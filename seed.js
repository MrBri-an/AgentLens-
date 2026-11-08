'use strict';
// Seed the store with a realistic week of support-agent traffic plus eval
// history, so the dashboard is alive the moment you open it.
require('./env');
const store = require('./store');
const evalsMod = require('./evals');
const { runAgent, classify } = require('./mock-agent');

const QUESTIONS = [
  'I was charged twice this month, I want a refund',
  'Why did my invoice include tax twice?',
  'UNACCEPTABLE — I WANT MY MONEY BACK, I\'M CALLING MY LAWYER',
  'The API returns 500 on /v1/sync',
  'The webhook deliveries are failing',
  'App crashes when I export CSV',
  'My sync is broken since yesterday',
  'I forgot my password and cannot sign in',
  'How do I enable 2FA on my account?',
  'What does the Pro plan cost?',
  'Can I upgrade from the free trial?',
  'Where are your docs?',
  'What are your support hours?',
  'Do you have a status page?',
  'Refund my subscription immediately!! This is unacceptable',
  'Getting a 500 error from the API every few minutes'
];

async function seed() {
  store.clearAll();
  const now = Date.now();
  let count = 0;
  let errors = 0;

  for (let i = 0; i < 44; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const noise = i % 3; // rotate determinism tiers / failure path
    const r = runAgent({ question: q }, { noise });
    if (r.status === 'error') errors++;
    const ageMs = Math.floor(((i * 3.7 + ((i * i) % 11)) % 168) * 3600 * 1000);
    store.appendTrace({
      id: 'tr_seed' + String(i).padStart(3, '0'),
      name: 'support/' + classify(q) + (r.status === 'error' ? '/ticket-failed' : ''),
      startedAt: now - ageMs,
      durationMs: r.spans[0].durationMs,
      status: r.status,
      error: r.error,
      model: r.model,
      tags: ['support', i % 5 === 0 ? 'canary' : 'prod'],
      input: { question: q },
      output: r.output,
      tokens: r.tokens,
      costUsd: r.costUsd,
      spans: r.spans
    });
    count++;
  }

  // eval history: 3 backdated runs per suite so regressions/sparklines render
  const day = 86400000;
  for (const suiteName of ['triage-core', 'triage-quality']) {
    for (let k = 0; k < 3; k++) {
      await evalsMod.runEval({
        suite: suiteName,
        noise: k + 1,
        record: true,
        startedAt: now - (3 - k) * day
      });
    }
  }

  // set baselines to the most recent run of each suite
  for (const s of ['triage-core', 'triage-quality']) {
    const runs = store.listEvalRuns(s);
    if (runs.length) {
      store.setBaseline(s, { runId: runs[0].id, score: runs[0].summary.score, at: runs[0].startedAt });
    }
  }

  const st = store.stats();
  return { traces: count, errors, evalRuns: st.evalRuns };
}

if (require.main === module) {
  seed()
    .then((out) => {
      console.log('[AgentLens] seeded ' + out.traces + ' traces (' + out.errors + ' errored) + ' + out.evalRuns + ' eval runs');
      console.log('[AgentLens] dashboard: http://localhost:4175');
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { seed };
