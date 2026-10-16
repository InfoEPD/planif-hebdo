// api/_lib/dapdf.js
//
// Dessins d'atelier (DA) / fiches techniques (FT) : fiche d'identification, assemblage avec le PDF du fournisseur
// et tableau sommaire des approbations (pdf-lib, visuel Exacto).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Ctx, LOGO_B64, M, PAGE_W, PAGE_H, CW } = require('./pdf');

const ACCENT = rgb(0.184, 0.357, 0.918);
const NAVY = rgb(0.12, 0.2, 0.43);
const ACCENT_SOFT = rgb(0.91, 0.933, 1);
const INK = rgb(0.09, 0.133, 0.231);
const MUTED = rgb(0.416, 0.463, 0.569);
const ZEBRA = rgb(0.973, 0.98, 0.996);
const LINE = rgb(0.8, 0.83, 0.9);
const WHITE = rgb(1, 1, 1);

const STATUS_LABEL = {
  a_demander: 'À demander', demande: 'Demandé au fournisseur', recu: 'Reçu du fournisseur', chez_pro: 'Chez le professionnel',
  a_corriger: 'Corrections demandées', approuve: 'Approuvé'
};
const TYPE_LABEL = { DA: "Dessin d'atelier", FT: 'Fiche technique', ECH: 'Échantillon' };

function fmtDate(d, sep) {
  const mm = String(d instanceof Date ? d.toISOString() : d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return mm ? mm[3] + (sep || ' / ') + mm[2] + (sep || ' / ') + mm[1] : '';
}
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(p || '').trim();
}

async function newDoc(title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setProducer('Exacto-Finance'); doc.setCreator('Exacto-Finance');
  const f = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), ital: await doc.embedFont(StandardFonts.HelveticaOblique) };
  const logo = await doc.embedPng(Buffer.from(LOGO_B64, 'base64'));
  return { doc, f, logo };
}

class DaCtx extends Ctx {
  newPage() {
    const pg = super.newPage();
    if (this.hm) { this.drawHeader(pg); this.y = this.hm.bottom + 12; }
    return pg;
  }
  drawHeader(pg) {
    const h = this.hm;
    this.page = pg;
    pg.drawImage(h.logo, { x: M, y: PAGE_H - 30 - h.lh, width: h.lw, height: h.lh });
    const x = 318, w = PAGE_W - M - x;
    h.titleLines.forEach((ln, i) => this.text(ln, x, 44 + i * 16, 13.5, this.f.bold, INK));
    if (h.sub) this.text(h.sub, x, 44 + h.titleLines.length * 16 + 2, 9.5, this.f.reg, MUTED);
    this.line(M, h.bottom, PAGE_W - M, h.bottom, 1.5, ACCENT);
  }
}

// Barre de titre de section (bleu Exacto, texte blanc centré)
function bar(c, text, x, w, top, h, size) {
  c.rect(x, top, w, h || 20, { color: ACCENT });
  c.textCenter(text, x + w / 2, top + (h || 20) / 2 + 4, size || 10.5, c.f.bold, WHITE);
}
function box(c, x, top, w, h) { c.rect(x, top, w, h, { borderColor: LINE, borderWidth: 0.8 }); }
function kvRow(c, k, v, x, top, w, kw, size) {
  size = size || 9.5;
  c.textRight(k, x + kw - 6, top + 12, size, c.f.reg, MUTED);
  const lines = c.wrap(v || '', size, c.f.bold, w - kw - 8);
  lines.slice(0, 3).forEach((ln, i) => c.text(ln, x + kw + 2, top + 12 + i * 12.5, size, c.f.bold, INK));
  return Math.max(1, Math.min(3, lines.length)) * 12.5 + 8;
}

/**
 * Fiche d'identification (1 page) pour un DA / FT.
 * info : { project:{number,name,address,phone,ownerName,ownerEmail}, cp:{name,email}, da:{ref,type,description,specialty,spec_section,supplier_name,supplier_contact,date_sent,rev} }
 */
async function buildFiche(info) {
  const da = info.da, pj = info.project || {};
  const { doc, f, logo } = await newDoc('Fiche DA ' + (da.ref || '') + ' — ' + (pj.number || ''));
  const lw = 130, lh = lw * logo.height / logo.width;
  const c = new DaCtx(doc, f);
  c.hm = { logo, lw, lh, titleLines: ["Fiche d'identification pour dessin d'atelier,", "fiches techniques et échantillons"], sub: (da.ref || '') + (da.rev ? ' — Révision ' + da.rev : ''), bottom: Math.max(34 + lh, 92) + 6 };
  c.drawHeader(c.page); c.y = c.hm.bottom + 14;
  const W = CW, half = W / 2;

  // 1. Projet / donneur d'ouvrage
  let top = c.y;
  bar(c, "Identification du projet / donneur d'ouvrage", M, W, top, 20);
  const r1 = [['Projet :', (pj.name || ''), '# Projet :', pj.number || ''], ['Adresse :', pj.address || '', '# Téléphone :', fmtPhone(pj.phone)], ['Responsable :', pj.ownerName || '', 'Courriel :', pj.ownerEmail || '']];
  let yy = top + 20;
  const rowsH = r1.map(r => Math.max(kvH(c, r[1], half - 78), kvH(c, r[3], half - 78)));
  const totalH = rowsH.reduce((a, b) => a + b, 0) + 6;
  box(c, M, yy, W, totalH);
  let ry = yy + 3;
  r1.forEach((r, i) => { kvRow(c, r[0], r[1], M, ry, half, 72); kvRow(c, r[2], r[3], M + half, ry, half, 72); ry += rowsH[i]; });
  c.y = yy + totalH + 12;

  // 2. Entrepreneur général
  top = c.y;
  bar(c, "Identification de l'entrepreneur Général", M, W, top, 20);
  box(c, M, top + 20, W, 28);
  kvRow(c, 'Chargé de projet :', (info.cp && info.cp.name) || '', M, top + 22, half, 100);
  kvRow(c, 'Courriel :', (info.cp && info.cp.email) || '', M + half, top + 22, half, 60);
  c.y = top + 48 + 12;

  // 3. Fournisseur
  top = c.y;
  bar(c, "Identification de l'entrepreneur spécialisé / fournisseur", M, W, top, 20);
  box(c, M, top + 20, W, 52);
  c.line(M + 118, top + 20, M + 118, top + 72, 0.8, LINE); c.line(M, top + 46, M + W, top + 46, 0.8, LINE);
  c.textRight('Nom :', M + 108, top + 37, 9.5, f.reg, MUTED); c.text(da.supplier_name || '', M + 126, top + 37, 10, f.bold, INK);
  c.textRight('Nom du responsable :', M + 108, top + 63, 9.5, f.reg, MUTED); c.text(da.supplier_contact || '', M + 126, top + 63, 10, f.bold, INK);
  c.y = top + 72 + 18;

  // 4. Description + approbation
  top = c.y;
  bar(c, "Description du dessin d'atelier, fiche technique ou échantillon", M, W, top, 22, 10.5);
  const leftW = W * 0.46, rightX = M + leftW + 14, rightW = W - leftW - 14;
  let ly = top + 22 + 8;
  box(c, M, ly, leftW, 74);
  kvRow(c, 'Spécialité :', da.specialty || '', M, ly + 2, leftW, 92);
  kvRow(c, 'Section de devis :', da.spec_section || '', M, ly + 26, leftW, 92);
  kvRow(c, "Date d'envoi :", fmtDate(da.date_sent), M, ly + 50, leftW, 92);
  ly += 74 + 10;
  bar(c, (TYPE_LABEL[da.type] || 'Description') + ' — description', M, leftW, ly, 20, 10);
  const descH = 150;
  box(c, M, ly + 20, leftW, descH);
  c.wrap(da.description || '', 9.5, f.reg, leftW - 14).slice(0, 11).forEach((ln, i) => c.text(ln, M + 7, ly + 20 + 15 + i * 13, 9.5, f.reg, INK));
  // Approbation du professionnel (cadre vide : le professionnel y appose son timbre)
  bar(c, 'Approbation du professionnel', rightX, rightW, top + 22 + 8, 22, 10.5);
  box(c, rightX, top + 22 + 8 + 22, rightW, 74 + 10 + 20 + descH - 22 + 0);
  c.textCenter('Espace réservé au timbre du professionnel', rightX + rightW / 2, top + 22 + 8 + 22 + 16, 8, f.ital, MUTED);
  c.y = ly + 20 + descH + 14;
  c.text('Réf. interne : ' + (da.ref || '') + (da.rev ? ' — révision ' + da.rev : ''), M, c.y + 8, 8, f.reg, MUTED);
  return doc.save();
}
function kvH(c, v, w) { return Math.max(1, Math.min(3, c.wrap(v || '', 9.5, c.f.bold, w).length)) * 12.5 + 8; }

/** Fiche (page 1) + pages du PDF du fournisseur dans un seul PDF. */
async function assemble(ficheBytes, supplierPdfBytes, names) {
  const out = await PDFDocument.create();
  const a = await PDFDocument.load(ficheBytes);
  (await out.copyPages(a, a.getPageIndices())).forEach(p => out.addPage(p));
  const list = Array.isArray(supplierPdfBytes) ? supplierPdfBytes : [supplierPdfBytes];
  for (let i = 0; i < list.length; i++) {
    let b;
    try { b = await PDFDocument.load(list[i], { ignoreEncryption: true }); }
    catch (e) { throw { status: 400, message: 'Le PDF du fournisseur' + (names && names[i] ? ' (' + names[i] + ')' : '') + ' est illisible ou protégé : ' + ((e && e.message) || e) }; }
    (await out.copyPages(b, b.getPageIndices())).forEach(p => out.addPage(p));
  }
  out.setProducer('Exacto-Finance');
  return out.save();
}

/** Tableau sommaire des approbations, par professionnel (spécialité). */
async function buildSummary(info) {
  const pj = info.project || {}, items = info.items || [];
  const { doc, f, logo } = await newDoc('Sommaire DA et FT — ' + (pj.number || ''));
  const lw = 130, lh = lw * logo.height / logo.width;
  const c = new DaCtx(doc, f);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  c.hm = { logo, lw, lh, titleLines: ["Sommaire des dessins d'atelier", 'et fiches techniques'], sub: (pj.number ? pj.number + ' - ' : '') + (pj.name || '') + '  |  ' + fmtDate(today, '/'), bottom: Math.max(34 + lh, 92) + 6 };
  c.drawHeader(c.page); c.y = c.hm.bottom + 14;

  const total = items.length, appr = items.filter(i => i.status === 'approuve').length;
  c.text('Avancement global : ' + appr + ' approuvé' + (appr > 1 ? 's' : '') + ' sur ' + total + ' (' + (total ? Math.round(appr * 100 / total) : 0) + ' %)', M, c.y + 10, 11, f.bold, INK);
  const counts = {}; items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
  c.wrap(Object.keys(STATUS_LABEL).filter(k => counts[k]).map(k => STATUS_LABEL[k] + ' : ' + counts[k]).join('   |   '), 8.5, f.reg, CW).forEach((ln, i) => c.text(ln, M, c.y + 26 + i * 11, 8.5, f.reg, MUTED));
  c.y += 42;

  const cols = [{ k: 'ref', t: 'Réf.', w: 40 }, { k: 'description', t: 'Description', w: 160 }, { k: 'spec_section', t: 'Section', w: 50 }, { k: 'supplier_name', t: 'Fournisseur', w: 96 }, { k: 'date_sent', t: 'Envoyé', w: 54 }, { k: 'status', t: 'Statut', w: 76 }, { k: 'approved_at', t: 'Approuvé', w: 54 }];
  const sumW = cols.reduce((s, x) => s + x.w, 0); const k = CW / sumW; cols.forEach(x => { x.w *= k; });
  const groups = new Map();
  items.forEach(i => { const key = (i.specialty || 'Sans spécialité').trim() || 'Sans spécialité'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); });
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  const head = () => {
    c.need(24); c.rect(M, c.y, CW, 17, { color: ACCENT_SOFT });
    let x = M; cols.forEach(col => { c.text(col.t, x + 4, c.y + 12, 8, f.bold, INK); x += col.w; });
    c.y += 17;
  };
  for (const name of names) {
    const list = groups.get(name);
    const a = list.filter(i => i.status === 'approuve').length;
    c.need(70);
    c.rect(M, c.y, CW, 21, { color: NAVY });
    c.text(name + '  —  ' + a + ' / ' + list.length + ' approuvé' + (a > 1 ? 's' : ''), M + 8, c.y + 14.5, 10.5, f.bold, WHITE);
    c.y += 21; head();
    list.sort((x, y) => String(x.ref).localeCompare(String(y.ref), 'fr', { numeric: true }));
    list.forEach((it, idx) => {
      const cells = cols.map(col => {
        let v = it[col.k];
        if (col.k === 'date_sent' || col.k === 'approved_at') v = fmtDate(v, '/');
        if (col.k === 'status') v = STATUS_LABEL[v] || v;
        return c.wrap(String(v == null ? '' : v), 8, f.reg, col.w - 8).slice(0, 4);
      });
      const h = Math.max(...cells.map(l => l.length || 1)) * 10.5 + 8;
      if (c.y + h > PAGE_H - 52) { c.newPage(); head(); }
      if (idx % 2 === 0) c.rect(M, c.y, CW, h, { color: ZEBRA });
      let x = M;
      cells.forEach((lines, ci) => {
        const col = cols[ci];
        const color = col.k === 'status' ? (it.status === 'approuve' ? rgb(0.05, 0.5, 0.3) : it.status === 'a_corriger' ? rgb(0.75, 0.2, 0.2) : INK) : INK;
        lines.forEach((ln, li) => c.text(ln, x + 4, c.y + 11 + li * 10.5, 8, col.k === 'status' || col.k === 'ref' ? f.bold : f.reg, color));
        x += col.w;
      });
      c.line(M, c.y + h, M + CW, c.y + h, 0.4, LINE);
      c.y += h;
    });
    c.y += 12;
  }
  if (!items.length) c.text('Aucun dessin d\'atelier ni fiche technique inscrit pour ce projet.', M, c.y + 14, 10, f.reg, MUTED);
  // pied de page
  const n = c.pages.length;
  c.pages.forEach((pg, i) => { c.page = pg; c.textRight('Page ' + (i + 1) + ' / ' + n, PAGE_W - M, PAGE_H - 24, 8, f.reg, MUTED); });
  return doc.save();
}

module.exports = { buildFiche, assemble, buildSummary, STATUS_LABEL, TYPE_LABEL, newDoc, DaCtx, bar, box, kvRow, fmtDate, fmtPhone, COLORS: { ACCENT, NAVY, ACCENT_SOFT, INK, MUTED, ZEBRA, LINE, WHITE } };
