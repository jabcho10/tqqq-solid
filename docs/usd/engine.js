/* USD 솔리드 매매 규칙 엔진 — usd_solid.py 와 같은 로직 (브라우저 / node 공용)
   규칙서: USD_솔리드_규칙서.md
   data = { dates:[ms..], usd:[..] }. 신호 지수(반도체 1배) = USD 일간 수익률 ÷ 2 누적 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    init_ratio: 0.25, entry_mult: 1.10, add_ratio: 0.25, b1: 0.995, b2: 0.89,
    max_buys: 8,                 // 첫 매수 포함. 7회인 날은 매수1만
    take_profit: 1.045, time_stop: 24,
    use_rsi: true, rsi_buy: 22, rsi_sell: 25, rsi_ratio: 0.30, rsi_splits: 2, rsi_hold: 10,
    lev: 2.0, rsi_down_floor: -0.333,
    cap: 0.60,                   // 총 투입 상한 (총자산 대비)
    fee: 0.0007,
  };

  const rd = (x, n = 2) => { const f = 10 ** n; return Math.floor(x * f + 1e-9) / f; };
  const ru = (x, n = 2) => { const f = 10 ** n; return Math.ceil(x * f - 1e-9) / f; };

  function newState(cash) {
    return {
      cash, shares: 0, avg: 0, invested: 0, last_buy: 0, adds: 0, day: -1, cyc_equity: 0,
      rsi_shares: 0, rsi_avg: 0, rsi_buys: 0, rsi_day: -1,
    };
  }

  /* 반도체 1배 대용 지수: 첫 값 100에서 USD 일간 수익률 ÷ 2 를 누적 */
  function signalIndex(usd) {
    const out = new Array(usd.length);
    out[0] = 100;
    for (let i = 1; i < usd.length; i++) out[i] = out[i - 1] * (1 + (usd[i] / usd[i - 1] - 1) / 2);
    return out;
  }

  /* RSI(2): 첫 2일 단순평균, 이후 (전날 + 오늘) ÷ 2 */
  function rsiAvgs(px) {
    const len = px.length, ag = new Array(len).fill(NaN), al = new Array(len).fill(NaN);
    if (len <= 2) return { ag, al };
    let g = 0, l = 0;
    for (let i = 1; i <= 2; i++) { const d = px[i] - px[i - 1]; if (d > 0) g += d; else l -= d; }
    ag[2] = g / 2; al[2] = l / 2;
    for (let i = 3; i < len; i++) {
      const d = px[i] - px[i - 1];
      ag[i] = (ag[i - 1] + Math.max(d, 0)) / 2;
      al[i] = (al[i - 1] + Math.max(-d, 0)) / 2;
    }
    return { ag, al };
  }

  /* 내일 지수 RSI가 r이 되는 가격 P → USD 주문가 = 오늘 USD 종가 × (1 + 2 × ch) (규칙서 3.2) */
  function rsiOrderPrice(usdC, C, ag, al, r, lev, downFloor) {
    if (Number.isNaN(ag) || Number.isNaN(al)) return null;
    const up = C - ag + al * r / (100 - r);
    const dn = C + al - ag * (100 - r) / r;
    let p;
    if (up > C) p = up; else if (dn < C) p = dn; else return null;
    p = Math.max(p, 0.01);
    const ch = Math.max(p / C - 1, downFloor);
    const px = rd(usdC * (1 + lev * ch), 2);
    return px > 0 ? px : null;
  }

  /* 장 마감 전: 오늘 낼 주문 (규칙서 5장). prev = 전날 USD 종가 */
  function planOrders(st, prev, rsiBuyPx, rsiSellPx, p) {
    const orders = [];
    const hold = (st.shares + st.rsi_shares) * prev;
    const equity = st.cash + hold;
    const capRoom = Math.max(0, equity * p.cap - hold);
    let room = Math.min(capRoom, st.cash);         // 수수료 포함 금액 한도 (4장)
    const limitBy = capRoom < st.cash ? 'cap' : 'cash';

    const buy = (tag, amt, price, meta = {}) => {
      const a = Math.min(amt, room / (1 + p.fee));
      const qty = price > 0 ? Math.floor(Math.max(0, a) / price) : 0;
      meta = Object.assign({}, meta, { short: a < amt - 1e-9, limit: limitBy });
      if (qty > 0) { orders.push({ tag, side: 'BUY', kind: 'LOC', qty, price, target: amt, meta }); room -= qty * price * (1 + p.fee); }
      else if (amt > 0) orders.push({ tag, side: 'BUY', kind: 'LOC', qty: 0, price, target: amt, meta });
    };

    // 메인 엔진
    let basis = null;
    if (st.shares === 0) {
      basis = equity;
      buy('entry', equity * p.init_ratio, rd(prev * p.entry_mult), { equity });
    } else if (st.day + 1 >= p.time_stop) {
      orders.push({ tag: 'time_stop', side: 'SELL', kind: 'MOC', qty: st.shares, price: null, meta: {} });
    } else {
      orders.push({ tag: 'tp', side: 'SELL', kind: 'LOC', qty: st.shares, price: ru(st.last_buy * p.take_profit), meta: {} });
      const buys = st.adds + 1;
      if (buys < p.max_buys) {
        const amt = st.invested * p.add_ratio;
        buy('buy1', amt, rd(prev * p.b1));
        if (buys < p.max_buys - 1) buy('buy2', amt, rd(prev * p.b2));
      }
    }

    // RSI 엔진
    if (p.use_rsi) {
      const rsiMoc = st.rsi_shares > 0 && st.rsi_day + 1 >= p.rsi_hold;
      if (rsiMoc) orders.push({ tag: 'rsi_time', side: 'SELL', kind: 'MOC', qty: st.rsi_shares, price: null, meta: {} });
      else {
        if (st.rsi_buys < p.rsi_splits && rsiBuyPx != null) {
          const b = st.shares > 0 ? st.cyc_equity : basis;
          buy('rsi_buy', b * p.rsi_ratio / p.rsi_splits, rsiBuyPx, { basis: b });
        }
        if (st.rsi_shares > 0 && rsiSellPx != null)
          orders.push({ tag: 'rsi_tp', side: 'SELL', kind: 'LOC', qty: st.rsi_shares, price: rsiSellPx, meta: {} });
      }
    }
    return orders;
  }

  function resetMain(st) { Object.assign(st, { shares: 0, avg: 0, invested: 0, last_buy: 0, adds: 0, day: -1 }); }
  function resetRsi(st) { Object.assign(st, { rsi_shares: 0, rsi_avg: 0, rsi_buys: 0, rsi_day: -1 }); }
  function addBuy(st, o, qty, price, p) {
    const cost = qty * price;
    st.cash -= cost * (1 + p.fee);
    if (o.tag === 'rsi_buy') {
      if (st.rsi_shares === 0) st.rsi_day = 0;
      st.rsi_avg = (st.rsi_avg * st.rsi_shares + cost) / (st.rsi_shares + qty);
      st.rsi_shares += qty; st.rsi_buys += 1;
    } else {
      if (o.tag === 'entry') { st.day = 0; st.adds = 0; st.cyc_equity = o.meta.equity; }
      else st.adds += 1;
      st.avg = (st.avg * st.shares + cost) / (st.shares + qty);
      st.shares += qty; st.invested += cost; st.last_buy = price;
    }
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
      if (o.tag === 'tp' || o.tag === 'time_stop') { resetMain(st); mainSold = true; } else resetRsi(st);
      fills.push(o);
    }
    for (const o of orders) {
      if (o.side !== 'BUY' || !hit(o)) continue;
      if (mainSold && (o.tag === 'buy1' || o.tag === 'buy2')) continue;
      addBuy(st, o, o.qty, c, p);
      fills.push(o);
    }
    if (st.cash < -1e-6) throw new Error('현금이 음수가 됨 (미수 발생)');
    return fills;
  }

  /* 실제 체결 입력: items = [{order, qty, price}] (체결된 것만) */
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
      if (isRsi) { if (q >= st.rsi_shares) resetRsi(st); else st.rsi_shares -= q; }
      else if (q >= st.shares) resetMain(st);
      else { st.invested *= (st.shares - q) / st.shares; st.shares -= q; }
      done.push(Object.assign({}, it, { qty: q }));
    }
    for (const it of items) {
      const o = it.order;
      if (o.side !== 'BUY' || !(it.qty > 0)) continue;
      addBuy(st, o, it.qty, it.price, p);
      done.push(it);
    }
    return done;
  }

  /* 각 날짜 종가 기준 '다음 날' 주문에 쓸 RSI 가격 */
  function signals(usd, idx, p) {
    const n = usd.length, bpx = new Array(n), spx = new Array(n);
    const { ag, al } = rsiAvgs(idx);
    for (let i = 0; i < n; i++) {
      bpx[i] = rsiOrderPrice(usd[i], idx[i], ag[i], al[i], p.rsi_buy, p.lev, p.rsi_down_floor);
      spx[i] = rsiOrderPrice(usd[i], idx[i], ag[i], al[i], p.rsi_sell, p.lev, p.rsi_down_floor);
    }
    return { bpx, spx };
  }

  function backtest(data, params = {}, start = '2002-07-22', end = null, cash0 = 1e9) {
    const p = Object.assign({}, DEFAULTS, params);
    const t0 = new Date(start + 'T00:00:00Z').getTime();
    const t1 = end ? new Date(end + 'T00:00:00Z').getTime() : Infinity;
    const D = data.dates;
    let lo = Infinity;
    for (let i = 0; i < D.length; i++) if (D[i] >= t0 && D[i] <= t1) lo = Math.min(lo, data.usd[i]);
    // 0.01 단위 반올림 왜곡 방지: 가격 전체에 상수를 곱한다 (수익률 무관)
    const scale = 10 ** Math.max(0, Math.ceil(Math.log10(100 / lo)));
    const px = data.usd.map(x => x * scale);
    const idx = data.idx || signalIndex(data.usd);
    const sig = signals(px, idx, p);
    const st = newState(cash0);
    const rows = [], cycles = [];
    let cyc = null;
    for (let i = 1; i < D.length; i++) {
      if (D[i] < t0 || D[i] > t1) continue;
      const orders = planOrders(st, px[i - 1], sig.bpx[i - 1], sig.spx[i - 1], p);
      const short = orders.some(o => o.side === 'BUY' && o.meta.short && o.meta.limit === 'cap');
      const c = px[i], addsBefore = st.adds;
      const fills = applyFills(st, orders, c, p);
      const eq = st.cash + (st.shares + st.rsi_shares) * c;
      for (const o of fills) {
        if (o.tag === 'entry') cyc = { start: D[i], equity0: o.meta.equity };
        if ((o.tag === 'tp' || o.tag === 'time_stop') && cyc) {
          cycles.push(Object.assign(cyc, { end: D[i], exit: o.tag, buys: addsBefore + 1, equity1: eq })); cyc = null;
        }
      }
      rows.push({ t: D[i], equity: eq, mainVal: st.shares * c, rsiVal: st.rsi_shares * c, short, usd: data.usd[i], idx: idx[i] });
    }
    return { rows, cycles, state: st, scale, params: p };
  }

  const YEAR_MS = 365.25 * 86400000;
  const cagr = (v0, v1, t0, t1) => (v1 / v0) ** (YEAR_MS / (t1 - t0)) - 1;
  const yearOf = t => new Date(t).getUTCFullYear();

  /* 연도별: 수익률은 전년 말 대비, 연중 최대 하락은 그해 안의 고점 기준 (규칙서 표와 같은 정의) */
  function yearly(rows) {
    const out = [];
    let base = rows[0], i = 0;
    while (i < rows.length) {
      const y = yearOf(rows[i].t);
      let j = i, peak = -Infinity, mdd = 0;
      while (j < rows.length && yearOf(rows[j].t) === y) {
        peak = Math.max(peak, rows[j].equity); mdd = Math.min(mdd, rows[j].equity / peak - 1); j++;
      }
      const last = rows[j - 1];
      out.push({ year: y, strategy: last.equity / base.equity - 1, maxdd: mdd,
                 usd: last.usd / base.usd - 1, idx: last.idx / base.idx - 1 });
      base = last; i = j;
    }
    return out;
  }

  function monthly(rows) {
    const out = [];
    let base = rows[0], i = 0;
    while (i < rows.length) {
      const d0 = new Date(rows[i].t), y = d0.getUTCFullYear(), m = d0.getUTCMonth();
      let j = i, peak = -Infinity, mdd = 0;
      while (j < rows.length) {
        const d = new Date(rows[j].t);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m) break;
        peak = Math.max(peak, rows[j].equity); mdd = Math.min(mdd, rows[j].equity / peak - 1); j++;
      }
      const last = rows[j - 1];
      out.push({ year: y, month: m + 1, strategy: last.equity / base.equity - 1, maxdd: mdd,
                 usd: last.usd / base.usd - 1, idx: last.idx / base.idx - 1 });
      base = last; i = j;
    }
    return out;
  }

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
               idx: cagr(r0.idx, r1.idx, r0.t, r1.t), usd: cagr(r0.usd, r1.usd, r0.t, r1.t) };
    }).filter(Boolean);
  }

  function summary(res) {
    const { rows, cycles } = res;
    const r0 = rows[0], r1 = rows[rows.length - 1];
    let peak = -Infinity, mdd = 0, mddT = r0.t, lastPeakT = r0.t, longest = 0, expo = 0, maxExpo = 0, short = 0;
    for (const r of rows) {
      if (r.equity >= peak) { longest = Math.max(longest, r.t - lastPeakT); peak = r.equity; lastPeakT = r.t; }
      const dd = r.equity / peak - 1;
      if (dd < mdd) { mdd = dd; mddT = r.t; }
      const e = (r.mainVal + r.rsiVal) / r.equity;
      expo += e; maxExpo = Math.max(maxExpo, e); short += r.short ? 1 : 0;
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
      longestUnderwater: longest / YEAR_MS, exposure: expo / rows.length, maxExposure: maxExpo,
      capDays: short / rows.length,
    };
  }

  const api = { DEFAULTS, rd, ru, newState, signalIndex, rsiAvgs, rsiOrderPrice, planOrders, applyFills, applyManualFills,
                signals, backtest, yearly, monthly, worstCycles, periods, summary, cagr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SolidEngine = api;
})(typeof self !== 'undefined' ? self : this);
