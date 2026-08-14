// KoreaConnect 여행 웹앱 프록시 서버
// - api_user_key_id 헤더 은닉
// - WGS84 <-> KATEC(TM128) 좌표 변환 (오피넷용)
// - CORS 우회 (서버 사이드 호출)
import 'dotenv/config';
import express from 'express';
import proj4 from 'proj4';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8792;

// === 키는 .env(로컬) 또는 환경변수로 주입 — 저장소에 커밋하지 않음 ===
const API_KEY = process.env.KC_API_KEY || '';            // KoreaConnect 공통 인증키
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || ''; // 카카오 REST(길찾기)

// === 엔드포인트 (나의 신청 이력에서 회수) ===
const EP = {
  gasAround: 'https://api.koreaconnect.kr/01/1/2603111016116012457OPINET/LOGIS/api/aroundAll.do',
  gasAvg:    'https://api.koreaconnect.kr/01/1/2603111016116012457OPINET/FISCAL/api/avgAllPrice.do',
  tour:      'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/CULTR/B551011/KorService2/locationBasedList2',
};

// === 좌표계: KATEC(오피넷 TM128) <-> WGS84 ===
const KATEC = '+proj=tmerc +lat_0=38 +lon_0=128 +ellps=bessel +units=m +x_0=400000 +y_0=600000 +k=0.9999 ' +
  '+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43';
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const toKatec = (lng, lat) => proj4(WGS84, KATEC, [lng, lat]);   // [x, y]
const toWgs   = (x, y) => proj4(KATEC, WGS84, [x, y]);           // [lng, lat]

function kcHeaders() { return { 'api_user_key_id': API_KEY, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }; }

// --- 반경 내 최저가 주유소 (위경도 입력 -> KATEC 변환 -> 오피넷) ---
app.get('/api/gas', async (req, res) => {
  try {
    const { lat, lng, radius = 3000, prodcd = 'B027', sort = 1 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    const [x, y] = toKatec(+lng, +lat);
    const url = `${EP.gasAround}?out=json&x=${x}&y=${y}&radius=${Math.min(+radius, 5000)}&prodcd=${prodcd}&sort=${sort}`;
    const r = await fetch(url, { headers: kcHeaders() });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { return res.status(502).json({ error: '오피넷 비정상 응답', raw: text.slice(0, 400) }); }
    const oil = j?.RESULT?.OIL || [];
    // KATEC 좌표를 위경도로 되돌려 지도에 표시 가능하게
    const list = oil.map(o => {
      let plng = null, plat = null;
      if (o.GIS_X_COOR && o.GIS_Y_COOR) { const w = toWgs(+o.GIS_X_COOR, +o.GIS_Y_COOR); plng = w[0]; plat = w[1]; }
      return { id: o.UNI_ID, name: o.OS_NM, brand: o.POLL_DIV_CD, price: +o.PRICE, distance: +o.DISTANCE, lat: plat, lng: plng };
    });
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 전국 평균가격 ---
app.get('/api/gas-avg', async (req, res) => {
  try {
    const r = await fetch(`${EP.gasAvg}?out=json`, { headers: kcHeaders() });
    const j = await r.json();
    res.json({ list: (j?.RESULT?.OIL || []).map(o => ({ prodcd: o.PRODCD, name: o.PRODNM, price: +o.PRICE, diff: o.DIFF })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 위치기반 관광정보 (맛집=39, 숙소=32) ---
app.get('/api/tour', async (req, res) => {
  try {
    const { lat, lng, radius = 10000, contentTypeId = 39, rows = 15 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    const qs = new URLSearchParams({
      numOfRows: rows, pageNo: 1, MobileOS: 'ETC', MobileApp: 'coursePlanner',
      _type: 'json', arrange: 'E', mapX: lng, mapY: lat, radius, contentTypeId,
    });
    const r = await fetch(`${EP.tour}?${qs}`, { headers: kcHeaders() });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { return res.status(502).json({ error: '관광공사 비정상 응답', raw: text.slice(0, 400) }); }
    let items = j?.response?.body?.items?.item || [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    res.json({
      count: items.length,
      list: items.map(i => ({ name: i.title, addr: [i.addr1, i.addr2].filter(Boolean).join(' '), tel: i.tel, img: i.firstimage, lat: +i.mapy, lng: +i.mapx, id: i.contentid })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 카카오: 주소/키워드 → 좌표 ---
app.get('/api/geocode', async (req, res) => {
  try {
    if (!KAKAO_REST_KEY) return res.status(400).json({ error: 'KAKAO_REST_KEY 미설정' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q 필요' });
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=1`,
      { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } });
    const j = await r.json();
    const d = j?.documents?.[0];
    if (!d) return res.status(404).json({ error: '검색 결과 없음' });
    res.json({ name: d.place_name || q, addr: d.road_address_name || d.address_name, lat: +d.y, lng: +d.x });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 카카오모빌리티: 자동차 길찾기 (경로 좌표 + 요약) ---
app.get('/api/route', async (req, res) => {
  try {
    if (!KAKAO_REST_KEY) return res.status(400).json({ error: 'KAKAO_REST_KEY 미설정' });
    const { oLat, oLng, dLat, dLng } = req.query;
    if (!oLat || !dLat) return res.status(400).json({ error: 'oLat,oLng,dLat,dLng 필요' });
    const url = `https://apis-navi.kakaomobility.com/v1/directions?origin=${oLng},${oLat}&destination=${dLng},${dLat}&priority=RECOMMEND`;
    const r = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } });
    const j = await r.json();
    const route = j?.routes?.[0];
    if (!route || route.result_code !== 0) return res.status(502).json({ error: '경로 실패', detail: route?.result_msg || j });
    // 경로 좌표 추출 (sections>roads>vertexes: [lng,lat,lng,lat,...])
    const path = [];
    (route.sections || []).forEach(sec => (sec.roads || []).forEach(rd => {
      const v = rd.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) path.push({ lng: v[i], lat: v[i + 1] });
    }));
    res.json({
      distance: route.summary.distance,   // m
      duration: route.summary.duration,   // s
      path,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === 추가 위젯 엔드포인트 (기존 발급 API 활용) ===
const EP2 = {
  weather:  'https://api.koreaconnect.kr/01/1/2603111007183154866OWT/ENVIRO/data/2.5/weather',
  forecast: 'https://api.koreaconnect.kr/01/1/2603111007183154866OWT/ENVIRO/data/2.5/forecast',
  air:      'https://api.koreaconnect.kr/01/1/2603111007183154866OWT/ENVIRO/data/2.5/air_pollution',
  transit:  'https://api.koreaconnect.kr/01/1/2604071749001710344ODS/LOGIS/v1/api/searchPubTransPathT',
  airport:  'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/LOGIS/B551177/statusOfDepartureCongestion/getDepartureCongestion',
  airportBus: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/LOGIS/B551177/BusInformation/getBusInfo',
};
const AQI_TXT = { 1: '좋음', 2: '보통', 3: '나쁨', 4: '매우나쁨', 5: '최악' };

// --- 날씨: 현재 + 대기질 ---
app.get('/api/weather', async (req, res) => {
  try {
    const { lat, lng, lang = 'kr' } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    const [wr, ar] = await Promise.all([
      fetch(`${EP2.weather}?lat=${lat}&lon=${lng}&units=metric&lang=${lang}`, { headers: kcHeaders() }).then(r => r.json()),
      fetch(`${EP2.air}?lat=${lat}&lon=${lng}`, { headers: kcHeaders() }).then(r => r.json()),
    ]);
    const air = ar?.list?.[0];
    res.json({
      city: wr.name, temp: wr.main?.temp, feels: wr.main?.feels_like, humidity: wr.main?.humidity,
      desc: wr.weather?.[0]?.description, icon: wr.weather?.[0]?.icon, wind: wr.wind?.speed,
      aqi: air?.main?.aqi, aqiText: AQI_TXT[air?.main?.aqi] || '-', pm10: air?.components?.pm10, pm25: air?.components?.pm2_5,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 예보: 5일/3시간 (앞으로 8개 슬롯만) ---
app.get('/api/forecast', async (req, res) => {
  try {
    const { lat, lng, lang = 'kr' } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    const j = await fetch(`${EP2.forecast}?lat=${lat}&lon=${lng}&units=metric&lang=${lang}`, { headers: kcHeaders() }).then(r => r.json());
    const list = (j?.list || []).slice(0, 8).map(x => ({
      time: x.dt_txt, temp: x.main?.temp, desc: x.weather?.[0]?.description, icon: x.weather?.[0]?.icon, pop: x.pop,
    }));
    res.json({ city: j?.city?.name, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 대중교통 (ODsay): 출발→도착 추천경로 ---
app.get('/api/transit', async (req, res) => {
  try {
    const { oLat, oLng, dLat, dLng } = req.query;
    if (!oLat || !dLat) return res.status(400).json({ error: 'oLat,oLng,dLat,dLng 필요' });
    const url = `${EP2.transit}?SX=${oLng}&SY=${oLat}&EX=${dLng}&EY=${dLat}&OPT=0`;
    const j = await fetch(url, { headers: kcHeaders() }).then(r => r.json());
    const paths = (j?.result?.path || []).slice(0, 3).map(p => ({
      type: ({ 1: '지하철', 2: '버스', 3: '버스+지하철' })[p.pathType] || '복합',
      totalTime: p.info?.totalTime, payment: p.info?.payment,
      transfers: (p.info?.busTransitCount || 0) + (p.info?.subwayTransitCount || 0),
      walk: p.info?.totalWalk, start: p.info?.firstStartStation, end: p.info?.lastEndStation,
      distance: p.info?.totalDistance,
    }));
    if (!paths.length) return res.status(502).json({ error: j?.result?.msgList || '대중교통 경로 없음(도시간 등)', raw: j?.error });
    res.json({ paths });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 인천공항 출국장 혼잡도 (XML → JSON) ---
app.get('/api/airport', async (req, res) => {
  try {
    const terminal = req.query.terminal || 'P01';
    const xml = await fetch(`${EP2.airport}?pageNo=1&numOfRows=30&terminalId=${terminal}`, { headers: kcHeaders() }).then(r => r.text());
    const items = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const g = (t) => (block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [, ''])[1].trim();
      items.push({ gate: g('gateId'), waitTime: +g('waitTime') || 0, waitLength: g('waitLength'), operating: g('operatingTime'), time: g('occurtime') });
    }
    const valid = items.filter(i => i.gate);
    const avg = valid.length ? Math.round(valid.reduce((s, i) => s + i.waitTime, 0) / valid.length) : 0;
    res.json({ terminal, avgWait: avg, gates: valid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 인천공항 리무진 버스 정보 (지역별) ---
app.get('/api/airport-bus', async (req, res) => {
  try {
    const area = req.query.area || '1'; // 1서울 2경기 3인천 4강원 5충청 6경상 7전라
    const j = await fetch(`${EP2.airportBus}?numOfRows=8&pageNo=1&area=${area}&type=json`, { headers: kcHeaders() }).then(r => r.json());
    const items = j?.response?.body?.items || [];
    const arr = (Array.isArray(items) ? items : items.item || []);
    res.json({
      area, total: j?.response?.body?.totalCount,
      buses: arr.map(b => ({
        no: b.busnumber, fare: +b.adultfare || 0, cls: b.busclass, company: b.cpname,
        firstToAirport: b.toawfirst, lastToAirport: b.toawlast,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 전국 공항 혼잡도 (한국공항공사 v1: 김포·제주 등, v2: 김해·청주·대구 등) ---
const KAC_BASE = 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/LOGIS/B551178/airport-congestion';
const IATA = { GMP: '김포', CJU: '제주', PUS: '김해', TAE: '대구', CJJ: '청주', KWJ: '광주', USN: '울산', RSU: '여수', KUV: '군산', WJU: '원주', HIN: '사천', KPO: '포항', MWX: '무안', YNY: '양양' };
const kacLvl = (v) => { const n = +v || 0; return n >= 3 ? { level: '혼잡', color: '#ef4444' } : n >= 2 ? { level: '보통', color: '#f59e0b' } : { level: '원활', color: '#22c55e' }; };
app.get('/api/airport-all', async (req, res) => {
  try {
    const fetchV = async (v) => { try { return pickItems(await fetchJsonRetry(`${KAC_BASE}/${v}?pageNo=1&numOfRows=20&type=json`)); } catch { return []; } };
    const [a1, a2] = await Promise.all([fetchV('v1'), fetchV('v2')]);
    const seen = {}, airports = [];
    [...a1, ...a2].forEach(a => {
      const code = a.IATA_APCD; if (!code || seen[code]) return; seen[code] = 1;
      airports.push({ name: (IATA[code] || code) + '공항', hr: a.PRC_HR, ...kacLvl(a.CGDR_ALL_LVL) });
    });
    res.json({ airports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ⛽ 충전 배치 (전기차·수소·LPG) =====
const CHG = {
  ev:  'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/ENVIRO/B552584/EvCharger/getChargerInfo',
  h2:  'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/ENVIRO/B552532/h2nbiz_3/currentInfo',
  lpg: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/ENVIRO/B410019/kgsapi/lpg_station',
};
const haversine = (aLat, aLng, bLat, bLng) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
const pickItems = (j) => {
  let it = j?.response?.body?.items?.item ?? j?.response?.body?.items
    ?? j?.body?.items?.item ?? j?.body?.items
    ?? j?.items?.item ?? j?.items ?? [];
  return Array.isArray(it) ? it : (it ? [it] : []);
};
// 전기차 충전소 (위치기반 최근접)
app.get('/api/ev', async (req, res) => {
  try {
    const { lat, lng, zcode = '', radius = 5000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    const j = await fetch(`${CHG.ev}?pageNo=1&numOfRows=1000&dataType=JSON${zcode ? `&zcode=${zcode}` : ''}`, { headers: kcHeaders() }).then(r => r.json());
    const uniq = {};
    pickItems(j).forEach(c => { const id = c.statId || c.statNm; if (c.lat && c.lng && !uniq[id]) uniq[id] = c; });
    const list = Object.values(uniq).map(c => ({
      name: c.statNm, addr: c.addr, lat: +c.lat, lng: +c.lng, useTime: c.useTime,
      dist: Math.round(haversine(+lat, +lng, +c.lat, +c.lng)),
    })).filter(c => c.dist <= +radius * 4).sort((a, b) => a.dist - b.dist).slice(0, 15);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 수소충전소 실시간 (전국, 대기·혼잡)
const H2CODE = { 0: '정보없음', 1: '여유', 2: '보통', 3: '혼잡' };
app.get('/api/h2', async (req, res) => {
  try {
    const j = await fetch(`${CHG.h2}?pageNo=1&numOfRows=300`, { headers: kcHeaders() }).then(r => r.json());
    const list = pickItems(j).map(s => ({
      name: s.chrstn_nm, wait: +s.wait_vhcle_alge || 0,
      oper: s.oper_sttus_nm || '-', status: s.cnf_sttus_nm && s.cnf_sttus_nm !== '-' ? s.cnf_sttus_nm : (s.oper_sttus_nm || '-'),
      updated: s.last_mdfcn_dt,
    })).filter(s => s.name);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// LPG 충전소 (위치기반 최근접, 캐시)
let lpgCache = null, lpgAt = 0;
app.get('/api/lpg', async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    if (!lpgCache || Date.now() - lpgAt > 3600e3) {
      const j = await fetch(`${CHG.lpg}?pageNo=1&numOfRows=3000`, { headers: kcHeaders() }).then(r => r.json());
      lpgCache = pickItems(j).filter(s => s.LAT && s.LOT); lpgAt = Date.now();
    }
    const list = lpgCache.map(s => ({
      name: s.BSES_NM, addr: s.ADDR, tel: s.TELNO, lat: +s.LAT, lng: +s.LOT,
      dist: Math.round(haversine(+lat, +lng, +s.LAT, +s.LOT)),
    })).filter(s => s.dist <= +radius * 4).sort((a, b) => a.dist - b.dist).slice(0, 15);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 다중 목적지 최적 경로 (카카오모빌리티 경유지 + 최근접 순서 최적화) =====
// stops=lat,lng,name|lat,lng,name|...   (출발지 제외, 방문할 목적지들)
app.get('/api/route-multi', async (req, res) => {
  try {
    if (!KAKAO_REST_KEY) return res.status(400).json({ error: 'KAKAO_REST_KEY 미설정' });
    const { oLat, oLng } = req.query;
    const stops = (req.query.stops || '').split('|').filter(Boolean).map(s => {
      const [lat, lng, ...n] = s.split(','); return { lat: +lat, lng: +lng, name: n.join(',') || '' };
    });
    if (!oLat || stops.length < 1) return res.status(400).json({ error: 'oLat,oLng,stops 필요' });
    // 최근접 이웃(Nearest-Neighbor)으로 방문 순서 최적화
    let cur = { lat: +oLat, lng: +oLng }, remain = stops.slice(), order = [];
    while (remain.length) {
      let bi = 0, bd = Infinity;
      remain.forEach((s, i) => { const d = haversine(cur.lat, cur.lng, s.lat, s.lng); if (d < bd) { bd = d; bi = i; } });
      order.push(remain[bi]); cur = remain[bi]; remain.splice(bi, 1);
    }
    const dest = order[order.length - 1], mids = order.slice(0, -1);
    const body = {
      origin: { x: +oLng, y: +oLat }, destination: { x: dest.lng, y: dest.lat },
      waypoints: mids.map(m => ({ x: m.lng, y: m.lat })), priority: 'RECOMMEND',
    };
    const r = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions',
      { method: 'POST', headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    const route = j?.routes?.[0];
    if (!route || route.result_code !== 0) return res.status(502).json({ error: '경로 실패', detail: route?.result_msg || j });
    const path = [];
    (route.sections || []).forEach(sec => (sec.roads || []).forEach(rd => {
      const v = rd.vertexes || []; for (let i = 0; i + 1 < v.length; i += 2) path.push({ lng: v[i], lat: v[i + 1] });
    }));
    res.json({
      distance: route.summary.distance, duration: route.summary.duration, path,
      order: order.map((o, i) => ({ seq: i + 1, name: o.name, lat: o.lat, lng: o.lng })),
      dest: { lat: dest.lat, lng: dest.lng },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 🚗 이동 배치 (교통량·휴게소·여객선) =====
const MOVE = {
  traffic:  'https://api.koreaconnect.kr/01/1/2603101731183499809HPDP/LOGIS/openapi/trafficapi/trafficAll',
  restfood: 'https://api.koreaconnect.kr/01/1/2603101731183499809HPDP/LOGIS/openapi/restinfo/restBestfoodList',
  ferry:    'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/SAFETY/B554035/ferry-route-info-v4/get-ferry-route-info-v4',
};
// 고속도로 실시간 교통량(전국 집계)
app.get('/api/traffic', async (req, res) => {
  try {
    const j = await fetchJsonRetry(`${MOVE.traffic}?type=json`);
    const rows = j?.trafficAll || [];
    const tcs = rows.filter(r => r.tcsType === '1'); // TCS 통행대수
    const total = tcs.reduce((s, r) => s + (+r.trafficAmout || 0), 0);
    res.json({ total, sumTm: rows[0]?.sumTm, sumDate: rows[0]?.sumDate, byType: tcs.slice(0, 8).map(r => ({ car: r.carType, amount: +r.trafficAmout, span: r.tmName })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// WAF 간헐 차단 대비 JSON 재시도 fetch
async function fetchJsonRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const t = await fetch(url, { headers: kcHeaders() }).then(r => r.text()); return JSON.parse(t); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 400)); }
  }
}
// 고속도로 휴게소 추천 메뉴
app.get('/api/restarea', async (req, res) => {
  try {
    const routeNm = req.query.route || '';
    const j = await fetchJsonRetry(`${MOVE.restfood}?type=json&numOfRows=40${routeNm ? `&routeNm=${encodeURIComponent(routeNm)}` : ''}`);
    const list = (j?.list || []).map(f => ({
      rest: f.stdRestNm, route: f.routeNm, addr: f.svarAddr, food: f.foodNm, cost: +f.foodCost || 0,
      desc: (f.etc || '').slice(0, 40), best: f.bestfoodyn === 'Y' || f.recommendyn === 'Y',
    }));
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 여객선 운항상태 (필수 파라미터 필요 — 조사 후 연결 예정)
app.get('/api/ferry', async (req, res) => {
  try {
    const qs = new URLSearchParams({ type: 'json', numOfRows: '30', pageNo: '1', ...req.query });
    const j = await fetch(`${MOVE.ferry}?${qs}`, { headers: kcHeaders() }).then(r => r.json());
    if (j?.response?.header && j.response.header.resultCode !== '00')
      return res.json({ error: j.response.header.resultMsg, list: [] });
    const items = pickItems(j);
    res.json({ count: items.length, list: items.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 기상특보 현황 (전국)
app.get('/api/wxalert', async (req, res) => {
  try {
    const j = await fetchJsonRetry(`https://api.koreaconnect.kr/01/1/2603101713597416530PDP/ENVIRO/1360000/WthrWrnInfoService/getPwnStatus?pageNo=1&numOfRows=10&dataType=JSON`);
    const items = pickItems(j);
    const alerts = [];
    items.forEach(it => Object.entries(it).forEach(([k, v]) => {
      if (typeof v === 'string' && /(주의보|경보)/.test(v) && !/없음/.test(v)) {
        const m = v.match(/([가-힣]+(주의보|경보))\s*:\s*(.+)/s);
        if (m) alerts.push({ type: m[1], area: m[3].replace(/\r?\n/g, ' ').trim().slice(0, 80) });
      }
    }));
    res.json({ count: alerts.length, alerts: alerts.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 🎡 볼거리 배치 (골프·낚시터·바다낚시지수·캠핑) =====
const PLAY = {
  golf: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/CULTR/1741000/golf_courses/info',
  fish: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/AGFOOD/1741000/fishing_spot_info/info',
  fishIdx: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/AGFOOD/1192136/fcstFishingv2/GetFcstFishingApiServicev2',
  camping: 'https://api.koreaconnect.kr/01/1/2603101713597416530PDP/CULTR/B551011/GoCamping/basedList',
};
// EPSG:5174 (중부원점 TM, Bessel) → WGS84
const TM5174 = '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs ' +
  '+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43';
const tm5174ToWgs = (x, y) => proj4(TM5174, WGS84, [x, y]); // [lng, lat]

// 골프장 (전국, EPSG:5174→WGS84, 최근접)
let golfCache = null, golfAt = 0;
app.get('/api/golf', async (req, res) => {
  try {
    const { lat, lng, radius = 30000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    if (!golfCache || Date.now() - golfAt > 6 * 3600e3) {
      const j = await fetchJsonRetry(`${PLAY.golf}?pageNo=1&numOfRows=800&type=json`);
      golfCache = pickItems(j).map(g => {
        if (!g.CRD_INFO_X || !g.CRD_INFO_Y) return null;
        const [wlng, wlat] = tm5174ToWgs(+g.CRD_INFO_X, +g.CRD_INFO_Y);
        return { name: g.BPLC_NM, addr: g.ROAD_NM_ADDR || g.LOTNO_ADDR, kind: g.DTIL_TPBIZ_NM, status: g.DTL_SALS_STTS_NM, lat: wlat, lng: wlng };
      }).filter(g => g && g.lat > 33 && g.lat < 39);
      golfAt = Date.now();
    }
    const list = golfCache.map(g => ({ ...g, dist: Math.round(haversine(+lat, +lng, g.lat, g.lng)) }))
      .filter(g => g.dist <= +radius).sort((a, b) => a.dist - b.dist).slice(0, 15);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 낚시터 (전국, WGS84, 최근접)
let fishCache = null, fishAt = 0;
app.get('/api/fish', async (req, res) => {
  try {
    const { lat, lng, radius = 30000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    if (!fishCache || Date.now() - fishAt > 6 * 3600e3) {
      const j = await fetchJsonRetry(`${PLAY.fish}?pageNo=1&numOfRows=1200&type=json`);
      fishCache = pickItems(j).filter(f => f.WGS84_LAT && f.WGS84_LOT)
        .map(f => ({ name: f.FSHNGSPT_NM, type: f.FSHNGSPT_TYPE, addr: f.LCTN_ROAD_NM_ADDR || f.LCTN_LOTNO_ADDR, lat: +f.WGS84_LAT, lng: +f.WGS84_LOT }));
      fishAt = Date.now();
    }
    const list = fishCache.map(f => ({ ...f, dist: Math.round(haversine(+lat, +lng, f.lat, f.lng)) }))
      .filter(f => f.dist <= +radius).sort((a, b) => a.dist - b.dist).slice(0, 15);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 캠핑장 (전국, 최근접)
let campCache = null, campAt = 0;
app.get('/api/camping', async (req, res) => {
  try {
    const { lat, lng, radius = 30000 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat,lng 필요' });
    if (!campCache || Date.now() - campAt > 6 * 3600e3) {
      const j = await fetchJsonRetry(`${PLAY.camping}?numOfRows=3200&pageNo=1&MobileOS=ETC&MobileApp=coursePlanner&_type=json`);
      campCache = pickItems(j).filter(c => c.mapX && c.mapY)
        .map(c => ({ name: c.facltNm, addr: c.addr1, tel: c.tel, img: c.firstImageUrl, intro: (c.lineIntro || '').slice(0, 40), lat: +c.mapY, lng: +c.mapX }));
      campAt = Date.now();
    }
    const list = campCache.map(c => ({ ...c, dist: Math.round(haversine(+lat, +lng, c.lat, c.lng)) }))
      .filter(c => c.dist <= +radius).sort((a, b) => a.dist - b.dist).slice(0, 15);
    res.json({ count: list.length, list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 🚻 편의·안전 배치 =====
// 응급실 실시간 가용병상 (시도/시군구)
app.get('/api/er', async (req, res) => {
  try {
    const { stage1, stage2 } = req.query;
    if (!stage1 || !stage2) return res.status(400).json({ error: 'stage1(시도),stage2(시군구) 필요' });
    const url = `https://api.koreaconnect.kr/01/1/2603101713597416530PDP/HEALTH/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire?STAGE1=${encodeURIComponent(stage1)}&STAGE2=${encodeURIComponent(stage2)}&pageNo=1&numOfRows=20`;
    let xml = '';
    for (let i = 0; i < 3; i++) { xml = await fetch(url, { headers: kcHeaders() }).then(r => r.text()); if (xml.includes('<item')) break; await new Promise(r => setTimeout(r, 400)); }
    const list = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1]; const g = t => (b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [, ''])[1].trim();
      list.push({ name: g('dutyName'), tel: g('dutyTel3'), beds: +g('hvec') || 0, total: +g('hvs01') || null });
    }
    res.json({ count: list.length, list: list.sort((a, b) => b.beds - a.beds) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 키/좌표 변환 자체 점검용
app.get('/api/health', (req, res) => {
  const [x, y] = toKatec(127.0276, 37.4979); // 강남역 근처
  res.json({ ok: true, kcKeyLoaded: !!API_KEY, kakaoRestKeyLoaded: !!KAKAO_REST_KEY, sampleKatec: { x: Math.round(x), y: Math.round(y) } });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`▶ http://localhost:${PORT}  (health: /api/health)`));
