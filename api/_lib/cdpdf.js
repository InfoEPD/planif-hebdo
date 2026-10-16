// api/_lib/cdpdf.js
//
// Avis de changement (DDC) : calcul des montants + PDF (gabarit EPD / Exacto, pdf-lib).
//   en-tête répété (logo, n° d'avis, date, projet) · émetteur / destinataire · tableau d'information · description
//   · ventilation (nom, qté, prix, sous-total, frais administratif, sous-total) · assurance / cautionnement · totaux
//   · note importante · signature.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Ctx, clean, LOGO_B64, M, PAGE_W, PAGE_H, CW, COMPANY } = require('./pdf');

const ACCENT = rgb(0.184, 0.357, 0.918);
const ACCENT_SOFT = rgb(0.91, 0.933, 1);
const INK = rgb(0.09, 0.133, 0.231);
const MUTED = rgb(0.416, 0.463, 0.569);
const ZEBRA = rgb(0.973, 0.98, 0.996);
const LINE = rgb(0.8, 0.83, 0.9);

const TPS_RATE = 0.05, TVQ_RATE = 0.09975;
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = v => { const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

const DEFAULT_NOTES = [
  "Les prix indiqués ci-dessus sont établis selon les informations, les documents disponibles et les conditions de chantier connues au moment de la présente soumission.\nLes Entreprises Philippe Denis inc. se réserve le droit d'ajuster le coût total des travaux, les quantités, les méthodes d'exécution et les délais si des modifications, omissions, contraintes de chantier, conditions imprévues ou directives additionnelles surviennent, ou si ces éléments entraînent une perte d'efficacité, une désorganisation ou tout autre impact affectant la réalisation des travaux.",
  "Bien que les travaux décrits dans la présente demande de changement puissent ne pas se situer sur le chemin critique au moment de l'analyse et de l'estimation, Les Entreprises Philippe Denis inc. se réserve expressément le droit de réclamer tous frais additionnels, prolongations de délais, coûts de mobilisation ou pertes d'efficacité s'ils deviennent par la suite un élément influençant le chemin critique ou s'ils occasionnent un prolongement du chantier.",
  "Toute attente, mobilisation supplémentaire, modification de séquence, interruption, impact direct ou indirect sur le rendement ou prolongation de la durée du chantier pourra faire l'objet d'une réclamation ou d'un ajustement de prix, conformément aux dispositions du contrat et aux conditions applicables.",
  "Cette soumission demeure valide pour une période maximale de 30 jours à compter de sa date d'émission et est également conditionnelle à la confirmation des conditions réelles sur le site ainsi qu'aux directives officielles du professionnel."
].join('\n\n');

/** Montants de l'avis : lignes -> sous-totaux, frais, assurance / cautionnement (sur le total avec frais), taxes. */
function computeChange(lines, insurancePct, bondPct) {
  const out = (lines || []).map(l => {
    const qty = num(l.qty), price = num(l.price), fee = num(l.feePct);
    const base = r2(qty * price), feeAmt = r2(base * fee / 100);
    return { base, feeAmt, total: r2(base + feeAmt) };
  });
  const sumBase = r2(out.reduce((s, x) => s + x.base, 0));
  const sumFee = r2(out.reduce((s, x) => s + x.feeAmt, 0));
  const sumTotal = r2(out.reduce((s, x) => s + x.total, 0));
  const ins = r2(sumTotal * num(insurancePct) / 100);
  const bond = r2(sumTotal * num(bondPct) / 100);
  const subtotal = r2(sumTotal + ins + bond);
  const tps = r2(subtotal * TPS_RATE), tvq = r2(subtotal * TVQ_RATE);
  return { lines: out, sumBase, sumFee, sumTotal, ins, bond, subtotal, tps, tvq, total: r2(subtotal + tps + tvq) };
}

function money(n) { return (n < 0 ? '-' : '') + '$' + Math.abs(Number(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) {
  const mm = String(d instanceof Date ? d.toISOString() : d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return mm ? mm[3] + ' / ' + mm[2] + ' / ' + mm[1] : String(d || '');
}
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function frLong(d) {
  const mm = String(d instanceof Date ? d.toISOString() : d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return mm ? (Number(mm[3]) === 1 ? '1er' : String(Number(mm[3]))) + ' ' + MOIS[Number(mm[2]) - 1] + ' ' + mm[1] : '';
}
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(p || '').trim();
}
const PRICE_LABEL = { augmentation: 'Oui, augmentation', reduction: 'Oui, réduction', inchange: 'Non, inchangé', inconnu: '?' };
const label = v => PRICE_LABEL[v] || (v ? String(v) : '');

class CdCtx extends Ctx {
  newPage() {
    const pg = super.newPage();
    if (this.hm) { this.drawHeader(pg); this.y = this.hm.bottom + 14; }
    return pg;
  }
  drawHeader(pg) {
    const h = this.hm;
    pg.drawImage(h.logo, { x: M, y: PAGE_H - 30 - h.lh, width: h.lw, height: h.lh });
    this.page = pg;
    const x = 318;
    this.text(h.title, x, 46, 15, this.f.bold, INK);
    this.text('Date :', x, 66, 9.5, this.f.bold, INK); this.text(h.date, x + 32, 66, 9.5, this.f.reg, INK);
    this.text('Projet :', x, 80, 9.5, this.f.bold, INK);
    this.wrap(h.project, 9.5, this.f.reg, PAGE_W - M - x - 40).slice(0, 2).forEach((ln, i) => this.text(ln, x + 40, 80 + i * 12, 9.5, this.f.reg, INK));
    this.line(M, h.bottom, PAGE_W - M, h.bottom, 1.5, ACCENT);
  }
}

/**
 * ch : ligne fin_change (champs snake_case, lines parsé) ; opts.owner non utilisé (dest_* sont dans ch).
 * Retourne Uint8Array.
 */
async function buildChangePdf(ch) {
  const doc = await PDFDocument.create();
  const avc = 'Avis de changement # ' + (String(ch.ddc_number || '').trim() || (ch.legacy ? ch.avc_number : '') || '(à saisir)') + (ch.rev > 0 ? ' Rév.' + ch.rev : '');
  doc.setTitle(avc + ' — ' + (ch.project_number || '')); doc.setProducer('Exacto-Finance'); doc.setCreator('Exacto-Finance');
  const f = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), ital: await doc.embedFont(StandardFonts.HelveticaOblique) };
  const logo = await doc.embedPng(Buffer.from(LOGO_B64, 'base64'));
  const lw = 130, lh = lw * logo.height / logo.width;
  const c = new CdCtx(doc, f);
  const projectLine = (ch.project_number ? ch.project_number + ' - ' : '') + (ch.project_name || '');
  const issued = ch.sent_at ? new Date(ch.sent_at) : new Date();
  const dateStr = fmtDate(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(issued));
  c.hm = { logo, lw, lh, title: avc, date: dateStr, project: projectLine, bottom: Math.max(34 + lh, 98) + 6 };
  c.drawHeader(c.page); c.y = c.hm.bottom + 14;

  const calc = computeChange(ch.lines, ch.insurance_pct, ch.bond_pct);

  // --- Émetteur / Destinataire ---
  const colW = (CW - 20) / 2, x2 = M + colW + 20;
  const top0 = c.y;
  c.text('Émetteur', M, top0 + 10, 10.5, f.bold, INK); c.line(M, top0 + 13, M + c.width('Émetteur', 10.5, f.bold), top0 + 13, 0.8, INK);
  c.text('Destinataire', x2, top0 + 10, 10.5, f.bold, INK); c.line(x2, top0 + 13, x2 + c.width('Destinataire', 10.5, f.bold), top0 + 13, 0.8, INK);
  let ly = top0 + 32;
  c.text(COMPANY.name, M, ly, 10, f.bold, INK); ly += 14;
  COMPANY.lines.concat(['Tél : ' + COMPANY.tel]).forEach(t => { c.text(t, M, ly, 9.5, f.reg, INK); ly += 13; });
  let ry = top0 + 32;
  const kv = (k, v) => {
    const kw = c.width(k + ' ', 9.5, f.bold);
    const lines = c.wrap(v || '—', 9.5, f.reg, colW - kw);
    c.text(k, x2, ry, 9.5, f.bold, INK);
    lines.forEach((ln, i) => c.text(ln, x2 + kw, ry + i * 12.5, 9.5, f.reg, INK));
    ry += 13 * lines.length;
  };
  kv('Nom :', ch.dest_name); kv('Courriel :', ch.dest_email); kv('Téléphone :', fmtPhone(ch.dest_phone));
  c.y = Math.max(ly, ry) + 10;

  // --- Tableau d'information ---
  const rows = [
    ['Type de modification', ch.change_type || ''],
    ['Émetteur', ch.issuer || ''],
    ['Date de réception de l\'avis', frLong(ch.received_date)],
    ['La modification affecte le prix?', label(ch.affects_price)],
    ['La modification affecte le délais?', label(ch.affects_delay)],
    ['Nombre de jours additionnels?', ch.extra_days != null && ch.extra_days !== '' ? String(ch.extra_days) : '']
  ];
  if (ch.ddc_number) rows.unshift(['N° de la demande du professionnel', ch.ddc_number]);
  const lw1 = 250;
  rows.forEach((r, i) => {
    c.need(20);
    if (i % 2 === 0) c.rect(M, c.y, CW, 19, { color: ZEBRA });
    c.text(r[0], M + 6, c.y + 13, 9, f.reg, MUTED); c.text(r[1], M + lw1, c.y + 13, 9.5, f.bold, INK);
    c.line(M, c.y + 19, M + CW, c.y + 19, 0.5, LINE);
    c.y += 19;
  });
  c.line(M, c.y - 19 * rows.length, M, c.y, 0.5, LINE); c.line(M + CW, c.y - 19 * rows.length, M + CW, c.y, 0.5, LINE);
  c.y += 16;

  // --- Description globale ---
  c.need(60);
  c.rect(M, c.y, CW, 20, { color: ACCENT_SOFT }); c.rect(M, c.y, 3.5, 20, { color: ACCENT });
  c.text('Description globale de la demande de changement :', M + 10, c.y + 14, 10, f.bold, ACCENT);
  c.y += 28;
  c.para(ch.description || '—', { size: 9.5, lh: 13, x: M + 4, w: CW - 8, color: INK });
  c.y += 14;

  // --- Ventilation ---
  const cols = [
    { l: 'Nom', w: 168, a: 'l' }, { l: 'QTÉ', w: 34, a: 'r' }, { l: 'Prix', w: 62, a: 'r' }, { l: 'Sous-total\navant frais', w: 70, a: 'r' },
    { l: 'Frais\nadministratif', w: 56, a: 'r' }, { l: 'Montant des\nfrais admin.', w: 66, a: 'r' }, { l: 'Sous-total', w: CW - 456, a: 'r' }
  ];
  const head = () => {
    c.need(60);
    c.rect(M, c.y, CW, 28, { color: ACCENT });
    let x = M;
    cols.forEach(col => {
      col.l.split('\n').forEach((ln, i) => { col.a === 'r' ? c.textRight(ln, x + col.w - 6, c.y + 11 + i * 10, 8, f.bold, rgb(1, 1, 1)) : c.text(ln, x + 6, c.y + 11 + i * 10, 8, f.bold, rgb(1, 1, 1)); });
      x += col.w;
    });
    c.y += 28;
  };
  if (c.y + 120 > PAGE_H - 52) c.newPage();
  head();
  const cell = (txt, i, y, bold) => {
    const col = cols[i]; let x = M; for (let k = 0; k < i; k++) x += cols[k].w;
    col.a === 'r' ? c.textRight(txt, x + col.w - 6, y, 9, bold ? f.bold : f.reg, INK) : c.text(txt, x + 6, y, 9, bold ? f.bold : f.reg, INK);
  };
  (ch.lines || []).forEach((l, i) => {
    const nameLines = c.wrap(l.name || '', 9, f.reg, cols[0].w - 12);
    const rh = Math.max(1, nameLines.length) * 11.5 + 9;
    if (c.y + rh > PAGE_H - 60) { c.newPage(); head(); }
    if (i % 2 === 1) c.rect(M, c.y, CW, rh, { color: ZEBRA });
    nameLines.forEach((ln, k) => c.text(ln, M + 6, c.y + 14 + k * 11.5, 9, f.reg, INK));
    const x = calc.lines[i], y = c.y + 14;
    const q = num(l.qty);
    cell(String(Math.round(q * 1000) / 1000).replace('.', ','), 1, y);
    cell(money(num(l.price)), 2, y); cell(money(x.base), 3, y);
    cell(String(num(l.feePct)).replace('.', ',') + ' %', 4, y); cell(money(x.feeAmt), 5, y); cell(money(x.total), 6, y, true);
    c.line(M, c.y + rh, M + CW, c.y + rh, 0.5, LINE);
    c.y += rh;
  });
  [['Assurance supplémentaire', ch.insurance_pct, calc.ins], ['Cautionnement supplémentaire', ch.bond_pct, calc.bond]].forEach(([nm, pct, amt]) => {
    const rh = 30;
    if (c.y + rh > PAGE_H - 60) { c.newPage(); head(); }
    c.text(nm + ' (%)', M + 6, c.y + 13, 9, f.reg, INK);
    c.text(String(num(pct)).replace('.', ',') + ' %', M + 6, c.y + 24, 8, f.reg, MUTED);
    cell(money(amt), 6, c.y + 13, true);
    c.line(M, c.y + rh, M + CW, c.y + rh, 0.5, LINE);
    c.y += rh;
  });
  c.y += 14;

  // --- Totaux ---
  c.need(100);
  const tx = PAGE_W - M - 230, tv = PAGE_W - M - 8;
  const trow = (k, v, bold) => { c.text(k, tx, c.y + 12, 9.5, bold ? f.bold : f.reg, INK); c.textRight(v, tv, c.y + 12, 10, f.bold, INK); c.y += 21; };
  trow('Sous-total', money(calc.subtotal)); trow('TPS 5%', money(calc.tps)); trow('TVQ 9,975%', money(calc.tvq));
  c.rect(tx - 6, c.y - 2, 244, 24, { color: ACCENT_SOFT }); c.rect(tx - 6, c.y - 2, 3.5, 24, { color: ACCENT });
  c.text('Total', tx + 4, c.y + 14, 11, f.bold, ACCENT); c.textRight(money(calc.total), tv, c.y + 14, 11.5, f.bold, ACCENT);
  c.y += 34;

  // --- Note importante + signature ---
  c.need(120);
  c.text('Note importante :', M, c.y + 10, 10.5, f.bold, INK); c.y += 24;
  String(ch.notes_text || DEFAULT_NOTES).split(/\n{2,}/).forEach(p => { c.para(p.trim(), { size: 8.5, lh: 11.5, color: INK }); c.y += 6; });
  c.y += 22;
  c.need(60);
  c.text('Signature :', M, c.y + 10, 10, f.bold, INK); c.line(M + 62, c.y + 12, M + 330, c.y + 12, 0.7, INK);
  c.text('Date :', M + 360, c.y + 10, 10, f.bold, INK); c.line(M + 392, c.y + 12, PAGE_W - M, c.y + 12, 0.7, INK);
  c.y += 30;

  // --- Pieds de page ---
  c.pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 36 }, end: { x: PAGE_W - M, y: 36 }, thickness: 0.5, color: LINE });
    pg.drawText(clean('Les Entreprises Philippe Denis inc. — ' + avc), { x: M, y: 24, size: 7.5, font: f.reg, color: MUTED });
    const t = 'Page ' + (i + 1) + ' / ' + c.pages.length;
    pg.drawText(t, { x: PAGE_W - M - f.reg.widthOfTextAtSize(t, 7.5), y: 24, size: 7.5, font: f.reg, color: MUTED });
  });
  return doc.save();
}

module.exports = { buildChangePdf, computeChange, DEFAULT_NOTES, TPS_RATE, TVQ_RATE };
