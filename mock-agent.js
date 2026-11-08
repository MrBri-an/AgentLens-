'use strict';
// Mock support-triage agent. Deterministic per (question, noise) pair so
// evals are reproducible; `noise > 0` unlocks quality tiers and a small
// failure path so seeded history looks realistic.

const KB = {
  billing: [
    'Refunds are processed within 5-7 business days once approved.',
    'You can update your payment method from Settings → Billing.',
    'Invoices for the last 12 months are available under Billing → History.'
  ],
  technical: [
    'Try clearing the app cache, then restart the sync service.',
    'API errors 5xx are usually transient; retry with exponential backoff.',
    'Webhook deliveries can be replayed from the Developers console.'
  ],
  account: [
    'Password resets are sent to the email on file within a minute.',
    'You can enable 2FA from Settings → Security.'
  ],
  sales: [
    'The Pro plan is $29/month and includes unlimited traces and 90-day retention.',
    'Team workspaces add SSO, audit logs and priority support.'
  ],
  general: [
    'Our docs cover setup, SDKs and the API reference.',
    'Support hours are 9am-6pm UTC, Monday to Friday.',
    'Our status page at status.acme.test shows live uptime and incident history.'
  ]
};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function classify(q) {
  const s = String(q).toLowerCase();
  if (/(refund|charge|invoice|billing|payment|subscription|money)/.test(s)) return 'billing';
  if (/(error|crash|bug|broken|fail|500|api|sync|webhook)/.test(s)) return 'technical';
  if (/(password|login|2fa|sign in|account)/.test(s)) return 'account';
  if (/(price|pricing|plan|cost|upgrade|trial)/.test(s)) return 'sales';
  return 'general';
}

function isAngry(q) {
  const s = String(q);
  return /(unacceptable|lawyer|legal|furious|terrible|worst|!!+)/i.test(s) ||
    (s === s.toUpperCase() && /[A-Z]{4,}/.test(s) && s.length > 12);
}

function cost(tokens) {
  return +((tokens.input * 0.1 + tokens.output * 0.3) / 1e6).toFixed(6);
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'i', 'my', 'me', 'you', 'your', 'do', 'does', 'did',
  'what', 'how', 'where', 'can', 'cannot', 'to', 'of', 'on', 'in', 'for', 'and', 'it',
  'this', 'that', 'have', 'has', 'not', 'was', 'were', 'why', 'getting', 'there'
]);

// Pick the most relevant KB entry by keyword overlap; fall back to the RNG
// only when nothing matches (deterministic per question either way).
function pickKb(intent, q, rng) {
  const words = String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  let best = null;
  let bestScore = 0;
  for (const sn of KB[intent]) {
    const sl = sn.toLowerCase();
    const score = words.reduce((a, w) => a + (sl.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = sn;
    }
  }
  return bestScore > 0 ? best : KB[intent][Math.floor(rng() * KB[intent].length)];
}

function runAgent(input, opts = {}) {
  const q = input && input.question != null ? String(input.question) : String(input == null ? '' : input);
  const noise = opts.noise | 0;
  const rng = mulberry32((hashStr(q) ^ Math.imul(noise + 1, 0x9e3779b1)) >>> 0);
  const model = 'mock/triage-v2';
  const rootId = 'sp_root';
  const spans = [];
  const push = (name, kind, startedAt, durationMs, extra) =>
    spans.push(Object.assign({ id: 'sp_' + spans.length, parentId: rootId, name, kind, startedAt, durationMs, status: 'ok' }, extra || {}));

  push('agent.triage', 'agent', 0, 0, { model });
  const planMs = 120 + Math.floor(rng() * 260);
  push('llm.plan', 'llm', 0, planMs, { model, input: { task: 'classify+plan', question: q }, output: { next: 'search_kb' } });

  const intent = classify(q);
  const kb = pickKb(intent, q, rng);
  const kbMs = 60 + Math.floor(rng() * 160);
  push('tool.search_kb', 'tool', planMs, kbMs, { input: { query: q }, output: { snippet: kb } });

  let cursor = planMs + kbMs;
  const angry = isAngry(q);
  let ticketLine = '';

  if (intent === 'billing' || intent === 'technical') {
    const ticketMs = 80 + Math.floor(rng() * 220);
    if (noise > 0 && rng() < 0.08) {
      // failure path (only under noise, so deterministic evals stay clean)
      const err = 'tool.create_ticket: upstream timeout';
      push('tool.create_ticket', 'tool', cursor, ticketMs, { status: 'error', error: err, input: { intent, priority: angry ? 'high' : 'normal' }, output: null });
      cursor += ticketMs;
      const respMs = 140 + Math.floor(rng() * 260);
      const fallback = 'Sorry — I could not file your ticket just now. Please retry in a moment or email support@acme.test and we will follow up.';
      push('llm.respond', 'llm', cursor, respMs, { model, input: { task: 'compose' }, output: { text: fallback } });
      cursor += respMs;
      spans[0].durationMs = cursor;
      const tokens = { input: 320 + (q.length % 200), output: Math.ceil(fallback.length / 4) };
      return { output: fallback, spans, status: 'error', error: err, tokens, costUsd: cost(tokens), model };
    }
    const tid = 'TCK-' + (1000 + Math.floor(rng() * 9000));
    push('tool.create_ticket', 'tool', cursor, ticketMs, { input: { intent, priority: angry ? 'high' : 'normal' }, output: { ticket: tid } });
    cursor += ticketMs;
    ticketLine = ' I have filed ticket ' + tid + ' and our team will follow up by email within one business day.';
  }

  const respMs = 150 + Math.floor(rng() * 350);
  const tier = noise > 0 ? Math.floor(rng() * 3) : 1;
  const opener = angry ? 'I am really sorry about the trouble — I have escalated this immediately. ' : '';
  const intentLine = {
    billing: /refund/.test(q.toLowerCase())
      ? 'I have started the refund review for the duplicate charge.'
      : 'I have started a billing review for your account.',
    technical: 'I have logged the technical issue and started a diagnosis.',
    account: 'I have checked your account access settings.',
    sales: 'Here are the plan details you asked about.',
    general: 'Here is the section of our docs that covers this.'
  }[intent];
  const tail = tier === 0 ? '' : tier === 1
    ? ' Let me know if that helps.'
    : ' Would you like me to walk you through it step by step, or schedule a quick call?';
  const answer = opener + intentLine + ' ' + kb + ticketLine + tail + (angry ? ' A senior agent will review this case with priority.' : '');

  push('llm.respond', 'llm', cursor, respMs, { model, input: { task: 'compose' }, output: { text: answer } });
  cursor += respMs;
  spans[0].durationMs = cursor;
  const tokens = { input: 320 + (q.length % 200), output: Math.ceil(answer.length / 4) };
  return { output: answer, spans, status: 'ok', error: null, tokens, costUsd: cost(tokens), model };
}

module.exports = { runAgent, classify, isAngry, pickKb, KB };
