// api/_lib/po.js
// Fonctions partagées par api/finance.js (authentifié) et api/sign.js (public, par jeton).

const crypto = require('crypto');
const { q } = require('./db');
const sp = require('./sharepoint');

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

/** Ligne SQL -> objet bon de commande (numériques en nombres). */
function rowToPo(r) {
  if (!r) return null;
  const o = Object.assign({}, r);
  ['subtotal', 'tps', 'tvq', 'total', 'retention_pct'].forEach(k => { if (k in o) o[k] = num(o[k]); });
  if (typeof o.contacts === 'string') { try { o.contacts = JSON.parse(o.contacts); } catch (e) { o.contacts = []; } }
  if (typeof o.owner === 'string') { try { o.owner = JSON.parse(o.owner); } catch (e) { o.owner = {}; } }
  if (typeof o.lines === 'string') { try { o.lines = JSON.parse(o.lines); } catch (e) { o.lines = []; } }
  if (o.po_date instanceof Date) o.po_date = o.po_date.toISOString().slice(0, 10);
  else if (typeof o.po_date === 'string') o.po_date = o.po_date.slice(0, 10);
  return o;
}

async function logEvent(poId, event, actor, ip, detail) {
  try {
    await q('INSERT INTO fin_po_event (po_id, event, actor, ip, detail) VALUES ($1,$2,$3,$4,$5)',
      [poId, event, actor || null, ip || null, detail ? String(detail).slice(0, 500) : null]);
  } catch (e) { console.error('logEvent', e && e.message); }
}

async function getFile(poId, kind) {
  const r = await q('SELECT filename, data_b64 FROM fin_po_file WHERE po_id = $1 AND kind = $2', [poId, kind]);
  return r[0] ? { filename: r[0].filename, bytes: Buffer.from(r[0].data_b64, 'base64') } : null;
}

async function putFile(poId, kind, filename, bytes) {
  await q(`INSERT INTO fin_po_file (po_id, kind, filename, data_b64) VALUES ($1,$2,$3,$4)
           ON CONFLICT (po_id, kind) DO UPDATE SET filename = EXCLUDED.filename, data_b64 = EXCLUDED.data_b64, created_at = now()`,
    [poId, kind, filename, Buffer.from(bytes).toString('base64')]);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

function newDocRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const b = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) { s += alphabet[b[i] % alphabet.length]; if (i % 5 === 4 && i < 19) s += '-'; }
  return s;
}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function safeFilename(po, suffix) {
  const s = String(po.po_number + ' - ' + po.supplier_name + (suffix ? ' ' + suffix : '')).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s + '.pdf';
}

/** Dépose le PDF signé dans SharePoint et met à jour le statut (attente -> reussi | echec | non_configure). */
async function pushToSharePoint(po) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_po SET sharepoint_status = 'non_configure', sharepoint_error = NULL, updated_at = now() WHERE id = $1", [po.id]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_po SET sharepoint_status = 'attente', sharepoint_error = NULL WHERE id = $1", [po.id]);
  try {
    const f = await getFile(po.id, 'signed');
    if (!f) throw new Error('PDF signé introuvable.');
    const out = await sp.uploadPdf(po, f.bytes);
    await q("UPDATE fin_po SET sharepoint_status = 'reussi', sharepoint_url = $2, sharepoint_error = NULL, updated_at = now() WHERE id = $1", [po.id, out.webUrl || null]);
    await logEvent(po.id, 'sharepoint_ok', 'systeme', null, out.path);
    return { status: 'reussi', url: out.webUrl };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_po SET sharepoint_status = 'echec', sharepoint_error = $2, updated_at = now() WHERE id = $1", [po.id, msg]);
    await logEvent(po.id, 'sharepoint_echec', 'systeme', null, msg);
    return { status: 'echec', error: msg };
  }
}

// ---------- Normalisation des champs saisis ------------------------------------------------

function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max || 200); }
function isEmail(s) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s); }

function normalizeLines(arr) {
  if (!Array.isArray(arr) || !arr.length) throw { status: 400, message: 'Ajoutez au moins une ligne au bon de commande.' };
  if (arr.length > 40) throw { status: 400, message: 'Maximum 40 lignes par bon de commande.' };
  return arr.map((l, i) => {
    const name = str(l.name, 400);
    const price = Math.round(num(l.price) * 100) / 100;
    const qty = Math.round(num(l.qty) * 1000) / 1000;
    if (!name) throw { status: 400, message: 'Ligne ' + (i + 1) + ' : la description est obligatoire.' };
    if (price < 0 || price > 99999999) throw { status: 400, message: 'Ligne ' + (i + 1) + ' : prix invalide.' };
    if (!qty || Math.abs(qty) > 999999) throw { status: 400, message: 'Ligne ' + (i + 1) + ' : quantité invalide.' };
    return { name, price, qty };
  });
}

function normalizeContacts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 8).map(c => ({ role: str(c.role, 60), name: str(c.name, 80), phone: str(c.phone, 40), email: str(c.email, 120) }))
    .filter(c => c.role || c.name || c.phone || c.email);
}

function normalizeOwner(o) {
  o = o || {};
  return { name: str(o.name, 160), address: str(o.address, 240), cadastre: str(o.cadastre, 80), email: str(o.email, 200) };
}

function normalizeRetention(v) {
  const n = num(v);
  if (n < 0 || n > 100) throw { status: 400, message: 'Retenue invalide (0 à 100 %).' };
  return Math.round(n * 100) / 100;
}

module.exports = {
  rowToPo, logEvent, getFile, putFile, clientIp, newDocRef, newToken, safeFilename, pushToSharePoint,
  str, isEmail, num, normalizeLines, normalizeContacts, normalizeOwner, normalizeRetention
};
