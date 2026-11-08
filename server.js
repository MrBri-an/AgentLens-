'use strict';
// AgentLens server — static dashboard + REST API. Zero dependencies.
require('./env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./store');
const evalsMod = require('./evals');

const PORT = Number(process.env.PORT || 4175);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 5e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return json(res, 200, { ok: true, name: 'AgentLens', version: '0.1.0', time: Date.now() });
  }

  if (p === '/api/stats') return json(res, 200, store.stats());

  if (p === '/api/traces' && req.method === 'GET') {
    const limit = Math.min(500, Number(q.get('limit') || 100));
    let items = store.listTraces();
    const status = q.get('status');
    if (status) items = items.filter((t) => t.status === status);
    const tag = q.get('tag');
    if (tag) items = items.filter((t) => (t.tags || []).includes(tag));
    const s = (q.get('q') || '').toLowerCase();
    if (s) {
      items = items.filter((t) =>
        (t.name + ' ' + JSON.stringify(t.input || '') + ' ' + JSON.stringify(t.output || ''))
          .toLowerCase()
          .includes(s)
      );
    }
    return json(res, 200, items.slice(0, limit).map((t) => ({
      id: t.id,
      name: t.name,
      startedAt: t.startedAt,
      durationMs: t.durationMs,
      status: t.status,
      model: t.model,
      tags: t.tags,
      costUsd: t.costUsd,
      tokens: t.tokens,
      spanCount: (t.spans || []).length,
      error: t.error
    })));
  }

  let m = p.match(/^\/api\/traces\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const t = store.getTrace(m[1]);
    return t ? json(res, 200, t) : json(res, 404, { error: 'trace not found' });
  }

  if (p === '/api/traces' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const t = store.appendTrace(body);
      return json(res, 201, { ok: true, id: t.id });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (p === '/api/suites') return json(res, 200, evalsMod.listSuites());

  if (p === '/api/evals' && req.method === 'GET') {
    const suite = q.get('suite');
    const runs = store.listEvalRuns(suite || undefined).slice(0, 50).map((r) => ({
      id: r.id,
      suite: r.suite,
      startedAt: r.startedAt,
      summary: r.summary,
      regressed: r.regressed,
      delta: r.delta,
      baseline: r.baseline
    }));
    return json(res, 200, runs);
  }

  m = p.match(/^\/api\/evals\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const run = store.getEvalRun(m[1]);
    return run ? json(res, 200, run) : json(res, 404, { error: 'eval run not found' });
  }

  if (p === '/api/evals/run' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.suite) return json(res, 400, { ok: false, error: 'suite is required' });
      const run = await evalsMod.runEval({
        suite: body.suite,
        noise: body.noise || 0,
        record: body.record !== false,
        apiKey: body.apiKey !== undefined ? body.apiKey : process.env.GROQ_API_KEY || null
      });
      return json(res, 200, run);
    } catch (e) {
      return json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (p === '/api/seed' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const st = store.stats();
      if (st.total > 0 && !body.force) {
        return json(res, 409, { ok: false, error: 'store not empty — pass {"force":true} to reseed', total: st.total });
      }
      const { seed } = require('./seed');
      const out = await seed();
      return json(res, 200, { ok: true, seeded: out, stats: store.stats() });
    } catch (e) {
      return json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (p === '/api/baselines' && req.method === 'GET') {
    return json(res, 200, store.getBaselines());
  }

  if (p === '/api/baselines' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runs = store.listEvalRuns(body.suite);
      if (!runs.length) return json(res, 404, { ok: false, error: 'no runs for suite ' + body.suite });
      const latest = runs[0];
      store.setBaseline(body.suite, { runId: latest.id, score: latest.summary.score, at: latest.startedAt });
      return json(res, 200, { ok: true, suite: body.suite, baseline: latest.summary.score });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }

  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(buf);
  });
}

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => json(res, 500, { error: String((e && e.message) || e) }));
    return;
  }
  serveStatic(req, res, url);
}

function start(port) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(Number.isFinite(port) ? port : PORT, () => resolve(server));
  });
}

if (require.main === module) {
  const st = store.stats();
  start().then(() => {
    console.log('[AgentLens] http://localhost:' + PORT);
    console.log('[AgentLens] ' + st.total + ' traces in store' + (st.total === 0 ? ' — run `npm run seed` for demo data' : ''));
    console.log('[AgentLens] judge: ' + (process.env.GROQ_API_KEY ? 'Groq (' + (process.env.GROQ_MODEL || 'openai/gpt-oss-120b') + ')' : 'local heuristic (set GROQ_API_KEY for LLM-as-judge)'));
  });
}

module.exports = { start, handler };
