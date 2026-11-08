'use strict';
// AgentLens MCP server (stdio, JSON-RPC 2.0). Lets coding agents — Claude
// Desktop, Cursor, ZCode — inspect their own traces and run their own evals.
//
// Add to your MCP client config:
// {
//   "mcpServers": {
//     "agentlens": { "command": "node", "args": ["/path/to/agentlens/mcp-server.js"] }
//   }
// }

const store = require('./store');
const evalsMod = require('./evals');
require('./env');

const VERSION = '0.1.0';

const TOOLS = [
  {
    name: 'lens_overview',
    description: 'AgentLens dashboard stats: trace counts, failure rate, latency p95, token spend, eval pass rate.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lens_list_traces',
    description: 'List recent agent traces (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'default 20' },
        status: { type: 'string', enum: ['ok', 'error'] }
      }
    }
  },
  {
    name: 'lens_get_trace',
    description: 'Get one trace with full span waterfall, inputs/outputs, tokens and cost.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'lens_list_suites',
    description: 'List eval suites available in ./evals/suites.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lens_run_eval',
    description: 'Run an eval suite against its target and record the result. Use this to regression-test an agent after changing its prompt or code.',
    inputSchema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] }
  },
  {
    name: 'lens_eval_summary',
    description: 'Latest eval run per suite with baseline comparison and regression flags.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lens_set_baseline',
    description: 'Promote the latest run of a suite to its regression baseline.',
    inputSchema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] }
  }
];

async function handle(msg) {
  const method = msg.method || '';

  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentlens', version: VERSION }
    };
  }

  if (method === 'tools/list') return { tools: TOOLS };

  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const a = (msg.params && msg.params.arguments) || {};
    let out;
    try {
      switch (name) {
        case 'lens_overview':
          out = store.stats();
          break;
        case 'lens_list_traces':
          out = store
            .listTraces()
            .filter((t) => !a.status || t.status === a.status)
            .slice(0, a.limit || 20)
            .map((t) => ({ id: t.id, name: t.name, status: t.status, durationMs: t.durationMs, costUsd: t.costUsd, tags: t.tags }));
          break;
        case 'lens_get_trace': {
          const t = store.getTrace(a.id);
          if (!t) throw new Error('trace not found: ' + a.id);
          out = t;
          break;
        }
        case 'lens_list_suites':
          out = evalsMod.listSuites();
          break;
        case 'lens_run_eval':
          if (!a.suite) throw new Error('suite is required');
          out = await evalsMod.runEval({ suite: a.suite });
          break;
        case 'lens_eval_summary': {
          const rows = [];
          for (const s of evalsMod.listSuites()) {
            const runs = store.listEvalRuns(s.name);
            const latest = runs[0];
            const base = store.getBaselines()[s.name];
            rows.push({
              suite: s.name,
              latest: latest
                ? { id: latest.id, score: latest.summary.score, passed: latest.summary.passed, total: latest.summary.total, at: latest.startedAt }
                : null,
              baseline: base ? base.score : null,
              delta: latest && base ? latest.summary.score - base.score : null,
              regressed: latest ? latest.regressed : false
            });
          }
          out = rows;
          break;
        }
        case 'lens_set_baseline': {
          const runs = store.listEvalRuns(a.suite);
          if (!runs.length) throw new Error('no runs for suite ' + a.suite);
          store.setBaseline(a.suite, { runId: runs[0].id, score: runs[0].summary.score, at: runs[0].startedAt });
          out = { ok: true, suite: a.suite, baseline: runs[0].summary.score };
          break;
        }
        default:
          throw new Error('unknown tool: ' + name);
      }
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + String((e && e.message) || e) }], isError: true };
    }
  }

  if (method.startsWith('notifications/')) return undefined;
  throw new Error('method not supported: ' + method);
}

function send(io, obj) {
  io.stdout.write(JSON.stringify(obj) + '\n');
}

function wire(io) {
  let buf = '';
  io.stdin.setEncoding('utf8');
  io.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send(io, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      handle(msg)
        .then((r) => {
          if (r !== undefined) send(io, { jsonrpc: '2.0', id: msg.id, result: r });
        })
        .catch((e) =>
          send(io, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } })
        );
    }
  });
}

if (require.main === module) wire(process);

module.exports = { handle, wire, TOOLS };
