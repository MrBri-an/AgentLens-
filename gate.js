'use strict';
// CI regression gate. Exit 0 = pass, exit 1 = fail, exit 2 = error.
//
//   node gate.js --suite triage-core --min-score 70 --max-regression 5
//
// Set GROQ_API_KEY to enable the real LLM judge; without it the
// deterministic heuristic judge runs.

const evalsMod = require('./evals');
require('./env');

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return o;
}

async function runGate(opts) {
  const suite = opts.suite;
  if (!suite) throw new Error('--suite is required');
  const minScore = Number(opts['min-score'] || 0);
  const maxDrop = Number(opts['max-regression'] === undefined ? 5 : opts['max-regression']);

  const run = await evalsMod.runEval({ suite, record: opts.record !== false });
  const { score } = run.summary;
  const reasons = [];
  if (minScore && score < minScore) reasons.push('score ' + score + ' < minimum ' + minScore);
  if (run.baseline != null && run.delta <= -maxDrop) {
    reasons.push('score dropped ' + Math.abs(run.delta) + ' points vs baseline ' + run.baseline);
  }
  const ok = reasons.length === 0;

  console.log('AgentLens CI gate — suite "' + suite + '"');
  console.log(
    '  score ' + score + '/100 (' + run.summary.passed + '/' + run.summary.total +
    ' cases)  baseline ' + (run.baseline == null ? 'n/a' : run.baseline) +
    '  delta ' + (run.delta == null ? 'n/a' : (run.delta > 0 ? '+' : '') + run.delta)
  );
  for (const r of run.results) {
    console.log('  ' + (r.passed ? '  ✓ ' : '  ✗ ') + r.case + (r.status === 'error' ? ' (runtime error)' : ''));
  }
  console.log(ok ? '  PASS' : '  FAIL: ' + reasons.join('; '));
  return { ok, score, delta: run.delta, baseline: run.baseline, reasons };
}

if (require.main === module) {
  runGate(parseArgs(process.argv))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}

module.exports = { runGate, parseArgs };
