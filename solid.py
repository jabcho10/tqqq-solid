"""TQQQ 솔리드 매매 규칙 (TQQQ_솔리드_매매규칙.md) 구현

구조
- plan_orders(): 장 마감 전, 전날 종가와 계좌 상태로 오늘 낼 주문을 만든다 (문서 6장 체크리스트).
- apply_fills(): 오늘 종가로 LOC/MOC 체결을 처리하고 상태를 갱신한다.
- backtest(): 위 두 함수를 매일 반복한다. 실매매와 백테스트가 같은 코드를 쓴다.

사용
  python solid.py                         # 1991-01-02 ~ 데이터 끝 백테스트
  python solid.py --start 2010-02-11
  python solid.py --no-rsi                # RSI 엔진 끄기
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

DATA_XLSX = 'TQQQ-QLD-NDX-SPX_데이터_1985-2026.xlsx'
DATA_SHEET = '260812수정'


# ───────────────────────────── 설정 ─────────────────────────────
@dataclass(frozen=True)
class Params:
    # 메인 엔진 (2장)
    init_ratio: float = 0.20      # 첫 매수 = 총자산 × 20%
    entry_mult: float = 1.10      # 첫 매수 LOC = 전날 종가 × 1.10
    add_ratio: float = 0.25       # 추가 매수 = 지금까지 산 금액 × 25%
    b1: float = 0.995             # 매수1 = 전날 종가 × 0.995
    b2: float = 0.89              # 매수2 = 전날 종가 × 0.89
    max_adds: int = 7             # 누적 추가 매수 7회 미만일 때만 매수1·2 주문. 6회에서 둘 다 체결되면 8회 (의도된 동작)
    take_profit: float = 1.045    # 마지막 매수가 × 1.045 이상이면 전량 매도
    time_stop: int = 24           # 첫 매수일 0일 기준 24거래일째 MOC 전량 매도
    # RSI 엔진 (3장)
    use_rsi: bool = True
    rsi_n: int = 2
    rsi_buy: float = 22
    rsi_sell: float = 25
    rsi_ratio: float = 0.30       # 메인 사이클 시작 총자산 × 30% ÷ 2
    rsi_splits: int = 2
    rsi_hold: int = 10            # 첫 RSI 매수 0일 기준 10거래일째 MOC
    lev: float = 3.0
    rsi_down_floor: float = -0.333
    # 모멘텀 필터 (4장)
    use_mom: bool = True
    mom_lookback: int = 252
    mom_mult: float = 0.25
    mom_on_adds: bool = False     # 필터는 첫 매수에만 ×0.25. 추가 매수는 '산 금액의 25%'라 자연히 1/4 규모
    # 비용
    fee: float = 0.0007
    # 실험용 (기본값이면 문서 규칙 그대로)
    tp_split: tuple | None = None  # 나눠 팔기: ((1.03, 0.5), (1.06, 1.0)) = +3%에 절반, +6%에 나머지
    hook: object = None            # hook(ctx) -> dict. 키: init_ratio, mult, rsi_ratio, entry_mult


@dataclass
class State:
    cash: float
    # 메인
    shares: int = 0
    avg: float = 0.0
    invested: float = 0.0          # 지금까지 산 금액 (체결가 × 수량 합)
    last_buy: float = 0.0
    adds: int = 0
    day: int = -1                  # 사이클 진행일 (첫 매수일 = 0)
    cyc_mult: float = 1.0          # 사이클 시작 시 고정한 필터 배수
    cyc_equity: float = 0.0        # 사이클 시작 시점 총자산
    # RSI
    rsi_shares: int = 0
    rsi_avg: float = 0.0
    rsi_buys: int = 0
    rsi_day: int = -1
    rsi_mult: float = 1.0          # RSI 보유가 없을 때 판단해서 고정
    sold_part: bool = False        # 나눠 팔기 실험용


@dataclass
class Order:
    tag: str        # entry / buy1 / buy2 / tp / time_stop / rsi_buy / rsi_tp / rsi_time
    side: str       # BUY / SELL
    kind: str       # LOC / MOC
    qty: int
    price: float | None = None
    target_amt: float = 0.0        # 규칙상 금액 (현금 부족 판정용)
    meta: dict = field(default_factory=dict)


# ───────────────────────────── 계산 도구 ─────────────────────────────
def rd(x, n=2):
    """소수점 n자리 미만 버림"""
    f = 10 ** n
    return math.floor(x * f + 1e-9) / f


def ru(x, n=2):
    """소수점 n자리 미만 올림"""
    f = 10 ** n
    return math.ceil(x * f - 1e-9) / f


def rsi_avgs(px: np.ndarray, n: int = 2):
    """Wilder RSI 평균. 처음 n개 변화는 단순평균, 이후 (전날 × (n−1) + 오늘) ÷ n"""
    d = np.diff(px, prepend=np.nan)
    ag = np.full(len(px), np.nan)
    al = np.full(len(px), np.nan)
    ag[n] = np.clip(d[1:n + 1], 0, None).sum() / n
    al[n] = -np.clip(d[1:n + 1], None, 0).sum() / n
    for i in range(n + 1, len(px)):
        ag[i] = (ag[i - 1] * (n - 1) + max(d[i], 0)) / n
        al[i] = (al[i - 1] * (n - 1) + max(-d[i], 0)) / n
    return ag, al


def rsi_order_price(tq_c, q_c, ag, al, r, n, lev, down_floor, floor_p):
    """내일 QQQ RSI가 r이 되는 가격 → TQQQ 주문가 (3-2장)"""
    if np.isnan(ag) or np.isnan(al):
        return None
    k = n - 1
    p_up = q_c - ag * k + al * k * r / (100 - r)
    p_dn = q_c + al * k - ag * k * (100 - r) / r
    if floor_p:
        p_up, p_dn = max(p_up, 0.01), max(p_dn, 0.01)
    if p_up > q_c:
        p = p_up
    elif p_dn < q_c:
        p = p_dn
    else:
        return None
    ch = p / q_c - 1
    if ch < 0:
        ch = max(ch, down_floor)
    px = rd(tq_c * (1 + lev * ch), 2)
    return px if px > 0 else None


# ───────────────────────────── 주문 생성 (장 마감 전) ─────────────────────────────
def plan_orders(st: State, tq_prev: float, mom: float | None,
                rsi_buy_px: float | None, rsi_sell_px: float | None, p: Params,
                ov: dict | None = None) -> list[Order]:
    ov = ov or {}
    orders: list[Order] = []
    equity = st.cash + (st.shares + st.rsi_shares) * tq_prev
    filt_on = p.use_mom and mom is not None and mom < 0
    today_mult = ov.get('mult', p.mom_mult if filt_on else 1.0)
    avail = st.cash / (1 + p.fee)      # 수수료까지 낼 수 있는 한도. 미수 없음

    def buy(tag, amt, price, meta=None):
        nonlocal avail
        a = max(0.0, min(amt, avail))
        meta = dict(meta or {}, short=avail < amt)      # 현금 한도에 걸려 금액이 줄었는지
        qty = int(rd(a / price, 0)) if price > 0 else 0
        if qty > 0:
            orders.append(Order(tag, 'BUY', 'LOC', qty, price, amt, meta))
            avail -= qty * price
        elif amt > 0:
            orders.append(Order(tag, 'BUY', 'LOC', 0, price, amt, meta))  # 현금 부족 기록용

    # 메인 엔진
    if st.shares == 0:
        buy('entry', equity * ov.get('init_ratio', p.init_ratio) * today_mult,
            rd(tq_prev * ov.get('entry_mult', p.entry_mult)),
            {'mult': today_mult, 'equity': equity})
    else:
        if st.day + 1 >= p.time_stop:
            orders.append(Order('time_stop', 'SELL', 'MOC', st.shares))
        else:
            if p.tp_split:
                (t1, f1), (t2, _) = p.tp_split
                orders.append(Order('tp', 'SELL', 'LOC', st.shares, ru(st.last_buy * t2)))
                if not st.sold_part and int(st.shares * f1) > 0:
                    orders.append(Order('tp1', 'SELL', 'LOC', int(st.shares * f1), ru(st.last_buy * t1)))
            else:
                orders.append(Order('tp', 'SELL', 'LOC', st.shares, ru(st.last_buy * p.take_profit)))
            if st.adds < p.max_adds:
                amt = st.invested * p.add_ratio * (st.cyc_mult if p.mom_on_adds else 1.0)
                buy('buy1', amt, rd(tq_prev * p.b1))
                buy('buy2', amt, rd(tq_prev * p.b2))

    # RSI 엔진
    if p.use_rsi:
        rsi_moc = st.rsi_shares > 0 and st.rsi_day + 1 >= p.rsi_hold
        if rsi_moc:
            orders.append(Order('rsi_time', 'SELL', 'MOC', st.rsi_shares))
        elif st.rsi_shares > 0 and rsi_sell_px is not None:
            orders.append(Order('rsi_tp', 'SELL', 'LOC', st.rsi_shares, rsi_sell_px))
        if not rsi_moc and st.rsi_buys < p.rsi_splits and rsi_buy_px is not None and avail > 0:
            if st.rsi_shares > 0:
                rmult = st.rsi_mult
            else:
                rmult = st.cyc_mult if st.shares > 0 else today_mult
            basis = st.cyc_equity if st.shares > 0 else equity
            buy('rsi_buy', basis * ov.get('rsi_ratio', p.rsi_ratio) / p.rsi_splits * rmult, rsi_buy_px,
                {'mult': rmult})
    return orders


# ───────────────────────────── 체결 (장 마감) ─────────────────────────────
def apply_fills(st: State, orders: list[Order], c: float, p: Params) -> list[tuple[Order, float]]:
    if st.shares > 0:
        st.day += 1
    if st.rsi_shares > 0:
        st.rsi_day += 1
    fills = []

    def hit(o):
        if o.qty <= 0:
            return False
        if o.kind == 'MOC':
            return True
        return c <= o.price if o.side == 'BUY' else c >= o.price

    main_sold = False
    for o in orders:                                   # 매도 먼저
        if o.side != 'SELL' or not hit(o) or (o.tag == 'tp1' and main_sold):
            continue
        st.cash += o.qty * c * (1 - p.fee)
        if o.tag in ('tp', 'time_stop'):
            st.shares, st.avg, st.invested, st.last_buy, st.adds, st.day = 0, 0.0, 0.0, 0.0, 0, -1
            st.sold_part = False
            main_sold = True
        elif o.tag == 'tp1':
            st.invested *= (st.shares - o.qty) / st.shares
            st.shares -= o.qty
            st.sold_part = True
        else:
            st.rsi_shares, st.rsi_avg, st.rsi_buys, st.rsi_day = 0, 0.0, 0, -1
        fills.append((o, c))

    for o in orders:
        if o.side != 'BUY' or not hit(o):
            continue
        if main_sold and o.tag in ('buy1', 'buy2'):
            continue
        cost = o.qty * c
        st.cash -= cost * (1 + p.fee)
        if o.tag == 'rsi_buy':
            if st.rsi_shares == 0:
                st.rsi_day, st.rsi_mult = 0, o.meta['mult']
            st.rsi_avg = (st.rsi_avg * st.rsi_shares + cost) / (st.rsi_shares + o.qty)
            st.rsi_shares += o.qty
            st.rsi_buys += 1
        else:
            if o.tag == 'entry':
                st.day, st.adds = 0, 0
                st.cyc_mult, st.cyc_equity = o.meta['mult'], o.meta['equity']
            else:
                st.adds += 1
            st.avg = (st.avg * st.shares + cost) / (st.shares + o.qty)
            st.shares += o.qty
            st.invested += cost
            st.last_buy = c
        fills.append((o, c))
    assert st.cash > -1e-6, '현금이 음수가 됨 (미수 발생)'
    return fills


# ───────────────────────────── 데이터 / 백테스트 ─────────────────────────────
def load_data(path=DATA_XLSX, sheet=DATA_SHEET, asset='TQQQ') -> pd.DataFrame:
    """tqqq 열 = 매매 종목 종가 (asset='QLD'면 QLD), qqq 열 = 신호 종목"""
    df = pd.read_excel(path, sheet_name=sheet, usecols=['날짜', f'{asset} 종가', 'QQQ 종가'])
    df = df.rename(columns={'날짜': 'date', f'{asset} 종가': 'tqqq', 'QQQ 종가': 'qqq'})
    df = df.dropna().set_index('date').sort_index()
    return df[~df.index.duplicated()]


def signals(df: pd.DataFrame, p: Params) -> pd.DataFrame:
    """각 날짜 종가 기준으로 '다음 날' 주문에 쓸 값"""
    out = pd.DataFrame(index=df.index)
    out['mom'] = df.qqq / df.qqq.shift(p.mom_lookback) - 1
    ag, al = rsi_avgs(df.qqq.values, p.rsi_n)
    t, q = df.tqqq.values, df.qqq.values
    out['rsi_buy_px'] = [rsi_order_price(t[i], q[i], ag[i], al[i], p.rsi_buy, p.rsi_n, p.lev,
                                         p.rsi_down_floor, True) for i in range(len(df))]
    out['rsi_sell_px'] = [rsi_order_price(t[i], q[i], ag[i], al[i], p.rsi_sell, p.rsi_n, p.lev,
                                          p.rsi_down_floor, False) for i in range(len(df))]
    return out


def backtest(df: pd.DataFrame, p: Params = Params(), start='1991-01-02', end=None,
             cash0=1e9, price_scale=None):
    """price_scale: 2010년 이전 합성 TQQQ는 0.1달러 수준이라 0.01 단위 반올림이 가격을 크게 왜곡한다.
    가격 전체에 상수를 곱해(분할 전 가격처럼) 왜곡을 없앤다. 수익률에는 영향이 없다."""
    df = df.copy()
    if price_scale is None:
        lo = df.loc[start:end, 'tqqq'].min()
        price_scale = 10 ** max(0, math.ceil(math.log10(100 / lo)))
    df['tqqq'] *= price_scale
    sig = signals(df, p)
    idx = df.index
    days = idx[(idx >= pd.Timestamp(start)) & ((idx <= pd.Timestamp(end)) if end else True)]
    st = State(cash=cash0)
    rows, trades, cycles = [], [], []
    cyc = None
    for d in days:
        i = idx.get_loc(d)
        tq_prev = df.tqqq.iloc[i - 1]
        s = sig.iloc[i - 1]
        mom = None if pd.isna(s.mom) else s.mom
        bpx = None if pd.isna(s.rsi_buy_px) else s.rsi_buy_px
        spx = None if pd.isna(s.rsi_sell_px) else s.rsi_sell_px
        ov = p.hook(dict(date=idx[i - 1], i=i - 1, cycles=cycles, rows=rows)) if p.hook else None
        orders = plan_orders(st, tq_prev, mom, bpx, spx, p, ov)
        short = any(o.tag in ('buy1', 'buy2') and o.meta.get('short') for o in orders)
        c = df.tqqq.iloc[i]
        adds_before = st.adds
        fills = apply_fills(st, orders, c, p)
        eq = st.cash + (st.shares + st.rsi_shares) * c
        for o, px in fills:
            trades.append(dict(date=d, tag=o.tag, side=o.side, qty=o.qty, price=px / price_scale))
            if o.tag == 'entry':
                cyc = dict(start=d, equity0=o.meta['equity'], mult=o.meta['mult'])
            if o.tag in ('tp', 'time_stop') and cyc:
                cycles.append(dict(**cyc, end=d, exit=o.tag, adds=adds_before, equity1=eq))
                cyc = None
        rows.append(dict(date=d, equity=eq, cash=st.cash, main_val=st.shares * c, rsi_val=st.rsi_shares * c,
                         adds=st.adds, day=st.day, filt=st.cyc_mult < 1 if st.shares else (mom is not None and mom < 0),
                         short=short, tqqq=c, qqq=df.qqq.iloc[i]))
    daily = pd.DataFrame(rows).set_index('date')
    return daily, pd.DataFrame(trades), pd.DataFrame(cycles)


# ───────────────────────────── 성과 ─────────────────────────────
def cagr(v: pd.Series):
    yrs = (v.index[-1] - v.index[0]).days / 365.25
    return (v.iloc[-1] / v.iloc[0]) ** (1 / yrs) - 1


def summary(daily: pd.DataFrame, cycles: pd.DataFrame):
    eq = daily.equity
    dd = eq / eq.cummax() - 1
    yr = yearly(daily)
    # 최장 언더워터
    peak_dates = eq[eq >= eq.cummax()].index
    gaps = np.diff(list(peak_dates) + [eq.index[-1]])
    longest = max(gaps).days / 365.25 if len(gaps) else 0
    cyc_ret = (cycles.equity1 / cycles.equity0 - 1) if len(cycles) and 'equity1' in cycles else pd.Series(dtype=float)
    c = cagr(eq)
    return {
        '기간': f"{eq.index[0].date()} ~ {eq.index[-1].date()}",
        'CAGR': f"{c:.1%}",
        'MDD': f"{dd.min():.1%} ({dd.idxmin().date()})",
        'Calmar': f"{abs(c / dd.min()):.2f}",
        '최악 연도': f"{yr.strategy.min():+.1%} ({yr.strategy.idxmin()})",
        '손실 연도': f"{(yr.strategy < 0).sum()} / {len(yr)}",
        '연 수익률 중앙값': f"{yr.strategy.median():+.1%}",
        '사이클 수': f"{len(cycles)} (24일 청산 {(cycles.exit == 'time_stop').sum() if len(cycles) else 0})",
        '최악 사이클 (계좌 대비)': f"{cyc_ret.min():.1%}" if len(cyc_ret) else '-',
        '최장 언더워터': f"{longest:.1f}년",
        '평균 투입 비중': f"{((daily.main_val + daily.rsi_val) / daily.equity).mean():.1%}",
        '필터 켜진 날': f"{daily.filt.mean():.1%}",
        '현금 부족으로 추가 매수 줄어든 날': f"{daily.short.mean():.1%}",
    }


def yearly(daily: pd.DataFrame) -> pd.DataFrame:
    out = []
    first = daily.index[0]
    for y, g in daily.groupby(daily.index.year):
        prev = daily[daily.index.year < y]
        base = prev.iloc[-1] if len(prev) else daily.iloc[0]
        e = pd.concat([pd.Series([base.equity]), g.equity.reset_index(drop=True)])
        out.append(dict(year=y,
                        strategy=g.equity.iloc[-1] / base.equity - 1,
                        maxdd=(e / e.cummax() - 1).min(),
                        tqqq=g.tqqq.iloc[-1] / base.tqqq - 1,
                        qqq=g.qqq.iloc[-1] / base.qqq - 1))
    return pd.DataFrame(out).set_index('year')


def decades(daily: pd.DataFrame):
    out = []
    for a, b in [(1991, 2000), (2001, 2010), (2011, 2020), (2021, 2026)]:
        g = daily[(daily.index.year >= a - 1) & (daily.index.year <= b)]
        g = g[g.index >= g[g.index.year == a - 1].index.max()] if (g.index.year == a - 1).any() else g
        out.append(dict(기간=f"{a}~{b}", 전략=cagr(g.equity), QQQ=cagr(g.qqq), TQQQ=cagr(g.tqqq)))
    return pd.DataFrame(out).set_index('기간')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='1991-01-02')
    ap.add_argument('--end', default=None)
    ap.add_argument('--no-rsi', action='store_true')
    ap.add_argument('--no-mom', action='store_true')
    ap.add_argument('--mom-adds', action='store_true', help='추가 매수에도 필터 ×0.25 적용 (이전 해석)')
    ap.add_argument('--fee', type=float, default=0.0007)
    ap.add_argument('--yearly', action='store_true')
    a = ap.parse_args()
    p = replace(Params(), use_rsi=not a.no_rsi, use_mom=not a.no_mom,
                mom_on_adds=a.mom_adds, fee=a.fee)
    df = load_data()
    daily, trades, cycles = backtest(df, p, a.start, a.end)
    for k, v in summary(daily, cycles).items():
        print(f"{k:24s} {v}")
    if a.yearly:
        print('\n[10년 단위 CAGR]')
        print(decades(daily).map(lambda x: f"{x:6.1%}").to_string())
        print('\n[연도별]')
        print(yearly(daily).map(lambda x: f"{x:+7.1%}").to_string())


if __name__ == '__main__':
    main()
