/* KinoPub for Hisense VIDAA — site mode (login + password, no API keys).
 * ES5 only: the TV browser engine is old (no arrow functions, let/const,
 * template strings). Data comes from kino.watch pages through the Worker
 * (see worker/worker.js) and is parsed by parser.js (window.KP_PARSE).
 */
(function () {
  'use strict';

  var CFG = window.KP_CONFIG || {};
  var PROXY = (CFG.proxy || '').replace(/\/+$/, '');
  var P = window.KP_PARSE;

  /* ---------- small utils ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function each(arr, fn) { for (var i = 0; i < (arr ? arr.length : 0); i++) fn(arr[i], i); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function qs(obj) {
    var out = [];
    for (var k in obj) if (obj.hasOwnProperty(k) && obj[k] != null && obj[k] !== '') out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    return out.join('&');
  }
  function addParam(path, k, v) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(v); }
  function setParam(path, k, v) {
    var re = new RegExp('([?&])' + k + '=[^&]*');
    return re.test(path) ? path.replace(re, '$1' + k + '=' + encodeURIComponent(v)) : addParam(path, k, v);
  }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (h ? (m < 10 ? '0' : '') : '') + m, ss = (sec < 10 ? '0' : '') + sec;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function fmtDur(s) { s = s || 0; var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return (h ? h + ' ч ' : '') + m + ' мин'; }
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast show';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, ms || 2500);
  }
  var loading = 0;
  function loader(on) { loading += on ? 1 : -1; if (loading < 0) loading = 0; $('loader').className = 'loader' + (loading ? ' show' : ''); }

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('kp_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('kp_' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('kp_' + k); } catch (e) {} }
  };
  var DEFAULTS = { engine: 'auto', autonext: true, audio: '', audioLang: '', subs: 'off' };
  var settings = store.get('settings2', {});
  for (var dk in DEFAULTS) if (!(dk in settings)) settings[dk] = DEFAULTS[dk];
  function saveSettings() { store.set('settings2', settings); }

  /* ---------- HTTP to the Worker ---------- */
  var auth = { session: store.get('session', null), user: store.get('user', '') };

  function http(method, url, body, headers, cb) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    for (var h in headers) if (headers.hasOwnProperty(h)) x.setRequestHeader(h, headers[h]);
    x.timeout = 30000;
    var done = false;
    function finish(st) { if (done) return; done = true; cb(st, x.responseText || '', x); }
    x.onreadystatechange = function () { if (x.readyState === 4) finish(x.status); };
    x.onerror = function () { finish(0); };
    x.ontimeout = function () { finish(0); };
    x.send(body || null);
  }

  /* site.get(path, cb(err, text, contentType)) — page or JSON from kino.watch */
  var site = {
    request: function (method, path, params, cb) {
      if (!auth.session) { cb('auth'); return sessionLost(); }
      var url = PROXY + '/site/' + (method === 'POST' ? 'post' : 'get') + '?' + qs({ path: path });
      var headers = { 'X-KP-Session': auth.session };
      if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      loader(true);
      http(method, url, method === 'POST' ? qs(params || {}) : null, headers, function (st, text, x) {
        loader(false);
        var fresh = null; try { fresh = x.getResponseHeader('X-KP-Session'); } catch (e) {}
        if (fresh) { auth.session = fresh; store.set('session', fresh); }
        if (st === 401) { cb('auth'); return sessionLost(); }
        if (st === 0) { toast('Нет связи с прокси ' + PROXY); return cb('network'); }
        if (st >= 400) { toast('Ошибка сайта: HTTP ' + st); return cb('http ' + st); }
        var type = ''; try { type = x.getResponseHeader('Content-Type') || ''; } catch (e) {}
        cb(null, text, type);
      });
    },
    page: function (path, cb) {
      site.request('GET', path, null, function (err, text) {
        if (err) return cb(err);
        var d; try { d = P.doc(text); } catch (e) { return cb('parse'); }
        cb(null, d);
      });
    },
    json: function (path, cb) {
      site.request('GET', path, null, function (err, text) {
        if (err) return cb(err);
        try { cb(null, JSON.parse(text)); } catch (e) { cb('json'); }
      });
    },
    post: function (path, params, cb) { site.request('POST', path, params, cb || function () {}); }
  };

  function sessionLost() {
    if (current === 'login') return;
    auth.session = null; store.del('session');
    if (current === 'player') player.stop(true);
    toast('Нужно войти заново', 3500);
    openLogin();
  }

  /* ---------- screens & focus ---------- */
  var screens = {}, stack = [], current = null, lastFocus = {};
  each(document.querySelectorAll('.screen'), function (s) { screens[s.id.replace('screen-', '')] = s; });

  function showScreen(name, push) {
    if (current) {
      lastFocus[current] = focused;
      screens[current].className = 'screen';
      if (push !== false && name !== current) stack.push(current);
    }
    current = name;
    screens[name].className = 'screen active';
    var f = lastFocus[name];
    if (f && document.body.contains(f) && (f.offsetWidth || f.offsetHeight)) focus(f); else focusFirst();
  }
  function goBack() {
    if (overlay.open) return overlay.close();
    if (current === 'player') player.stop();
    if (current === 'login') return exitApp();
    var prev = stack.pop();
    if (!prev) { if (current === 'home') return exitApp(); prev = 'home'; }
    showScreen(prev, false);
  }
  function exitApp() {
    try { if (typeof window.Hisense_Exit === 'function') return window.Hisense_Exit(); } catch (e) {}
    try { window.close(); } catch (e) {}
    try { history.back(); } catch (e) {}
  }

  var focused = null;
  function focus(e) {
    if (!e) return;
    if (focused && focused.classList) focused.classList.remove('focus');
    focused = e; e.classList.add('focus');
    scrollIntoView(e);
  }
  function scopeRoot() { return overlay.open ? overlay.node : (current === 'player' && player.menuOpen ? $('player-menu') : screens[current]); }
  function focusFirst() {
    var list = visibleFocusables();
    focus(list.length ? list[0] : null);
  }
  function visibleFocusables() {
    var out = [], list = scopeRoot().querySelectorAll('.focusable');
    each(list, function (e) { if (e.offsetWidth || e.offsetHeight) out.push(e); });
    return out;
  }
  /* Rows and grids scroll inside boxes with overflow:hidden, so a scrolled-away
     tile still has a position on screen (e.g. under the top bar). When focus
     comes from outside such a box, only the visible part of a tile counts;
     inside the same box the real position is used (that's how a row scrolls). */
  function navRect(e, root) {
    var r = rect(e);
    for (var p = e.parentNode; p && p !== root; p = p.parentNode) {
      var ov = window.getComputedStyle(p).overflow;
      if (ov !== 'hidden' && ov !== 'auto' && ov !== 'scroll') continue;
      if (focused && p.contains(focused)) break;
      var b = p.getBoundingClientRect();
      r.l = Math.max(r.l, b.left); r.r = Math.min(r.r, b.right); r.t = Math.max(r.t, b.top); r.b = Math.min(r.b, b.bottom);
      if (r.r - r.l < 4 || r.b - r.t < 4) return null;
    }
    r.cx = (r.l + r.r) / 2; r.cy = (r.t + r.b) / 2;
    return r;
  }
  function rect(e) { var r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; }
  /* geometric spatial navigation: nearest focusable in the pressed direction */
  function move(dir) {
    if (!focused || !scopeRoot().contains(focused)) return focusFirst();
    var cur = rect(focused), best = null, bestScore = Infinity;
    var root = scopeRoot();
    each(visibleFocusables(), function (e) {
      if (e === focused) return;
      var r = navRect(e, root), primary, secondary, overlap;
      if (!r) return;
      if (dir === 'left') { primary = cur.l - r.r; secondary = Math.abs(r.cy - cur.cy); overlap = r.b > cur.t && r.t < cur.b; }
      else if (dir === 'right') { primary = r.l - cur.r; secondary = Math.abs(r.cy - cur.cy); overlap = r.b > cur.t && r.t < cur.b; }
      else if (dir === 'up') { primary = cur.t - r.b; secondary = Math.abs(r.cx - cur.cx); overlap = r.r > cur.l && r.l < cur.r; }
      else { primary = r.t - cur.b; secondary = Math.abs(r.cx - cur.cx); overlap = r.r > cur.l && r.l < cur.r; }
      if (primary < -10) return;
      if ((dir === 'left' || dir === 'right') && !overlap) return; // stay on the same line
      var score = primary + (overlap ? 0 : 1000) + secondary * (overlap ? 0.3 : 2);
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) focus(best);
  }
  function scrollIntoView(e) {
    var p = e.parentNode;
    while (p && p !== document.body) {
      var ov = window.getComputedStyle(p).overflow;
      if (ov === 'hidden' || ov === 'auto' || ov === 'scroll') {
        var pr = p.getBoundingClientRect(), er = e.getBoundingClientRect();
        if (er.left < pr.left) p.scrollLeft -= (pr.left - er.left) + 24;
        else if (er.right > pr.right) p.scrollLeft += (er.right - pr.right) + 24;
        if (er.top < pr.top) p.scrollTop -= (pr.top - er.top) + 20;
        else if (er.bottom > pr.bottom) p.scrollTop += (er.bottom - pr.bottom) + 20;
      }
      p = p.parentNode;
    }
  }

  /* ---------- overlay (pop-up list over the item screen) ---------- */
  var overlay = {
    open: false, node: $('item-overlay'), back: null,
    show: function (title, buttons) {
      var o = overlay.node; clear(o);
      var box = el('div', 'overlay-box'); box.appendChild(el('h2', null, title));
      each(buttons, function (b) { box.appendChild(b); });
      o.appendChild(box); o.className = 'overlay show';
      overlay.back = focused; overlay.open = true; focusFirst();
    },
    close: function () { overlay.node.className = 'overlay'; overlay.open = false; if (overlay.back) focus(overlay.back); }
  };

  /* ---------- keys ---------- */
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: [8, 27, 461, 10009, 166], PLAY: [415, 179, 10252, 10253], PAUSE: [19], STOP: [413], REW: [412, 227], FF: [417, 228], RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: [457], MENU: [18, 93, 10135] };
  function isKey(code, list) { for (var i = 0; i < list.length; i++) if (list[i] === code) return true; return false; }
  var lastKeys = [];

  document.addEventListener('keydown', function (ev) {
    var c = ev.keyCode;
    lastKeys.unshift(c + (ev.key ? '/' + ev.key : '')); if (lastKeys.length > 8) lastKeys.pop();
    if (current === 'player' && !player.menuOpen) { if (player.key(c)) ev.preventDefault(); return; }
    var handled = true;
    if (c === KEY.LEFT) move('left');
    else if (c === KEY.RIGHT) move('right');
    else if (c === KEY.UP) move('up');
    else if (c === KEY.DOWN) move('down');
    else if (c === KEY.ENTER) { if (focused && focused.onclick) focused.onclick(); }
    else if (isKey(c, KEY.BACK)) { if (current === 'player') player.closeMenu(); else goBack(); }
    else if (current === 'player' && (isKey(c, KEY.INFO) || isKey(c, KEY.MENU) || c === KEY.RED || c === KEY.GREEN || c === KEY.YELLOW || c === KEY.BLUE)) player.closeMenu();
    else handled = false;
    if (handled) ev.preventDefault();
  });
  /* typing from a USB/Bluetooth keyboard on the login and search screens */
  document.addEventListener('keypress', function (ev) {
    var ch = ev.charCode ? String.fromCharCode(ev.charCode) : '';
    if (!ch || ch < ' ') return;
    if (current === 'login') { loginForm.type(ch); ev.preventDefault(); }
    else if (current === 'search') { search.type(ch); ev.preventDefault(); }
  });
  /* Cmd+V / Ctrl+V: paste into the current login field (or the search line) */
  document.addEventListener('paste', function (ev) {
    if (current !== 'login' && current !== 'search') return;
    var cd = ev.clipboardData || window.clipboardData, t = '';
    try { t = cd ? cd.getData('text') : ''; } catch (e) { t = ''; }
    t = (t || '').replace(/[\r\n\t]+/g, '');
    if (!t) return;
    ev.preventDefault();
    if (current === 'login') {
      var f = loginForm.field;
      loginForm[f] += f === 'code' ? t.replace(/\s+/g, '') : t;
      loginForm.render();
    } else {
      for (var i = 0; i < t.length; i++) search.type(t.charAt(i));
    }
  });

  /* ---------- on-screen keyboard ---------- */
  var LAYOUTS = {
    ru: ['йцукенгшщзх', 'фывапролджэ', 'ячсмитьбюъё', '1234567890-'],
    en: ['qwertyuiop@', 'asdfghjkl._', 'zxcvbnm-!#$', '1234567890+'],
    EN: ['QWERTYUIOP@', 'ASDFGHJKL._', 'ZXCVBNM-!#$', '1234567890+'],
    sym: ['!@#$%^&*()_', '-+=[]{};:\'"', ',.<>/?\\|~`', '1234567890 ']
  };
  /* Keyboard(container, layouts, onKey(ch | 'BS' | 'CLR' | 'OK')) */
  function Keyboard(box, names, onKey, okLabel) {
    var state = { layout: names[0] };
    function draw(keep) {
      var keepIdx = -1;
      if (keep && focused && box.contains(focused)) keepIdx = Array.prototype.indexOf.call(box.querySelectorAll('.key'), focused);
      clear(box);
      each(LAYOUTS[state.layout], function (row) {
        each(row.split(''), function (ch) {
          var k = el('div', 'key focusable', ch === ' ' ? '␣' : ch);
          k.onclick = function () { onKey(ch); };
          box.appendChild(k);
        });
        box.appendChild(el('br'));
      });
      each(names, function (n) {
        var label = n === 'ru' ? 'РУС' : n === 'en' ? 'abc' : n === 'EN' ? 'ABC' : '#+=';
        var k = el('div', 'key mid focusable' + (n === state.layout ? ' on' : ''), label);
        k.onclick = function () { state.layout = n; draw(true); };
        box.appendChild(k);
      });
      box.appendChild(el('br'));
      var sp = el('div', 'key wide focusable', 'пробел'); sp.onclick = function () { onKey(' '); }; box.appendChild(sp);
      var bs = el('div', 'key mid focusable', '⌫'); bs.onclick = function () { onKey('BS'); }; box.appendChild(bs);
      var cl = el('div', 'key mid focusable', '✕'); cl.onclick = function () { onKey('CLR'); }; box.appendChild(cl);
      if (okLabel) { var ok = el('div', 'key mid focusable ok', okLabel); ok.onclick = function () { onKey('OK'); }; box.appendChild(ok); }
      if (keepIdx >= 0) { var keys = box.querySelectorAll('.key'); focus(keys[Math.min(keepIdx, keys.length - 1)]); }
    }
    draw(false);
    return { redraw: draw, setLayout: function (n) { if (LAYOUTS[n] && state.layout !== n) { state.layout = n; draw(false); } } };
  }

  /* ---------- login ---------- */
  /* Two steps. 1: login + password. The site then usually e-mails a code,
     because to the site the Worker is a new device; the Worker answers
     need:'code' with a "pending" string (the half-finished site session).
     2: the code from the e-mail + pending. */
  var loginForm = {
    user: store.get('login', ''), pass: '', code: '', pending: null, field: 'user', show: false, osk: null, busy: false,
    render: function () {
      var codeStep = !!loginForm.pending;
      $('login-user').querySelector('.field-value').textContent = loginForm.user + (loginForm.field === 'user' ? '|' : '');
      var p = loginForm.show ? loginForm.pass : new Array(loginForm.pass.length + 1).join('•');
      $('login-pass').querySelector('.field-value').textContent = p + (loginForm.field === 'pass' ? '|' : '');
      $('login-code').querySelector('.field-value').textContent = loginForm.code + (loginForm.field === 'code' ? '|' : '');
      each(['user', 'pass', 'code'], function (f) {
        var e = $('login-' + f);
        var hide = codeStep ? f !== 'code' : f === 'code';
        e.className = 'field focusable' + (hide ? ' hidden' : '') + (loginForm.field === f ? ' active' : '') + (focused === e ? ' focus' : '');
      });
      $('login-show').className = 'btn focusable' + (codeStep ? ' hidden' : '');
      $('login-resend').className = 'btn focusable' + (codeStep ? '' : ' hidden');
      $('login-show').textContent = loginForm.show ? 'Скрыть пароль' : 'Показать пароль';
      $('login-go').textContent = codeStep ? 'Подтвердить' : 'Войти';
    },
    type: function (ch) {
      var f = loginForm.field;
      if (ch === 'BS') loginForm[f] = loginForm[f].slice(0, -1);
      else if (ch === 'CLR') loginForm[f] = '';
      else if (ch === 'OK') { if (f === 'user') { loginForm.field = 'pass'; } else return loginForm.submit(); }
      else if (f === 'code' && !/[0-9A-Za-z]/.test(ch)) return;
      else loginForm[f] += ch;
      loginForm.render();
    },
    reset: function () { loginForm.pending = null; loginForm.code = ''; loginForm.field = loginForm.user ? 'pass' : 'user'; },
    submit: function (resend) {
      if (loginForm.busy) return;
      var params;
      if (loginForm.pending) {
        if (!resend && !loginForm.code) { $('login-status').textContent = 'Введите код из письма'; return; }
        params = resend ? { pending: loginForm.pending, resend: '1' } : { pending: loginForm.pending, code: loginForm.code };
      } else {
        if (!loginForm.user || !loginForm.pass) { $('login-status').textContent = 'Введите логин и пароль'; return; }
        params = { login: loginForm.user, password: loginForm.pass };
      }
      loginForm.busy = true;
      $('login-status').textContent = resend ? 'Прошу новый код…' : 'Вхожу…';
      http('POST', PROXY + '/site/login', qs(params), { 'Content-Type': 'application/x-www-form-urlencoded' }, function (st, text) {
        loginForm.busy = false;
        var d = null; try { d = JSON.parse(text); } catch (e) {}
        window.KP_LAST_LOGIN = d && { ok: d.ok, need: d.need, error: d.error, detail: d.detail }; // diagnostics, no secrets
        if (d && d.ok && d.session) {
          auth.session = d.session; auth.user = d.user || '';
          store.set('session', d.session); store.set('user', auth.user); store.set('login', loginForm.user);
          loginForm.pass = ''; loginForm.reset(); loginForm.render();
          $('login-status').textContent = '';
          homeLoaded = false; openHome();
          return;
        }
        if (d && d.need === 'code' && d.pending) {
          var first = !loginForm.pending;
          loginForm.pending = d.pending; loginForm.pass = '';
          if (!resend) loginForm.code = '';
          loginForm.field = 'code';
          loginForm.render();
          $('login-status').textContent = d.error || (first ? 'Сайт отправил код на вашу почту — введите его' : 'Введите код из письма');
          if (first) { loginForm.osk.setLayout('en'); focus($('login-osk').querySelector('.key')); }
          return;
        }
        if (d && /устарела/.test(d.error || '')) { loginForm.reset(); loginForm.render(); }
        $('login-status').textContent = st === 0 ? ('Прокси недоступен: ' + PROXY) : ((d && d.error) || ('Ошибка входа, HTTP ' + st));
      });
    }
  };
  $('login-user').onclick = function () { loginForm.field = 'user'; loginForm.render(); focus($('login-osk').querySelector('.key')); };
  $('login-pass').onclick = function () { loginForm.field = 'pass'; loginForm.render(); focus($('login-osk').querySelector('.key')); };
  $('login-code').onclick = function () { loginForm.field = 'code'; loginForm.render(); focus($('login-osk').querySelector('.key')); };
  $('login-show').onclick = function () { loginForm.show = !loginForm.show; loginForm.render(); };
  $('login-resend').onclick = function () { loginForm.submit(true); };
  $('login-go').onclick = function () { loginForm.submit(false); };
  function openLogin() {
    stack = [];
    if (!loginForm.osk) loginForm.osk = Keyboard($('login-osk'), ['en', 'EN', 'sym', 'ru'], loginForm.type, 'Далее');
    loginForm.reset();
    showScreen('login', false);
    loginForm.render();
    focus($('login-osk').querySelector('.key'));
  }

  /* ---------- tiles ---------- */
  function tile(it) {
    var t = el('div', 'tile focusable');
    var img = el('img'); img.src = it.poster; img.alt = ''; t.appendChild(img);
    if (it.badge) t.appendChild(el('span', 'badge', '+' + it.badge));
    t.appendChild(el('div', 'tile-title', it.title));
    t.onclick = function () { openItem(it.id); };
    return t;
  }
  function moreTile(onclick) { var t = el('div', 'tile more focusable', 'Ещё…'); t.onclick = onclick; return t; }

  /* fill(container, items, nextPage) — nextPage(cb(items, hasMore)) or null */
  function fill(container, items, nextPage) {
    var seen = container.kpSeen || (container.kpSeen = {});
    each(items, function (it) { if (seen[it.id]) return; seen[it.id] = 1; container.appendChild(tile(it)); });
    if (nextPage) {
      var m = moreTile(function () {
        var idx = Array.prototype.indexOf.call(container.children, m);
        nextPage(function (more, again) {
          if (m.parentNode) container.removeChild(m);
          fill(container, more, again ? nextPage : null);
          var target = container.children[idx] || container.lastChild;
          if (target) focus(target);
        });
      });
      container.appendChild(m);
    }
  }
  /* pager(path): loads ?page=2,3,… of a catalog page */
  function pager(path, startPage) {
    var page = startPage == null ? 1 : startPage;
    return function (cb) {
      page++;
      site.page(setParam(path, 'page', page), function (err, d) {
        if (err) return cb([], false);
        var l = P.list(d); cb(l.items, l.hasNext);
      });
    };
  }

  /* ---------- home ---------- */
  var homeLoaded = false;
  function openHome() {
    stack = [];
    showScreen('home', false);
    if (!homeLoaded) { homeLoaded = true; loadHome(); }
  }
  function row(title) {
    var r = el('div', 'row'); r.appendChild(el('div', 'row-title', title));
    var items = el('div', 'row-items'); r.appendChild(items);
    $('home-rows').appendChild(r);
    return items;
  }
  function loadHome() {
    clear($('home-rows'));
    var wl = row('Я смотрю');
    if (auth.user) {
      site.page('/watchlist/' + encodeURIComponent(auth.user), function (err, d) {
        var items = err ? [] : P.list(d).items;
        if (!items.length) { wl.parentNode.style.display = 'none'; return; }
        // series with new episodes first
        items.sort(function (a, b) { return (parseInt(b.badge, 10) || 0) - (parseInt(a.badge, 10) || 0); });
        fill(wl, items);
        if (!focused || !document.body.contains(focused) || !screens.home.contains(focused)) focusFirst();
      });
    } else wl.parentNode.style.display = 'none';
    var rest = el('div'); $('home-rows').appendChild(rest);
    site.page('/', function (err, d) {
      if (err) return;
      if (!auth.user) { auth.user = P.user(d); store.set('user', auth.user); }
      each(P.home(d), function (r) {
        var box = el('div', 'row'); box.appendChild(el('div', 'row-title', r.title));
        var items = el('div', 'row-items'); box.appendChild(items); rest.appendChild(box);
        fill(items, r.items, r.path ? pager(r.path, 0) : null);
      });
      if (!screens.home.contains(focused)) focusFirst();
    });
  }
  each($('screen-home').querySelectorAll('.topnav .btn'), function (b) {
    b.onclick = function () {
      var a = b.getAttribute('data-action');
      if (a === 'search') openSearch();
      else if (a === 'section') openSection(b.getAttribute('data-path'), b.textContent, true);
      else if (a === 'bookmarks') openBookmarks();
      else if (a === 'history') openSection('/history', 'История', false);
      else if (a === 'settings') openSettings();
    };
  });

  /* ---------- section grid (catalog, bookmark folder, history) ---------- */
  var section = { path: '/movie', order: 'updated', sortable: true };
  function openSection(path, title, sortable) {
    section.path = path; section.sortable = !!sortable;
    $('section-title').textContent = title;
    $('section-sorts').style.display = sortable ? '' : 'none';
    showScreen('section');
    loadSection();
  }
  function loadSection() {
    var grid = $('section-grid'); clear(grid); grid.kpSeen = {}; grid.scrollTop = 0;
    each($('section-sorts').querySelectorAll('.btn'), function (b) { b.className = 'btn focusable' + (b.getAttribute('data-order') === section.order ? ' on' : ''); });
    var path = section.sortable ? setParam(setParam(section.path, 'order', section.order), 'period', 'all') : section.path;
    site.page(path, function (err, d) {
      if (err) return;
      var l = P.list(d);
      if (!l.items.length) grid.appendChild(el('div', 'empty', 'Здесь пусто'));
      fill(grid, l.items, l.hasNext ? pager(path) : null);
      if (grid.firstChild && grid.firstChild.className.indexOf('focusable') >= 0) focus(grid.firstChild);
    });
  }
  each($('section-sorts').querySelectorAll('.btn'), function (b) {
    b.onclick = function () { section.order = b.getAttribute('data-order'); loadSection(); };
  });

  /* ---------- bookmarks ---------- */
  function openBookmarks() {
    var box = $('bookmarks-list'); clear(box);
    showScreen('bookmarks');
    function add(title, fn) { var b = el('button', 'btn focusable folder', title); b.onclick = fn; box.appendChild(b); return b; }
    if (auth.user) add('Я смотрю', function () { openSection('/watchlist/' + encodeURIComponent(auth.user), 'Я смотрю', false); });
    focusFirst();
    site.page('/favorites', function (err, d) {
      if (err) return;
      each(P.folders(d), function (f) { add('★ ' + f.title, function () { openSection('/favorites/view?id=' + f.id, f.title, false); }); });
    });
  }

  /* ---------- search ---------- */
  var search = {
    q: '', timer: null, osk: null,
    type: function (ch) {
      if (ch === 'BS') search.q = search.q.slice(0, -1);
      else if (ch === 'CLR') search.q = '';
      else if (ch === 'OK') { clearTimeout(search.timer); return search.run(); }
      else search.q += ch;
      var inp = $('search-input'); clear(inp); inp.appendChild(document.createTextNode(search.q)); inp.appendChild(el('span', 'caret', '|'));
      clearTimeout(search.timer);
      if (search.q.length >= 3) search.timer = setTimeout(search.run, 800);
    },
    run: function () {
      if (search.q.length < 2) return;
      var grid = $('search-grid'); clear(grid); grid.kpSeen = {};
      site.page('/item/search?query=' + encodeURIComponent(search.q), function (err, d) {
        if (err) return;
        var items = P.list(d).items;
        if (!items.length) grid.appendChild(el('div', 'empty', 'Ничего не найдено'));
        fill(grid, items);
      });
    }
  };
  function openSearch() {
    if (!search.osk) search.osk = Keyboard($('search-osk'), ['ru', 'en', 'sym'], search.type, 'Найти');
    showScreen('search');
  }

  /* ---------- item ---------- */
  var item = { data: null, season: 0, episodes: [], cache: {} };
  function openItem(id) {
    site.page('/item/view/' + id, function (err, d) {
      if (err) return;
      var it = P.item(d);
      if (!it.id) { toast('Не удалось разобрать страницу'); return; }
      item.data = it; item.cache = {};
      item.season = it.currentSeason; item.episodes = it.episodes;
      item.cache[it.currentSeason] = it.episodes;
      renderItem();
      showScreen('item');
      var pb = $('item-actions').querySelector('.btn'); if (pb) focus(pb);
    });
  }
  function infoValue(it, key) { for (var i = 0; i < it.info.length; i++) if (it.info[i].k.indexOf(key) === 0) return it.info[i].v; return ''; }
  function renderItem(keepFocus) {
    var it = item.data;
    $('item-bg').style.backgroundImage = 'url(' + it.poster + ')';
    $('item-poster').src = it.poster;
    $('item-title').textContent = it.title;
    $('item-orig').textContent = it.orig;
    var meta = [], year = infoValue(it, 'Год');
    if (year) meta.push(year);
    each(['Страна', 'Жанр'], function (k) { var v = infoValue(it, k); if (v) meta.push(v.split(', ').slice(0, 3).join(', ')); });
    var dur = /\((\d+) мин\)/.exec(infoValue(it, 'Длительность'));
    if (dur) meta.push(fmtDur(dur[1] * 60) + (it.serial ? ' серия' : ''));
    $('item-meta').textContent = meta.join('  ·  ');
    var badges = $('item-badges'); clear(badges);
    var rating = infoValue(it, 'Рейтинг').replace(/ \/ [\d,]+/g, '');
    each(rating.match(/(КП|IMDb) [\d.]+/g) || [], function (r) { badges.appendChild(el('span', 'chip rating', r)); });
    each(it.chips, function (c) { if (c !== year && !/^\d+\+$/.test(c)) badges.appendChild(el('span', 'chip', c)); });
    var age = infoValue(it, 'Возраст'); if (age) badges.appendChild(el('span', 'chip', age));
    var status = it.serial ? [infoValue(it, 'Статус'), infoValue(it, 'Добавлен') ? 'добавлен ' + infoValue(it, 'Добавлен') : ''].filter(function (x) { return x; }).join(', ') : '';
    if (status) badges.appendChild(el('span', 'chip muted', status));
    $('item-plot').textContent = it.plot;

    var actions = $('item-actions'); clear(actions);
    var seasons = $('item-seasons'); clear(seasons);
    var eps = $('item-episodes'); clear(eps);

    if (it.serial) {
      var next = nextToWatch();
      var play = el('button', 'btn focusable primary', next ? ('▶ Смотреть S' + next.season + 'E' + next.number + (next.time > 30 && !next.watched ? ' с ' + fmtTime(next.time) : '')) : '▶ Смотреть');
      play.onclick = function () { if (next) playEpisode(item.episodes, item.episodes.indexOf(next)); };
      actions.appendChild(play);
    } else {
      each(it.episodes, function (v, i) {
        var multi = it.episodes.length > 1;
        var label = multi ? ('▶ Часть ' + v.number + (v.title ? ': ' + v.title : '')) : (v.time > 30 && !v.watched ? '▶ Продолжить с ' + fmtTime(v.time) : '▶ Смотреть');
        var play = el('button', 'btn focusable primary', label);
        play.onclick = function () { playEpisode(it.episodes, i); };
        actions.appendChild(play);
        if (!multi && v.time > 30 && !v.watched) {
          var fromStart = el('button', 'btn focusable', 'С начала');
          fromStart.onclick = function () { playEpisode(it.episodes, i, 0); };
          actions.appendChild(fromStart);
        }
      });
    }
    if (it.subscribed !== null) {
      var wl = el('button', 'btn focusable', it.subscribed ? '✓ Я смотрю' : '+ Я смотрю');
      wl.onclick = function () {
        var on = !it.subscribed;
        site.post((on ? '/watchlist/subscribe/' : '/watchlist/unsubscribe/') + it.id, {}, function (err) {
          if (err) return;
          it.subscribed = on; wl.textContent = on ? '✓ Я смотрю' : '+ Я смотрю';
          toast(on ? 'Добавлено в «Я смотрю»' : 'Убрано из «Я смотрю»');
        });
      };
      actions.appendChild(wl);
    }
    if (it.favorites.length) {
      var bm = el('button', 'btn focusable', '★ Закладки');
      bm.onclick = function () { showFavorites(); };
      actions.appendChild(bm);
    }

    if (it.serial) {
      each(it.seasons, function (s) {
        var b = el('button', 'btn focusable' + (s.number === item.season ? ' on' : ''), 'Сезон ' + s.number + (s.watched ? ' ✓' : ''));
        b.onclick = function () { selectSeason(s.number); };
        seasons.appendChild(b);
      });
      each(item.episodes, function (ep, i) {
        var e = el('div', 'ep focusable' + (ep.watched ? ' watched' : ''));
        e.appendChild(document.createTextNode((ep.watched ? '✓ ' : '') + ep.number + '. ' + (ep.title || 'Эпизод ' + ep.number)));
        e.appendChild(el('span', 'ep-dur', fmtDur(ep.duration)));
        if (ep.time > 0 && ep.duration && !ep.watched) { var p = el('div', 'progress'); var i2 = el('i'); i2.style.width = Math.min(100, ep.time / ep.duration * 100) + '%'; p.appendChild(i2); e.appendChild(p); }
        e.onclick = function () { playEpisode(item.episodes, i); };
        eps.appendChild(e);
      });
    }
    if (keepFocus) { var f = keepFocus(); if (f) focus(f); }
  }
  function selectSeason(n) {
    function show(list) {
      item.season = n; item.episodes = list;
      renderItem(function () { return $('item-episodes').firstChild || $('item-seasons').firstChild; });
    }
    if (item.cache[n]) return show(item.cache[n]);
    loadSeason(n, function (list) { if (list) show(list); });
  }
  function loadSeason(n, cb) {
    if (item.cache[n]) return cb(item.cache[n]);
    site.json('/item/playlist?id=' + item.data.id + '&season=' + n, function (err, j) {
      if (err) return cb(null);
      var s = P.seasonJson(j);
      if (!s.ok) { toast('Не удалось загрузить сезон ' + n); return cb(null); }
      item.cache[n] = s.episodes; cb(s.episodes);
    });
  }
  /* The episode to continue with: a started one in this season, else the first
     unwatched; on the season the site opened, trust the site's own choice. */
  function nextToWatch() {
    var eps = item.episodes, it = item.data;
    if (!eps.length) return null;
    if (item.season === it.currentSeason && it.startIndex >= 0 && eps[it.startIndex]) return eps[it.startIndex];
    for (var i = 0; i < eps.length; i++) if (eps[i].time > 0 && !eps[i].watched) return eps[i];
    for (i = 0; i < eps.length; i++) if (!eps[i].watched) return eps[i];
    return eps[0];
  }
  function showFavorites() {
    var it = item.data, buttons = [];
    each(it.favorites, function (f) {
      var b = el('button', 'btn focusable', (f.on ? '☑ ' : '☐ ') + f.title);
      b.onclick = function () {
        site.post('/favorites/change', { id: f.id, item_id: it.id }, function (err) {
          if (err) return;
          f.on = !f.on; b.textContent = (f.on ? '☑ ' : '☐ ') + f.title;
        });
      };
      buttons.push(b);
    });
    var close = el('button', 'btn focusable', 'Готово'); close.onclick = overlay.close; buttons.push(close);
    overlay.show('Папки закладок', buttons);
  }

  /* ---------- player ---------- */
  var video = $('video');
  var hlsLib = { state: 'none', waiters: [] };
  function loadHlsJs(cb) {
    if (window.Hls) return cb(true);
    if (hlsLib.state === 'failed' || !CFG.hlsjs) return cb(false);
    hlsLib.waiters.push(cb);
    if (hlsLib.state === 'loading') return;
    hlsLib.state = 'loading';
    var s = document.createElement('script');
    s.src = CFG.hlsjs;
    s.onload = function () { hlsLib.state = window.Hls ? 'ok' : 'failed'; var w = hlsLib.waiters; hlsLib.waiters = []; each(w, function (f) { f(!!window.Hls); }); };
    s.onerror = function () { hlsLib.state = 'failed'; var w = hlsLib.waiters; hlsLib.waiters = []; each(w, function (f) { f(false); }); };
    document.getElementsByTagName('head')[0].appendChild(s);
  }
  function nativeHls() { try { return !!video.canPlayType('application/vnd.apple.mpegurl'); } catch (e) { return false; } }
  function hlsJsOk() { return !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported()); }

  var player = {
    ctx: null, hls: null, engine: '', osdTimer: null, markTimer: null, menuOpen: false, seekAcc: 0, seekTimer: null, lastSent: 0, completedSent: false,

    key: function (c) {
      if (isKey(c, KEY.BACK) || isKey(c, KEY.STOP)) { goBack(); return true; }
      if (c === KEY.ENTER || isKey(c, KEY.PLAY) || isKey(c, KEY.PAUSE)) { player.togglePause(); return true; }
      if (c === KEY.LEFT || isKey(c, KEY.REW)) { player.seek(-10); return true; }
      if (c === KEY.RIGHT || isKey(c, KEY.FF)) { player.seek(10); return true; }
      if (c === KEY.UP) { player.seek(60); return true; }
      if (c === KEY.DOWN) { player.seek(-60); return true; }
      if (c === KEY.RED || c === KEY.BLUE || c === KEY.YELLOW || c === KEY.GREEN || isKey(c, KEY.INFO) || isKey(c, KEY.MENU)) { player.openMenu(); return true; }
      return false;
    },
    showOsd: function (ms) {
      $('player-osd').className = 'player-osd show';
      clearTimeout(player.osdTimer);
      player.osdTimer = setTimeout(function () { if (!video.paused) $('player-osd').className = 'player-osd'; }, ms || 3000);
    },
    msg: function (text) { var m = $('player-msg'); m.textContent = text || ''; m.className = 'player-msg' + (text ? ' show' : ''); },
    togglePause: function () { if (video.paused) video.play(); else { video.pause(); player.mark(true); } player.showOsd(); },
    seek: function (d) {
      player.seekAcc += d; clearTimeout(player.seekTimer);
      var target = Math.max(0, Math.min((video.duration || 1e9) - 2, video.currentTime + player.seekAcc));
      $('osd-cur').textContent = fmtTime(target); $('osd-fill').style.width = (video.duration ? target / video.duration * 100 : 0) + '%';
      player.showOsd();
      player.seekTimer = setTimeout(function () { video.currentTime = target; player.seekAcc = 0; }, 400);
    },
    updateOsd: function () {
      if (player.seekAcc) return;
      $('osd-cur').textContent = fmtTime(video.currentTime); $('osd-dur').textContent = fmtTime(video.duration);
      $('osd-fill').style.width = (video.duration ? video.currentTime / video.duration * 100 : 0) + '%';
      var c = player.ctx;
      if (c && video.duration && !player.completedSent && video.currentTime / video.duration > 0.95) player.markWatched(true);
    },
    /* progress to the site, like its own player: only after the first minute */
    mark: function (force) {
      var c = player.ctx; if (!c) return;
      var t = Math.floor(video.currentTime || 0);
      if (t < 60) return;
      if (!force && Math.abs(t - player.lastSent) < 10) return;
      player.lastSent = t;
      site.post('/item/media-marktime', { media_id: c.ep.mediaId, time: t });
      c.ep.time = t;
    },
    markWatched: function (on) {
      var c = player.ctx; if (!c) return;
      player.completedSent = on;
      site.post('/item/update-watching', { media_id: c.ep.mediaId, c: on ? 1 : 0 });
      c.ep.watched = on;
    },

    /* ctx = { episodes, index, ep, title } */
    start: function (ctx, startTime, engine) {
      player.destroy();
      player.ctx = ctx; player.lastSent = 0; player.completedSent = ctx.ep.watched;
      ctx.startTime = startTime || 0;
      $('osd-title').textContent = ctx.title;
      player.msg('Загрузка…');
      if (current !== 'player') showScreen('player');
      var want = engine || settings.engine;
      if (want === 'native' || (want === 'auto' && nativeHls() && !ctx.preferHlsJs)) return player.startNative();
      loadHlsJs(function (ok) {
        if (player.ctx !== ctx) return;
        if (ok && hlsJsOk()) player.startHlsJs();
        else player.startNative();
      });
    },
    startNative: function () {
      var c = player.ctx; player.engine = 'native'; c.triedNative = true;
      $('osd-info').textContent = '  [встроенный плеер]';
      video.src = c.ep.manifest;
      video.load();
      player.afterLoad();
    },
    startHlsJs: function () {
      var c = player.ctx; player.engine = 'hls.js'; c.triedHlsJs = true;
      $('osd-info').textContent = '  [hls.js]';
      var hls = new window.Hls({ startPosition: c.startTime > 0 ? c.startTime : -1, maxBufferLength: 60, capLevelToPlayerSize: false });
      player.hls = hls;
      hls.on(window.Hls.Events.ERROR, function (ev, data) {
        if (!data.fatal || player.hls !== hls) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch (e) {} }
        player.fail('hls.js: ' + data.details);
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function () { player.applyPrefs(); });
      hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, function () { player.applySubs(); });
      hls.loadSource(c.ep.manifest);
      hls.attachMedia(video);
      player.afterLoad(true);
    },
    onMeta: null,
    afterLoad: function (startHandled) {
      var c = player.ctx;
      player.onMeta = function () {
        if (player.ctx !== c) return;
        if (!startHandled && c.startTime > 0) { try { video.currentTime = c.startTime; } catch (e) {} }
        if (player.engine === 'native') player.applyPrefs();
        player.msg('');
      };
      video.addEventListener('loadedmetadata', player.onMeta);
      var p = video.play(); if (p && p['catch']) p['catch'](function () {});
      player.showOsd(5000);
      clearInterval(player.markTimer);
      player.markTimer = setInterval(function () { if (!video.paused && !video.ended) player.mark(); }, 30000);
    },
    /* playback failed: try the other engine once, then give up */
    fail: function (why) {
      var c = player.ctx; if (!c) return;
      var t = video.currentTime || c.startTime;
      if (player.engine === 'hls.js' && !c.triedNative) { toast('hls.js не смог (' + why + '), пробую встроенный плеер', 4000); return player.start(c, t, 'native'); }
      if (player.engine === 'native' && !c.triedHlsJs && settings.engine !== 'native') { toast('Встроенный плеер не смог, пробую hls.js', 4000); c.preferHlsJs = true; return player.start(c, t, 'hlsjs'); }
      player.msg('Не удалось воспроизвести (' + why + ')');
    },
    destroy: function () {
      clearInterval(player.markTimer);
      if (player.onMeta) { video.removeEventListener('loadedmetadata', player.onMeta); player.onMeta = null; }
      if (player.hls) { try { player.hls.destroy(); } catch (e) {} player.hls = null; }
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src'); try { video.load(); } catch (e) {}
    },
    stop: function (silent) {
      if (player.ctx && !silent) player.mark(true);
      player.destroy();
      player.closeMenu(); player.msg('');
      var c = player.ctx; player.ctx = null;
      if (c && current === 'player' && item.data) renderItem(function () { return $('item-actions').querySelector('.btn'); });
    },

    /* ----- audio / subtitles / quality ----- */
    audioList: function () {
      var out = [];
      if (player.hls) each(player.hls.audioTracks, function (t, i) { out.push({ name: t.name || ('Дорожка ' + (i + 1)), lang: t.lang || '', on: player.hls.audioTrack === i, pick: function () { player.hls.audioTrack = i; } }); });
      else if (video.audioTracks) for (var i = 0; i < video.audioTracks.length; i++) (function (i) {
        var t = video.audioTracks[i];
        out.push({ name: t.label || t.language || ('Дорожка ' + (i + 1)), lang: t.language || '', on: t.enabled, pick: function () { for (var k = 0; k < video.audioTracks.length; k++) video.audioTracks[k].enabled = (k === i); } });
      })(i);
      return out;
    },
    subsList: function () {
      var out = [];
      if (player.hls) each(player.hls.subtitleTracks, function (t, i) { out.push({ name: t.name || t.lang, lang: t.lang || '', on: player.hls.subtitleTrack === i, pick: function () { player.hls.subtitleDisplay = true; player.hls.subtitleTrack = i; } }); });
      else if (video.textTracks) for (var i = 0; i < video.textTracks.length; i++) (function (i) {
        var t = video.textTracks[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
        out.push({ name: t.label || t.language, lang: t.language || '', on: t.mode === 'showing', pick: function () { for (var k = 0; k < video.textTracks.length; k++) video.textTracks[k].mode = k === i ? 'showing' : 'disabled'; } });
      })(i);
      return out;
    },
    subsOff: function () {
      if (player.hls) { player.hls.subtitleTrack = -1; player.hls.subtitleDisplay = false; }
      if (video.textTracks) for (var k = 0; k < video.textTracks.length; k++) video.textTracks[k].mode = 'disabled';
    },
    /* re-apply the audio/subtitle choice remembered from earlier films */
    applyPrefs: function () {
      var list = player.audioList(), pick = null;
      if (settings.audio) each(list, function (a) { if (!pick && a.name === settings.audio) pick = a; });
      if (!pick && settings.audioLang) each(list, function (a) { if (!pick && a.lang === settings.audioLang) pick = a; });
      if (pick && !pick.on) { try { pick.pick(); } catch (e) {} }
      player.applySubs();
    },
    applySubs: function () {
      if (settings.subs === 'off') { try { player.subsOff(); } catch (e) {} return; }
      var pick = null;
      each(player.subsList(), function (s) { if (!pick && (s.name === settings.subs || s.lang === settings.subs)) pick = s; });
      if (pick && !pick.on) { try { pick.pick(); } catch (e) {} }
    },
    qualityList: function () {
      var out = [];
      if (!player.hls) return out;
      out.push({ name: 'Авто', on: player.hls.autoLevelEnabled, pick: function () { player.hls.currentLevel = -1; } });
      each(player.hls.levels, function (l, i) { out.push({ name: qualityName(l, i) + (l.bitrate ? ' (' + Math.round(l.bitrate / 100000) / 10 + ' Мбит/с)' : ''), on: !player.hls.autoLevelEnabled && player.hls.currentLevel === i, pick: function () { player.hls.currentLevel = i; } }); });
      return out;
    },

    openMenu: function () {
      var m = $('player-menu'); clear(m);
      var c = player.ctx; if (!c) return;
      function section(title, list, onPick) {
        if (!list.length) return;
        m.appendChild(el('h2', null, title));
        each(list, function (x) {
          var b = el('button', 'btn focusable' + (x.on ? ' on' : ''), x.name);
          b.onclick = function () { try { x.pick(); } catch (e) {} if (onPick) onPick(x); player.closeMenu(); };
          m.appendChild(b);
        });
      }
      var audio = player.audioList();
      if (audio.length > 1) section('Звук', audio, function (x) { settings.audio = x.name; settings.audioLang = x.lang; saveSettings(); });
      else if (player.engine === 'native') m.appendChild(el('h2', null, 'Звук: дорожки недоступны во встроенном плеере — переключите на hls.js ниже'));
      var subs = player.subsList();
      subs = subs.map(function (x, i) { x.i = i; return x; }).sort(function (a, b) { return subsRank(a) - subsRank(b) || a.i - b.i; });
      if (subs.length) {
        subs.unshift({ name: 'Выключены', on: settings.subs === 'off', pick: function () { player.subsOff(); }, off: true });
        section('Субтитры', subs, function (x) { settings.subs = x.off ? 'off' : x.name; saveSettings(); });
      }
      section('Качество', player.qualityList());
      m.appendChild(el('h2', null, 'Плеер: ' + player.engine));
      var other = player.engine === 'native' ? 'hlsjs' : 'native';
      var sw = el('button', 'btn focusable', other === 'native' ? 'Переключить на встроенный' : 'Переключить на hls.js');
      sw.onclick = function () { var t = video.currentTime; player.closeMenu(); c.triedNative = c.triedHlsJs = false; c.preferHlsJs = other === 'hlsjs'; player.start(c, t, other); };
      m.appendChild(sw);
      var mk = el('button', 'btn focusable', c.ep.watched ? 'Снять отметку «просмотрено»' : 'Отметить как просмотренное');
      mk.onclick = function () { player.markWatched(!c.ep.watched); toast(c.ep.watched ? 'Отмечено как просмотренное' : 'Отметка снята'); player.closeMenu(); };
      m.appendChild(mk);
      m.className = 'player-menu show'; player.menuOpen = true;
      focus(m.querySelector('.btn.on') || m.querySelector('.focusable'));
    },
    closeMenu: function () { $('player-menu').className = 'player-menu'; player.menuOpen = false; }
  };
  /* Mouse / pointer mode (the TV browser turns the remote into a cursor and OK into
     a click): click on the picture = pause, on-screen buttons, click on the bar = seek. */
  $('screen-player').addEventListener('click', function (ev) {
    var t = ev.target;
    if ($('player-menu').contains(t)) return;           // menu buttons handle themselves
    if (player.menuOpen) { player.closeMenu(); return; }
    while (t && t !== this && !(t.getAttribute && t.getAttribute('data-ctl')) && t.id !== 'osd-bar') t = t.parentNode;
    if (t && t.id === 'osd-bar') {
      var r = t.getBoundingClientRect();
      if (video.duration) { video.currentTime = Math.max(0, Math.min(video.duration - 2, (ev.clientX - r.left) / r.width * video.duration)); }
      player.showOsd(); return;
    }
    var c = t && t.getAttribute ? t.getAttribute('data-ctl') : null;
    if (c === 'back') goBack();
    else if (c === 'rew') player.seek(-10);
    else if (c === 'ff') player.seek(10);
    else if (c === 'rew60') player.seek(-60);
    else if (c === 'ff60') player.seek(60);
    else if (c === 'menu') player.openMenu();
    else player.togglePause();
    player.showOsd(4000);
  });
  $('screen-player').addEventListener('mousemove', function () { if (current === 'player' && !player.menuOpen) player.showOsd(3000); });
  function updatePlayBtn() { $('ctl-play').textContent = video.paused ? '▶' : '❚❚'; }
  video.addEventListener('play', updatePlayBtn);
  video.addEventListener('pause', updatePlayBtn);
  video.addEventListener('timeupdate', player.updateOsd);
  video.addEventListener('waiting', function () { player.msg('Буферизация…'); });
  video.addEventListener('playing', function () { player.msg(''); });
  video.addEventListener('error', function () {
    if (!player.ctx || player.engine !== 'native') return;
    player.fail('код ' + (video.error && video.error.code));
  });
  video.addEventListener('ended', function () {
    var c = player.ctx; if (!c) return;
    if (!player.completedSent) player.markWatched(true);
    if (settings.autonext && item.data && item.data.serial) {
      nextEpisode(c, function (list, idx) {
        if (list) { toast('Следующая серия: S' + list[idx].season + 'E' + list[idx].number); playEpisode(list, idx, 0); }
        else goBack();
      });
      return;
    }
    goBack();
  });
  function nextEpisode(c, cb) {
    if (c.index + 1 < c.episodes.length) return cb(c.episodes, c.index + 1);
    var seasons = item.data.seasons, cur = c.ep.season, nextS = null;
    each(seasons, function (s) { if (nextS === null && s.number > cur) nextS = s.number; });
    if (nextS === null) return cb(null);
    loadSeason(nextS, function (list) {
      if (!list || !list.length) return cb(null);
      item.season = nextS; item.episodes = list;
      cb(list, 0);
    });
  }
  function playEpisode(list, idx, from) {
    var ep = list[idx], it = item.data;
    if (!ep) return;
    if (!ep.manifest) { toast('Нет ссылки на видео'); return; }
    var title = it.title + (it.serial ? ' — S' + ep.season + 'E' + ep.number + (ep.title ? ' «' + ep.title + '»' : '') : (list.length > 1 ? ' — часть ' + ep.number : ''));
    var t = from != null ? from : ((!ep.watched && ep.time > 30 && (!ep.duration || ep.time < ep.duration - 60)) ? ep.time : 0);
    if (t > 0) toast('Продолжаю с ' + fmtTime(t) + ' (↓ — назад на минуту)', 4000);
    player.start({ episodes: list, index: idx, ep: ep, title: title }, t);
  }

  function qualityName(l, i) {
    var w = l.width || 0;
    if (w >= 3800) return '4K';
    if (w >= 1900) return '1080p';
    if (w >= 1260) return '720p';
    if (w >= 700) return '480p';
    return l.height ? l.height + 'p' : 'Уровень ' + (i + 1);
  }
  /* subtitles: Russian, English, Ukrainian first, the rest as the site lists them */
  function subsRank(s) { var l = (s.lang || s.name || '').toLowerCase().slice(0, 3); return l === 'rus' ? 0 : l === 'eng' ? 1 : l === 'ukr' ? 2 : 3; }

  /* ---------- settings ---------- */
  function openSettings() {
    var box = $('settings-box'); clear(box);
    box.appendChild(el('h1', null, 'Настройки'));
    box.appendChild(el('h2', null, 'Плеер'));
    each([['auto', 'Авто'], ['native', 'Встроенный в ТВ'], ['hlsjs', 'hls.js (дорожки, субтитры, качество)']], function (s) {
      var b = el('button', 'btn focusable' + (settings.engine === s[0] ? ' on' : ''), s[1]);
      b.onclick = function () { settings.engine = s[0]; saveSettings(); openSettings(); };
      box.appendChild(b);
    });
    box.appendChild(el('h2', null, 'Автопереход к следующей серии'));
    var an = el('button', 'btn focusable', settings.autonext ? 'Включён' : 'Выключен');
    an.onclick = function () { settings.autonext = !settings.autonext; saveSettings(); openSettings(); };
    box.appendChild(an);
    box.appendChild(el('h2', null, 'Запомненные звук и субтитры'));
    var pr = el('button', 'btn focusable', 'Звук: ' + (settings.audio || 'по умолчанию') + ' · Субтитры: ' + (settings.subs === 'off' ? 'выкл.' : settings.subs) + ' — сбросить');
    pr.onclick = function () { settings.audio = ''; settings.audioLang = ''; settings.subs = 'off'; saveSettings(); openSettings(); toast('Сброшено'); };
    box.appendChild(pr);
    box.appendChild(el('h2', null, 'Аккаунт' + (auth.user ? ': ' + auth.user : '')));
    var lo = el('button', 'btn focusable', 'Выйти из аккаунта на этом ТВ');
    lo.onclick = function () { auth.session = null; store.del('session'); homeLoaded = false; openLogin(); };
    box.appendChild(lo);
    var rl = el('button', 'btn focusable', 'Обновить главную');
    rl.onclick = function () { homeLoaded = false; openHome(); };
    box.appendChild(rl);
    var ex = el('button', 'btn focusable', 'Выход из приложения');
    ex.onclick = exitApp;
    box.appendChild(ex);
    box.appendChild(el('h2', null, 'Плитка KinoPub на главном экране ТВ'));
    var ti = el('button', 'btn focusable', 'Установить плитку');
    var tiOut = el('div', 'info', tvApiReport());
    ti.onclick = function () { installTile(tiOut); };
    box.appendChild(ti);
    box.appendChild(tiOut);
    var mse = !!(window.MediaSource || window.WebKitMediaSource);
    box.appendChild(el('div', 'info',
      'Прокси: ' + PROXY + '\n' +
      'Браузер: ' + navigator.userAgent + '\n' +
      'HLS встроенный: ' + (nativeHls() ? video.canPlayType('application/vnd.apple.mpegurl') : 'нет') +
      ' · MediaSource: ' + (mse ? 'да' : 'нет') + ' · hls.js: ' + (window.Hls ? (hlsJsOk() ? 'загружен, работает' : 'загружен, НЕ поддерживается') : 'не загружен') +
      ' · audioTracks: ' + (video.audioTracks ? 'да' : 'нет') + '\n' +
      'Последние кнопки пульта (keyCode): ' + lastKeys.join(', ')));
    showScreen('settings');
  }

  /* ---------- tile on the TV home screen (VIDAA browser API) ---------- */
  var TILE_ID = 'KinoPubdebug';
  function tvCall(name) { try { var f = window[name]; return typeof f === 'function' ? String(f()) : '—'; } catch (e) { return 'ошибка: ' + e; } }
  function tvApiReport() {
    var names = [];
    try { for (var k in window) if (/^(Hisense|omi_|opera_omi|vowOS|hisense)/.test(k)) names.push(k); } catch (e) {}
    return 'Модель: ' + tvCall('Hisense_GetModelName') + ' · прошивка: ' + tvCall('Hisense_GetFirmWareVersion') +
      ' · страна: ' + tvCall('Hisense_GetCountryCode') + '\n' +
      'Hisense_installApp: ' + (typeof window.Hisense_installApp) + ' · omi_platform: ' + (typeof window.omi_platform) +
      ' · opera_omi: ' + (typeof window.opera_omi) + '\n' +
      'Функции ТВ: ' + (names.length ? names.sort().join(', ') : 'не найдены');
  }
  function refreshTvApps(id) {
    var m = { type: 'APPMessage', MsgType: 'appControl', action: 'updateAppState', source: 'browser', startAppType: 2,
      param: { event: 'AllAppsUpdate', SubModuleName: 'AllApps', startFrom: '', appInfo: id } };
    try { if (window.omi_platform) window.omi_platform.sendPlatformMessage(JSON.stringify(m));
      else if (window.opera_omi) window.opera_omi.sendPlatformMessage(JSON.stringify(m)); } catch (e) {}
  }
  function installTile(out) {
    var base = location.href.replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
    var icon = base + 'icon.png';
    var say = function (t) { out.textContent = t + '\n\n' + tvApiReport(); toast(t, 6000); };
    if (typeof window.Hisense_installApp !== 'function') {
      return say('Телевизор не даёт этой странице устанавливать плитки (Hisense_installApp недоступна).');
    }
    say('Устанавливаю…');
    var answered = false;
    setTimeout(function () { if (!answered) say('Телевизор не ответил за 15 секунд. Проверьте конец списка приложений.'); }, 15000);
    try {
      window.Hisense_installApp(TILE_ID, 'KinoPub', icon, icon, icon, base, 'store', function (status) {
        answered = true;
        if (status) say('Телевизор отказал в установке (код ' + status + ').');
        else { refreshTvApps(TILE_ID); say('Готово: плитка KinoPub добавлена. Она в конце списка приложений.'); }
      });
    } catch (e) { answered = true; say('Ошибка при вызове установки: ' + e); }
  }

  /* ---------- scale 1920x1080 to the real screen ---------- */
  function fitScreen() {
    var w = window.innerWidth || 1920, h = window.innerHeight || 1080;
    var k = Math.min(w / 1920, h / 1080);
    var b = document.body.style;
    b.transformOrigin = b.webkitTransformOrigin = '0 0';
    b.transform = b.webkitTransform = 'translate(' + Math.round((w - 1920 * k) / 2) + 'px,' + Math.round((h - 1080 * k) / 2) + 'px) scale(' + k + ')';
  }
  fitScreen();
  window.addEventListener('resize', fitScreen);

  /* ---------- boot ---------- */
  function boot() {
    if (!PROXY) { openLogin(); $('login-status').textContent = 'В config.js не указан адрес прокси (proxy).'; return; }
    if (auth.session) openHome(); else openLogin();
  }
  window.addEventListener('beforeunload', function () { if (current === 'player') player.mark(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && current === 'player') { video.pause(); player.mark(true); } });
  boot();
})();
