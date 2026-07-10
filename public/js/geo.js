// geo: 장소 검색·지오코딩(카카오/OSM), 경로·대중교통 계산, 좌표/거리 유틸
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.


const geoCache = new Map();

// 카카오 category_group_code → 내부 카테고리
const KAKAO_CAT = { FD6: "restaurant", CE7: "cafe", AT4: "attraction", AD5: "hotel", MT1: "mall", CT1: "attraction", CS2: "convenience" };
const kakaoCat = (code) => KAKAO_CAT[code] || "";
function kakaoDoc(d) {
  return {
    name: d.place_name,
    addr: d.road_address_name || d.address_name || "",
    lat: parseFloat(d.y), lon: parseFloat(d.x),
    category: kakaoCat(d.category_group_code),
    phone: d.phone || "", website: d.place_url || "",
  };
}
// 카카오 키워드 검색 (services 라이브러리, 클라이언트)
function kakaoKeyword(q, near) {
  return new Promise((resolve) => {
    try {
      const ps = new window.kakao.maps.services.Places();
      const opts = {};
      if (near) {
        opts.location = new window.kakao.maps.LatLng(near.lat, near.lon);
        opts.radius = 20000; // 최대 20km
        opts.sort = window.kakao.maps.services.SortBy.DISTANCE;
      }
      ps.keywordSearch(q, (data, status) => {
        resolve(status === window.kakao.maps.services.Status.OK && Array.isArray(data) ? data.map(kakaoDoc) : []);
      }, opts);
    } catch { resolve([]); }
  });
}
async function osmSearch(q, near) {
  try {
    let u = "/api/geo/search?q=" + encodeURIComponent(q);
    if (near) u += `&lat=${near.lat}&lon=${near.lon}`;
    const data = await (await fetch(u)).json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function searchPlaces(query, bias = true) {
  const q = query.trim();
  if (q.length < 2) return [];
  // bias=true면 목적지 주변으로 검색 범위를 제한 (지역 밖 엉뚱한 결과 방지)
  const near = bias ? tripCenterSync() : null;
  const cacheKey = near ? `${q}@${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : q;
  if (geoCache.has(cacheKey)) return geoCache.get(cacheKey);
  let results = [];
  // 국내(또는 아직 지역 미확정)면 카카오 우선, 해외 확정이면 건너뜀
  const overseas = near ? !inKorea(near) : false;
  if (!overseas && await ensureKakao()) results = await kakaoKeyword(q, near);
  if (!results.length) results = await osmSearch(q, near); // 카카오 결과 없으면 OSM 폴백
  if (results.length) geoCache.set(cacheKey, results); // 빈 결과는 캐시 안 함(일시 실패 재시도 가능)
  return results;
}

// 카카오 주소 검색 (도로명/지번 → 좌표)
function kakaoAddress(addr) {
  return new Promise((resolve) => {
    try {
      const g = new window.kakao.maps.services.Geocoder();
      g.addressSearch(addr, (data, status) => {
        if (status === window.kakao.maps.services.Status.OK && data[0]) {
          resolve({ lat: parseFloat(data[0].y), lon: parseFloat(data[0].x), addr: data[0].address_name || addr });
        } else resolve(null);
      });
    } catch { resolve(null); }
  });
}
// 입력한 텍스트(주소/장소명)의 좌표를 찾는다. 못 찾으면 null.
async function geocodeText(text) {
  const t = text.trim();
  if (!t) return null;
  if (await ensureKakao()) { const r = await kakaoAddress(t); if (r) return r; } // 국내 주소 우선
  const hits = await searchPlaces(t, true);
  if (hits.length) return { lat: hits[0].lat, lon: hits[0].lon, addr: hits[0].addr || "" };
  return null;
}

// 목적지(지역) 중심 좌표 — 검색 편향 기준
function tripCenterSync() {
  if (!state || !state.destination) return null;
  const c = recCenterCache.get(state.destination);
  return (c && c !== "pending") ? c : null;
}
const centerAttempts = {}; // destination -> 지오코딩 시도 횟수
let centerInflight = false; // 동시/재귀 조회 방지 (렌더 루프 차단)
async function getTripCenter() {
  if (!state || !state.destination) return null;
  const dest = state.destination;
  const cached = recCenterCache.get(dest);
  if (cached && cached !== "pending") return cached; // 성공 좌표만 캐시됨
  if (centerInflight) return null;                    // 이미 조회 중이면 대기
  centerInflight = true;
  try {
    try {
      const hits = await searchPlaces(dest, false); // 목적지 자체는 편향 없이 조회
      if (hits[0]) {
        const center = { lat: hits[0].lat, lon: hits[0].lon };
        recCenterCache.set(dest, center); // 성공만 캐시
        centerAttempts[dest] = 0;
        render();
        return center;
      }
    } catch {
      // 네트워크 throw 등은 실패 시도로 취급 (아래 재시도 로직으로 흘려보냄)
    }
    // 실패는 캐시하지 않음(=다음에 재시도). 일시적 실패면 잠시 뒤 최대 3회 재시도
    const n = (centerAttempts[dest] = (centerAttempts[dest] || 0) + 1);
    if (n < 4) setTimeout(getTripCenter, 1500); // 지오코딩만 재시도 (불필요한 전체 렌더 방지)
    return null;
  } finally {
    centerInflight = false;
  }
}

// 좌표가 없는 장소는 이름으로 위치를 자동 조회해서 좌표를 채운다 (이동시간 계산용)
async function ensureCoords(r) {
  if (r.lat != null && r.lon != null) return r;
  const hits = await searchPlaces(r.name);
  if (hits.length) return { name: r.name, addr: r.addr || hits[0].addr || "", lat: hits[0].lat, lon: hits[0].lon };
  return r;
}

async function routeLegs(points, profile = "driving") {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("http " + res.status);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes[0]) throw new Error(data.code || "route fail");
  return data.routes[0].legs.map((l) => ({ distance: l.distance, duration: l.duration }));
}

// 자동차/도보(OSRM) 구간 채우기.
// 공용 OSRM은 도보 프로파일도 차량 속도로 계산하므로, 도보는 실제 도로거리를 4.8km/h로 환산한다.
const WALK_MPS = 4.8 * 1000 / 3600; // ≈ 1.33 m/s
function fillRouteLegs(coordItems, legHolders, total, profile) {
  const walk = profile === "walking";
  const suffix = walk ? " (약)" : "";
  routeLegs(coordItems, "driving").then((legs) => {
    if (!total.isConnected) return; // 재렌더로 교체된 DOM이면 무시
    let sumD = 0, sumT = 0;
    legs.forEach((lg, i) => {
      const dur = walk ? lg.distance / WALK_MPS : lg.duration;
      sumD += lg.distance; sumT += dur;
      if (legHolders[i] && legHolders[i].node.isConnected) legHolders[i].node.textContent = `${fmtDist(lg.distance)} · ${fmtDur(dur)}${suffix}`;
    });
    total.textContent = `총 ${fmtDist(sumD)} · ${fmtDur(sumT)}${suffix}`;
  }).catch(() => {
    legHolders.forEach((h) => { if (h.node.isConnected) h.node.textContent = "이동 계산 실패 (잠시 후 재시도)"; });
  });
}

const dayMode = new Map();       // dayId -> "car" | "walk" | "transit"
const transitCache = new Map();  // "lat,lon>lat,lon" -> ODsay 응답
let noKeyNotified = false;

async function transitLeg(a, b) {
  const key = `${a.lat},${a.lon}>${b.lat},${b.lon}`;
  if (transitCache.has(key)) return transitCache.get(key);
  const res = await fetch(`/api/transit?sx=${a.lon}&sy=${a.lat}&ex=${b.lon}&ey=${b.lat}`);
  const data = await res.json();
  if (data.found || data.error === "no_key") transitCache.set(key, data); // 성공/키없음만 캐시 (일시 실패는 재시도)
  return data;
}

function notifyNoKey() {
  if (noKeyNotified) return;
  noKeyNotified = true;
  alert("대중교통 길찾기를 쓰려면 ODsay 무료 API 키가 필요해요.\n\n발급받은 키를 서버의 data/odsay.key 파일에 붙여넣거나,\n환경변수 ODSAY_API_KEY 로 설정하세요. (재시작 없이 적용)");
}

// 대중교통 모드: 연속 좌표 구간마다 ODsay 결과로 leg 채우기 (+ 요금 경비 추가 버튼)
async function fillTransitLegs(day, coordItems, legHolders, total) {
  let sumT = 0, sumPay = 0, allFound = true, noKey = false;
  for (let i = 0; i < legHolders.length; i++) {
    if (legHolders[i]) legHolders[i].node.textContent = "· · · 대중교통 계산 중 · · ·";
  }
  for (let i = 0; i < legHolders.length; i++) {
    if (!total.isConnected) return; // 재렌더로 교체된 DOM이면 중단(불필요한 API 호출도 멈춤)
    const node = legHolders[i] && legHolders[i].node;
    let t;
    try { t = await transitLeg(coordItems[i], coordItems[i + 1]); }
    catch { if (node) node.textContent = "대중교통 계산 실패"; allFound = false; continue; }
    if (t.error === "no_key") { noKey = true; if (node) node.textContent = "ODsay 키 설정 필요"; allFound = false; continue; }
    if (!t.found) { if (node) node.textContent = "대중교통 경로 없음"; allFound = false; continue; }
    const parts = [`${t.mode} ${fmtDur(t.totalTime * 60)}`];
    if (t.transfers) parts.push(`환승 ${t.transfers}회`);
    parts.push(t.payment ? `${t.payment.toLocaleString("ko-KR")}원` : "요금 미제공");
    const from = coordItems[i], to = coordItems[i + 1];
    if (node) {
      node.textContent = "";
      node.append(
        el("span", { class: "leg-text" }, parts.join(" · ")),
        el("button", { class: "leg-add-btn", title: "이 구간 교통비를 경비정산에 추가",
          onclick: (e) => addTransitFare(day, from, to, t, e.target) }, "경비 추가")
      );
    }
    sumT += t.totalTime; sumPay += t.payment || 0;
  }
  if (noKey) { total.textContent = ""; notifyNoKey(); return; }
  total.textContent = allFound ? `총 ${fmtDur(sumT * 60)}` + (sumPay ? ` · ${sumPay.toLocaleString("ko-KR")}원` : "") : "";
}

// 교통 요금을 경비정산에 추가 (요금 미제공=기차 등이면 직접 입력받아 보강)
function addTransitFare(day, from, to, t, btn) {
  let amount = t.payment || 0;
  if (!amount) {
    const v = prompt(`${t.mode} 요금을 입력하세요 (원)\n${from.place} → ${to.place}`, "");
    if (v == null) return;
    amount = parseInt(String(v).replace(/[^0-9]/g, ""), 10) || 0;
    if (!amount) return;
  }
  const desc = `${fmtDate(day.date)} ${t.mode} (${from.place || "출발"}→${to.place || "도착"})`;
  send("addExpense", { desc, amount, payer: me, sharedBy: (state.members || []).slice() });
  toast(`경비 추가됨 · ${amount.toLocaleString("ko-KR")}원`);
}

function toast(msg) {
  let wrap = $("#toastWrap");
  if (!wrap) { wrap = el("div", { class: "toast-wrap", id: "toastWrap" }); document.body.append(wrap); }
  const t = el("div", { class: "toast" }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), 2200);
}
// 되돌리기 버튼이 있는 토스트 (삭제 취소 등)
function undoToast(msg, onUndo) {
  let wrap = $("#toastWrap");
  if (!wrap) { wrap = el("div", { class: "toast-wrap", id: "toastWrap" }); document.body.append(wrap); }
  let done = false;
  const t = el("div", { class: "toast" }, msg,
    el("button", { class: "toast-undo", onclick: () => { if (done) return; done = true; t.remove(); onUndo(); } }, "실행취소"));
  wrap.append(t);
  setTimeout(() => t.remove(), 5000);
}

async function optimizeOrder(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/trip/v1/driving/${coords}?source=first&roundtrip=false&overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("http " + res.status);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error(data.code || "trip fail");
  return data.waypoints.map((w) => w.waypoint_index);
}

const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + "km" : Math.round(m) + "m");
const fmtDur = (s) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};

function haversineKm(a, b) {
  const R = 6371;
  const toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function nearestNeighborPath(items) {
  if (items.length <= 2) return items.slice();
  const rem = items.slice();
  const path = [rem.shift()];
  while (rem.length) {
    const last = path[path.length - 1];
    let bi = 0, bd = Infinity;
    rem.forEach((r, i) => {
      const d = haversineKm(last, r);
      if (d < bd) { bd = d; bi = i; }
    });
    path.push(rem.splice(bi, 1)[0]);
  }
  return path;
}

function splitBalanced(arr, k) {
  const chunks = Array.from({ length: k }, () => []);
  if (!arr.length || k <= 0) return chunks;
  const base = Math.floor(arr.length / k);
  const rem = arr.length % k;
  let idx = 0;
  for (let d = 0; d < k; d++) {
    const size = base + (d < rem ? 1 : 0);
    for (let s = 0; s < size; s++) if (idx < arr.length) chunks[d].push(arr[idx++]);
  }
  return chunks;
}

function slotTime(i) {
  const total = Math.min(10 * 60 + i * 120, 22 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

