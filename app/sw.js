// Network first so updates reach the iPad; falls back to the cached copy when offline.
const C="peninsula-offers-v5";
const FILES=["./","./index.html","./config.js","./manifest.webmanifest","./apple-touch-icon.png","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api/"))return; // never cache account data
  e.respondWith(fetch(e.request).then(res=>{const copy=res.clone();caches.open(C).then(c=>c.put(e.request,copy)).catch(()=>{});return res}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match("./index.html"))))});
