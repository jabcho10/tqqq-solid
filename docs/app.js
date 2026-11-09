/* TQQQ 솔리드 백테스트 페이지 */
(function () {
  'use strict';
  const E = window.SolidEngine;
  const $ = id => document.getElementById(id);
  const DATA = { dates: [], tqqq: [], qqq: [], iso: [] };

  // ───────── 형식 ─────────
  const pct = (x, d = 1, sign = false) => (x == null || !isFinite(x)) ? '–'
    : (sign && x > 0 ? '+' : '') + (x * 100).toFixed(d).replace('-', '−') + '%';
  const num = (x, d = 2) => (x == null || !isFinite(x)) ? '–'
    : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = x => (x < 0 ? '−$' : '$') + num(Math.abs(x), 2);
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const cls = x => x > 0 ? 'pos' : x < 0 ? 'neg' : '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } },
  };

  // ───────── 테마 ─────────
  const THEMES = ['auto', 'light', 'dark'], THEME_LABEL = { auto: '자동', light: '밝게', dark: '어둡게' };
  let theme = store.get('solid-theme') || 'auto';
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('themeBtn').textContent = '테마: ' + THEME_LABEL[theme];
  }
  $('themeBtn').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set('solid-theme', theme); applyTheme(); drawCharts();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawCharts());
  applyTheme();

  // ───────── 탭 ─────────
  const tabs = document.querySelectorAll('nav.tabs button');
  function showTab(name) {
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $('tab-bt').hidden = name !== 'bt'; $('tab-calc').hidden = name !== 'calc';
    store.set('solid-tab', name);
    if (name === 'bt') drawCharts();
  }
  tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ───────── 설정 폼 ─────────
  // UI 값 <-> 엔진 파라미터
  const UI_DEFAULT = {
    start: '1991-01-02', end: '', init_ratio: 20, add_ratio: 25, b1: -0.5, b2: -11, max_adds: 7,
    take_profit: 4.5, time_stop: 24, use_rsi: true, rsi_ratio: 30, rsi_buy: 22, rsi_sell: 25, rsi_hold: 10,
    use_mom: true, mom_months: 12, mom_mult: 0.25, fee: 0.07,
  };
  const KEYS = Object.keys(UI_DEFAULT);
  function readUI() {
    const u = {};
    for (const k of KEYS) {
      const el = $('p_' + k);
      if (typeof UI_DEFAULT[k] === 'boolean') u[k] = el.checked;
      else if (typeof UI_DEFAULT[k] === 'string') u[k] = el.value;
      else { const v = parseFloat(el.value); u[k] = isFinite(v) ? v : UI_DEFAULT[k]; }
    }
    return u;
  }
  function writeUI(u) {
    for (const k of KEYS) {
      const el = $('p_' + k);
      if (typeof UI_DEFAULT[k] === 'boolean') el.checked = !!u[k]; else el.value = u[k];
    }
  }
  const toParams = u => ({
    init_ratio: u.init_ratio / 100, add_ratio: u.add_ratio / 100, b1: 1 + u.b1 / 100, b2: 1 + u.b2 / 100,
    max_adds: Math.round(u.max_adds), take_profit: 1 + u.take_profit / 100, time_stop: Math.round(u.time_stop),
    use_rsi: u.use_rsi, rsi_ratio: u.rsi_ratio / 100, rsi_buy: u.rsi_buy, rsi_sell: u.rsi_sell,
    rsi_hold: Math.round(u.rsi_hold), use_mom: u.use_mom, mom_lookback: Math.round(252 * u.mom_months / 12),
    mom_mult: u.mom_mult, fee: u.fee / 100,
  });
  function uiFromHash() {
    const u = Object.assign({}, UI_DEFAULT);
    const h = new URLSearchParams(location.hash.slice(1));
    for (const k of KEYS) {
      if (!h.has(k)) continue;
      const v = h.get(k);
      if (typeof UI_DEFAULT[k] === 'boolean') u[k] = v === '1';
      else if (typeof UI_DEFAULT[k] === 'string') u[k] = v;
      else if (isFinite(parseFloat(v))) u[k] = parseFloat(v);
    }
    return u;
  }
  function hashFromUI(u) {
    const h = new URLSearchParams();
    for (const k of KEYS) {
      if (u[k] === UI_DEFAULT[k]) continue;
      h.set(k, typeof u[k] === 'boolean' ? (u[k] ? '1' : '0') : String(u[k]));
    }
    const s = h.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }
  function paramSummary(u) {
    const diff = KEYS.filter(k => k !== 'start' && k !== 'end' && u[k] !== UI_DEFAULT[k]);
    return '· ' + (diff.length ? '규칙 변경 ' + diff.length + '개' : '문서 규칙 그대로');
  }

  $('paramBox').addEventListener('toggle', e => {
    e.target.querySelector('.chev').textContent = e.target.open ? '접기 ▴' : '펼치기 ▾';
  });
  $('paramForm').addEventListener('submit', e => { e.preventDefault(); run(); });
  $('paramForm').addEventListener('change', () => run());
  $('resetBtn').addEventListener('click', () => {
    const u = readUI(); writeUI(Object.assign({}, UI_DEFAULT, { start: u.start, end: u.end })); run();
  });

  // ───────── 기간 선택 ─────────
  const lastIso = () => DATA.iso[DATA.iso.length - 1];
  const yearsAgo = n => { const d = new Date(Date.parse(lastIso() + 'T00:00:00Z')); d.setUTCFullYear(d.getUTCFullYear() - n); return iso(d.getTime()); };
  const PRESETS = {
    all: () => ['1991-01-02', ''],
    2010: () => ['2010-02-11', ''],
    y10: () => [yearsAgo(10), ''],
    y5: () => [yearsAgo(5), ''],
    y3: () => [yearsAgo(3), ''],
    ytd: () => [lastIso().slice(0, 4) + '-01-01', ''],
  };
  function setPeriod(start, end) { const u = readUI(); u.start = start; u.end = end; writeUI(u); run(); }
  $('presets').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'yearToggle') { toggleYears(); return; }
    toggleYears(false);
    setPeriod(...PRESETS[b.dataset.preset]());
  });
  function toggleYears(open) {
    const box = $('yearChips'), show = open == null ? box.hidden : open;
    box.hidden = !show; $('yearToggle').setAttribute('aria-expanded', String(show));
  }
  $('yearChips').addEventListener('click', e => {
    const b = e.target.closest('button[data-year]'); if (!b) return;
    const y = b.dataset.year; toggleYears(false); setPeriod(`${y}-01-01`, `${y}-12-31`);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleYears(false); });
  document.addEventListener('click', e => {
    if (!$('yearChips').hidden && !e.target.closest('#yearChips, #yearToggle')) toggleYears(false);
  });
  $('tblYears').addEventListener('click', e => {
    const only = e.target.closest('[data-only-year]');
    if (only) {
      const y = only.dataset.onlyYear; OPEN_YEAR = null; setPeriod(`${y}-01-01`, `${y}-12-31`);
      document.querySelector('.period').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const tr = e.target.closest('tr[data-year]'); if (!tr) return;
    OPEN_YEAR = OPEN_YEAR === tr.dataset.year ? null : tr.dataset.year;
    renderYears();
  });
  ['p_start', 'p_end'].forEach(id => $(id).addEventListener('change', () => run()));
  function buildYearChips() {
    const y0 = Number(DATA.iso[Math.min(DATA.iso.length - 1, 260)].slice(0, 4)) + 1, y1 = Number(lastIso().slice(0, 4));
    let h = '';
    for (let d = Math.floor(y1 / 10) * 10; d >= Math.floor(y0 / 10) * 10; d -= 10) {
      let ys = '';
      for (let y = d; y <= d + 9; y++) if (y >= y0 && y <= y1) ys += `<button type="button" class="chip" data-year="${y}">${y}</button>`;
      h += `<div class="decade"><div class="decade-label">${d}년대</div><div class="decade-years">${ys}</div></div>`;
    }
    $('yearChips').innerHTML = h;
  }
  function markPeriod(u) {
    const end = u.end || '';
    document.querySelectorAll('#presets .chip[data-preset]').forEach(b => {
      const [s0, e0] = PRESETS[b.dataset.preset]();
      const startMatch = s0 === u.start || (b.dataset.preset === 'all' && u.start <= '1991-01-02' && u.start >= '1990-12-31');
      b.setAttribute('aria-pressed', String(startMatch && e0 === end));
    });
    const yr = u.start.slice(5) === '01-01' && (end === u.start.slice(0, 4) + '-12-31') ? u.start.slice(0, 4) : null;
    document.querySelectorAll('#yearChips .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.year === yr)));
    $('yearToggle').setAttribute('aria-pressed', String(!!yr));
    $('yearToggle').textContent = (yr ? yr + '년' : '연도 선택') + ' ▾';
    return yr;
  }

  // ───────── 백테스트 실행 / 렌더 ─────────
  let RES = null, SUM = null, SEL_YEAR = null, OPEN_YEAR = null, YEARS = [], MONTHS = [];
  function run() {
    const u = readUI();
    const first = iso(DATA.dates[Math.min(DATA.dates.length - 1, 260)]);
    if (!u.start || u.start < first) u.start = first;
    if (u.end && u.end < u.start) u.end = '';
    writeUI(u); hashFromUI(u);
    $('paramSummary').textContent = paramSummary(u);
    SEL_YEAR = markPeriod(u);
    const t = performance.now();
    try {
      RES = E.backtest(DATA, toParams(u), u.start, u.end || null);
      if (RES.rows.length < 5) throw new Error('기간이 너무 짧습니다 (5거래일 이상)');
      SUM = E.summary(RES);
    } catch (err) {
      $('kpis').innerHTML = `<div class="kpi"><div class="k">오류</div><div class="d">${esc(err.message)}</div></div>`;
      return;
    }
    $('runTime').textContent = `계산 ${Math.round(performance.now() - t)}ms · ${RES.rows.length.toLocaleString()}거래일`;
    renderKPIs(); drawCharts(); renderTables();
  }

  function renderKPIs() {
    const s = SUM;
    const cards = [
      (s.end - s.start) < 365 * 86400000
        ? ['기간 수익률', pct(s.multiple - 1, 1, true), `${iso(s.start)} ~ ${iso(s.end)} · 연환산 ${pct(s.cagr)}`, 'hero ' + cls(s.multiple - 1)]
        : ['CAGR', pct(s.cagr), `${iso(s.start)} ~ ${iso(s.end)}${s.multiple < 10 ? ' · 누적 ' + pct(s.multiple - 1, 0, true) : ''}`, 'hero ' + cls(s.cagr)],
      ['MDD', pct(s.mdd), iso(s.mddT), 'hero neg'],
      ['Calmar', s.calmar.toFixed(2), 'CAGR ÷ |MDD|', 'hero'],
      ['누적 배수', '×' + num(s.multiple, s.multiple > 100 ? 0 : 2), '시작 자산 대비', ''],
      ['최악 연도', pct(s.worstYear.strategy, 1, true), String(s.worstYear.year), cls(s.worstYear.strategy)],
      ['손실 연도', `${s.lossYears} / ${s.years}`, `중앙값 ${pct(s.medianYear, 1, true)}`, ''],
      ['최장 언더워터', s.longestUnderwater.toFixed(1) + '년', '전고점 회복까지', ''],
      ['평균 투입 비중', pct(s.exposure, 0), `필터 켜진 날 ${pct(s.filterDays, 0)}`, ''],
    ];
    $('kpis').innerHTML = cards.map(([k, v, d, c]) =>
      `<div class="kpi ${c.includes('hero') ? 'hero' : ''}"><div class="k">${k}</div><div class="v ${c.replace('hero', '').trim()}">${v}</div><div class="d">${d}</div></div>`).join('');
  }

  function renderTables() {
    const rows = RES.rows, y0 = new Date(rows[0].t).getUTCFullYear(), y1 = new Date(rows.at(-1).t).getUTCFullYear();
    const buckets = [[1991, 2000], [2001, 2010], [2011, 2020], [2021, 2030]]
      .map(([a, b]) => [Math.max(a, y0), Math.min(b, y1)]).filter(([a, b]) => a <= b);
    const per = E.periods(rows, buckets);
    const all = { label: '전체', strategy: SUM.cagr,
      qqq: E.cagr(rows[0].qqq, rows.at(-1).qqq, rows[0].t, rows.at(-1).t),
      tqqq: E.cagr(rows[0].tqqq, rows.at(-1).tqqq, rows[0].t, rows.at(-1).t) };
    $('tblPeriods').innerHTML = '<thead><tr><th>기간</th><th>이 전략</th><th>QQQ 보유</th><th>TQQQ 보유</th></tr></thead><tbody>' +
      per.concat([all]).map(p => `<tr><td class="txt">${p.label}</td><td class="${cls(p.strategy)}">${pct(p.strategy)}</td><td>${pct(p.qqq)}</td><td>${pct(p.tqqq)}</td></tr>`).join('') + '</tbody>';

    const s = SUM;
    $('tblCycles').innerHTML = '<tbody>' + [
      ['사이클 수', s.cycles.toLocaleString()],
      ['수익 사이클 비율', pct(s.winRate)],
      ['24일 시간 손절', `${s.timeStops}회`],
      ['최악 사이클 (계좌 대비)', pct(s.worstCycle)],
      ['현금 부족으로 추가 매수 줄어든 날', pct(s.shortDays)],
    ].map(([k, v]) => `<tr><td class="txt">${k}</td><td>${v}</td></tr>`).join('') + '</tbody>';

    const worst = E.worstCycles(RES, 3);
    const short = (a, b) => { const x = iso(a), y = iso(b); return x.slice(0, 4) === y.slice(0, 4) ? `${x} ~ ${y.slice(5)}` : `${x} ~ ${y}`; };
    $('tblWorst').innerHTML = '<thead><tr><th>기간</th><th>계좌 대비</th></tr></thead><tbody>' +
      (worst.length ? worst.map((c, k) => `<tr><td><span class="rank">${k + 1}</span>${short(c.start, c.end)}
        <div class="wmeta">${c.days}거래일 · 추가 매수 ${c.adds}회 · <span class="exit-tag ${c.exit === 'time_stop' ? 'ts' : ''}">${c.exit === 'time_stop' ? '24일 손절' : '익절·탈출'}</span>${c.mult < 1 ? ' <span class="exit-tag">필터 ×0.25</span>' : ''}</div></td>
        <td class="${cls(c.ret)}">${pct(c.ret, 1, true)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="txt empty">완료된 사이클이 없습니다.</td></tr>') + '</tbody>';

    YEARS = E.yearly(rows); MONTHS = E.monthly(rows);
    if (OPEN_YEAR && !YEARS.some(y => String(y.year) === OPEN_YEAR)) OPEN_YEAR = null;
    renderYears();
  }

  const MONTH_LABEL = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
  function monthPanel(year) {
    const ms = MONTHS.filter(m => m.year === year);
    const byM = new Map(ms.map(m => [m.month, m]));
    const cells = MONTH_LABEL.map((lab, k) => {
      const m = byM.get(k + 1);
      if (!m) return `<div class="mcell empty"><div class="mk">${lab}</div><div class="mv">–</div></div>`;
      return `<div class="mcell ${m.strategy > 0 ? 'pos' : m.strategy < 0 ? 'neg' : ''}" title="월중 최대 하락 ${pct(m.maxdd)}">
        <div class="mk">${lab}</div><div class="mv">${pct(m.strategy, 1, true)}</div>
        <div class="ms">TQQQ ${pct(m.tqqq, 0, true)}<br>QQQ ${pct(m.qqq, 1, true)}</div></div>`;
    }).join('');
    const best = ms.reduce((a, b) => (b.strategy > a.strategy ? b : a), ms[0]);
    const worst = ms.reduce((a, b) => (b.strategy < a.strategy ? b : a), ms[0]);
    const up = ms.filter(m => m.strategy > 0).length;
    return `<div class="mgrid">${cells}</div>
      <div class="msum"><span>최고 ${best.month}월 ${pct(best.strategy, 1, true)} · 최악 ${worst.month}월 ${pct(worst.strategy, 1, true)} · 플러스 ${up}/${ms.length}개월</span>
      <button type="button" class="btn small" data-only-year="${year}">${year}년만 따로 백테스트</button></div>`;
  }
  function renderYears() {
    $('tblYears').innerHTML = '<thead><tr><th>연도</th><th>이 전략</th><th>연중 최대 하락</th><th>TQQQ 보유</th><th>QQQ 보유</th></tr></thead><tbody>' +
      YEARS.slice().reverse().map(y => {
        const open = String(y.year) === OPEN_YEAR;
        const cl = [String(y.year) === SEL_YEAR ? 'sel' : '', open ? 'open' : ''].join(' ').trim();
        return `<tr data-year="${y.year}" title="눌러서 ${y.year}년 월별 수익률 보기" class="${cl}"><td class="txt">${y.year}</td><td class="${y.strategy >= 0 ? 'cell-pos' : 'cell-neg'}">${pct(y.strategy, 1, true)}</td><td>${pct(y.maxdd)}</td><td class="${cls(y.tqqq)}">${pct(y.tqqq, 1, true)}</td><td class="${cls(y.qqq)}">${pct(y.qqq, 1, true)}</td></tr>` +
          (open ? `<tr class="months"><td colspan="5">${monthPanel(y.year)}</td></tr>` : '');
      }).join('') + '</tbody>';
  }

  // ───────── 차트 ─────────
  let charts = [];
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function drawCharts() {
    if (!RES || $('tab-bt').hidden) return;
    charts.forEach(c => c.destroy()); charts = [];
    const rows = RES.rows, n = rows.length;
    const x = new Float64Array(n), eq = new Float64Array(n), q = new Float64Array(n), t3 = new Float64Array(n);
    const dd = new Float64Array(n), qdd = new Float64Array(n);
    let pk = 0, qpk = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      x[i] = r.t / 1000; eq[i] = r.equity / rows[0].equity; q[i] = r.qqq / rows[0].qqq; t3[i] = r.tqqq / rows[0].tqqq;
      pk = Math.max(pk, eq[i]); qpk = Math.max(qpk, q[i]); dd[i] = eq[i] / pk - 1; qdd[i] = q[i] / qpk - 1;
    }
    const C = { s: cssVar('--s-strategy'), q: cssVar('--s-qqq'), t: cssVar('--s-tqqq'), grid: cssVar('--border'), text: cssVar('--muted') };
    const W = $('chartEq').clientWidth || 800, narrow = W < 600;
    const axis = (fmt, size) => ({ stroke: C.text, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid, width: 1 }, values: fmt, size });
    const xAxis = { stroke: C.text, grid: { show: false }, ticks: { stroke: C.grid, width: 1 } };
    const sync = uPlot.sync('solid');
    const cursor = { sync: { key: sync.key }, drag: { x: true, y: false }, points: { size: 6 } };
    let lo = Infinity, hi = -Infinity;
    for (const arr of [eq, q, t3]) for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const logMode = hi / lo > 4;                       // 한 자릿수 배 이내면 일반 눈금
    $('eqScale').textContent = logMode ? '(시작 = 1, 로그 눈금)' : '(시작 = 1)';
    const fmtMult = logMode
      ? (u, v) => v.map(x => x == null ? '' : x >= 1000 ? '×' + (x / 1000).toFixed(0) + 'k' : x >= 1 ? '×' + +x.toFixed(1) : '×' + +x.toPrecision(1))
      : (u, v) => v.map(x => x == null ? '' : '×' + x.toFixed(2));
    const logSplits = (u, ai, mn, mx) => {
      const pick = ms => { const out = []; for (let e = Math.floor(Math.log10(mn)); e <= Math.ceil(Math.log10(mx)); e++) for (const m of ms) { const v = m * 10 ** e; if (v >= mn && v <= mx) out.push(v); } return out; };
      const dec = pick([1]); return dec.length >= 3 ? dec : pick([1, 2, 5]);
    };
    const eqChart = new uPlot({
      width: W, height: narrow ? 260 : 360, cursor,
      scales: { x: { time: true }, y: logMode ? { distr: 3, range: () => [lo / 1.06, hi * 1.06] } : { distr: 1 } },
      axes: [xAxis, Object.assign(axis(fmtMult, narrow ? 46 : 56), logMode ? { splits: logSplits } : {})],
      series: [{}, { label: '전략', stroke: C.s, width: 2 }, { label: 'QQQ', stroke: C.q, width: 1.25 }, { label: 'TQQQ', stroke: C.t, width: 1.25 }],
      legend: { show: false },
      hooks: { setCursor: [u => {
        const i = u.cursor.idx;
        $('readout1').innerHTML = i == null ? '&nbsp;' :
          `${iso(rows[i].t)} · 전략 ×${num(eq[i], 2)} (낙폭 ${pct(dd[i])}) · QQQ ×${num(q[i], 2)} · TQQQ ×${num(t3[i], 2)}`;
      }] },
    }, [x, eq, q, t3], $('chartEq'));
    const ddChart = new uPlot({
      width: W, height: narrow ? 140 : 180, cursor,
      scales: { x: { time: true }, y: { range: (u, mn) => [Math.min(mn, -0.05) * 1.05, 0] } },
      axes: [xAxis, axis((u, v) => v.map(x => (x * 100).toFixed(0) + '%'), narrow ? 46 : 56)],
      series: [{}, { label: '전략', stroke: C.s, fill: C.s + '26', width: 1.5 }, { label: 'QQQ', stroke: C.q, width: 1 }],
      legend: { show: false },
    }, [x, dd, qdd], $('chartDD'));
    sync.sub(eqChart); sync.sub(ddChart);
    charts = [eqChart, ddChart];
  }
  let rzT;
  new ResizeObserver(() => { clearTimeout(rzT); rzT = setTimeout(() => {
    const W = $('chartEq').clientWidth; charts.forEach(c => c.setSize({ width: W, height: c.height }));
  }, 120); }).observe($('chartEq'));

  // ───────── 주문 계산기 ─────────
  const P = Object.assign({}, E.DEFAULTS);       // 실전은 문서 규칙 그대로
  let LIVE = null;                                // 실제 가격 기준 신호
  // 저장: 계좌 / 메인 사이클 / RSI 사이클을 따로 둔다
  const SEC = {
    acct: { key: 'solid-acct-v2', fields: ['asof', 'cash'] },
    main: { key: 'solid-main-v2', fields: ['shares', 'invested', 'last_buy', 'adds', 'day', 'cyc_equity', 'cyc_mult'] },
    rsi: { key: 'solid-rsi-v2', fields: ['rsi_shares', 'rsi_buys', 'rsi_day', 'rsi_mult'] },
  };
  const MONEY = ['cash', 'invested', 'last_buy', 'cyc_equity'];
  const blank = {
    acct: cash => ({ asof: iso(DATA.dates.at(-1)), cash, log: [] }),
    main: () => ({ shares: 0, invested: 0, last_buy: 0, adds: 0, day: 0, cyc_equity: 0, cyc_mult: 1 }),
    rsi: () => ({ rsi_shares: 0, rsi_buys: 0, rsi_day: 0, rsi_mult: 1 }),
  };
  const SAVED = {};
  function loadSaved() {
    const old = store.get('solid-account-v1');          // 이전 버전(한 덩어리) 이관
    for (const k of Object.keys(SEC)) {
      let v = store.get(SEC[k].key);
      if (!v && old) { v = {}; for (const f of SEC[k].fields) v[f] = old[f]; if (k === 'acct') v.log = old.log || []; }
      SAVED[k] = v || (k === 'acct' ? blank.acct(10000) : blank[k]());
    }
  }
  function saveSec(k, val) {
    SAVED[k] = Object.assign({}, val);
    if (k === 'acct' && !SAVED.acct.log) SAVED.acct.log = [];
    store.set(SEC[k].key, SAVED[k]);
  }
  const fmtField = (f, v) => f === 'asof' ? v : (f === 'cyc_mult' || f === 'rsi_mult') ? String(v) : MONEY.includes(f) ? Math.round(v * 100) / 100 : v;
  function readSec(k) {
    const o = {};
    for (const f of SEC[k].fields) {
      if (f === 'asof') { o.asof = $('s_asof').value; continue; }
      const v = parseFloat($('s_' + f).value); o[f] = isFinite(v) ? v : 0;
    }
    if (k === 'acct') o.log = SAVED.acct.log || [];
    return o;
  }
  function writeSec(k, o) { for (const f of SEC[k].fields) $(f === 'asof' ? 's_asof' : 's_' + f).value = fmtField(f, o[f]); }
  function refreshDirty() {
    for (const k of Object.keys(SEC)) {
      const cur = readSec(k), sv = SAVED[k];
      const dirty = SEC[k].fields.some(f => String(fmtField(f, cur[f])) !== String(fmtField(f, sv[f])));
      $('dirty_' + k).hidden = !dirty;
    }
  }
  function readAccount() { return Object.assign({}, readSec('main'), readSec('rsi'), readSec('acct')); }
  function writeAll(a) { for (const k of Object.keys(SEC)) writeSec(k, a); }
  function saveAll(a) { for (const k of Object.keys(SEC)) { const o = {}; for (const f of SEC[k].fields) o[f] = a[f]; if (k === 'acct') o.log = a.log || []; saveSec(k, o); } }

  const toEngineState = a => Object.assign(E.newState(a.cash), {
    shares: a.shares, invested: a.invested, last_buy: a.last_buy, adds: a.adds,
    day: a.shares > 0 ? a.day : -1, cyc_mult: a.cyc_mult, cyc_equity: a.cyc_equity,
    rsi_shares: a.rsi_shares, rsi_buys: a.rsi_shares > 0 ? a.rsi_buys : 0,
    rsi_day: a.rsi_shares > 0 ? a.rsi_day : -1, rsi_mult: a.rsi_mult,
  });
  const fromEngineState = (st, asof, log) => ({
    asof, cash: st.cash, shares: st.shares, invested: st.invested, last_buy: st.last_buy, adds: st.adds,
    day: Math.max(0, st.day), cyc_equity: st.cyc_equity, cyc_mult: st.cyc_mult, rsi_shares: st.rsi_shares,
    rsi_buys: st.rsi_buys, rsi_day: Math.max(0, st.rsi_day), rsi_mult: st.rsi_mult, log,
  });

  const ORDER_NAME = {
    entry: '첫 매수', buy1: '매수1', buy2: '매수2', tp: '익절·탈출 매도 (전량)', time_stop: '24일 시간 손절 (전량)',
    rsi_buy: 'RSI 매수', rsi_tp: 'RSI 매도 (전량)', rsi_time: 'RSI 10일 청산 (전량)',
  };
  function orderDesc(o, st, eq) {
    const f = o.meta && o.meta.mult < 1 ? ' × 0.25(필터)' : '';
    switch (o.tag) {
      case 'entry': return `총자산 ${usd(eq)} × 20%${f}, 가격 = 종가 × 1.10`;
      case 'buy1': return `산 금액 ${usd(st.invested)} × 25%, 가격 = 종가 × 0.995`;
      case 'buy2': return `산 금액 ${usd(st.invested)} × 25%, 가격 = 종가 × 0.89`;
      case 'tp': return `마지막 매수가 ${usd(st.last_buy)} × 1.045 (올림)`;
      case 'time_stop': return '첫 매수일 0일 기준 24거래일째';
      case 'rsi_buy': return `RSI 자금 (사이클 시작 총자산 × 30% ÷ 2)${f}`;
      case 'rsi_tp': return 'QQQ RSI(2)가 25가 되는 가격 환산';
      case 'rsi_time': return '첫 RSI 매수일 0일 기준 10거래일째';
      default: return '';
    }
  }

  function renderCalc() {
    const L = DATA.dates.length - 1, lastIso = iso(DATA.dates[L]);
    const a = readAccount();
    const st = toEngineState(a);
    const tq = DATA.tqqq[L], mom = LIVE.mom[L], bpx = LIVE.bpx[L], spx = LIVE.spx[L];
    const eq = st.cash + (st.shares + st.rsi_shares) * tq;
    $('calcBasis').textContent = `${lastIso} 종가 기준 → 다음 거래일 장 마감 전에 넣을 주문`;
    // 상태 카드 (필터 · 분할 진행)
    const inCycle = st.shares > 0, inRsi = st.rsi_shares > 0;
    const filtToday = P.use_mom && mom != null && mom < 0;
    const nextDay = inCycle ? st.day + 1 : 0, nextRsi = inRsi ? st.rsi_day + 1 : 0;
    const bar = (v, max, warnAt) => `<div class="bar ${v >= max ? 'full' : v >= warnAt ? 'warn' : ''}"><i style="width:${Math.min(100, v / max * 100)}%"></i></div>`;
    const multTxt = m => m < 1 ? '×0.25 (필터)' : '×1';
    const cards = [
      [`st ${filtToday ? 'on' : 'off'}`, '모멘텀 필터', filtToday ? '켜짐' : '꺼짐',
        `QQQ 12개월 ${pct(mom, 1, true)}${inCycle ? ` · 현재 사이클 ${multTxt(st.cyc_mult)}` : ' · 새 사이클에 적용'}`],
      ['st', '메인 사이클 진행일', inCycle ? `${nextDay}<small> / ${P.time_stop}일</small>` : '대기',
        (inCycle ? `다음 거래일 = ${nextDay}일째${nextDay >= P.time_stop ? ' (시간 손절)' : ''}` : '보유 없음 · 첫 매수 주문') + (inCycle ? bar(nextDay, P.time_stop, P.time_stop - 4) : '')],
      ['st', '추가 매수 (분할)', `${st.adds}<small> / ${P.max_adds}회</small>`,
        (inCycle ? (st.adds >= P.max_adds ? '한도 도달 · 매수 중단' : `산 금액 ${usd(st.invested)}`) : '사이클 시작 전') + bar(st.adds, P.max_adds, P.max_adds - 1)],
      ['st', 'RSI 매수', `${st.rsi_buys}<small> / ${P.rsi_splits}회</small>`,
        (inRsi ? `보유 ${st.rsi_shares}주 · ${multTxt(st.rsi_mult)}` : '보유 없음') + bar(st.rsi_buys, P.rsi_splits, P.rsi_splits)],
      ['st', 'RSI 보유일', inRsi ? `${nextRsi}<small> / ${P.rsi_hold}일</small>` : '–',
        (inRsi ? `다음 거래일 = ${nextRsi}일째${nextRsi >= P.rsi_hold ? ' (청산)' : ''}` : '첫 RSI 매수일이 0일') + (inRsi ? bar(nextRsi, P.rsi_hold, P.rsi_hold - 2) : '')],
    ];
    $('status').innerHTML = cards.map(([c, k, v, d]) => `<div class="${c}"><div class="k">${k}</div><div class="v ${/^[가-힣]/.test(v) ? 'word' : ''}">${v}</div><div class="d">${d}</div></div>`).join('');

    $('market').innerHTML = [
      ['TQQQ 종가', usd(tq)], ['QQQ 종가', usd(DATA.qqq[L])],
      ['RSI 매수가', bpx == null ? '없음' : usd(bpx)], ['RSI 매도가', spx == null ? '없음' : usd(spx)],
      ['예수금', usd(st.cash)], ['내 총자산', usd(eq)],
    ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

    // 주문 표: 메인 / RSI
    const orders = E.planOrders(st, tq, mom, bpx, spx, P);
    const head = '<colgroup><col class="c-name"><col class="c-kind"><col class="c-px"><col class="c-qty"><col class="c-amt"><col class="c-why"></colgroup>' +
      '<thead><tr><th>주문</th><th>종류</th><th>가격</th><th>수량</th><th>금액</th><th style="text-align:left">근거</th></tr></thead>';
    const row = o => {
      const none = o.qty <= 0;
      const amt = none ? '현금 부족, 주문 없음' : (o.price ? '≤ ' + usd(o.qty * o.price) : '≈ ' + usd(o.qty * tq));
      return `<tr><td class="txt"><span class="badge ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side === 'BUY' ? '매수' : '매도'}</span> ${ORDER_NAME[o.tag]}
        <div class="why-m hint">${amt} · ${orderDesc(o, st, eq)}</div></td>
        <td class="txt">${o.kind}</td><td>${o.price == null ? '시장가' : usd(o.price)}</td>
        <td>${none ? '–' : o.qty.toLocaleString()}</td><td>${amt}</td>
        <td class="txt why hint">${orderDesc(o, st, eq)}</td></tr>`;
    };
    const table = (list, emptyMsg) => head + '<tbody>' + (list.length ? list.map(row).join('') : `<tr><td colspan="6" class="empty-row">${emptyMsg}</td></tr>`) + '</tbody>';
    const mainO = orders.filter(o => !o.tag.startsWith('rsi')), rsiO = orders.filter(o => o.tag.startsWith('rsi'));
    $('tblMain').innerHTML = table(mainO, '낼 주문이 없습니다.');
    $('mainSub').textContent = !inCycle ? '· 새 사이클 시작'
      : nextDay >= P.time_stop ? '· 시간 손절일, 전량 MOC 매도만'
      : st.adds >= P.max_adds ? '· 추가 매수 한도 도달, 매도 주문만' : '· 매도 1건 + 매수1·매수2';
    let rsiEmpty = '낼 주문이 없습니다.';
    if (!P.use_rsi) rsiEmpty = 'RSI 엔진을 쓰지 않습니다.';
    else if (bpx == null) rsiEmpty = '오늘은 RSI 매수가가 계산되지 않습니다.';
    $('tblRsi').innerHTML = table(rsiO, rsiEmpty);
    $('rsiSub').textContent = inRsi
      ? (nextRsi >= P.rsi_hold ? '· 10일째, 전량 MOC 청산' : st.rsi_buys >= P.rsi_splits ? '· 2회 매수 완료, 매도 대기' : '· 매도 + 2차 매수')
      : '· QQQ RSI(2)가 22가 되는 가격 이하에서 매수';

    const notes = [];
    if (a.asof < lastIso) notes.push(`<p class="note">아직 반영하지 않은 거래일이 있습니다. 위 「체결 입력」을 먼저 끝내면 이 주문이 정확해집니다.</p>`);
    if (a.asof > lastIso) notes.push(`<p class="note">상태 기준일(${a.asof})이 최신 시세(${lastIso})보다 뒤입니다. 시세가 아직 갱신되지 않았을 수 있습니다.</p>`);
    $('calcNotes').innerHTML = notes.join('');
    renderFill(a); refreshDirty(); renderJournal();
  }

  // ───────── 체결 기록(저널) ─────────
  // 시작 상태(base) + 사건 목록(events)을 순서대로 다시 적용해 현재 상태를 만든다.
  //   fill: { type:'fill', date, items:[{tag, qty, price}], auto? }   하루 한 건
  //   set : { type:'set', sec:'acct'|'main'|'rsi', values:{...}, date }   칸을 직접 고쳐 저장
  const JKEY = 'solid-journal-v1';
  let J = null;
  const clone = o => JSON.parse(JSON.stringify(o));
  const flatBlank = cash => { const a = Object.assign(blank.acct(cash), blank.main(), blank.rsi()); delete a.log; return a; };
  function loadJournal() {
    J = store.get(JKEY);
    if (!J || !J.base || !Array.isArray(J.events)) {
      const base = Object.assign({}, SAVED.main, SAVED.rsi, SAVED.acct);
      const legacy = base.log || []; delete base.log;
      J = { base, events: [], legacy };
    }
  }
  const saveJournal = () => store.set(JKEY, J);
  const ordersFor = (st, i) => E.planOrders(st, DATA.tqqq[i - 1], LIVE.mom[i - 1], LIVE.bpx[i - 1], LIVE.spx[i - 1], P);
  function synthOrder(tag, st, i) {          // 계획 주문에 없던 체결(수동 입력)용
    const buy = ['entry', 'buy1', 'buy2', 'rsi_buy'].includes(tag);
    const m = LIVE.mom[i - 1], today = P.use_mom && m != null && m < 0 ? P.mom_mult : 1;
    const meta = tag === 'entry' ? { mult: today, equity: st.cash + (st.shares + st.rsi_shares) * DATA.tqqq[i - 1] }
      : tag === 'rsi_buy' ? { mult: st.rsi_shares > 0 ? st.rsi_mult : st.shares > 0 ? st.cyc_mult : today } : {};
    return { tag, side: buy ? 'BUY' : 'SELL', kind: 'LOC', qty: 0, price: null, meta };
  }
  function applyEvent(st, ev, i) {
    const orders = ordersFor(st, i);
    const items = ev.items.map(it => ({
      order: orders.find(o => o.tag === it.tag) || synthOrder(it.tag, st, i), price: it.price,
      qty: it.full ? (it.tag.startsWith('rsi') ? st.rsi_shares : st.shares) : it.qty,
    }));
    return E.applyManualFills(st, items, P);
  }
  /* 처음 k개 사건까지 적용한 상태. minCash: 도중 예수금 최저값 */
  function replayTo(k, events = J.events) {
    let st = toEngineState(J.base), asof = J.base.asof, minCash = st.cash;
    for (let e = 0; e < k; e++) {
      const ev = events[e];
      if (ev.type === 'set') {
        const cur = fromEngineState(st, asof); Object.assign(cur, ev.values);
        asof = cur.asof; st = toEngineState(cur);
      } else {
        const i = DATA.iso.indexOf(ev.date);
        if (i >= 1) applyEvent(st, ev, i);
        asof = ev.date;
      }
      minCash = Math.min(minCash, st.cash);
    }
    const a = fromEngineState(st, asof); a.minCash = minCash; return a;
  }
  function commit(events) {                    // 사건 목록을 바꾸고 현재 상태를 다시 계산
    const a = replayTo(events.length, events);
    if (a.minCash < -0.005) { alert('이 기록대로라면 중간에 예수금이 음수가 됩니다. 수량·가격이나 예수금을 확인해 주세요.'); return false; }
    J.events = events; saveJournal();
    delete a.minCash; writeAll(a); saveAll(a); EDIT = null; renderCalc();
    return true;
  }
  const itemsText = items => items.length
    ? items.map(it => `${ORDER_NAME[it.tag].replace(' (전량)', '')} ${it.full ? '전량' : it.qty + '주'} @${num(it.price)}`).join(', ')
    : '<span class="none">체결 없음</span>';
  const SEC_NAME = { acct: '계좌', main: '메인 사이클', rsi: 'RSI 사이클' };
  function renderJournal() {
    const ev = J.events, n = ev.length;
    const rows = [];
    for (let k = n - 1; k >= Math.max(0, n - 150); k--) {
      const e = ev[k], last = k === n - 1;
      const text = e.type === 'set'
        ? `<span class="tag set">직접 수정</span>${SEC_NAME[e.sec]} 값을 저장`
        : `${e.auto ? '<span class="tag">자동</span>' : ''}${itemsText(e.items)}`;
      const btns = (e.type === 'fill' ? `<button type="button" class="btn small" data-jedit="${k}">수정</button>` : '') +
        (last ? `<button type="button" class="btn small" data-jundo="${k}" title="이 기록을 지우고 그 전 상태로">되돌리기</button>` : '');
      rows.push(`<div class="jrow ${EDIT && EDIT.k === k ? 'editing' : ''}"><div class="jd">${e.date || ''}</div><div class="jt">${text}</div><div class="jb">${btns}</div></div>`);
    }
    $('journal').innerHTML = rows.length ? rows.join('') : '<div class="jrow"><div class="jt none" style="grid-column:1/-1">아직 기록이 없습니다. 체결을 반영하거나 칸을 저장하면 여기에 남습니다.</div></div>';
    const lg = J.legacy || [];
    $('legacyBox').hidden = !lg.length;
    if (lg.length) $('legacyLog').textContent = lg.slice(-200).join('\n');
  }
  $('journal').addEventListener('click', e => {
    const ed = e.target.closest('[data-jedit]'), un = e.target.closest('[data-jundo]');
    if (ed) { EDIT = { k: +ed.dataset.jedit }; FILL_KEY = null; renderCalc(); $('fillBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (un) {
      const k = +un.dataset.jundo, ev = J.events[k];
      const what = ev.type === 'set' ? `${SEC_NAME[ev.sec]} 직접 수정` : `${ev.date} 체결`;
      if (!confirm(`${what} 기록을 지우고 그 전 상태로 되돌릴까요?`)) return;
      commit(J.events.slice(0, k));
    }
  });

  // 칸별 저장 / 초기화 → 'set' 사건으로 기록
  function pushSet(k, values) {
    const v = Object.assign({}, values); delete v.log;
    const evs = J.events.slice(), last = evs[evs.length - 1];
    const ev = { type: 'set', sec: k, values: v, date: readSec('acct').asof };
    if (last && last.type === 'set' && last.sec === k) evs[evs.length - 1] = ev; else evs.push(ev);
    commit(evs);
  }
  for (const k of Object.keys(SEC)) {
    $('form_' + k).addEventListener('submit', e => { e.preventDefault(); pushSet(k, readSec(k)); });
    $('form_' + k).addEventListener('input', () => renderCalc());
  }
  document.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', () => {
    const k = btn.dataset.reset; writeSec(k, blank[k]()); pushSet(k, blank[k]());
  }));
  $('newBtn').addEventListener('click', () => {
    const cash = parseFloat($('n_cash').value);
    if (!(cash > 0)) return;
    if (!confirm('계좌·메인·RSI 상태와 체결 기록을 모두 지우고 새로 시작할까요?')) return;
    J = { base: flatBlank(cash), events: [], legacy: [] };
    commit([]);
  });

  // ───────── 체결 입력 / 수정 ─────────
  let FILL = null, EDIT = null, FILL_KEY = null;   // FILL: { i, orders, k? }
  const FULL_SELL = ['tp', 'time_stop', 'rsi_tp', 'rsi_time'];
  const pendingIndex = asof => { const i = DATA.iso.findIndex(d => d > asof); return i < 1 ? -1 : i; };
  function renderFill(a) {
    let i, st, recorded = null, k = null;
    if (EDIT) {
      k = EDIT.k; const ev = J.events[k];
      if (!ev || ev.type !== 'fill') { EDIT = null; return renderFill(a); }
      i = DATA.iso.indexOf(ev.date); st = toEngineState(replayTo(k)); recorded = ev.items;
    } else {
      i = pendingIndex(a.asof); st = toEngineState(a);
    }
    const key = JSON.stringify([k, i, EDIT ? J.events[k] : a]);
    if (key === FILL_KEY) return;              // 입력 중인 값 지우지 않기
    FILL_KEY = key;
    const box = $('fillBox');
    if (i < 1) { box.hidden = true; FILL = null; return; }
    const L = DATA.iso.length - 1, c = DATA.tqqq[i];
    let orders = ordersFor(st, i).filter(o => o.qty > 0);
    if (recorded) for (const it of recorded) if (!orders.some(o => o.tag === it.tag)) orders.push(Object.assign(synthOrder(it.tag, st, i), { qty: it.qty }));
    FILL = { i, orders, k };
    box.hidden = false; box.classList.toggle('editing', !!EDIT);
    $('fillTitle').textContent = EDIT ? `· ${DATA.iso[i]} 기록 수정 (TQQQ 종가 ${usd(c)})` : `· ${DATA.iso[i]} 주문 (TQQQ 종가 ${usd(c)})`;
    const left = L - i;
    $('fillPending').textContent = EDIT ? '고치면 이후 날짜가 다시 계산됩니다' : left > 0 ? `이 날 뒤로 ${left}거래일 더 남음` : '마지막 미반영 거래일';
    $('rollBtn').hidden = !!EDIT || left === 0;
    $('fillCancel').hidden = !EDIT;
    $('fillApply').textContent = EDIT ? '수정 저장' : '체결 반영';
    $('fillHelp').textContent = EDIT
      ? '기록한 체결을 고칩니다. 체크·수량·체결가를 바꾸고 「수정 저장」을 누르면 이 날 이후 상태가 다시 계산됩니다. 전량 매도는 다시 계산할 때도 그 시점 보유 전부를 팝니다.'
      : '그날 낸 주문입니다. 종가로 계산한 체결 여부를 미리 체크해 두었으니, 실제와 다른 것만 고치고 「체결 반영」을 누르세요. 예수금은 수수료 0.07%를 가정해 계산합니다.';
    const hit = o => o.price != null && (o.kind === 'MOC' || (o.side === 'BUY' ? c <= o.price : c >= o.price)) || o.kind === 'MOC';
    const row = (o, j) => {
      const rec = recorded ? recorded.find(it => it.tag === o.tag) : null;
      const on = recorded ? !!rec : hit(o);
      const q = rec ? (rec.full ? o.qty : rec.qty) : o.qty, px = rec ? rec.price : c;
      const rule = o.price == null && o.kind !== 'MOC' ? '계획에 없던 주문' : `${o.kind} ${o.price == null ? '시장가' : usd(o.price)} · 규칙상 ${hit(o) ? '체결' : '미체결'}`;
      return `<tr data-j="${j}" class="${on ? '' : 'off'}">
        <td><input type="checkbox" ${on ? 'checked' : ''} aria-label="${ORDER_NAME[o.tag]} 체결"></td>
        <td class="txt"><span class="badge ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side === 'BUY' ? '매수' : '매도'}</span> ${ORDER_NAME[o.tag]}
          <div class="rule hint">${rule}</div></td>
        <td><input type="number" class="q" step="1" min="0" value="${q}" aria-label="체결 수량"></td>
        <td><input type="number" class="px" step="0.01" min="0" value="${(+px).toFixed(2)}" aria-label="체결가"></td></tr>`;
    };
    const mainO = orders.map((o, j) => [o, j]).filter(([o]) => !o.tag.startsWith('rsi'));
    const rsiO = orders.map((o, j) => [o, j]).filter(([o]) => o.tag.startsWith('rsi'));
    const grp = (title, list) => `<tr class="grp"><td colspan="4">${title}</td></tr>` +
      (list.length ? list.map(([o, j]) => row(o, j)).join('') : '<tr><td colspan="4" class="empty-row" style="text-align:left;font-family:inherit;color:var(--faint)">낸 주문 없음</td></tr>');
    $('tblFill').innerHTML = '<thead><tr><th style="width:44px">체결</th><th>주문</th><th>수량</th><th>체결가</th></tr></thead><tbody>' +
      grp('메인 엔진', mainO) + grp('RSI 엔진', rsiO) + '</tbody>';
  }
  $('tblFill').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-j]');
    if (tr && e.target.type === 'checkbox') tr.classList.toggle('off', !e.target.checked);
  });
  function readFillItems() {
    const items = [];
    document.querySelectorAll('#tblFill tr[data-j]').forEach(tr => {
      if (!tr.querySelector('input[type=checkbox]').checked) return;
      const o = FILL.orders[+tr.dataset.j];
      const qty = Math.floor(+tr.querySelector('.q').value || 0), price = +tr.querySelector('.px').value || 0;
      const full = o.side === 'SELL' && FULL_SELL.includes(o.tag) && o.qty > 0 && qty >= o.qty;   // 전량 매도
      if (qty > 0) items.push(full ? { tag: o.tag, qty, price, full } : { tag: o.tag, qty, price });
    });
    return items;
  }
  $('fillApply').addEventListener('click', () => {
    if (!FILL) return;
    const items = readFillItems();
    const bad = items.find(it => !(it.price > 0));
    if (bad) { alert(`${ORDER_NAME[bad.tag]}의 체결가를 입력해 주세요.`); return; }
    const evs = J.events.slice();
    if (FILL.k != null) evs[FILL.k] = Object.assign({}, evs[FILL.k], { items, auto: false });
    else {
      const a = readAccount();
      // 칸에 저장 안 한 값이 있으면 먼저 기록 (체결은 지금 화면 상태 기준)
      for (const sec of Object.keys(SEC)) if (!$('dirty_' + sec).hidden) { const v = readSec(sec); delete v.log; evs.push({ type: 'set', sec, values: v, date: a.asof }); }
      evs.push({ type: 'fill', date: DATA.iso[FILL.i], items });
    }
    FILL_KEY = null; commit(evs);
  });
  $('fillCancel').addEventListener('click', () => { EDIT = null; FILL_KEY = null; renderCalc(); });
  $('rollBtn').addEventListener('click', () => {
    const a = readAccount();
    const L = DATA.dates.length - 1;
    let i = pendingIndex(a.asof);
    if (i < 0) return;
    if (!confirm(`${DATA.iso[i]}부터 ${DATA.iso[L]}까지 ${L - i + 1}거래일을 규칙대로 체결됐다고 보고 진행할까요?`)) return;
    const st = toEngineState(a), evs = J.events.slice();
    for (; i <= L; i++) {
      const orders = ordersFor(st, i), c = DATA.tqqq[i];
      let hits = orders.filter(o => o.qty > 0 && (o.kind === 'MOC' || (o.side === 'BUY' ? c <= o.price : c >= o.price)));
      if (hits.some(o => o.tag === 'tp' || o.tag === 'time_stop')) hits = hits.filter(o => o.tag !== 'buy1' && o.tag !== 'buy2');
      const items = hits.map(o => FULL_SELL.includes(o.tag) ? { tag: o.tag, qty: o.qty, price: c, full: true } : { tag: o.tag, qty: o.qty, price: c });
      E.applyManualFills(st, items.map(it => ({ order: orders.find(o => o.tag === it.tag), qty: it.qty, price: it.price })), P);
      evs.push({ type: 'fill', date: DATA.iso[i], items, auto: true });
    }
    FILL_KEY = null; commit(evs);
  });

  // ───────── 시작 ─────────
  async function init() {
    let text;
    try {
      const res = await fetch('data/prices.csv', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      text = await res.text();
    } catch (err) {
      $('loading').textContent = '시세 파일(data/prices.csv)을 불러오지 못했습니다. 로컬에서는 웹 서버로 열어 주세요.';
      return;
    }
    const lines = text.trim().split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const [d, t, q] = lines[i].split(',');
      if (!d) continue;
      DATA.iso.push(d); DATA.dates.push(Date.parse(d + 'T00:00:00Z')); DATA.tqqq.push(+t); DATA.qqq.push(+q);
    }
    const L = DATA.dates.length - 1;
    $('dataInfo').innerHTML = `시세 <b>${DATA.iso[0]} ~ ${DATA.iso[L]}</b> · ${DATA.dates.length.toLocaleString()}거래일 · TQQQ ${usd(DATA.tqqq[L])} · QQQ ${usd(DATA.qqq[L])}`;
    LIVE = E.signals(DATA.tqqq, DATA.qqq, P);
    $('loading').hidden = true;

    buildYearChips();
    writeUI(uiFromHash());
    loadSaved(); loadJournal(); saveJournal();
    const cur = replayTo(J.events.length); delete cur.minCash;
    writeAll(cur); saveAll(cur);
    showTab(store.get('solid-tab') === 'calc' ? 'calc' : 'bt');
    run(); renderCalc();
  }
  init();
})();
