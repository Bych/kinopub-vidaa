/* KinoPub for Hisense VIDAA — ES5 only (old TV browser engine). */
(function () {
  'use strict';

  var CFG = window.KP_CONFIG || {};
  var API = (CFG.proxy || '').replace(/\/+$/, '');
  var PER_PAGE = CFG.perPage || 24;

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
  var settings = store.get('settings', { quality: '1080p', stream: 'http', autonext: true });
  function saveSettings() { store.set('settings', settings); }

  /* ---------- HTTP ---------- */
  function http(method, url, cb) {
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    x.setRequestHeader('Accept', 'application/json');
    x.timeout = 20000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
      cb(x.status, data);
    };
    x.onerror = function () { cb(0, null); };
    x.ontimeout = function () { cb(0, null); };
    x.send();
  }

  /* ---------- auth ---------- */
  var auth = {
    token: store.get('token', null), // {access_token, refresh_token, expires_at}
    refreshing: false,
    waiters: []
  };
  function saveToken(t) {
    auth.token = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 };
    store.set('token', auth.token);
  }
  function logout() { auth.token = null; store.del('token'); showScreen('auth'); startDeviceFlow(); }

  function refreshToken(cb) {
    if (!auth.token || !auth.token.refresh_token) return cb(false);
    auth.waiters.push(cb);
    if (auth.refreshing) return;
    auth.refreshing = true;
    http('POST', API + '/oauth2/token?' + qs({ grant_type: 'refresh_token', refresh_token: auth.token.refresh_token }), function (st, d) {
      auth.refreshing = false;
      var ok = st === 200 && d && d.access_token;
      if (ok) saveToken(d);
      var w = auth.waiters; auth.waiters = [];
      each(w, function (f) { f(ok); });
    });
  }

  /* api(path, params, cb(err, data)) — adds access_token, refreshes on 401 */
  function api(path, params, cb, _retried) {
    if (!auth.token) return cb('no_token');
    params = params || {};
    var url = API + path + '?' + qs(params) + '&access_token=' + encodeURIComponent(auth.token.access_token);
    loader(true);
    http('GET', url, function (st, d) {
      loader(false);
      if (st === 200 && d) return cb(null, d);
      if (st === 401 && !_retried) {
        return refreshToken(function (ok) {
          if (ok) api(path, params, cb, true); else { toast('Сессия истекла, войдите заново'); logout(); }
        });
      }
      if (st === 0) { toast('Нет связи с прокси ' + API); return cb('network'); }
      var msg = (d && (d.message || d.error_description || d.error)) || ('HTTP ' + st);
      toast('Ошибка API: ' + msg);
      cb(msg);
    });
  }
  function apiPost(path, params) {
    if (!auth.token) return;
    http('POST', API + path + '?' + qs(params || {}) + '&access_token=' + encodeURIComponent(auth.token.access_token), function () {});
  }

  var deviceFlow = { timer: null, code: null };
  function startDeviceFlow() {
    clearTimeout(deviceFlow.timer);
    $('auth-code').textContent = '······';
    $('auth-status').textContent = 'Получаю код…';
    http('POST', API + '/oauth2/device?grant_type=device_code', function (st, d) {
      if (st !== 200 || !d || !d.user_code) {
        $('auth-status').textContent = 'Не удалось получить код: ' + ((d && (d.error_description || d.error)) || (st === 0 ? 'прокси недоступен (' + API + ')' : 'HTTP ' + st));
        focus($('auth-retry'));
        return;
      }
      deviceFlow.code = d.code;
      var uri = (d.verification_uri || 'https://kino.watch/device').replace('kino.pub', 'kino.watch').replace(/^https?:\/\//, '');
      $('auth-url').textContent = uri;
      $('auth-code').textContent = d.user_code;
      $('auth-status').textContent = 'Жду подтверждения…';
      var interval = Math.max(3, d.interval || 5) * 1000;
      var deadline = Date.now() + (d.expires_in || 600) * 1000;
      (function poll() {
        if (Date.now() > deadline) { $('auth-status').textContent = 'Код истёк'; focus($('auth-retry')); return; }
        http('POST', API + '/oauth2/device?' + qs({ grant_type: 'device_token', code: deviceFlow.code }), function (st, t) {
          if (st === 200 && t && t.access_token) {
            saveToken(t);
            apiPost('/v1/device/notify', { title: CFG.deviceTitle || 'Hisense VIDAA', hardware: CFG.deviceHardware || 'Hisense', software: CFG.deviceSoftware || 'kinopub-vidaa' });
            openHome();
            return;
          }
          if (t && t.error && t.error !== 'authorization_pending') {
            $('auth-status').textContent = 'Ошибка: ' + (t.error_description || t.error); focus($('auth-retry')); return;
          }
          deviceFlow.timer = setTimeout(poll, interval);
        });
      })();
    });
  }
  $('auth-retry').onclick = startDeviceFlow;

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
    if (f && document.body.contains(f)) focus(f); else focusFirst();
  }
  function goBack() {
    if (current === 'player') { player.stop(); }
    if (current === 'auth') return exitApp();
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
    if (focused) focused.classList.remove('focus');
    focused = e; e.classList.add('focus');
    scrollIntoView(e);
  }
  function focusFirst() {
    var list = screens[current].querySelectorAll('.focusable');
    focus(list.length ? list[0] : null);
  }
  function visibleFocusables() {
    var out = [], list = screens[current].querySelectorAll('.focusable');
    each(list, function (e) { if (e.offsetWidth || e.offsetHeight) out.push(e); });
    return out;
  }
  function rect(e) { var r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 }; }
  /* geometric spatial navigation */
  function move(dir) {
    if (!focused) return focusFirst();
    var cur = rect(focused), best = null, bestScore = Infinity;
    each(visibleFocusables(), function (e) {
      if (e === focused) return;
      var r = rect(e), primary, secondary, overlap;
      if (dir === 'left') { primary = cur.l - r.r; secondary = Math.abs(r.cy - cur.cy); overlap = r.b > cur.t && r.t < cur.b; }
      else if (dir === 'right') { primary = r.l - cur.r; secondary = Math.abs(r.cy - cur.cy); overlap = r.b > cur.t && r.t < cur.b; }
      else if (dir === 'up') { primary = cur.t - r.b; secondary = Math.abs(r.cx - cur.cx); overlap = r.r > cur.l && r.l < cur.r; }
      else { primary = r.t - cur.b; secondary = Math.abs(r.cx - cur.cx); overlap = r.r > cur.l && r.l < cur.r; }
      if (primary < -10) return; // not in that direction
      var score = primary + (overlap ? 0 : 1000) + secondary * (overlap ? 0.3 : 2);
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) focus(best);
    else if (screens[current].onEdge) screens[current].onEdge(dir, focused);
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

  /* ---------- keys ---------- */
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: [8, 27, 461, 10009, 166], PLAY: [415, 179, 10252, 10253], PAUSE: [19], STOP: [413], REW: [412, 227], FF: [417, 228], RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: [457], MENU: [18, 93, 10135] };
  function isKey(code, list) { for (var i = 0; i < list.length; i++) if (list[i] === code) return true; return false; }

  document.addEventListener('keydown', function (ev) {
    var c = ev.keyCode;
    if (current === 'player') { if (player.key(c)) { ev.preventDefault(); } return; }
    var handled = true;
    if (c === KEY.LEFT) move('left');
    else if (c === KEY.RIGHT) move('right');
    else if (c === KEY.UP) move('up');
    else if (c === KEY.DOWN) move('down');
    else if (c === KEY.ENTER) { if (focused && focused.onclick) focused.onclick(); }
    else if (isKey(c, KEY.BACK)) goBack();
    else handled = false;
    if (handled) ev.preventDefault();
  });

  /* ---------- tiles ---------- */
  function poster(it) { return (it.posters && (it.posters.medium || it.posters.small || it.posters.big)) || ''; }
  function tile(it) {
    var t = el('div', 'tile focusable');
    var img = el('img'); img.src = poster(it); img.alt = ''; t.appendChild(img);
    if (it.quality) t.appendChild(el('span', 'badge', it.quality >= 2160 ? '4K' : it.quality + 'p'));
    if (it['new']) { var b = el('span', 'badge', '+' + it['new']); b.style.right = '0'; t.appendChild(b); }
    var title = (it.title || '').split(' / ')[0];
    t.appendChild(el('div', 'tile-title', title + (it.year ? ' (' + it.year + ')' : '')));
    t.onclick = function () { openItem(it.id); };
    return t;
  }
  function moreTile(onclick) { var t = el('div', 'tile more focusable', 'Ещё…'); t.onclick = onclick; return t; }

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
  function fillRow(container, items, loadMore) {
    each(items, function (it) { container.appendChild(tile(it)); });
    if (loadMore) {
      var m = moreTile(function () {
        var prev = m.previousSibling; container.removeChild(m);
        loadMore(function (more, again) { fillRow(container, more, again ? loadMore : null); focus(prev ? prev.nextSibling || prev : container.firstChild); });
      });
      container.appendChild(m);
    }
  }
  function pagedLoader(path, params) {
    var page = 1;
    return function (cb) {
      page++;
      var p = {}; for (var k in params) p[k] = params[k]; p.page = page; p.perpage = PER_PAGE;
      api(path, p, function (err, d) { if (err) return cb([], false); var pg = d.pagination || {}; cb(d.items || [], pg.current < pg.total); });
    };
  }
  function loadHome() {
    clear($('home-rows'));
    var cont = row('Продолжить просмотр');
    api('/v1/watching/serials', { subscribed: 0 }, function (err, d) {
      var items = (d && d.items) || [];
      api('/v1/watching/movies', {}, function (err2, d2) {
        items = items.concat((d2 && d2.items) || []);
        if (!items.length) cont.parentNode.style.display = 'none';
        fillRow(cont, items.slice(0, 30));
        focusFirst();
      });
    });
    var defs = [
      ['Свежие фильмы', '/v1/items/fresh', { type: 'movie' }],
      ['Свежие сериалы', '/v1/items/fresh', { type: 'serial' }],
      ['Популярные фильмы', '/v1/items/popular', { type: 'movie' }],
      ['Популярные сериалы', '/v1/items/popular', { type: 'serial' }],
      ['Горячее', '/v1/items/hot', { type: 'movie' }]
    ];
    each(defs, function (def) {
      var c = row(def[0]);
      var params = { type: def[2].type, perpage: PER_PAGE, page: 1 };
      api(def[1], params, function (err, d) { if (!err) fillRow(c, d.items || [], pagedLoader(def[1], def[2])); });
    });
  }
  each($('screen-home').querySelectorAll('.topnav .btn'), function (b) {
    b.onclick = function () {
      var a = b.getAttribute('data-action');
      if (a === 'search') openSearch();
      else if (a === 'section') openSection(b.getAttribute('data-type'), b.textContent);
      else if (a === 'settings') openSettings();
    };
  });

  /* ---------- section (grid) ---------- */
  var section = { type: 'movie', sort: 'updated-' };
  function openSection(type, title) {
    section.type = type; $('section-title').textContent = title;
    showScreen('section');
    loadSection();
  }
  function loadSection() {
    var grid = $('section-grid'); clear(grid); grid.scrollTop = 0;
    each($('section-sorts').querySelectorAll('.btn'), function (b) { b.className = 'btn focusable' + (b.getAttribute('data-sort') === section.sort ? ' on' : ''); });
    var params = { type: section.type, sort: section.sort, perpage: PER_PAGE, page: 1 };
    api('/v1/items', params, function (err, d) {
      if (err) return;
      fillRow(grid, d.items || [], pagedLoader('/v1/items', { type: section.type, sort: section.sort }));
      if (grid.firstChild) focus(grid.firstChild);
    });
  }
  each($('section-sorts').querySelectorAll('.btn'), function (b) {
    b.onclick = function () { section.sort = b.getAttribute('data-sort'); loadSection(); };
  });

  /* ---------- search + on-screen keyboard ---------- */
  var search = { q: '', timer: null };
  var OSK_ROWS = ['абвгдеёжзий', 'клмнопрстуф', 'хцчшщъыьэюя', 'abcdefghijk', 'lmnopqrstuv', 'wxyz1234567', '890-:.,!?&'];
  function buildOsk() {
    var osk = $('osk'); clear(osk);
    each(OSK_ROWS, function (r) {
      each(r.split(''), function (ch) { var k = el('div', 'key focusable', ch); k.onclick = function () { search.q += ch; renderSearchInput(); }; osk.appendChild(k); });
      osk.appendChild(el('br'));
    });
    var sp = el('div', 'key wide focusable', 'пробел'); sp.onclick = function () { search.q += ' '; renderSearchInput(); }; osk.appendChild(sp);
    var bs = el('div', 'key wide focusable', '⌫'); bs.onclick = function () { search.q = search.q.slice(0, -1); renderSearchInput(); }; osk.appendChild(bs);
    var cl = el('div', 'key wide focusable', 'очистить'); cl.onclick = function () { search.q = ''; renderSearchInput(); }; osk.appendChild(cl);
  }
  function renderSearchInput() {
    var inp = $('search-input'); clear(inp); inp.appendChild(document.createTextNode(search.q)); inp.appendChild(el('span', 'caret', '|'));
    clearTimeout(search.timer);
    if (search.q.length >= 3) search.timer = setTimeout(doSearch, 600);
  }
  function doSearch() {
    var grid = $('search-grid'); clear(grid);
    api('/v1/items/search', { q: search.q, perpage: 40 }, function (err, d) {
      if (err) return;
      var items = d.items || [];
      if (!items.length) grid.appendChild(el('div', 'empty', 'Ничего не найдено'));
      fillRow(grid, items);
    });
  }
  function openSearch() { if (!$('osk').firstChild) buildOsk(); showScreen('search'); }

  /* ---------- item ---------- */
  var item = { data: null, season: 0 };
  function openItem(id) {
    api('/v1/items/' + id, {}, function (err, d) {
      if (err || !d.item) return;
      item.data = d.item; item.season = 0;
      renderItem();
      showScreen('item');
      var pb = $('item-actions').querySelector('.btn'); if (pb) focus(pb);
    });
  }
  function isSerial(it) { return !!(it.seasons && it.seasons.length); }
  function renderItem() {
    var it = item.data;
    $('item-bg').style.backgroundImage = 'url(' + (it.posters && it.posters.big || '') + ')';
    $('item-poster').src = poster(it) || (it.posters && it.posters.big) || '';
    $('item-title').textContent = it.title || '';
    var meta = [];
    if (it.year) meta.push(it.year);
    if (it.genres) meta.push(it.genres.map(function (g) { return g.title; }).join(', '));
    if (it.countries) meta.push(it.countries.map(function (g) { return g.title; }).join(', '));
    if (it.imdb_rating) meta.push('IMDb ' + it.imdb_rating);
    if (it.kinopoisk_rating) meta.push('КП ' + it.kinopoisk_rating);
    if (it.duration && it.duration.average) meta.push(fmtDur(it.duration.average));
    if (it.quality) meta.push(it.quality >= 2160 ? '4K' : it.quality + 'p');
    if (it.voice) meta.push(it.voice);
    $('item-meta').textContent = meta.join('  •  ');
    $('item-plot').textContent = it.plot || '';

    var actions = $('item-actions'); clear(actions);
    var seasons = $('item-seasons'); clear(seasons);
    var eps = $('item-episodes'); clear(eps);

    if (isSerial(it)) {
      // find first unfinished episode for "continue"
      var next = findNextEpisode(it);
      var play = el('button', 'btn focusable', next ? ('Смотреть S' + next.season.number + 'E' + next.episode.number) : 'Смотреть');
      play.onclick = function () { if (next) playEpisode(next.season, next.episode); };
      actions.appendChild(play);
      var wl = el('button', 'btn focusable', it.in_watchlist ? '✓ Буду смотреть' : '+ Буду смотреть');
      wl.onclick = function () { api('/v1/watching/togglewatchlist', { id: it.id }, function (err, d) { if (!err) { it.in_watchlist = d.watching; wl.textContent = d.watching ? '✓ Буду смотреть' : '+ Буду смотреть'; } }); };
      actions.appendChild(wl);
      each(it.seasons, function (s, i) {
        var b = el('button', 'btn focusable' + (i === item.season ? ' on' : ''), 'Сезон ' + s.number);
        b.onclick = function () { item.season = i; renderItem(); focus($('item-seasons').children[i]); };
        seasons.appendChild(b);
      });
      var s = it.seasons[item.season];
      each(s.episodes, function (ep) {
        var e = el('div', 'ep focusable' + (ep.watching && ep.watching.status === 1 ? ' watched' : ''));
        e.appendChild(document.createTextNode(ep.number + '. ' + (ep.title || 'Эпизод ' + ep.number)));
        e.appendChild(el('span', 'ep-dur', fmtDur(ep.duration)));
        if (ep.watching && ep.watching.time > 0 && ep.duration) { var p = el('div', 'progress'); var i2 = el('i'); i2.style.width = Math.min(100, ep.watching.time / ep.duration * 100) + '%'; p.appendChild(i2); e.appendChild(p); }
        e.onclick = function () { playEpisode(s, ep); };
        eps.appendChild(e);
      });
    } else {
      each(it.videos || [], function (v, i) {
        var multi = it.videos.length > 1;
        var play = el('button', 'btn focusable', multi ? ('Часть ' + v.number + (v.title ? ': ' + v.title : '')) : 'Смотреть');
        play.onclick = function () { playVideo(v, null); };
        actions.appendChild(play);
      });
      var bm = el('button', 'btn focusable', '★ В закладки');
      bm.onclick = function () { api('/v1/bookmarks/toggle-item', { item: it.id }, function (err) { if (!err) toast('Готово'); }); };
      actions.appendChild(bm);
    }
  }
  /* Which episode to offer: a started-but-unfinished one (latest), else the first
     unwatched episode after the last fully watched one, else episode 1. */
  function findNextEpisode(it) {
    var all = [];
    each(it.seasons, function (s) { each(s.episodes, function (e) { all.push({ season: s, episode: e, st: (e.watching || {}).status }); }); });
    if (!all.length) return null;
    var started = null, lastWatched = -1;
    each(all, function (x, i) { if (x.st === 0) started = x; if (x.st === 1) lastWatched = i; });
    if (started) return started;
    for (var i = lastWatched + 1; i < all.length; i++) if (all[i].st !== 1) return all[i];
    return all[0];
  }
  function playEpisode(season, ep) { playVideo(ep, season); }

  /* ---------- player ---------- */
  var video = $('video');
  var player = {
    ctx: null, osdTimer: null, markTimer: null, menuOpen: false, seekAcc: 0, seekTimer: null,
    key: function (c) {
      if (player.menuOpen) {
        if (c === KEY.UP) move('up'); else if (c === KEY.DOWN) move('down');
        else if (c === KEY.ENTER) { if (focused && focused.onclick) focused.onclick(); }
        else if (isKey(c, KEY.BACK) || c === KEY.LEFT || isKey(c, KEY.INFO) || c === KEY.RED || c === KEY.BLUE || c === KEY.YELLOW || c === KEY.GREEN || isKey(c, KEY.MENU)) player.closeMenu();
        return true;
      }
      if (isKey(c, KEY.BACK)) { goBack(); return true; }
      if (c === KEY.ENTER || isKey(c, KEY.PLAY) || isKey(c, KEY.PAUSE)) { player.togglePause(); return true; }
      if (c === KEY.LEFT || isKey(c, KEY.REW)) { player.seek(-10); return true; }
      if (c === KEY.RIGHT || isKey(c, KEY.FF)) { player.seek(10); return true; }
      if (c === KEY.UP) { player.seek(60); return true; }
      if (c === KEY.DOWN) { player.seek(-60); return true; }
      if (isKey(c, KEY.STOP)) { goBack(); return true; }
      if (c === KEY.RED || c === KEY.BLUE || c === KEY.YELLOW || c === KEY.GREEN || isKey(c, KEY.INFO) || isKey(c, KEY.MENU)) { player.openMenu(); return true; }
      return false;
    },
    showOsd: function (ms) {
      $('player-osd').className = 'player-osd show';
      clearTimeout(player.osdTimer);
      player.osdTimer = setTimeout(function () { if (!video.paused) $('player-osd').className = 'player-osd'; }, ms || 3000);
    },
    msg: function (text) { var m = $('player-msg'); m.textContent = text || ''; m.className = 'player-msg' + (text ? ' show' : ''); },
    togglePause: function () { if (video.paused) video.play(); else { video.pause(); player.mark(); } player.showOsd(); },
    seek: function (d) {
      player.seekAcc += d; clearTimeout(player.seekTimer);
      var target = Math.max(0, Math.min((video.duration || 1e9) - 2, video.currentTime + player.seekAcc));
      $('osd-cur').textContent = fmtTime(target); $('osd-fill').style.width = (video.duration ? target / video.duration * 100 : 0) + '%';
      player.showOsd();
      player.seekTimer = setTimeout(function () { video.currentTime = target; player.seekAcc = 0; }, 350);
    },
    updateOsd: function () {
      if (player.seekAcc) return;
      $('osd-cur').textContent = fmtTime(video.currentTime); $('osd-dur').textContent = fmtTime(video.duration);
      $('osd-fill').style.width = (video.duration ? video.currentTime / video.duration * 100 : 0) + '%';
    },
    mark: function () {
      var c = player.ctx; if (!c || !video.currentTime) return;
      var p = { id: c.item.id, time: Math.floor(video.currentTime), video: c.video.number };
      if (c.season) p.season = c.season.number;
      api('/v1/watching/marktime', p, function () {});
      c.video.watching = c.video.watching || {}; c.video.watching.time = Math.floor(video.currentTime); c.video.watching.status = 0;
    },
    pickFile: function (files) {
      var want = settings.quality === 'max' ? 99999 : parseInt(settings.quality, 10);
      var sorted = files.slice().sort(function (a, b) { return (b.h || 0) - (a.h || 0); });
      for (var i = 0; i < sorted.length; i++) if ((sorted[i].h || 0) <= want) return sorted[i];
      return sorted[sorted.length - 1];
    },
    urlFor: function (f) {
      var u = f.url || f.urls || {};
      return u[settings.stream] || u.http || u.hls4 || u.hls || '';
    },
    start: function (ctx, startTime) {
      player.ctx = ctx;
      var f = player.pickFile(ctx.video.files || []);
      if (!f) { toast('Нет файлов для воспроизведения'); return; }
      ctx.file = f;
      $('osd-title').textContent = ctx.title;
      $('osd-info').textContent = '  [' + f.quality + ', ' + settings.stream + ']';
      player.msg('Загрузка…');
      showScreen('player');
      video.src = player.urlFor(f);
      video.load();
      var once = function () {
        video.removeEventListener('loadedmetadata', once);
        if (startTime > 0) { try { video.currentTime = startTime; } catch (e) {} }
        player.applyAudio();
        player.msg('');
      };
      video.addEventListener('loadedmetadata', once);
      video.play();
      player.showOsd();
      clearInterval(player.markTimer);
      player.markTimer = setInterval(function () { if (!video.paused && !video.ended) player.mark(); }, 30000);
    },
    stop: function () {
      clearInterval(player.markTimer);
      if (player.ctx && video.currentTime > 0) player.mark();
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src'); try { video.load(); } catch (e) {}
      player.closeMenu(); player.msg('');
      var c = player.ctx; player.ctx = null;
      if (c && item.data && item.data.id === c.item.id) renderItem();
    },
    applyAudio: function () {
      var idx = player.ctx.audioIndex;
      var at = video.audioTracks;
      if (!at || idx == null) return;
      for (var i = 0; i < at.length; i++) at[i].enabled = (i === idx);
    },
    openMenu: function () {
      var m = $('player-menu'); clear(m);
      var c = player.ctx, v = c.video;
      m.appendChild(el('h2', null, 'Качество'));
      each(v.files || [], function (f) {
        var b = el('button', 'btn focusable' + (f === c.file ? ' on' : ''), f.quality + (f.codec ? ' ' + f.codec : ''));
        b.onclick = function () { var t = video.currentTime; settings.quality = f.quality; saveSettings(); player.closeMenu(); player.start(c, t); };
        m.appendChild(b);
      });
      m.appendChild(el('h2', null, 'Поток'));
      each(['http', 'hls4', 'hls'], function (s) {
        var b = el('button', 'btn focusable' + (s === settings.stream ? ' on' : ''), s === 'http' ? 'MP4 (прямой)' : s.toUpperCase());
        b.onclick = function () { var t = video.currentTime; settings.stream = s; saveSettings(); player.closeMenu(); player.start(c, t); };
        m.appendChild(b);
      });
      var at = video.audioTracks;
      if (at && at.length > 1) {
        m.appendChild(el('h2', null, 'Звуковая дорожка'));
        for (var i = 0; i < at.length; i++) (function (i) {
          var a = (v.audios || [])[i];
          var label = a ? ((a.lang || '') + ' ' + (a.type && a.type.title || '') + ' ' + (a.author && a.author.title || '')).replace(/\s+/g, ' ') : (at[i].label || at[i].language || ('Дорожка ' + (i + 1)));
          var b = el('button', 'btn focusable' + (at[i].enabled ? ' on' : ''), label);
          b.onclick = function () { c.audioIndex = i; player.applyAudio(); player.closeMenu(); };
          m.appendChild(b);
        })(i);
      } else if (v.audios && v.audios.length > 1) {
        m.appendChild(el('h2', null, 'Дорожки в файле: ' + v.audios.length + ' (переключение не поддерживается этим ТВ)'));
      }
      var mk = el('button', 'btn focusable', 'Отметить как просмотренное');
      mk.onclick = function () { var p = { id: c.item.id, video: v.number }; if (c.season) p.season = c.season.number; api('/v1/watching/toggle', p, function (err) { if (!err) toast('Отмечено'); }); player.closeMenu(); };
      m.appendChild(mk);
      m.className = 'player-menu show'; player.menuOpen = true;
      focus(m.querySelector('.focusable'));
    },
    closeMenu: function () { $('player-menu').className = 'player-menu'; player.menuOpen = false; }
  };
  video.addEventListener('timeupdate', player.updateOsd);
  video.addEventListener('waiting', function () { player.msg('Буферизация…'); });
  video.addEventListener('playing', function () { player.msg(''); });
  video.addEventListener('error', function () {
    var c = player.ctx; if (!c) return;
    var code = video.error && video.error.code;
    if (!c.triedFallback && settings.stream !== 'hls') { c.triedFallback = true; var alt = settings.stream === 'http' ? 'hls4' : 'http'; toast('Ошибка видео (' + code + '), пробую ' + alt); var t = video.currentTime; var s = settings.stream; settings.stream = alt; player.start(c, t); settings.stream = s; return; }
    player.msg('Не удалось воспроизвести (код ' + code + ')');
  });
  video.addEventListener('ended', function () {
    var c = player.ctx; if (!c) return;
    api('/v1/watching/toggle', c.season ? { id: c.item.id, season: c.season.number, video: c.video.number } : { id: c.item.id, video: c.video.number }, function () {});
    if (c.video.watching) c.video.watching.status = 1;
    if (settings.autonext && c.season) {
      var nx = nextEpisode(c);
      if (nx) { toast('Следующая серия: S' + nx.season.number + 'E' + nx.episode.number); player.stop(); playVideo(nx.episode, nx.season, true); return; }
    }
    goBack();
  });
  function nextEpisode(c) {
    var it = c.item, seasons = it.seasons, found = null, take = false;
    each(seasons, function (s) { each(s.episodes, function (e) { if (found) return; if (take) found = { season: s, episode: e }; if (e === c.video) take = true; }); });
    return found;
  }
  function playVideo(v, season, noResume) {
    var it = item.data;
    var title = (it.title || '').split(' / ')[0] + (season ? ' — S' + season.number + 'E' + v.number : (it.videos && it.videos.length > 1 ? ' — часть ' + v.number : ''));
    var ctx = { item: it, video: v, season: season, title: title };
    var t = (v.watching && v.watching.time) || 0;
    if (!noResume && t > 30 && v.duration && t < v.duration - 60) {
      // simple resume prompt via toast + OSD: start from saved position; user can seek back with Down
      toast('Продолжаю с ' + fmtTime(t) + ' (↓ чтобы отмотать)', 4000);
      player.start(ctx, t);
    } else player.start(ctx, 0);
  }

  /* ---------- settings ---------- */
  function openSettings() {
    var box = $('settings-box'); clear(box);
    box.appendChild(el('h1', null, 'Настройки'));
    box.appendChild(el('h2', null, 'Качество по умолчанию'));
    each(['max', '2160p', '1080p', '720p', '480p'], function (q) {
      var b = el('button', 'btn focusable' + (settings.quality === q ? ' on' : ''), q === 'max' ? 'Максимальное' : q);
      b.onclick = function () { settings.quality = q; saveSettings(); openSettings(); focus(b); };
      box.appendChild(b);
    });
    box.appendChild(el('h2', null, 'Тип потока'));
    each([['http', 'MP4 прямой (надёжнее, перемотка быстрее)'], ['hls4', 'HLS4 (адаптивное качество)'], ['hls', 'HLS']], function (s) {
      var b = el('button', 'btn focusable' + (settings.stream === s[0] ? ' on' : ''), s[1]);
      b.onclick = function () { settings.stream = s[0]; saveSettings(); openSettings(); focus(b); };
      box.appendChild(b);
    });
    box.appendChild(el('h2', null, 'Автопереход к следующей серии'));
    var an = el('button', 'btn focusable', settings.autonext ? 'Включён' : 'Выключен');
    an.onclick = function () { settings.autonext = !settings.autonext; saveSettings(); openSettings(); focus(an); };
    box.appendChild(an);
    box.appendChild(el('h2', null, 'Аккаунт'));
    var lo = el('button', 'btn focusable', 'Выйти (отвязать устройство)');
    lo.onclick = function () { apiPost('/v1/device/unlink', {}); logout(); };
    box.appendChild(lo);
    var ex = el('button', 'btn focusable', 'Выход из приложения');
    ex.onclick = exitApp;
    box.appendChild(ex);
    var ua = navigator.userAgent;
    box.appendChild(el('div', 'info', 'Прокси: ' + API + '\nБраузер: ' + ua + '\naudioTracks: ' + (video.audioTracks ? 'да' : 'нет') + ', HLS native: ' + (video.canPlayType('application/vnd.apple.mpegurl') || 'нет') + ', HEVC: ' + (video.canPlayType('video/mp4; codecs="hvc1"') || video.canPlayType('video/mp4; codecs="hev1"') || 'нет')));
    showScreen('settings');
  }

  /* ---------- edge handling (rows) ---------- */
  $('screen-home').onEdge = function (dir) { /* nothing */ };

  /* ---------- boot ---------- */
  function boot() {
    if (!API || API.indexOf('REPLACE-ME') >= 0) {
      showScreen('auth');
      $('auth-status').textContent = 'В config.js не указан адрес прокси (proxy).';
      return;
    }
    if (auth.token) {
      current = null; openHome();
    } else {
      showScreen('auth'); startDeviceFlow();
    }
  }
  window.addEventListener('beforeunload', function () { if (current === 'player') player.mark(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && current === 'player') { video.pause(); player.mark(); } });
  boot();
})();
