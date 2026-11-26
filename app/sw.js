// Network first so updates reach the iPad; falls back to the cached copy when offline.
const C="peninsula-offers-v7";
const FILES=["/","/index.html","/app/","/app/index.html","/config.js","/manifest.webmanifest","/apple-touch-icon.png","/icon-192.png","/icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)).catch(()=>{}));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&!x.endsWith("-img")).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==location.origin)return;
  // Photos never change once published: serve them from the cache first.
  if(u.pathname.startsWith("/img/")||u.pathname==="/api/media"){e.respondWith(caches.open(C+"-img").then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(res=>{if(res.ok)c.put(e.request,res.clone());return res}))));return}
  if(u.pathname.startsWith("/api/"))return; // never cache account data
  e.respondWith(fetch(e.request).then(res=>{const copy=res.clone();if(res.ok)caches.open(C).then(c=>c.put(e.request,copy)).catch(()=>{});return res})
    .catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match(u.pathname.startsWith("/app")?"/app/index.html":"/index.html"))))});

// Notifications for the team: a client booked a viewing, and so on.
self.addEventListener("push",e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:"Peninsula",body:e.data?e.data.text():""}}
  e.waitUntil(self.registration.showNotification(d.title||"Peninsula",{body:d.body||"",tag:d.tag,renotify:true,icon:"/icon-192.png",badge:"/icon-192.png",data:{url:d.url||"/app/"}}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const url=(e.notification.data&&e.notification.data.url)||"/app/";
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(l=>{for(const c of l){if(new URL(c.url).pathname.startsWith("/app")){c.focus();c.postMessage({type:"open",url});return}}return self.clients.openWindow(url)}))});
