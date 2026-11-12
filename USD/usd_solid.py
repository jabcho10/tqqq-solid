"""USD 솔리드 규칙서(USD_솔리드_규칙서.md) 백테스트 — 문서만 보고 독립 구현

사용
  python usd_solid.py                      # 실제 데이터 2007-02 ~ 끝
  python usd_solid.py --start 2010-01-01
  python usd_solid.py --data USD_합성_일별데이터_2001-2026.xlsx --start 2002-07-22 --yearly   # 규칙서 6장 합성 포함 구간
"""
from __future__ import annotations

import argparse
import math

import numpy as np
import pandas as pd

FEE = 0.0007
INIT, ENTRY_M, ADD, B1, B2 = 0.25, 1.10, 0.25, 0.995, 0.89
MAX_BUYS, TP, TSTOP = 8, 1.045, 24
R_BUY, R_SELL, R_RATIO, R_SPLITS, R_HOLD, LEV, FLOOR = 22, 25, 0.30, 2, 10, 2.0, -0.333
CAP = 0.60


def rd(x, n=2):
    f = 10 ** n
    return math.floor(x * f + 1e-9) / f


def ru(x, n=2):
    f = 10 ** n
    return math.ceil(x * f - 1e-9) / f


def load(path='usd_us_d.csv'):
    if path.endswith('.xlsx'):    # 합성+실제 (USD_합성_일별데이터_2001-2026.xlsx, 시트 USD_데이터)
        df = pd.read_excel(path, sheet_name='USD_데이터', usecols=['날짜', 'USD 종가'])
        usd = df.set_index('날짜')['USD 종가'].dropna().sort_index()
    else:
        df = pd.read_csv(path, parse_dates=['Date']).set_index('Date').sort_index()
        usd = df.Close
    idx = (1 + usd.pct_change().fillna(0) / 2).cumprod() * 100     # 반도체 1배 대용 지수
    return pd.DataFrame({'usd': usd, 'idx': idx})


def rsi_avgs(px):
    d = np.diff(px, prepend=np.nan)
    ag, al = np.full(len(px), np.nan), np.full(len(px), np.nan)
    ag[2] = np.clip(d[1:3], 0, None).mean()
    al[2] = (-np.clip(d[1:3], None, 0)).mean()
    for i in range(3, len(px)):
        ag[i] = (ag[i - 1] + max(d[i], 0)) / 2
        al[i] = (al[i - 1] + max(-d[i], 0)) / 2
    return ag, al


def rsi_px(usd_c, C, ag, al, r):
    if np.isnan(ag):
        return None
    pu = C - ag + al * r / (100 - r)
    pdn = C + al - ag * (100 - r) / r
    if pu > C:
        P = pu
    elif pdn < C:
        P = pdn
    else:
        return None
    P = max(P, 0.01)
    ch = max(P / C - 1, FLOOR)
    px = rd(usd_c * (1 + LEV * ch))
    return px if px > 0 else None


def backtest(df, start, end=None, cash0=1e8):
    df = df.copy()
    lo = df.loc[start:end, 'usd'].min()
    df['usd'] *= 10 ** max(0, math.ceil(math.log10(100 / lo)))     # 0.01 반올림 왜곡 방지 (수익률 무관)
    ag, al = rsi_avgs(df.idx.values)
    u, x = df.usd.values, df.idx.values
    bpx = [rsi_px(u[i], x[i], ag[i], al[i], R_BUY) for i in range(len(df))]
    spx = [rsi_px(u[i], x[i], ag[i], al[i], R_SELL) for i in range(len(df))]

    cash = cash0
    sh = buys = 0; day = -1; invested = last = cyc_eq = 0.0
    rsh = rbuys = 0; rday = -1
    rows, cycles = [], []
    days = np.where((df.index >= start) & ((df.index <= end) if end else True))[0]
    for i in days:
        prev, c = u[i - 1], u[i]
        eq = cash + (sh + rsh) * prev
        room = min(max(0.0, eq * CAP - (sh + rsh) * prev), cash)   # 수수료 포함 금액 한도
        orders = []   # (tag, side, kind, qty, price)

        def buy(tag, amt, price):
            nonlocal room
            amt = min(amt, room / (1 + FEE))
            q = int(amt // price) if price > 0 else 0
            if q > 0:
                orders.append((tag, 'B', 'LOC', q, price))
                room -= q * price * (1 + FEE)

        # 메인
        basis = None
        if sh == 0:
            basis = eq
            buy('entry', eq * INIT, rd(prev * ENTRY_M))
        elif day + 1 >= TSTOP:
            orders.append(('tstop', 'S', 'MOC', sh, None))
        else:
            orders.append(('tp', 'S', 'LOC', sh, ru(last * TP)))
            if buys < MAX_BUYS:
                amt = invested * ADD
                buy('buy1', amt, rd(prev * B1))
                if buys < MAX_BUYS - 1:
                    buy('buy2', amt, rd(prev * B2))
        # RSI
        rmoc = rsh > 0 and rday + 1 >= R_HOLD
        if rmoc:
            orders.append(('rtime', 'S', 'MOC', rsh, None))
        else:
            if rbuys < R_SPLITS and bpx[i - 1] is not None:
                rb = cyc_eq if sh > 0 else basis
                buy('rbuy', rb * R_RATIO / R_SPLITS, bpx[i - 1])
            if rsh > 0 and spx[i - 1] is not None:
                orders.append(('rtp', 'S', 'LOC', rsh, spx[i - 1]))

        # 체결
        if sh: day += 1
        if rsh: rday += 1
        hit = lambda o: o[2] == 'MOC' or (c <= o[4] if o[1] == 'B' else c >= o[4])
        main_sold = False
        for o in orders:
            if o[1] == 'S' and hit(o):
                cash += o[3] * c * (1 - FEE)
                if o[0] in ('tp', 'tstop'):
                    cycles.append(dict(end=df.index[i], exit=o[0], buys=buys))
                    sh = buys = 0; day = -1; invested = last = 0.0; main_sold = True
                else:
                    rsh = rbuys = 0; rday = -1
        for o in orders:
            if o[1] != 'B' or not hit(o) or (main_sold and o[0] in ('buy1', 'buy2')):
                continue
            cost = o[3] * c
            cash -= cost * (1 + FEE)
            if o[0] == 'rbuy':
                if rsh == 0: rday = 0
                rsh += o[3]; rbuys += 1
            else:
                if o[0] == 'entry':
                    day, buys, cyc_eq = 0, 0, basis
                sh += o[3]; buys += 1; invested += cost; last = c
        assert cash > -1e-6
        e = cash + (sh + rsh) * c
        rows.append(dict(date=df.index[i], equity=e, expo=(sh + rsh) * c / e, usd=c))
    return pd.DataFrame(rows).set_index('date'), pd.DataFrame(cycles)


def cagr(v):
    return (v.iloc[-1] / v.iloc[0]) ** (365.25 / (v.index[-1] - v.index[0]).days) - 1


def report(daily, cycles, yearly=False):
    eq = daily.equity
    dd = eq / eq.cummax() - 1
    c = cagr(eq)
    print(f"기간 {eq.index[0].date()} ~ {eq.index[-1].date()}")
    print(f"CAGR {c:.1%}  MDD {dd.min():.1%} ({dd.idxmin().date()})  Calmar {abs(c / dd.min()):.2f}")
    print(f"평균 투입 {daily.expo.mean():.1%}  최대 투입 {daily.expo.max():.1%}")
    print(f"사이클 {len(cycles)} (1.045 매도 {(cycles.exit == 'tp').sum()}, 24일 MOC {(cycles.exit == 'tstop').sum()})")
    print(f"USD 보유 CAGR {cagr(daily.usd):.1%}  MDD {(daily.usd / daily.usd.cummax() - 1).min():.1%}")
    if yearly:
        out = []
        for y, g in daily.groupby(daily.index.year):
            prev = daily[daily.index.year < y]
            b = prev.iloc[-1] if len(prev) else daily.iloc[0]
            e = g.equity    # 연중 최대 하락: 그해 안의 고점 기준 (규칙서 표와 같은 정의)
            out.append((y, g.equity.iloc[-1] / b.equity - 1, (e / e.cummax() - 1).min(), g.usd.iloc[-1] / b.usd - 1))
        print(pd.DataFrame(out, columns=['연도', '수익률', '연중MDD', 'USD']).set_index('연도')
              .map(lambda v: f"{v:+.1%}").to_string())


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2007-02-02')
    ap.add_argument('--end')
    ap.add_argument('--data', default='usd_us_d.csv', help='합성 포함: USD_합성_일별데이터_2001-2026.xlsx')
    ap.add_argument('--yearly', action='store_true')
    a = ap.parse_args()
    report(*backtest(load(a.data), a.start, a.end), a.yearly)
