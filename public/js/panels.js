// panels: 일정 항목 상세·드래그, 경비정산, 준비물
// 모든 앱 스크립트는 전역 스코프를 공유합니다. index.html의 로드 순서(core→geo→map→itinerary→recs→panels)를 지켜야 합니다.


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
    el("span", { class: "acc-icon", title: "장소 종류" }, placeIcon(it.place)),
    el("span", { class: "acc-title" }, it.place || "(제목 없음)"),
    ...(it.addr && !isOpen ? [el("span", { class: "acc-sub" }, it.addr.split(",")[0])] : []),
    ...(it.lat == null && !isOpen ? [el("span", { class: "acc-nogeo", title: "위치를 못 찾아 이동시간 계산에서 제외돼요. 항목을 눌러 위치를 지정하세요." }, "위치 없음")] : []),
    ...(it.link && !isOpen ? [el("button", { class: "tiny link-chip", title: it.link, onclick: (e) => { e.stopPropagation(); openLink(it.link); } }, "링크")] : []),
    ...(itemCost(it) > 0 ? [el("span", { class: "cost-chip", title: "이 장소 지출" }, won(itemCost(it)))] : []),
    el("button", { class: "done-btn" + (it.done ? " on" : ""), title: it.done ? "완료됨 — 해제" : "다녀왔어요 체크",
      onclick: (e) => { e.stopPropagation(); send("updateItem", { dayId: day.id, id: it.id, done: !it.done }); } }, "✓"),
    el("button", { class: "del tiny", onclick: () => send("removeItem", { dayId: day.id, id: it.id }) }, "✕")
  );
  wrap.append(summary);

  if (isOpen) {
    const body = el("div", { class: "acc-body" });
    // 장소 정보: 사진·주소·지도 링크 (좌표 있을 때)
    if (it.lat != null && it.place) {
      const kakao = `https://map.kakao.com/link/map/${encodeURIComponent(it.place)},${it.lat},${it.lon}`;
      const google = `https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lon}`;
      body.append(el("div", { class: "place-info" },
        thumbEl({ name: it.place, lat: it.lat, lon: it.lon, category: "attraction", addr: it.addr }),
        el("div", { class: "place-info-body" },
          el("div", { class: "place-info-name" }, it.place),
          el("div", { class: "place-info-addr" }, it.addr ? it.addr.split(",").slice(0, 3).join(", ") : `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}`),
          el("div", { class: "place-info-actions" },
            el("button", { class: "tiny", onclick: () => { focusRec = { name: it.place, lat: it.lat, lon: it.lon }; if (typeof updateMap === "function") updateMap(); const mc = $("#mapCanvas"); if (mc) mc.scrollIntoView({ behavior: "smooth", block: "center" }); } }, "지도에서 보기"),
            el("button", { class: "tiny", onclick: () => window.open(kakao, "_blank", "noopener") }, "카카오맵"),
            el("button", { class: "tiny", onclick: () => window.open(google, "_blank", "noopener") }, "구글맵"),
            ...(it.link ? [el("button", { class: "tiny", onclick: () => openLink(it.link) }, "링크")] : []),
            el("button", { class: "tiny del", onclick: () => send("updateItem", { dayId: day.id, id: it.id, lat: null, lon: null, addr: "" }) }, "위치 지우기")))));
    }
    body.append(
      field("장소·활동", el("input", { type: "text", value: it.place,
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, place: e.target.value }) })),
      field("메모", el("input", { type: "text", value: it.memo,
        onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, memo: e.target.value }) })),
      field("지출 금액 (원)", el("div", { class: "cost-input" },
        el("input", { type: "number", min: "0", inputmode: "numeric", value: it.cost || "",
          onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, cost: Math.max(0, Number(e.target.value) || 0) }) }),
        el("span", { class: "cost-won" }, "원"))),
      field("링크", el("div", { class: "row" },
        el("input", { type: "url", value: it.link || "",
          onchange: (e) => send("updateItem", { dayId: day.id, id: it.id, link: e.target.value.trim() }) }),
        ...(it.link ? [el("button", { class: "tiny", onclick: () => openLink(it.link) }, "열기")] : [])))
    );
    if (it.lat == null) {
      body.append(el("div", { class: "acc-field" },
        el("label", {}, "위치 지정"),
        searchBox("장소/주소 검색", async (r) => { const g = await ensureCoords(r); send("updateItem", { dayId: day.id, id: it.id, place: it.place || g.name, addr: g.addr || "", lat: g.lat ?? null, lon: g.lon ?? null }); })));
    }
    wrap.append(body);
  }
  return wrap;
}

function field(label, input) {
  return el("div", { class: "acc-field" }, el("label", {}, label), input);
}

// 장소 이름 키워드로 종류 아이콘을 대략 추정
function placeIcon(name) {
  const s = String(name || "");
  const any = (arr) => arr.some((k) => s.includes(k));
  if (any(["카페", "커피", "로스터", "베이커리", "디저트"])) return "☕";
  if (any(["해변", "해수욕", "바다", "해안", "비치", "포구", "항구"])) return "🏖️";
  if (any(["시장", "마켓"])) return "🛒";
  if (any(["박물관", "미술관", "전시", "갤러리", "과학관", "기념관"])) return "🏛️";
  if (any(["호텔", "펜션", "게스트", "모텔", "리조트", "숙소", "스테이", "호스텔"])) return "🛏️";
  if (any(["온천", "스파", "찜질"])) return "♨️";
  if (any(["공원", "정원", "수목원", "숲"])) return "🌳";
  if (any(["산", "봉우리", "계곡", "국립공원", "등산", "둘레길", "폭포", "전망대", "케이블카", "타워"])) return "⛰️";
  if (any(["절", "사찰", "서원", "향교", "한옥", "사원", "궁"])) return "🏯";
  if (any(["회", "물회", "횟집", "식당", "맛집", "고기", "국밥", "순대", "게찜", "먹거리", "분식", "국수", "정식", "뷔페", "밥집"])) return "🍽️";
  if (any(["펍", "호프", "와인", "맥주", "포차"])) return "🍺";
  if (any(["쇼핑", "백화점", "아울렛", "면세"])) return "🛍️";
  return "📍";
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

  // 예산 대비 지출 (경비정산 + 일정 항목 지출 합산)
  const expSpent = state.expenses.reduce((s, e) => s + e.amount, 0);
  const itinSpent = tripSpent();
  const spent = expSpent + itinSpent;
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
        `지출 ${won(spent)} / 총예산 ${won(totalBudget)} · ` + (over ? `${won(spent - totalBudget)} 초과` : `${won(totalBudget - spent)} 남음`)),
      ...(itinSpent > 0 ? [el("div", { class: "budget-nums", style: "margin-top:2px" }, `(경비 ${won(expSpent)} + 일정 지출 ${won(itinSpent)})`)] : [])
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
          el("div", { style: "font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px" },
            personDot(e.payer), `${e.payer || "?"} 결제 · ${e.sharedBy.length}명 분담`)
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
    // 지분을 정수 원으로 배분: 몫은 균등, 나머지는 앞에서부터 1원씩 추가로 차감
    const n = sharers.length;
    const per = Math.floor(e.amount / n);
    let rem = e.amount - per * n;
    for (const s of sharers) { touch(s); bal[s] -= per; if (rem > 0) { bal[s] -= 1; rem -= 1; } }
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

  // 지역 날씨 (여행 날짜별)
  if (typeof weatherByDate !== "undefined" && weatherByDate) {
    const wdays = state.itinerary.filter((d) => d.date && weatherByDate[d.date]);
    if (wdays.length) {
      const wc = el("div", { class: "card" });
      wc.append(el("div", { class: "card-head" },
        el("h3", {}, `${state.destination || "여행지"} 날씨`),
        el("span", { style: "font-size:12px;color:var(--muted)" }, weatherNormal ? "예년 기준" : "예보")));
      const row = el("div", { class: "weather-days" });
      wdays.forEach((d) => {
        const w = weatherByDate[d.date];
        row.append(el("div", { class: "weather-day" },
          el("div", { class: "wd-date" }, fmtDate(d.date) || ""),
          el("div", { class: "wd-icon" }, wmoIcon(w.code)),
          el("div", { class: "wd-temp" }, w.tmax != null ? `${Math.round(w.tmax)}° / ${Math.round(w.tmin)}°` : "—")));
      });
      wc.append(row);
      root.append(wc);
    }
  }

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

  // 날씨 기반 추천 (이미 목록에 있는 항목은 제외)
  const sug = weatherPackSuggest().filter((s) => !state.packing.some((p) => p.text === s.item));
  if (sug.length) {
    const box = el("div", { class: "card" });
    box.append(el("div", { class: "card-head" },
      el("h3", {}, "날씨 추천 준비물"),
      el("span", { style: "color:var(--muted);font-size:13px" }, weatherNormal ? "예년 날씨 기준" : "예보 기준")));
    const chips = el("div", { class: "pack-suggest" });
    sug.forEach((s) => chips.append(el("button", { class: "chip", title: s.reason,
      onclick: () => send("addPacking", { text: s.item, assignee: "" }) }, "+ " + s.item)));
    box.append(chips);
    root.append(box);
  }

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
      p.assignee ? el("span", { class: "assignee-tag", style: `background:${memberColor(p.assignee)};color:#fff` }, p.assignee) : null,
      el("button", { class: "del tiny", onclick: () => send("removePacking", { id: p.id }) }, "✕")
    ));
  }
  root.append(card);
}
