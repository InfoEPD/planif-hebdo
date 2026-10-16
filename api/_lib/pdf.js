// api/_lib/pdf.js
//
// Génération du PDF du bon de commande (gabarit EPD) avec pdf-lib :
//   page 1  : en-tête, émetteur/destinataire, contacts, lignes, taxes, dénonciation
//   suite   : conditions générales (texte modifiable par bon de commande), bloc de signature
//   [signé] : page « Certificat de signature électronique »
//   fin     : soumission du sous-traitant (PDF joint), ajoutée telle quelle
//
// Polices standard (Helvetica) : l'alphabet français est couvert (WinAnsi). Tout autre caractère
// est remplacé par « ? » pour ne jamais faire échouer la génération.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');
const LOGO_B64 = require('./epd-logo');

const PAGE_W = 612, PAGE_H = 792, M = 40, CW = PAGE_W - 2 * M;
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;

const COMPANY = {
  name: 'LES ENTREPRISES PHILIPPE DENIS',
  lines: ['1810, rue J-A Roy', 'Joliette (Québec)', 'J6E 9H6'],
  tel: '450-499-5536'
};

// ---------- Utilitaires -------------------------------------------------------------------

const EXTRA_WINANSI = new Set('’‘“”‚„–—…•€™ŒœŠšŸŽžƒˆ˜†‡‰‹›'.split(''));
function clean(s) {
  s = String(s == null ? '' : s)
    .replace(/[   ]/g, ' ')
    .replace(/[​‌‍⁠﻿]/g, '')
    .replace(/\r/g, '');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || EXTRA_WINANSI.has(ch)) out += ch === '\t' ? '  ' : ch;
    else out += '?';
  }
  return out;
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function computeTotals(lines, rates) {
  const sub = round2((lines || []).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0));
  const tps = round2(sub * ((rates && rates.tps) != null ? rates.tps : TPS_RATE));
  const tvq = round2(sub * ((rates && rates.tvq) != null ? rates.tvq : TVQ_RATE));
  return { subtotal: sub, tps, tvq, total: round2(sub + tps + tvq) };
}

function money(n) {
  { const v = Number(n || 0); return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
}

function fmtDate(d) {
  // d : 'YYYY-MM-DD' ou Date
  let y, m, day;
  if (d instanceof Date) { y = d.getFullYear(); m = d.getMonth() + 1; day = d.getDate(); }
  else { const mm = String(d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!mm) return String(d || ''); y = mm[1]; m = mm[2]; day = mm[3]; }
  return String(day).padStart(2, '0') + ' / ' + String(m).padStart(2, '0') + ' / ' + y;
}

function fmtDateTimeToronto(d) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(d)) + ' (HE)';
  } catch (e) { return new Date(d).toISOString(); }
}

function formatRetention(p) {
  const n = Number(p);
  if (!isFinite(n)) return '10';
  return (Math.round(n * 100) / 100).toString().replace('.', ',');
}

function renderTermsText(po) {
  return String(po.terms_text || '').replace(/\{\{\s*RETENUE\s*\}\}/g, formatRetention(po.retention_pct));
}

// ---------- Contexte de dessin ------------------------------------------------------------

class Ctx {
  constructor(doc, fonts) {
    this.doc = doc; this.f = fonts; this.page = null; this.y = M; this.pages = [];
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = 46; // distance depuis le haut
    return this.page;
  }
  need(h) { if (this.y + h > PAGE_H - 52) this.newPage(); }
  // y "top-based" -> coordonnée pdf-lib
  Y(top) { return PAGE_H - top; }
  text(str, x, top, size, font, color) {
    str = clean(str);
    if (!str) return;
    this.page.drawText(str, { x, y: this.Y(top), size, font: font || this.f.reg, color: color || rgb(0, 0, 0) });
  }
  width(str, size, font) { return (font || this.f.reg).widthOfTextAtSize(clean(str), size); }
  textRight(str, xRight, top, size, font, color) {
    this.text(str, xRight - this.width(str, size, font), top, size, font, color);
  }
  textCenter(str, xCenter, top, size, font, color) {
    this.text(str, xCenter - this.width(str, size, font) / 2, top, size, font, color);
  }
  line(x1, top1, x2, top2, w, color) {
    this.page.drawLine({ start: { x: x1, y: this.Y(top1) }, end: { x: x2, y: this.Y(top2) }, thickness: w || 0.5, color: color || rgb(0, 0, 0) });
  }
  rect(x, top, w, h, opts) {
    this.page.drawRectangle(Object.assign({ x, y: this.Y(top + h), width: w, height: h }, opts || {}));
  }
  wrap(str, size, font, maxW) {
    const out = [];
    const paragraphs = clean(str).split('\n');
    for (const p of paragraphs) {
      if (p.trim() === '') { out.push(''); continue; }
      const words = p.split(/ +/);
      let cur = '';
      for (let w of words) {
        // mot plus long que la ligne : on le coupe
        while (this.width(w, size, font) > maxW && w.length > 1) {
          let k = w.length - 1;
          while (k > 1 && this.width(w.slice(0, k), size, font) > maxW) k--;
          if (cur) { out.push(cur); cur = ''; }
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        const trial = cur ? cur + ' ' + w : w;
        if (this.width(trial, size, font) <= maxW) cur = trial;
        else { if (cur) out.push(cur); cur = w; }
      }
      out.push(cur);
    }
    return out;
  }
  // paragraphe avec retour à la ligne + sauts de page ; avance this.y
  para(str, o) {
    o = o || {};
    const size = o.size || 8, font = o.font || this.f.reg, lh = o.lh || size * 1.32, x = o.x != null ? o.x : M, w = o.w || CW;
    const lines = this.wrap(str, size, font, w);
    for (const ln of lines) {
      this.need(lh);
      this.text(ln, x, this.y + size, size, font, o.color);
      this.y += lh;
    }
  }
}

// ---------- Construction -------------------------------------------------------------------

/**
 * po : ligne fin_po (champs snake_case, contacts/owner/lines déjà parsés)
 * opts.quoteBytes   : Buffer/Uint8Array de la soumission (facultatif)
 * opts.signature    : { name, title, signedAt, ip, ua, viewedAt, sentAt, sentTo, pngDataUrl, docHash } (facultatif)
 * Retourne Uint8Array.
 */
async function buildPoPdf(po, opts) {
  opts = opts || {};
  const doc = await PDFDocument.create();
  doc.setTitle('Bon de commande ' + po.po_number);
  doc.setProducer('Exacto-Finance');
  doc.setCreator('Exacto-Finance');
  const fixed = new Date(po.sent_at || po.created_at || Date.now());
  doc.setCreationDate(fixed); doc.setModificationDate(fixed);

  const f = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    ital: await doc.embedFont(StandardFonts.HelveticaOblique)
  };
  const c = new Ctx(doc, f);
  const grey = rgb(0.4, 0.4, 0.4);

  // --- En-tête : logo + titre ---
  const logo = await doc.embedPng(Buffer.from(LOGO_B64, 'base64'));
  const logoW = 200, logoH = logoW * logo.height / logo.width;
  c.page.drawImage(logo, { x: M, y: c.Y(40 + logoH), width: logoW, height: logoH });
  const hx = 290;
  c.text('Bon de commande # ' + po.po_number, hx, 56, 16, f.bold);
  c.text('Date : ', hx, 80, 9, f.bold); c.text(fmtDate(po.po_date), hx + c.width('Date : ', 9, f.bold), 80, 9, f.reg);
  if (po.revision > 0) c.text('Révision ' + po.revision, hx + 150, 80, 9, f.bold);
  const projLine = (po.project_number || '') + (po.project_name ? ' - ' + po.project_name : '');
  c.text('Projet : ', hx, 96, 9, f.bold);
  {
    const lbl = c.width('Projet : ', 9, f.bold);
    const lines = c.wrap(projLine, 9, f.reg, PAGE_W - M - hx - lbl);
    c.text(lines[0] || '', hx + lbl, 96, 9, f.reg);
    if (lines[1]) c.text(lines[1], hx + lbl, 108, 9, f.reg);
  }
  const sTop = projLine && c.wrap(projLine, 9, f.reg, PAGE_W - M - hx - 40).length > 1 ? 122 : 112;
  c.text('# Soumission: ', hx, sTop + 4, 9, f.bold);
  c.text(po.soumission_number || '', hx + c.width('# Soumission: ', 9, f.bold), sTop + 4, 9, f.reg);

  // --- Émetteur / Destinataire ---
  let top = 150;
  const colB = hx;
  c.text('Émetteur', M, top, 9.5, f.bold); c.line(M, top + 2, M + c.width('Émetteur', 9.5, f.bold), top + 2, 0.7);
  c.text('Destinataire', colB, top, 9.5, f.bold); c.line(colB, top + 2, colB + c.width('Destinataire', 9.5, f.bold), top + 2, 0.7);
  top += 20;
  c.text(COMPANY.name, M, top, 8, f.bold);
  let ty = top + 12;
  COMPANY.lines.forEach(l => { c.text(l, M, ty, 8, f.reg); ty += 11; });
  c.text('Tél : ' + COMPANY.tel, M, ty, 8, f.reg); ty += 11;

  let dy = top;
  const destRows = [['Nom : ', po.supplier_name], ['Courriel : ', po.supplier_email], ['Téléphone : ', po.supplier_phone]];
  destRows.forEach(([lbl, val]) => {
    c.text(lbl, colB, dy, 8, f.bold);
    const lw = c.width(lbl, 8, f.bold);
    const ls = c.wrap(val || '', 8, f.reg, PAGE_W - M - colB - lw);
    ls.slice(0, 2).forEach((ln, i) => c.text(ln, colB + lw, dy + i * 10, 8, f.reg));
    dy += 12 + (ls.length > 1 ? 10 : 0);
  });
  c.y = Math.max(ty, dy) + 14;

  // --- Table des contacts ---
  const cw = [150, 120, 120, CW - 390];
  const heads = ['NOM', 'POSTE', 'TÉLÉPHONE', 'COURRIEL'];
  const rowH = 16;
  const contacts = (po.contacts && po.contacts.length ? po.contacts : []);
  c.need(rowH * (contacts.length + 1) + 10);
  let x = M, t = c.y;
  heads.forEach((h, i) => {
    c.rect(x, t, cw[i], rowH, { borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
    c.textCenter(h, x + cw[i] / 2, t + 11, 8, f.bold);
    x += cw[i];
  });
  t += rowH;
  contacts.forEach(ct => {
    x = M;
    const cells = [ct.name || '', ct.role || '', ct.phone || '', ct.email || ''];
    cells.forEach((v, i) => {
      c.rect(x, t, cw[i], rowH, { borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
      const size = 7.5;
      let s = clean(v);
      while (s.length > 1 && c.width(s, size, f.reg) > cw[i] - 8) s = s.slice(0, -1);
      if (i === 1) c.textCenter(s, x + cw[i] / 2, t + 11, size, f.reg); else c.text(s, x + 4, t + 11, size, f.reg);
      x += cw[i];
    });
    t += rowH;
  });
  c.y = t + 14;

  // --- Lien projet ---
  if (po.project_link) {
    c.need(20);
    const lbl = 'Lien projet: ';
    c.text(lbl, M, c.y + 9, 9, f.bold);
    const lw = c.width(lbl, 9, f.bold);
    const ls = c.wrap(po.project_link, 9, f.bold, CW - lw);
    c.text(ls[0], M + lw, c.y + 9, 9, f.bold);
    c.y += 12;
    ls.slice(1).forEach(l => { c.text(l, M, c.y + 9, 9, f.bold); c.y += 11; });
    c.y += 8;
  }

  // --- Table des lignes ---
  const lcw = [CW - 232, 90, 60, 82];
  const lh = ['Nom', 'Prix', 'QTÉ', 'Sous-total'];
  c.need(60);
  t = c.y; x = M;
  lh.forEach((h, i) => {
    c.rect(x, t, lcw[i], 20, { borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    if (i === 0) c.text(h, x + 4, t + 14, 9.5, f.bold); else c.textRight(h, x + lcw[i] - 5, t + 14, 9.5, f.bold);
    x += lcw[i];
  });
  c.y = t + 20;
  (po.lines || []).forEach(l => {
    const nameLines = c.wrap(l.name || '', 9, f.reg, lcw[0] - 10);
    const h = Math.max(20, nameLines.length * 11 + 8);
    c.need(h);
    let xx = M, tt = c.y;
    lcw.forEach((w, i) => { c.rect(xx, tt, w, h, { borderColor: rgb(0, 0, 0), borderWidth: 0.5 }); xx += w; });
    nameLines.forEach((ln, i) => c.text(ln, M + 4, tt + 13 + i * 11, 9, f.reg));
    const qty = Number(l.qty) || 0, price = Number(l.price) || 0;
    c.textRight(money(price), M + lcw[0] + lcw[1] - 5, tt + 13, 9, f.reg);
    c.textRight(String(qty), M + lcw[0] + lcw[1] + lcw[2] - 5, tt + 13, 9, f.reg);
    c.textRight(money(round2(price * qty)), M + CW - 5, tt + 13, 9, f.reg);
    c.y += h;
  });
  c.y += 14;

  // --- Totaux ---
  c.need(90);
  const rx = M + CW - 5, lx = M + CW - 150;
  const trow = (label, val, bold, size) => {
    c.textRight(label, lx, c.y + 10, size || 9.5, bold ? f.bold : f.reg);
    c.textRight(val, rx, c.y + 10, size || 9.5, bold ? f.bold : f.reg);
    c.y += (size || 9.5) + 11;
  };
  trow('Sous-total', money(po.subtotal), true);
  trow('TPS 5%', money(po.tps), false);
  trow('TVQ 9,975%', money(po.tvq), false);
  trow('Total', money(po.total), true, 11);
  c.y += 8;

  // --- Mention facture + dénonciation + info supplémentaire ---
  c.para('Toute facture liée au présent bon de commande doit obligatoirement indiquer le numéro du bon de commande, sans quoi elle sera automatiquement refusée.', { size: 8, font: f.bold, lh: 11 });
  c.y += 10;
  const ow = po.owner || {};
  if (ow.name || ow.address || ow.cadastre || ow.email) {
    c.need(70);
    c.text('Informations Dénonciation:', M, c.y + 8, 8, f.bold);
    c.line(M, c.y + 10, M + c.width('Informations Dénonciation:', 8, f.bold), c.y + 10, 0.6);
    c.y += 16;
    if (ow.name) c.para('Nom du propriétaire: ' + ow.name, { size: 8, lh: 11 });
    if (ow.address) c.para('Adresse du propriétaire: ' + ow.address, { size: 8, lh: 11 });
    if (ow.cadastre) c.para('Numéro de cadastre: ' + ow.cadastre, { size: 8, lh: 11 });
    if (ow.email) c.para('Courriel du propriétaire: ' + ow.email, { size: 8, lh: 11 });
    c.y += 8;
  }
  c.need(30);
  c.para('Information supplémentaire : ' + (po.info_additional && String(po.info_additional).trim() ? po.info_additional : 'n/a'), { size: 8, lh: 11 });

  // --- Conditions générales (nouvelle page) ---
  c.newPage();
  c.text('CONDITIONS GÉNÉRALES DU BON DE COMMANDE', M, c.y + 10, 10, f.bold);
  c.y += 26;
  const termsLines = renderTermsText(po).split('\n');
  for (const raw of termsLines) {
    const ln = raw.replace(/\s+$/, '');
    if (ln === '') { c.y += 5; continue; }
    if (/^\d{1,2}\.\s+\S/.test(ln) && ln.length < 90) {
      c.need(30); c.y += 4;
      c.text(ln, M, c.y + 9, 9, f.bold); c.y += 13;
    } else if (/^[-•]\s+/.test(ln)) {
      c.need(11);
      const body = ln.replace(/^[-•]\s+/, '');
      const ls = c.wrap(body, 8, f.reg, CW - 40);
      ls.forEach((l2, i) => {
        c.need(10.5);
        if (i === 0) c.text('•', M + 18, c.y + 8, 8, f.reg);
        c.text(l2, M + 30, c.y + 8, 8, f.reg);
        c.y += 10.5;
      });
    } else {
      c.para(ln, { size: 8, lh: 10.5 });
    }
  }

  // --- Bloc de signature ---
  c.need(150);
  c.y += 16;
  c.para('Je, soussigné(e), accepte ce bon de commande aux termes et conditions qui y sont stipulés.', { size: 8, lh: 11 });
  c.y += 10;
  const sig = opts.signature;
  const sigBoxTop = c.y;
  if (sig && sig.pngDataUrl) {
    try {
      const b64 = String(sig.pngDataUrl).replace(/^data:image\/png;base64,/, '');
      const img = await doc.embedPng(Buffer.from(b64, 'base64'));
      const maxW = 220, maxH = 60;
      const sc = Math.min(maxW / img.width, maxH / img.height, 1);
      c.page.drawImage(img, { x: M + 6, y: c.Y(sigBoxTop + img.height * sc), width: img.width * sc, height: img.height * sc });
    } catch (e) { /* signature illisible : on continue avec la mention texte */ }
  }
  c.y = sigBoxTop + 64;
  c.line(M, c.y, M + 240, c.y, 0.6);
  c.line(M + 280, c.y, M + CW, c.y, 0.6);
  c.y += 10;
  c.text('Signature du fournisseur', M, c.y, 7.5, f.reg, grey);
  c.text('Nom, titre et date', M + 280, c.y, 7.5, f.reg, grey);
  if (sig) {
    c.text(clean(sig.name) + (sig.title ? ', ' + clean(sig.title) : ''), M + 280, c.y - 28, 8.5, f.bold);
    c.text(fmtDateTimeToronto(sig.signedAt), M + 280, c.y - 16, 7.5, f.reg, grey);
  }
  c.y += 16;
  c.para("Le présent bon de commande, lorsqu'accepté par le Fournisseur devient le contrat ci-joint entre les parties. Merci de votre confiance!", { size: 8, lh: 11 });

  // --- Certificat de signature ---
  if (sig) {
    c.newPage();
    c.text('Certificat de signature électronique', M, c.y + 14, 15, f.bold);
    c.y += 34;
    const rows = [
      ['Bon de commande', po.po_number],
      ['Référence du document', po.doc_ref],
      ['Fournisseur', po.supplier_name],
      ['Montant total', money(po.total)],
      ['Envoyé à', (sig.sentTo || po.supplier_email || '') + (sig.sentAt ? '  —  ' + fmtDateTimeToronto(sig.sentAt) : '')],
      ['Consulté', sig.viewedAt ? fmtDateTimeToronto(sig.viewedAt) : '—'],
      ['Signé par', clean(sig.name) + (sig.title ? ', ' + clean(sig.title) : '')],
      ['Signé le', fmtDateTimeToronto(sig.signedAt)],
      ['Adresse IP', sig.ip || ''],
      ['Navigateur', String(sig.ua || '').slice(0, 140)],
      ['Empreinte SHA-256', sig.docHash || '']
    ];
    rows.forEach(([k, v]) => {
      const ls = c.wrap(v, 8.5, f.reg, CW - 170);
      const h = Math.max(18, ls.length * 11 + 8);
      c.need(h);
      c.text(k, M, c.y + 12, 8.5, f.bold);
      ls.forEach((l2, i) => c.text(l2, M + 165, c.y + 12 + i * 11, 8.5, f.reg));
      c.y += h;
      c.line(M, c.y - 3, M + CW, c.y - 3, 0.3, rgb(0.8, 0.8, 0.8));
    });
    c.y += 14;
    if (sig.pngDataUrl) {
      try {
        const img = await doc.embedPng(Buffer.from(String(sig.pngDataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
        const sc = Math.min(240 / img.width, 70 / img.height, 1);
        c.need(img.height * sc + 20);
        c.text('Signature', M, c.y + 10, 8.5, f.bold);
        c.y += 16;
        c.page.drawImage(img, { x: M, y: c.Y(c.y + img.height * sc), width: img.width * sc, height: img.height * sc });
        c.y += img.height * sc + 10;
      } catch (e) {}
    }
    c.y += 10;
    c.para("La signature électronique ci-dessus a été apposée par la personne identifiée, depuis le lien sécurisé transmis à l'adresse courriel indiquée. Ce certificat consigne les éléments de preuve (date, heure, adresse IP, empreinte du document) au moment de la signature.", { size: 8, lh: 11, color: grey });
  }

  // --- Pieds de page (pages du bon de commande seulement) ---
  const total = c.pages.length;
  c.pages.forEach((pg, i) => {
    c.page = pg;
    c.rect(M - 18, PAGE_H - 30, 250, 11, { color: rgb(0.9, 0.9, 0.9) });
    c.text('Réf. du document : ' + po.doc_ref, M - 14, PAGE_H - 22, 6.5, f.reg, rgb(0.15, 0.15, 0.15));
    c.rect(PAGE_W - M - 62, PAGE_H - 30, 80, 11, { color: rgb(0.9, 0.9, 0.9) });
    c.textRight('Page ' + (i + 1) + ' sur ' + total, PAGE_W - M + 14, PAGE_H - 22, 6.5, f.reg, rgb(0.15, 0.15, 0.15));
  });

  // --- Soumission du sous-traitant : ajoutée à la toute fin ---
  if (opts.quoteBytes && opts.quoteBytes.length) {
    let qdoc;
    try {
      qdoc = await PDFDocument.load(opts.quoteBytes, { ignoreEncryption: true });
    } catch (e) {
      const err = new Error("La soumission jointe n'est pas un PDF lisible. Veuillez la remplacer.");
      err.status = 400; throw err;
    }
    const copied = await doc.copyPages(qdoc, qdoc.getPageIndices());
    copied.forEach(p => doc.addPage(p));
  }

  return await doc.save();
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

module.exports = { buildPoPdf, computeTotals, sha256Hex, renderTermsText, round2, fmtDateTimeToronto, TPS_RATE, TVQ_RATE, COMPANY, Ctx, clean, LOGO_B64, M, PAGE_W, PAGE_H, CW };
