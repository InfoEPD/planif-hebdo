// api/_lib/parties.js — Liste d'intervenants (Clients, Maîtres de l'ouvrage, Professionnels), distincte des fournisseurs.
const { q } = require('./db');
const KINDS = ['client', 'maitre', 'professionnel'];
const str = (v, n) => (v == null ? '' : String(v).trim().slice(0, n || 200));
const COLS = 'id, kind, name, specialty, contact, phone, email, notes, active';

let _ready = null;
function ensure() {
  if (!_ready) _ready = q(`CREATE TABLE IF NOT EXISTS fin_party (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'professionnel', name TEXT NOT NULL, specialty TEXT, contact TEXT, phone TEXT, email TEXT, notes TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(e => { _ready = null; throw e; });
  return _ready;
}
async function list(all) {
  await ensure();
  return q('SELECT ' + COLS + ' FROM fin_party ' + (all ? '' : 'WHERE active ') + "ORDER BY CASE kind WHEN 'client' THEN 1 WHEN 'maitre' THEN 2 ELSE 3 END, lower(name)");
}
async function save(user, b) {
  await ensure();
  const kind = KINDS.includes(b.kind) ? b.kind : null; if (!kind) throw { status: 400, message: 'Catégorie invalide.' };
  const name = str(b.name, 200); if (!name) throw { status: 400, message: 'Le nom est requis.' };
  const v = [kind, name, kind === 'professionnel' ? str(b.specialty, 80) || null : null, str(b.contact, 120) || null, str(b.phone, 60) || null, str(b.email, 200) || null, str(b.notes, 2000) || null, b.active !== false];
  const id = Number(b.id) || 0;
  if (id) {
    const r = await q('UPDATE fin_party SET kind=$2, name=$3, specialty=$4, contact=$5, phone=$6, email=$7, notes=$8, active=$9, updated_by=$10, updated_at=now() WHERE id=$1 RETURNING id', [id, ...v, user.email]);
    if (!r[0]) throw { status: 404, message: 'Intervenant introuvable.' };
    return { ok: true, id };
  }
  const r = await q('INSERT INTO fin_party (kind, name, specialty, contact, phone, email, notes, active, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id', [...v, user.email]);
  return { ok: true, id: r[0].id };
}
async function remove(b) { await ensure(); await q('DELETE FROM fin_party WHERE id = $1', [Number(b.id) || 0]); return { ok: true }; }
module.exports = { list, save, remove, ensure, KINDS };
