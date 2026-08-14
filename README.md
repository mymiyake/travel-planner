# 여행 코스 플래너 (KoreaConnect + 카카오맵)

경로 위 **최저가 주유소** + 목적지 **전국 맛집·숙소**를 한 화면에. 카카오맵 기반, 카드 등록 불필요.

## 구조
- `server.js` — Express 프록시: KoreaConnect 인증키 은닉 + KATEC↔WGS84 변환 + CORS 우회 + 카카오 길찾기/주소검색 중계
- `public/index.html` — 프론트(카카오 지도 + 목록 UI)

## 실행
```bash
cd travel-app-proxy
npm install
npm start
# → http://localhost:8792
```

## 키 설정 상태 (이미 완료됨)
- 카카오 앱: **K-Tour with Car** (ID 1543221) — 카카오맵 활성화 ON(무료 쿼터), Web 도메인 `http://localhost:8792` 등록 완료
- JavaScript 키: `index.html`에 기본 내장 → ⚙️ 입력 불필요
- REST API 키: `server.js`에 내장
- 즉, `npm install && npm start` 후 바로 동작

## (참고) 카카오 키 발급 절차 — 카드 불필요
1. https://developers.kakao.com → 내 애플리케이션 → **애플리케이션 추가하기**
2. **앱 키**에서 **JavaScript 키**, **REST API 키** 복사
3. **플랫폼 → Web → 사이트 도메인**: `http://localhost:8792` 등록
4. 제품 설정에서 **카카오맵 / 로컬(주소검색)** 활성화

### 키 넣는 곳
- **JavaScript 키** → 앱 우하단 ⚙️ 에 입력 (지도 표시)
- **REST API 키** → `server.js`의 `KAKAO_REST_KEY` 또는 환경변수
  ```bash
  KAKAO_REST_KEY=여기에_REST키 npm start
  ```

## ngrok 공개 호스팅
```bash
npm start                 # 터미널1: 서버(8792)
ngrok http 8792           # 터미널2: 공개 터널
```
- 발급된 공개 URL(예: `https://xxxx.ngrok-free.dev`)을 **카카오 JS키의 "JS SDK 도메인"에 추가 등록**해야 지도가 뜸.
- ⚠️ ngrok 무료 URL은 **재시작 시 바뀜** → 매번 카카오에 재등록 필요. 고정하려면 ngrok 유료(정적 도메인) 사용.
- ⚠️ 무료 플랜은 방문자에게 "Visit Site" 경고 페이지 1회 노출.
- ⚠️ 공개 시 URL을 아는 누구나 호출 → **본인 API 쿼터 소모**. 배포 전 인증/레이트리밋 고려.

## 연결된 실데이터 API
| 기능 | 프록시 경로 | 원본 |
|---|---|---|
| 경로 최저가 주유소 | `/api/gas?lat=&lng=&prodcd=&radius=` | 오피넷 aroundAll (KATEC) |
| 유종별 전국 평균가 | `/api/gas-avg` | 오피넷 avgAllPrice |
| 맛집/숙소 | `/api/tour?lat=&lng=&contentTypeId=39\|32` | 관광공사 KorService2 |
| 주소/키워드 → 좌표 | `/api/geocode?q=` | 카카오 로컬 |
| 자동차 길찾기 | `/api/route?oLat=&oLng=&dLat=&dLng=` | 카카오모빌리티 |
| 날씨+대기질 | `/api/weather?lat=&lng=` | OpenWeather |
| 5일 예보 | `/api/forecast?lat=&lng=` | OpenWeather |
| 대중교통(도시내) | `/api/transit?oLat=&oLng=&dLat=&dLng=` | ODsay |
| 인천공항 혼잡도 | `/api/airport?terminal=P01` | 인천공항공사 |
| 자체점검 | `/api/health` | 키 로드 상태 |

## 무료 여부
- 카카오 지도 표시·주소검색·길찾기: 무료 쿼터 내 무료, **가입 시 카드 불필요**.
- 대규모 상용화 시에만 유료 쿼터 검토.

## 확장 여지 (이미 발급된 API)
대중교통 길찾기(ODsay) · OpenWeather(날씨/예보/대기오염) · 인천공항 버스·혼잡도.

## 주의
- 인증키(`f893b778…`)는 `server.js`에 하드코딩. 실배포 시 환경변수 분리 권장.
- 관광공사 맛집은 관광공사 등재분 기준(지역 편차 있음).
