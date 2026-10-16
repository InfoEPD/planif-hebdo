// api/_lib/supplier-sync.js — synchronisation Avantage -> fin_supplier (reçue d'Exacto-Bridge).
// Les champs de conformité et de gestion (type, catégorie, RBQ, assurance, etc.) ne sont JAMAIS touchés ici.

const { q } = require('./db');
const crypto = require('crypto');

const FIELDS = ['name', 'address', 'address2', 'city', 'province', 'postalCode', 'country', 'phone', 'phoneExt', 'phone2', 'fax', 'cell',
  'contactName', 'email', 'tpsNo', 'tvqNo', 'defaultGl', 'apName', 'apPhone', 'apEmail', 'ordName', 'ordPhone', 'ordEmail', 'payName', 'payPhone', 'payEmail', 'remark'];
const str = (v, n) => (v == null ? '' : String(v).trim().slice(0, n || 300));

function clean(r) {
  const o = { avantageId: str(r.avantageId, 30) };
  FIELDS.forEach(k => { o[k] = str(r[k], k === 'remark' ? 1000 : 300); });
  o.lastPurchase = /^\d{4}-\d{2}-\d{2}$/.test(String(r.lastPurchase || '')) ? r.lastPurchase : null;
  o.inactive = r.inactive === true;
  o.srcUpdated = str(r.srcUpdated, 40) || null;
  o.hash = crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
  return o;
}

/** Insère ou met à jour un lot de fournisseurs (une seule requête SQL). */
async function upsertBatch(records) {
  const rows = (Array.isArray(records) ? records : []).slice(0, 500).map(clean).filter(o => o.avantageId && o.name);
  if (!rows.length) return { created: 0, updated: 0 };
  const res = await q(`
    WITH inc AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        "avantageId" text, name text, address text, address2 text, city text, province text, "postalCode" text, country text, phone text, "phoneExt" text, phone2 text, fax text, cell text,
        "contactName" text, email text, "tpsNo" text, "tvqNo" text, "defaultGl" text, "apName" text, "apPhone" text, "apEmail" text, "ordName" text, "ordPhone" text, "ordEmail" text,
        "payName" text, "payPhone" text, "payEmail" text, remark text, "lastPurchase" date, inactive boolean, "srcUpdated" text, hash text)),
    up AS (
      INSERT INTO fin_supplier (avantage_id, name, address, address2, city, province, postal_code, country, phone, phone_ext, phone2, fax, cell, contact_name, email, tps_no, tvq_no, default_gl,
          ap_name, ap_phone, ap_email, ord_name, ord_phone, ord_email, pay_name, pay_phone, pay_email, remark, last_purchase, avantage_inactive, in_avantage, src_hash, src_updated, synced_at)
      SELECT "avantageId", name, address, address2, city, province, "postalCode", country, phone, "phoneExt", phone2, fax, cell, "contactName", email, "tpsNo", "tvqNo", "defaultGl",
          "apName", "apPhone", "apEmail", "ordName", "ordPhone", "ordEmail", "payName", "payPhone", "payEmail", remark, "lastPurchase", inactive, TRUE, hash, "srcUpdated", now() FROM inc
      ON CONFLICT (avantage_id) DO UPDATE SET
          name = EXCLUDED.name, address = EXCLUDED.address, address2 = EXCLUDED.address2, city = EXCLUDED.city, province = EXCLUDED.province, postal_code = EXCLUDED.postal_code, country = EXCLUDED.country,
          phone = EXCLUDED.phone, phone_ext = EXCLUDED.phone_ext, phone2 = EXCLUDED.phone2, fax = EXCLUDED.fax, cell = EXCLUDED.cell, contact_name = EXCLUDED.contact_name, email = EXCLUDED.email,
          tps_no = EXCLUDED.tps_no, tvq_no = EXCLUDED.tvq_no, default_gl = EXCLUDED.default_gl, ap_name = EXCLUDED.ap_name, ap_phone = EXCLUDED.ap_phone, ap_email = EXCLUDED.ap_email,
          ord_name = EXCLUDED.ord_name, ord_phone = EXCLUDED.ord_phone, ord_email = EXCLUDED.ord_email, pay_name = EXCLUDED.pay_name, pay_phone = EXCLUDED.pay_phone, pay_email = EXCLUDED.pay_email,
          remark = EXCLUDED.remark, last_purchase = EXCLUDED.last_purchase, avantage_inactive = EXCLUDED.avantage_inactive, in_avantage = TRUE,
          src_hash = EXCLUDED.src_hash, src_updated = EXCLUDED.src_updated, synced_at = now()
      RETURNING (xmax = 0) AS inserted)
    SELECT count(*) FILTER (WHERE inserted)::int AS created, count(*) FILTER (WHERE NOT inserted)::int AS updated FROM up`, [JSON.stringify(rows)]);
  await q("UPDATE fin_supplier SET ext_id = '9' || lpad(id::text, 12, '0') WHERE ext_id IS NULL");
  return { created: Number(res[0].created) || 0, updated: Number(res[0].updated) || 0 };
}

/** Marque « retiré d'Avantage » les fournisseurs absents de la liste reçue (jamais supprimés). */
async function markPresent(present) {
  const list = (Array.isArray(present) ? present : []).map(v => str(v, 30)).filter(Boolean);
  if (list.length < 10) throw { status: 400, message: 'Liste de présence trop courte : ignorée par sécurité.' };
  const r = await q(`WITH p AS (SELECT unnest($1::text[]) AS id),
      gone AS (UPDATE fin_supplier SET in_avantage = FALSE WHERE avantage_id IS NOT NULL AND in_avantage AND avantage_id NOT IN (SELECT id FROM p) RETURNING 1),
      back AS (UPDATE fin_supplier SET in_avantage = TRUE WHERE NOT in_avantage AND avantage_id IN (SELECT id FROM p) RETURNING 1)
      SELECT (SELECT count(*) FROM gone)::int AS removed, (SELECT count(*) FROM back)::int AS restored`, [list]);
  // Mémorise le dernier passage réussi du pont (la date des fiches ne bouge que si un fournisseur change dans Avantage)
  try { await q("INSERT INTO fin_settings (key, value, updated_by) VALUES ('avantage_sup_last_run', $1, 'pont') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [new Date().toISOString()]); } catch (e) { /* facultatif */ }
  return { removed: Number(r[0].removed) || 0, restored: Number(r[0].restored) || 0 };
}

module.exports = { upsertBatch, markPresent, clean };
