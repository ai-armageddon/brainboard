// The small script /api/browse adds to every page it serves. It runs inside the shared browser's sandboxed
// frame, before any of the page's own scripts, and talks to the board with postMessage:
//   - for the person driving, it reports where they scroll, point, click and type, and turns link clicks and
//     form submissions into requests to load the next page;
//   - for everyone watching, it replays those on their copy of the page.
// Elements are named by their position under <body>, which is the same in every copy of the same HTML.
// Scroll and pointer positions travel as "this far into that element" as well as in pixels, because fonts,
// ads and lazy content make the same page a slightly different height on every machine.
//
// Plain ES5-style JavaScript kept in a string: it is sent to the page as text, never run by the server.
// (No backticks or closing script tags in here.)
export const PAGE_SCRIPT = String.raw`function (cfg) {
  'use strict';
  var host = window.parent;
  if (!host || host === window) return;
  var drive = false, replaying = false, who = null, want = null;

  function post(m) { m.bb = 1; try { host.postMessage(m, '*'); } catch (e) {} }

  // ---- the frame has no origin of its own, so storage and cookies throw. Give pages harmless stand-ins.
  function memoryStore() {
    var d = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; },
      clear: function () { d = {}; },
      key: function (i) { return Object.keys(d)[i] || null; },
      get length() { return Object.keys(d).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name]; } catch (e) {
      try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (e2) {}
    }
  });
  try { void document.cookie; } catch (e) {
    try { Object.defineProperty(document, 'cookie', { get: function () { return ''; }, set: function () {}, configurable: true }); } catch (e2) {}
  }

  // ---- sites that change the address themselves: that would throw here, so keep track of it instead.
  var virtual = cfg.url;
  var here = location.origin + location.pathname, ours = { b: 1, k: 1, n: 1, u: 1 };
  /** An address the page built from where the frame really is means "this page, with these changes". */
  function real(url) {
    var u = new URL(String(url), virtual);
    if (u.origin + u.pathname !== here) return u.href;
    var out = new URL(virtual);
    u.searchParams.forEach(function (v, k) { if (!ours[k]) out.searchParams.set(k, v); });
    if (u.hash) out.hash = u.hash;
    return out.href;
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function (state, title, url) {
      if (url !== undefined && url !== null) {
        try { virtual = real(url); } catch (e) {}
        if (drive && !replaying) post({ t: 'loc', url: virtual });
      }
      try { return original.call(history, state, title); } catch (e) {}
    };
  });

  // ---- naming elements and points
  function pathOf(el) {
    var p = [];
    while (el && el !== document.body) {
      var parent = el.parentElement;
      if (!parent) return null;
      var i = 0, s = el;
      while ((s = s.previousElementSibling)) i++;
      p.unshift(i);
      el = parent;
    }
    return el && p.length <= 64 ? p : null;
  }
  function byPath(p) {
    var el = document.body;
    for (var i = 0; el && i < p.length; i++) el = el.children[p[i]];
    return el || null;
  }
  function anchorAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var p = el && pathOf(el);
    if (!p) return undefined;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return undefined;
    return { p: p, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
  }
  function pointOf(a) {
    var el = a && document.body && byPath(a.p);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
  }
  /** Headers and sidebars that stay put say nothing about how far the page has scrolled. */
  function pinned(el) {
    for (var n = 0; el && el !== document.documentElement && n < 40; n++, el = el.parentElement) {
      var pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  // ---- driving: report what happens
  var scrollQueued = false, innerQueued = null, cursorQueued = false, cx = 0, cy = 0;
  function sendScroll() {
    scrollQueued = false;
    if (!drive) return;
    var e = { k: 'scroll', x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var el = document.elementFromPoint(mx, my);
    if (el && !pinned(el)) e.a = anchorAt(mx, my);
    post({ t: 'ev', e: e });
  }
  function sendInnerScroll() {
    var el = innerQueued;
    innerQueued = null;
    var p = drive && el && pathOf(el);
    if (p) post({ t: 'ev', e: { k: 'escroll', p: p, x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) } });
  }
  window.addEventListener('scroll', function (e) {
    if (!drive) return;
    if (e.target === document) {
      if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(sendScroll); }
    } else if (e.target && e.target.nodeType === 1) {
      if (innerQueued && innerQueued !== e.target) sendInnerScroll();
      if (!innerQueued) { innerQueued = e.target; requestAnimationFrame(sendInnerScroll); }
    }
  }, true);

  function sendCursor() {
    cursorQueued = false;
    if (drive) post({ t: 'ev', e: { k: 'cursor', x: Math.round(cx), y: Math.round(cy), a: anchorAt(cx, cy) } });
  }
  document.addEventListener('mousemove', function (e) {
    if (!drive) return;
    cx = e.clientX; cy = e.clientY;
    if (!cursorQueued) { cursorQueued = true; setTimeout(sendCursor, 33); }
  }, true);
  document.documentElement.addEventListener('mouseleave', function () {
    if (drive) post({ t: 'ev', e: { k: 'cursor', x: -1, y: -1 } });
  });

  document.addEventListener('click', function (e) {
    if (!drive || replaying || !e.isTrusted) return;
    var t = e.target && e.target.nodeType === 1 ? e.target : null;
    var p = t && pathOf(t);
    if (p) post({ t: 'ev', e: { k: 'click', p: p, x: Math.round(e.clientX), y: Math.round(e.clientY), a: anchorAt(e.clientX, e.clientY) } });
  }, true);

  /** Never pass on what is typed into fields that hold secrets. */
  function isPrivate(el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    var auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || type === 'file' || type === 'hidden' || /password|one-time|cc-/.test(auto);
  }
  function onInput(e) {
    if (!drive || replaying) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
    if (isPrivate(el)) return;
    var p = pathOf(el);
    if (!p) return;
    var type = (el.type || '').toLowerCase();
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) post({ t: 'ev', e: { k: 'input', p: p, c: !!el.checked } });
    else post({ t: 'ev', e: { k: 'input', p: p, v: String(el.value).slice(0, 4000) } });
  }
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);

  // ---- links and forms: the board loads the next page for everyone, so the frame never leaves on its own.
  // These listen last (on window, after the page's own handlers) and leave alone whatever the page already
  // dealt with itself, so menus, tabs and in-page routing keep working.
  var bare = function (href) { return String(href).split('#')[0]; };
  function jump(id) {
    try { id = decodeURIComponent(id); } catch (e) {}
    var t = id && (document.getElementById(id) || document.getElementsByName(id)[0]);
    if (t) t.scrollIntoView();
    else if (!id || id === 'top') window.scrollTo(0, 0);
  }
  window.addEventListener('click', function (e) {
    var a = null, path = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length && !a; i++) {
      var n = path[i];
      if (n && n.nodeType === 1 && /^(a|area)$/i.test(n.tagName) && n.hasAttribute('href')) a = n;
    }
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (/^\s*javascript:/i.test(raw) || e.defaultPrevented) return;
    e.preventDefault();
    var u;
    try { u = new URL(raw, document.baseURI); } catch (err) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (bare(u.href) === bare(document.baseURI)) { if (u.hash.length > 1) jump(u.hash.slice(1)); return; }
    if (drive && !replaying) post({ t: 'nav', url: u.href });
  });
  window.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM' || e.defaultPrevented) return;
    var by = e.submitter || null;
    var method = ((by && by.getAttribute('formmethod')) || f.getAttribute('method') || 'get').toLowerCase();
    if (method === 'dialog') return;
    e.preventDefault();
    if (!drive || replaying) return;
    if (method !== 'get') { post({ t: 'note', note: 'post' }); return; }
    var u, data;
    try { u = new URL((by && by.getAttribute('formaction')) || f.getAttribute('action') || '', document.baseURI); } catch (err) { return; }
    try { data = new FormData(f, by); } catch (err) { data = new FormData(f); }
    var q = new URLSearchParams();
    data.forEach(function (v, k) { if (typeof v === 'string') q.append(k, v); });
    u.search = q.toString();
    u.hash = '';
    post({ t: 'nav', url: u.href });
  });

  // ---- watching: replay what the driver does
  var cursor = null, cursorLabel = null, cursorArrow = null, layer = null;
  function overlay() {
    if (layer) return layer;
    var hostEl = document.createElement('div');
    hostEl.setAttribute('aria-hidden', 'true');
    hostEl.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    layer = hostEl.attachShadow ? hostEl.attachShadow({ mode: 'closed' }) : hostEl;
    document.documentElement.appendChild(hostEl);
    return layer;
  }
  function showCursor(x, y) {
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;transition:transform 70ms linear;will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3));';
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 16 20');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '20');
      svg.style.cssText = 'display:block;';
      cursorArrow = document.createElementNS(ns, 'path');
      cursorArrow.setAttribute('d', 'M1.5 1.5v14l3.8-3.6 2.6 6 2.4-1-2.6-5.9h5.3z');
      cursorArrow.setAttribute('stroke', '#fff');
      cursorArrow.setAttribute('stroke-width', '1.2');
      cursorArrow.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(cursorArrow);
      cursorLabel = document.createElement('span');
      cursorLabel.style.cssText = 'position:absolute;left:13px;top:17px;padding:3px 7px;border-radius:3px;color:#fff;white-space:nowrap;font:600 11px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;';
      cursor.appendChild(svg);
      cursor.appendChild(cursorLabel);
      overlay().appendChild(cursor);
    }
    var color = who && /^#[0-9a-f]{6}$/i.test(who.color) ? who.color : '#4f6bff';
    cursorArrow.setAttribute('fill', color);
    cursorLabel.style.background = color;
    cursorLabel.textContent = who && who.name ? String(who.name).slice(0, 40) : '';
    cursorLabel.style.display = cursorLabel.textContent ? '' : 'none';
    cursor.style.transform = 'translate(' + (x - 1.5) + 'px,' + (y - 1.5) + 'px)';
    cursor.style.display = '';
  }
  function hideCursor() { if (cursor) cursor.style.display = 'none'; }
  function ripple(x, y) {
    var dot = document.createElement('div');
    var color = who && /^#[0-9a-f]{6}$/i.test(who.color) ? who.color : '#4f6bff';
    dot.style.cssText = 'position:fixed;left:' + (x - 16) + 'px;top:' + (y - 16) + 'px;width:32px;height:32px;border-radius:50%;pointer-events:none;border:2px solid ' + color + ';background:' + color + '33;';
    overlay().appendChild(dot);
    var done = function () { if (dot.parentNode) dot.parentNode.removeChild(dot); };
    if (dot.animate) dot.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 480, easing: 'ease-out' }).onfinish = done;
    setTimeout(done, 520);
  }

  // Scrolling eases towards where the driver is, so 30 updates a second still look like one motion.
  var easing = false, snap = true;
  function scrollTarget() {
    var pt = pointOf(want.a);
    return pt ? window.scrollY + pt.y - window.innerHeight / 2 : want.y;
  }
  function ease() {
    easing = false;
    if (drive || !want) return;
    var before = window.scrollY;
    var d = scrollTarget() - before;
    if (Math.abs(d) < 0.5 && Math.abs(want.x - window.scrollX) < 0.5) return;
    var jumpNow = snap || Math.abs(d) < 2 || Math.abs(d) > window.innerHeight * 1.5;
    snap = false;
    window.scrollTo({ left: want.x, top: before + (jumpNow ? d : d * 0.45), behavior: 'instant' });
    if (!jumpNow && Math.abs(window.scrollY - before) >= 0.5) follow();
  }
  function follow() { if (!easing) { easing = true; requestAnimationFrame(ease); } }
  /** The page grew or shifted (images, late content): line up with the driver again. */
  function realign() { if (!drive && want) { snap = true; follow(); } }

  function setValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : el.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
    var d = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
  }
  function replay(e) {
    if (!document.body) return;
    if (e.k === 'scroll') {
      want = e;
      // A tab in the background gets no animation frames: go straight there instead of easing.
      if (document.hidden) { snap = true; ease(); } else follow();
      return;
    }
    if (e.k === 'cursor') {
      if (e.x < 0) return hideCursor();
      var c = pointOf(e.a) || e;
      return showCursor(c.x, c.y);
    }
    var el = byPath(e.p);
    if (e.k === 'escroll') { if (el) { el.scrollLeft = e.x; el.scrollTop = e.y; } return; }
    replaying = true;
    try {
      if (e.k === 'click') {
        var pt = pointOf(e.a) || e;
        ripple(pt.x, pt.y);
        if (el) {
          var o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: pt.x, clientY: pt.y, button: 0 };
          if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerdown', o));
          el.dispatchEvent(new MouseEvent('mousedown', o));
          if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new MouseEvent('click', o));
        }
      } else if (e.k === 'input' && el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !isPrivate(el)) {
        var changed = false;
        if (typeof e.c === 'boolean') { changed = el.checked !== e.c; el.checked = e.c; }
        else if (typeof e.v === 'string') { changed = el.value !== e.v; if (changed) setValue(el, e.v); }
        if (changed) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch (err) {}
    replaying = false;
  }

  // ---- talking to the board
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== host || !m || m.bb !== 1) return;
    if (m.t === 'role') {
      drive = !!m.drive;
      who = m.who || null;
      if (drive) { hideCursor(); want = null; }
      else if (m.scroll) { want = m.scroll; snap = true; follow(); }
    } else if (m.t === 'ev' && !drive && m.e) replay(m.e);
  });

  var title = function () { post({ t: 'title', title: String(document.title || '').slice(0, 200) }); };
  document.addEventListener('DOMContentLoaded', function () {
    if (cfg.hash) jump(cfg.hash);
    post({ t: 'ready' });
    title();
    if (window.ResizeObserver) new ResizeObserver(realign).observe(document.documentElement);
  });
  window.addEventListener('load', function () { title(); realign(); });
  post({ t: 'hello', url: cfg.url });
}`;
