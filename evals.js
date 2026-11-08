'use strict';
// Eval engine: suites of cases, declarative checks, optional LLM-as-judge,
// scoring, and baseline regression comparison.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const judgeMod = require('./judge');
const mockAgent = require('./mock-agent');

const SUITES_DIR = path.join(__dirname, 'evals', 'suites');

function listSuites() {
  if (!fs.existsSync(SUITES_DIR)) return [];
  return fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, f), 'utf8'));
        return {
          name: s.name,
          file: f,
          description: s.description || '',
          target: s.target || { type: 'mock' },
          cases: (s.cases || []).length,
          regressionThreshold: s.regression_threshold === undefined ? 5 : s.regression_threshold
        };
      } catch (e) {
        return { name: f, file: f, error: String((e && e.message) || e), cases: 0 };
      }
    });
}

function loadSuite(name) {
  const file = path.join(SUITES_DIR, name.endsWith('.json') ? name : name + '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.regressionThreshold = raw.regression_threshold === undefined ? 5 : raw.regression_threshold;
  return raw;
}

// ---------- checks ----------

function runSyncCheck(check, ctx) {
  const out = String(ctx.output == null ? '' : ctx.output);
  switch (check.type) {
    case 'contains': return out.includes(check.value);
    case 'not_contains': return !out.includes(check.value);
    case 'equals': return out.trim() === check.value;
    case 'regex': return new RegExp(check.value, check.flags || 'i').test(out);
    case 'json_valid':
      try { JSON.parse(out); return true; } catch { return false; }
    case 'min_output_length': return out.length >= (check.value || 0);
    case 'max_latency_ms': return ctx.latencyMs <= check.value;
    case 'max_cost_usd': return (ctx.costUsd || 0) <= check.value;
    default: throw new Error('unknown check type: ' + check.type);
  }
}

async function runChecks(checks, ctx) {
  const results = [];
  for (const c of checks || []) {
    if (c.type === 'judge') {
      const r = await judgeMod.judge({
        input: ctx.input,
        output: ctx.output,
        criteria: c.criteria,
        apiKey: ctx.apiKey
      });
      const min = c.min === undefined ? 6 : c.min;
      results.push({
        type: 'judge',
        name: c.name || ('judge>=' + min),
        passed: r.score >= min,
        score: r.score,
        judge: r.judge,
        detail: r.reasoning
      });
    } else {
      let passed = false;
      let detail = null;
      try { passed = !!runSyncCheck(c, ctx); } catch (e) { detail = String((e && e.message) || e); }
      results.push({
        type: c.type,
        name: c.name || c.type,
        passed,
        detail: detail || (passed ? null : 'check failed')
      });
    }
  }
  return results;
}

// ---------- targets ----------

async function invokeTarget(target, input, noise) {
  if (!target || target.type === 'mock') {
    const r = mockAgent.runAgent(input, { noise: noise || 0, vary: noise > 0 });
    return {
      output: r.output,
      spans: r.spans,
      status: r.status,
      error: r.error,
      tokens: r.tokens,
      costUsd: r.costUsd,
      model: r.model
    };
  }
  if (target.type === 'http') {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input })
    });
    if (!res.ok) throw new Error('target HTTP ' + res.status);
    const j = await res.json();
    return {
      output: j.output !== undefined ? j.output : j,
      tokens: j.tokens || null,
      costUsd: j.costUsd || 0,
      model: j.model || null,
      spans: j.spans || null,
      status: 'ok'
    };
  }
  throw new Error('unknown target type: ' + target.type);
}

// ---------- regression ----------

function regressionInfo(latestScore, baseline, threshold) {
  if (!baseline || typeof baseline.score !== 'number') {
    return { baseline: null, delta: null, regressed: false };
  }
  const delta = latestScore - baseline.score;
  return {
    baseline: baseline.score,
    delta,
    regressed: delta <= -(threshold === undefined || threshold === null ? 5 : threshold)
  };
}

// ---------- runner ----------

async function runEval(opts) {
  const suite = typeof opts.suite === 'string' ? loadSuite(opts.suite) : opts.suite;
  const noise = opts.noise || 0;
  const record = opts.record !== false;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.GROQ_API_KEY || null;

  const results = [];
  for (const c of suite.cases || []) {
    const t0 = Date.now();
    let r = {};
    let status = 'ok';
    let runtimeError = null;
    try {
      r = await invokeTarget(suite.target, c.input, noise);
    } catch (e) {
      status = 'error';
      runtimeError = String((e && e.message) || e);
    }
    const latencyMs = Date.now() - t0;
    const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(c.input);
    const checks = status === 'error'
      ? [{ type: 'runtime', name: 'target responded', passed: false, detail: runtimeError }]
      : await runChecks(c.checks || [], {
          input: inputStr,
          output: r.output,
          latencyMs,
          costUsd: r.costUsd,
          apiKey
        });
    const passed = checks.every((x) => x.passed);
    results.push({
      case: c.name,
      input: inputStr,
      output: r.output == null ? null : String(r.output).slice(0, 2000),
      status,
      passed,
      latencyMs,
      checks
    });

    if (record && r.spans) {
      // every eval case also lands in the trace store — evals and
      // observability share one timeline (the eval-to-prod loop)
      try {
        store.appendTrace({
          name: 'eval/' + suite.name + '/' + c.name,
          startedAt: t0,
          durationMs: (r.spans[0] && r.spans[0].durationMs) || latencyMs,
          status: r.status === 'error' ? 'error' : 'ok',
          model: r.model || null,
          tags: ['eval', suite.name],
          input: c.input,
          output: r.output,
          error: r.error || null,
          tokens: r.tokens || { input: 0, output: 0 },
          costUsd: r.costUsd || 0,
          spans: r.spans
        });
      } catch { /* tracing must never break evals */ }
    }
  }

  const total = results.length;
  const passedCount = results.filter((x) => x.passed).length;
  const score = total ? Math.round(100 * passedCount / total) : 0;
  const summary = {
    total,
    passed: passedCount,
    failed: total - passedCount,
    score,
    avgLatencyMs: total ? Math.round(results.reduce((a, x) => a + x.latencyMs, 0) / total) : 0
  };
  const baselines = store.getBaselines();
  const info = regressionInfo(score, baselines[suite.name], suite.regressionThreshold);
  const run = {
    id: store.uid('ev'),
    suite: suite.name,
    startedAt: opts.startedAt || Date.now(),
    summary,
    regressed: info.regressed,
    delta: info.delta,
    baseline: info.baseline,
    results
  };
  if (record) store.appendEvalRun(run);
  return run;
}

module.exports = {
  listSuites,
  loadSuite,
  runEval,
  runChecks,
  runSyncCheck,
  regressionInfo,
  invokeTarget,
  SUITES_DIR
};
