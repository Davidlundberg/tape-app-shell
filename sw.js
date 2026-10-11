/* Tape service worker.
 *
 * VERSION is in lockstep with APP_VERSION in index.html. Bump both on every
 * shell change, or phones keep serving the old shell.
 *
 * Strategy:
 *   - Shell (index.html, manifest, icons, the pinned supabase-js UMD): cache-first,
 *     precached at install. Navigations are answered with the cached index.html.
 *   - Google Fonts: cache-first runtime cache; a miss offline falls back to the
 *     system font, never an error.
 *   - Everything else passes straight through to the network and is NEVER cached:
 *     *.supabase.co (auth + the tape_content row) and content/*.json. The deck's
 *     offline copy lives in localStorage (tape.deck.v1), owned by the page.
 * All shell paths are relative so the precache resolves under any Pages subpath.
 */
var VERSION = "1.0.0";
var SHELL_CACHE = "tape-shell-" + VERSION;
var FONT_CACHE = "tape-fonts-" + VERSION;
var SUPABASE_UMD = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.min.js";
var SHELL = [
  "index.html",
  "manifest.webmanifest",
  "static/icon-180.png",
  "static/icon-192.png",
  "static/icon-512.png",
  "static/icon-512-maskable.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      // {cache:"reload"} bypasses the HTTP cache so a version bump precaches the fresh shell.
      var local = SHELL.map(function (u) { return new Request(u, { cache: "reload" }); });
      // CORS mode so the cached response still satisfies the page's SRI check.
      var umd = new Request(SUPABASE_UMD, { mode: "cors", credentials: "omit" });
      return c.addAll(local).then(function () {
        return fetch(umd).then(function (r) { if (r.ok) return c.put(umd, r); }).catch(function () {});
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys
        .filter(function (k) { return k.indexOf("tape-") === 0 && k !== SHELL_CACHE && k !== FONT_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isContentJson(url) { return /\/content\/[^/]*\.json$/i.test(url.pathname); }

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Never intercept or cache Supabase (auth, content row) or deck files.
  if (url.hostname === "supabase.co" || url.hostname.slice(-12) === ".supabase.co") return;
  if (url.origin === self.location.origin && isContentJson(url)) return;

  // The pinned supabase-js UMD: cache-first.
  if (req.url === SUPABASE_UMD) {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }

  // Google Fonts: cache-first; offline miss -> empty CSS / no font (system fallback).
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONT_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) {
          if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone());
          return r;
        }).catch(function () {
          return new Response("", { status: 200, headers: { "Content-Type": url.hostname === "fonts.googleapis.com" ? "text/css" : "font/woff2" } });
        });
      });
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Navigations: the cached shell (query strings such as ?deck= are ignored).
  if (req.mode === "navigate") {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match("index.html").then(function (hit) { return hit || fetch(req); });
    }));
    return;
  }

  // Shell assets within scope: cache-first. Anything else in scope passes through uncached.
  var scopePath = new URL(self.registration.scope).pathname;
  var rel = url.pathname.indexOf(scopePath) === 0 ? url.pathname.slice(scopePath.length) : null;
  if (rel !== null && SHELL.indexOf(rel) >= 0) {
    e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
      return c.match(rel).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(rel, r.clone()); return r; });
      });
    }));
  }
});
