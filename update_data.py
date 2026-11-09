"""엑셀 '260812수정' 시트에 Yahoo Finance 최신 일봉(수정 전 OHLC)을 이어 붙인다.

python update_data.py          # 마지막 날짜 다음날부터 오늘까지 추가
엑셀(COM)로 직접 쓰므로 다른 시트·차트·서식이 그대로 유지된다. 엑셀 파일은 닫아 둘 것.
"""
import os
import sys

import pandas as pd
import yfinance as yf
import win32com.client

XLSX = os.path.abspath('TQQQ-QLD-NDX-SPX_데이터_1985-2026.xlsx')
SHEET = '260812수정'
TICKERS = {'TQQQ': 'TQQQ', 'QLD': 'QLD', 'QQQ': 'QQQ', 'SPY': 'SPY', 'NDX': '^NDX', 'SPX': '^GSPC'}
FIELDS = [('종가', 'Close'), ('시가', 'Open'), ('고가', 'High'), ('저가', 'Low')]


def excel_serial(d) -> int:
    return (pd.Timestamp(d).normalize() - pd.Timestamp('1899-12-30')).days


def main():
    cur = pd.read_excel(XLSX, sheet_name=SHEET, usecols=range(25)).dropna(subset=['날짜']).set_index('날짜')
    last = cur.index.max()
    cols = list(cur.columns)                                   # B~Y 열 순서
    raw = yf.download(list(TICKERS.values()), start=(last - pd.Timedelta(days=60)).strftime('%Y-%m-%d'),
                      auto_adjust=False, actions=True, progress=False)

    # 1) 겹치는 구간 검증: 기존 값과 다르면 중단
    for k, t in TICKERS.items():
        for ko, en in FIELDS:
            a = cur[f'{k} {ko}'].loc[raw.index.min():]
            diff = (a - raw[en][t].reindex(a.index)).abs().max()
            if not diff <= 0.011:
                sys.exit(f'기존 데이터와 불일치: {k} {ko} 최대 차이 {diff}')
    # 2) 분할 발생 시 중단 (수정 전 가격을 이어 붙이면 시계열이 끊김)
    if (raw['Stock Splits'].loc[raw.index > last] != 0).any().any():
        sys.exit('새 구간에 주식 분할이 있음. 수동 확인 필요')

    new = pd.DataFrame({f'{k} {ko}': raw[en][t].round(2) for k, t in TICKERS.items() for ko, en in FIELDS})
    new = new[new.index > last].dropna()
    if new.empty:
        print('추가할 데이터 없음. 마지막 날짜', last.date())
        return
    new = new[cols]

    xl = win32com.client.DispatchEx('Excel.Application')
    xl.Visible = False
    xl.DisplayAlerts = False
    try:
        wb = xl.Workbooks.Open(XLSX)
        ws = wb.Worksheets(SHEET)
        last_row = ws.Cells(ws.Rows.Count, 1).End(-4162).Row       # xlUp
        first = last_row + 1
        n = len(new)
        # datetime을 COM으로 넘기면 시간대 변환(KST→UTC)으로 하루 밀리므로 엑셀 일련번호로 쓴다
        ws.Range(ws.Cells(first, 1), ws.Cells(first + n - 1, 1)).Value = [[excel_serial(d)] for d in new.index]
        ws.Range(ws.Cells(first, 2), ws.Cells(first + n - 1, 25)).Value = new.values.tolist()
        ws.Range(ws.Cells(last_row, 1), ws.Cells(last_row, 25)).Copy()
        ws.Range(ws.Cells(first, 1), ws.Cells(first + n - 1, 25)).PasteSpecial(-4122)  # 서식만
        xl.CutCopyMode = False
        wb.Save()
        wb.Close()
    finally:
        xl.Quit()
    print(f'{n}행 추가: {new.index[0].date()} ~ {new.index[-1].date()} (행 {first}~{first + n - 1})')


if __name__ == '__main__':
    main()
