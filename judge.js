'use strict';
// LLM-as-judge via Groq, with a deterministic local heuristic fallback so
// evals always run — even offline or without an API key.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function heuristicJudge({ input, output, criteria }) {
  const text = String(output || '');
  const reasons = [];
  let score = 4;
  if (text.length > 220) { score += 2; reasons.push('answer is substantive (>220 chars)'); }
  else if (text.length > 120) { score += 1; reasons.push('answer has moderate detail'); }
  else reasons.push('answer is terse');
  if (/\b(sorry|apolog|appreciate|thanks)\b/i.test(text)) { score += 1; reasons.push('acknowledges the user'); }
  if (/\b(will|next|steps?|follow up|schedule|retry)\b/i.test(text)) { score += 1; reasons.push('proposes a next step'); }
  if (/(TODO|lorem|placeholder|undefined|NaN)/.test(text)) { score -= 2; reasons.push('contains placeholder text'); }
  if (criteria && /escalat/i.test(criteria) && /escalat|senior|priority/i.test(text)) { score += 1; reasons.push('escalation handled'); }
  score = Math.max(1, Math.min(10, score));
  return {
    score,
    reasoning: 'heuristic: ' + (reasons.join('; ') || 'meets baseline expectations'),
    judge: 'heuristic'
  };
}

async function groqJudge({ input, output, criteria, apiKey, timeoutMs = 20000 }) {
  const sys =
    'You are a strict QA reviewer for a customer-support AI agent. ' +
    'Score the agent answer 1-10 against the criteria. ' +
    'Respond ONLY with compact JSON: {"score": <number 1-10>, "reasoning": "<one sentence>"}';
  const user =
    'Criteria: ' + criteria + '\n\nCustomer question: ' + input + '\n\nAgent answer: ' + output;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        // reasoning models (e.g. gpt-oss-120b) spend tokens thinking before
        // the JSON answer — give them room or content comes back empty
        max_tokens: 1024,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('groq HTTP ' + res.status);
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const m = text.match(/"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!m) throw new Error('no score in judge response');
    const r = text.match(/"reasoning"\s*:\s*"([^"]+)"/);
    return {
      score: Math.max(0, Math.min(10, parseFloat(m[1]))),
      reasoning: r ? r[1] : text.slice(0, 160),
      judge: 'groq:' + MODEL
    };
  } finally {
    clearTimeout(timer);
  }
}

async function judge(args) {
  if (args.apiKey) {
    try {
      return await groqJudge(args);
    } catch (e) {
      const h = heuristicJudge(args);
      h.reasoning = 'groq judge failed (' + e.message + '); fell back. ' + h.reasoning;
      return h;
    }
  }
  return heuristicJudge(args);
}

module.exports = { judge, heuristicJudge, groqJudge, MODEL, GROQ_URL };
