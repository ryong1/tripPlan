import { chromium } from "playwright";
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1000, height: 1200 } });
const errs=[]; page.on("pageerror",e=>errs.push(e.message));
page.on("dialog", d=>d.accept()); // confirm
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.fill("#nameInput","가영"); await page.fill("#joinIdInput","874431ea"); await page.click("#joinBtn");
await page.waitForSelector("#app:not(.hidden)"); await page.waitForTimeout(2000);
const btns = await page.locator(".itin-actions button").allTextContents();
console.log("일정표 버튼:", btns.join(" / "));
await page.locator('.itin-actions button:has-text("추천 코스 자동 만들기")').click();
await page.waitForTimeout(9000); // 지오코딩 + Overpass 3종
const days = await page.$$eval("#tab-itinerary .day-card", cards=>cards.map(c=>({
  date: c.querySelector(".day-date")?.textContent?.trim(),
  items: [...c.querySelectorAll(".tl-item .acc-title")].map(t=>t.textContent.trim())
})));
days.forEach(d=>console.log(`${d.date}: ${d.items.join(", ")}`));
console.log("JS ERR:", errs.join(" | ")||"none");
await b.close();
