// api/_lib/sumpdf.js — Tableaux sommaires PDF génériques (QRT, demandes de changement), même visuel que le sommaire DA/FT.
const { rgb } = require('pdf-lib');
const { M, PAGE_W, PAGE_H, CW } = require('./pdf');
const { newDoc, DaCtx, fmtDate, COLORS } = require('./dapdf');
const { ACCENT_SOFT, NAVY, INK, MUTED, ZEBRA, LINE, WHITE } = COLORS;

/**
 * info = { docTitle, titleLines[], project{number,name}, headline, subline, groups:[{name, items:[row]}], cols:[{k,t,w,date?,bold?}], emptyText,
 *          statusKey, good:[statuts verts], bad:[statuts rouges] }
 * Chaque row est un objet { [col.k]: valeur }.
 */
async function buildGenericSummary(info) {
  const pj = info.project || {};
  const { doc, f, logo } = await newDoc(info.docTitle + ' — ' + (pj.number || ''));
  const lw = 130, lh = lw * logo.height / logo.width;
  const c = new DaCtx(doc, f);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  c.hm = { logo, lw, lh, titleLines: info.titleLines, sub: (pj.number ? pj.number + ' - ' : '') + (pj.name || '') + '  |  ' + fmtDate(today, '/'), bottom: Math.max(34 + lh, 92) + 6 };
  c.drawHeader(c.page); c.y = c.hm.bottom + 14;

  c.text(info.headline || '', M, c.y + 10, 11, f.bold, INK);
  if (info.subline) c.wrap(info.subline, 8.5, f.reg, CW).forEach((ln, i) => c.text(ln, M, c.y + 26 + i * 11, 8.5, f.reg, MUTED));
  c.y += 42;

  const cols = info.cols.map(x => Object.assign({}, x));
  const k = CW / cols.reduce((s, x) => s + x.w, 0); cols.forEach(x => { x.w *= k; });
  const head = () => {
    c.need(24); c.rect(M, c.y, CW, 17, { color: ACCENT_SOFT });
    let x = M; cols.forEach(col => { c.text(col.t, x + 4, c.y + 12, 8, f.bold, INK); x += col.w; });
    c.y += 17;
  };
  let any = false;
  for (const g of info.groups) {
    if (!g.items.length) continue; any = true;
    c.need(70);
    c.rect(M, c.y, CW, 21, { color: NAVY });
    c.text(g.name + '  —  ' + g.items.length, M + 8, c.y + 14.5, 10.5, f.bold, WHITE);
    c.y += 21; head();
    g.items.forEach((it, idx) => {
      const cells = cols.map(col => {
        let v = it[col.k]; if (col.date) v = fmtDate(v, '/');
        return c.wrap(String(v == null ? '' : v), 8, f.reg, col.w - 8).slice(0, 4);
      });
      const h = Math.max(...cells.map(l => l.length || 1)) * 10.5 + 8;
      if (c.y + h > PAGE_H - 52) { c.newPage(); head(); }
      if (idx % 2 === 0) c.rect(M, c.y, CW, h, { color: ZEBRA });
      let x = M;
      cells.forEach((lines, ci) => {
        const col = cols[ci];
        const st = it[info.statusKey];
        const color = col.status ? ((info.good || []).includes(st) ? rgb(0.05, 0.5, 0.3) : (info.bad || []).includes(st) ? rgb(0.75, 0.2, 0.2) : INK) : INK;
        lines.forEach((ln, li) => c.text(ln, x + 4, c.y + 11 + li * 10.5, 8, (col.status || col.bold) ? f.bold : f.reg, color));
        x += col.w;
      });
      c.line(M, c.y + h, M + CW, c.y + h, 0.4, LINE);
      c.y += h;
    });
    c.y += 12;
  }
  if (!any) c.text(info.emptyText || 'Aucun élément.', M, c.y + 14, 10, f.reg, MUTED);
  const n = c.pages.length;
  c.pages.forEach((pg, i) => { c.page = pg; c.textRight('Page ' + (i + 1) + ' / ' + n, PAGE_W - M, PAGE_H - 24, 8, f.reg, MUTED); });
  return doc.save();
}
module.exports = { buildGenericSummary };
