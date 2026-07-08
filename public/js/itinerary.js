// itinerary: 날씨, 코스 자동생성(AI/주변), 여행 요약, 일정표/날짜 렌더링
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.

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

// 이미 담아둔 장소들을 최적 동선으로 날짜에 재배치 (항목 데이터는 보존)
function optimizeRoute() {
  const days = state.itinerary;
  if (!days.length) { alert("여행 날짜가 먼저 필요해요."); return; }
  const all = [];
  days.forEach((d) => d.items.forEach((it) => all.push(it)));
  const geo = all.filter((it) => it.lat != null && it.lon != null);
  if (geo.length < 2) { alert("정리할 장소가 2곳 이상 필요해요.\n추천이나 검색으로 가고 싶은 곳을 먼저 담아주세요."); return; }
  if (!confirm("담아둔 장소들을 가까운 순서(최적 동선)로 날짜에 다시 배치할까요?\n순서와 날짜가 바뀔 수 있어요.")) return;
  const noGeo = all.filter((it) => it.lat == null || it.lon == null);
  const ordered = [...nearestNeighborPath(geo), ...noGeo];
  const chunks = splitBalanced(ordered, days.length);
  const assignments = days.map((d, di) => ({
    dayId: d.id,
    items: chunks[di].map((it, i) => ({ id: it.id, time: slotTime(i) })),
  }));
  send("reflow", { assignments });
  toast("최적 동선으로 정리했어요");
}

// 하루 일정 리듬: 볼거리 → 점심(식당) → 볼거리 → 카페 → 볼거리 → 저녁(식당)
const DAY_TEMPLATE = [
  { cat: "attraction", time: "10:00", memo: "오전 관광" },
  { cat: "restaurant", time: "12:30", memo: "점심" },
  { cat: "attraction", time: "14:30", memo: "오후 관광" },
  { cat: "cafe",       time: "16:00", memo: "카페 휴식" },
  { cat: "attraction", time: "17:30", memo: "관광" },
  { cat: "restaurant", time: "19:00", memo: "저녁" },
];
// 아직 안 쓴 장소 중 현재 위치에서 가장 가까운 곳
function pickNearestUnused(pool, used, from) {
  let best = null, bd = Infinity;
  for (const p of pool || []) {
    if (!p || p.lat == null || used.has(p.name)) continue;
    const d = from ? haversineKm(from, p) : 0;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// 목적지 지역을 "볼거리·식당·카페" 흐름으로 하루 일정 자동 생성
async function generateCourse(btn) {
  if (!state.destination) { alert("먼저 목적지를 설정해주세요."); return; }
  const days = state.itinerary;
  if (!days.length) { alert("먼저 여행 날짜가 필요해요."); return; }
  const center = await getTripCenter();
  if (!center) { alert("목적지 위치를 찾지 못했어요. 목적지 이름을 확인해주세요."); return; }
  if (!confirm(`${state.destination} 지역을 "볼거리 → 점심 → 카페 → 저녁" 흐름으로 하루 일정을 자동으로 채울까요?\n(기존 일정 항목은 대체됩니다)`)) return;
  const orig = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "만드는 중…"; }
  try {
    const [attraction, restaurant, cafe] = await Promise.all([
      searchNearby(center.lat, center.lon, "attraction", 4000),
      searchNearby(center.lat, center.lon, "restaurant", 4000),
      searchNearby(center.lat, center.lon, "cafe", 4000),
    ]);
    const pools = {
      attraction: attraction.filter((p) => p.lat != null),
      restaurant: restaurant.filter((p) => p.lat != null),
      cafe: cafe.filter((p) => p.lat != null),
    };
    if (!pools.attraction.length && !pools.restaurant.length && !pools.cafe.length) {
      alert("이 지역에서 추천할 장소를 찾지 못했어요. 잠시 후 다시 시도해주세요."); return;
    }
    const used = new Set();
    let cursor = center, picked = 0;
    const assignments = days.map((d) => {
      const items = [];
      for (const slot of DAY_TEMPLATE) {
        let p = pickNearestUnused(pools[slot.cat], used, cursor);
        let memo = slot.memo;
        if (!p) { // 해당 종류가 동나면 다른 종류로 채우되 메모는 비움
          p = pickNearestUnused(pools.attraction, used, cursor)
            || pickNearestUnused(pools.restaurant, used, cursor)
            || pickNearestUnused(pools.cafe, used, cursor);
          memo = "";
        }
        if (!p) continue;
        used.add(p.name); cursor = p; picked++;
        items.push({ place: p.name, addr: p.addr || "", lat: p.lat, lon: p.lon, time: slot.time, memo });
      }
      return { dayId: d.id, items };
    });
    if (!picked) { alert("추천할 장소를 찾지 못했어요. 잠시 후 다시 시도해주세요."); return; }
    send("autoPlan", { assignments, replace: true });
    toast(`추천 코스 완성 · ${picked}곳`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// AI 추천 옵션 선택 모달 — 여행 스타일 + 꼭 넣고 싶은 요소
const AI_STYLES = [
  { v: "balanced", label: "균형" },
  { v: "activity", label: "액티비티·체험" },
  { v: "healing", label: "여유·힐링" },
  { v: "food", label: "맛집 탐방" },
];
const AI_MUSTS = ["바다", "시장", "산·자연", "카페", "역사·문화", "쇼핑", "야경", "온천"];
function openAiOptions() {
  if (!state.destination) { alert("먼저 목적지를 설정해주세요."); return; }
  if (!state.itinerary.length) { alert("먼저 여행 날짜가 필요해요."); return; }
  let style = "balanced";
  const musts = new Set();
  const styleRow = el("div", { class: "opt-row" });
  const styleBtns = AI_STYLES.map((o) => {
    const c = el("button", { class: "chip" + (o.v === "balanced" ? " on" : ""),
      onclick: () => { style = o.v; styleBtns.forEach((x) => x.classList.remove("on")); c.classList.add("on"); } }, o.label);
    styleRow.append(c); return c;
  });
  const mustRow = el("div", { class: "opt-row" });
  AI_MUSTS.forEach((m) => {
    const c = el("button", { class: "chip",
      onclick: () => { if (musts.has(m)) { musts.delete(m); c.classList.remove("on"); } else { musts.add(m); c.classList.add("on"); } } }, m);
    mustRow.append(c);
  });
  const modal = el("div", { class: "modal auto-modal" },
    el("div", { class: "modal-card" },
      el("h3", {}, "AI 추천 코스 만들기"),
      el("p", { class: "sub" }, `${state.destination} · ${state.itinerary.length}일`),
      el("div", { class: "opt-label" }, "여행 스타일"),
      styleRow,
      el("div", { class: "opt-label" }, "꼭 넣고 싶은 것 (여러 개 선택 가능)"),
      mustRow,
      el("div", { class: "modal-actions" },
        el("button", { class: "primary", onclick: () => { modal.remove(); runAiCourse({ style, musts: [...musts] }); } }, "코스 만들기"),
        el("button", { class: "ghost close-modal", onclick: () => modal.remove() }, "취소"))));
  document.body.append(modal);
}

// AI(무료 Gemini) 추천 코스 실행 — 실제 장소명으로 일정 생성 후 좌표를 붙여 배치
async function runAiCourse(prefs) {
  const days = state.itinerary;
  const loading = el("div", { class: "modal auto-modal" },
    el("div", { class: "modal-card" }, el("p", { class: "ai-loading", id: "aiLoadingText" }, "AI가 코스를 짜고 있어요… (10~20초)")));
  document.body.append(loading);
  const setLoad = (t) => { const n = $("#aiLoadingText"); if (n) n.textContent = t; };
  try {
    const qs = `dest=${encodeURIComponent(state.destination)}&days=${days.length}`
      + `&style=${encodeURIComponent(prefs.style || "balanced")}&musts=${encodeURIComponent((prefs.musts || []).join(","))}`;
    const res = await fetch(`/api/ai/course?${qs}`);
    const data = await res.json();
    if (data.error === "no_key") { alert("AI 추천을 쓰려면 Gemini 무료 API 키가 필요해요.\n서버 data/gemini.key 또는 환경변수 GEMINI_API_KEY에 넣어주세요."); return; }
    if (!data.days || !Array.isArray(data.days)) { alert("AI 응답을 받지 못했어요. 잠시 후 다시 시도해주세요."); return; }
    setLoad("장소 위치를 찾는 중…");
    const assignments = [];
    let total = 0;
    for (let i = 0; i < days.length; i++) {
      const aiDay = data.days[i] || { items: [] };
      const items = [];
      for (const it of (aiDay.items || [])) {
        if (!it || !it.place) continue;
        const hits = await searchPlaces(it.place, true); // 목적지 주변으로 좌표 조회(정확도 우선)
        const g = hits[0];
        // OSM이 못 찾으면 AI가 준 대략 좌표를 사용 (유효한 좌표 범위일 때만)
        const aiOk = typeof it.lat === "number" && typeof it.lon === "number"
          && Math.abs(it.lat) <= 90 && Math.abs(it.lon) <= 180 && (it.lat !== 0 || it.lon !== 0);
        const lat = g ? g.lat : (aiOk ? it.lat : null);
        const lon = g ? g.lon : (aiOk ? it.lon : null);
        items.push({ place: it.place, time: it.time || "", memo: it.memo || "",
          addr: g ? g.addr : "", lat, lon });
        total++;
      }
      assignments.push({ dayId: days[i].id, items });
    }
    if (!total) { alert("AI가 장소를 만들지 못했어요. 잠시 후 다시 시도해주세요."); return; }
    send("autoPlan", { assignments, replace: true });
    toast(`AI 추천 코스 완성 · ${total}곳`);
  } catch {
    alert("AI 추천 중 오류가 났어요. 잠시 후 다시 시도해주세요.");
  } finally {
    loading.remove();
  }
}

const itemCost = (it) => Math.max(0, Number(it.cost) || 0);
const dayCost = (d) => d.items.reduce((m, it) => m + itemCost(it), 0);
const tripSpent = () => state.itinerary.reduce((n, d) => n + dayCost(d), 0);

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
  const spent = state.expenses.reduce((s, e) => s + e.amount, 0) + tripSpent();
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
    el("div", { class: "itin-actions" },
      el("button", { class: "sm act-ai", onclick: () => openAiOptions() }, "AI 추천 코스"),
      el("button", { class: "sm act-soft", onclick: (e) => generateCourse(e.currentTarget) }, "주변 장소로 채우기"),
      el("button", { class: "sm act-line", onclick: optimizeRoute }, "최적 동선으로 정리"))));

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
  const spentToday = dayCost(day);
  card.append(el("div", { class: "day-head" },
    el("div", { class: "day-date" }, fmtDate(day.date) || "날짜 미정"),
    ...(isToday ? [el("span", { class: "today-badge" }, "오늘")] : []),
    ...(spentToday > 0 ? [el("span", { class: "day-spend", title: "이 날의 지출 합계" }, "지출 " + won(spentToday))] : []),
    ...(w ? [el("span", { class: "day-weather" }, `${wmoIcon(w.code)} ${Math.round(w.tmax)}° / ${Math.round(w.tmin)}°${weatherNormal ? " 예년" : ""}`)] : [])
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
    timeline.append(el("div", { class: "day-empty" }, "위 '추천 코스 자동 만들기'로 한 번에 채우거나, 아래 검색으로 장소를 담아보세요."));
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

