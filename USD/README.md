# USD 솔리드 백테스트

매매 규칙: [USD_솔리드_규칙서.md](USD_솔리드_규칙서.md). 상위 폴더 TQQQ 솔리드 사이트를 USD(반도체 2배)에 맞춘 것.

## 구성

| 경로 | 내용 |
|---|---|
| `../docs/usd/` | 백테스트 + 주문 계산기 페이지 (https://jabcho10.github.io/tqqq-solid/usd/). 브라우저에서 계산 |
| `../docs/usd/engine.js` | 매매 엔진 (`usd_solid.py`와 같은 로직, 결과 일치 검증함) |
| `../docs/usd/data/prices.csv` | 일별 USD 종가 (date, usd). 2007-01-31까지는 합성값 |
| `scripts/build_prices.py` | `USD_합성_일별데이터_2001-2026.xlsx`에서 prices.csv를 처음 만든다 |
| `scripts/update_prices.py` | 최신 종가를 여러 출처(Yahoo, Nasdaq, CNBC 등)로 교차 확인해 이어 붙인다 |
| `usd_solid.py` | Python 백테스트 (`python usd_solid.py --data USD_합성_일별데이터_2001-2026.xlsx --start 2002-07-22 --yearly`) |

## TQQQ 페이지와 다른 점

- 신호 지수: QQQ 대신 USD 일간 수익률 ÷ 2 를 누적한 반도체 1배 대용 지수. RSI 주문가 = USD 종가 × (1 + 2 × 등락률)
- 첫 매수 25%, 최대 매수 첫 매수 포함 8회 (7회인 날은 매수1만)
- 총 투입 상한 60%: 매수 여력 = 총자산 × 60% − 보유 평가액. 첫 매수·매수1 → 매수2 → RSI 순으로 배분
- 모멘텀 필터 없음
- 비교 대상: USD 보유, 반도체 1배 지수
- 브라우저 저장 키 앞에 `usd-`를 붙여 같은 도메인의 TQQQ 페이지 기록과 섞이지 않는다

## 로컬에서 보기

```
cd docs          # 저장소 최상위 docs
python -m http.server 8000
```
브라우저에서 http://localhost:8000/usd/ (TQQQ는 http://localhost:8000/). 페이지 위 TQQQ · USD 버튼으로 오간다.

## 시세 갱신

GitHub Actions(시세 갱신 워크플로)가 TQQQ와 함께 평일마다 갱신한다. 직접 돌리려면 저장소 최상위에서:
```
python USD/scripts/update_prices.py                   # 갱신
python USD/scripts/update_prices.py --test-truncate 5 # 끝 5일을 지웠다고 치고 다시 받아 비교 (쓰지 않음)
```
`build_prices.py`는 합성 엑셀(저장소에 올리지 않음)이 USD 폴더에 있어야 돈다.
Google Finance는 USD(NYSE Arca) 마감 종가를 찾지 못하는 경우가 있다. Yahoo·Nasdaq·CNBC로 교차 확인된다.

## 검증 (2026-11-12)

- `engine.js`와 `usd_solid.py`: 2002-07-22 / 2007-02-01 / 2010 / 2016 시작 모두 최종 자산이 1달러 단위까지 같음
- 규칙서 6장: CAGR, MDD, 사이클 895개(1.045 매도 869, 24일 MOC 26), 연도별 수익률·연중 최대 하락 일치. 2015년 수익률만 17.3%(규칙서 17.9%)
- MDD는 시작 자금에 따라 −38.4% ~ −38.7%로 조금 달라진다 (주식 수 소수점 버림 영향)
