"""매매규칙 8장 '검토했지만 채택하지 않은 안' 재검증 (+ 4장 모멘텀 기간 비교)

python verify_ch8.py   # 결과를 표로 출력하고 ch8_results.csv로 저장
"""
from dataclasses import replace

import numpy as np
import pandas as pd

from solid import Params, backtest, cagr, load_data, summary, yearly

BASE = Params()
DF = load_data()
Q = DF.qqq


# ───────── 성과 지표 ─────────
def metrics(daily, cycles):
    eq = daily.equity
    out = dict(CAGR=cagr(eq), MDD=(eq / eq.cummax() - 1).min())
    for a, b in [('1991', '2009'), ('2010', '2026')]:
        e = eq.loc[a:b]
        out[f'CAGR_{a[2:]}~{b[2:]}'] = cagr(e)
        out[f'MDD_{a[2:]}~{b[2:]}'] = (e / e.cummax() - 1).min()
    out['Calmar'] = abs(out['CAGR'] / out['MDD'])
    out['24일청산'] = int((cycles.exit == 'time_stop').sum())
    out['투입비중'] = ((daily.main_val + daily.rsi_val) / daily.equity).mean()
    return out


# ───────── 신호 ─────────
def weekly_regime_table():
    """원본 엑셀 '시장 평가': QQQ 주봉 종가 / 260주 로그 회귀 추세 − 1 (GROWTH 이격도)"""
    wk = Q.groupby(Q.index.to_period('W-FRI')).tail(1)
    x = np.array([d.toordinal() for d in wk.index], float)
    y = np.log(wk.values)
    trend = np.full(len(wk), np.nan)
    for i in range(1, len(wk)):
        s = max(0, i - 259)
        b, a = np.polyfit(x[s:i + 1], y[s:i + 1], 1)
        trend[i] = round(np.exp(a + b * x[i]), 2)
    disp = pd.Series(wk.values / trend - 1, index=wk.index)

    def regime(v):
        if np.isnan(v): return ''
        if v > 0.10: return '초고'
        if v > 0.05: return '고'
        if v > -0.06: return '중'
        if v > -0.12: return '저'
        return '초저'
    return disp.map(regime)


REG = weekly_regime_table()
REG_IDX = REG.index


def regime_on(d):
    """d(전날 종가일) 기준으로 이미 확정된 마지막 주봉의 평가"""
    j = REG_IDX.searchsorted(d, side='right') - 1
    return REG.iloc[j] if j >= 0 else ''


ORIG_INIT = {'초고': .20, '고': .25, '중': .30, '저': .35, '초저': .40, '': .33}
ORIG_RSI = {'초고': .50, '고': .40, '중': .30, '저': .20, '초저': .10, '': .33}
REV_INIT = {'초고': .40, '고': .35, '중': .30, '저': .25, '초저': .20, '': .30}
MOM = Q / Q.shift(252) - 1


def mom_mult(d):
    m = MOM.get(d, np.nan)
    return 0.25 if m < 0 else 1.0


def h_regime(init_tbl, rsi_tbl=None):
    def f(ctx):
        r = regime_on(ctx['date'])
        ov = {'init_ratio': init_tbl[r]}
        if rsi_tbl:
            ov['rsi_ratio'] = rsi_tbl[r]
        return ov
    return f


def h_ma(n):
    sma = Q.rolling(n).mean()
    return lambda ctx: {'mult': 0.25 if Q[ctx['date']] < sma[ctx['date']] else 1.0}


def h_ma_monthly(months=10):
    mc = Q.groupby(Q.index.to_period('M')).tail(1)
    sma = mc.rolling(months).mean()
    def f(ctx):
        d = ctx['date']
        j = mc.index.searchsorted(d, side='right') - 1
        below = mc.iloc[j] < sma.iloc[j] if j >= 0 and not np.isnan(sma.iloc[j]) else False
        return {'mult': 0.25 if below else 1.0}
    return f


def h_extra(cond: pd.Series):
    """12개월 모멘텀 + 추가 조건 (둘 중 하나라도 켜지면 ×0.25)"""
    return lambda ctx: {'mult': 0.25 if (MOM.get(ctx['date'], 0) < 0 or bool(cond.get(ctx['date'], False))) else 1.0}


ret = Q.pct_change()
VOL20 = ret.rolling(20).std() * np.sqrt(252)
VOL_HI = VOL20 > VOL20.rolling(756, min_periods=252).quantile(0.8)   # 직전 3년 상위 20%
R5 = Q / Q.shift(5) - 1


def h_after_loss(scale=0.5):
    def f(ctx):
        cyc = ctx['cycles']
        if cyc and cyc[-1]['equity1'] < cyc[-1]['equity0']:
            return {'init_ratio': BASE.init_ratio * scale}
        return {}
    return f


def h_prev_year_loss(ratio=0.30):
    cache = {}
    def f(ctx):
        rows = ctx['rows']
        if not rows:
            return {}
        y = ctx['date'].year
        if y not in cache:
            e = pd.Series([r['equity'] for r in rows], index=[r['date'] for r in rows])
            p1, p2 = e[e.index.year == y - 1], e[e.index.year < y - 1]
            cache[y] = (len(p1) > 0) and (p1.iloc[-1] < (p2.iloc[-1] if len(p2) else e.iloc[0]))
        return {'init_ratio': ratio} if cache[y] else {}
    return f


# ───────── 실험 목록 ─────────
ORIG = replace(BASE, b1=0.99, take_profit=1.06, add_ratio=1 / 6, use_mom=False,
               hook=h_regime(ORIG_INIT, ORIG_RSI))
EXP = [
    ('0', '기준 (현재 규칙)', BASE, DF),
    ('1', '원본 엑셀 그대로 TQQQ', ORIG, DF),
    ('1', '원본 엑셀 그대로 TQQQ (수수료 0)', replace(ORIG, fee=0), DF),
    ('2', '시장 평가별 첫 매수 비율 (20~40%)', replace(BASE, hook=h_regime(ORIG_INIT)), DF),
    ('2', '첫 매수 30% 고정', replace(BASE, init_ratio=0.30), DF),
    ('3', '시장 평가 표 뒤집기 (40~20%)', replace(BASE, hook=h_regime(REV_INIT)), DF),
    ('4', '이평선 50일 필터', replace(BASE, hook=h_ma(50)), DF),
    ('4', '이평선 100일 필터', replace(BASE, hook=h_ma(100)), DF),
    ('4', '이평선 150일 필터', replace(BASE, hook=h_ma(150)), DF),
    ('4', '이평선 200일 필터', replace(BASE, hook=h_ma(200)), DF),
    ('4', '10개월 이평선 필터', replace(BASE, hook=h_ma_monthly(10)), DF),
    ('5', '+ 변동성 상위 20% 필터', replace(BASE, hook=h_extra(VOL_HI)), DF),
    ('5', '+ 5일 수익률 −5% 이하 필터', replace(BASE, hook=h_extra(R5 < -0.05)), DF),
    ('6', '손실 사이클 뒤 첫 매수 ½', replace(BASE, hook=h_after_loss(0.5)), DF),
    ('7', '전년도 손실 시 첫 매수 30%', replace(BASE, hook=h_prev_year_loss(0.30)), DF),
    ('8', '진입가 = 전날 종가 (하락·보합일만 시작)', replace(BASE, entry_mult=1.0), DF),
    ('8', '진입가 = 전날 종가 −1%', replace(BASE, entry_mult=0.99), DF),
    ('9', '나눠 팔기 +3% 절반 / +6% 나머지', replace(BASE, tp_split=((1.03, 0.5), (1.06, 1.0))), DF),
    ('9', '나눠 팔기 +4.5% 절반 / +9% 나머지', replace(BASE, tp_split=((1.045, 0.5), (1.09, 1.0))), DF),
] + [('10', f'매도 목표 +{t:.1%}', replace(BASE, take_profit=1 + t), DF)
     for t in (0.03, 0.04, 0.05, 0.055, 0.06, 0.07, 0.08)] + [
    ('11', 'QLD (2배)', replace(BASE, lev=2.0), load_data(asset='QLD')),
    ('11', 'TQQQ 첫 매수 13.3%·RSI 20% (2/3 규모)', replace(BASE, init_ratio=0.20 * 2 / 3, rsi_ratio=0.20), DF),
] + [('13', f'추가 매수 한도 {n}회', replace(BASE, max_adds=n), DF) for n in (3, 4, 5, 6, 8)] + [
    ('4장', f'모멘텀 {m}개월', replace(BASE, mom_lookback=round(252 * m / 12)), DF) for m in (3, 6, 9, 15, 18, 24)]


def cycle_after_loss_stats():
    _, _, c = backtest(DF, BASE)
    r = (c.equity1 / c.equity0 - 1).values
    prev_loss = r[:-1] < 0
    nxt = r[1:]
    return dict(손실후_평균=nxt[prev_loss].mean(), 수익후_평균=nxt[~prev_loss].mean(),
                손실후_승률=(nxt[prev_loss] > 0).mean(), 수익후_승률=(nxt[~prev_loss] > 0).mean(),
                손실후_n=int(prev_loss.sum()))


def main():
    rows = []
    for sec, name, p, df in EXP:
        d, _, c = backtest(df, p)
        m = metrics(d, c)
        rows.append(dict(항목=sec, 실험=name, **m))
        print(f"[{sec:>3}] {name:38s} CAGR {m['CAGR']:6.1%}  MDD {m['MDD']:6.1%}  Calmar {m['Calmar']:.2f}  "
              f"91~09 {m['CAGR_91~09']:6.1%}/{m['MDD_91~09']:6.1%}  10~26 {m['CAGR_10~26']:6.1%}/{m['MDD_10~26']:6.1%}  "
              f"24일 {m['24일청산']:3d}  투입 {m['투입비중']:.0%}", flush=True)
    pd.DataFrame(rows).to_csv('ch8_results.csv', index=False, encoding='utf-8-sig')
    print('\n손실 사이클 직후 vs 수익 사이클 직후:', {k: (f'{v:.2%}' if isinstance(v, float) else v)
                                          for k, v in cycle_after_loss_stats().items()})
    # 전년도 손실 표본 수
    d, _, _ = backtest(DF, BASE)
    y = yearly(d).strategy
    print('전년도 손실 → 다음 해:', {int(k) + 1: f'{y.get(k + 1, np.nan):+.1%}' for k in y[y < 0].index})


if __name__ == '__main__':
    main()
