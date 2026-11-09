"""SOXL 솔리드 하이브리드 전략 - 구글시트 수식 1:1 재현 엔진"""
import math
import numpy as np
import pandas as pd

P = dict(first_fallback=0.33, b0=0.10, b1=-0.01, b2=-0.11,
         rsi_n=2, rsi_buy=22, rsi_sell=25,
         th=(0.10, 0.05, -0.06, -0.12),
         init_ratio={'초고': .20, '고': .25, '중': .30, '저': .35, '초저': .40, '': .33},
         rsi_ratio={'초고': .50, '고': .40, '중': .30, '저': .20, '초저': .10, '': .33},
         sell=0.06, moc=24, buy_limit=7, split=6, rsi_split=2, rsi_moc=10,
         growth_win=260, use_regime=True, use_rsi=True,
         filt=None, max_exposure=None, dd_throttle=None, use_main=True)


def rd(x, n=0):
    f = 10 ** n
    return math.floor(x * f + 1e-9) / f


def ru(x, n=0):
    f = 10 ** n
    return math.ceil(x * f - 1e-9) / f


def weekly_growth(qqq: pd.Series, win=260):
    """qqq: daily close indexed by date -> weekly close (last trading day of week) + rolling GROWTH disparity"""
    wk = qqq.groupby(qqq.index.to_period('W-FRI')).tail(1)
    x = np.array([d.toordinal() for d in wk.index], float)
    y = np.log(wk.values.astype(float))
    trend = np.full(len(wk), np.nan)
    for i in range(1, len(wk)):
        s = max(0, i - win + 1)
        xs, ys = x[s:i + 1], y[s:i + 1]
        b, a = np.polyfit(xs, ys, 1)
        trend[i] = round(math.exp(a + b * x[i]), 2)
    return pd.DataFrame({'close': wk.values, 'trend': trend, 'disp': wk.values / trend - 1}, index=wk.index)


def rsi_avgs(px: pd.Series, n=2):
    g = px.diff()
    ag = np.full(len(px), np.nan); al = np.full(len(px), np.nan)
    gv = g.values
    # 시트: 첫 값 = 처음 n개 변화의 단순평균 (row n+2), 이후 Wilder
    ag[n] = np.sum(np.clip(gv[1:n + 1], 0, None)) / n
    al[n] = -np.sum(np.clip(gv[1:n + 1], None, 0)) / n
    for i in range(n + 1, len(px)):
        ag[i] = (ag[i - 1] * (n - 1) + max(gv[i], 0)) / n
        al[i] = (al[i - 1] * (n - 1) + max(-gv[i], 0)) / n
    return pd.DataFrame({'c': px.values, 'ag': ag, 'al': al}, index=px.index)


def rsi_price(soxl_c, sx, r, n, floor=True):
    c, ag, al = sx
    if np.isnan(ag):
        return None
    up = c - ag * (n - 1) + al * (n - 1) * r / (100 - r)
    dn = c + al * (n - 1) - ag * (n - 1) * (100 - r) / r
    if floor:
        up = max(up, 0.01); dn = max(dn, 0.01)
    if up > c:
        t = up
    elif dn < c:
        t = dn
    else:
        return None
    ch = t / c - 1
    if ch < 0:
        ch = max(ch, -0.333)
    return rd(soxl_c * (1 + ch * 3), 2)


def regime_of(date, next_bd, wk, p):
    if not p['use_regime']:
        return ''
    idx = wk.index[wk.index < next_bd]
    if len(idx) == 0:
        return ''
    d = idx[-1]
    if (next_bd - d).days > 9:
        return ''
    v = wk.at[d, 'disp']
    if np.isnan(v):
        return ''
    a, b, c, e = p['th']
    if v > a: return '초고'
    if v > b: return '고'
    if v > c: return '중'
    if v > e: return '저'
    return '초저'


def run(soxl: pd.Series, soxx: pd.Series, qqq: pd.Series, start, end=None, cash0=6500.0, p=P, wk=None):
    """soxl/soxx/qqq: daily close Series indexed by Timestamp."""
    if wk is None:
        wk = weekly_growth(qqq, p['growth_win'])
    sx = rsi_avgs(soxx, p['rsi_n'])
    days = soxl.index[(soxl.index >= pd.Timestamp(start))]
    if end is not None:
        days = days[days <= pd.Timestamp(end)]
    allbd = soxl.index
    n = p['rsi_n']
    recs = []
    # state
    A = 0; R = 0; E = 0.0; S = 0; J = 0.0; Pc = cash0; AC = cash0; AF = 0; AG = 0; AH = 0
    W = 0.0; peak = 0.0; last_buy = None; cyc_start_i = 0; cyc_AC = cash0; invested = 0.0
    prev = None
    for i, d in enumerate(days):
        C = float(soxl.at[d])
        pos = allbd.get_loc(d)
        nbd = allbd[pos + 1] if pos + 1 < len(allbd) else d + pd.offsets.BDay(1)
        reg = regime_of(d, nbd, wk, p)
        D = 0; I = 0; gmain = None; grsi = None
        if prev is not None:
            Cp = prev['C']
            b0 = rd(Cp * (1 + p['b0']), 2); b1 = rd(Cp * (1 + p['b1']), 2); b2 = rd(Cp * (1 + p['b2']), 2)
            sellb = ru(last_buy * (1 + p['sell']), 2) if last_buy is not None else float('inf')
            forced = i - cyc_start_i
            fx = prev['F']
            if fx.get('exit') and R > 0:
                D = -R
            elif prev['A'] == 0:
                D = int(rd(prev['Y'] / b0)) if C <= b0 else 0
            elif forced > p['moc']:
                D = -R
            elif C >= sellb:
                D = -R
            elif C <= b2:
                D = int(rd(prev['Z'] / b1)) + int(rd(prev['AA'] / b2))
            elif C <= b1:
                D = int(rd(prev['Z'] / b1))
            # A
            if D < 0: A = 0
            elif prev['A'] == 0 and D > 0: A = 1
            elif D > 0 and C <= b2: A = prev['A'] + 2
            elif D > 0 and C <= b1: A = prev['A'] + 1
            else: A = prev['A']
            # RSI
            AIp, AJp = prev['AI'], prev['AJ']
            if fx.get('exit') and S > 0:
                I = -S
            elif (not p['use_rsi']) or AIp is None:
                I = 0
            elif prev['AH'] >= p['rsi_moc']:
                I = -S
            elif C <= AIp:
                I = int(rd(prev['AB'] / AIp))
            elif AJp is not None and C >= AJp:
                I = -S
            else:
                I = 0
            # main fills
            if D > 0:
                E = (E * R + C * D) / (R + D); invested += C * D; last_buy = C
            elif D < 0:
                gmain = (C / E - 1, -(C - E) * D)
                invested = 0.0
            R += D
            if R == 0 and D < 0: E = 0.0
            if I > 0:
                J = (J * S + C * I) / (S + I)
            elif I < 0:
                grsi = (C / J - 1, -(C - J) * I)
            S += I
            if S == 0 and I < 0: J = 0.0
            Pc = Pc - C * D - C * I
        O = Pc + C * (R + S)
        if prev is not None:
            W = (1 + W) * (O / prev['O']) - 1
        peak = max(peak, W)
        DD = (W - peak) / (1 + peak)
        if A == 0:
            AC = O; cyc_start_i = i; cyc_AC = AC
        AF = 0 if A == 0 else AF + 1
        AG = 0 if I < 0 else (AG + 1 if I > 0 else AG)
        AH = 0 if AG == 0 else AH + 1
        F = p['filt'](d, reg) if p['filt'] else {}
        mult = 1.0
        if p['dd_throttle'] and DD < p['dd_throttle'][0]:
            mult = p['dd_throttle'][1]
        ir = F.get('init_ratio', p['init_ratio'][reg])
        Y = AC * ir * F.get('init', 1.0) * mult if A == 0 else 0.0
        if not p['use_main']:
            Y = 0.0
        if A == 0 or A >= p['buy_limit'] + 1 or AF >= p['moc']:
            Z = AA = 0.0
        else:
            amt = invested / p['split'] * F.get('add', 1.0) * mult
            if p['max_exposure'] is not None:
                amt = max(0.0, min(amt, cyc_AC * p['max_exposure'] - invested))
            Z = min(amt, Pc)
            AA = min(amt, Pc - Z)
            if p['max_exposure'] is not None:
                AA = max(0.0, min(AA, cyc_AC * p['max_exposure'] - invested - Z))
        # RSI next-day prices (SOXX same date)
        if d in sx.index:
            row = sx.loc[d]; t = (row.c, row.ag, row.al)
            AI = rsi_price(C, t, p['rsi_buy'], n, True)
            AJ = rsi_price(C, t, p['rsi_sell'], n, False)
        else:
            AI = AJ = None
        if AG == p['rsi_split'] or AI is None:
            AB = 0.0
        else:
            AB = min(cyc_AC * F.get('rsi_ratio', p['rsi_ratio'][reg]) / p['rsi_split'] * F.get('rsi', 1.0) * mult, Pc - Y - Z - AA)
            AB = max(AB, 0.0)
        cur = dict(date=d, C=C, A=A, D=D, I=I, R=R, S=S, O=O, P=Pc, W=W, DD=DD, Y=Y, Z=Z, AA=AA, AB=AB,
                   AI=AI, AJ=AJ, AH=AH, reg=reg, F=F, gm=gmain, gr=grsi, cash=Pc / O)
        recs.append(cur); prev = cur
    return pd.DataFrame(recs).set_index('date')


def stats(df):
    yrs = (df.index[-1] - df.index[0]).days + 1
    tot = df.W.iloc[-1]
    cagr = (1 + tot) ** (365 / yrs) - 1
    mdd = df.DD.min()
    gm = [g for g in df.gm if g is not None]; gr = [g for g in df.gr if g is not None]
    return dict(start=df.index[0].date(), end=df.index[-1].date(), CAGR=cagr, MDD=mdd, Calmar=abs(cagr / mdd),
                total=tot, main_n=len(gm), main_win=np.mean([g[0] > 0 for g in gm]) if gm else np.nan,
                rsi_n=len(gr), rsi_win=np.mean([g[0] > 0 for g in gr]) if gr else np.nan,
                avg_cash=df.cash.mean(), min_cash=df.cash.min())


def yearly(df):
    out = []
    for y, g in df.groupby(df.index.year):
        prev = df[df.index.year < y]
        w0 = prev.W.iloc[-1] if len(prev) else 0
        ret = (1 + g.W.iloc[-1]) / (1 + w0) - 1
        # 연중 MDD (연초 대비 신고점 기준)
        wv = (1 + g.W.values) / (1 + w0)
        pk = np.maximum.accumulate(np.concatenate([[1.0], wv]))[1:]
        out.append(dict(year=y, ret=ret, mdd=(wv / pk - 1).min()))
    return pd.DataFrame(out).set_index('year')
