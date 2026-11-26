// Anonymous visit counter for the Peninsula website and app: a random visitor id in this browser, the page,
// where the visitor came from, and the screen size. No cookies, no names, no IP addresses are stored.
(() => {
  try {
    if (/bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp/i.test(navigator.userAgent)) return;
    let v = "na";
    try { v = localStorage.getItem("orla.vid"); if (!v) { v = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem("orla.vid", v); } } catch (e) {}
    let ref = "";
    try { if (document.referrer && new URL(document.referrer).origin !== location.origin) ref = new URL(document.referrer).hostname; } catch (e) {}
    const q = new URLSearchParams(location.search), src = q.get("utm_source") || q.get("ref") || ref;
    window.orlaTrack = extra => {
      try {
        fetch("/api/track", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Orla": "1" },
          body: JSON.stringify(Object.assign({ vid: v, path: location.pathname, ref: src, lang: document.documentElement.lang || "", w: innerWidth }, extra || {})) }).catch(() => {});
      } catch (e) {}
    };
    window.orlaTrack();
  } catch (e) {}
})();
