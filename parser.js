/* KinoPub for VIDAA — parsing of kino.watch HTML pages. ES5 only.
 *
 * Every function takes a parsed HTML Document (see KP_PARSE.doc) and returns
 * plain objects. All knowledge about the site's markup lives in this file, so
 * when the site changes its layout, this is the only file to fix.
 */
(function (root) {
  'use strict';

  var SITE = 'https://kino.watch';
  var POSTER = 'https://m.staticpop.net/poster/item/';

  function toArr(list) { var a = []; for (var i = 0; i < (list ? list.length : 0); i++) a.push(list[i]); return a; }
  function txt(e) { return e ? (e.textContent || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') : ''; }
  function attr(e, n) { return e && e.getAttribute ? (e.getAttribute(n) || '') : ''; }
  function itemId(href) { var m = /\/item\/view\/(\d+)/.exec(href || ''); return m ? parseInt(m[1], 10) : 0; }
  function closest(e, test, stop) { while (e && e !== stop && e.nodeType === 1) { if (test(e)) return e; e = e.parentNode; } return null; }
  function hasClass(e, c) { return e && e.className && (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }

  /* HTML string -> Document. DOMParser first, fallback for very old engines. */
  function doc(html) {
    var d = null;
    try { d = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { d = null; }
    if (!d || !d.body) {
      d = document.implementation.createHTMLDocument('');
      d.documentElement.innerHTML = html;
    }
    return d;
  }

  /* Poster URL: absolute, and the "medium" size (small is 100px wide, too blurry on a TV). */
  function posterUrl(src, id) {
    if (!src && id) return POSTER + 'medium/' + id + '.jpg';
    if (src.indexOf('//') === 0) src = 'https:' + src;
    else if (src.charAt(0) === '/') src = SITE + src;
    return src.replace('/poster/item/small/', '/poster/item/medium/');
  }
  function splitTitle(t) {
    var p = (t || '').split(' / ');
    return { title: p[0] || '', orig: p.length > 1 ? p.slice(1).join(' / ') : '' };
  }

  /* All item cards inside `scope`, in page order, one entry per item id.
     Works for every card layout on the site: catalog grid (.item-title),
     home carousels (a[title]), search and history rows (div.item.r). */
  function cards(scope) {
    var out = [], byId = {};
    if (!scope) return out;
    toArr(scope.querySelectorAll('a[href*="/item/view/"]')).forEach(function (a) {
      var id = itemId(attr(a, 'href'));
      if (!id) return;
      var c = byId[id];
      if (!c) { c = byId[id] = { id: id, title: '', orig: '', poster: '', badge: '' }; out.push(c); }
      var img = a.querySelector('img');
      if (img && !c.poster) c.poster = posterUrl(attr(img, 'src') || attr(img, 'data-src'), 0);
      var t = attr(a, 'title') || txt(a) || (img ? attr(img, 'alt') : '');
      if (t) {
        var inAuthor = closest(a, function (e) { return hasClass(e, 'item-author'); }, scope);
        if (inAuthor) { if (!c.orig) c.orig = t; }
        else if (!c.title) { var s = splitTitle(t); c.title = s.title; if (s.orig && !c.orig) c.orig = s.orig; }
      }
      if (!c.badge) {
        // "new episodes" counter in the top-right corner of a poster (watchlist page)
        var box = closest(a, function (e) { return e.querySelector && e.querySelector('.topright-2x'); }, scope);
        var lab = box ? box.querySelector('.topright-2x .label') : null;
        var n = txt(lab);
        if (/^\d+$/.test(n)) c.badge = n;
      }
    });
    out.forEach(function (c) { if (!c.poster) c.poster = posterUrl('', c.id); if (!c.title) c.title = c.orig || ('#' + c.id); });
    return out;
  }

  function content(d) { return d.querySelector('#view') || d.querySelector('#content') || d.body; }

  /* Catalog / search / history / watchlist page -> { items, hasNext } */
  function list(d) {
    var next = d.querySelector('.pagination li.next a');
    var nextLi = next ? next.parentNode : null;
    return { items: cards(content(d)), hasNext: !!(next && !hasClass(nextLi, 'disabled')) };
  }

  /* Home page: rows of "h3.index" heading + carousel. */
  function home(d) {
    var rows = [];
    toArr(d.querySelectorAll('h3.index')).forEach(function (h) {
      var link = h.querySelector('a');
      var sib = h.nextElementSibling || h.nextSibling;
      while (sib && sib.nodeType !== 1) sib = sib.nextSibling;
      if (!sib) return;
      var items = cards(sib);
      if (!items.length) return;
      if (link && /^\/3d\b/.test(attr(link, 'href'))) return; // 3D is useless on this TV
      rows.push({ title: txt(h), path: link ? attr(link, 'href') : '', items: items });
    });
    return rows;
  }

  /* Username of the logged-in user (needed for /watchlist/<user>). */
  function user(d) {
    var a = d.querySelector('a[href^="/watchlist/"]') || d.querySelector('a[href^="/users/"]');
    var m = a ? /\/(?:watchlist|users)\/([^\/?#]+)/.exec(attr(a, 'href')) : null;
    return m ? m[1] : '';
  }
  function isLoginPage(d) { return !!d.querySelector('input[name="login-form[password]"]'); }

  /* Find `window.NAME = <json>;` in inline scripts and parse the JSON. */
  function scriptVar(d, name) {
    var scripts = d.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].text || scripts[i].textContent || '';
      var k = s.indexOf(name);
      if (k < 0) continue;
      var m = new RegExp('(?:window\\.)?' + name + '\\s*=\\s*').exec(s.slice(k));
      if (!m) continue;
      var start = k + m.index + m[0].length;
      var raw = jsonSlice(s, start);
      if (raw == null) continue;
      try { return JSON.parse(raw); } catch (e) { /* try the next script */ }
    }
    return null;
  }
  /* Returns the JSON literal that starts at s[start]: an array/object (balanced,
     string-aware), or a scalar up to the next ; or newline. */
  function jsonSlice(s, start) {
    var c = s.charAt(start);
    if (c !== '[' && c !== '{') {
      var m = /^[^;\n]*/.exec(s.slice(start));
      return m ? m[0].replace(/\s+$/, '') : null;
    }
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  /* One episode/part from PLAYER_PLAYLIST or /item/playlist. */
  function episode(e) {
    return {
      mediaId: e.media_id,
      season: e.season || 0,
      number: e.episode || 1,
      title: e.episode_title || '',
      duration: parseInt(e.duration, 10) || 0,
      time: parseInt(e.marktime, 10) || 0,
      watched: Number(e.completed) === 1,
      manifest: e.manifest || '',
      thumb: e.thumb || ''
    };
  }

  /* Item page (/item/view/ID) -> full item. */
  function item(d) {
    var id = scriptVar(d, 'PLAYER_ITEM_ID');
    var playlist = scriptVar(d, 'PLAYER_PLAYLIST') || [];
    var seasons = scriptVar(d, 'PLAYER_SEASONS') || [];
    var curSeason = scriptVar(d, 'PLAYER_CURRENT_SEASON');
    var startIndex = scriptVar(d, 'PLAYER_START_INDEX');
    if (!id) { var canon = d.querySelector('link[rel="canonical"]'); id = itemId(attr(canon, 'href')) || (playlist[0] && playlist[0].id) || 0; }

    var ru = txt(d.querySelector('.iv-title-ru')), orig = txt(d.querySelector('.iv-title-orig'));
    if (!ru) { var s = splitTitle(txt(d.querySelector('title'))); ru = s.title; orig = orig || s.orig; }

    var big = d.querySelector('img.item-poster-relative');
    var info = [];
    toArr(d.querySelectorAll('table.iv-info tr')).forEach(function (tr) {
      var cells = tr.querySelectorAll('td,th');
      if (cells.length < 2) return;
      var k = txt(cells[0]), v = cellText(cells[cells.length - 1]);
      v = v.replace(/\s*Добавить$/, '').replace(/,(\s*,)+/g, ',');
      if (k && v) info.push({ k: k, v: v });
    });
    var chips = toArr(d.querySelectorAll('.iv-chips .iv-chip')).map(txt).filter(function (x) { return x && !/^S\d+E\d+$/.test(x); });

    var sub = d.querySelector('#watchlist-subscription');
    var favs = toArr(d.querySelectorAll('a.favorites-title')).map(function (a) {
      return { id: attr(a, 'data-id'), title: txt(a), on: !!a.querySelector('.fa-check-square') };
    });

    var isSerial = false;
    each(seasons, function (s) { if (s.season > 0) isSerial = true; });
    var eps = []; each(playlist, function (e) { eps.push(episode(e)); });

    return {
      id: parseInt(id, 10) || 0,
      title: ru, orig: orig,
      poster: big ? posterUrl(attr(big, 'src'), 0) : POSTER + 'big/' + id + '.jpg',
      chips: chips,
      info: info,
      plot: txt(d.querySelector('#plot')),
      serial: isSerial,
      seasons: seasons.map(function (s) { return { number: s.season, id: s.season_id, count: s.count, watched: !!s.allWatched }; }),
      currentSeason: curSeason == null ? (eps[0] ? eps[0].season : 0) : curSeason,
      episodes: eps,                       // episodes of currentSeason (or parts of a movie)
      startIndex: typeof startIndex === 'number' ? startIndex : -1, // episode the site would continue with
      subscribed: sub ? attr(sub, 'data-subscribed') === '1' : null,
      favorites: favs
    };
  }
  /* Table cell text; rating icons (IMDb / Кинопоиск) become labels. */
  function cellText(td) {
    var parts = [], label = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { var t = c.textContent.replace(/\s+/g, ' '); if (t.replace(/\s/g, '')) { parts.push(label + t); label = ''; } }
        else if (c.nodeType === 1) {
          var cls = (c.className || '').toString();
          if (/fa-imdb|imdb/.test(cls)) label = 'IMDb ';
          else if (/kinopoisk/.test(cls)) label = 'КП ';
          walk(c);
        }
      }
    })(td);
    return parts.join(' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').replace(/\s+,/g, ',');
  }
  function each(a, f) { for (var i = 0; i < (a ? a.length : 0); i++) f(a[i], i); }

  /* JSON from /item/playlist?id=&season= */
  function seasonJson(j) {
    var eps = [];
    each((j && j.episodes) || [], function (e) { eps.push(episode(e)); });
    return { ok: !!(j && j.success), season: j && j.season, episodes: eps, first: (j && j.firstUnwatchedIndex) || 0 };
  }

  /* /favorites -> folders */
  function folders(d) {
    var seen = {}, out = [];
    toArr(content(d).querySelectorAll('a[href*="/favorites/view"]')).forEach(function (a) {
      var m = /[?&]id=(\d+)/.exec(attr(a, 'href'));
      var t = txt(a);
      if (!m || seen[m[1]] || !t) return;
      seen[m[1]] = 1; out.push({ id: m[1], title: t });
    });
    return out;
  }

  /* Error text on the login page (wrong password etc.) */
  function loginError(d) {
    var e = d.querySelector('.help-block-error') || d.querySelector('.invalid-feedback') || d.querySelector('.alert-danger') || d.querySelector('.has-error .help-block');
    return txt(e);
  }

  root.KP_PARSE = {
    doc: doc, cards: cards, list: list, home: home, item: item, seasonJson: seasonJson,
    folders: folders, user: user, isLoginPage: isLoginPage, loginError: loginError,
    scriptVar: scriptVar, itemId: itemId
  };
})(typeof window !== 'undefined' ? window : this);
