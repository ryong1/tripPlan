// 최소 서비스워커 — 홈 화면 설치(PWA) 가능하게 하는 용도 (오프라인 캐싱은 하지 않음)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
