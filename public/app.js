const socket = io();

let state = null;
let me = "";
let currentTripId = null;
const expanded = new Set();
let pendingRender = false;

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};
const won = (n) => (Number(n) || 0).toLocaleString("ko-KR") + "원";
const send = (type, payload) => socket.emit("action", { type, payload });
const saveName = (name) => localStorage.setItem("tp_name", name);

$("#nameInput").value = localStorage.getItem("tp_name") || "";

function parseTripCode(raw) {
  const s = (raw || "").trim();
  const m = s.match(/[?&]trip=([^&]+)/) || s.match(/#([A-Za-z0-9]+)$/);
  if (m) return m[1];
  return s;
}

$("#createBtn").addEventListener("click", async () => {
  const name = $("#nameInput").value.trim();
  if (!name) return showLandingError("이름을 먼저 입력해주세요.");
  saveName(name);
  const body = {
    name: $("#tripNameInput").value.trim(),
    destination: $("#destInput").value.trim(),
    startDate: $("#startInput").value,
    endDate: $("#endInput").value,
  };
  const res = await fetch("/api/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { id } = await res.json();
  enter(id, name);
});

$("#joinBtn").addEventListener("click", () => {
  const name = $("#nameInput").value.trim();
  if (!name) return showLandingError("이름을 먼저 입력해주세요.");
  const id = parseTripCode($("#joinIdInput").value);
  if (!id) return showLandingError("여행 코드나 링크를 입력해주세요.");
  saveName(name);
  enter(id, name);
});

function showLandingError(msg) {
  $("#landingError").textContent = msg;
}

const urlTrip = new URLSearchParams(location.search).get("trip");
if (urlTrip) {
  $("#joinIdInput").value = urlTrip;
  const saved = localStorage.getItem("tp_name");
  if (saved) enter(urlTrip, saved);
}

function enter(tripId, name) {
  me = name;
  currentTripId = tripId;
  socket.emit("join", { tripId, userName: name }, (resp) => {
    if (resp.error) return showLandingError(resp.error);
    saveRecent(resp.trip);
    // 여행 전환 시 이전 여행의 추천/스크롤 상태 초기화
    recState = null; nearbyCache.clear(); nearbyInflight.clear(); recCenterCache.clear();
    scrolledToday = false;
    history.replaceState(null, "", "?trip=" + tripId);
    $("#landing").classList.add("hidden");
    $("#app").classList.remove("hidden");
  });
}

// 최근 본 여행 (localStorage) — 링크 없이 재방문
function getRecent() {
  try { return JSON.parse(localStorage.getItem("tp_recent") || "[]"); } catch { return []; }
}
function saveRecent(trip) {
  if (!trip || !trip.id) return;
  const list = getRecent().filter((t) => t.id !== trip.id);
  list.unshift({ id: trip.id, name: trip.name || "우리 여행", destination: trip.destination || "",
    startDate: trip.startDate || "", endDate: trip.endDate || "" });
  localStorage.setItem("tp_recent", JSON.stringify(list.slice(0, 8)));
}
function removeRecent(id) {
  localStorage.setItem("tp_recent", JSON.stringify(getRecent().filter((t) => t.id !== id)));
  renderRecent();
}
function renderRecent() {
  const wrap = $("#recentWrap"), list = $("#recentList");
  const items = getRecent();
  if (!items.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  list.innerHTML = "";
  for (const t of items) {
    const range = t.startDate ? `${fmtDate(t.startDate)}${t.endDate ? " ~ " + fmtDate(t.endDate) : ""}` : "";
    const meta = [t.destination, range].filter(Boolean).join("  ·  ");
    list.append(el("div", { class: "recent-item" },
      el("button", { class: "recent-open", onclick: () => {
        const nm = $("#nameInput").value.trim() || localStorage.getItem("tp_name");
        if (!nm) return showLandingError("이름을 먼저 입력해주세요.");
        saveName(nm);
        enter(t.id, nm);
      } },
        el("span", { class: "recent-name" }, t.name),
        meta ? el("span", { class: "recent-meta" }, meta) : null),
      el("button", { class: "recent-x", title: "목록에서 제거", onclick: () => removeRecent(t.id) }, "✕")
    ));
  }
}
renderRecent();

socket.on("state", (trip) => {
  state = trip;
  render();
});
socket.on("presence", ({ online, people }) => {
  const ppl = people || [];
  const names = ppl.map((p) => p.name).join(", ") || `${online}명`;
  const editing = ppl.filter((p) => p.editing).map((p) => p.name);
  let txt = `● ${names}`;
  if (editing.length) txt += `  ·  ${editing.join(", ")} 편집 중`;
  $("#presence").textContent = txt;
});

// 편집 중 표시: 계획 영역 입력창에 포커스가 있으면 알림
function emitEditing(on) { if (currentTripId) socket.emit("editing", { editing: on }); }
document.addEventListener("focusin", (e) => {
  const ae = e.target;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName) && ae.closest(".content")) emitEditing(true);
});
document.addEventListener("focusout", (e) => {
  const ae = e.target;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName) && ae.closest(".content")) emitEditing(false);
});

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "plan") showMap();
  });
});

$("#tripTitle").addEventListener("change", (e) => send("renameTrip", { name: e.target.value }));

$("#shareBtn").addEventListener("click", () => {
  $("#shareLink").value = location.origin + "/?trip=" + currentTripId;
  $("#shareModal").classList.remove("hidden");
});
$("#closeShare").addEventListener("click", () => $("#shareModal").classList.add("hidden"));
$("#copyBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#shareLink").value);
    $("#copyBtn").textContent = "복사됨!";
    setTimeout(() => ($("#copyBtn").textContent = "복사"), 1500);
  } catch {
    $("#shareLink").select();
  }
});

// 확정 일정을 카톡에 붙여넣을 텍스트로 만들기
function buildPlanText() {
  const t = state;
  if (!t) return "";
  const range = t.startDate ? `${fmtDate(t.startDate)}${t.endDate ? " ~ " + fmtDate(t.endDate) : ""}` : "";
  let out = `${t.name || "우리 여행"}`;
  if (t.destination) out += `  · ${t.destination}`;
  if (range) out += `\n${range}`;
  out += "\n";
  for (const d of t.itinerary) {
    out += `\n[${fmtDate(d.date) || "날짜 미정"}]\n`;
    if (!d.items.length) { out += "· (아직 미정)\n"; continue; }
    for (const it of d.items) out += `${it.time ? it.time + "  " : ""}${it.place || "(제목 없음)"}\n`;
  }
  out += `\n공유 링크: ${location.origin}/?trip=${t.id}`;
  return out.trim();
}
$("#copyPlanBtn").addEventListener("click", async () => {
  const text = buildPlanText();
  try {
    await navigator.clipboard.writeText(text);
    toast("일정을 복사했어요 — 카톡에 붙여넣기");
  } catch {
    prompt("복사해서 공유하세요", text);
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function isEditing() {
  const ae = document.activeElement;
  if (!ae) return false;
  if (ae === $("#tripTitle")) return true;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName) && ae.closest(".content");
}

document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRender && !isEditing()) {
      pendingRender = false;
      render();
    }
  }, 0);
});

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
}
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
let scrolledToday = false;

function render() {
  if (!state) return;
  if (isEditing()) { pendingRender = true; return; }
  $("#tripTitle").value = state.name;
  const range = state.startDate ? `${fmtDate(state.startDate)} ~ ${fmtDate(state.endDate)}` : "";
  $("#tripSub").textContent = [state.destination && "📍 " + state.destination, range].filter(Boolean).join("  ·  ");
  if (state.destination) getTripCenter(); // 검색 편향용 목적지 중심 미리 확보
  renderItinerary();
  renderExpenses();
  renderPacking();
  if ($("#tab-plan").classList.contains("active")) { if (!map) showMap(); else updateMap(); }
}

const geoCache = new Map();

async function searchPlaces(query, bias = true) {
  const q = query.trim();
  if (q.length < 2) return [];
  // bias=true면 목적지 주변으로 검색 범위를 제한 (지역 밖 엉뚱한 결과 방지)
  const near = bias ? tripCenterSync() : null;
  const cacheKey = near ? `${q}@${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : q;
  if (geoCache.has(cacheKey)) return geoCache.get(cacheKey);
  try {
    let u = "/api/geo/search?q=" + encodeURIComponent(q);
    if (near) u += `&lat=${near.lat}&lon=${near.lon}`;
    const res = await fetch(u);
    const data = await res.json();
    const results = Array.isArray(data) ? data : [];
    geoCache.set(cacheKey, results);
    return results;
  } catch {
    return [];
  }
}

// 목적지(지역) 중심 좌표 — 검색 편향 기준
function tripCenterSync() {
  if (!state || !state.destination) return null;
  const c = recCenterCache.get(state.destination);
  return (c && c !== "pending") ? c : null;
}
async function getTripCenter() {
  if (!state || !state.destination) return null;
  const c = recCenterCache.get(state.destination);
  if (c && c !== "pending") return c;
  if (c === "pending") return null;
  recCenterCache.set(state.destination, "pending");
  const hits = await searchPlaces(state.destination, false); // 목적지 자체는 편향 없이 조회
  const center = hits[0] ? { lat: hits[0].lat, lon: hits[0].lon } : null;
  recCenterCache.set(state.destination, center);
  render();
  return center;
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
    let sumD = 0, sumT = 0;
    legs.forEach((lg, i) => {
      const dur = walk ? lg.distance / WALK_MPS : lg.duration;
      sumD += lg.distance; sumT += dur;
      if (legHolders[i]) legHolders[i].node.textContent = `${fmtDist(lg.distance)} · ${fmtDur(dur)}${suffix}`;
    });
    total.textContent = `총 ${fmtDist(sumD)} · ${fmtDur(sumT)}${suffix}`;
  }).catch(() => {
    legHolders.forEach((h) => (h.node.textContent = "이동 계산 실패 (잠시 후 재시도)"));
  });
}

const dayMode = new Map();       // dayId -> "car" | "walk" | "transit"
const transitCache = new Map();  // "lat,lon>lat,lon" -> ODsay 응답
const TRANSIT_ICON = { 1: "🚇", 2: "🚌", 3: "🚉", 11: "🚆", 12: "🚌", 13: "✈️" };
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
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function optimizeOrder(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/trip/v1/driving/${coords}?source=first&roundtrip=false&overview=false`;
  const res = await fetch(url);
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

/* ── 지도로 일정 짜기 ────────────────────────────── */
let map = null, mapMarkers = null, mapRoutes = null, mapCollapsed = false;
const MAP_COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];

function toggleMap() {
  mapCollapsed = !mapCollapsed;
  const c = $("#mapCanvas");
  if (c) c.style.display = mapCollapsed ? "none" : "";
  updateMap();
  if (!mapCollapsed && map) requestAnimationFrame(() => map.invalidateSize());
}

function numIcon(color, n) {
  return L.divIcon({ className: "map-pin", html: `<span class="pin-num" style="background:${color}">${n}</span>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13] });
}

function showMap() {
  const pane = $("#tab-map");
  if (!map) {
    pane.innerHTML = "";
    pane.append(
      el("div", { class: "map-toolbar", id: "mapToolbar" }),
      el("div", { class: "map-canvas", id: "mapCanvas" })
    );
    map = L.map("mapCanvas").setView([37.5665, 126.9780], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    mapMarkers = L.layerGroup().addTo(map);
    mapRoutes = L.layerGroup().addTo(map);
  }
  updateMap();
  requestAnimationFrame(() => map.invalidateSize());
}

function itemPopup(day, di, it, idx) {
  const box = el("div", { class: "map-pop" });
  box.append(el("b", {}, `${idx}. ${it.place || "(제목 없음)"}`));
  box.append(el("div", { class: "map-pop-sub" }, `${fmtDate(day.date)} ${it.time || ""}`));
  box.append(el("button", { class: "map-day-btn danger",
    onclick: () => { send("removeItem", { dayId: day.id, id: it.id }); map.closePopup(); } }, "일정에서 빼기"));
  return box;
}

function updateMap() {
  if (!map || !state) return;
  mapMarkers.clearLayers();
  mapRoutes.clearLayers();
  const bounds = [];

  // 일정 항목: 날짜별 색상·순번 핀 + 동선 경로선
  const legendDays = [];
  state.itinerary.forEach((day, di) => {
    const color = MAP_COLORS[di % MAP_COLORS.length];
    const pts = day.items.filter((it) => it.lat != null && it.lon != null);
    if (pts.length) legendDays.push({ color, label: fmtDate(day.date) || `${di + 1}일차`, count: pts.length });
    const line = [];
    pts.forEach((it, i) => {
      const ll = [it.lat, it.lon];
      bounds.push(ll); line.push(ll);
      L.marker(ll, { icon: numIcon(color, i + 1) }).bindPopup(itemPopup(day, di, it, i + 1)).addTo(mapMarkers);
    });
    if (line.length > 1) L.polyline(line, { color, weight: 3, opacity: 0.75 }).addTo(mapRoutes);
  });

  // 지역 추천 위치 핀 (추천 패널 열려 있을 때)
  if (recState) {
    const center = recCenterCache.get(state.destination);
    if (center && center !== "pending") {
      const recs = nearbyCache.get(`${center.lat.toFixed(3)},${center.lon.toFixed(3)}|${recState}`);
      if (Array.isArray(recs)) recs.slice(0, 10).forEach((r) => {
        const isFocus = focusRec && focusRec.name === r.name && Math.abs(focusRec.lat - r.lat) < 1e-6;
        L.marker([r.lat, r.lon], { icon: recIcon(isFocus) }).bindPopup(`<b>${r.name}</b><br>${catKr(r.category)}`).addTo(mapMarkers);
      });
    }
  }

  buildMapToolbar(legendDays);

  const doFocus = focusRec;
  if (doFocus) { map.setView([doFocus.lat, doFocus.lon], 16); focusRec = null; }
  else if (!mapCollapsed) {
    if (bounds.length === 1) map.setView(bounds[0], 14);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [45, 45] });
  }
}
function recIcon(focus) {
  return L.divIcon({ className: "map-pin", html: `<span class="pin-rec${focus ? " focus" : ""}"></span>`,
    iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8] });
}

function buildMapToolbar(legendDays) {
  const bar = $("#mapToolbar");
  bar.innerHTML = "";
  bar.append(el("button", { class: "tiny", onclick: toggleMap }, mapCollapsed ? "지도 보기" : "지도 접기"));
  const legend = el("div", { class: "map-legend" });
  legendDays.forEach((x) => legend.append(el("span", { class: "lg-item" },
    el("span", { class: "lg-dot", style: `background:${x.color}` }), `${x.label} (${x.count})`)));
  if (!legendDays.length) {
    legend.append(el("span", { class: "lg-empty" }, "아래 일정표에서 장소를 검색해 담으면 지도에 표시돼요."));
  }
  bar.append(legend);
}

function searchBox(placeholder, onPick) {
  const input = el("input", { type: "text", placeholder });
  const results = el("div", { class: "search-results hidden" });
  const wrap = el("div", { class: "search-box" }, input, results);
  let timer = null, lastQ = null;

  const pick = (r) => { input.value = ""; lastQ = null; results.classList.add("hidden"); onPick(r); input.blur(); };
  const doSearch = async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.classList.add("hidden"); return; }
    if (q === lastQ) return;
    lastQ = q;
    results.classList.remove("hidden");
    results.innerHTML = "";
    results.append(el("div", { class: "search-hint" }, "검색 중…"));
    const found = await searchPlaces(q);
    if (input.value.trim() !== q) return;
    results.innerHTML = "";
    if (!found.length) { results.append(el("div", { class: "search-hint" }, "결과 없음 — Enter로 직접 추가할 수 있어요")); return; }
    for (const r of found) {
      results.append(el("div", { class: "search-item", onclick: () => pick(r) },
        el("div", { class: "s-name" }, r.name),
        el("div", { class: "s-addr" }, r.addr)));
    }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 500); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value.trim();
      if (v) pick({ name: v, addr: "", lat: null, lon: null });
    }
  });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) results.classList.add("hidden"); });
  return wrap;
}

// ── 날씨 (Open-Meteo, 무료·키 불필요) ──
let weatherByDate = null, weatherKey = null, weatherNormal = false;
function wmoIcon(code) {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌧️";
  if (code <= 86) return "🌨️";
  return "⛈️";
}
function loadWeather() {
  const days = state.itinerary;
  if (!days.length || !days[0].date) return;
  let lat = null, lon = null;
  for (const d of days) { for (const it of d.items) if (it.lat != null) { lat = it.lat; lon = it.lon; break; } if (lat != null) break; }
  if (lat == null) { // 항목 좌표가 없으면 목적지 좌표로
    const c = recCenterCache.get(state.destination);
    if (c && c !== "pending") { lat = c.lat; lon = c.lon; }
  }
  if (lat == null) return;
  const start = days[0].date, end = days[days.length - 1].date;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${start},${end}`;
  if (key === weatherKey) return; // 이미 조회함
  weatherKey = key;
  const apply = (D, normal, mapDate) => {
    const m = {};
    D.time.forEach((t, i) => { m[mapDate ? mapDate(t) : t] = { code: D.weather_code[i], tmax: D.temperature_2m_max[i], tmin: D.temperature_2m_min[i] }; });
    weatherByDate = m; weatherNormal = normal; render();
  };
  const daily = "daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto";
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&${daily}&start_date=${start}&end_date=${end}`)
    .then((r) => r.json()).then((d) => {
      if (d.daily && d.daily.time && d.daily.time.length && d.daily.temperature_2m_max.some((v) => v != null)) {
        apply(d.daily, false); return;
      }
      // 예보 범위(약 16일) 밖 → 작년 같은 기간(예년) 기록으로 대체
      const ly = (iso) => (parseInt(iso.slice(0, 4)) - 1) + iso.slice(4);
      fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&${daily}&start_date=${ly(start)}&end_date=${ly(end)}`)
        .then((r) => r.json()).then((a) => { if (a.daily && a.daily.time) apply(a.daily, true, (t) => (parseInt(t.slice(0, 4)) + 1) + t.slice(4)); })
        .catch(() => {});
    }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 장소 목록을 붙여넣으면 위치 조회 → 동선 정렬 → 날짜 분배 → 시간 배정
function openAutoPlan() {
  if (!state.itinerary.length) {
    alert("먼저 여행 날짜가 필요해요. 일정표 아래에서 날짜를 추가하거나, 새 여행을 만들 때 기간을 넣어주세요.");
    return;
  }
  const ta = el("textarea", { class: "auto-ta", rows: "7",
    placeholder: "가고 싶은 곳을 한 줄에 하나씩 적어주세요" });
  const status = el("div", { class: "auto-status" }, "");
  const genBtn = el("button", { class: "primary" }, "생성");
  const modal = el("div", { class: "modal auto-modal" },
    el("div", { class: "modal-card" },
      el("h3", {}, "장소로 자동 일정 짜기"),
      el("p", { class: "sub" }, "가고 싶은 곳을 한 줄에 하나씩 적어주세요. 위치를 찾아 동선(가까운 순)으로 날짜에 나눠 담아요."),
      ta, status,
      el("div", { class: "row", style: "margin-top:12px" },
        genBtn,
        el("button", { class: "ghost", onclick: () => modal.remove() }, "닫기"))));
  genBtn.addEventListener("click", () => runAutoPlan(ta, status, genBtn, modal));
  document.body.append(modal);
  ta.focus();
}

async function runAutoPlan(ta, status, genBtn, modal) {
  const names = ta.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) { status.textContent = "장소를 한 개 이상 입력해주세요."; return; }
  const days = state.itinerary;
  let replace = false;
  if (days.some((d) => d.items.length)) {
    replace = confirm("이미 일정에 항목이 있어요.\n\n[확인] 기존 일정을 지우고 새로 생성\n[취소] 기존 항목 뒤에 이어붙이기");
  }
  genBtn.disabled = true;
  const places = [];
  for (let i = 0; i < names.length; i++) {
    status.textContent = `위치 찾는 중… (${i + 1}/${names.length}) ${names[i]}`;
    places.push(await ensureCoords({ name: names[i], addr: "", lat: null, lon: null }));
    if (i < names.length - 1) await sleep(500); // Nominatim 예의상 간격
  }
  const geo = places.filter((p) => p.lat != null && p.lon != null);
  const noGeo = places.filter((p) => p.lat == null || p.lon == null);
  const ordered = [...nearestNeighborPath(geo), ...noGeo];
  const chunks = splitBalanced(ordered, days.length);
  const assignments = days.map((d, di) => ({
    dayId: d.id,
    items: chunks[di].map((p, i) => ({ place: p.name, addr: p.addr || "", lat: p.lat ?? null, lon: p.lon ?? null, time: slotTime(i) })),
  }));
  send("autoPlan", { assignments, replace });
  modal.remove();
  toast(`자동 일정 완료 · ${places.length}곳` + (noGeo.length ? ` (위치 못 찾은 ${noGeo.length}곳은 위치 없이 추가)` : ""));
}

function renderSummaryHeader() {
  const today = todayISO();
  let dday = "날짜 미정";
  if (state.startDate) {
    const day = 86400000;
    const s = new Date(state.startDate), e = new Date(state.endDate || state.startDate);
    const t = new Date(today);
    if (t < s) dday = `D-${Math.round((s - t) / day)}`;
    else if (t <= e) dday = `${Math.round((t - s) / day) + 1}일차`;
    else dday = "여행 종료";
  }
  const totalPlaces = state.itinerary.reduce((n, d) => n + d.items.length, 0);
  const spent = state.expenses.reduce((s, e) => s + e.amount, 0);
  const totalBudget = (state.budget || 0) * (state.members.length || 1);
  let budgetText = "예산 미설정", budgetCls = "muted";
  if (totalBudget > 0) {
    const rem = totalBudget - spent;
    budgetText = rem >= 0 ? `${won(rem)} 남음` : `${won(-rem)} 초과`;
    budgetCls = rem >= 0 ? "ok" : "danger";
  }
  let km = 0;
  for (const d of state.itinerary) {
    const geo = d.items.filter((it) => it.lat != null && it.lon != null);
    for (let i = 0; i < geo.length - 1; i++) km += haversineKm(geo[i], geo[i + 1]);
  }
  const distText = km > 0 ? `약 ${Math.round(km)}km` : "—";
  const item = (label, value, cls) => el("div", { class: "summary-item" },
    el("div", { class: "summary-label" }, label),
    el("div", { class: "summary-value" + (cls ? " " + cls : "") }, value));
  return el("div", { class: "summary-header" },
    item("여행 상태", dday),
    item("담은 장소", totalPlaces + "곳"),
    item("예산", budgetText, budgetCls),
    item("예상 이동", distText, "muted"));
}

function renderItinerary() {
  const root = $("#tab-itinerary");
  root.innerHTML = "";
  root.append(el("div", { class: "itin-head" },
    el("h2", { class: "pane-title" }, "일정표"),
    el("button", { class: "primary sm", onclick: openAutoPlan }, "자동으로 일정 짜기")));

  if (state.startDate) root.append(renderSummaryHeader());
  if (state.destination) root.append(renderRegionRecs());

  if (state.itinerary.length === 0) {
    root.append(el("p", { class: "empty" }, "여행을 만들 때 기간을 넣으면 날짜가 자동으로 채워져요. 아래에서 날짜를 추가할 수도 있어요."));
  }

  for (const day of state.itinerary) {
    root.append(renderDay(day));
  }
  loadWeather();
  if (!scrolledToday && $("#tab-plan").classList.contains("active")) {
    const t = root.querySelector(".day-card.today");
    if (t) { scrolledToday = true; requestAnimationFrame(() => t.scrollIntoView({ behavior: "smooth", block: "start" })); }
  }

  const dateInput = el("input", { type: "date" });
  root.append(el("div", { class: "card section-add" },
    el("div", { class: "row" }, dateInput,
      el("button", { class: "tiny", onclick: () => {
        if (!dateInput.value) return;
        send("addDay", { date: dateInput.value });
      } }, "+ 날짜 추가"))
  ));
}

function renderDay(day) {
  const card = el("div", { class: "card day-card" });

  const isToday = day.date && day.date === todayISO();
  if (isToday) card.classList.add("today");
  const total = el("span", { class: "day-total" }, "");
  const w = weatherByDate && weatherByDate[day.date];
  card.append(el("div", { class: "day-head" },
    el("div", { class: "day-date" }, fmtDate(day.date) || "날짜 미정"),
    ...(isToday ? [el("span", { class: "today-badge" }, "오늘")] : []),
    ...(w ? [el("span", { class: "day-weather" }, `${wmoIcon(w.code)} ${Math.round(w.tmax)}° / ${Math.round(w.tmin)}°${weatherNormal ? " 예년" : ""}`)] : []),
    el("button", { class: "del tiny", onclick: () => confirmDel("이 날짜를 통째로 삭제할까요?") && send("removeDay", { id: day.id }) }, "삭제")
  ));

  const coordItems = day.items.filter((i) => i.lat != null && i.lon != null);
  const tools = el("div", { class: "day-tools" });
  if (day.items.length >= 2) {
    tools.append(el("button", { class: "tiny", onclick: () => sortByTime(day) }, "시간순 정렬"));
  }
  const mode = dayMode.get(day.id) || "car";
  if (coordItems.length >= 2) {
    tools.append(el("button", { class: "tiny", onclick: (e) => runOptimize(day, coordItems, e.target) }, "동선 최적화"));
    tools.append(el("div", { class: "mode-toggle" },
      el("button", { class: "tiny seg" + (mode === "car" ? " on" : ""), onclick: () => { dayMode.set(day.id, "car"); render(); } }, "자동차"),
      el("button", { class: "tiny seg" + (mode === "walk" ? " on" : ""), onclick: () => { dayMode.set(day.id, "walk"); render(); } }, "도보"),
      el("button", { class: "tiny seg" + (mode === "transit" ? " on" : ""), onclick: () => { dayMode.set(day.id, "transit"); render(); } }, "대중교통")));
    tools.append(total);
  }
  card.append(tools);

  const timeline = el("div", { class: "timeline" });
  const legHolders = [];
  let prevCoordIdx = -1;
  day.items.forEach((it, idx) => {
    timeline.append(renderItineraryItem(day, it));
    if (it.lat != null && it.lon != null) {
      if (prevCoordIdx >= 0) {
        const leg = el("div", { class: "leg" }, "· · · 이동 계산 중 · · ·");
        timeline.append(leg);
        legHolders.push({ node: leg });
      }
      prevCoordIdx = idx;
    }
  });
  if (!day.items.length) {
    timeline.append(el("div", { class: "day-empty" }, "아래 검색창에서 장소를 찾아 이 날짜에 담아보세요."));
  }
  card.append(timeline);

  card.append(el("div", { class: "add-item-box" },
    searchBox("장소 검색", async (r) => {
      const g = await ensureCoords(r);
      send("addItem", { dayId: day.id, place: g.name, addr: g.addr || "", lat: g.lat ?? null, lon: g.lon ?? null, time: slotTime(day.items.length) });
    })
  ));

  if (coordItems.length >= 2) {
    if (mode === "transit") fillTransitLegs(day, coordItems, legHolders, total);
    else fillRouteLegs(coordItems, legHolders, total, mode === "walk" ? "walking" : "driving");
  }

  return card;
}

function openLink(url) {
  if (!url) return;
  const u = /^https?:\/\//i.test(url) ? url : "https://" + url;
  window.open(u, "_blank", "noopener");
}

/* ── 지역 추천 장소 (목적지 기준, OSM Overpass) ── */
let recState = null;              // null=닫힘, 아니면 category id
const nearbyCache = new Map();    // `${lat3},${lon3}|${cat}` -> items[]
const nearbyInflight = new Set();
const recCenterCache = new Map(); // destination -> {lat,lon} | null | "pending"
const NEARBY_CATS = [{ id: "restaurant", label: "식당" }, { id: "cafe", label: "카페" }, { id: "attraction", label: "볼거리" }];

async function searchNearby(lat, lon, category, radius = 1200) {
  try {
    const res = await fetch(`/api/nearby?lat=${lat}&lon=${lon}&category=${category}&radius=${radius}`);
    const data = await res.json();
    if (res.ok && Array.isArray(data)) return data;
    if (data.error === "overpass_timeout" || data.error === "overpass_busy") toast("추천 서버가 혼잡해요. 잠시 후 다시 시도해주세요.");
    return [];
  } catch { return []; }
}

// 목적지 지역 추천 패널 (일정표 상단)
function renderRegionRecs() {
  const wrap = el("div", { class: "card rec-card" });
  wrap.append(el("div", { class: "rec-head" },
    el("h3", {}, `${state.destination} 추천 장소`),
    el("button", { class: "tiny", onclick: () => { recState = recState ? null : "restaurant"; render(); } }, recState ? "숨기기" : "보기")));
  if (!recState) return wrap;
  wrap.append(el("div", { class: "nearby-tabs" },
    ...NEARBY_CATS.map((c) => el("button", { class: "tiny nearby-cat" + (c.id === recState ? " on" : ""),
      onclick: () => { recState = c.id; render(); } }, c.label))));
  const list = el("div", { class: "nearby-list" });
  wrap.append(list);
  paintRegionRecs(recState, list);
  return wrap;
}

function paintRegionRecs(cat, list) {
  if (!state.destination) { list.append(el("div", { class: "nearby-empty" }, "목적지를 설정하면 추천을 보여드려요.")); return; }
  const center = tripCenterSync();
  if (!center) {
    if (recCenterCache.get(state.destination) === null) { list.append(el("div", { class: "nearby-empty" }, "목적지 위치를 찾지 못했어요.")); return; }
    list.append(el("div", { class: "nearby-empty" }, "지역 위치 찾는 중…"));
    getTripCenter();
    return;
  }
  const key = `${center.lat.toFixed(3)},${center.lon.toFixed(3)}|${cat}`;
  if (nearbyCache.has(key)) { fillRegionCards(list, nearbyCache.get(key)); return; }
  list.append(el("div", { class: "nearby-empty" }, "추천 검색 중…"));
  if (!nearbyInflight.has(key)) {
    nearbyInflight.add(key);
    searchNearby(center.lat, center.lon, cat, 3000)
      .then((items) => { nearbyInflight.delete(key); nearbyCache.set(key, items); if (recState === cat) render(); })
      .catch(() => { nearbyInflight.delete(key); nearbyCache.set(key, []); if (recState === cat) render(); });
  }
}

const recImgCache = new Map();   // wikiKey/imageUrl -> url|null
let focusRec = null;             // '지도에서 보기'로 강조할 추천
const CAT_KR = { restaurant: "식당", cafe: "카페", bar: "술집", fast_food: "분식", pub: "펍",
  attraction: "볼거리", museum: "박물관", viewpoint: "전망대", theme_park: "테마파크",
  artwork: "예술작품", zoo: "동물원", aquarium: "아쿠아리움", gallery: "갤러리" };
const catKr = (c) => CAT_KR[c] || "장소";

function wikiKey(rec) {
  if (!rec.wiki) return null;
  const p = rec.wiki.split(":");
  const lang = p.length > 1 ? p[0] : "ko";
  const title = p.length > 1 ? p.slice(1).join(":") : p[0];
  return { lang, title, key: `${lang}:${title}` };
}
const geoImgKey = (rec) => `geo:${rec.lat.toFixed(4)},${rec.lon.toFixed(4)}`;
function cachedRecImage(rec) {
  if (rec.image && /^https?:\/\//i.test(rec.image)) return rec.image;
  const wk = wikiKey(rec);
  if (wk && recImgCache.has(wk.key)) return recImgCache.get(wk.key);
  if (recImgCache.has(geoImgKey(rec))) return recImgCache.get(geoImgKey(rec));
  return undefined;
}
function resolveRecImage(rec, onDone) {
  const wk = wikiKey(rec);
  if (wk) {
    if (recImgCache.has(wk.key)) { onDone(recImgCache.get(wk.key)); return; }
    fetch(`https://${wk.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wk.title)}`)
      .then((r) => r.json()).then((d) => { const u = (d.thumbnail && d.thumbnail.source) || null; recImgCache.set(wk.key, u); onDone(u); })
      .catch(() => { recImgCache.set(wk.key, null); onDone(null); });
    return;
  }
  // 좌표 기반 위키백과 사진 (반경 200m 내 문서 썸네일) — 명소류 커버리지 보강
  const ck = geoImgKey(rec);
  if (recImgCache.has(ck)) { onDone(recImgCache.get(ck)); return; }
  const u = `https://ko.wikipedia.org/w/api.php?action=query&format=json&origin=*`
    + `&generator=geosearch&ggscoord=${rec.lat}%7C${rec.lon}&ggsradius=200&ggslimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=320`;
  fetch(u).then((r) => r.json()).then((d) => {
    const pages = d.query && d.query.pages;
    let img = null;
    if (pages) { const p = Object.values(pages)[0]; img = (p.thumbnail && p.thumbnail.source) || null; }
    recImgCache.set(ck, img); onDone(img);
  }).catch(() => { recImgCache.set(ck, null); onDone(null); });
}
function thumbEl(rec) {
  const t = el("div", { class: "nc-thumb" }, el("span", { class: "nc-thumb-label" }, catKr(rec.category)));
  const setImg = (u) => { if (u) { t.style.backgroundImage = `url("${u}")`; t.classList.add("has"); } };
  const cached = cachedRecImage(rec);
  if (cached !== undefined) setImg(cached); else resolveRecImage(rec, setImg);
  return t;
}
function dayButtonsFor(rec, onAfter) {
  const days = state.itinerary;
  const row = el("div", { class: "rec-days" });
  if (!days.length) { row.append(el("span", { class: "nearby-empty" }, "먼저 날짜를 추가하세요")); return row; }
  days.forEach((d, di) => row.append(el("button", { class: "tiny",
    onclick: () => { send("addItem", { dayId: d.id, place: rec.name, addr: rec.addr || "", lat: rec.lat, lon: rec.lon, time: slotTime(d.items.length) }); toast(`${fmtDate(d.date) || (di + 1) + "일차"}에 ${rec.name} 추가`); if (onAfter) onAfter(); } },
    fmtDate(d.date) || `${di + 1}일차`)));
  return row;
}
function openRecDetail(rec) {
  const img = el("div", { class: "rec-detail-img" });
  const setImg = (u) => { if (u) { img.style.backgroundImage = `url("${u}")`; img.classList.add("has"); } };
  const cached = cachedRecImage(rec);
  if (cached !== undefined) setImg(cached); else resolveRecImage(rec, setImg);
  const kakao = `https://map.kakao.com/link/map/${encodeURIComponent(rec.name)},${rec.lat},${rec.lon}`;
  const google = `https://www.google.com/maps/search/?api=1&query=${rec.lat},${rec.lon}`;
  const modal = el("div", { class: "modal auto-modal" },
    el("div", { class: "modal-card rec-detail" },
      img,
      el("h3", {}, rec.name),
      el("div", { class: "sub" }, [catKr(rec.category), rec.cuisine, rec.addr].filter(Boolean).join(" · ") || "위치 정보"),
      el("div", { class: "rec-detail-actions" },
        el("button", { class: "tiny", onclick: () => { focusRec = rec; modal.remove(); updateMap(); const mc = $("#mapCanvas"); if (mc) mc.scrollIntoView({ behavior: "smooth", block: "center" }); } }, "지도에서 보기"),
        el("button", { class: "tiny", onclick: () => window.open(kakao, "_blank", "noopener") }, "카카오맵"),
        el("button", { class: "tiny", onclick: () => window.open(google, "_blank", "noopener") }, "구글맵"),
        ...(rec.website ? [el("button", { class: "tiny", onclick: () => openLink(rec.website) }, "웹사이트")] : [])),
      el("div", { class: "rec-detail-label" }, "일정에 추가"),
      dayButtonsFor(rec, () => modal.remove()),
      el("button", { class: "ghost close-modal", onclick: () => modal.remove() }, "닫기")));
  document.body.append(modal);
}
function fillRegionCards(list, items) {
  list.classList.add("rec-grid");
  if (!items.length) { list.append(el("div", { class: "nearby-empty" }, "추천이 없어요")); return; }
  for (const rec of items.slice(0, 10)) {
    const daysRow = dayButtonsFor(rec);
    daysRow.classList.add("hidden");
    const thumb = thumbEl(rec);
    thumb.style.cursor = "pointer";
    thumb.addEventListener("click", () => openRecDetail(rec));
    list.append(el("div", { class: "rec-item" },
      thumb,
      el("div", { class: "nc-body", style: "cursor:pointer", onclick: () => openRecDetail(rec) },
        el("div", { class: "nc-name" }, rec.name),
        el("div", { class: "nc-cat" }, [catKr(rec.category), rec.addr].filter(Boolean).join(" · "))),
      el("div", { class: "nc-actions" },
        el("button", { class: "tiny", onclick: () => openRecDetail(rec) }, "자세히"),
        el("button", { class: "tiny primary", onclick: (e) => { e.currentTarget.closest(".rec-item").querySelector(".rec-days").classList.toggle("hidden"); } }, "추가")),
      daysRow));
  }
}

function sortByTime(day) {
  const withTime = day.items.filter((i) => i.time).sort((a, b) => a.time.localeCompare(b.time));
  const noTime = day.items.filter((i) => !i.time);
  send("reorderDay", { dayId: day.id, orderedIds: [...withTime, ...noTime].map((i) => i.id) });
}

// 드래그 순서 변경: draggedId를 targetId 앞으로 이동
let dragItem = null;
function reorderWithin(day, draggedId, targetId) {
  if (draggedId === targetId) return;
  const ids = day.items.map((i) => i.id).filter((id) => id !== draggedId);
  const ti = ids.indexOf(targetId);
  if (ti < 0) return;
  ids.splice(ti, 0, draggedId);
  send("reorderDay", { dayId: day.id, orderedIds: ids });
}

async function runOptimize(day, coordItems, btn) {
  const orig = btn.textContent;
  btn.textContent = "계산 중…"; btn.disabled = true;
  try {
    const order = await optimizeOrder(coordItems);
    const reordered = new Array(coordItems.length);
    order.forEach((pos, i) => (reordered[pos] = coordItems[i]));
    const noCoord = day.items.filter((i) => i.lat == null || i.lon == null);
    send("reorderDay", { dayId: day.id, orderedIds: [...reordered, ...noCoord].map((i) => i.id) });
  } catch {
    btn.textContent = "실패"; setTimeout(() => (btn.textContent = orig, btn.disabled = false), 1500);
  }
}

function renderItineraryItem(day, it) {
  const isOpen = expanded.has(it.id);
  const wrap = el("div", { class: "acc-item tl-item" + (isOpen ? " open" : "") + (it.done ? " done" : "") });
  wrap.addEventListener("dragover", (e) => {
    if (dragItem && dragItem.dayId === day.id && dragItem.id !== it.id) { e.preventDefault(); wrap.classList.add("drag-over"); }
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drag-over"));
  wrap.addEventListener("drop", (e) => {
    e.preventDefault(); wrap.classList.remove("drag-over");
    if (dragItem && dragItem.dayId === day.id) { reorderWithin(day, dragItem.id, it.id); dragItem = null; }
  });

  const handle = el("span", { class: "drag-handle", draggable: "true", title: "드래그해서 순서 변경",
    onclick: (e) => e.stopPropagation() }, "⠿");
  handle.addEventListener("dragstart", (e) => {
    dragItem = { dayId: day.id, id: it.id };
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setDragImage(wrap, 12, 12); } catch {}
    wrap.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => wrap.classList.remove("dragging"));

  const summary = el("div", { class: "acc-head",
    onclick: (e) => {
      if (e.target.closest(".del") || e.target.closest(".drag-handle") || e.target.closest(".acc-time-input") || e.target.closest(".done-btn")) return;
      isOpen ? expanded.delete(it.id) : expanded.add(it.id);
      render();
    } });
  summary.append(
    handle,
    el("input", { type: "time", class: "acc-time-input", value: it.time || "",
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, time: e.target.value }) }),
    el("span", { class: "tl-dot" + (it.lat != null ? " geo" : "") }, ""),
    el("span", { class: "acc-title" }, it.place || "(제목 없음)"),
    ...(it.addr && !isOpen ? [el("span", { class: "acc-sub" }, it.addr.split(",")[0])] : []),
    ...(it.lat == null && !isOpen ? [el("span", { class: "acc-nogeo", title: "위치를 못 찾아 이동시간 계산에서 제외돼요. 항목을 눌러 위치를 지정하세요." }, "위치 없음")] : []),
    ...(it.link && !isOpen ? [el("button", { class: "tiny link-chip", title: it.link, onclick: (e) => { e.stopPropagation(); openLink(it.link); } }, "링크")] : []),
    el("button", { class: "done-btn" + (it.done ? " on" : ""), title: it.done ? "완료됨 — 해제" : "다녀왔어요 체크",
      onclick: (e) => { e.stopPropagation(); send("updateItem", { dayId: day.id, id: it.id, done: !it.done }); } }, "✓"),
    el("button", { class: "del tiny", onclick: () => send("removeItem", { dayId: day.id, id: it.id }) }, "✕")
  );
  wrap.append(summary);

  if (isOpen) {
    const body = el("div", { class: "acc-body" });
    body.append(
      field("장소·활동", el("input", { type: "text", value: it.place, placeholder: "장소",
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, place: e.target.value }) })),
      field("메모", el("input", { type: "text", value: it.memo, placeholder: "메모",
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, memo: e.target.value }) })),
      field("링크 (예약·정보)", el("div", { class: "row" },
        el("input", { type: "url", value: it.link || "", placeholder: "https://",
          onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, link: e.target.value.trim() }) }),
        ...(it.link ? [el("button", { class: "tiny", onclick: () => openLink(it.link) }, "열기")] : [])))
    );
    if (it.lat != null) {
      body.append(el("div", { class: "acc-field" },
        el("label", {}, "위치 (동선 계산에 사용됨)"),
        el("div", { class: "loc-line" },
          el("span", {}, (it.addr ? it.addr.split(",").slice(0, 3).join(", ") : `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}`)),
          el("button", { class: "tiny", onclick: () => send("updateItem", { dayId: day.id, id: it.id, lat: null, lon: null, addr: "" }) }, "위치 지우기"))
      ));
    } else {
      body.append(el("div", { class: "acc-field" },
        el("label", {}, "위치 지정 (검색하면 동선 계산에 포함돼요)"),
        searchBox("장소/주소 검색", async (r) => { const g = await ensureCoords(r); send("updateItem", { dayId: day.id, id: it.id, place: it.place || g.name, addr: g.addr || "", lat: g.lat ?? null, lon: g.lon ?? null }); })));
    }
    wrap.append(body);
  }
  return wrap;
}

function field(label, input) {
  return el("div", { class: "acc-field" }, el("label", {}, label), input);
}

function flash(node, msg) {
  const t = el("div", { class: "flash" }, msg);
  node.append(t);
  setTimeout(() => t.remove(), 1400);
}

function renderExpenses() {
  const root = $("#tab-expenses");
  root.innerHTML = "";
  root.append(el("h2", { class: "pane-title" }, "경비정산"));

  const members = state.members.length ? state.members : [me];
  const descI = el("input", { type: "text", placeholder: "내역" });
  const amtI = el("input", { type: "number", placeholder: "금액", min: "0" });
  const payerSel = el("select", {}, ...members.map((m) => el("option", { value: m }, m)));
  payerSel.value = me;

  const shareChips = el("div", { class: "chips", style: "margin:10px 0" });
  const shareSet = new Set(members);
  const renderChips = () => {
    shareChips.innerHTML = "";
    for (const m of members) {
      shareChips.append(el("span", { class: "chip" + (shareSet.has(m) ? " on" : ""),
        onclick: () => { shareSet.has(m) ? shareSet.delete(m) : shareSet.add(m); renderChips(); } }, m));
    }
  };
  renderChips();

  root.append(el("div", { class: "card section-add" },
    el("div", { class: "row" }, descI, amtI),
    el("div", { class: "row", style: "margin-top:8px; align-items:center" },
      el("label", { style: "font-size:13px;color:var(--muted)" }, "낸 사람"), payerSel),
    el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px" }, "함께 나눌 사람 (탭해서 선택)"),
    shareChips,
    el("button", { class: "primary", style: "width:100%", onclick: () => {
      const amount = Number(amtI.value);
      if (!descI.value.trim() || !amount) return;
      send("addExpense", { desc: descI.value.trim(), amount, payer: payerSel.value, sharedBy: [...shareSet] });
      descI.value = ""; amtI.value = "";
    } }, "+ 지출 추가")
  ));

  // 예산 대비 지출
  const spent = state.expenses.reduce((s, e) => s + e.amount, 0);
  const perBudget = state.budget || 0;
  const totalBudget = perBudget * members.length;
  const budgetI = el("input", { type: "number", min: "0", placeholder: "1인당 예산", value: perBudget || "" });
  const budgetCard = el("div", { class: "card" },
    el("div", { class: "card-head" }, el("h3", {}, "예산"),
      el("span", { style: "font-size:12px;color:var(--muted)" }, `${members.length}명 기준`)),
    el("div", { class: "row", style: "align-items:center" },
      el("label", { style: "font-size:13px;color:var(--muted);white-space:nowrap" }, "1인당"),
      budgetI,
      el("button", { class: "tiny", onclick: () => send("setBudget", { amount: Number(budgetI.value) || 0 }) }, "저장"))
  );
  if (totalBudget > 0) {
    const pct = Math.min(100, Math.round((spent / totalBudget) * 100));
    const over = spent > totalBudget;
    budgetCard.append(
      el("div", { class: "budget-bar" }, el("div", { class: "budget-fill" + (over ? " over" : ""), style: `width:${pct}%` }, "")),
      el("div", { class: "budget-nums" },
        `지출 ${won(spent)} / 총예산 ${won(totalBudget)} · ` + (over ? `${won(spent - totalBudget)} 초과` : `${won(totalBudget - spent)} 남음`))
    );
  }
  root.append(budgetCard);

  const listCard = el("div", { class: "card" });
  listCard.append(el("div", { class: "card-head" }, el("h3", {}, "지출 내역")));
  let total = 0;
  if (state.expenses.length === 0) {
    listCard.append(el("p", { class: "empty" }, "아직 지출 내역이 없어요."));
  } else {
    for (const e of state.expenses) {
      total += e.amount;
      listCard.append(el("div", { class: "expense-row" },
        el("div", { class: "desc" },
          el("div", {}, e.desc),
          el("div", { style: "font-size:12px;color:var(--muted)" },
            `${e.payer || "?"} 결제 · ${e.sharedBy.length}명 분담`)
        ),
        el("span", { class: "amt" }, won(e.amount)),
        el("button", { class: "del tiny", onclick: () => send("removeExpense", { id: e.id }) }, "✕")
      ));
    }
    listCard.append(el("div", { class: "total-line" }, "총 지출: " + won(total)));
  }
  root.append(listCard);

  const balances = computeBalances();
  const settleCard = el("div", { class: "card" });
  settleCard.append(el("div", { class: "card-head" }, el("h3", {}, "1인당 정산")));
  const names = Object.keys(balances);
  if (names.length === 0 || state.expenses.length === 0) {
    settleCard.append(el("p", { class: "empty" }, "지출을 추가하면 정산이 계산돼요."));
  } else {
    for (const n of names) {
      const b = balances[n];
      const cls = b > 0.5 ? "pos" : b < -0.5 ? "neg" : "";
      const txt = b > 0.5 ? `${won(Math.round(b))} 받을 돈` : b < -0.5 ? `${won(Math.round(-b))} 낼 돈` : "정산 완료";
      settleCard.append(el("div", { class: "balance " + cls }, el("span", {}, n), el("span", {}, txt)));
    }
    const tx = settleTransactions(balances);
    if (tx.length) {
      settleCard.append(el("div", { style: "margin-top:10px;font-weight:700" }, "송금 방법"));
      for (const t of tx) {
        settleCard.append(el("div", { class: "settle-line" }, `${t.from} → ${t.to} : ${won(t.amount)}`));
      }
    }
  }
  root.append(settleCard);
}

function computeBalances() {
  const bal = {};
  const touch = (n) => { if (n && !(n in bal)) bal[n] = 0; };
  for (const e of state.expenses) {
    const sharers = e.sharedBy.length ? e.sharedBy : [];
    if (!sharers.length) continue;
    touch(e.payer);
    bal[e.payer] += e.amount;
    const per = e.amount / sharers.length;
    for (const s of sharers) { touch(s); bal[s] -= per; }
  }
  return bal;
}

function settleTransactions(bal) {
  const creditors = [], debtors = [];
  for (const [n, v] of Object.entries(bal)) {
    if (v > 0.5) creditors.push({ n, v });
    else if (v < -0.5) debtors.push({ n, v: -v });
  }
  creditors.sort((a, b) => b.v - a.v);
  debtors.sort((a, b) => b.v - a.v);
  const tx = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    tx.push({ from: debtors[i].n, to: creditors[j].n, amount: Math.round(pay) });
    debtors[i].v -= pay; creditors[j].v -= pay;
    if (debtors[i].v < 0.5) i++;
    if (creditors[j].v < 0.5) j++;
  }
  return tx;
}

function renderPacking() {
  const root = $("#tab-packing");
  root.innerHTML = "";
  root.append(el("h2", { class: "pane-title" }, "준비물"));

  const members = state.members.length ? state.members : [me];
  const textI = el("input", { type: "text", placeholder: "준비물" });
  const assignSel = el("select", {}, el("option", { value: "" }, "담당 없음"),
    ...members.map((m) => el("option", { value: m }, m)));
  root.append(el("div", { class: "card section-add" },
    el("div", { class: "row" }, textI, assignSel,
      el("button", { class: "primary", onclick: () => {
        if (!textI.value.trim()) return;
        send("addPacking", { text: textI.value.trim(), assignee: assignSel.value });
        textI.value = "";
      } }, "+ 추가")
    )
  ));

  if (state.packing.length === 0) {
    root.append(el("p", { class: "empty" }, "챙길 준비물을 추가해보세요."));
    return;
  }

  const doneCount = state.packing.filter((p) => p.done).length;
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "card-head" },
    el("h3", {}, "체크리스트"),
    el("span", { style: "color:var(--muted);font-size:14px" }, `${doneCount} / ${state.packing.length} 완료`)
  ));
  for (const p of state.packing) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = p.done;
    cb.addEventListener("change", () => send("updatePacking", { id: p.id, done: cb.checked }));
    card.append(el("div", { class: "pack-row" + (p.done ? " done" : "") },
      cb,
      el("span", { class: "text" }, p.text),
      p.assignee ? el("span", { class: "assignee-tag" }, p.assignee) : null,
      el("button", { class: "del tiny", onclick: () => send("removePacking", { id: p.id }) }, "✕")
    ));
  }
  root.append(card);
}

function confirmDel(msg) {
  return window.confirm(msg);
}
