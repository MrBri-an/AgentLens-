'use strict';
// AgentLens store — append-only JSONL persistence, zero dependencies.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTLENS_DATA_DIR || path.join(__dirname, 'data');
const TRACES_FILE = path.join(DATA_DIR, 'traces.jsonl');
const EVALS_FILE = path.join(DATA_DIR, 'evals.jsonl');
const BASELINES_FILE = path.join(DATA_DIR, 'baselines.json');

function uid(prefix) {
  return (prefix || 'run') + '_' + crypto.randomBytes(6).toString('hex');
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// ---------- traces ----------

function appendTrace(t) {
  if (!t || typeof t.name !== 'string' || !t.name.trim()) throw new Error('trace.name is required');
  const trace = {
    id: t.id || uid('tr'),
    name: t.name,
    startedAt: Number.isFinite(t.startedAt) ? t.startedAt : Date.now(),
    durationMs: Number(t.durationMs) || 0,
    status: t.status === 'error' ? 'error' : 'ok',
    model: t.model || null,
    tags: Array.isArray(t.tags) ? t.tags : [],
    input: t.input === undefined ? null : t.input,
    output: t.output === undefined ? null : t.output,
    error: t.error || null,
    tokens: {
      input: (t.tokens && Number(t.tokens.input)) || 0,
      output: (t.tokens && Number(t.tokens.output)) || 0
    },
    costUsd: Number(t.costUsd) || 0,
    spans: Array.isArray(t.spans) ? t.spans : []
  };
  ensureDir();
  fs.appendFileSync(TRACES_FILE, JSON.stringify(trace) + '\n');
  return trace;
}

function listTraces() {
  return readJsonl(TRACES_FILE).sort((a, b) => b.startedAt - a.startedAt);
}

function getTrace(id) {
  return readJsonl(TRACES_FILE).find((t) => t.id === id) || null;
}

// ---------- eval runs ----------

function appendEvalRun(run) {
  ensureDir();
  fs.appendFileSync(EVALS_FILE, JSON.stringify(run) + '\n');
  return run;
}

function listEvalRuns(suite) {
  const runs = readJsonl(EVALS_FILE).sort((a, b) => b.startedAt - a.startedAt);
  return suite ? runs.filter((r) => r.suite === suite) : runs;
}

function getEvalRun(id) {
  return readJsonl(EVALS_FILE).find((r) => r.id === id) || null;
}

// ---------- baselines ----------

function getBaselines() {
  if (!fs.existsSync(BASELINES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BASELINES_FILE, 'utf8')); } catch { return {}; }
}

function setBaseline(suite, payload) {
  const all = getBaselines();
  all[suite] = { runId: payload.runId, score: payload.score, at: payload.at || Date.now() };
  ensureDir();
  fs.writeFileSync(BASELINES_FILE, JSON.stringify(all, null, 2));
  return all[suite];
}

// ---------- maintenance ----------

function clearAll() {
  for (const f of [TRACES_FILE, EVALS_FILE, BASELINES_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ---------- aggregate stats ----------

function stats() {
  const traces = listTraces();
  const total = traces.length;
  const failed = traces.filter((t) => t.status === 'error').length;
  const durs = traces.map((t) => t.durationMs).sort((a, b) => a - b);
  const p95 = durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : 0;
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  const cost = traces.reduce((a, t) => a + (t.costUsd || 0), 0);
  const tokens = traces.reduce((a, t) => a + t.tokens.input + t.tokens.output, 0);
  const evalRuns = listEvalRuns();
  const totCases = evalRuns.reduce((a, r) => a + r.summary.total, 0);
  const passCases = evalRuns.reduce((a, r) => a + r.summary.passed, 0);
  return {
    total,
    failed,
    failRate: total ? +(100 * failed / total).toFixed(1) : 0,
    avgMs: avg,
    p95Ms: p95,
    costUsd: +cost.toFixed(4),
    tokens,
    evalRuns: evalRuns.length,
    evalPassRate: totCases ? Math.round(100 * passCases / totCases) : null
  };
}

module.exports = {
  uid,
  appendTrace,
  listTraces,
  getTrace,
  appendEvalRun,
  listEvalRuns,
  getEvalRun,
  getBaselines,
  setBaseline,
  clearAll,
  stats,
  DATA_DIR,
  TRACES_FILE,
  EVALS_FILE,
  BASELINES_FILE
};
