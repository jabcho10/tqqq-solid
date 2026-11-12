"""docs/usd/data/prices.csv 에 최신 USD 종가를 이어 붙인다 (상위 폴더 TQQQ 갱신 스크립트를 USD 한 종목용으로 고침). 여러 출처를 쓰고 서로 교차 확인한다.

출처 (기본 순서, 앞이 우선)
  yahoo         여러 날   yfinance, 수정 전 종가 + 분할 정보
  nasdaq        여러 날   api.nasdaq.com 과거 시세
  alphavantage  여러 날   ALPHAVANTAGE_KEY 환경변수가 있을 때만 (무료 키)
  google        하루치    Google Finance 페이지의 마감 종가 ("Closed:" 표시가 있을 때만)
  cnbc          하루치    CNBC 시세 (장중이 아닐 때만)

규칙
- 각 출처를 기존 CSV와 겹치는 날짜로 대조해, 어긋나면 그 출처는 버린다.
- 새 날짜는 우선순위가 가장 높은 출처 값을 쓰고, 다른 출처와 0.5% 넘게 다르면 아무것도 쓰지 않고 실패한다.
- 하루치 출처(google, cnbc)만 가진 날짜는 바로 다음 평일일 때만 추가한다 (빈 날 방지).
- 분할이 생기면 이전 가격을 분할 비율로 나눠 잇는다 (yahoo 분할 정보).
- 결과와 출처는 docs/data/meta.json 에 남긴다.

python scripts/update_prices.py                  # 갱신
python scripts/update_prices.py --dry-run        # 쓰지 않고 결과만 출력
python scripts/update_prices.py --test-truncate 5   # CSV 끝 5일을 지웠다고 치고 다시 받아 실제 값과 비교 (쓰지 않음)
PRICE_SOURCES=nasdaq,google python scripts/update_prices.py   # 출처 지정
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import pandas as pd
import requests

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'usd', 'data')   # 사이트: docs/usd/
CSV = os.path.join(ROOT, 'prices.csv')
META = os.path.join(ROOT, 'meta.json')
TICKERS = {'usd': 'USD'}
GOOGLE_EXCHANGE = {'USD': 'NYSEARCA'}       # USD(ProShares Ultra Semiconductors)는 NYSE Arca 상장
DEFAULT_ORDER = ['yahoo', 'nasdaq', 'alphavantage', 'google', 'cnbc']
LATEST_ONLY = {'google', 'cnbc'}
NAMES = {'yahoo': 'Yahoo', 'nasdaq': 'Nasdaq', 'alphavantage': 'Alpha Vantage', 'google': 'Google', 'cnbc': 'CNBC'}
CROSS_TOL = 0.005                     # 출처끼리 허용 차이 (0.5%)
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9'}


def overlap_tol(price):
    """기존 값과 대조할 때 허용 차이: 0.011 (100달러 넘으면 비례)"""
    return 0.011 * max(1.0, abs(price) / 100)


# ───────── 출처별 수집 (DataFrame: index=날짜, columns=usd) ─────────
def fetch_yahoo(start):
    import yfinance as yf
    tickers = list(TICKERS.values())
    for k in range(4):
        raw = yf.download(tickers, start=start, auto_adjust=False, actions=True, progress=False, threads=False)
        if not raw.empty and all(t in raw['Close'].columns and raw['Close'][t].notna().any() for t in tickers):
            break
        time.sleep(5 * (k + 1))
    else:
        raise RuntimeError('다운로드 불완전')
    raw.index = pd.to_datetime(raw.index).tz_localize(None).normalize()
    df = pd.DataFrame({c: raw['Close'][t] for c, t in TICKERS.items()}).dropna()
    splits = {}
    for c, t in TICKERS.items():
        s = raw['Stock Splits'][t]
        splits[c] = {d: float(r) for d, r in s[s > 0].items()}
    return df, splits


def fetch_nasdaq(start):
    out = {}
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    for c, t in TICKERS.items():
        url = (f'https://api.nasdaq.com/api/quote/{t}/historical?assetclass=etf'
               f'&fromdate={start}&todate={today}&limit=100')
        r = requests.get(url, headers=dict(UA, Accept='application/json'), timeout=20)
        r.raise_for_status()
        rows = ((r.json().get('data') or {}).get('tradesTable') or {}).get('rows') or []
        if not rows:
            raise RuntimeError(f'{t} 데이터 없음')
        out[c] = pd.Series({pd.Timestamp(datetime.strptime(x['date'], '%m/%d/%Y')): float(x['close'].replace('$', '').replace(',', ''))
                            for x in rows})
    return pd.DataFrame(out).dropna().sort_index(), {}


def fetch_alphavantage(start):
    key = os.environ.get('ALPHAVANTAGE_KEY')
    if not key:
        raise RuntimeError('ALPHAVANTAGE_KEY 없음 (건너뜀)')
    out = {}
    for c, t in TICKERS.items():
        r = requests.get('https://www.alphavantage.co/query', timeout=20,
                         params={'function': 'TIME_SERIES_DAILY', 'symbol': t, 'outputsize': 'compact', 'apikey': key})
        ts = r.json().get('Time Series (Daily)')
        if not ts:
            raise RuntimeError(f'{t} 응답 이상: {str(r.json())[:120]}')
        out[c] = pd.Series({pd.Timestamp(d): float(v['4. close']) for d, v in ts.items()})
        time.sleep(1.5)
    df = pd.DataFrame(out).dropna().sort_index()
    return df[df.index >= pd.Timestamp(start)], {}


MONTHS = {m: i for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], 1)}


def fetch_google(start):
    vals, dates = {}, set()
    now = datetime.now(timezone.utc)
    for c, t in TICKERS.items():
        r = requests.get(f'https://www.google.com/finance/quote/{t}:{GOOGLE_EXCHANGE.get(t, "NASDAQ")}?hl=en', headers=UA, timeout=20)
        r.raise_for_status()
        s = r.text
        m = re.search(r'\$([\d,]+\.\d+)</span>(?:(?!\$[\d,]+\.\d+).){0,1500}?Closed:(?:&nbsp;|\s)+([A-Z][a-z]{2}) (\d{1,2}),', s, re.S)
        if not m:
            raise RuntimeError(f'{t} 마감 종가를 찾지 못함 (장중이거나 페이지 구조 변경)')
        mon, day = MONTHS[m.group(2)], int(m.group(3))
        year = now.year - (1 if mon > now.month else 0)
        d = pd.Timestamp(year, mon, day)
        vals[c] = float(m.group(1).replace(',', ''))
        dates.add(d)
    if len(dates) != 1:
        raise RuntimeError(f'종목별 날짜가 다름 {dates}')
    return pd.DataFrame([vals], index=[dates.pop()]), {}


def fetch_cnbc(start):
    r = requests.get('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol', headers=UA, timeout=20,
                     params={'symbols': '|'.join(TICKERS.values()), 'requestMethod': 'itv', 'noform': 1,
                             'partnerId': 2, 'fund': 1, 'exthrs': 1, 'output': 'json'})
    r.raise_for_status()
    q = {x['symbol']: x for x in r.json()['FormattedQuoteResult']['FormattedQuote']}
    vals, dates = {}, set()
    for c, t in TICKERS.items():
        x = q[t]
        if x.get('curmktstatus') == 'REG_MKT':
            raise RuntimeError('장중이라 종가 아님')
        vals[c] = float(str(x['last']).replace(',', ''))
        dates.add(pd.Timestamp(x['last_time'][:10]))
    if len(dates) != 1:
        raise RuntimeError(f'종목별 날짜가 다름 {dates}')
    return pd.DataFrame([vals], index=[dates.pop()]), {}


FETCHERS = {'yahoo': fetch_yahoo, 'nasdaq': fetch_nasdaq, 'alphavantage': fetch_alphavantage,
            'google': fetch_google, 'cnbc': fetch_cnbc}


# ───────── 본체 ─────────
def read_csv():
    return pd.read_csv(CSV, parse_dates=['date']).set_index('date')


def write_csv(df):
    with open(CSV, 'w', newline='\n') as f:
        f.write('date,usd\n')
        for d, r in df.iterrows():
            f.write(f'{d:%Y-%m-%d},{r.usd:.12g}\n')


def update(cur, order, log=print):
    """반환: (새 DataFrame 전체, 추가된 행 정보 list, 출처 상태 dict). 교차 확인 실패 시 RuntimeError"""
    last = cur.index.max()
    start = (last - pd.Timedelta(days=40)).strftime('%Y-%m-%d')
    got, status = {}, {}
    for name in order:
        try:
            df, splits = FETCHERS[name](start)
            got[name] = (df, splits)
            status[name] = f'ok ({len(df)}일, ~{df.index.max().date()})'
        except Exception as e:                      # noqa: BLE001  출처 하나 실패는 다음 출처로
            status[name] = f'실패: {str(e)[:140]}'
        log(f'  {NAMES[name]:14s} {status[name]}')

    # 분할 역보정 (yahoo 기준)
    cur = cur.copy()
    if 'yahoo' in got:
        for c, sp in got['yahoo'][1].items():
            for d, ratio in sp.items():
                if d > last:
                    log(f'  분할: {TICKERS[c]} {d.date()} {ratio}:1 → 이전 가격 역보정')
                    cur[c] = cur[c] / ratio

    # 기존 데이터와 대조
    valid = {}
    for name, (df, _) in got.items():
        ov = df.index.intersection(cur.index)
        bad = [(d, c, cur.at[d, c], df.at[d, c]) for d in ov for c in TICKERS
               if abs(cur.at[d, c] - df.at[d, c]) > overlap_tol(cur.at[d, c])]
        if bad:
            d, c, a, b = bad[0]
            status[name] = f'버림: 기존 값과 다름 ({d.date()} {TICKERS[c]} {a} vs {b})'
            log(f'  {NAMES[name]:14s} {status[name]}')
            continue
        if not len(ov) and name not in LATEST_ONLY:
            status[name] = '버림: 겹치는 날짜가 없어 대조 불가'
            continue
        valid[name] = df

    if not any(n not in LATEST_ONLY for n in valid) and not valid:
        raise RuntimeError('쓸 수 있는 출처가 하나도 없음')

    # 새 날짜 결정
    new_dates = sorted({d for df in valid.values() for d in df.index if d > last})
    rows, added, prev = [], [], last
    for d in new_dates:
        have = {n: valid[n].loc[d] for n in order if n in valid and d in valid[n].index}
        primary = next(iter(have))
        base = have[primary]
        for n, v in have.items():
            for c in TICKERS:
                if abs(v[c] / base[c] - 1) > CROSS_TOL:
                    raise RuntimeError(f'{d.date()} {TICKERS[c]} 출처 불일치: {NAMES[primary]} {base[c]} vs {NAMES[n]} {v[c]}')
        if primary in LATEST_ONLY and len(pd.bdate_range(prev, d)) - 1 != 1:
            log(f'  {d.date()} 건너뜀: 하루치 출처만 있고 앞에 빠진 평일이 있음')
            continue
        rows.append(pd.DataFrame([{c: round(float(base[c]), 4) for c in TICKERS}], index=[d]))
        added.append({'date': f'{d:%Y-%m-%d}', 'source': primary, 'checked': [n for n in have if n != primary]})
        prev = d
    out = pd.concat([cur] + rows) if rows else cur
    return out, added, status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--test-truncate', type=int, default=0)
    a = ap.parse_args()
    order = [s.strip() for s in os.environ.get('PRICE_SOURCES', ','.join(DEFAULT_ORDER)).split(',') if s.strip() in FETCHERS]
    cur = read_csv()
    truth = None
    if a.test_truncate:
        truth = cur.iloc[-a.test_truncate:]
        cur = cur.iloc[:-a.test_truncate]
        print(f'[테스트] CSV 끝 {a.test_truncate}일을 지우고 다시 받기 (마지막 {cur.index.max().date()})')
    print(f'출처: {", ".join(NAMES[o] for o in order)}')
    try:
        out, added, status = update(cur, order)
    except RuntimeError as e:
        print(f'실패: {e}')
        sys.exit(1)
    for r in added:
        d = pd.Timestamp(r['date'])
        chk = f" (교차 확인: {', '.join(NAMES[n] for n in r['checked'])})" if r['checked'] else ' (교차 확인 없음)'
        line = f"  + {r['date']}  USD {out.at[d, 'usd']}  ← {NAMES[r['source']]}{chk}"
        if truth is not None and d in truth.index:
            ok = all(abs(out.at[d, c] - truth.at[d, c]) <= overlap_tol(truth.at[d, c]) for c in TICKERS)
            line += f"   실제 {truth.at[d, 'usd']} {'일치' if ok else '불일치!'}"
        print(line)
    if not added:
        print(f'추가할 데이터 없음 (마지막 {cur.index.max().date()})')
    if a.dry_run or a.test_truncate:
        return
    if added:
        write_csv(out)
    meta = {}
    if os.path.exists(META):
        try:
            meta = json.load(open(META, encoding='utf-8'))
        except ValueError:
            meta = {}
    hist = (meta.get('rows') or []) + added
    meta.update({'checked_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                 'last_date': f'{out.index.max():%Y-%m-%d}', 'sources': status, 'rows': hist[-60:]})
    if added:
        meta['updated_at'] = meta['checked_at']
    with open(META, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    if not any(v.startswith('ok') for v in status.values()):
        print('모든 출처 실패')
        sys.exit(1)


if __name__ == '__main__':
    main()
