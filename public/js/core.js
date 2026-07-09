// core: 부트스트랩(소켓·설정 로드), 전역 상태, DOM 헬퍼, 입장(enter)/최근 여행, render() 오케스트레이션
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.

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

/* ── 카카오(국내) / OSM(해외) 하이브리드 ────────────────────
   여행지 좌표가 한국 범위이고 카카오 키가 있으면 카카오맵을, 아니면 기존 OSM을 쓴다. */
let kakaoJsKey = "";
let kakaoReady = false;       // SDK 로드 완료 여부
let kakaoLoadPromise = null;
// 카카오맵(지도+로컬 검색)은 '추가 기능 신청' 승인이 필요해 현재 비활성.
// 승인받으면 true로 바꾸면 지도·검색이 자동으로 카카오로 전환됨.
// (장소 '이미지 검색'은 별도 검색 REST API라 이 값과 무관하게 계속 동작)
const KAKAO_MAPS_ENABLED = false;
async function loadConfig() {
  try { const c = await (await fetch("/api/config")).json(); kakaoJsKey = c.kakaoJsKey || ""; }
  catch { kakaoJsKey = ""; }
}
const configReady = loadConfig();
// 카카오맵 SDK 동적 로드 (키 있을 때만). services 라이브러리로 장소검색까지 처리.
function ensureKakao() {
  if (!KAKAO_MAPS_ENABLED) return Promise.resolve(false); // 승인 전: 지도/검색은 OSM 사용
  if (kakaoReady) return Promise.resolve(true);
  if (kakaoLoadPromise) return kakaoLoadPromise;
  kakaoLoadPromise = configReady.then(() => new Promise((resolve) => {
    if (!kakaoJsKey) return resolve(false);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoJsKey}&libraries=services&autoload=false`;
    s.onload = () => {
      // 인증 실패 시 200이지만 window.kakao가 없을 수 있음 → 안전 폴백
      if (window.kakao && window.kakao.maps) {
        try { window.kakao.maps.load(() => { kakaoReady = true; finish(true); }); }
        catch { finish(false); }
      } else finish(false);
    };
    s.onerror = () => finish(false);
    setTimeout(() => finish(false), 6000); // 6초 내 미로드 시 폴백 (절대 멈추지 않도록)
    document.head.appendChild(s);
  }));
  return kakaoLoadPromise;
}
// 대한민국 대략 범위 (제주~강원 포함)
function inKorea(c) { return !!c && c.lat >= 33 && c.lat <= 38.9 && c.lon >= 124.5 && c.lon <= 131.5; }
function isDomestic() { return inKorea(tripCenterSync()); }

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
  try {
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const { id } = await res.json();
    enter(id, name);
  } catch {
    showLandingError("여행을 만들지 못했어요. 잠시 후 다시 시도해주세요.");
  }
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

function enter(tripId, name, onFail) {
  me = name;
  currentTripId = tripId;
  socket.emit("join", { tripId, userName: name }, (resp) => {
    if (resp.error) { showLandingError(resp.error); if (onFail) onFail(resp.error); return; }
    saveRecent(resp.trip);
    // 여행 전환 시 이전 여행의 추천/스크롤 상태 초기화
    recState = null; nearbyCache.clear(); nearbyInflight.clear(); recCenterCache.clear();
    geoCache.clear(); transitCache.clear(); dayMode.clear(); Object.keys(centerAttempts).forEach((k) => delete centerAttempts[k]);
    mapDayFilter = "all";
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
  try { localStorage.setItem("tp_recent", JSON.stringify(list.slice(0, 8))); } catch {}
}
function removeRecent(id) {
  try { localStorage.setItem("tp_recent", JSON.stringify(getRecent().filter((t) => t.id !== id))); } catch {}
  renderRecent();
}
function renderRecent() {
  const wrap = $("#recentWrap"), list = $("#recentList");
  const items = getRecent();
  list.innerHTML = "";
  if (!items.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const t of items) {
    const range = t.startDate ? `${fmtDate(t.startDate)}${t.endDate ? " ~ " + fmtDate(t.endDate) : ""}` : "";
    const meta = [t.destination, range].filter(Boolean).join("  ·  ");
    list.append(el("div", { class: "recent-item" },
      el("button", { class: "recent-open", onclick: () => {
        const nm = $("#nameInput").value.trim() || localStorage.getItem("tp_name");
        if (!nm) return showLandingError("이름을 먼저 입력해주세요.");
        saveName(nm);
        enter(t.id, nm, () => {
          if (confirm(`'${t.name}'을(를) 찾을 수 없어요.\n삭제됐거나 서버가 초기화됐을 수 있어요. 목록에서 지울까요?`)) removeRecent(t.id);
        });
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
// 멤버별 색상 팔레트 (색상 미지정 시 멤버 순서로 자동 배정)
const PERSON_COLORS = ["#3c6ec8", "#e0673f", "#2f9e6f", "#8b5cf6", "#e5484d", "#0891b2", "#d97706", "#db2777", "#65a30d", "#475569"];
function memberColor(name) {
  if (!name) return "#94a3b8";
  const mc = state && state.memberColors;
  let idx;
  if (mc && mc[name] != null) idx = mc[name];
  else { const arr = (state && state.members) || []; const i = arr.indexOf(name); idx = i >= 0 ? i : 0; }
  return PERSON_COLORS[((idx % PERSON_COLORS.length) + PERSON_COLORS.length) % PERSON_COLORS.length];
}
function personDot(name) { return el("span", { class: "person-dot", style: `background:${memberColor(name)}` }); }

socket.on("presence", ({ online, people }) => {
  const ppl = people || [];
  const box = $("#presence");
  box.innerHTML = "";
  if (!ppl.length) { box.textContent = `● ${online}명 접속`; return; }
  ppl.forEach((p) => box.append(el("span", { class: "pres-person" + (p.editing ? " editing" : "") },
    personDot(p.name), (p.name || "") + (p.editing ? " ✎" : ""))));
});

// 공유 모달의 멤버 색상 편집 (스와치 클릭 시 다음 색으로 순환)
function renderMemberColors() {
  const box = $("#memberColors");
  if (!box) return;
  box.innerHTML = "";
  const ms = (state && state.members) || [];
  if (!ms.length) { box.append(el("p", { class: "sub", style: "margin:0" }, "아직 멤버가 없어요.")); return; }
  ms.forEach((name) => {
    const cur = (state.memberColors && state.memberColors[name] != null) ? state.memberColors[name] : ms.indexOf(name);
    box.append(el("div", { class: "person-row" },
      el("button", { class: "person-swatch", style: `background:${memberColor(name)}`, title: "색상 바꾸기",
        onclick: () => send("setMemberColor", { name, color: (Number(cur) + 1) % PERSON_COLORS.length }) }),
      el("span", { class: "person-name" }, name)));
  });
}

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
    if (btn.dataset.tab === "recap") renderRecap(); // 사진 등 무거운 부분은 탭 열 때 로드

  });
});

$("#tripTitle").addEventListener("change", (e) => send("renameTrip", { name: e.target.value }));

// 홈(내 여행 목록)으로 돌아가기 — 랜딩의 '이어서 계획하기'를 다시 볼 수 있게
$("#homeBtn").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname);
  $("#app").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  $("#landingError").textContent = "";
  renderRecent();
});

$("#shareBtn").addEventListener("click", () => {
  $("#shareLink").value = location.origin + "/?trip=" + currentTripId;
  renderMemberColors();
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

// 탭 복귀 시 밀린 렌더 폴백 flush
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pendingRender) { pendingRender = false; render(); }
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
  renderRecap();
  if (!$("#shareModal").classList.contains("hidden")) renderMemberColors(); // 모달 열려 있으면 색상 갱신
  if ($("#tab-plan").classList.contains("active")) { if (!map) showMap(); else updateMap(); }
}
