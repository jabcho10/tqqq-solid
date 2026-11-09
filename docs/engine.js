/* TQQQ 솔리드 매매 규칙 엔진 — solid.py 와 같은 로직 (브라우저 / node 공용) */
(function (root) {
  'use strict';

  const DEFAULTS = {
    init_ratio: 0.20, entry_mult: 1.10, add_ratio: 0.25, b1: 0.995, b2: 0.89,
    max_adds: 7, take_profit: 1.045, time_stop: 24,
    use_rsi: true, rsi_n: 2, rsi_buy: 22, rsi_sell: 25, rsi_ratio: 0.30, rsi_splits: 2,
    rsi_hold: 10, lev: 3.0, rsi_down_floor: -0.333,
    use_mom: true, mom_lookback: 252, mom_mult: 0.25, mom_on_adds: false,
    fee: 0.0007,
  };

  const rd = (x, n = 2) => { const f = 10 ** n; return Math.floor(x * f + 1e-9) / f; };
  const ru = (x, n = 2) => { const f = 10 ** n; return Math.ceil(x * f - 1e-9) / f; };

  function newState(cash) {
    return {
      cash, shares: 0, avg: 0, invested: 0, last_buy: 0, adds: 0, day: -1,
      cyc_mult: 1, cyc_equity: 0,
      rsi_shares: 0, rsi_avg: 0, rsi_buys: 0, rsi_day: -1, rsi_mult: 1,
    };
  }

  function rsiAvgs(px, n) {
    const len = px.length, ag = new Array(len).fill(NaN), al = new Array(len).fill(NaN);
    if (len <= n) return { ag, al };
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = px[i] - px[i - 1]; if (d > 0) g += d; else l -= d; }
    ag[n] = g / n; al[n] = l / n;
    for (let i = n + 1; i < len; i++) {
      const d = px[i] - px[i - 1];
      ag[i] = (ag[i - 1] * (n - 1) + Math.max(d, 0)) / n;
      al[i] = (al[i - 1] * (n - 1) + Math.max(-d, 0)) / n;
    }
    return { ag, al };
  }

  /* 내일 QQQ RSI가 r이 되는 가격 → TQQQ 주문가 */
  function rsiOrderPrice(tqC, qC, ag, al, r, n, lev, downFloor, floorP) {
    if (Number.isNaN(ag) || Number.isNaN(al)) return null;
    const k = n - 1;
    let up = qC - ag * k + al * k * r / (100 - r);
    let dn = qC + al * k - ag * k * (100 - r) / r;
    if (floorP) { up = Math.max(up, 0.01); dn = Math.max(dn, 0.01); }
    let p;
    if (up > qC) p = up; else if (dn < qC) p = dn; else return null;
    let ch = p / qC - 1;
    if (ch < 0) ch = Math.max(ch, downFloor);
    const px = rd(tqC * (1 + lev * ch), 2);
    return px > 0 ? px : null;
  }

  /* 장 마감 전: 오늘 낼 주문 (문서 6장 체크리스트) */
  function planOrders(st, tqPrev, mom, rsiBuyPx, rsiSellPx, p) {
    const orders = [];
    const equity = st.cash + (st.shares + st.rsi_shares) * tqPrev;
    const filtOn = p.use_mom && mom != null && mom < 0;
    const todayMult = filtOn ? p.mom_mult : 1;
    let avail = st.cash / (1 + p.fee);

    const buy = (tag, amt, price, meta = {}) => {
      const a = Math.max(0, Math.min(amt, avail));
      meta = Object.assign({}, meta, { short: avail < amt });
      const qty = price > 0 ? Math.floor(rd(a / price, 0)) : 0;
      if (qty > 0) { orders.push({ tag, side: 'BUY', kind: 'LOC', qty, price, target: amt, meta }); avail -= qty * price; }
      else if (amt > 0) orders.push({ tag, side: 'BUY', kind: 'LOC', qty: 0, price, target: amt, meta });
    };

    if (st.shares === 0) {
      buy('entry', equity * p.init_ratio * todayMult, rd(tqPrev * p.entry_mult), { mult: todayMult, equity });
    } else if (st.day + 1 >= p.time_stop) {
      orders.push({ tag: 'time_stop', side: 'SELL', kind: 'MOC', qty: st.shares, price: null, meta: {} });
    } else {
      orders.push({ tag: 'tp', side: 'SELL', kind: 'LOC', qty: st.shares, price: ru(st.last_buy * p.take_profit), meta: {} });
      if (st.adds < p.max_adds) {
        const amt = st.invested * p.add_ratio * (p.mom_on_adds ? st.cyc_mult : 1);
        buy('buy1', amt, rd(tqPrev * p.b1));
        buy('buy2', amt, rd(tqPrev * p.b2));
      }
    }

    if (p.use_rsi) {
      const rsiMoc = st.rsi_shares > 0 && st.rsi_day + 1 >= p.rsi_hold;
      if (rsiMoc) orders.push({ tag: 'rsi_time', side: 'SELL', kind: 'MOC', qty: st.rsi_shares, price: null, meta: {} });
      else if (st.rsi_shares > 0 && rsiSellPx != null)
        orders.push({ tag: 'rsi_tp', side: 'SELL', kind: 'LOC', qty: st.rsi_shares, price: rsiSellPx, meta: {} });
      if (!rsiMoc && st.rsi_buys < p.rsi_splits && rsiBuyPx != null && avail > 0) {
        const rmult = st.rsi_shares > 0 ? st.rsi_mult : (st.shares > 0 ? st.cyc_mult : todayMult);
        const basis = st.shares > 0 ? st.cyc_equity : equity;
        buy('rsi_buy', basis * p.rsi_ratio / p.rsi_splits * rmult, rsiBuyPx, { mult: rmult });
      }
    }
    return orders;
  }

  /* 장 마감: 종가 c 로 체결 */
  function applyFills(st, orders, c, p) {
    if (st.shares > 0) st.day += 1;
    if (st.rsi_shares > 0) st.rsi_day += 1;
    const fills = [];
    const hit = o => o.qty > 0 && (o.kind === 'MOC' || (o.side === 'BUY' ? c <= o.price : c >= o.price));
    let mainSold = false;
    for (const o of orders) {
      if (o.side !== 'SELL' || !hit(o)) continue;
      st.cash += o.qty * c * (1 - p.fee);
      if (o.tag === 'tp' || o.tag === 'time_stop') {
        Object.assign(st, { shares: 0, avg: 0, invested: 0, last_buy: 0, adds: 0, day: -1 });
        mainSold = true;
      } else {
        Object.assign(st, { rsi_shares: 0, rsi_avg: 0, rsi_buys: 0, rsi_day: -1 });
      }
      fills.push(o);
    }
    for (const o of orders) {
      if (o.side !== 'BUY' || !hit(o)) continue;
      if (mainSold && (o.tag === 'buy1' || o.tag === 'buy2')) continue;
      const cost = o.qty * c;
      st.cash -= cost * (1 + p.fee);
      if (o.tag === 'rsi_buy') {
        if (st.rsi_shares === 0) { st.rsi_day = 0; st.rsi_mult = o.meta.mult; }
        st.rsi_avg = (st.rsi_avg * st.rsi_shares + cost) / (st.rsi_shares + o.qty);
        st.rsi_shares += o.qty; st.rsi_buys += 1;
      } else {
        if (o.tag === 'entry') { st.day = 0; st.adds = 0; st.cyc_mult = o.meta.mult; st.cyc_equity = o.meta.equity; }
        else st.adds += 1;
        st.avg = (st.avg * st.shares + cost) / (st.shares + o.qty);
        st.shares += o.qty; st.invested += cost; st.last_buy = c;
      }
      fills.push(o);
    }
    if (st.cash < -1e-6) throw new Error('현금이 음수가 됨 (미수 발생)');
    return fills;
  }

  /* 실제 체결 입력: items = [{order, qty, price}] (체결된 것만). 수량·가격은 사용자가 입력한 값 */
  function applyManualFills(st, items, p) {
    if (st.shares > 0) st.day += 1;
    if (st.rsi_shares > 0) st.rsi_day += 1;
    const done = [];
    for (const it of items) {
      const o = it.order;
      if (o.side !== 'SELL' || !(it.qty > 0)) continue;
      const isRsi = o.tag.startsWith('rsi');
      const q = Math.min(it.qty, isRsi ? st.rsi_shares : st.shares);
      if (q <= 0) continue;
      st.cash += q * it.price * (1 - p.fee);
      if (isRsi) {
        if (q >= st.rsi_shares) Object.assign(st, { rsi_shares: 0, rsi_avg: 0, rsi_buys: 0, rsi_day: -1 });
        else st.rsi_shares -= q;
      } else if (q >= st.shares) {
        Object.assign(st, { shares: 0, avg: 0, invested: 0, last_buy: 0, adds: 0, day: -1 });
      } else {
        st.invested *= (st.shares - q) / st.shares; st.shares -= q;
      }
      done.push(Object.assign({}, it, { qty: q }));
    }
    for (const it of items) {
      const o = it.order;
      if (o.side !== 'BUY' || !(it.qty > 0)) continue;
      const cost = it.qty * it.price;
      st.cash -= cost * (1 + p.fee);
      if (o.tag === 'rsi_buy') {
        if (st.rsi_shares === 0) { st.rsi_day = 0; st.rsi_mult = o.meta.mult; }
        st.rsi_avg = (st.rsi_avg * st.rsi_shares + cost) / (st.rsi_shares + it.qty);
        st.rsi_shares += it.qty; st.rsi_buys += 1;
      } else {
        if (o.tag === 'entry') { st.day = 0; st.adds = 0; st.cyc_mult = o.meta.mult; st.cyc_equity = o.meta.equity; }
        else st.adds += 1;
        st.avg = (st.avg * st.shares + cost) / (st.shares + it.qty);
        st.shares += it.qty; st.invested += cost; st.last_buy = it.price;
      }
      done.push(it);
    }
    return done;
  }

  /* 각 날짜 종가 기준 '다음 날' 주문에 쓸 신호 */
  function signals(tq, qq, p) {
    const n = tq.length, mom = new Array(n).fill(null), bpx = new Array(n), spx = new Array(n);
    for (let i = p.mom_lookback; i < n; i++) mom[i] = qq[i] / qq[i - p.mom_lookback] - 1;
    const { ag, al } = rsiAvgs(qq, p.rsi_n);
    for (let i = 0; i < n; i++) {
      bpx[i] = rsiOrderPrice(tq[i], qq[i], ag[i], al[i], p.rsi_buy, p.rsi_n, p.lev, p.rsi_down_floor, true);
      spx[i] = rsiOrderPrice(tq[i], qq[i], ag[i], al[i], p.rsi_sell, p.rsi_n, p.lev, p.rsi_down_floor, false);
    }
    return { mom, bpx, spx };
  }

  /* data = {dates:[Date..], tqqq:[..], qqq:[..]} */
  function backtest(data, params = {}, start = '1991-01-02', end = null, cash0 = 1e9) {
    const p = Object.assign({}, DEFAULTS, params);
    const t0 = new Date(start + 'T00:00:00Z').getTime();
    const t1 = end ? new Date(end + 'T00:00:00Z').getTime() : Infinity;
    const D = data.dates;
    let lo = Infinity;
    for (let i = 0; i < D.length; i++) if (D[i] >= t0 && D[i] <= t1) lo = Math.min(lo, data.tqqq[i]);
    const scale = 10 ** Math.max(0, Math.ceil(Math.log10(100 / lo)));
    const tq = data.tqqq.map(x => x * scale), qq = data.qqq;
    const sig = signals(tq, qq, p);
    const st = newState(cash0);
    const rows = [], cycles = [];
    let cyc = null, shortDays = 0;
    for (let i = Math.max(1, p.mom_lookback ? 1 : 1); i < D.length; i++) {
      if (D[i] < t0 || D[i] > t1) continue;
      const orders = planOrders(st, tq[i - 1], sig.mom[i - 1], sig.bpx[i - 1], sig.spx[i - 1], p);
      const short = orders.some(o => (o.tag === 'buy1' || o.tag === 'buy2') && o.meta.short);
      const c = tq[i], addsBefore = st.adds;
      const fills = applyFills(st, orders, c, p);
      const eq = st.cash + (st.shares + st.rsi_shares) * c;
      for (const o of fills) {
        if (o.tag === 'entry') cyc = { start: D[i], equity0: o.meta.equity, mult: o.meta.mult };
        if ((o.tag === 'tp' || o.tag === 'time_stop') && cyc) {
          cycles.push(Object.assign(cyc, { end: D[i], exit: o.tag, adds: addsBefore, equity1: eq })); cyc = null;
        }
      }
      if (short) shortDays++;
      const filt = st.shares ? st.cyc_mult < 1 : (sig.mom[i - 1] != null && sig.mom[i - 1] < 0);
      rows.push({ t: D[i], equity: eq, mainVal: st.shares * c, rsiVal: st.rsi_shares * c, filt, short, tqqq: data.tqqq[i], qqq: qq[i] });
    }
    return { rows, cycles, state: st, scale, params: p };
  }

  const YEAR_MS = 365.25 * 86400000;
  const cagr = (v0, v1, t0, t1) => (v1 / v0) ** (YEAR_MS / (t1 - t0)) - 1;
  const yearOf = t => new Date(t).getUTCFullYear();

  function yearly(rows) {
    const out = [];
    let base = rows[0], i = 0;
    while (i < rows.length) {
      const y = yearOf(rows[i].t);
      let j = i, peak = base.equity, mdd = 0;
      while (j < rows.length && yearOf(rows[j].t) === y) {
        peak = Math.max(peak, rows[j].equity); mdd = Math.min(mdd, rows[j].equity / peak - 1); j++;
      }
      const last = rows[j - 1];
      out.push({ year: y, strategy: last.equity / base.equity - 1, maxdd: mdd,
                 tqqq: last.tqqq / base.tqqq - 1, qqq: last.qqq / base.qqq - 1 });
      base = last; i = j;
    }
    return out;
  }

  /* 월별 수익률: 전월 말 대비 (첫 달은 시작일 대비) */
  function monthly(rows) {
    const out = [];
    let base = rows[0], i = 0;
    while (i < rows.length) {
      const d0 = new Date(rows[i].t), y = d0.getUTCFullYear(), m = d0.getUTCMonth();
      let j = i, peak = base.equity, mdd = 0;
      while (j < rows.length) {
        const d = new Date(rows[j].t);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m) break;
        peak = Math.max(peak, rows[j].equity); mdd = Math.min(mdd, rows[j].equity / peak - 1); j++;
      }
      const last = rows[j - 1];
      out.push({ year: y, month: m + 1, strategy: last.equity / base.equity - 1, maxdd: mdd,
                 tqqq: last.tqqq / base.tqqq - 1, qqq: last.qqq / base.qqq - 1 });
      base = last; i = j;
    }
    return out;
  }

  /* 계좌 대비 손실이 큰 사이클 n개 */
  function worstCycles(res, n = 3) {
    const idx = new Map(res.rows.map((r, i) => [r.t, i]));
    return res.cycles
      .map(c => Object.assign({}, c, { ret: c.equity1 / c.equity0 - 1, days: idx.get(c.end) - idx.get(c.start) }))
      .sort((a, b) => a.ret - b.ret)
      .slice(0, n);
  }

  function periods(rows, ranges) {
    return ranges.map(([a, b]) => {
      let s = -1, e = -1;
      for (let i = 0; i < rows.length; i++) {
        const y = yearOf(rows[i].t);
        if (y === a - 1) s = i;
        if (y >= a && y <= b) { if (s < 0) s = i; e = i; }
      }
      if (s < 0 || e <= s) return null;
      const r0 = rows[s], r1 = rows[e];
      return { label: `${a}~${b}`, strategy: cagr(r0.equity, r1.equity, r0.t, r1.t),
               qqq: cagr(r0.qqq, r1.qqq, r0.t, r1.t), tqqq: cagr(r0.tqqq, r1.tqqq, r0.t, r1.t) };
    }).filter(Boolean);
  }

  function summary(res) {
    const { rows, cycles } = res;
    const r0 = rows[0], r1 = rows[rows.length - 1];
    let peak = -Infinity, mdd = 0, mddT = r0.t, lastPeakT = r0.t, longest = 0, expo = 0, filt = 0, short = 0;
    for (const r of rows) {
      if (r.equity >= peak) { longest = Math.max(longest, r.t - lastPeakT); peak = r.equity; lastPeakT = r.t; }
      const dd = r.equity / peak - 1;
      if (dd < mdd) { mdd = dd; mddT = r.t; }
      expo += (r.mainVal + r.rsiVal) / r.equity; filt += r.filt ? 1 : 0; short += r.short ? 1 : 0;
    }
    longest = Math.max(longest, r1.t - lastPeakT);
    const c = cagr(r0.equity, r1.equity, r0.t, r1.t);
    const yr = yearly(rows);
    const ys = yr.map(y => y.strategy).sort((a, b) => a - b);
    const worstY = yr.reduce((a, b) => (b.strategy < a.strategy ? b : a));
    const cr = cycles.map(x => x.equity1 / x.equity0 - 1);
    const mid = ys.length >> 1;
    return {
      start: r0.t, end: r1.t, cagr: c, mdd, mddT, calmar: Math.abs(c / mdd), multiple: r1.equity / r0.equity,
      worstYear: worstY, lossYears: yr.filter(y => y.strategy < 0).length, years: yr.length,
      medianYear: ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2,
      cycles: cycles.length, timeStops: cycles.filter(x => x.exit === 'time_stop').length,
      winRate: cr.filter(x => x > 0).length / (cr.length || 1), worstCycle: cr.length ? Math.min(...cr) : 0,
      longestUnderwater: longest / YEAR_MS, exposure: expo / rows.length,
      filterDays: filt / rows.length, shortDays: short / rows.length,
    };
  }

  const api = { DEFAULTS, rd, ru, newState, rsiAvgs, rsiOrderPrice, planOrders, applyFills, applyManualFills, signals,
                backtest, yearly, monthly, worstCycles, periods, summary, cagr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolidEngine = api;
})(typeof self !== 'undefined' ? self : this);
