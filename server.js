import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "trips.json");
const ODSAY_KEY_FILE = join(DATA_DIR, "odsay.key");
const KAKAO_KEY_FILE = join(DATA_DIR, "kakao.key");
const GEMINI_KEY_FILE = join(DATA_DIR, "gemini.key");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ODsay 대중교통 API 키: 환경변수 ODSAY_API_KEY 우선, 없으면 data/odsay.key 파일에서 읽음(재시작 불필요)
function getOdsayKey() {
  if (process.env.ODSAY_API_KEY) return process.env.ODSAY_API_KEY.trim();
  try {
    return fs.existsSync(ODSAY_KEY_FILE) ? fs.readFileSync(ODSAY_KEY_FILE, "utf-8").trim() : "";
  } catch {
    return "";
  }
}

// 카카오 키(국내 지도·장소검색·이미지): 환경변수(KAKAO_JS_KEY / KAKAO_REST_KEY) 우선,
// 없으면 data/kakao.key(JSON {"js":"...","rest":"..."})에서 읽음. 재시작 불필요.
function getKakaoKeys() {
  let js = (process.env.KAKAO_JS_KEY || "").trim();
  let rest = (process.env.KAKAO_REST_KEY || "").trim();
  if ((!js || !rest) && fs.existsSync(KAKAO_KEY_FILE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(KAKAO_KEY_FILE, "utf-8").trim());
      js = js || (obj.js || "").trim();
      rest = rest || (obj.rest || "").trim();
    } catch { /* JSON이 아니면 무시 */ }
  }
  return { js, rest };
}

// Gemini(무료 AI 추천) 키: 환경변수 GEMINI_API_KEY 우선, 없으면 data/gemini.key 파일
function getGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return fs.existsSync(GEMINI_KEY_FILE) ? fs.readFileSync(GEMINI_KEY_FILE, "utf-8").trim() : "";
  } catch {
    return "";
  }
}
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let trips = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    trips = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  }
} catch (e) {
  console.error("데이터 파일을 읽지 못했습니다:", e);
  // 손상 파일을 백업(.bak)으로 옮기고 빈 상태로 시작 — 기존 파일 즉시 덮어쓰기 방지
  try { fs.renameSync(DATA_FILE, DATA_FILE + ".bak"); } catch (e2) { console.error("백업 실패:", e2); }
  trips = {};
}

const DATA_TMP = DATA_FILE + ".tmp";
let saveTimer = null;
let writing = false; // 쓰는 중 여부
let dirty = false;   // 쓰는 중 재요청 시 대기 플래그
function writeNow() {
  if (writing) { dirty = true; return; }
  writing = true;
  dirty = false;
  // 임시파일에 쓴 뒤 rename으로 원자적 교체
  fs.writeFile(DATA_TMP, JSON.stringify(trips, null, 2), (err) => {
    if (err) {
      console.error("저장 실패:", err);
      writing = false;
      if (dirty) writeNow();
      return;
    }
    fs.rename(DATA_TMP, DATA_FILE, (err2) => {
      if (err2) console.error("저장 실패:", err2);
      writing = false;
      if (dirty) writeNow(); // 대기 중이던 재요청 처리(직렬화)
    });
  });
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}

// 종료 시 동기 flush 후 정상 종료(디바운스 대기분 유실 방지)
function flushSync() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(trips, null, 2));
    fs.renameSync(DATA_TMP, DATA_FILE);
  } catch (e) {
    console.error("종료 저장 실패:", e);
  }
}
process.on("SIGINT", () => { flushSync(); process.exit(0); });
process.on("SIGTERM", () => { flushSync(); process.exit(0); });
process.on("beforeExit", () => { flushSync(); });

function genDays(startDate, endDate) {
  const days = [];
  if (!startDate) return days;
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date((endDate || startDate) + "T00:00:00Z");
  if (isNaN(start) || isNaN(end) || end < start) return days;
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 60) {
    const iso = cur.toISOString().slice(0, 10);
    days.push({ id: randomUUID().slice(0, 8), date: iso, title: "", items: [] });
    cur = new Date(cur.getTime() + 86400000);
    guard++;
  }
  return days;
}

function newTrip(opts = {}) {
  return {
    id: randomUUID().slice(0, 8),
    name: opts.name || "우리 여행",
    destination: opts.destination || "",
    startDate: opts.startDate || "",
    endDate: opts.endDate || "",
    createdAt: new Date().toISOString(),
    itinerary: genDays(opts.startDate, opts.endDate),
    expenses: [],
    places: [],
    packing: [],
    members: [],
    budget: 0,
    memberColors: {},
  };
}

// 좌표 정규화: null이면 null 유지, 아니면 Number 강제하되 NaN이면 null
function normCoord(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
// 링크: http(s)로 시작할 때만 저장, 아니면 ""
function normLink(v) {
  const s = String(v || "");
  return /^https?:\/\//i.test(s) ? s : "";
}

function applyAction(trip, action, user) {
  const { type } = action;
  // payload가 객체가 아니면 빈 객체로 대체
  const payload = (action.payload && typeof action.payload === "object") ? action.payload : {};
  const uid = () => randomUUID().slice(0, 8);

  switch (type) {
    case "renameTrip":
      trip.name = String(payload.name || trip.name).slice(0, 100);
      break;
    case "setBudget":
      trip.budget = Math.max(0, Number(payload.amount) || 0);
      break;
    case "setMemberColor":
      if (typeof payload.name === "string") {
        if (!trip.memberColors || typeof trip.memberColors !== "object") trip.memberColors = {};
        trip.memberColors[payload.name] = Math.max(0, Math.min(9, parseInt(payload.color) || 0));
      }
      break;
    case "updateMeta":
      if (payload.destination !== undefined) trip.destination = String(payload.destination).slice(0, 100);
      break;
    case "reorderDay": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      if (d && Array.isArray(payload.orderedIds)) {
        const map = new Map(d.items.map((i) => [i.id, i]));
        const next = [];
        for (const id of payload.orderedIds) if (map.has(id)) { next.push(map.get(id)); map.delete(id); }
        for (const leftover of map.values()) next.push(leftover);
        d.items = next;
      }
      break;
    }

    case "addDay":
      trip.itinerary.push({ id: uid(), date: payload.date || "", title: payload.title || "", items: [] });
      break;
    case "updateDay": {
      const d = trip.itinerary.find((x) => x.id === payload.id);
      if (d) {
        if (payload.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) d.date = String(payload.date);
        if (payload.title !== undefined) d.title = String(payload.title).slice(0, 300);
      }
      break;
    }
    case "removeDay":
      trip.itinerary = trip.itinerary.filter((x) => x.id !== payload.id);
      break;
    case "addItem": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      if (d) d.items.push({
        id: uid(), time: payload.time || "", place: String(payload.place || "").slice(0, 500), memo: String(payload.memo || "").slice(0, 500),
        lat: normCoord(payload.lat), lon: normCoord(payload.lon), addr: String(payload.addr || "").slice(0, 500), link: normLink(payload.link),
        cost: Math.max(0, Number(payload.cost) || 0), done: false,
      });
      break;
    }
    case "updateItem": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      const it = d && d.items.find((i) => i.id === payload.id);
      if (it) {
        if (payload.time !== undefined) it.time = payload.time;
        if (payload.place !== undefined) it.place = String(payload.place).slice(0, 500);
        if (payload.memo !== undefined) it.memo = String(payload.memo).slice(0, 500);
        if (payload.addr !== undefined) it.addr = String(payload.addr).slice(0, 500);
        if (payload.lat !== undefined) it.lat = normCoord(payload.lat);
        if (payload.lon !== undefined) it.lon = normCoord(payload.lon);
        if (payload.link !== undefined) it.link = normLink(payload.link);
        if (payload.done !== undefined) it.done = !!payload.done;
        if (payload.cost !== undefined) it.cost = Math.max(0, Number(payload.cost) || 0);
      }
      break;
    }
    case "removeItem": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      if (d) d.items = d.items.filter((i) => i.id !== payload.id);
      break;
    }

    case "autoPlan": {
      if (!Array.isArray(payload.assignments)) return false;
      if (payload.replace) for (const d of trip.itinerary) d.items = [];
      for (const a of payload.assignments.slice(0, 60)) {
        if (!a || typeof a !== "object") continue;
        const d = trip.itinerary.find((x) => x.id === a.dayId);
        if (!d || !Array.isArray(a.items)) continue;
        for (const src of a.items.slice(0, 200)) {
          d.items.push({
            id: uid(), time: src.time || "", place: String(src.place || "").slice(0, 500), memo: String(src.memo || "").slice(0, 500),
            lat: normCoord(src.lat), lon: normCoord(src.lon), addr: String(src.addr || "").slice(0, 500),
          });
        }
      }
      break;
    }

    case "reflow": {
      // 기존 항목(메모·링크·완료 등)을 보존하며 날짜/순서만 재배치
      if (!Array.isArray(payload.assignments)) return false;
      const byId = {};
      for (const d of trip.itinerary) for (const it of d.items) byId[it.id] = it;
      for (const d of trip.itinerary) d.items = [];
      for (const a of payload.assignments.slice(0, 60)) {
        if (!a || typeof a !== "object") continue;
        const d = trip.itinerary.find((x) => x.id === a.dayId);
        if (!d || !Array.isArray(a.items)) continue;
        for (const s of a.items.slice(0, 200)) {
          const it = byId[s.id];
          if (!it) continue;
          if (s.time !== undefined) it.time = s.time;
          d.items.push(it);
          delete byId[s.id];
        }
      }
      const leftover = Object.values(byId);
      if (leftover.length && trip.itinerary[0]) trip.itinerary[0].items.push(...leftover);
      break;
    }

    case "addExpense":
      trip.expenses.push({
        id: uid(),
        desc: String(payload.desc || "").slice(0, 300),
        amount: Math.max(0, Number(payload.amount) || 0),
        payer: payload.payer || "",
        sharedBy: Array.isArray(payload.sharedBy) ? payload.sharedBy.filter((x) => typeof x === "string").slice(0, 50) : [],
      });
      break;
    case "updateExpense": {
      const e = trip.expenses.find((x) => x.id === payload.id);
      if (e) {
        if (payload.desc !== undefined) e.desc = payload.desc;
        if (payload.amount !== undefined) e.amount = Number(payload.amount) || 0;
        if (payload.payer !== undefined) e.payer = payload.payer;
        if (payload.sharedBy !== undefined) e.sharedBy = payload.sharedBy;
      }
      break;
    }
    case "removeExpense":
      trip.expenses = trip.expenses.filter((x) => x.id !== payload.id);
      break;

    case "addPlace":
      trip.places.push({
        id: uid(), name: String(payload.name || "").slice(0, 300), memo: String(payload.memo || "").slice(0, 300), votes: [],
        lat: payload.lat ?? null, lon: payload.lon ?? null, addr: String(payload.addr || "").slice(0, 300),
      });
      break;
    case "updatePlace": {
      const p = trip.places.find((x) => x.id === payload.id);
      if (p) {
        for (const k of ["name", "memo", "lat", "lon", "addr"]) if (payload[k] !== undefined) p[k] = payload[k];
      }
      break;
    }
    case "removePlace":
      trip.places = trip.places.filter((x) => x.id !== payload.id);
      break;
    case "toggleVote": {
      const p = trip.places.find((x) => x.id === payload.id);
      if (p && user) {
        const i = p.votes.indexOf(user);
        if (i >= 0) p.votes.splice(i, 1);
        else p.votes.push(user);
      }
      break;
    }

    case "addPacking":
      trip.packing.push({ id: uid(), text: String(payload.text || "").slice(0, 300), assignee: payload.assignee || "", done: false });
      break;
    case "updatePacking": {
      const p = trip.packing.find((x) => x.id === payload.id);
      if (p) {
        if (payload.text !== undefined) p.text = payload.text;
        if (payload.assignee !== undefined) p.assignee = payload.assignee;
        if (payload.done !== undefined) p.done = !!payload.done;
      }
      break;
    }
    case "removePacking":
      trip.packing = trip.packing.filter((x) => x.id !== payload.id);
      break;

    default:
      return false;
  }
  return true;
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.post("/api/trips", (req, res) => {
  const trip = newTrip(req.body || {});
  trips[trip.id] = trip;
  persist();
  res.json({ id: trip.id });
});

app.get("/api/geo/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  // 목적지 좌표(lat/lon)가 오면 그 주변으로 검색 범위를 제한 (엉뚱한 지역 방지)
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  let bias = "";
  if (!isNaN(lat) && !isNaN(lon)) {
    const d = 0.4; // 약 ±40km 박스
    bias = `&viewbox=${lon - d},${lat + d},${lon + d},${lat - d}&bounded=1`;
  }
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6"
      + "&accept-language=ko" + bias + "&q=" + encodeURIComponent(q);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000); // 응답 지연 시 중단 (요청 매달림 방지)
    let r;
    try {
      r = await fetch(url, {
        headers: {
          "User-Agent": "TravelPlanner/1.0 (personal trip planner)",
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json();
    res.json(
      (Array.isArray(data) ? data : []).map((x) => ({
        name: (x.name || String(x.display_name).split(",")[0]).split(";")[0].trim(),
        addr: x.display_name,
        lat: parseFloat(x.lat),
        lon: parseFloat(x.lon),
      }))
    );
  } catch (e) {
    res.status(502).json({ error: "search_failed" });
  }
});

// 클라이언트 설정 — 카카오 지도 JS 키만 노출(도메인 잠금됨). REST 키는 서버에만 둔다.
app.get("/api/config", (req, res) => {
  const { js } = getKakaoKeys();
  res.json({ kakaoJsKey: js || "" });
});

// 장소 사진 — 카카오 이미지 검색 프록시 (REST 키 사용, 국내 장소 커버리지 좋음)
const imgCache = new Map(); // query -> url|null
app.get("/api/image", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ url: null });
  if (imgCache.has(q)) return res.json({ url: imgCache.get(q) });
  const { rest } = getKakaoKeys();
  if (!rest) return res.json({ url: null, error: "no_key" });
  try {
    const url = "https://dapi.kakao.com/v2/search/image?size=1&sort=accuracy&query=" + encodeURIComponent(q);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let r;
    try {
      r = await fetch(url, { headers: { Authorization: "KakaoAK " + rest }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return res.json({ url: null });
    const data = await r.json();
    const doc = data.documents && data.documents[0];
    const img = doc ? (doc.thumbnail_url || doc.image_url || null) : null;
    if (imgCache.size > 2000) imgCache.clear(); // 단순 상한
    imgCache.set(q, img);
    res.json({ url: img });
  } catch {
    res.json({ url: null });
  }
});

// AI 추천 코스 — Gemini(무료 티어) 프록시. 실제 장소명으로 하루 흐름의 일정을 JSON으로 생성.
app.get("/api/ai/course", async (req, res) => {
  const key = getGeminiKey();
  if (!key) return res.json({ error: "no_key" });
  const dest = String(req.query.dest || "").trim();
  const days = Math.min(10, Math.max(1, parseInt(req.query.days) || 1));
  if (!dest) return res.status(400).json({ error: "bad_params" });
  // 여행 스타일 + 꼭 넣고 싶은 요소 (클라이언트 옵션)
  const STYLE_KR = {
    activity: "액티비티·체험 위주(해양 레저, 트레킹, 놀거리 등 활동적인 일정)",
    healing: "여유롭고 서정적인 힐링 위주(자연 풍경, 조용한 산책, 감성 스팟)",
    food: "맛집·먹거리 탐방 위주",
    balanced: "관광·맛집·휴식이 고루 섞인 균형 잡힌 구성",
  };
  const style = STYLE_KR[String(req.query.style)] || STYLE_KR.balanced;
  const musts = String(req.query.musts || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const mustsLine = musts.length ? `\n- 여행 중 다음 요소를 반드시 포함하세요: ${musts.join(", ")}.` : "";
  const prompt = `당신은 한국 여행 전문 플래너입니다. 목적지 "${dest}"에서 ${days}일 여행 일정을 만들어 주세요.
각 날은 하루 4~6곳을 "오전 관광 → 점심 식당 → 오후 관광/체험 → 카페 → 저녁 식당" 흐름으로 구성하세요.
규칙:
- 여행 스타일: ${style}.${mustsLine}
- 실제로 존재하는 유명하고 평이 좋은 장소명을 한국어로 정확하게 쓰세요.
- 한 항목에는 반드시 한 장소만. "&"나 쉼표로 여러 장소를 묶지 마세요.
- 각 장소에 방문 시간(time, HH:MM 24시간제)과 한 줄 추천 이유(memo, 25자 내외)를 붙이세요.
- 각 장소의 대략적인 위도(lat)·경도(lon)를 소수점 좌표로 반드시 포함하세요(지도 표시용).
반드시 다음 JSON 형식으로만 답하세요:
{"days":[{"items":[{"place":"장소명","time":"10:00","memo":"이유","lat":38.20,"lon":128.59}]}]}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return res.status(502).json({ error: "gemini_failed", status: r.status });
    const data = await r.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    if (!text) return res.status(502).json({ error: "empty" });
    let parsed;
    try { parsed = JSON.parse(text); } catch { return res.status(502).json({ error: "parse_failed" }); }
    if (!parsed || !Array.isArray(parsed.days)) return res.status(502).json({ error: "bad_shape" });
    res.json(parsed);
  } catch (e) {
    if (e.name === "AbortError") return res.status(502).json({ error: "gemini_timeout" });
    res.status(502).json({ error: "gemini_failed" });
  }
});

// 대중교통(지하철·버스·기차) 길찾기 프록시 — ODsay searchPubTransPathT
app.get("/api/transit", async (req, res) => {
  const key = getOdsayKey();
  if (!key) return res.json({ error: "no_key" });
  const { sx, sy, ex, ey } = req.query;
  const nsx = parseFloat(sx), nsy = parseFloat(sy), nex = parseFloat(ex), ney = parseFloat(ey);
  if (![nsx, nsy, nex, ney].every(Number.isFinite)) return res.status(400).json({ error: "bad_params" });
  try {
    const url = "https://api.odsay.com/v1/api/searchPubTransPathT"
      + `?apiKey=${encodeURIComponent(key)}&SX=${encodeURIComponent(nsx)}&SY=${encodeURIComponent(nsy)}`
      + `&EX=${encodeURIComponent(nex)}&EY=${encodeURIComponent(ney)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let r;
    try {
      r = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json();
    const err = Array.isArray(data.error) ? data.error[0] : data.error;
    if (err) return res.json({ error: "odsay", code: err.code, message: err.message || err.msg || "" });
    const paths = data.result && Array.isArray(data.result.path) ? data.result.path : [];
    if (!paths.length) return res.json({ found: false });
    const p = paths[0];
    const pathTypeMap = { 1: "지하철", 2: "버스", 3: "버스+지하철", 11: "기차", 12: "버스", 13: "항공" };
    const trafficMap = { 1: "지하철", 2: "버스", 3: "도보", 4: "기차", 5: "고속버스", 6: "시외버스", 7: "항공" };
    const laneName = (lane) => {
      const L = Array.isArray(lane) ? lane[0] : lane;
      return L ? (L.name || L.busNo || "") : "";
    };
    const legs = (p.subPath || []).map((s) => ({
      type: trafficMap[s.trafficType] || "",
      time: s.sectionTime || 0,
      name: s.trafficType === 3 ? "도보" : laneName(s.lane),
      from: s.startName || "",
      to: s.endName || "",
    }));
    res.json({
      found: true,
      pathType: p.pathType,
      mode: pathTypeMap[p.pathType] || "대중교통",
      totalTime: p.info.totalTime,
      payment: p.info.payment || 0,
      transfers: (p.info.busTransitCount || 0) + (p.info.subwayTransitCount || 0),
      legs,
    });
  } catch (e) {
    res.status(502).json({ error: "transit_failed" });
  }
});

// 주변 명소·맛집 추천 프록시 — OSM Overpass
app.get("/api/nearby", async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: "bad_coords" });
  }
  const radius = Math.min(3000, Math.max(200, parseInt(req.query.radius) || 1200));
  const filters = {
    restaurant: "[amenity=restaurant]",
    cafe: "[amenity=cafe]",
    attraction: '[tourism~"^(attraction|museum|viewpoint|theme_park|artwork|zoo|aquarium|gallery)$"]',
    hotel: '[tourism~"^(hotel|guest_house|hostel|motel|apartment)$"]',
    shopping: '[shop~"^(mall|department_store|supermarket|convenience|bakery|gift|clothes)$"]',
  };
  const f = filters[String(req.query.category)] || filters.restaurant;
  const query = `[out:json][timeout:20];(nwr(around:${radius},${lat},${lon})${f};);out center 40;`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "TravelPlanner/1.0 (nearby POI search)" },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (r.status === 429 || r.status === 503) return res.status(502).json({ error: "overpass_busy" });
    if (!r.ok) return res.status(502).json({ error: "nearby_failed" });
    const data = await r.json();
    const els = Array.isArray(data.elements) ? data.elements : [];
    const seen = new Set();
    const results = [];
    for (const e of els) {
      const t = e.tags || {};
      const elat = e.lat ?? (e.center && e.center.lat);
      const elon = e.lon ?? (e.center && e.center.lon);
      if (elat == null || elon == null) continue;
      const name = t.name || t["name:ko"] || "";
      if (!name) continue; // 이름 없는 POI는 담을 의미 없어 제외
      const key = `${name}@${elat.toFixed(4)},${elon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const addr = [t["addr:city"], t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
      results.push({
        name, lat: elat, lon: elon, category: t.amenity || t.tourism || t.shop || "", addr,
        image: t.image || t["image:0"] || "",
        wiki: t.wikipedia || "",
        cuisine: t.cuisine || "",
        phone: t.phone || t["contact:phone"] || "",
        website: t.website || t["contact:website"] || "",
      });
      if (results.length >= 40) break;
    }
    res.json(results);
  } catch (e) {
    if (e.name === "AbortError") return res.status(502).json({ error: "overpass_timeout" });
    res.status(502).json({ error: "nearby_failed" });
  }
});

const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 262144 });

const presence = {}; // tripId -> Map(socketId -> { name, editing })
function presenceFor(id) {
  const m = presence[id];
  if (!m) return { online: 0, people: [] };
  const byName = new Map(); // 같은 이름(여러 탭)은 하나로 합침
  for (const { name, editing } of m.values()) {
    const cur = byName.get(name) || { name, editing: false };
    cur.editing = cur.editing || !!editing;
    byName.set(name, cur);
  }
  const people = [...byName.values()];
  return { online: people.length, people };
}

io.on("connection", (socket) => {
  let tripId = null;
  let userName = null;

  socket.on("join", ({ tripId: id, userName: name }, cb) => {
    const trip = trips[id];
    if (!trip) {
      if (cb) cb({ error: "여행을 찾을 수 없어요." });
      return;
    }
    tripId = id;
    userName = (name || "익명").slice(0, 30);
    socket.join(id);
    (presence[id] = presence[id] || new Map()).set(socket.id, { name: userName, editing: false });
    if (userName && !trip.members.includes(userName)) {
      trip.members.push(userName);
      persist();
    }
    if (cb) cb({ trip });
    io.to(id).emit("state", trips[id]);
    io.to(id).emit("presence", presenceFor(id));
  });

  socket.on("action", (action) => {
    if (!action || typeof action !== "object") return;
    if (!tripId || !trips[tripId]) return;
    let changed = false;
    try {
      changed = applyAction(trips[tripId], action, userName);
    } catch (e) {
      console.error("액션 처리 실패:", e);
      return;
    }
    if (changed) {
      persist();
      io.to(tripId).emit("state", trips[tripId]);
    }
  });

  socket.on("editing", ({ editing } = {}) => {
    if (!tripId || !presence[tripId]) return;
    const e = presence[tripId].get(socket.id);
    if (e && e.editing !== !!editing) {
      e.editing = !!editing;
      io.to(tripId).emit("presence", presenceFor(tripId));
    }
  });

  socket.on("disconnect", () => {
    if (tripId && presence[tripId]) {
      presence[tripId].delete(socket.id);
      if (presence[tripId].size === 0) delete presence[tripId];
      io.to(tripId).emit("presence", presenceFor(tripId));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  여행 플래너 실행 중 →  http://localhost:${PORT}\n`);
});
