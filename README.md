# ◎ AgentLens

**Local-first evaluation & observability for LLM agents.** Traces, eval suites, LLM-as-judge, CI regression gates and an MCP server — in one zero-dependency Node process.

> 2026's consensus: *the model is solved, the reliability layer is not.* 88% of orgs use AI somewhere, but fewer than 10% scaled any function — because agents are nondeterministic and nobody can debug or gate them. AgentLens is that missing layer, with a business model that fits: the local core is the product, not a trial.

```
npm start          # → http://localhost:4175
npm run seed       # optional: a week of realistic demo traffic + eval history
npm test           # 25/25 pipeline tests
npm run gate -- --suite triage-core --min-score 70   # CI regression gate
npm run mcp        # MCP server for Claude Desktop / Cursor / ZCode
```

No `npm install`. Node 18+. That's the whole install.

For the real LLM-as-judge, copy `.env.example` → `.env` and add your Groq key (`.env` is gitignored; `env.js` loads it without overriding real environment variables). Default judge model: `openai/gpt-oss-120b`. Without a key, the deterministic heuristic judge keeps everything running offline — and an empty store can bootstrap itself from the dashboard's empty state (`POST /api/seed`).

---

## What you get

| Capability | How it works |
|---|---|
| **Trace ingestion** | `POST /api/traces` with an OpenTelemetry-style span tree (agent → llm → tool), or use the bundled [`Lens` SDK](public/agentlens.js) |
| **Flight-recorder UI** | Span waterfall with time ruler, per-span input/output/errors, tokens, cost, status LEDs |
| **Eval suites** | Declarative JSON cases in [`evals/suites/`](evals/suites) — checks: `contains`, `regex`, `json_valid`, `max_latency_ms`, `max_cost_usd`, … |
| **LLM-as-judge** | Quality checks scored 1–10 by Groq (`GROQ_API_KEY`) with a deterministic heuristic fallback — evals never block on the network |
| **Regression gate** | Every suite has a baseline; score drops ≥ threshold flag `REGRESSED`. `gate.js` exits 1 so CI fails loudly |
| **MCP server** | Agents can inspect their own traces and run their own evals (`lens_run_eval`) — the self-testing agent loop |
| **Eval-to-prod loop** | Every eval case is also recorded as a tagged trace, so offline tests and live traffic share one timeline |

## Architecture (one process, zero deps)

```
server.js        HTTP + REST API + static dashboard     → :4175
store.js         append-only JSONL (data/traces.jsonl)  → files you own
env.js           tiny zero-dep .env loader
evals.js         suite runner, checks, scoring, regression
judge.js         Groq LLM-as-judge + heuristic fallback
gate.js          CI exit-code gate
mcp-server.js    stdio JSON-RPC MCP server
mock-agent.js    demo support-triage agent (deterministic)
seed.js          demo data bootstrap
public/          flight-recorder dashboard (vanilla JS/CSS)
```

**Storage is plain JSONL** — `tail -f data/traces.jsonl`, grep it, ship it anywhere. Nothing phones home.

## The Lens SDK (2 lines of integration)

```js
const Lens = require('./agentlens.js');           // served at /agentlens.js

const t = Lens.startTrace('support-run', { model: 'gpt-4o', tags: ['prod'] });
const plan = t.span('llm.plan', { kind: 'llm', input: { q } });
plan.end({ next: 'search_kb' });
const kb = t.span('tool.search_kb', { kind: 'tool', input: { query: q } });
kb.end({ snippet });
await t.end('ok', { output: answer, tokens: { input: 320, output: 180 } });
```

Or wrap a whole run: `const out = await Lens.trace('run', opts, async (t) => …);` — errors are captured automatically.

## MCP config (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "agentlens": { "command": "node", "args": ["/path/to/agentlens/mcp-server.js"] }
  }
}
```

Tools: `lens_overview`, `lens_list_traces`, `lens_get_trace`, `lens_list_suites`, `lens_run_eval`, `lens_eval_summary`, `lens_set_baseline`.

The killer loop: your coding agent edits a prompt → calls `lens_run_eval` → sees the score → calls `lens_set_baseline` when it improves. Agents that test themselves.

## CI

```yaml
- name: Prompt regression gate
  run: node gate.js --suite triage-core --min-score 70 --max-regression 5
  env:
    GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}   # optional — heuristic judge otherwise
```

## Suites

```json
{
  "name": "triage-core",
  "target": { "type": "mock" },
  "regression_threshold": 5,
  "cases": [
    {
      "name": "billing: refund request",
      "input": { "question": "I was charged twice this month, I want a refund" },
      "checks": [
        { "type": "contains", "value": "refund" },
        { "type": "regex", "value": "TCK-\\d+" },
        { "type": "judge", "name": "qa-judge", "min": 5, "criteria": "…empathy, grounding, next step…" }
      ]
    }
  ]
}
```

Targets: built-in `mock`, or `{ "type": "http", "url": "http://localhost:3000/agent" }` pointing at your real agent (`POST {input} → {output, tokens?, costUsd?, spans?}`).

## API

| Route | What |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/stats` | runs, fail rate, p95, spend, eval pass rate |
| `GET /api/traces?limit&status&tag&q` | filtered list (span summaries) |
| `GET /api/traces/:id` | full span waterfall |
| `POST /api/traces` | ingest a trace |
| `GET /api/suites` | available eval suites |
| `POST /api/evals/run {suite}` | run + record an eval |
| `GET /api/evals` · `GET /api/evals/:id` | run history · full results |
| `GET /api/baselines` · `POST /api/baselines {suite}` | read · promote latest run |
| `POST /api/seed` | bootstrap demo data (409 unless store empty or `{force:true}`) |

## Pricing (the plan)

- **OSS Core — $0 forever.** Local traces/evals, waterfall UI, MCP, CI gate. This repo.
- **Cloud — $29/user/mo.** Hosted dashboards, shareable trace links, team workspaces, Slack regression alerts, scheduled evals.
- **Team/On-prem — $99/user/mo.** SSO/SAML, audit logs, unlimited retention, the same zero-dep binary deployed in your VPC.

Distribution flywheel: the free core gets embedded in CI pipelines and MCP configs — every project that adopts it argues for the team tier later. Traces are too sensitive to outsource by default, which is exactly why local-first wins the wedge.

## Why this beats hosted tools (Braintrust / LangSmith / Langfuse)

1. **Zero install** — no Docker, no SaaS signup; `node server.js` and you're recording.
2. **No lock-in** — data is JSONL files you own; no framework coupling.
3. **The gate is the product** — most tools show dashboards; AgentLens *blocks bad prompts in CI*.
4. **Agent-native** — MCP server means the agent itself is the operator, not just a human staring at charts.
5. **Offline evals** — heuristic judge keeps CI green when the LLM API is down; Groq judge when it isn't.

**Proven in this repo's own history**: the judge caught the demo agent serving irrelevant KB snippets (pricing answered 1/10), the fix was shipped, and the suite climbed 50 → 83 → 100 with the baseline re-promoted — the exact loop AgentLens exists to close.

## Roadmap

- OpenTelemetry span format compatibility + OTLP endpoint
- Dataset capture from production traces ("this failing run → new eval case" one-click)
- Multi-agent nested trace stitching
- Hosted Cloud tier (waitlist: `hello@agentlens.dev`)

## Interview talking points

This project demonstrates, end to end, exactly what "AI engineer / eval engineer" job posts ask for in 2026:

- **Observability design**: OTel-style span trees, waterfall rendering, p95 latency and cost accounting
- **Eval engineering**: declarative checks, LLM-as-judge with rubric prompts, deterministic fallbacks, regression thresholds
- **Agent reliability**: the "88% use / 10% scale" problem, framed and attacked with CI gates
- **Protocol breadth**: a hand-rolled JSON-RPC 2.0 MCP server and a UMD SDK — no framework crutches
- **Engineering discipline**: 25/25 zero-dependency tests, crash-safe append-only storage, graceful degradation everywhere

## License

MIT
