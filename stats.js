/* Exacto Heures — onglet « Statistiques » (heures poinçonnées des employés de chantier, Exacto Punch).
   Données : action serveur punchStats (Neon). Graphiques SVG sans dépendance, thème via variables CSS de l'app.
   Chaque graphique a ses propres dates début/fin ; un clic sur une barre/un point ouvre le détail des poinçons. */
(function () {
  var D = { punches: [], employees: [], projects: [], tasks: [] };
  var EMP = {}, PRJ = {}, CCQ = {};
  var cfg = { taux: 0.55, franchise: 0 };
  try { var sv = JSON.parse(localStorage.getItem('statsCfg') || 'null'); if (sv) cfg = Object.assign(cfg, sv); } catch (e) {}
  var mounted = false, loading = false, loadedFrom = '', loadedTo = '';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var iso = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var addDays = function (s, n) { var d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  var sunday = function (s) { var d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() - d.getDay()); return iso(d); };
  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var f1 = function (n) { return (Math.round(n * 10) / 10).toLocaleString('fr-CA'); };
  var money = function (n) { return Math.round(n).toLocaleString('fr-CA') + ' $'; };
  var today = iso(new Date());

  function nm(id) { return (EMP[id] && EMP[id].name) || (id ? 'Employé ' + id : '?'); }
  function wl(w) { return w.slice(8) + ' ' + MOIS[+w.slice(5, 7) - 1]; }
  function pn(id) { var p = PRJ[id]; return p ? ((p.number ? p.number + ' ' : '') + p.name) : (id || '?'); }
  function weekG(p) { var w = sunday(p.d); return [{ k: w, l: wl(w), w: 1 }]; }
  function ot(p) { return p.o15 + p.o2; }

  var CHARTS = [
    { id: 'ot-emp', title: 'Overtime par employé (Top 10)', sub: 'Heures supplémentaires (1,5x + 2x)', type: 'barH', start: addDays(today, -90), end: today, fmt: f1, unit: 'h',
      group: function (p) { return [{ k: p.e, l: nm(p.e), w: 1 }]; }, val: ot, top: 10 },
    { id: 'ot-cp', title: 'Overtime par CP', sub: 'Selon le chargé de projet du projet (réparti si plusieurs)', type: 'barH', start: addDays(today, -90), end: today, fmt: f1, unit: 'h',
      group: function (p) { var c = (PRJ[p.p] && PRJ[p.p].cp) || []; if (!c.length) return [{ k: '_', l: 'Sans CP', w: 1 }]; return c.map(function (n) { return { k: n, l: n, w: 1 / c.length }; }); },
      val: ot, top: 15 },
    { id: 'ot-wk', title: 'Évolution overtime', sub: 'Heures supplémentaires par semaine', type: 'line', start: addDays(today, -84), end: today, fmt: f1, unit: 'h',
      group: weekG, val: ot, time: 'week' },
    { id: 'head', title: 'Headcount employés chantier', sub: 'Employés distincts ayant poinçonné, par semaine', type: 'line', start: addDays(today, -84), end: today, fmt: function (n) { return String(Math.round(n)); }, unit: '',
      group: weekG, val: function () { return 0; }, time: 'week', distinct: true },
    { id: 'ccq', title: 'Heures travaillées CCQ', sub: 'Heures sur tâches CCQ, par semaine', type: 'line', start: addDays(today, -84), end: today, fmt: f1, unit: 'h',
      group: weekG, val: function (p) { return CCQ[(p.t || '').toLowerCase()] ? p.h : 0; }, time: 'week' },
    { id: 'indem', title: 'Indemnité de déplacement par mois', sub: 'Km au-delà de la franchise × taux (réglable ci-dessus)', type: 'barV', start: addDays(today, -180), end: today, fmt: money, unit: '$',
      group: function (p) { var m = p.d.slice(0, 7); return [{ k: m, l: MOIS[+m.slice(5) - 1] + ' ' + m.slice(2, 4), w: 1 }]; },
      val: function (p) { return Math.max(0, p.km - cfg.franchise) * cfg.taux; }, time: 'month' }
  ];
  function chartById(id) { return CHARTS.filter(function (x) { return x.id === id; })[0]; }

  function css() {
    if ($('stats-css')) return;
    var s = document.createElement('style'); s.id = 'stats-css';
    s.textContent = '.st-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:16px}' +
      '.st-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}' +
      '.st-card h3{margin:0;font-size:15px;font-weight:700}.st-sub{font-size:12px;color:var(--text-secondary);margin:2px 0 8px}' +
      '.st-ctl{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-bottom:6px}' +
      '.st-ctl input[type=date]{padding:4px 6px;font-size:12px}.st-ctl .q{padding:3px 8px;font-size:11px}' +
      '.st-tot{margin-left:auto;font-weight:700;color:var(--text);font-size:13px}' +
      '.st-svg{width:100%;height:auto;display:block}.st-svg text{fill:var(--text-secondary);font-size:11px;font-family:inherit}' +
      '.st-hit{cursor:pointer}.st-hit:hover{opacity:.8}.st-bar{fill:var(--accent)}.st-line{fill:none;stroke:var(--accent);stroke-width:2.2}' +
      '.st-dot{fill:var(--panel);stroke:var(--accent);stroke-width:2.2}.st-area{fill:var(--accent-bg)}.st-grid-l{stroke:var(--border);stroke-width:1}' +
      '.st-svg .st-val{fill:var(--text);font-weight:600}.st-svg .st-lab{fill:var(--text)}' +
      '.st-empty{padding:30px 0;text-align:center;color:var(--text-secondary);font-size:13px}' +
      '#st-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;display:none;align-items:center;justify-content:center;padding:20px}' +
      '#st-modal.open{display:flex}#st-modal .box{background:var(--panel);border:1px solid var(--border);border-radius:12px;max-width:1100px;width:100%;max-height:88vh;display:flex;flex-direction:column}' +
      '#st-modal .hd{display:flex;gap:10px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border)}#st-modal .hd h3{margin:0;font-size:15px;flex:1}' +
      '#st-modal .bd{overflow:auto;padding:0 16px 14px}#st-modal table{width:100%;border-collapse:collapse;font-size:13px}' +
      '#st-modal th{position:sticky;top:0;background:var(--panel-alt);text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap}' +
      '#st-modal td{padding:6px 8px;border-bottom:1px solid var(--border)}#st-modal td.n,#st-modal th.n{text-align:right}';
    document.head.appendChild(s);
  }

  function mount() {
    if (mounted) return; mounted = true; css();
    var pnl = $('tab-stats');
    pnl.innerHTML = '<div class="weeknav" style="margin-bottom:10px;"><span style="font-weight:700;">Statistiques — heures poinçonnées (chantier)</span>' +
      '<span style="margin-left:auto;font-size:12px;color:var(--text-secondary);">Indemnité : taux $/km <input type="number" step="0.01" id="st-taux" style="width:70px"> franchise km <input type="number" step="1" id="st-fr" style="width:60px"></span>' +
      '<button class="btn btn-outline" id="st-refresh">↻ Rafraîchir</button></div>' +
      '<div class="st-grid" id="st-grid"></div>' +
      '<div id="st-modal"><div class="box"><div class="hd"><h3 id="st-mt"></h3><button class="btn btn-outline" id="st-csv">Exporter CSV</button><button class="btn btn-outline" id="st-x">✕</button></div><div class="bd" id="st-mb"></div></div></div>';
    $('st-taux').value = cfg.taux; $('st-fr').value = cfg.franchise;
    var sc = function () { cfg.taux = parseFloat($('st-taux').value) || 0; cfg.franchise = parseFloat($('st-fr').value) || 0; try { localStorage.setItem('statsCfg', JSON.stringify(cfg)); } catch (e) {} renderAll(); };
    $('st-taux').addEventListener('change', sc); $('st-fr').addEventListener('change', sc);
    $('st-refresh').addEventListener('click', function () { load(true); });
    $('st-x').addEventListener('click', function () { $('st-modal').classList.remove('open'); });
    $('st-modal').addEventListener('click', function (e) { if (e.target.id === 'st-modal') $('st-modal').classList.remove('open'); });
    var g = $('st-grid');
    g.innerHTML = CHARTS.map(function (c) {
      return '<div class="st-card"><h3>' + esc(c.title) + '</h3><div class="st-sub">' + esc(c.sub) + '</div>' +
        '<div class="st-ctl">Du <input type="date" data-c="' + c.id + '" data-k="start" value="' + c.start + '"> au <input type="date" data-c="' + c.id + '" data-k="end" value="' + c.end + '">' +
        '<button class="btn btn-outline q" data-c="' + c.id + '" data-q="30">30 j</button><button class="btn btn-outline q" data-c="' + c.id + '" data-q="90">3 mois</button><button class="btn btn-outline q" data-c="' + c.id + '" data-q="365">1 an</button>' +
        '<span class="st-tot" id="t-' + c.id + '"></span></div><div id="b-' + c.id + '"></div></div>';
    }).join('');
    g.addEventListener('change', function (e) {
      var t = e.target; if (!t.dataset.c || !t.value) return;
      chartById(t.dataset.c)[t.dataset.k] = t.value; load(false);
    });
    g.addEventListener('click', function (e) {
      var t = e.target.closest('[data-q]');
      if (t) { var c = chartById(t.dataset.c); c.end = today; c.start = addDays(today, -(+t.dataset.q)); syncInputs(c); load(false); return; }
      var h = e.target.closest('[data-h]'); if (!h) return;
      var i = h.dataset.h.indexOf('|'); drill(h.dataset.h.slice(0, i), h.dataset.h.slice(i + 1));
    });
  }
  function syncInputs(c) {
    var a = document.querySelector('[data-c="' + c.id + '"][data-k="start"]'), b = document.querySelector('[data-c="' + c.id + '"][data-k="end"]');
    if (a) a.value = c.start; if (b) b.value = c.end;
  }

  async function load(force) {
    var from = CHARTS.reduce(function (m, c) { return c.start < m ? c.start : m; }, '9999');
    var to = CHARTS.reduce(function (m, c) { return c.end > m ? c.end : m; }, '0000');
    if (!force && loadedFrom && from >= loadedFrom && to <= loadedTo) { renderAll(); return; }
    if (loading) return; loading = true;
    CHARTS.forEach(function (c) { $('b-' + c.id).innerHTML = '<div class="st-empty">Chargement…</div>'; });
    try {
      var r = await planifApi('punchStats', { from: from, to: to });
      D = r; loadedFrom = from; loadedTo = to;
      EMP = {}; r.employees.forEach(function (e) { EMP[e.id] = e; });
      PRJ = {}; r.projects.forEach(function (p) { PRJ[p.id] = p; });
      CCQ = {}; r.tasks.forEach(function (t) { CCQ[(t.name || '').toLowerCase()] = t.ccq; });
      renderAll();
    } catch (e) {
      CHARTS.forEach(function (c) { $('b-' + c.id).innerHTML = '<div class="st-empty" style="color:var(--danger)">' + esc(e.message) + '</div>'; });
    } finally { loading = false; }
  }

  function rowsFor(c) {
    return D.punches.filter(function (p) { return p.d >= c.start && p.d <= c.end && EMP[p.e] && EMP[p.e].chantier && !/rej/i.test(p.s); });
  }
  function series(c) {
    var rows = rowsFor(c), m = {}, order = [];
    rows.forEach(function (p) {
      c.group(p).forEach(function (g) {
        var o = m[g.k]; if (!o) { o = m[g.k] = { k: g.k, l: g.l, v: 0, set: {}, rows: [] }; order.push(o); }
        o.rows.push(p);
        if (c.distinct) o.set[p.e] = 1; else o.v += c.val(p) * g.w;
      });
    });
    if (c.distinct) order.forEach(function (o) { o.v = Object.keys(o.set).length; });
    var out = [];
    if (c.time === 'week') {
      var w = sunday(c.start), e = sunday(c.end);
      for (; w <= e; w = addDays(w, 7)) out.push(m[w] || { k: w, l: wl(w), v: 0, rows: [] });
      return out;
    }
    if (c.time === 'month') {
      var y = +c.start.slice(0, 4), mo = +c.start.slice(5, 7), ey = +c.end.slice(0, 4), em = +c.end.slice(5, 7);
      while (y < ey || (y === ey && mo <= em)) {
        var k = y + '-' + String(mo).padStart(2, '0');
        out.push(m[k] || { k: k, l: MOIS[mo - 1] + ' ' + String(y).slice(2), v: 0, rows: [] });
        if (++mo > 12) { mo = 1; y++; }
      }
      return out;
    }
    order.sort(function (x, y2) { return y2.v - x.v; });
    return c.top ? order.slice(0, c.top) : order;
  }

  function renderAll() { CHARTS.forEach(render); }
  function render(c) {
    var s = series(c), el = $('b-' + c.id);
    var tot = s.reduce(function (a, o) { return a + o.v; }, 0);
    $('t-' + c.id).textContent = c.distinct ? '' : 'Total : ' + c.fmt(tot) + (c.unit === 'h' ? ' h' : '');
    if (!s.length || !tot) { el.innerHTML = '<div class="st-empty">Aucune donnée sur cette période.</div>'; return; }
    el.innerHTML = c.type === 'barH' ? barH(c, s) : c.type === 'barV' ? barV(c, s) : line(c, s);
  }
  function hit(c, o) { return ' class="st-hit" data-h="' + c.id + '|' + esc(o.k) + '"'; }
  function barH(c, s) {
    var W = 560, rh = 26, L = 170, R = 60, H = s.length * rh + 8, mx = Math.max.apply(null, s.map(function (o) { return o.v; })) || 1;
    var out = '<svg class="st-svg" viewBox="0 0 ' + W + ' ' + H + '">';
    s.forEach(function (o, i) {
      var y = 4 + i * rh, w = Math.max(2, (W - L - R) * o.v / mx), lab = o.l.length > 24 ? o.l.slice(0, 23) + '…' : o.l;
      out += '<g' + hit(c, o) + '><title>' + esc(o.l) + ' : ' + c.fmt(o.v) + ' ' + c.unit + '</title><rect x="0" y="' + y + '" width="' + W + '" height="' + (rh - 2) + '" fill="transparent"/>' +
        '<text class="st-lab" x="' + (L - 8) + '" y="' + (y + 15) + '" text-anchor="end">' + esc(lab) + '</text><rect class="st-bar" x="' + L + '" y="' + (y + 3) + '" width="' + w + '" height="' + (rh - 8) + '" rx="3"/>' +
        '<text class="st-val" x="' + (L + w + 6) + '" y="' + (y + 15) + '">' + c.fmt(o.v) + '</text></g>';
    });
    return out + '</svg>';
  }
  function niceStep(x) { if (x <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(x))), n = x / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  function axis(mx, st, H, T, L, W, R, fmt) {
    var o = '';
    for (var v = 0; v <= mx + 1e-9; v += st) {
      var y = T + (H - T - 22) * (1 - v / mx);
      o += '<line class="st-grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + fmt(v) + '</text>';
    }
    return o;
  }
  function line(c, s) {
    var W = 560, H = 240, L = 46, R = 14, T = 16, raw = Math.max.apply(null, s.map(function (o) { return o.v; })) || 1;
    var st = niceStep(raw / 4), mx = Math.ceil(raw / st) * st, n = s.length;
    var xs = function (i) { return L + (n === 1 ? (W - L - R) / 2 : (W - L - R) * i / (n - 1)); };
    var ys = function (v) { return T + (H - T - 22) * (1 - v / mx); };
    var pts = s.map(function (o, i) { return xs(i) + ',' + ys(o.v); });
    var o = '<svg class="st-svg" viewBox="0 0 ' + W + ' ' + H + '">' + axis(mx, st, H, T, L, W, R, c.fmt);
    o += '<polygon class="st-area" points="' + xs(0) + ',' + ys(0) + ' ' + pts.join(' ') + ' ' + xs(n - 1) + ',' + ys(0) + '"/><polyline class="st-line" points="' + pts.join(' ') + '"/>';
    var every = Math.ceil(n / 8);
    s.forEach(function (p, i) {
      o += '<g' + hit(c, p) + '><title>' + esc(p.l) + ' : ' + c.fmt(p.v) + ' ' + c.unit + '</title><circle cx="' + xs(i) + '" cy="' + ys(p.v) + '" r="10" fill="transparent"/><circle class="st-dot" cx="' + xs(i) + '" cy="' + ys(p.v) + '" r="4"/></g>';
      if (n <= 14) o += '<text class="st-val" x="' + xs(i) + '" y="' + (ys(p.v) - 9) + '" text-anchor="middle">' + c.fmt(p.v) + '</text>';
      if (i % every === 0) o += '<text x="' + xs(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.l) + '</text>';
    });
    return o + '</svg>';
  }
  function barV(c, s) {
    var W = 560, H = 240, L = 56, R = 10, T = 18, raw = Math.max.apply(null, s.map(function (o) { return o.v; })) || 1;
    var st = niceStep(raw / 4), mx = Math.ceil(raw / st) * st, n = s.length, bw = (W - L - R) / n;
    var o = '<svg class="st-svg" viewBox="0 0 ' + W + ' ' + H + '">' + axis(mx, st, H, T, L, W, R, money);
    s.forEach(function (p, i) {
      var h = (H - T - 22) * p.v / mx, x = L + i * bw + bw * 0.15, y = H - 22 - h;
      o += '<g' + hit(c, p) + '><title>' + esc(p.l) + ' : ' + c.fmt(p.v) + '</title><rect x="' + (L + i * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - 22) + '" fill="transparent"/>' +
        '<rect class="st-bar" x="' + x + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + Math.max(h, 1) + '" rx="3"/>' +
        '<text class="st-val" x="' + (x + bw * 0.35) + '" y="' + (y - 5) + '" text-anchor="middle">' + (n <= 12 ? c.fmt(p.v) : '') + '</text>' +
        '<text x="' + (x + bw * 0.35) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(p.l) + '</text></g>';
    });
    return o + '</svg>';
  }

  var cur = { rows: [], sort: 'd', dir: 1, title: '' };
  var COLS = [['d', 'Date'], ['emp', 'Employé'], ['prj', 'Projet'], ['t', 'Tâche'], ['h', 'Heures', 1], ['o15', 'HS 1,5x', 1], ['o2', 'HS 2x', 1], ['km', 'Km', 1], ['s', 'Statut']];
  function cell(p, k) { return k === 'emp' ? nm(p.e) : k === 'prj' ? pn(p.p) : p[k]; }
  function drill(cid, key) {
    var c = chartById(cid), o = series(c).filter(function (x) { return String(x.k) === key; })[0];
    if (!o) return;
    cur = { rows: o.rows.slice(), sort: 'd', dir: 1, title: c.title + ' — ' + o.l + ' (' + c.start + ' au ' + c.end + ')' };
    drawModal();
    $('st-modal').classList.add('open');
  }
  function drawModal() {
    var r = cur.rows.slice().sort(function (a, b) { var x = cell(a, cur.sort), y = cell(b, cur.sort); return (x < y ? -1 : x > y ? 1 : 0) * cur.dir; });
    var tot = { h: 0, o15: 0, o2: 0, km: 0 }; r.forEach(function (p) { tot.h += p.h; tot.o15 += p.o15; tot.o2 += p.o2; tot.km += p.km; });
    $('st-mt').textContent = cur.title + ' · ' + r.length + ' poinçon(s)';
    $('st-mb').innerHTML = '<table><thead><tr>' + COLS.map(function (c) { return '<th class="' + (c[2] ? 'n' : '') + '" data-s="' + c[0] + '">' + c[1] + (cur.sort === c[0] ? (cur.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>'; }).join('') + '</tr></thead><tbody>' +
      r.map(function (p) { return '<tr>' + COLS.map(function (c) { var v = cell(p, c[0]); return '<td class="' + (c[2] ? 'n' : '') + '">' + esc(c[2] ? f1(v) : v) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '<tr style="font-weight:700"><td colspan="4">Total</td><td class="n">' + f1(tot.h) + '</td><td class="n">' + f1(tot.o15) + '</td><td class="n">' + f1(tot.o2) + '</td><td class="n">' + f1(tot.km) + '</td><td></td></tr></tbody></table>';
    $('st-mb').querySelectorAll('th').forEach(function (th) { th.onclick = function () { if (cur.sort === th.dataset.s) cur.dir = -cur.dir; else { cur.sort = th.dataset.s; cur.dir = 1; } drawModal(); }; });
    $('st-csv').onclick = function () {
      var csv = [COLS.map(function (c) { return c[1]; }).join(';')].concat(r.map(function (p) { return COLS.map(function (c) { return '"' + String(cell(p, c[0])).replace(/"/g, '""') + '"'; }).join(';'); })).join('\n');
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = 'statistiques-poincons.csv'; a.click();
    };
  }

  window.loadStats = function () { mount(); load(false); };
})();
