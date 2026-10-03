/**
 * 전국 PC방(문화_인터넷컴퓨터게임시설제공업) 데이터 적재
 *   출처: LOCALDATA 지방행정인허가데이터 (행정안전부 표준데이터, 이용허락범위 제한 없음)
 *   https://www.data.go.kr/data/15045073/fileData.do
 *
 *   CSV(CP949, 51컬럼) → 영업중만 필터 → EPSG:5174 좌표를 WGS84로 변환 → data/pcbang.json
 *
 * 사용: node scripts/build-pcbang.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'pcbang.json');

const BASE = 'https://file.localdata.go.kr';
const PAGE = `${BASE}/file/pc_bangs/info`;
const FILE = `${BASE}/file/download/pc_bangs/info`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
// 보정계수 없는 Bessel 중부원점TM — 원본 데이터 설명에 명시된 좌표계
const TM5174 = '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs ' +
  '+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43';
const tm5174ToWgs = (x, y) => proj4(TM5174, WGS84, [x, y]);

/** 따옴표를 인식하는 최소 CSV 파서 (한 줄씩 소비) */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function download() {
  console.log('▶ LOCALDATA에서 전국 PC방 CSV 내려받는 중…');
  // 다운로드 카운트 검증 쿠키를 먼저 받아야 403이 나지 않는다
  const warm = await fetch(PAGE, { headers: { 'User-Agent': UA } });
  const cookie = (warm.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const res = await fetch(FILE, { headers: { 'User-Agent': UA, Referer: PAGE, ...(cookie ? { Cookie: cookie } : {}) } });
  if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  받음: ${(buf.length / 1048576).toFixed(1)} MB`);
  return new TextDecoder('euc-kr').decode(buf);   // 원본은 CP949 (WHATWG 라벨로는 euc-kr)
}

function build(text) {
  const rows = parseCsv(text);
  const head = rows[0].map(h => h.trim());
  const idx = name => head.indexOf(name);
  const C = {
    status: idx('영업상태명'), name: idx('사업장명'), lic: idx('인허가일자'),
    closed: idx('폐업일자'), road: idx('도로명주소'), jibun: idx('지번주소'),
    tel: idx('전화번호'), x: idx('좌표정보(X)'), y: idx('좌표정보(Y)'),
    area: idx('시설면적'), games: idx('총게임기수'), updated: idx('데이터갱신시점'),
    detail: idx('상세영업상태명'),
  };
  const missing = Object.entries(C).filter(([, v]) => v < 0).map(([k]) => k);
  if (missing.length) throw new Error(`컬럼을 못 찾음: ${missing.join(', ')} — 원본 서식이 바뀌었습니다`);

  const list = [];
  let total = 0, closed = 0, noCoord = 0, maxUpdated = '';
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < head.length - 2) continue;
    total++;
    const up = (r[C.updated] || '').trim().slice(0, 10);
    if (up > maxUpdated) maxUpdated = up;          // 전체 행 중 가장 최신 갱신시점
    const status = (r[C.status] || '').trim();
    // 인허가 데이터에는 폐업·휴업이 함께 들어 있다 → 실제 운영 중인 곳만 남긴다
    const detail = (r[C.detail] || '').trim();
    if (!status.includes('영업') || detail.includes('폐업') || detail.includes('휴업')) { closed++; continue; }
    const x = parseFloat(r[C.x]), y = parseFloat(r[C.y]);
    if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) { noCoord++; continue; }
    const [lng, lat] = tm5174ToWgs(x, y);
    if (!(lat > 32 && lat < 40 && lng > 124 && lng < 132)) { noCoord++; continue; }  // 한반도 밖 = 불량 좌표
    const name = (r[C.name] || '').trim();
    if (!name) continue;
    list.push({
      n: name,
      a: (r[C.road] || r[C.jibun] || '').trim(),
      t: (r[C.tel] || '').trim(),
      d: (r[C.lic] || '').trim().slice(0, 10),        // 인허가일자
      lat: +lat.toFixed(6), lng: +lng.toFixed(6),
      ar: parseFloat(r[C.area]) || 0,                  // 시설면적 m²
      g: parseInt(r[C.games], 10) || 0,                // 총게임기수(PC 대수)
    });
  }
  list.sort((a, b) => (b.d || '').localeCompare(a.d || ''));   // 최근 인허가순으로 미리 정렬
  const updated = maxUpdated;
  return { meta: { source: 'LOCALDATA 문화_인터넷컴퓨터게임시설제공업', built: new Date().toISOString().slice(0, 10), dataDate: updated, total, closed, noCoord, open: list.length }, list };
}

const data = build(await download());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data));
const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`✅ ${OUT}  (${mb} MB)`);
console.log(`   전체 ${data.meta.total} / 영업중 ${data.meta.open} / 폐업·휴업 ${data.meta.closed} / 좌표불량 ${data.meta.noCoord}`);
console.log(`   최근 인허가 5곳:`);
for (const p of data.list.slice(0, 5)) console.log(`   · ${p.d}  ${p.n}  (${p.a})`);
