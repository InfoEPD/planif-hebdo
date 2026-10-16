// api/_lib/qrtpdf.js
//
// Formulaire « Question réponse technique » (QRT) : pages 1+ = identification et question; dernière page = zone de réponse
// avec CHAMPS REMPLISSABLES (le professionnel répond directement dans le PDF avec Acrobat / Aperçu / navigateur) (pdf-lib, visuel Exacto).

const { rgb, PDFDocument, degrees } = require('pdf-lib');
const { M, PAGE_W, PAGE_H, CW } = require('./pdf');
const { newDoc, DaCtx, bar, box, kvRow, fmtDate, COLORS } = require('./dapdf');
const { INK, MUTED, LINE, ACCENT, WHITE } = COLORS;

const YN = { oui: 'Oui', non: 'Non', a_determiner: 'À déterminer' };
const ynLabel = v => YN[v] || (v ? String(v) : '—');


/** Orientation EXIF d'un JPEG (1 si absente). */
function jpegOrientation(buf) {
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
    let p = 2;
    while (p + 4 < buf.length) {
      if (buf[p] !== 0xFF) { p++; continue; }
      const mk = buf[p + 1], len = buf.readUInt16BE(p + 2);
      if (mk === 0xE1 && buf.toString('latin1', p + 4, p + 8) === 'Exif') {
        const t = p + 10, le = buf.toString('latin1', t, t + 2) === 'II';
        const r16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o), r32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
        const ifd = t + r32(t + 4), n = r16(ifd);
        for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (r16(e) === 0x0112) return r16(e + 8) || 1; }
        return 1;
      }
      if (mk === 0xDA) break;
      p += 2 + len;
    }
  } catch (e) { /* orientation ignorée */ }
  return 1;
}

/**
 * Ajoute les pièces jointes (PDF ou images JPEG/PNG) au document, avant la page de réponse.
 * annexes : [{ filename, bytes }]. Retourne { merged:[noms], skipped:[{name,reason}] }.
 */
async function addAnnexes(doc, f, annexes) {
  const merged = [], skipped = [], marks = [];
  let k = 0;
  for (const a of annexes || []) {
    const name = String(a.filename || 'pièce jointe'), buf = Buffer.from(a.bytes);
    const isPdf = /\.pdf$/i.test(name) || buf.toString('latin1', 0, 5) === '%PDF-';
    const isJpg = /\.jpe?g$/i.test(name) || (buf[0] === 0xFF && buf[1] === 0xD8);
    const isPng = /\.png$/i.test(name) || buf.toString('latin1', 1, 4) === 'PNG';
    try {
      if (isPdf) {
        const src = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        k++; pages.forEach(pg => { doc.addPage(pg); marks.push({ page: pg, label: 'Annexe ' + k + ' — ' + name }); });
      } else if (isJpg || isPng) {
        const img = isJpg ? await doc.embedJpg(new Uint8Array(buf)) : await doc.embedPng(new Uint8Array(buf));
        const ori = isJpg ? jpegOrientation(buf) : 1;
        const swap = ori >= 5 && ori <= 8;
        const iw = swap ? img.height : img.width, ih = swap ? img.width : img.height;
        k++;
        const pg = doc.addPage([PAGE_W, PAGE_H]);
        const bx = M, bw = PAGE_W - 2 * M, by = 60, bh = PAGE_H - 60 - 74;
        const sc = Math.min(bw / iw, bh / ih, 1.6);
        const dw = iw * sc, dh = ih * sc, ox = bx + (bw - dw) / 2, oy = by + (bh - dh) / 2;       // boîte affichée (origine bas-gauche)
        const w = img.width * sc, h = img.height * sc;
        let x = ox, y = oy, rot = 0;
        if (ori === 3) { rot = 180; x = ox + w; y = oy + h; }
        else if (ori === 6) { rot = -90; x = ox; y = oy + w; }
        else if (ori === 8) { rot = 90; x = ox + h; y = oy; }
        pg.drawImage(img, { x, y, width: w, height: h, rotate: degrees(rot) });
        pg.drawText('Annexe ' + k + ' — ' + name, { x: M, y: PAGE_H - 52, size: 11, font: f.bold, color: INK });
        marks.push({ page: pg, label: null });
      } else { skipped.push({ name, reason: 'format non fusionnable' }); continue; }
      merged.push(name);
    } catch (e) { skipped.push({ name, reason: String((e && e.message) || e).slice(0, 80) }); }
  }
  return { merged, skipped, marks };
}

/**
 * q : { ref, qrt_date, object, impact_schedule, impact_budget, directive, requester_name, requester_email, question,
 *       parties:[{k,v}], pro_company, pro_name, pro_email }
 * project : { number, name }
 */
async function buildQrt(project, q, annexes, report) {
  const { doc, f, logo } = await newDoc('QRT ' + (q.ref || '') + ' — ' + (project.number || ''));
  const lw = 130, lh = lw * logo.height / logo.width;
  const c = new DaCtx(doc, f);
  c.hm = { logo, lw, lh, titleLines: ['Question réponse technique'], sub: (q.ref || '') + '  |  ' + fmtDate(q.qrt_date, '/'), bottom: Math.max(34 + lh, 92) + 6 };
  c.drawHeader(c.page); c.y = c.hm.bottom + 14;
  const W = CW, half = W / 2;

  // 1. Projet
  let top = c.y;
  bar(c, 'Projet', M, W, top, 20);
  const rows1 = [['Projet :', project.name || '', 'No projet :', project.number || ''], ['QRT :', q.ref || '', 'Date :', fmtDate(q.qrt_date, '-').split('-').reverse().join('-')]];
  box(c, M, top + 20, W, 52);
  rows1.forEach((r, i) => { kvRow(c, r[0], r[1], M, top + 22 + i * 25, half, 72); kvRow(c, r[2], r[3], M + half, top + 22 + i * 25, half, 72); });
  c.y = top + 72 + 12;

  // 2. Intervenants
  const parties = (q.parties || []).filter(p => p && (p.k || p.v));
  if (parties.length) {
    top = c.y;
    bar(c, 'Intervenants du projet', M, W, top, 20);
    const nRows = Math.ceil(parties.length / 2);
    box(c, M, top + 20, W, nRows * 25 + 6);
    parties.forEach((p, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      kvRow(c, p.k + ' :', p.v || '', M + col * half, top + 23 + row * 25, half, 98, 9);
    });
    c.y = top + 20 + nRows * 25 + 6 + 12;
  }

  // 3. Objet + impacts
  top = c.y;
  bar(c, 'Objet de la QRT', M, W, top, 20);
  const objLines = c.wrap(q.object || '', 10.5, f.bold, W - 16).slice(0, 3);
  const objH = objLines.length * 14 + 10;
  box(c, M, top + 20, W, objH);
  objLines.forEach((ln, i) => c.text(ln, M + 8, top + 20 + 15 + i * 14, 10.5, f.bold, INK));
  c.y = top + 20 + objH + 10;
  top = c.y;
  box(c, M, top, W, 3 * 22 + 4);
  [["Est-ce que cette QRT a un impact sur l'échéancier ?", q.impact_schedule], ['Est-ce que cette QRT a un impact budgétaire ?', q.impact_budget], ["Est-ce qu'une directive sera émise ?", q.directive]]
    .forEach((r, i) => { c.text(r[0], M + 8, top + 17 + i * 22, 9.5, f.reg, MUTED); c.text(ynLabel(r[1]), M + W - 110, top + 17 + i * 22, 9.5, f.bold, INK); if (i) c.line(M, top + 2 + i * 22, M + W, top + 2 + i * 22, 0.4, LINE); });
  c.y = top + 3 * 22 + 4 + 12;

  // 4. Demandeur
  top = c.y;
  bar(c, 'Demandeur', M, W, top, 20);
  box(c, M, top + 20, W, 28);
  kvRow(c, 'Nom :', q.requester_name || '', M, top + 22, half, 50, 9.5);
  kvRow(c, 'Courriel :', q.requester_email || '', M + half, top + 22, half, 60, 9.5);
  c.y = top + 48 + 14;

  // 5. Question (peut s'étendre sur plusieurs pages)
  c.need(60);
  top = c.y;
  bar(c, 'Question, éclaircissement, clarification', M, W, top, 20);
  c.y = top + 20 + 8;
  const qLines = c.wrap(q.question || '', 10, f.reg, W - 18);
  c.rect(M, c.y - 4, 0.8, 1, { color: LINE });
  qLines.forEach(ln => { if (c.y + 14 > PAGE_H - 52) c.newPage(); c.text(ln, M + 9, c.y + 10, 10, f.reg, INK); c.y += 13.5; });
  c.line(M, c.y + 4, M + W, c.y + 4, 0.8, LINE);

  // 5b. Pièces jointes fusionnées (annexes), avant la page de réponse
  let marks = [];
  if (annexes && annexes.length) {
    const rep = await addAnnexes(doc, f, annexes);
    marks = rep.marks;
    if (report) { report.merged = rep.merged; report.skipped = rep.skipped; }
  }

  // 6. Réponse (dernière page, champs remplissables)
  c.newPage();
  const rtop = c.y;
  bar(c, 'Réponse du professionnel', M, W, rtop, 20);
  c.text('Répondre directement dans les champs ci-dessous, enregistrer le PDF puis le retourner à ' + (q.requester_email || "l'entrepreneur général") + '.', M, rtop + 36, 8.5, f.ital, MUTED);
  const form = doc.getForm();
  const bigTop = rtop + 44, bigH = 400;
  const mk = (name, top, h, multi, text) => {
    const tf = form.createTextField(name);
    if (multi) tf.enableMultiline();
    if (text) tf.setText(text);
    tf.addToPage(c.page, { x: M + 1, y: PAGE_H - (top + h), width: W - 2, height: h, borderWidth: 0.8, borderColor: LINE, backgroundColor: rgb(0.99, 0.995, 1), font: f.reg });
    tf.setFontSize(10);
    return tf;
  };
  mk('reponse', bigTop, bigH, true);
  // identification du répondant
  const labels = [['Organisation :', 'organisation', q.pro_company], ['Nom :', 'nom', q.pro_name], ['Courriel :', 'courriel', q.pro_email], ['Date :', 'date_reponse', '']];
  let ry = bigTop + bigH + 16;
  labels.forEach(([lab, name, val]) => {
    c.rect(M, ry, 110, 26, { color: rgb(0.93, 0.945, 0.98), borderColor: LINE, borderWidth: 0.8 });
    c.textRight(lab, M + 102, ry + 17, 9.5, f.reg, INK);
    const tf = form.createTextField(name); if (val) tf.setText(String(val));
    tf.addToPage(c.page, { x: M + 110, y: PAGE_H - (ry + 26), width: W - 110, height: 26, borderWidth: 0.8, borderColor: LINE, backgroundColor: rgb(0.99, 0.995, 1), font: f.reg });
    tf.setFontSize(10);
    ry += 26;
  });
  c.text('Réf. interne : ' + (q.ref || '') + ' — projet ' + (project.number || ''), M, ry + 22, 8, f.reg, MUTED);
  form.updateFieldAppearances(f.reg);
  const all = doc.getPages(), n = all.length;
  all.forEach((pg, i) => {
    const { width } = pg.getSize(), t = 'Page ' + (i + 1) + ' / ' + n;
    const mk = marks.find(x => x.page === pg);
    if (mk) {                                                    // page d'annexe : bandeau blanc pour rester lisible
      pg.drawRectangle({ x: width - M - 70, y: 20, width: 70, height: 14, color: WHITE });
      if (mk.label) { pg.drawRectangle({ x: 0, y: pg.getSize().height - 20, width, height: 20, color: WHITE }); pg.drawText(mk.label.slice(0, 110), { x: 18, y: pg.getSize().height - 14, size: 8, font: f.bold, color: MUTED }); }
    }
    pg.drawText(t, { x: width - M - f.reg.widthOfTextAtSize(t, 8), y: 24, size: 8, font: f.reg, color: MUTED });
  });
  return doc.save();
}

module.exports = { buildQrt };
