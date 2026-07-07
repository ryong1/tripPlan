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

let trips = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    trips = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  }
} catch (e) {
  console.error("데이터 파일을 읽지 못했습니다:", e);
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(trips, null, 2), (err) => {
      if (err) console.error("저장 실패:", err);
    });
  }, 300);
}

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
  };
}

function applyAction(trip, action, user) {
  const { type, payload = {} } = action;
  const uid = () => randomUUID().slice(0, 8);

  switch (type) {
    case "renameTrip":
      trip.name = String(payload.name || trip.name).slice(0, 100);
      break;
    case "setBudget":
      trip.budget = Math.max(0, Number(payload.amount) || 0);
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
        if (payload.date !== undefined) d.date = payload.date;
        if (payload.title !== undefined) d.title = payload.title;
      }
      break;
    }
    case "removeDay":
      trip.itinerary = trip.itinerary.filter((x) => x.id !== payload.id);
      break;
    case "addItem": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      if (d) d.items.push({
        id: uid(), time: payload.time || "", place: payload.place || "", memo: payload.memo || "",
        lat: payload.lat ?? null, lon: payload.lon ?? null, addr: payload.addr || "", link: payload.link || "", done: false,
      });
      break;
    }
    case "updateItem": {
      const d = trip.itinerary.find((x) => x.id === payload.dayId);
      const it = d && d.items.find((i) => i.id === payload.id);
      if (it) {
        for (const k of ["time", "place", "memo", "lat", "lon", "addr", "link", "done"]) if (payload[k] !== undefined) it[k] = payload[k];
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
      for (const a of payload.assignments) {
        const d = trip.itinerary.find((x) => x.id === a.dayId);
        if (!d || !Array.isArray(a.items)) continue;
        for (const src of a.items) {
          d.items.push({
            id: uid(), time: src.time || "", place: src.place || "", memo: src.memo || "",
            lat: src.lat ?? null, lon: src.lon ?? null, addr: src.addr || "",
          });
        }
      }
      break;
    }

    case "addExpense":
      trip.expenses.push({
        id: uid(),
        desc: payload.desc || "",
        amount: Number(payload.amount) || 0,
        payer: payload.payer || "",
        sharedBy: Array.isArray(payload.sharedBy) ? payload.sharedBy : [],
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
        id: uid(), name: payload.name || "", memo: payload.memo || "", votes: [],
        lat: payload.lat ?? null, lon: payload.lon ?? null, addr: payload.addr || "",
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
      trip.packing.push({ id: uid(), text: payload.text || "", assignee: payload.assignee || "", done: false });
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
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6"
      + "&accept-language=ko&q=" + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "TravelPlanner/1.0 (personal trip planner)",
        "Accept": "application/json",
      },
    });
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

// 대중교통(지하철·버스·기차) 길찾기 프록시 — ODsay searchPubTransPathT
app.get("/api/transit", async (req, res) => {
  const key = getOdsayKey();
  if (!key) return res.json({ error: "no_key" });
  const { sx, sy, ex, ey } = req.query;
  if (!sx || !sy || !ex || !ey) return res.status(400).json({ error: "bad_params" });
  try {
    const url = "https://api.odsay.com/v1/api/searchPubTransPathT"
      + `?apiKey=${encodeURIComponent(key)}&SX=${encodeURIComponent(sx)}&SY=${encodeURIComponent(sy)}`
      + `&EX=${encodeURIComponent(ex)}&EY=${encodeURIComponent(ey)}`;
    const r = await fetch(url);
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

const server = createServer(app);
const io = new Server(server);

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
    if (!tripId || !trips[tripId]) return;
    const changed = applyAction(trips[tripId], action, userName);
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
