// api/_lib/supplier-contacts.js — liste de contacts par fournisseur (courriel + téléphone saisis sur les bons de commande).
// Stockée dans fin_supplier.contacts ([{name, phone, email}]), la même liste que celle de la page « Fournisseurs ».
// S'y ajoutent, en suggestions NON supprimables, les contacts venant d'Avantage (contact principal, comptes payables, commandes).

const { q } = require('./db');

const MAX = 30;
const digits = s => String(s || '').replace(/\D/g, '');
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 200);
const stripZ = v => String(v || '').trim().replace(/^0+/, '');
const cid = c => String(c.email || '').trim().toLowerCase() + '|' + digits(c.phone);
const validEmail = e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);

const SEL = 'SELECT id, contacts, name, phone, email, contact_name, ap_name, ap_phone, ap_email, ord_name, ord_phone, ord_email FROM fin_supplier';

/** Retrouve (ou crée) la fiche fournisseur Finance correspondant à un fournisseur { id, name, avantageId }. */
async function resolveRow(sup) {
  let r = await q(SEL + ' WHERE ext_id = $1', [String(sup.id)]);
  if (!r[0] && sup.avantageId) r = await q(SEL + " WHERE ltrim(avantage_id, '0') = $1", [stripZ(sup.avantageId)]);
  if (!r[0]) {
    await q('INSERT INTO fin_supplier (ext_id, monday_item_id, name, in_avantage) VALUES ($1, $1, $2, TRUE) ON CONFLICT (ext_id) DO NOTHING', [String(sup.id), clean(sup.name, 200) || 'Fournisseur']);
    r = await q(SEL + ' WHERE ext_id = $1', [String(sup.id)]);
  }
  if (!r[0]) throw { status: 404, message: 'Fournisseur introuvable.' };
  return r[0];
}
function saved(row) {
  let c = row.contacts; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = []; } }
  return (Array.isArray(c) ? c : []).filter(x => x && (x.email || x.phone)).map(x => ({ name: clean(x.name, 100), email: clean(x.email, 150), phone: clean(x.phone, 40) }));
}

/** Liste affichée au chargé de projet : contacts enregistrés (modifiables) puis suggestions d'Avantage. */
async function list(sup) {
  const row = await resolveRow(sup);
  const out = saved(row).map(c => Object.assign({ id: cid(c), source: 'saved' }, c));
  const seen = new Set(out.map(c => c.id));
  const seenMail = new Set(out.map(c => c.email.toLowerCase()).filter(Boolean));
  [[row.contact_name, row.email, row.phone], [row.ap_name, row.ap_email, row.ap_phone], [row.ord_name, row.ord_email, row.ord_phone]].forEach(([name, email, phone]) => {
    const c = { name: clean(name, 100), email: clean(email, 150).toLowerCase(), phone: clean(phone, 40) };
    if (!c.email && !c.phone) return;
    const id = cid(c); if (seen.has(id) || (c.email && seenMail.has(c.email))) return;
    seen.add(id); if (c.email) seenMail.add(c.email);
    out.push(Object.assign({ id, source: 'avantage' }, c));
  });
  return out;
}

/** Ajoute le contact saisi sur un bon de commande (ou le met à jour / le remonte en tête de liste). */
async function remember(sup, c) {
  const email = clean(c.email, 150).toLowerCase(), phone = clean(c.phone, 40), name = clean(c.name, 100);
  if (!email && !phone) return { saved: false };
  if (email && !validEmail(email)) return { saved: false };
  const row = await resolveRow(sup);
  const arr = saved(row);
  let i = email ? arr.findIndex(x => x.email.toLowerCase() === email) : arr.findIndex(x => !x.email && digits(x.phone) === digits(phone));
  let item;
  if (i >= 0) { item = Object.assign({}, arr[i], { phone: phone || arr[i].phone, name: name || arr[i].name }); arr.splice(i, 1); }
  else item = { name, email, phone };
  arr.unshift(item);                       // le plus récemment utilisé en premier
  await q('UPDATE fin_supplier SET contacts = $2::jsonb, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(arr.slice(0, MAX))]);
  return { saved: true };
}

/** Retire un contact enregistré (ex. n'est plus à l'emploi du fournisseur). Les suggestions d'Avantage ne se retirent pas. */
async function remove(sup, id) {
  const row = await resolveRow(sup);
  const arr = saved(row), next = arr.filter(c => cid(c) !== String(id));
  if (next.length === arr.length) throw { status: 404, message: 'Contact introuvable (ou venant d’Avantage : non supprimable ici).' };
  await q('UPDATE fin_supplier SET contacts = $2::jsonb, updated_at = now() WHERE id = $1', [row.id, JSON.stringify(next)]);
  return { ok: true };
}

module.exports = { list, remember, remove, cid };
