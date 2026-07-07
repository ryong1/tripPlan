import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const logs = [];
page.on("dialog", async (d) => { logs.push("DIALOG: " + d.message().replace(/\n/g," ")); await d.accept(); });
page.on("console", (m) => { if (m.type()==="error") logs.push("CONSOLE ERR: " + m.text()); });

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });

// 1) 새 여행 만들기
await page.fill("#nameInput", "가영");
await page.fill("#tripNameInput", "오사카 우정여행");
await page.fill("#destInput", "오사카");
await page.fill("#startInput", "2026-08-01");
await page.fill("#endInput", "2026-08-03");
await page.click("#createBtn");
await page.waitForSelector("#app:not(.hidden)", { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: "shots/1-created.png" });
logs.push("생성 후 부제목: " + (await page.textContent("#tripSub")));

// 2) 가고싶은 곳 탭으로
await page.click('.tab[data-tab="places"]');
await page.waitForTimeout(300);

// 검색해서 추가하는 헬퍼
async function addBySearch(query) {
  const input = page.locator('#tab-places .search-box input').first();
  await input.click();
  await input.fill("");
  await input.type(query, { delay: 20 });
  try {
    await page.waitForSelector('#tab-places .search-item', { timeout: 6000 });
    const first = page.locator('#tab-places .search-item').first();
    const name = await first.locator('.s-name').textContent();
    await first.click();
    await page.waitForTimeout(400);
    logs.push(`검색 추가 OK: "${query}" → ${name}`);
    return true;
  } catch {
    logs.push(`검색 결과 없음: "${query}" (Enter로 직접추가 시도)`);
    await input.press("Enter");
    await page.waitForTimeout(300);
    return false;
  }
}

for (const q of ["오사카성", "도톤보리", "우메다 스카이빌딩", "신사이바시", "덴노지 동물원"]) {
  await addBySearch(q);
}
await page.waitForTimeout(300);
await page.screenshot({ path: "shots/2-places.png", fullPage: true });
const placeCount = await page.locator('#tab-places .place-head').count();
logs.push("추가된 장소 카드 수: " + placeCount);

// 3) 자동으로 일정 짜기
await page.click("#tab-places .auto-plan-card button");
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/3-autoplan.png", fullPage: true });

// 일정표 내용 추출
const days = await page.$$eval("#tab-itinerary .day-card", (cards) =>
  cards.map((c) => {
    const date = c.querySelector(".day-date")?.textContent?.trim();
    const items = [...c.querySelectorAll(".tl-item .acc-head")].map((h) => {
      const t = h.querySelector(".acc-time")?.textContent?.trim();
      const p = h.querySelector(".acc-title")?.textContent?.trim();
      return `${t} ${p}`;
    });
    return { date, items };
  })
);
logs.push("=== 자동 생성된 일정 ===");
for (const d of days) logs.push(`${d.date}: ${d.items.join(" | ")}`);

console.log(logs.join("\n"));
await browser.close();
