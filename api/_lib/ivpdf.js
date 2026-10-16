// api/_lib/ivpdf.js
//
// PDF « Liste des intervenants » d'un projet (gabarit EPD / Exacto, pdf-lib).
//   en-tête (logo, projet) · entrepreneur général · maître de l'ouvrage · chargé de projet / contremaître
//   · intervenants (professionnels) · sous-traitants · fournisseurs — pagination automatique, pied de page numéroté.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { Ctx, clean, LOGO_B64, M, PAGE_W, PAGE_H, CW } = require('./pdf');

const ACCENT = rgb(0.184, 0.357, 0.918);   // #2f5bea
const ACCENT_SOFT = rgb(0.91, 0.933, 1);   // #e8eeff
const INK = rgb(0.09, 0.133, 0.231);       // #17223b
const MUTED = rgb(0.416, 0.463, 0.569);    // #6a7691
const ZEBRA = rgb(0.973, 0.98, 0.996);
const LINE = rgb(0.86, 0.882, 0.933);

function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return '(' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(p || '').trim();
}

class IvCtx extends Ctx {
  newPage() {
    const pg = super.newPage();
    if (this.hdr) {
      const h = this.hdr;
      pg.drawRectangle({ x: 0, y: PAGE_H - 30, width: PAGE_W, height: 30, color: ACCENT });
      pg.drawText(clean('Intervenants — ' + h.title), { x: M, y: PAGE_H - 20, size: 9.5, font: this.f.bold, color: rgb(1, 1, 1) });
      this.y = 46;
    }
    return pg;
  }
}

async function buildIntervenantsPdf(m) {
  const doc = await PDFDocument.create();
  const title = (m.project.number ? m.project.number + ' - ' : '') + (m.project.name || '');
  doc.setTitle('Intervenants ' + title); doc.setProducer('Exacto-Finance'); doc.setCreator('Exacto-Finance');
  const f = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    ital: await doc.embedFont(StandardFonts.HelveticaOblique)
  };
  const c = new IvCtx(doc, f);
  c.hdr = { title };

  // --- En-tête de la première page ---
  const logo = await doc.embedPng(Buffer.from(LOGO_B64, 'base64'));
  const lw = 150, lh = lw * logo.height / logo.width;
  c.page.drawImage(logo, { x: M, y: c.Y(34 + lh), width: lw, height: lh });
  c.textRight('LISTE DES INTERVENANTS', PAGE_W - M, 52, 15, f.bold, ACCENT);
  const projLines = c.wrap(title, 10.5, f.bold, 320);
  projLines.slice(0, 2).forEach((ln, i) => c.textRight(ln, PAGE_W - M, 70 + i * 14, 10.5, f.bold, INK));
  c.line(M, 34 + lh + 12, PAGE_W - M, 34 + lh + 12, 1.5, ACCENT);
  c.y = 34 + lh + 26;

  const section = label => {
    c.need(40);
    c.rect(M, c.y, CW, 17, { color: ACCENT_SOFT });
    c.rect(M, c.y, 3.5, 17, { color: ACCENT });
    c.text(label, M + 10, c.y + 12, 9.5, f.bold, ACCENT);
    c.y += 24;
  };
  const kv = (k, v, x, w) => {
    const kw = c.width(k + ' ', 8.5, f.bold);
    const lines = c.wrap(v || '—', 8.5, f.reg, w - kw);
    c.need(12 * lines.length);
    c.text(k, x, c.y + 8.5, 8.5, f.bold, MUTED);
    lines.forEach((ln, i) => c.text(ln, x + kw, c.y + 8.5 + i * 11, 8.5, f.reg, INK));
    c.y += 12 * lines.length;
  };

  // --- Entrepreneur général ---
  section('ENTREPRENEUR GÉNÉRAL');
  c.text(m.company.name, M + 4, c.y + 9, 10, f.bold, INK); c.y += 14;
  kv('Adresse :', m.company.address, M + 4, CW); kv('Courriel :', m.company.email, M + 4, CW); kv('Téléphone :', fmtPhone(m.company.phone), M + 4, CW);
  c.y += 8;

  // --- Maître de l'ouvrage ---
  section("MAÎTRE DE L'OUVRAGE");
  kv('Nom :', m.owner.name, M + 4, CW); kv('Téléphone :', fmtPhone(m.owner.phone), M + 4, CW); kv('Courriel :', m.owner.email, M + 4, CW);
  c.y += 8;

  // --- Chargé de projet / Contremaître (2 colonnes) ---
  c.need(70);
  const colW = (CW - 16) / 2, x2 = M + colW + 16;
  const startY = c.y;
  const people = (label, list, x) => {
    c.y = startY;
    c.rect(x, c.y, colW, 17, { color: ACCENT_SOFT }); c.rect(x, c.y, 3.5, 17, { color: ACCENT });
    c.text(label, x + 10, c.y + 12, 9.5, f.bold, ACCENT); c.y += 24;
    const arr = list.length ? list : [{ name: '', phone: '', email: '' }];
    arr.forEach((p, i) => {
      kv('Nom :', p.name, x + 4, colW - 4); kv('Téléphone :', fmtPhone(p.phone), x + 4, colW - 4); kv('Courriel :', p.email, x + 4, colW - 4);
      if (i < arr.length - 1) c.y += 5;
    });
    return c.y;
  };
  const yA = people('CHARGÉ DE PROJET', m.cp, M);
  const yB = people('CONTREMAÎTRE', m.cm, x2);
  c.y = Math.max(yA, yB) + 10;

  // --- Tableaux ---
  const table = (label, cols, rows, emptyText) => {
    section(label);
    const drawHead = () => {
      c.need(26);
      c.rect(M, c.y, CW, 16, { color: ACCENT });
      let x = M;
      cols.forEach(col => { c.text(col.label, x + 5, c.y + 11, 8, f.bold, rgb(1, 1, 1)); x += col.w; });
      c.y += 16;
    };
    if (!rows.length) { c.text(emptyText || 'Aucun.', M + 4, c.y + 9, 8.5, f.ital, MUTED); c.y += 20; return; }
    drawHead();
    rows.forEach((r, ri) => {
      const wrapped = cols.map((col, i) => c.wrap(r[i] || '', 8.5, i === 0 ? f.bold : f.reg, col.w - 10));
      const nl = Math.max(1, ...wrapped.map(w => w.length));
      const rh = nl * 11 + 8;
      if (c.y + rh > PAGE_H - 52) { c.newPage(); drawHead(); }
      if (ri % 2 === 1) c.rect(M, c.y, CW, rh, { color: ZEBRA });
      let x = M;
      wrapped.forEach((lines, i) => { lines.forEach((ln, k) => c.text(ln, x + 5, c.y + 12 + k * 11, 8.5, i === 0 ? f.bold : f.reg, INK)); x += cols[i].w; });
      c.line(M, c.y + rh, M + CW, c.y + rh, 0.4, LINE);
      c.y += rh;
    });
    c.y += 12;
  };

  table('INTERVENANTS', [{ label: 'ENTREPRISE', w: 120 }, { label: 'SPÉCIALITÉ', w: 80 }, { label: 'CONTACT', w: 115 }, { label: 'TÉLÉPHONE', w: 78 }, { label: 'COURRIEL', w: CW - 393 }],
    m.pros.map(p => [p.company, p.specialty, p.contact, fmtPhone(p.phone), p.email]), 'Aucun intervenant inscrit.');
  const sub = list => list.map(s => [s.company + (s.category ? '\n' + s.category : ''), fmtPhone(s.phone), s.email || '—']);
  const cols3 = [{ label: 'ENTREPRISE / SPÉCIALITÉ', w: 230 }, { label: 'TÉLÉPHONE', w: 100 }, { label: 'COURRIEL', w: CW - 330 }];
  table('SOUS-TRAITANTS', cols3, sub(m.subs), "Aucun bon de commande de sous-traitance envoyé pour l'instant.");
  table('FOURNISSEURS', cols3, sub(m.suppliers), "Aucun bon de commande d'achat envoyé pour l'instant.");

  // --- Pieds de page ---
  const gd = m.generatedAt ? new Date(m.generatedAt) : null;
  const when = gd && !isNaN(gd) ? new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(gd) : (typeof m.generatedAt === 'string' ? m.generatedAt : '');
  c.pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 36 }, end: { x: PAGE_W - M, y: 36 }, thickness: 0.5, color: LINE });
    pg.drawText(clean(m.company.name + (when ? ' — généré le ' + when : '')), { x: M, y: 24, size: 7.5, font: f.reg, color: MUTED });
    const t = 'Page ' + (i + 1) + ' / ' + c.pages.length;
    pg.drawText(t, { x: PAGE_W - M - f.reg.widthOfTextAtSize(t, 7.5), y: 24, size: 7.5, font: f.reg, color: MUTED });
  });
  return doc.save();
}

module.exports = { buildIntervenantsPdf, fmtPhone };
