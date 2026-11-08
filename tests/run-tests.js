'use strict';
// AgentLens test suite — zero dependencies. Run: node tests/run-tests.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate data dir BEFORE any module that reads it.
process.env.AGENTLENS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-test-'));

const store = require('../store');
const mockAgent = require('../mock-agent');
const judgeMod = require('../judge');
const evalsMod = require('../evals');
const gate = require('../gate');
const mcp = require('../mcp-server');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- env ----------

test('env: loads .env without overriding existing vars', () => {
  const { loadEnv } = require('../env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nAL_TEST_X=preset-wins\nAL_TEST_Y="two words"\nAL_TEST_Z=3\n');
  process.env.AL_TEST_X = 'preset';
  try {
    assert.strictEqual(loadEnv(dir), true);
    assert.strictEqual(process.env.AL_TEST_X, 'preset');
    assert.strictEqual(process.env.AL_TEST_Y, 'two words');
    assert.strictEqual(process.env.AL_TEST_Z, '3');
  } finally {
    delete process.env.AL_TEST_X;
    delete process.env.AL_TEST_Y;
    delete process.env.AL_TEST_Z;
  }
});

// ---------- store ----------

test('store: append + get trace roundtrip', () => {
  const t = store.appendTrace({ name: 'test/run', status: 'ok', durationMs: 42, tokens: { input: 10, output: 20 }, costUsd: 0.001 });
  assert.ok(t.id.startsWith('tr_'));
  const got = store.getTrace(t.id);
  assert.strictEqual(got.name, 'test/run');
  assert.strictEqual(got.durationMs, 42);
  assert.deepStrictEqual(got.tokens, { input: 10, output: 20 });
});

test('store: rejects trace without name', () => {
  assert.throws(() => store.appendTrace({ nope: true }), /name is required/);
});

test('store: baseline set/get + eval run roundtrip', () => {
  const run = store.appendEvalRun({ id: 'ev_x1', suite: 's1', startedAt: Date.now(), summary: { total: 2, passed: 1, failed: 1, score: 50, avgLatencyMs: 5 }, regressed: false, delta: null, baseline: null, results: [] });
  assert.strictEqual(run.id, 'ev_x1');
  const runs = store.listEvalRuns('s1');
  assert.ok(runs.length >= 1);
  assert.strictEqual(store.getEvalRun('ev_x1').suite, 's1');
  store.setBaseline('s1', { runId: 'ev_x1', score: 50 });
  assert.strictEqual(store.getBaselines().s1.score, 50);
});

test('store: stats aggregation', () => {
  const s = store.stats();
  assert.ok(s.total >= 1);
  assert.ok(typeof s.failRate === 'number' && typeof s.costUsd === 'number');
});

// ---------- mock agent ----------

test('mock agent: deterministic for same (question, noise)', () => {
  const a = mockAgent.runAgent({ question: 'I want a refund' }, { noise: 0 });
  const b = mockAgent.runAgent({ question: 'I want a refund' }, { noise: 0 });
  assert.strictEqual(a.output, b.output);
  assert.deepStrictEqual(a.spans.map((s) => s.name), b.spans.map((s) => s.name));
});

test('mock agent: produces span waterfall with agent root', () => {
  const r = mockAgent.runAgent({ question: 'The API returns 500' }, { noise: 0 });
  assert.ok(r.spans.length >= 4);
  assert.strictEqual(r.spans[0].kind, 'agent');
  assert.ok(r.spans.some((s) => s.kind === 'llm'));
  assert.ok(r.spans.some((s) => s.kind === 'tool'));
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.spans[0].durationMs > 0);
});

test('mock agent: billing questions file a ticket', () => {
  const r = mockAgent.runAgent({ question: 'I was charged twice, I want a refund' }, { noise: 0 });
  assert.match(r.output, /TCK-\d+/);
  assert.ok(r.spans.some((s) => s.name === 'tool.create_ticket'));
});

test('mock agent: angry customer gets escalation', () => {
  const r = mockAgent.runAgent({ question: 'UNACCEPTABLE — I WANT MY MONEY BACK, CALLING MY LAWYER' }, { noise: 0 });
  assert.match(r.output, /sorry/i);
  assert.match(r.output, /escalat/i);
  assert.match(r.output, /priority/i);
});

test('mock agent: account questions do not file tickets', () => {
  const r = mockAgent.runAgent({ question: 'I forgot my password and cannot sign in' }, { noise: 0 });
  assert.ok(!/TCK-/.test(r.output));
});

// ---------- judge ----------

test('heuristic judge: scores in range with reasoning', () => {
  const r = judgeMod.heuristicJudge({
    input: 'my sync is broken',
    output: 'I am sorry about this. I have started a diagnosis and will follow up with next steps shortly.',
    criteria: 'be helpful'
  });
  assert.ok(r.score >= 1 && r.score <= 10);
  assert.ok(r.reasoning.length > 5);
  assert.strictEqual(r.judge, 'heuristic');
});

test('heuristic judge: terse empty output scores low', () => {
  const r = judgeMod.heuristicJudge({ input: 'x', output: 'ok', criteria: '' });
  assert.ok(r.score <= 6);
});

test('judge dispatcher: falls back without API key', async () => {
  const r = await judgeMod.judge({ input: 'q', output: 'helpful answer with next steps', criteria: 'c', apiKey: null });
  assert.strictEqual(r.judge, 'heuristic');
});

// ---------- checks & evals ----------

test('checks: sync check types pass/fail correctly', () => {
  const ctx = { output: 'Ticket TCK-1234 filed for your refund', latencyMs: 100, costUsd: 0.002 };
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'contains', value: 'TCK-1234' }, ctx), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'contains', value: 'nope' }, ctx), false);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'regex', value: 'TCK-\\d+' }, ctx), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'not_contains', value: 'nope' }, ctx), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'json_valid' }, { output: '{"a":1}' }), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'json_valid' }, { output: '{bad' }), false);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'min_output_length', value: 10 }, ctx), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'max_latency_ms', value: 200 }, ctx), true);
  assert.strictEqual(evalsMod.runSyncCheck({ type: 'max_latency_ms', value: 50 }, ctx), false);
  assert.throws(() => evalsMod.runSyncCheck({ type: 'bogus' }, ctx), /unknown check type/);
});

test('eval runner: triage-core passes fully at noise 0 (deterministic)', async () => {
  const run = await evalsMod.runEval({ suite: 'triage-core', record: false, apiKey: null });
  assert.strictEqual(run.summary.total, 8);
  assert.strictEqual(run.summary.passed, run.summary.total, 'failing cases: ' + JSON.stringify(run.results.filter((r) => !r.passed).map((r) => ({ c: r.case, checks: r.checks })), null, 1));
  assert.strictEqual(run.summary.score, 100);
  assert.strictEqual(run.regressed, false);
});

test('eval runner: quality suite uses judge checks', async () => {
  const run = await evalsMod.runEval({ suite: 'triage-quality', record: false, apiKey: null });
  assert.strictEqual(run.summary.total, 6);
  assert.ok(run.summary.score >= 80, 'score was ' + run.summary.score);
  const judgeChecks = run.results.flatMap((r) => r.checks).filter((c) => c.type === 'judge');
  assert.ok(judgeChecks.length >= 6);
  assert.ok(judgeChecks.every((c) => c.score >= 0 && c.score <= 10));
  assert.ok(judgeChecks.every((c) => c.judge === 'heuristic'));
});

test('eval runner: recorded run writes to store + traces tagged eval', async () => {
  const before = store.listEvalRuns('triage-core').length;
  const tracesBefore = store.listTraces().length;
  const run = await evalsMod.runEval({ suite: 'triage-core', record: true, apiKey: null });
  assert.strictEqual(store.listEvalRuns('triage-core').length, before + 1);
  assert.ok(store.listTraces().length > tracesBefore, 'eval should also record traces');
  const evalTraces = store.listTraces().filter((t) => (t.tags || []).includes('eval') && t.tags.includes('triage-core'));
  assert.ok(evalTraces.length >= 8);
  assert.ok(run.id.startsWith('ev_'));
});

test('regression: drop beyond threshold flags regressed', () => {
  assert.deepStrictEqual(evalsMod.regressionInfo(60, { score: 70 }, 5), { baseline: 70, delta: -10, regressed: true });
  assert.deepStrictEqual(evalsMod.regressionInfo(68, { score: 70 }, 5), { baseline: 70, delta: -2, regressed: false });
  assert.deepStrictEqual(evalsMod.regressionInfo(80, { score: 70 }, 5), { baseline: 70, delta: 10, regressed: false });
  assert.deepStrictEqual(evalsMod.regressionInfo(80, null, 5), { baseline: null, delta: null, regressed: false });
});

test('CI gate: passes on green suite', async () => {
  const r = await gate.runGate({ suite: 'triage-core', record: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.score, 100);
});

// ---------- HTTP API ----------

test('HTTP API: health, ingest, stats, eval run', async () => {
  const { start } = require('../server');
  const server = await start(0);
  try {
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;

    const health = await (await fetch(base + '/api/health')).json();
    assert.strictEqual(health.name, 'AgentLens');

    const post = await fetch(base + '/api/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'http/ingested', status: 'ok', spans: [{ id: 'sp1', parentId: null, name: 'root', kind: 'agent', startedAt: 0, durationMs: 12, status: 'ok' }] })
    });
    assert.strictEqual(post.status, 201);
    const posted = await post.json();
    assert.ok(posted.ok && posted.id);

    const bad = await fetch(base + '/api/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(bad.status, 400);

    const got = await (await fetch(base + '/api/traces/' + posted.id)).json();
    assert.strictEqual(got.name, 'http/ingested');

    const list = await (await fetch(base + '/api/traces?limit=5')).json();
    assert.ok(Array.isArray(list) && list.length >= 1 && list[0].spanCount >= 0);

    const stats = await (await fetch(base + '/api/stats')).json();
    assert.ok(stats.total >= 1);

    const suites = await (await fetch(base + '/api/suites')).json();
    assert.ok(suites.length >= 2);

    const evalRun = await (
      await fetch(base + '/api/evals/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suite: 'triage-core', record: false, apiKey: null })
      })
    ).json();
    assert.strictEqual(evalRun.summary.total, 8);

    const missing = await fetch(base + '/api/traces/tr_nope');
    assert.strictEqual(missing.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------- MCP ----------

test('MCP: initialize handshake + serverInfo', async () => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.strictEqual(r.serverInfo.name, 'agentlens');
  assert.ok(r.protocolVersion);
});

test('MCP: exposes >= 7 tools', async () => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(r.tools.length >= 7);
  const names = r.tools.map((t) => t.name);
  for (const n of ['lens_overview', 'lens_list_traces', 'lens_get_trace', 'lens_run_eval', 'lens_set_baseline']) {
    assert.ok(names.includes(n), 'missing tool ' + n);
  }
});

test('MCP: tools/call roundtrip (overview, suites, eval summary)', async () => {
  const call = (name, args) => mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args || {} } });
  const ov = await call('lens_overview');
  const ovData = JSON.parse(ov.content[0].text);
  assert.ok(ovData.total >= 1);

  const suites = JSON.parse((await call('lens_list_suites')).content[0].text);
  assert.ok(suites.length >= 2);

  const summ = JSON.parse((await call('lens_eval_summary')).content[0].text);
  assert.ok(summ.length >= 2);
  assert.ok(summ[0].latest && summ[0].latest.score != null);

  const unknown = await call('no_such_tool');
  assert.strictEqual(unknown.isError, true);
});

test('MCP: notifications produce no response', async () => {
  const r = await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(r, undefined);
});

// ---------- SDK ----------

test('SDK: builds span tree and POSTs payload', async () => {
  const Lens = require('../public/agentlens.js');
  let captured = null;
  const origFetch = global.fetch;
  global.fetch = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  };
  try {
    const t = Lens.startTrace('sdk/test', { model: 'test-model', tags: ['ci'] });
    const s1 = t.span('llm.plan', { kind: 'llm', input: { q: 1 } });
    s1.end({ next: 'tool' });
    const s2 = t.span('tool.call', { kind: 'tool', input: { x: 2 } });
    s2.end({ res: 3 });
    const nested = s1.span('llm.child', { kind: 'llm' });
    nested.end('leaf');
    await t.end('ok', { output: 'done', tokens: { input: 100, output: 50 } });
    assert.strictEqual(captured.url.endsWith('/api/traces'), true);
    assert.strictEqual(captured.body.name, 'sdk/test');
    assert.strictEqual(captured.body.spans.length, 4);
    assert.strictEqual(captured.body.spans[0].kind, 'agent');
    const child = captured.body.spans.find((s) => s.name === 'llm.child');
    assert.ok(child && child.parentId, 'nested span must carry parentId');
    assert.ok(captured.body.costUsd > 0, 'cost estimated from rates');
    assert.strictEqual(captured.body.status, 'ok');
  } finally {
    global.fetch = origFetch;
  }
});

// ---------- runner ----------

(async () => {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  ✓ ' + t.name);
    } catch (e) {
      fail++;
      console.log('  ✗ ' + t.name);
      console.log('      ' + String((e && e.message) || e).split('\n').slice(0, 6).join('\n      '));
    }
  }
  console.log('\n' + pass + '/' + (pass + fail) + ' pipeline tests passed');
  process.exit(fail ? 1 : 0);
})();
