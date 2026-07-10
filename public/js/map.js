// map: Leaflet 지도 렌더링(핀·경로·날짜 필터), 장소 검색 박스
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.

/* ── 지도로 일정 짜기 ────────────────────────────── */
let map = null, mapMarkers = null, mapRoutes = null, mapCollapsed = false;
let mapDayFilter = "all"; // "all" 또는 dayId — 지도에 표시할 날짜
const MAP_HUE_OFFSETS = [0, 150, 62, 255, 100, 300, 200, 30]; // 테마 기준색에서 날짜별 색상 회전
function hexToHsl(hex) {
  const m = String(hex).trim().replace("#", "");
  const h6 = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  if (!/^[0-9a-fA-F]{6}$/.test(h6)) return { h: 224, s: 71, l: 55 }; // 기본 --brand(#1d4ed8) 기준 HSL
  const r = parseInt(h6.slice(0, 2), 16) / 255, g = parseInt(h6.slice(2, 4), 16) / 255, b = parseInt(h6.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: s * 100, l: l * 100 };
}
// 현재 테마의 --brand에서 날짜별 지도 색을 생성 (테마마다 조금씩 달라짐)
function mapColors() {
  let brand = "#1d4ed8";
  try { brand = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || brand; } catch {}
  const base = hexToHsl(brand);
  const S = Math.max(58, Math.min(74, Number.isFinite(base.s) ? base.s : 65));
  const L = Math.max(44, Math.min(56, Number.isFinite(base.l) ? base.l : 50));
  return MAP_HUE_OFFSETS.map((off) => `hsl(${Math.round((base.h + off) % 360)}, ${S}%, ${L}%)`);
}

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

  // 선택한 날짜가 사라졌으면 전체로 되돌림
  if (mapDayFilter !== "all" && !state.itinerary.some((d) => d.id === mapDayFilter)) mapDayFilter = "all";
  // 일정 항목: 날짜별 색상·순번 핀 + 동선 경로선 (필터가 걸리면 해당 날짜만 그림)
  const legendDays = [];
  const COLORS = mapColors();
  state.itinerary.forEach((day, di) => {
    const color = COLORS[di % COLORS.length];
    const pts = day.items.filter((it) => it.lat != null && it.lon != null);
    if (pts.length) legendDays.push({ color, label: fmtDate(day.date) || `${di + 1}일차`, count: pts.length, id: day.id });
    if (mapDayFilter !== "all" && mapDayFilter !== day.id) return; // 필터: 이 날짜 건너뜀
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
    if (center && center !== "pending" && center.lat != null && center.lon != null) {
      const recs = nearbyCache.get(`${center.lat.toFixed(3)},${center.lon.toFixed(3)}|${recState}`);
      if (Array.isArray(recs)) recs.filter((r) => r.lat != null && r.lon != null).slice(0, 10).forEach((r) => {
        const isFocus = focusRec && focusRec.name === r.name && Math.abs(focusRec.lat - r.lat) < 1e-6;
        const pop = el("div", { class: "map-pop" }, el("b", {}, r.name || ""), el("div", { class: "map-pop-sub" }, catKr(r.category)));
        L.marker([r.lat, r.lon], { icon: recIcon(isFocus) }).bindPopup(pop).addTo(mapMarkers);
      });
    }
  }

  buildMapToolbar(legendDays);

  const doFocus = focusRec;
  if (doFocus) { map.setView([doFocus.lat, doFocus.lon], 16); focusRec = null; }
  else if (!mapCollapsed) {
    if (bounds.length === 1) map.setView(bounds[0], 14);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [45, 45] });
    else {
      // 핀이 하나도 없으면 목적지 중심(있으면)으로, 없으면 대한민국 중심으로 이동
      const c = recCenterCache.get(state.destination);
      if (c && c !== "pending" && c.lat != null && c.lon != null) map.setView([c.lat, c.lon], 11);
      else map.setView([36.5, 127.8], 7);
    }
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
  if (!legendDays.length) {
    bar.append(el("span", { class: "lg-empty" }, "아래 일정표에서 장소를 검색해 담으면 지도에 표시돼요."));
    return;
  }
  // 날짜 선택 칩 (전체 + 각 날짜). 색 점 = 지도 핀 색상.
  const sel = el("div", { class: "map-daysel" });
  const chip = (label, val, color, count) => el("button", {
    class: "day-chip" + (mapDayFilter === val ? " on" : ""),
    onclick: () => { mapDayFilter = val; updateMap(); },
  }, ...(color ? [el("span", { class: "lg-dot", style: `background:${color}` })] : []),
     count != null ? `${label} ${count}` : label);
  sel.append(chip("전체", "all", null, null));
  legendDays.forEach((x) => sel.append(chip(x.label, x.id, x.color, x.count)));
  bar.append(sel);
}

function searchBox(placeholder, onPick) {
  const input = el("input", { type: "text", placeholder });
  const results = el("div", { class: "search-results hidden" });
  const wrap = el("div", { class: "search-box" }, input, results);
  let timer = null, lastQ = null;

  const pick = (r) => { input.value = ""; lastQ = null; results.classList.add("hidden"); onPick(r); input.blur(); };
  // 입력한 텍스트를 주소로 보고 위치를 찾아 추가 (못 찾으면 이름만이라도 추가)
  const addByText = async (v) => {
    const text = (v || input.value).trim();
    if (!text) return;
    results.classList.remove("hidden");
    results.innerHTML = "";
    results.append(el("div", { class: "search-hint" }, "위치 찾는 중…"));
    const loc = await geocodeText(text);
    pick(loc ? { name: text, addr: loc.addr || "", lat: loc.lat, lon: loc.lon }
             : { name: text, addr: "", lat: null, lon: null });
    if (!loc) toast("위치를 못 찾아 이름만 추가했어요 (지도엔 안 나와요)");
  };
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
    if (!found.length) {
      results.append(el("div", { class: "search-hint" }, "검색 결과가 없어요."));
      results.append(el("div", { class: "search-item add-manual", onclick: () => addByText(q) },
        el("div", { class: "s-name" }, `‘${q}’ 주소로 추가`),
        el("div", { class: "s-addr" }, "주소를 입력했다면 위치를 찾아 지도에 표시해요")));
      return;
    }
    for (const r of found) {
      results.append(el("div", { class: "search-item", onclick: () => pick(r) },
        el("div", { class: "s-name" }, r.name),
        el("div", { class: "s-addr" }, r.addr)));
    }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 500); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const v = input.value.trim(); if (v) addByText(v); }
  });
  // 외부 클릭 대신 blur로 닫기(결과 onclick이 먼저 처리되도록 지연)
  input.addEventListener("blur", () => { setTimeout(() => results.classList.add("hidden"), 200); });
  return wrap;
}

