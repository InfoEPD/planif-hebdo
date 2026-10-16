// api/_lib/suppliers-db.js — liste des fournisseurs lue dans Neon (fin_supplier), même forme que monday.parseSupplier().
// Activé par la variable d'environnement SUPPLIERS_SOURCE=neon (sinon l'app continue de lire le board Monday).

const { q } = require('./db');

const COLS = 'ext_id, avantage_id, name, supplier_type, avantage_inactive, in_avantage, blacklisted, email_general, email, ap_email, ord_email, email_accounting, email_tender, phone, cell, phone2, contact_name, contacts';

function shape(r) {
  const emails = [];
  let cts = r.contacts; if (typeof cts === 'string') { try { cts = JSON.parse(cts); } catch (e) { cts = []; } }
  cts = (Array.isArray(cts) ? cts : []).filter(c => c && (c.email || c.phone));
  [r.email_general, r.email, r.ap_email, r.ord_email, r.email_accounting, r.email_tender].forEach(v => {
    String(v || '').split(/[;,\s]+/).forEach(e => { e = e.trim(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !emails.some(x => x.toLowerCase() === e.toLowerCase())) emails.push(e); });
  });
  cts.forEach(c => { const e = String(c.email || '').trim(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !emails.some(x => x.toLowerCase() === e.toLowerCase())) emails.push(e); });
  const cPhone = (cts.find(c => c.phone) || {}).phone || '', cName = (cts.find(c => c.name) || {}).name || '';
  return { id: String(r.ext_id), name: r.name, type: r.supplier_type || '', active: !r.avantage_inactive && r.in_avantage !== false,
    blacklisted: !!r.blacklisted, emails, phone: r.phone || r.cell || r.phone2 || cPhone || '', contact: r.contact_name || cName || '', contacts: cts, avantageId: r.avantage_id || '' };
}

let cache = { at: 0, list: null };
async function fetchSuppliers(force) {
  if (!force && cache.list && Date.now() - cache.at < 2 * 60 * 1000) return cache.list;
  const rows = await q(`SELECT ${COLS} FROM fin_supplier WHERE ext_id IS NOT NULL ORDER BY lower(name)`);
  cache = { at: Date.now(), list: rows.map(shape) };
  return cache.list;
}
async function fetchSupplier(id) {
  const r = await q(`SELECT ${COLS} FROM fin_supplier WHERE ext_id = $1`, [String(id)]);
  if (!r[0]) throw { status: 404, message: 'Fournisseur introuvable.' };
  return shape(r[0]);
}
const enabled = () => String(process.env.SUPPLIERS_SOURCE || '').toLowerCase() === 'neon';

module.exports = { fetchSuppliers, fetchSupplier, shape, enabled };
