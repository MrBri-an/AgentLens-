/*!
 * AgentLens SDK — embed in any browser or Node(18+) app.
 *   const t = Lens.startTrace('support-run', { model: 'gpt-4o', tags: ['prod'] });
 *   const s = t.span('llm.plan', { kind: 'llm', input: { q } });
 *   s.end({ next: 'search' });
 *   await t.end('ok', { output: 'done', tokens: { input: 120, output: 340 } });
 * Zero dependencies. POSTs OpenTelemetry-style span trees to /api/traces.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Lens = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // $ per 1M tokens [input, output]
  const RATES = { default: [0.15, 0.6], 'mock/triage-v2': [0.1, 0.3] };
  const cfg = {
    endpoint:
      typeof location !== 'undefined' && location.origin && /^http/.test(location.origin)
        ? location.origin
        : 'http://localhost:4175',
    debug: false
  };

  function uid(p) {
    return (p || 'sp') + '_' + Math.random().toString(16).slice(2, 10);
  }

  function estCost(model, tokens) {
    const r = RATES[model] || RATES.default;
    return +((tokens.input * r[0] + tokens.output * r[1]) / 1e6).toFixed(6);
  }

  function makeSpan(t, name, opts, parentId) {
    const s = {
      id: uid(),
      parentId: parentId,
      name: name,
      kind: (opts && opts.kind) || 'tool',
      model: (opts && opts.model) || null,
      startedAt: Date.now() - t.t0,
      durationMs: 0,
      status: 'ok',
      input: opts && opts.input !== undefined ? opts.input : null,
      output: null,
      error: null,
      tokens: null,
      costUsd: null
    };
    t.spans.push(s);
    return {
      span: (n, o) => makeSpan(t, n, o, s.id),
      end: function (out, extra) {
        s.durationMs = Date.now() - t.t0 - s.startedAt;
        if (out !== undefined) s.output = out;
        if (extra) Object.assign(s, extra);
        return s;
      },
      fail: function (err) {
        s.durationMs = Date.now() - t.t0 - s.startedAt;
        s.status = 'error';
        s.error = String((err && err.stack) || err);
        return s;
      }
    };
  }

  function startTrace(name, opts) {
    opts = opts || {};
    const t = {
      name: name,
      startedAt: Date.now(),
      t0: Date.now(),
      model: opts.model || null,
      tags: opts.tags || [],
      input: opts.input !== undefined ? opts.input : null,
      spans: [],
      rootId: null
    };
    const root = {
      id: uid('sp'),
      parentId: null,
      name: name,
      kind: 'agent',
      model: t.model,
      startedAt: 0,
      durationMs: 0,
      status: 'ok',
      input: t.input,
      output: null,
      error: null,
      tokens: null,
      costUsd: null
    };
    t.spans.push(root);
    t.rootId = root.id;
    return {
      span: (n, o) => makeSpan(t, n, o, root.id),
      end: function (status, extra) {
        root.durationMs = Date.now() - t.t0;
        root.status = status === 'error' ? 'error' : 'ok';
        const tokens = (extra && extra.tokens) || { input: 0, output: 0 };
        const payload = {
          id: opts.id || uid('tr'),
          name: t.name,
          startedAt: t.startedAt,
          durationMs: root.durationMs,
          status: root.status,
          model: t.model,
          tags: t.tags,
          input: t.input,
          output: extra && extra.output !== undefined ? extra.output : null,
          error: (extra && extra.error) || null,
          tokens: tokens,
          costUsd: extra && extra.costUsd != null ? extra.costUsd : estCost(t.model, tokens),
          spans: t.spans
        };
        return fetch(cfg.endpoint.replace(/\/$/, '') + '/api/traces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
          .then((r) => r.json())
          .catch((e) => {
            if (cfg.debug) console.warn('[AgentLens] flush failed', e);
          });
      }
    };
  }

  async function trace(name, opts, fn) {
    const t = startTrace(name, opts);
    try {
      const out = await fn(t);
      await t.end('ok', { output: out });
      return out;
    } catch (e) {
      await t.end('error', { error: String((e && e.stack) || e) });
      throw e;
    }
  }

  return {
    init: (o) => Object.assign(cfg, o),
    startTrace,
    trace,
    config: cfg,
    version: '0.1.0'
  };
});
