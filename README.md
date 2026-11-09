# TQQQ 솔리드 백테스트

매매 규칙: [TQQQ_솔리드_매매규칙.md](TQQQ_솔리드_매매규칙.md)

## 구성

| 경로 | 내용 |
|---|---|
| `docs/` | GitHub Pages 사이트 (백테스트 + 주문 계산기). 브라우저에서 계산 |
| `docs/engine.js` | 매매 엔진 (solid.py 와 같은 로직, 결과 일치 검증함) |
| `docs/data/prices.csv` | 일별 종가 (date, tqqq, qqq). 2010년 이전 TQQQ는 합성 |
| `scripts/update_prices.py` | Yahoo Finance에서 최신 종가를 받아 CSV에 추가 |
| `.github/workflows/update-prices.yml` | 평일 22:30 UTC(한국 07:30)에 시세 자동 갱신 |
| `solid.py` | Python 엔진 / 백테스트 (`python solid.py --yearly`) |
| `verify_ch8.py` | 매매규칙 8장 재검증 |
| `update_data.py` | 로컬 엑셀 파일 갱신 (Windows + Excel 필요) |

원본 엑셀(`TQQQ-QLD-NDX-SPX_데이터_1985-2026.xlsx`)은 저장소에 올리지 않는다. `solid.py`, `verify_ch8.py`, `update_data.py`는 엑셀이 같은 폴더에 있어야 돌아간다. 페이지는 `docs/data/prices.csv`만 쓴다.

## GitHub Pages 배포

- 페이지: https://jabcho10.github.io/tqqq-solid/
- Pages 설정: `main` 브랜치 `/docs` 폴더
- 시세를 바로 갱신하려면 **Actions → 시세 갱신 → Run workflow**

이후 평일마다 자동으로 `docs/data/prices.csv` 가 갱신·커밋되고, Pages가 다시 배포된다.

## 로컬에서 보기

```
cd docs
python -m http.server 8000
```
브라우저에서 http://localhost:8000 (파일을 직접 열면 CSV를 읽지 못한다).

## 시세 갱신 규칙

- 엑셀 원본과 같은 수정 전 종가(Close)를 쓴다. 배당은 반영하지 않는다.
- 분할이 생기면 이전 가격을 분할 비율로 나눠 잇는다.
- 겹치는 날짜의 값이 기존과 다르면 아무것도 바꾸지 않고 워크플로가 실패한다 (Actions 탭에서 확인).
