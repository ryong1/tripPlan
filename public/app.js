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
    history.replaceState(null, "", "?trip=" + tripId);
    $("#landing").classList.add("hidden");
    $("#app").classList.remove("hidden");
  });
}

socket.on("state", (trip) => {
  state = trip;
  render();
});
socket.on("presence", ({ online }) => {
  $("#presence").textContent = `● ${online}명 접속`;
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

function render() {
  if (!state) return;
  if (isEditing()) { pendingRender = true; return; }
  $("#tripTitle").value = state.name;
  const range = state.startDate ? `${fmtDate(state.startDate)} ~ ${fmtDate(state.endDate)}` : "";
  $("#tripSub").textContent = [state.destination && "📍 " + state.destination, range].filter(Boolean).join("  ·  ");
  renderItinerary();
  renderExpenses();
  renderPacking();
  if ($("#tab-plan").classList.contains("active")) { if (!map) showMap(); else updateMap(); }
}

const geoCache = new Map();

async function searchPlaces(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  if (geoCache.has(q)) return geoCache.get(q);
  try {
    const res = await fetch("/api/geo/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    const results = Array.isArray(data) ? data : [];
    geoCache.set(q, results);
    return results;
  } catch {
    return [];
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
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes[0]) throw new Error(data.code || "route fail");
  return data.routes[0].legs.map((l) => ({ distance: l.distance, duration: l.duration }));
}

// 자동차/도보(OSRM) 구간 채우기.
// 공용 OSRM은 도보 프로파일도 차량 속도로 계산하므로, 도보는 실제 도로거리를 4.8km/h로 환산한다.
const WALK_MPS = 4.8 * 1000 / 3600; // ≈ 1.33 m/s
function fillRouteLegs(coordItems, legHolders, total, profile) {
  const walk = profile === "walking";
  const icon = walk ? "🚶" : "🚗";
  const suffix = walk ? " (약)" : "";
  routeLegs(coordItems, "driving").then((legs) => {
    let sumD = 0, sumT = 0;
    legs.forEach((lg, i) => {
      const dur = walk ? lg.distance / WALK_MPS : lg.duration;
      sumD += lg.distance; sumT += dur;
      if (legHolders[i]) legHolders[i].node.textContent = `${icon} ${fmtDist(lg.distance)} · ${fmtDur(dur)}${suffix}`;
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
    if (t.error === "no_key") { noKey = true; if (node) node.textContent = "🔑 ODsay 키 설정 필요"; allFound = false; continue; }
    if (!t.found) { if (node) node.textContent = "🚉 대중교통 경로 없음"; allFound = false; continue; }
    const icon = TRANSIT_ICON[t.pathType] || "🚌";
    const parts = [`${icon} ${t.mode} ${fmtDur(t.totalTime * 60)}`];
    if (t.transfers) parts.push(`환승 ${t.transfers}회`);
    parts.push(t.payment ? `${t.payment.toLocaleString("ko-KR")}원` : "요금 미제공");
    const from = coordItems[i], to = coordItems[i + 1];
    if (node) {
      node.textContent = "";
      node.append(
        el("span", { class: "leg-text" }, parts.join(" · ")),
        el("button", { class: "leg-add-btn", title: "이 구간 교통비를 경비정산에 추가",
          onclick: (e) => addTransitFare(day, from, to, t, e.target) }, "🧾 경비 추가")
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
  toast(`💰 경비 추가됨 · ${amount.toLocaleString("ko-KR")}원`);
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
let map = null, mapMarkers = null, mapRoutes = null;
let previewPlace = null; // 검색해서 지도에 띄운, 아직 일정에 담기 전 장소
const MAP_COLORS = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];

function numIcon(color, n) {
  return L.divIcon({ className: "map-pin", html: `<span class="pin-num" style="background:${color}">${n}</span>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13] });
}
function previewIcon() {
  return L.divIcon({ className: "map-pin", html: `<span class="pin-preview">📍</span>`,
    iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26] });
}

function showMap() {
  const pane = $("#tab-map");
  if (!map) {
    pane.innerHTML = "";
    const search = el("div", { class: "plan-search" },
      el("div", { class: "plan-search-label" }, "🔎 장소를 검색해 지도에서 확인하고 일정에 담아보세요"),
      searchBox("장소·주소 검색 — 또는 직접 입력 후 Enter", pickSearchResult),
      el("div", { class: "plan-preview hidden", id: "planPreview" })
    );
    pane.append(
      search,
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

// 검색 결과 선택 → (좌표 없으면 자동 조회) → 미리보기로 지도에 표시
async function pickSearchResult(r) {
  previewPlace = { name: r.name, addr: r.addr || "", lat: r.lat ?? null, lon: r.lon ?? null };
  renderPreviewBar();
  const g = await ensureCoords(r);
  previewPlace = { name: g.name, addr: g.addr || "", lat: g.lat ?? null, lon: g.lon ?? null };
  updateMap();
  renderPreviewBar();
  if (previewPlace.lat != null && map) map.setView([previewPlace.lat, previewPlace.lon], 15);
}

function addPlaceToDay(place, day) {
  send("addItem", { dayId: day.id, place: place.name, memo: place.memo || "", addr: place.addr || "",
    lat: place.lat ?? null, lon: place.lon ?? null, time: slotTime(day.items.length) });
}

// 검색창 아래 미리보기 바: 어느 날짜에 담을지 선택
function renderPreviewBar() {
  const bar = $("#planPreview");
  if (!bar) return;
  bar.innerHTML = "";
  if (!previewPlace) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.append(el("div", { class: "pv-info" },
    el("span", { class: "pv-name" }, "📍 " + (previewPlace.name || "(이름 없음)")),
    previewPlace.addr ? el("span", { class: "pv-addr" }, previewPlace.addr.split(",").slice(0, 3).join(", ")) : null,
    previewPlace.lat == null ? el("span", { class: "pv-warn" }, "위치를 못 찾아 지도에는 표시되지 않아요") : null));
  const days = state.itinerary;
  if (!days.length) {
    bar.append(el("span", { class: "pv-addr" }, "먼저 아래 일정표에서 날짜를 추가하세요."));
    return;
  }
  const btns = el("div", { class: "pv-days" }, el("span", { class: "pv-label" }, "일정에 담기 →"));
  days.forEach((d, di) => {
    btns.append(el("button", { class: "map-day-btn", style: `border-color:${MAP_COLORS[di % MAP_COLORS.length]}`,
      onclick: () => { addPlaceToDay(previewPlace, d); previewPlace = null; updateMap(); renderPreviewBar(); } },
      (fmtDate(d.date) || `${di + 1}일차`) + "에 담기"));
  });
  btns.append(el("button", { class: "map-day-btn", onclick: () => { previewPlace = null; updateMap(); renderPreviewBar(); } }, "취소"));
  bar.append(btns);
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

  // 검색 미리보기 핀
  if (previewPlace && previewPlace.lat != null) {
    const ll = [previewPlace.lat, previewPlace.lon];
    bounds.push(ll);
    L.marker(ll, { icon: previewIcon() }).bindPopup(`<b>${previewPlace.name}</b><br>아래에서 담을 날짜를 선택하세요`).addTo(mapMarkers);
  }

  buildMapToolbar(legendDays);

  if (bounds.length === 1) map.setView(bounds[0], 14);
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [45, 45] });
}

function buildMapToolbar(legendDays) {
  const bar = $("#mapToolbar");
  bar.innerHTML = "";
  const legend = el("div", { class: "map-legend" });
  legendDays.forEach((x) => legend.append(el("span", { class: "lg-item" },
    el("span", { class: "lg-dot", style: `background:${x.color}` }), `${x.label} (${x.count})`)));
  if (!legendDays.length) {
    legend.append(el("span", { class: "lg-empty" }, "위 검색으로 장소를 찾아 일정에 담으면 지도에 표시돼요."));
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

function renderItinerary() {
  const root = $("#tab-itinerary");
  root.innerHTML = "";
  root.append(el("h2", { class: "pane-title" }, "📅 일정표"));

  if (state.itinerary.length === 0) {
    root.append(el("p", { class: "empty" }, "여행을 만들 때 기간을 넣으면 날짜가 자동으로 채워져요. 아래에서 날짜를 추가할 수도 있어요."));
  }

  for (const day of state.itinerary) {
    root.append(renderDay(day));
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

  const total = el("span", { class: "day-total" }, "");
  card.append(el("div", { class: "day-head" },
    el("div", { class: "day-date" }, fmtDate(day.date) || "날짜 미정"),
    el("button", { class: "del tiny", onclick: () => confirmDel("이 날짜를 통째로 삭제할까요?") && send("removeDay", { id: day.id }) }, "🗑")
  ));

  const coordItems = day.items.filter((i) => i.lat != null && i.lon != null);
  const tools = el("div", { class: "day-tools" });
  if (day.items.length >= 2) {
    tools.append(el("button", { class: "tiny", onclick: () => sortByTime(day) }, "🕒 시간순 정렬"));
  }
  const mode = dayMode.get(day.id) || "car";
  if (coordItems.length >= 2) {
    tools.append(el("button", { class: "tiny", onclick: (e) => runOptimize(day, coordItems, e.target) }, "🧭 동선 최적화"));
    tools.append(el("div", { class: "mode-toggle" },
      el("button", { class: "tiny seg" + (mode === "car" ? " on" : ""), onclick: () => { dayMode.set(day.id, "car"); render(); } }, "🚗 자동차"),
      el("button", { class: "tiny seg" + (mode === "walk" ? " on" : ""), onclick: () => { dayMode.set(day.id, "walk"); render(); } }, "🚶 도보"),
      el("button", { class: "tiny seg" + (mode === "transit" ? " on" : ""), onclick: () => { dayMode.set(day.id, "transit"); render(); } }, "🚆 대중교통")));
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
  card.append(timeline);

  card.append(el("div", { class: "add-item-box" },
    searchBox("장소 검색해서 추가 — 또는 직접 입력 후 Enter", async (r) => {
      const g = await ensureCoords(r);
      send("addItem", { dayId: day.id, place: g.name, addr: g.addr || "", lat: g.lat ?? null, lon: g.lon ?? null });
    })
  ));

  if (coordItems.length >= 2) {
    if (mode === "transit") fillTransitLegs(day, coordItems, legHolders, total);
    else fillRouteLegs(coordItems, legHolders, total, mode === "walk" ? "walking" : "driving");
  }

  return card;
}

function sortByTime(day) {
  const withTime = day.items.filter((i) => i.time).sort((a, b) => a.time.localeCompare(b.time));
  const noTime = day.items.filter((i) => !i.time);
  send("reorderDay", { dayId: day.id, orderedIds: [...withTime, ...noTime].map((i) => i.id) });
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
  const wrap = el("div", { class: "acc-item tl-item" + (isOpen ? " open" : "") });

  const summary = el("div", { class: "acc-head",
    onclick: (e) => {
      if (e.target.closest(".del")) return;
      isOpen ? expanded.delete(it.id) : expanded.add(it.id);
      render();
    } });
  summary.append(
    el("span", { class: "acc-time" }, it.time || "—"),
    el("span", { class: "tl-dot" + (it.lat != null ? " geo" : "") }, ""),
    el("span", { class: "acc-title" }, it.place || "(제목 없음)"),
    ...(it.addr && !isOpen ? [el("span", { class: "acc-sub" }, it.addr.split(",")[0])] : []),
    ...(it.lat == null && !isOpen ? [el("span", { class: "acc-nogeo", title: "위치를 못 찾아 이동시간 계산에서 제외돼요. 항목을 눌러 위치를 지정하세요." }, "위치 없음")] : []),
    el("button", { class: "del tiny", onclick: () => send("removeItem", { dayId: day.id, id: it.id }) }, "✕")
  );
  wrap.append(summary);

  if (isOpen) {
    const body = el("div", { class: "acc-body" });
    body.append(
      field("장소·활동", el("input", { type: "text", value: it.place, placeholder: "예: 도톤보리",
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, place: e.target.value }) })),
      field("시간", el("input", { type: "time", value: it.time,
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, time: e.target.value }) })),
      field("메모", el("input", { type: "text", value: it.memo, placeholder: "예약, 준비물, 팁 등",
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, memo: e.target.value }) }))
    );
    if (it.lat != null) {
      body.append(el("div", { class: "acc-field" },
        el("label", {}, "위치 (동선 계산에 사용됨)"),
        el("div", { class: "loc-line" },
          el("span", {}, "📍 " + (it.addr ? it.addr.split(",").slice(0, 3).join(", ") : `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}`)),
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
  root.append(el("h2", { class: "pane-title" }, "💰 경비정산"));

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
      settleCard.append(el("div", { style: "margin-top:10px;font-weight:700" }, "💸 송금 방법"));
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
  root.append(el("h2", { class: "pane-title" }, "🎒 준비물"));

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
