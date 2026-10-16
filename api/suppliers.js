// api/suppliers.js
//
// Module « Fournisseurs » : fiches synchronisées depuis Avantage (FOURNI.DBF, via Exacto-Bridge, chaque heure)
// + couche de conformité gérée dans Finance (licence RBQ, assurance responsabilité, attestation Revenu Québec).
//   POST { action, ... }  authentifié par Clerk. Lecture : tout utilisateur connecté. Écriture : comptabilité + administrateurs.
// Les rappels automatiques sont DÉSACTIVÉS par défaut (voir réglages).

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const inv = require('./_lib/invoice');
const monday = require('./_lib/monday');
const rem = require('./_lib/supplier-reminders');

const TYPES = ['Sous-traitant', 'Fournisseur', 'Autres'];
const parties = require('./_lib/parties');
const dupes = require('./_lib/dupes');
const str = (v, n) => (v == null ? '' : String(v).trim().slice(0, n || 300));
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const isId = v => /^\d+$/.test(String(v || ''));
const stripZ = v => String(v || '').trim().replace(/^0+/, '');

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAccounting: user.isAdmin || acct.includes(user.email), isAdmin: !!user.isAdmin };
}
async function needAccounting(user) { const w = await who(user); if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' }; return w; }
async function needAdmin(user) { if (!user.isAdmin) throw { status: 403, message: "Réservé à l'administrateur." }; }

const COLS = `id, ext_id, avantage_id, monday_item_id, name, address, address2, city, province, postal_code, country, phone, phone_ext, phone2, fax, cell,
  contact_name, email, tps_no, tvq_no, default_gl, ap_name, ap_phone, ap_email, ord_name, ord_phone, ord_email, pay_name, pay_phone, pay_email, remark,
  to_char(last_purchase,'YYYY-MM-DD') AS last_purchase, avantage_inactive, in_avantage, to_char(synced_at,'YYYY-MM-DD HH24:MI') AS synced_at,
  supplier_type, category, blacklisted, notes, email_general, email_tender, email_accounting, contacts, payment_terms, rbq_number,
  to_char(liability_expiry,'YYYY-MM-DD') AS liability_expiry, to_char(rq_expiry,'YYYY-MM-DD') AS rq_expiry, auto_reminders`;

function view(s, lead) {
  const c = rem.compliance(s, lead);
  return Object.assign({}, s, { compliance: c });
}

const ACTIONS = {
  /** Liste (allégée) + état de conformité. */
  async list(user) {
    const w = await who(user);
    const settings = await rem.getSettings();
    const rows = await q(`SELECT ${COLS} FROM fin_supplier ORDER BY lower(name)`);
    const syncInfo = (await q("SELECT max(synced_at) AS at, count(*)::int AS n FROM fin_supplier WHERE avantage_id IS NOT NULL"))[0] || {};
    let syncRequested = null; try { const sr = await q("SELECT value FROM fin_settings WHERE key = 'avantage_sup_sync_request'"); syncRequested = (sr[0] && sr[0].value) || null; } catch (e) { /* facultatif */ }
    let lastRun = null; try { const lr = await q("SELECT value FROM fin_settings WHERE key = 'avantage_sup_last_run'"); lastRun = (lr[0] && lr[0].value) || null; } catch (e) { /* facultatif */ }
    const list = rows.map(s => {
      const v = view(s, settings.leadDays);
      return { id: s.id, extId: s.ext_id, avantageId: s.avantage_id, name: s.name, city: s.city, phone: s.phone, email: s.email_general || s.email || s.ap_email || '',
        type: s.supplier_type || '', category: s.category || '', blacklisted: s.blacklisted, inactive: s.avantage_inactive, inAvantage: s.in_avantage,
        rbq: s.rbq_number || '', liabilityExpiry: s.liability_expiry, rqExpiry: s.rq_expiry, autoReminders: s.auto_reminders,
        status: v.compliance.overall, assurance: v.compliance.assurance, rq: v.compliance.rq };
    });
    return { suppliers: list, canEdit: w.isAccounting, isAdmin: w.isAdmin, types: TYPES, settings,
      lastSync: syncInfo.at || null, lastRun, syncRequested, avantageCount: syncInfo.n || 0 };
  },

  async get(user, b) {
    const w = await who(user);
    const r = await q(`SELECT ${COLS} FROM fin_supplier WHERE id = $1`, [Number(b.id) || 0]);
    if (!r[0]) throw { status: 404, message: 'Fournisseur introuvable.' };
    const settings = await rem.getSettings();
    const hist = await q("SELECT kind, to_char(expiry,'YYYY-MM-DD') AS expiry, sent_to, mode, sent_by, to_char(sent_at,'YYYY-MM-DD HH24:MI') AS sent_at FROM fin_supplier_reminder WHERE supplier_id = $1 ORDER BY sent_at DESC LIMIT 30", [r[0].id]);
    return { supplier: view(r[0], settings.leadDays), reminders: hist, canEdit: w.isAccounting, types: TYPES };
  },

  /** Enregistre UNIQUEMENT les champs gérés dans Finance (jamais ceux d'Avantage). */
  async save(user, b) {
    await needAccounting(user);
    const id = Number(b.id) || 0;
    const cur = (await q('SELECT id FROM fin_supplier WHERE id = $1', [id]))[0];
    if (!cur) throw { status: 404, message: 'Fournisseur introuvable.' };
    const type = str(b.type, 40); if (type && !TYPES.includes(type) && type !== "Liste d'intervenants") throw { status: 400, message: 'Type invalide.' };
    const auto = ['oui', 'non', 'a_definir'].includes(b.autoReminders) ? b.autoReminders : 'a_definir';
    const contacts = (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 20).map(c => ({ name: str(c.name, 100), phone: str(c.phone, 40), email: str(c.email, 150) })).filter(c => c.name || c.phone || c.email);
    await q(`UPDATE fin_supplier SET supplier_type = $2, category = $3, blacklisted = $4, notes = $5, email_general = $6, email_tender = $7, email_accounting = $8,
        contacts = $9::jsonb, payment_terms = $10, rbq_number = $11, liability_expiry = $12, rq_expiry = $13, auto_reminders = $14, updated_at = now(), updated_by = $15 WHERE id = $1`,
      [id, type || null, str(b.category, 120) || null, b.blacklisted === true, str(b.notes, 4000) || null, str(b.emailGeneral, 150) || null, str(b.emailTender, 150) || null,
        str(b.emailAccounting, 150) || null, JSON.stringify(contacts), str(b.paymentTerms, 120) || null, str(b.rbqNumber, 60) || null,
        dateOrNull(b.liabilityExpiry), dateOrNull(b.rqExpiry), auto, user.email]);
    return { ok: true };
  },

  /** Fournisseur qui n'existe pas dans Avantage (ex. : intervenant). */
  async create(user, b) {
    await needAccounting(user);
    const name = str(b.name, 200); if (!name) throw { status: 400, message: 'Le nom est requis.' };
    if (!b.confirmDuplicate) { const m = await dupes.find(name); if (m.length) throw { status: 409, code: 'duplicate', matches: m, message: 'Un nom semblable existe déjà.' }; }
    const r = await q(`INSERT INTO fin_supplier (name, email, phone, supplier_type, in_avantage, updated_by) VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`,
      [name, str(b.email, 150) || null, str(b.phone, 40) || null, TYPES.includes(b.type) ? b.type : null, user.email]);
    await q("UPDATE fin_supplier SET ext_id = '9' || lpad(id::text, 12, '0') WHERE id = $1 AND ext_id IS NULL", [r[0].id]);
    return { ok: true, id: r[0].id };
  },

  /** Supprime une fiche NON Avantage. Si elle est utilisée (factures, BC…), exige mergeInto (fiche conservée) ou refuse. */
  async delete(user, b) {
    await needAccounting(user);
    const r = await q('SELECT id, name, ext_id, avantage_id FROM fin_supplier WHERE id = $1', [Number(b.id) || 0]);
    const s = r[0]; if (!s) throw { status: 404, message: 'Fournisseur introuvable.' };
    if (s.avantage_id) throw { status: 400, message: 'Cette fiche provient d\u2019Avantage : elle ne peut pas être supprimée ici (supprimez-la dans Avantage).' };
    const refs = await dupes.refCounts(s.ext_id), total = Object.values(refs).reduce((a, n) => a + n, 0);
    if (total) {
      const tid = Number(b.mergeInto) || 0;
      if (!tid || tid === s.id) throw { status: 409, code: 'in_use', refs, message: 'Cette fiche est utilisée (' + total + ' document(s)). Choisissez la fiche à conserver pour fusionner.' };
      const t = (await q('SELECT id, ext_id FROM fin_supplier WHERE id = $1', [tid]))[0]; if (!t || !t.ext_id) throw { status: 404, message: 'Fiche à conserver introuvable.' };
      await dupes.reassign(s.ext_id, t.ext_id);
    }
    await q('DELETE FROM fin_supplier WHERE id = $1', [s.id]);
    return { ok: true, merged: !!total };
  },

  /** Fiches pouvant recevoir une fusion (candidats similaires). */
  async dupCandidates(user, b) {
    await needAccounting(user);
    const s = (await q('SELECT id, name FROM fin_supplier WHERE id = $1', [Number(b.id) || 0]))[0]; if (!s) throw { status: 404, message: 'Introuvable.' };
    const m = (await dupes.find(s.name, { excludeSupplierId: s.id })).filter(x => x.source === 'supplier');
    return { candidates: m };
  },

  /** Demande une synchronisation immédiate : le pont la détecte dans la minute et resynchronise tout. */
  async requestSync(user) {
    await needAccounting(user);
    await q("INSERT INTO fin_settings (key, value, updated_by) VALUES ('avantage_sup_sync_request', $1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()", [new Date().toISOString(), user.email]);
    return { ok: true };
  },

  /** Liste d'intervenants (clients, maîtres de l'ouvrage, professionnels) — lecture : tout utilisateur connecté. */
  async partyList(user) { const w = await who(user); return { parties: await parties.list(true), canEdit: w.isAccounting }; },
  async partySave(user, b) {
    await needAccounting(user);
    const name = str(b.name, 200);
    if (name && !b.confirmDuplicate) { const m = await dupes.find(name, { excludePartyId: Number(b.id) || 0 }); if (m.length && !(Number(b.id) && m.every(x => x.source === 'supplier'))) throw { status: 409, code: 'duplicate', matches: m, message: 'Un nom semblable existe déjà.' }; }
    return parties.save(user, b);
  },
  async partyDelete(user, b) { await needAccounting(user); return parties.remove(b); },

  async getSettings(user) { await who(user); return { settings: await rem.getSettings() }; },
  async saveSettings(user, b) { await needAdmin(user); return { settings: await rem.saveSettings(b.settings || {}, user.email) }; },

  /** Qui recevrait un rappel automatique maintenant (aucun envoi). */
  async remindersPreview(user) {
    await needAccounting(user);
    const settings = await rem.getSettings();
    const list = await rem.candidates(settings);
    return { settings, items: list.map(c => ({ id: c.s.id, name: c.s.name, kind: c.kind, label: rem.KINDS[c.kind].label, expiry: c.expiry, days: c.days, recipients: c.recipients })) };
  },

  /** Rappel envoyé manuellement (fonctionne même si les rappels automatiques sont désactivés). */
  async sendReminder(user, b) {
    await needAccounting(user);
    const r = await q(rem.SEL + ' WHERE id = $1', [Number(b.id) || 0]);
    if (!r[0]) throw { status: 404, message: 'Fournisseur introuvable.' };
    const settings = await rem.getSettings();
    const to = await rem.sendOne(r[0], b.kind, 'manuel', user.email, settings, user.email);
    return { ok: true, to };
  },

  /** Active / désactive les rappels automatiques pour une sélection de fournisseurs. */
  async bulkAuto(user, b) {
    await needAccounting(user);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 2000);
    const v = ['oui', 'non', 'a_definir'].includes(b.value) ? b.value : null;
    if (!ids.length || !v) throw { status: 400, message: 'Sélection invalide.' };
    await q('UPDATE fin_supplier SET auto_reminders = $2, updated_at = now(), updated_by = $3 WHERE id = ANY($1::bigint[])', [ids, v, user.email]);
    return { ok: true, count: ids.length };
  },

  /** Importe la conformité et les champs gérés depuis le board Monday (une seule fois ; relançable). */
  async importMonday(user, b) {
    await needAdmin(user);
    const full = await monday.fetchSuppliersFull();
    const titles = full.columns.map(c => ({ id: c.id, title: c.title, type: c.type }));
    const find = re => { const c = full.columns.find(x => re.test(x.title) && !/preuve|fichier|file|document/i.test(x.title)); return c ? c.id : ''; };
    const guess = {
      rbq: find(/rbq/i),
      liability: find(/(assurance|responsabilit).*(exp|date|éch|ech)|(exp|date|éch|ech).*(assurance|responsabilit)/i),
      rq: find(/(revenu|attestation|\brq\b).*(exp|date|éch|ech)|(exp|date|éch|ech).*(revenu|attestation|\brq\b)/i),
      category: find(/cat[ée]gorie|sp[ée]cialit|corps/i),
      notes: find(/notes?|commentaire|remarque/i)
    };
    const map = Object.assign({}, guess, b.mapping || {});
    if (b.dryRun !== false) return { dryRun: true, columns: titles, mapping: map, items: full.items.length };

    const pick = (it, id) => (id ? it.byId[id] || '' : '');
    const toDate = v => { const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : null; };
    const existing = await q('SELECT id, avantage_id, monday_item_id, contacts FROM fin_supplier');
    const byAv = new Map(), byMon = new Map(), curContacts = new Map();
    existing.forEach(r => { if (r.avantage_id) byAv.set(stripZ(r.avantage_id), r.id); if (r.monday_item_id) byMon.set(String(r.monday_item_id), r.id); let c = r.contacts; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = []; } } curContacts.set(r.id, Array.isArray(c) ? c : []); });
    const digitsOf = v => String(v || '').replace(/\D/g, '');
    const MC = { main: ['texte_mkmxfscy', 't_l_phone_mkmxmmjr', ''], c1: ['text_mkq958fs', 'phone_mktrz3eq', 'email_mktrpxw3'], c2: ['text_mktrfzv2', 'phone_mktrzej', 'email_mktrdhhg'], c3: ['text_mktry28s', 'phone_mktr86w0', 'email_mktrna9x'] };
    let contactsAdded = 0;
    let matched = 0, created = 0;
    for (const it of full.items) {
      const avId = stripZ(it.byId[monday.SC.avantageId]);
      const type = it.byId[monday.SC.type] || '';
      const vals = {
        type: TYPES.includes(type) ? type : null,
        blacklisted: it.byId[monday.SC.blacklist] === 'Blacklist',
        inactive: it.byId[monday.SC.active] === 'Inactif',
        eg: it.byId[monday.SC.emailGeneral] || null, et: it.byId[monday.SC.emailContact1] || null, ea: it.byId[monday.SC.emailCompta] || null,
        rbq: pick(it, map.rbq) || null, li: toDate(pick(it, map.liability)), rq: toDate(pick(it, map.rq)),
        cat: pick(it, map.category) || null, notes: pick(it, map.notes) || null,
        tender: it.byId.e_mail__1 || null, companyPhone: it.byId[monday.SC.phone] || null, mainContact: it.byId[monday.SC.contact] || null
      };
      // Contacts du board Monday (contact principal + contacts #1 à #3) -> liste de contacts du fournisseur
      const imported = Object.values(MC).map(([n, p, e]) => ({ name: (it.byId[n] || '').slice(0, 100), phone: (it.byId[p] || '').slice(0, 40), email: (e ? it.byId[e] || '' : '').toLowerCase().slice(0, 150) }))
        .filter(c => (c.email && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c.email)) || c.phone).map(c => ({ name: c.name, phone: c.phone, email: /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c.email) ? c.email : '' }));
      const mergeContacts = cur => { const out = (cur || []).slice(); imported.forEach(c => { const dup = out.find(x => (c.email && String(x.email || '').toLowerCase() === c.email) || (!c.email && digitsOf(x.phone) && digitsOf(x.phone) === digitsOf(c.phone))); if (dup) { if (!dup.name && c.name) dup.name = c.name; if (!dup.phone && c.phone) dup.phone = c.phone; if (!dup.email && c.email) dup.email = c.email; } else { out.push(c); contactsAdded++; } }); return out.slice(0, 30); };
      let id = byMon.get(String(it.id)) || (avId && byAv.get(avId)) || null;
      if (id) {
        await q(`UPDATE fin_supplier SET monday_item_id = $2, ext_id = $2, supplier_type = COALESCE($3, supplier_type), blacklisted = $4,
            email_general = COALESCE($5, email_general), email_tender = COALESCE($6, email_tender), email_accounting = COALESCE($7, email_accounting),
            rbq_number = COALESCE($8, rbq_number), liability_expiry = COALESCE($9::date, liability_expiry), rq_expiry = COALESCE($10::date, rq_expiry),
            category = COALESCE($11, category), notes = COALESCE($12, notes), updated_by = $13, updated_at = now(),
            phone = COALESCE(NULLIF(phone, ''), $14), contact_name = COALESCE(NULLIF(contact_name, ''), $15), contacts = $16::jsonb WHERE id = $1`,
          [id, String(it.id), vals.type, vals.blacklisted, vals.eg, vals.tender, vals.ea, vals.rbq, vals.li, vals.rq, vals.cat, vals.notes, user.email + ' (import Monday)',
            vals.companyPhone, vals.mainContact, JSON.stringify(mergeContacts(curContacts.get(id)))]);
        matched++;
      } else {
        await q(`INSERT INTO fin_supplier (ext_id, monday_item_id, name, avantage_inactive, in_avantage, supplier_type, blacklisted, email_general, email_tender, email_accounting,
            rbq_number, liability_expiry, rq_expiry, category, notes, phone, updated_by, contact_name, contacts)
            VALUES ($1,$1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17::jsonb)
            ON CONFLICT (ext_id) DO NOTHING`,
          [String(it.id), it.name, vals.inactive, vals.type, vals.blacklisted, vals.eg, vals.tender, vals.ea, vals.rbq, vals.li, vals.rq, vals.cat, vals.notes,
            vals.companyPhone, user.email + ' (import Monday)', vals.mainContact, JSON.stringify(mergeContacts([]))]);
        created++;
      }
    }
    return { dryRun: false, items: full.items.length, matched, created, contactsAdded, mapping: map };
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
  let user;
  try { user = await requireUser(req); }
  catch (e) { res.status(e.status || 401).json({ error: e.message || 'Non authentifié.' }); return; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fn = ACTIONS[body.action];
  if (!fn) { res.status(400).json({ error: 'Action inconnue.' }); return; }
  try { res.status(200).json(await fn(user, body, req)); }
  catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('suppliers.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.', code: e && e.code, matches: e && e.matches, refs: e && e.refs });
  }
};
module.exports.ACTIONS = ACTIONS;
