"""docs/data/prices.csv 에 Yahoo Finance 최신 종가(TQQQ, QQQ)를 이어 붙인다.

- 엑셀 원본과 같은 '수정 전 종가(Close)'를 쓴다. 배당은 반영하지 않는다.
- 주식 분할이 있으면 그 이전 가격을 분할 비율로 나눠(역보정) 시계열을 잇는다.
- 겹치는 구간이 기존 값과 다르면 아무것도 쓰지 않고 실패한다.

python scripts/update_prices.py            # GitHub Actions에서 매일 실행
"""
import os
import sys

import pandas as pd
import yfinance as yf

CSV = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'prices.csv')
TICKERS = {'tqqq': 'TQQQ', 'qqq': 'QQQ'}
TOL = 0.011


def main():
    cur = pd.read_csv(CSV, parse_dates=['date']).set_index('date')
    last = cur.index.max()
    start = (last - pd.Timedelta(days=40)).strftime('%Y-%m-%d')
    raw = yf.download(list(TICKERS.values()), start=start, auto_adjust=False, actions=True, progress=False)
    if raw.empty:
        sys.exit('Yahoo에서 데이터를 받지 못함')
    raw.index = pd.to_datetime(raw.index).tz_localize(None).normalize()

    # 1) 분할 역보정: 분할일 이전(기존 CSV 포함) 가격을 비율로 나눈다
    for col, t in TICKERS.items():
        splits = raw['Stock Splits'][t]
        for d, ratio in splits[(splits > 0) & (splits.index > last)].items():
            print(f'{t} {d.date()} 분할 {ratio}:1 → 이전 가격 역보정')
            cur[col] = cur[col] / ratio

    # 2) 겹치는 구간 검증
    for col, t in TICKERS.items():
        a = cur[col].loc[raw.index.min():]
        b = raw['Close'][t].reindex(a.index)
        diff = (a - b).abs().max()
        if not diff <= TOL * max(1.0, a.abs().max() / 100):
            sys.exit(f'{t} 기존 데이터와 불일치 (최대 차이 {diff:.4f}). 수동 확인 필요')

    new = pd.DataFrame({col: raw['Close'][t] for col, t in TICKERS.items()})
    new = new[new.index > last].dropna().round(4)
    if new.empty:
        print(f'추가할 데이터 없음 (마지막 {last.date()})')
        return
    out = pd.concat([cur, new])
    with open(CSV, 'w', newline='\n') as f:
        f.write('date,tqqq,qqq\n')
        for d, r in out.iterrows():
            f.write(f'{d:%Y-%m-%d},{r.tqqq:.8g},{r.qqq:.8g}\n')
    print(f'{len(new)}행 추가: {new.index[0].date()} ~ {new.index[-1].date()}')


if __name__ == '__main__':
    main()
