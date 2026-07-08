// recs: 지역 추천 장소(카카오/OSM), 추천 이미지, 추천 상세/카드
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.

/* ── 지역 추천 장소 (목적지 기준, OSM Overpass) ── */
let recState = null;              // null=닫힘, 아니면 category id
const nearbyCache = new Map();    // `${lat3},${lon3}|${cat}` -> items[]
const nearbyInflight = new Set();
const recCenterCache = new Map(); // destination -> {lat,lon} | null | "pending"
const NEARBY_CATS = [{ id: "restaurant", label: "식당" }, { id: "cafe", label: "카페" }, { id: "attraction", label: "볼거리" }, { id: "hotel", label: "숙소" }, { id: "shopping", label: "쇼핑" }];

// 내부 카테고리 → 카카오 category_group_code (쇼핑은 코드가 없어 키워드로)
const KAKAO_CAT_CODE = { restaurant: "FD6", cafe: "CE7", attraction: "AT4", hotel: "AD5" };
function kakaoNearby(lat, lon, category, radius) {
  return new Promise((resolve) => {
    try {
      const ps = new window.kakao.maps.services.Places();
      const opts = {
        location: new window.kakao.maps.LatLng(lat, lon),
        radius: Math.min(radius, 20000),
        sort: window.kakao.maps.services.SortBy.DISTANCE,
      };
      const cb = (data, status) => resolve(
        status === window.kakao.maps.services.Status.OK && Array.isArray(data)
          ? data.map((d) => { const o = kakaoDoc(d); if (!o.category) o.category = category; return o; })
          : []
      );
      const code = KAKAO_CAT_CODE[category];
      if (code) ps.categorySearch(code, cb, opts);
      else ps.keywordSearch("쇼핑", cb, opts);
    } catch { resolve([]); }
  });
}

async function searchNearby(lat, lon, category, radius = 1200) {
  // 국내면 카카오 카테고리 검색 우선, 결과 없거나 해외면 OSM(Overpass)
  if (inKorea({ lat, lon }) && await ensureKakao()) {
    const r = await kakaoNearby(lat, lon, category, radius);
    if (r.length) return r;
  }
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
  artwork: "예술작품", zoo: "동물원", aquarium: "아쿠아리움", gallery: "갤러리",
  hotel: "호텔", guest_house: "게스트하우스", hostel: "호스텔", motel: "모텔", apartment: "레지던스",
  mall: "쇼핑몰", department_store: "백화점", supermarket: "마트", convenience: "편의점", bakery: "베이커리", gift: "기념품", clothes: "의류" };
const catKr = (c) => CAT_KR[c] || "장소";

function wikiKey(rec) {
  if (!rec.wiki) return null;
  const p = rec.wiki.split(":");
  const lang = p.length > 1 ? p[0] : "ko";
  const title = p.length > 1 ? p.slice(1).join(":") : p[0];
  return { lang, title, key: `${lang}:${title}` };
}
const geoImgKey = (rec) => `geo:${rec.lat.toFixed(4)},${rec.lon.toFixed(4)}`;
const kakaoImgKey = (rec) => `kakao:${rec.name}`;
function cachedRecImage(rec) {
  if (rec.image && /^https?:\/\//i.test(rec.image)) return rec.image;
  const kk = kakaoImgKey(rec);
  if (recImgCache.has(kk) && recImgCache.get(kk)) return recImgCache.get(kk); // 카카오 성공분만 즉시 사용
  const wk = wikiKey(rec);
  if (wk && recImgCache.has(wk.key)) return recImgCache.get(wk.key);
  if (recImgCache.has(geoImgKey(rec))) return recImgCache.get(geoImgKey(rec));
  return undefined;
}
const hasHangul = (s) => /[가-힣]/.test(s || "");
// 한국 장소(이름에 한글 포함 또는 국내 목적지)는 카카오 이미지 검색 우선, 없으면 위키백과 폴백
function resolveRecImage(rec, onDone) {
  if (hasHangul(rec.name) || isDomestic()) {
    const kk = kakaoImgKey(rec);
    if (recImgCache.has(kk)) { const v = recImgCache.get(kk); if (v) { onDone(v); return; } }
    else {
      const q = ((state && state.destination ? state.destination + " " : "") + rec.name).trim();
      fetch("/api/image?q=" + encodeURIComponent(q)).then((r) => r.json()).then((d) => {
        const u = (d && d.url) || null; recImgCache.set(kk, u);
        if (u) onDone(u); else resolveWikiImage(rec, onDone);
      }).catch(() => { recImgCache.set(kk, null); resolveWikiImage(rec, onDone); });
      return;
    }
  }
  resolveWikiImage(rec, onDone);
}
function resolveWikiImage(rec, onDone) {
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
