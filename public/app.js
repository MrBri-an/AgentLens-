/* AgentLens dashboard — vanilla JS SPA. Hash routing, zero deps.
   Flows: overview → trace detail; evals → run → baseline; docs; pricing. */
'use strict';
(() => {
  const view = document.getElementById('view');

  /* ---------------- helpers ---------------- */

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's');
  const fmtCost = (c) => (c == null ? '—' : c === 0 ? '$0' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(2));
  const fmtTok = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const timeAgo = (ts) => {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };
  const dot = (st) => '<span class="dot ' + (st === 'error' ? 'err' : 'ok') + '"></span>';
  const badge = (t, cls) => '<span class="badge ' + (cls || '') + '">' + esc(t) + '</span>';
  const kindCls = (k) => ({ agent: 'k-agent', llm: 'k-llm', tool: 'k-tool' }[k] || '');

  async function j(url, opts) {
    const r = await fetch(url, opts);
    const d = await r.json();
    if (!r.ok) throw new Error((d && d.error) || 'HTTP ' + r.status);
    return d;
  }

  const post = (url, body) =>
    j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  function toast(msg, type) {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast t-' + (type || 'info');
    el.innerHTML = '<span class="t-dot"></span><span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 200);
    }, 3800);
  }

  const page = (html) => { view.innerHTML = '<div class="page">' + html + '</div>'; };

  const ICON = {
    inbox: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    gauge: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/><path d="M12 7v.01"/><path d="M7 12h.01"/></svg>'
  };

  const emptyState = (icon, title, desc, actionHtml) =>
    '<div class="card empty">' + icon + '<h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p>' + (actionHtml || '') + '</div>';

  const errView = (e) => {
    page(
      '<div class="card err-view"><h3>Something went wrong</h3>' +
      '<div class="msg">' + esc((e && e.message) || e) + '</div>' +
      '<button class="btn btn-ghost" id="btn-retry">Retry</button></div>'
    );
    const b = document.getElementById('btn-retry');
    if (b) b.onclick = () => router();
  };

  const sk = (w, h, extra) => '<div class="sk ' + (extra || '') + '" style="width:' + w + ';height:' + h + '"></div>';
  const skeletonOverview = () =>
    '<section class="kpis">' + Array.from({ length: 5 }, () => '<div class="card">' + sk('60%', 26) + '</div>').join('') + '</section>' +
    '<section class="grid-2">' + '<div class="card">' + sk('100%', 120) + '</div><div class="card">' + sk('100%', 120) + '</div></section>' +
    '<div class="card">' + sk('100%', 180) + '</div>';
  const skeletonList = () => '<div class="card">' + sk('30%', 34, 'sk-mb') + sk('100%', 320) + '</div>';

  function sparkline(values, h, cls) {
    const w = 560;
    if (!values.length) return '<svg class="spark ' + (cls || '') + '" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
    const max = Math.max.apply(null, values.concat([1]));
    const pts = values.map((v, i) => [
      values.length > 1 ? (i / (values.length - 1)) * (w - 8) + 4 : w / 2,
      h - 4 - (v / max) * (h - 10)
    ]);
    const line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = '4,' + (h - 1) + ' ' + line + ' ' + (w - 4) + ',' + (h - 1);
    const last = pts[pts.length - 1];
    return (
      '<svg class="spark ' + (cls || '') + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon class="spark-area" points="' + area + '"/>' +
      '<polyline class="spark-line" points="' + line + '"/>' +
      '<circle class="spark-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.5"/></svg>'
    );
  }

  function kpi(label, valueHtml, sub) {
    return '<div class="card"><div class="kpi-label">' + label + '</div><div class="kpi-value">' + valueHtml + '</div><div class="kpi-sub">' + sub + '</div></div>';
  }

  const errBadge = (rate) =>
    '<span class="badge ' + (rate > 5 ? 'b-red' : rate > 0 ? 'b-amber' : 'b-green') + '">' + rate + '%</span>';

  function runRow(t) {
    return (
      '<tr class="rowlink" data-id="' + esc(t.id) + '" tabindex="0" role="link" aria-label="open trace ' + esc(t.name) + '">' +
      '<td><span class="cell-name">' + dot(t.status) + '<span>' + esc(t.name) + '</span></span></td>' +
      '<td class="num">' + fmtMs(t.durationMs) + '</td>' +
      '<td class="num">' + (t.spanCount != null ? t.spanCount : '—') + '</td>' +
      '<td class="num">' + fmtCost(t.costUsd) + '</td>' +
      '<td class="num">' + fmtTok(t.tokens ? t.tokens.input + t.tokens.output : 0) + '</td>' +
      '<td>' + (t.tags || []).map((x) => badge(x)).join(' ') + '</td>' +
      '<td class="dim small">' + timeAgo(t.startedAt) + '</td></tr>'
    );
  }

  const RUN_HEAD =
    '<thead><tr><th>run</th><th class="num">duration</th><th class="num">spans</th><th class="num">cost</th>' +
    '<th class="num">tokens</th><th>tags</th><th>when</th></tr></thead>';

  function bindRowLinks(prefix) {
    view.querySelectorAll('tr.rowlink[data-id]').forEach((tr) => {
      const open = () => (location.hash = prefix + tr.dataset.id);
      tr.onclick = open;
      tr.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
  }

  /* ---------------- overview ---------------- */

  async function renderOverview() {
    page(skeletonOverview());
    const [stats, runs, evals, suites] = await Promise.all([
      j('/api/stats'),
      j('/api/traces?limit=500'),
      j('/api/evals'),
      j('/api/suites')
    ]);

    if (stats.total === 0) {
      page(
        emptyState(
          ICON.inbox,
          'No traces yet',
          'Point the Lens SDK at this server and record your first agent run — or load a week of realistic demo traffic with eval history.',
          '<button class="btn btn-primary" id="btn-seed">Load demo data</button>'
        )
      );
      const b = document.getElementById('btn-seed');
      if (b)
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = 'Seeding…';
          try {
            await post('/api/seed');
            toast('Demo data loaded', 'ok');
            renderOverview();
          } catch (e) {
            toast(e.message, 'err');
            b.disabled = false;
            b.textContent = 'Load demo data';
          }
        };
      return;
    }

    const dayMap = {};
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      dayMap[k] = { total: 0, err: 0 };
      days.push(k);
    }
    runs.forEach((t) => {
      const k = new Date(t.startedAt).toISOString().slice(0, 10);
      if (dayMap[k]) {
        dayMap[k].total++;
        if (t.status === 'error') dayMap[k].err++;
      }
    });

    const latestBySuite = {};
    evals.forEach((r) => {
      if (!latestBySuite[r.suite]) latestBySuite[r.suite] = r;
    });
    const suiteCards = suites
      .map((s) => {
        const r = latestBySuite[s.name];
        if (!r) return '';
        const score = r.summary.score;
        const cls = score >= 80 ? 'b-green' : score >= 50 ? 'b-amber' : 'b-red';
        return (
          '<a class="card interactive suite-card" href="#/evals"><div class="suite-name">' + esc(s.name) + '</div>' +
          '<div class="suite-score">' + score + '<span class="suite-total">/100</span> ' +
          (r.regressed ? badge('regressed', 'b-red') : '') + '</div>' +
          '<div class="meter"><i class="' + cls + '" style="width:' + score + '%"></i></div>' +
          '<div class="dim small">' + r.summary.passed + '/' + r.summary.total + ' cases · ' + timeAgo(r.startedAt) + '</div></a>'
        );
      })
      .join('');

    page(
      '<section class="kpis">' +
      kpi('Traces', String(stats.total), stats.tokens.toLocaleString() + ' tokens observed') +
      kpi('Fail rate', errBadge(stats.failRate), stats.failed + ' errored runs') +
      kpi('Latency p95', fmtMs(stats.p95Ms), 'avg ' + fmtMs(stats.avgMs)) +
      kpi('Spend', fmtCost(stats.costUsd), 'estimated across all runs') +
      kpi('Eval pass', stats.evalPassRate == null ? '—' : stats.evalPassRate + '%', stats.evalRuns + ' eval runs') +
      '</section>' +
      '<section class="grid-2">' +
      '<div class="card panel"><div class="panel-head"><h2>Run volume · 14 days</h2>' +
      '<span class="dim small">green total · red errors</span></div>' +
      sparkline(days.map((k) => dayMap[k].total), 84, 'big') +
      sparkline(days.map((k) => dayMap[k].err), 40, 'err') +
      '</div>' +
      '<div class="card panel"><div class="panel-head"><h2>Eval suites</h2><a class="btn btn-ghost btn-sm" href="#/evals">All evals →</a></div>' +
      '<div class="suite-strip">' + (suiteCards || '<p class="dim small">No suites found in evals/suites/.</p>') + '</div></div>' +
      '</section>' +
      '<section class="card panel"><div class="panel-head"><h2>Recent traces</h2><a class="btn btn-ghost btn-sm" href="#/runs">All traces →</a></div>' +
      '<table class="tbl">' + RUN_HEAD + '<tbody>' + runs.slice(0, 8).map(runRow).join('') + '</tbody></table></section>'
    );

    bindRowLinks('#/runs/');
  }

  /* ---------------- traces ---------------- */

  let runFilter = { status: '', q: '' };

  async function renderRuns() {
    page(skeletonList());
    const qs =
      '/api/traces?limit=100' +
      (runFilter.status ? '&status=' + runFilter.status : '') +
      (runFilter.q ? '&q=' + encodeURIComponent(runFilter.q) : '');
    const runs = await j(qs);

    if (!runs.length) {
      page(
        emptyState(
          ICON.inbox,
          runFilter.q || runFilter.status ? 'No traces match' : 'No traces yet',
          runFilter.q || runFilter.status
            ? 'Try a different search or clear the filters.'
            : 'Record your first run with the SDK, or load demo data from the overview.',
          (runFilter.q || runFilter.status
            ? '<button class="btn btn-ghost" id="btn-clear">Clear filters</button>'
            : '<a class="btn btn-primary" href="#/">Go to overview</a>')
        )
      );
      const c = document.getElementById('btn-clear');
      if (c)
        c.onclick = () => {
          runFilter = { status: '', q: '' };
          renderRuns();
        };
      return;
    }

    page(
      '<section class="page-head"><h1>Traces</h1>' +
      '<p class="dim">Every agent run with its full span waterfall. Ingest via <code>POST /api/traces</code> or the bundled <code>Lens</code> SDK — see <a href="#/docs">Docs</a>.</p></section>' +
      '<div class="card panel"><div class="filters">' +
      '<select id="f-status" aria-label="filter by status"><option value="">all statuses</option>' +
      '<option value="ok"' + (runFilter.status === 'ok' ? ' selected' : '') + '>ok</option>' +
      '<option value="error"' + (runFilter.status === 'error' ? ' selected' : '') + '>error</option></select>' +
      '<input id="f-q" placeholder="Search name, input or output…" value="' + esc(runFilter.q) + '" aria-label="search traces">' +
      '<span class="dim small">' + runs.length + ' runs</span></div>' +
      '<table class="tbl">' + RUN_HEAD + '<tbody>' + runs.map(runRow).join('') + '</tbody></table></div>'
    );

    document.getElementById('f-status').onchange = (e) => {
      runFilter.status = e.target.value;
      renderRuns();
    };
    let deb;
    document.getElementById('f-q').oninput = (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => {
        runFilter.q = e.target.value;
        renderRuns();
      }, 280);
    };
    bindRowLinks('#/runs/');
  }

  async function renderTrace(id) {
    page(
      '<div class="card">' +
      '<div class="trace-meta">' + sk('30%', 18) + sk('20%', 18) + sk('20%', 18) + '</div>' +
      Array.from({ length: 5 }, (_, i) => '<div style="margin-bottom:10px">' + sk(88 - i * 9 + '%', 16) + '</div>').join('') +
      '</div>'
    );
    let t;
    try {
      t = await j('/api/traces/' + id);
    } catch (e) {
      page(emptyState(ICON.inbox, 'Trace not found', 'It may have been seeded over. Head back to the list.', '<a class="btn btn-ghost" href="#/runs">All traces</a>'));
      return;
    }
    const spans = t.spans || [];
    const t0 = Math.min.apply(null, spans.map((s) => s.startedAt).concat([0]));
    const total = Math.max.apply(null, spans.map((s) => s.startedAt + s.durationMs).concat([1]));
    const errIdx = spans.findIndex((s) => s.status === 'error');
    const sel = errIdx >= 0 ? errIdx : 0;

    const ticks = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => '<span style="left:' + f * 100 + '%">' + fmtMs(total * f) + '</span>')
      .join('');

    const rows = spans
      .map((s, i) => {
        const left = ((s.startedAt - t0) / total) * 100;
        const width = Math.max(1.2, (s.durationMs / total) * 100);
        return (
          '<div class="wf-row' + (i === sel ? ' selected' : '') + (s.status === 'error' ? ' err' : '') +
          '" data-i="' + i + '" tabindex="0" role="button" aria-label="inspect span ' + esc(s.name) + '">' +
          '<div class="wf-name">' + dot(s.status) + esc(s.name) + '</div>' +
          '<div class="wf-track"><div class="wf-bar ' + kindCls(s.kind) + (s.status === 'error' ? ' bar-err' : '') +
          '" style="margin-left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;animation-delay:' + 60 + i * 45 + 'ms"></div></div>' +
          '<div class="wf-ms">' + fmtMs(s.durationMs) + '</div></div>'
        );
      })
      .join('');

    page(
      '<section class="page-head"><a href="#/runs">← Traces</a><h1>' + dot(t.status) + esc(t.name) + '</h1></section>' +
      '<div class="card panel"><div class="trace-meta">' +
      '<span>status <b>' + esc(t.status) + '</b></span>' +
      '<span>model <b>' + esc(t.model || '—') + '</b></span>' +
      '<span>duration <b>' + fmtMs(t.durationMs) + '</b></span>' +
      '<span>tokens <b>' + fmtTok(t.tokens.input) + ' in · ' + fmtTok(t.tokens.output) + ' out</b></span>' +
      '<span>cost <b>' + fmtCost(t.costUsd) + '</b></span>' +
      '<span>' + (t.tags || []).map((x) => badge(x)).join(' ') + '</span></div>' +
      '<div class="wf-ruler"><span>span</span><div class="ticks">' + ticks + '</div><span class="wf-ms">time</span></div>' +
      '<div class="wf">' + rows + '</div>' +
      '<div id="span-detail" style="margin-top:16px"></div></div>'
    );

    const detail = document.getElementById('span-detail');
    const ioBlock = (label, v) =>
      '<div style="margin-bottom:12px"><div class="dim small" style="margin-bottom:5px">' + label + '</div>' +
      '<pre class="io">' + (v == null || v === '' ? '—' : esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))) + '</pre></div>';
    const showSpan = (i) => {
      const s = spans[i];
      if (!s) return;
      view.querySelectorAll('.wf-row').forEach((r) => r.classList.toggle('selected', Number(r.dataset.i) === i));
      detail.innerHTML =
        '<h3>' + esc(s.name) + ' <span class="dim small">· ' + esc(s.kind) + (s.model ? ' · ' + esc(s.model) : '') + '</span></h3>' +
        '<div class="trace-meta"><span>starts <b>+' + fmtMs(s.startedAt) + '</b></span>' +
        '<span>duration <b>' + fmtMs(s.durationMs) + '</b></span>' +
        (s.tokens ? '<span>tokens <b>' + esc(String(s.tokens)) + '</b></span>' : '') + '</div>' +
        ioBlock('input', s.input) +
        ioBlock('output', s.output) +
        (s.error ? '<div class="dim small" style="margin-bottom:5px">error</div><pre class="io"><span class="err-line">' + esc(s.error) + '</span></pre>' : '');
    };
    showSpan(sel);
    view.querySelectorAll('.wf-row').forEach((r) => {
      const open = () => showSpan(Number(r.dataset.i));
      r.onclick = open;
      r.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
  }

  /* ---------------- evals ---------------- */

  async function renderEvals() {
    page(skeletonList());
    const [suites, runs, baselines] = await Promise.all([j('/api/suites'), j('/api/evals'), j('/api/baselines')]);
    const bySuite = {};
    runs.forEach((r) => (bySuite[r.suite] = bySuite[r.suite] || []).push(r));

    if (!suites.length) {
      page(
        emptyState(
          ICON.gauge,
          'No eval suites',
          'Drop suite JSON files into evals/suites/ — cases, declarative checks and optional LLM-as-judge criteria.',
          '<a class="btn btn-primary" href="#/docs">Read the docs</a>'
        )
      );
      return;
    }

    const cards = suites
      .map((s) => {
        const rs = bySuite[s.name] || [];
        const latest = rs[0];
        const b = baselines[s.name];
        const scores = rs.slice(0, 12).reverse().map((r) => r.summary.score);
        return (
          '<div class="card panel suite-block" id="suite-' + esc(s.name) + '">' +
          '<div class="panel-head"><h2>' + esc(s.name) + '</h2><div class="panel-actions">' +
          '<button class="btn btn-primary btn-sm" data-run="' + esc(s.name) + '">Run suite</button>' +
          '<button class="btn btn-ghost btn-sm" data-baseline="' + esc(s.name) + '"' + (rs.length ? '' : ' disabled') + '>Set baseline</button>' +
          '</div></div>' +
          '<p class="dim small" style="margin-bottom:6px">' + esc(s.description || '') + '</p>' +
          '<p class="dim small" style="margin-bottom:14px">' + s.cases + ' cases · target: ' + esc((s.target && s.target.type) || 'mock') +
          ' · regression threshold: −' + s.regressionThreshold + '</p>' +
          (latest
            ? '<div class="eval-latest"><div class="suite-score">' + latest.summary.score + '<span class="suite-total">/100</span></div>' +
              (latest.regressed
                ? badge('regressed ' + latest.delta, 'b-red')
                : latest.delta != null && latest.delta > 0
                ? badge('+' + latest.delta + ' vs baseline', 'b-green')
                : '') +
              '<div class="dim small">baseline ' + (b ? b.score : 'not set') + ' · ' +
              latest.summary.passed + '/' + latest.summary.total + ' passed · avg ' + fmtMs(latest.summary.avgLatencyMs) + '</div>' +
              '<div class="spark-box">' + sparkline(scores, 40) + '</div></div>' +
              '<table class="tbl"><thead><tr><th>run</th><th class="num">score</th><th class="num">passed</th><th>delta</th><th>when</th></tr></thead><tbody>' +
              rs.slice(0, 8)
                .map(
                  (r) =>
                    '<tr class="rowlink" data-eval="' + esc(r.id) + '" tabindex="0" role="button" aria-label="open eval run">' +
                    '<td class="mono small">' + esc(r.id.slice(0, 14)) + '</td>' +
                    '<td class="num">' + r.summary.score + '</td>' +
                    '<td class="num">' + r.summary.passed + '/' + r.summary.total + '</td>' +
                    '<td>' + (r.delta == null ? '<span class="dim">—</span>' : (r.delta >= 0 ? '+' : '') + r.delta + (r.regressed ? ' ' + badge('reg', 'b-red') : '')) + '</td>' +
                    '<td class="dim small">' + timeAgo(r.startedAt) + '</td></tr>'
                )
                .join('') +
              '</tbody></table>'
            : '<p class="dim small">No runs yet — press “Run suite”.</p>') +
          '<div class="eval-detail" id="detail-' + esc(s.name) + '"></div></div>'
        );
      })
      .join('');

    page(
      '<section class="page-head"><h1>Evals</h1>' +
      '<p class="dim">Datasets + checks + LLM-as-judge. Every run is recorded and compared against the suite baseline — a score drop flags a regression. Wire <code>node gate.js --suite &lt;name&gt;</code> into CI to block bad prompts before they ship.</p></section>' +
      cards
    );

    view.querySelectorAll('[data-run]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Running…';
        try {
          const run = await post('/api/evals/run', { suite: btn.dataset.run });
          toast(
            btn.dataset.run + ': ' + run.summary.score + '/100 · ' + run.summary.passed + '/' + run.summary.total + ' cases' +
            (run.regressed ? ' · REGRESSED' : ''),
            run.regressed ? 'err' : 'ok'
          );
          renderEvals();
        } catch (e) {
          toast('eval failed: ' + e.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Run suite';
        }
      };
    });

    view.querySelectorAll('[data-baseline]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const r = await post('/api/baselines', { suite: btn.dataset.baseline });
          toast('Baseline for ' + btn.dataset.baseline + ' set to ' + r.baseline, 'ok');
          renderEvals();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    });

    view.querySelectorAll('[data-eval]').forEach((tr) => {
      const open = async () => {
        const run = await j('/api/evals/' + tr.dataset.eval);
        const box = document.getElementById('detail-' + run.suite);
        if (!box) return;
        box.innerHTML =
          '<h3>' + esc(run.id) + '</h3>' +
          run.results
            .map(
              (r) =>
                '<details class="case' + (r.passed ? '' : ' case-fail') + '"><summary><span class="arrow">▶</span>' +
                (r.passed ? '<span class="dot ok"></span>' : '<span class="dot err"></span>') +
                esc(r.case) + ' <span class="dim small" style="margin-left:auto">' + fmtMs(r.latencyMs) + '</span></summary>' +
                '<div class="checks">' +
                r.checks
                  .map(
                    (c) =>
                      '<div class="check ' + (c.passed ? 'ck-pass' : 'ck-fail') + '"><span class="ck-badge">' +
                      (c.passed ? '✓' : '✗') + '</span> <b>' + esc(c.name || c.type) + '</b>' +
                      (c.type === 'judge' && c.score != null ? ' <span class="judge-score">' + c.score + '/10 · ' + esc(c.judge || '') + '</span>' : '') +
                      (c.detail ? '<p class="ck-detail">' + esc(c.detail) + '</p>' : '') +
                      '</div>'
                  )
                  .join('') +
                '</div>' +
                (r.output ? '<pre class="io">' + esc(String(r.output).slice(0, 800)) + '</pre>' : '') +
                '</details>'
            )
            .join('');
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      tr.onclick = open;
      tr.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      };
    });
  }

  /* ---------------- docs ---------------- */

  function renderDocs() {
    page(
      '<section class="page-head"><h1>Docs</h1>' +
      '<p class="dim">Everything AgentLens does, from a two-line SDK call to a CI gate. The full story lives in the repo <code>README.md</code>.</p></section>' +
      '<div class="card panel doc-section"><h2>Quickstart</h2>' +
      '<div class="code">npm start                          # dashboard on http://localhost:4175\nnpm run seed                       # optional: demo traffic + eval history\nGROQ_API_KEY=… npm start           # enables the real LLM-as-judge\nnpm run gate -- --suite triage-core --min-score 70   # CI regression gate\nnpm run mcp                        # MCP server for Claude / Cursor / ZCode</div></div>' +
      '<div class="card panel doc-section"><h2>Record a trace with the SDK</h2>' +
      '<p>Serve <code>/agentlens.js</code> from any page or <code>require</code> it in Node. Span kinds: <code>agent</code>, <code>llm</code>, <code>tool</code>.</p>' +
      '<div class="code">const t = Lens.startTrace(\'support-run\', { model: \'gpt-4o\', tags: [\'prod\'] });\nconst plan = t.span(\'llm.plan\', { kind: \'llm\', input: { q } });\nplan.end({ next: \'search_kb\' });\nconst kb = t.span(\'tool.search_kb\', { kind: \'tool\', input: { query: q } });\nkb.end({ snippet });\nawait t.end(\'ok\', { output: answer, tokens: { input: 320, output: 180 } });</div></div>' +
      '<div class="card panel doc-section"><h2>Eval suites</h2>' +
      '<p>Suites are JSON files in <code>evals/suites/</code>. Targets: built-in <code>mock</code> or <code>{"type":"http","url":"…"}</code> pointing at your real agent.</p>' +
      '<div class="code">{\n  "name": "triage-core",\n  "target": { "type": "mock" },\n  "regression_threshold": 5,\n  "cases": [{\n    "name": "billing: refund request",\n    "input": { "question": "I was charged twice" },\n    "checks": [\n      { "type": "contains", "value": "refund" },\n      { "type": "regex", "value": "TCK-\\\\d+" },\n      { "type": "judge", "min": 5, "criteria": "empathy, grounding, next step" }\n    ]\n  }]\n}</div></div>' +
      '<div class="card panel doc-section"><h2>API</h2>' +
      '<table class="tbl"><thead><tr><th>route</th><th>what</th></tr></thead><tbody>' +
      [['GET /api/health', 'liveness'], ['GET /api/stats', 'runs, fail rate, p95, spend, eval pass rate'], ['GET /api/traces', 'filtered list (limit, status, tag, q)'], ['GET /api/traces/:id', 'full span waterfall'], ['POST /api/traces', 'ingest a trace'], ['POST /api/evals/run', 'run + record an eval suite'], ['GET /api/evals[/:id]', 'run history / full results'], ['POST /api/baselines', 'promote latest run to baseline'], ['POST /api/seed', 'load demo data (409 unless store is empty or {"force":true})']]
        .map((r) => '<tr><td class="mono small">' + esc(r[0]) + '</td><td class="dim">' + esc(r[1]) + '</td></tr>')
        .join('') +
      '</tbody></table></div>' +
      '<div class="card panel doc-section"><h2>MCP — let your agent self-test</h2>' +
      '<p>Add to Claude Desktop / Cursor config. The agent can then inspect traces and run its own evals after changing a prompt.</p>' +
      '<div class="code">{\n  "mcpServers": {\n    "agentlens": { "command": "node", "args": ["/path/to/agentlens/mcp-server.js"] }\n  }\n}</div></div>' +
      '<div class="card panel doc-section"><h2>Configuration</h2>' +
      '<p><code>.env</code> (gitignored) or real environment variables — <code>GROQ_API_KEY</code>, <code>GROQ_MODEL</code> (default <code>openai/gpt-oss-120b</code>), <code>PORT</code>. Without a key, the deterministic heuristic judge keeps evals running offline.</p></div>'
    );
  }

  /* ---------------- pricing ---------------- */

  function renderPricing() {
    page(
      '<section class="page-head"><h1>Pricing</h1>' +
      '<p class="dim">The core is open, local and free forever — your traces never leave your machine. Paid tiers exist for teams that want this shared, hosted and alerted.</p></section>' +
      '<div class="tiers">' +
      '<div class="card tier"><h3>OSS Core</h3><div class="price">$0<small> / forever</small></div>' +
      '<ul><li>Unlimited local traces &amp; evals</li><li>Span waterfall + flight recorder UI</li><li>LLM-as-judge (your API key)</li><li>MCP server for coding agents</li><li>CI regression gate</li></ul>' +
      '<a class="btn btn-ghost" href="#/">You are here →</a></div>' +
      '<div class="card tier featured"><span class="tier-tag">Most popular</span><h3>Cloud</h3><div class="price">$29<small> / user / mo</small></div>' +
      '<ul><li>Hosted dashboards &amp; shareable trace links</li><li>Team workspaces &amp; comments</li><li>90-day retention + search</li><li>Slack / email regression alerts</li><li>Scheduled eval runs</li></ul>' +
      '<a class="btn btn-primary" href="mailto:hello@agentlens.dev?subject=AgentLens%20Cloud%20waitlist">Join the waitlist →</a></div>' +
      '<div class="card tier"><h3>Team / On-prem</h3><div class="price">$99<small> / user / mo</small></div>' +
      '<ul><li>Everything in Cloud</li><li>SSO / SAML &amp; audit logs</li><li>Unlimited retention</li><li>On-prem deployment (same zero-dep binary)</li><li>Priority support</li></ul>' +
      '<a class="btn btn-ghost" href="mailto:hello@agentlens.dev?subject=AgentLens%20Team">Talk to us →</a></div>' +
      '</div>' +
      '<div class="card panel"><div class="panel-head"><h2>Why local-first</h2></div>' +
      '<p class="dim" style="font-size:13.5px">Traces contain prompts, customer text and proprietary logic — shipping them to a vendor is a non-starter for many teams. AgentLens runs as a single zero-dependency Node process: <code>npm start</code> and it records to plain JSONL files you own. Regressions are caught by the same engine in CI, so the free tier is the whole product, not a trial.</p></div>'
    );
  }

  /* ---------------- router ---------------- */

  function router() {
    const hash = location.hash || '#/';
    const parts = hash.slice(2).split('/');
    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.classList.toggle('active', a.dataset.nav === (parts[0] || 'overview'));
    });
    const p = parts[0] || '';
    const guard = (pr) => pr.catch(errView);
    if (p === '' || p === 'overview') return guard(renderOverview());
    if (p === 'runs' && parts[1]) return guard(renderTrace(parts[1]));
    if (p === 'runs') return guard(renderRuns());
    if (p === 'evals') return guard(renderEvals());
    if (p === 'docs') return renderDocs();
    if (p === 'pricing') return renderPricing();
    return guard(renderOverview());
  }

  window.addEventListener('hashchange', router);
  router();

  fetch('/api/health')
    .then((r) => r.json())
    .then(() => {
      document.getElementById('led').classList.add('online');
      document.getElementById('status-label').textContent = 'recording';
      document.getElementById('foot-status').textContent = 'AgentLens online · localhost:4175 · zero-dep';
    })
    .catch(() => {
      document.getElementById('status-label').textContent = 'offline';
      document.getElementById('foot-status').textContent = 'API unreachable — is the server running?';
    });

  const tick = () => {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toISOString().slice(11, 19) + 'Z';
  };
  tick();
  setInterval(tick, 1000);
  setInterval(() => {
    if (!document.hidden && (location.hash || '#/') === '#/') router();
  }, 15000);
})();
