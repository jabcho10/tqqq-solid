"""docs/usd/data/prices.csv 를 처음 만든다: 합성(2001-07 ~ 2007-01) + 실제 USD 종가.

python scripts/build_prices.py
원본: USD_합성_일별데이터_2001-2026.xlsx (시트 USD_데이터). 이후 갱신은 scripts/update_prices.py
"""
import glob
import os

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
OUT = os.path.join(ROOT, '..', 'docs', 'usd', 'data', 'prices.csv')   # 사이트: docs/usd/
SYNTH_END = '2007-01-31'


def main():
    src = [p for p in glob.glob(os.path.join(ROOT, '*.xlsx')) if '2001' in os.path.basename(p)][0]
    df = pd.read_excel(src, sheet_name='USD_데이터', usecols=['날짜', 'USD 종가']).dropna()
    df = df.rename(columns={'날짜': 'date', 'USD 종가': 'usd'}).set_index('date').sort_index()
    df = df[~df.index.duplicated()]
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('date,usd\n')
        for d, r in df.iterrows():
            f.write(f'{d:%Y-%m-%d},{r.usd:.12g}\n')
    print(f'{OUT}: {len(df)}행 {df.index[0].date()} ~ {df.index[-1].date()} (합성 ~{SYNTH_END})')


if __name__ == '__main__':
    main()
