// api/qrt.js
//
// Module « Questions et réponses techniques (QRT) ».
//   POST { action, ... }  authentifié par Clerk. Accès : comptabilité + admins (tous les projets) ; chargé de projet (ses projets).
//
// Cycle : brouillon -> chez_pro (formulaire PDF envoyé au professionnel) -> repondu (PDF rempli déposé; copie SharePoint)
//         -> retourne (réponse renvoyée au sous-traitant).   annule = abandonné.
// Numéro : QRT-<lettre de discipline du professionnel>-<séquence> (compteur par projet et par discipline).

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const sp = require('./_lib/sharepoint');
const dash = require('./dashboard');
const qrtpdf = require('./_lib/qrtpdf');
const mx = require('./_lib/mailx');

const { str, cleanEmails, ccFor, fileSafe } = mx;
const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const CHUNK_B64 = 2097152;
const MAX_FILE = 20 * 1024 * 1024;
const mailLimit = () => (Number(process.env.QRT_MAIL_LIMIT_MB) || 15) * 1024 * 1024;
const DISCIPLINES = { A: 'Architecture', P: 'Architecture de paysage', M: 'Ing Mécanique', E: 'Ing Électrique', C: 'Ing Civil', S: 'Ing Structure', H: 'Hygiène', L: 'LEED', X: 'Autre' };
const DRAFTY = ['brouillon', 'revision'];            // « Révision avant envoi » (préparée par courriel) se comporte comme un brouillon
const YN = ['oui', 'non', 'a_determiner'];
const PARTY_KEYS = ['ENTREPRENEUR', "MAÎTRE DE L'OUVRAGE", 'ARCHITECTE', 'MÉCANIQUE', 'STRUCTURE', 'CIVIL', 'ÉLECTRICITÉ', 'CLIENT'];
const PARTY_SPEC = { ARCHITECTE: ['architecture'], 'MÉCANIQUE': ['mecanique'], STRUCTURE: ['structure'], CIVIL: ['civil'], 'ÉLECTRICITÉ': ['electrique', 'electricite'] };

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const spName = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').trim();
const fmtD = d => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '';
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
/** Plus petit numéro libre de la série (projet + discipline) : un numéro d'une QRT supprimée redevient disponible. */
async function nextSeq(projectId, disc) {
  const rows = await q('SELECT seq FROM fin_qrt WHERE project_item_id = $1 AND discipline = $2 ORDER BY seq', [projectId, disc]);
  const used = new Set(rows.map(r => Number(r.seq)));
  let n = 1; while (used.has(n)) n++;
  return n;
}
const refOf = (d, seq) => 'QRT-' + d + '-' + String(seq).padStart(2, '0');

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAccounting: user.isAdmin || acct.includes(user.email) };
}
async function projectAccess(user, projectItemId) {
  if (!isId(projectItemId)) throw { status: 400, message: 'Projet invalide.' };
  const w = await who(user);
  const project = await monday.fetchProject(projectItemId);
  const isCp = project.cp.some(c => (c.email || '').toLowerCase() === user.email);
  if (!w.isAccounting && !isCp) throw { status: 403, message: "Vous n'avez pas accès à ce projet." };
  return { project, isAccounting: w.isAccounting, isCp };
}
async function loadQrt(user, id) {
  if (!isUuid(id)) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_qrt WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'QRT introuvable.' };
  const ctx = await projectAccess(user, rows[0].project_item_id);
  return Object.assign({ qrt: rows[0] }, ctx);
}
async function logEvent(id, event, actor, detail) {
  await q('INSERT INTO fin_qrt_event (qrt_id, event, actor, detail) VALUES ($1,$2,$3,$4)', [id, event, actor || null, detail ? String(detail).slice(0, 4000) : null]);
}
async function latestFile(id, kind) {
  const r = await q('SELECT id, filename, data_b64, rev, created_at FROM fin_qrt_file WHERE qrt_id = $1 AND kind = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [id, kind]);
  return r[0] ? { id: r[0].id, filename: r[0].filename, bytes: Buffer.from(r[0].data_b64, 'base64'), rev: r[0].rev } : null;
}
async function allFiles(id, kind) {
  const r = await q('SELECT id, filename, data_b64 FROM fin_qrt_file WHERE qrt_id = $1 AND kind = $2 ORDER BY created_at, id', [id, kind]);
  return r.map(x => ({ id: x.id, filename: x.filename, bytes: Buffer.from(x.data_b64, 'base64') }));
}
async function storeFile(id, kind, rev, filename, bytes, by) {
  const buf = Buffer.from(bytes);
  const r = await q('INSERT INTO fin_qrt_file (qrt_id, kind, rev, filename, size_bytes, data_b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [id, kind, rev, filename, buf.length, buf.toString('base64'), by || null]);
  return r[0].id;
}
function rowOut(r) {
  const o = Object.assign({}, r);
  o.qrt_date = fmtD(r.qrt_date) || null;
  o.deleted = !!r.deleted_at;
  return o;
}
const COLS = `id, project_item_id, project_number, project_name, discipline, seq, ref, qrt_date, object, impact_schedule, impact_budget, directive, requester_name, requester_email,
  question, parties, supplier_item_id, supplier_name, supplier_contact, supplier_email, pro_company, pro_name, pro_email, status, sent_pro_at, reminders, last_reminder_at,
  answered_at, returned_at, sharepoint_status, sharepoint_url, sharepoint_error, deleted_at, source, ai_notes, email_from`;

/** Intervenants par défaut du projet (pour préremplir le tableau des parties) + professionnels + sous-traitants. */
async function projectParties(project) {
  let iv = { pros: [], subs: [], owner: {} };
  try { iv = await dash.buildInterv(project) || iv; } catch (e) { /* facultatif */ }
  const ownerName = (iv.owner && iv.owner.name) || (project.owner && project.owner.name) || '';
  const pros = (iv.pros || []).map(p => ({ company: p.company || '', name: p.contact || '', email: String(p.email || '').trim().toLowerCase(), specialty: p.specialty || '' }));
  const byKey = k => {
    const keys = PARTY_SPEC[k] || [];
    const p = pros.find(x => keys.some(s => norm(x.specialty).indexOf(s) >= 0));
    return p ? p.company : '';
  };
  const parties = PARTY_KEYS.map(k => {
    let v = '';
    if (k === 'ENTREPRENEUR') v = 'Les Entreprises Philippe Denis inc.';
    else if (k === "MAÎTRE DE L'OUVRAGE" || k === 'CLIENT') v = ownerName;
    else v = byKey(k);
    return { k, v };
  });
  const subs = (iv.subs || []).map(s => ({ id: s.id || '', name: s.company || '', contact: s.contact || '', email: String(s.email || '').trim().toLowerCase() }));
  return { parties, pros, subs, ownerName };
}
function cleanParties(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 16).map(p => ({ k: str(p && p.k, 40), v: str(p && p.v, 200) })).filter(p => p.k);
}
const pdfInput = r => ({ ref: r.ref, qrt_date: fmtD(r.qrt_date) || today(), object: r.object, impact_schedule: r.impact_schedule, impact_budget: r.impact_budget, directive: r.directive,
  requester_name: r.requester_name, requester_email: r.requester_email, question: r.question, parties: r.parties || [], pro_company: r.pro_company, pro_name: r.pro_name, pro_email: r.pro_email });
const projOf = r => ({ number: r.project_number, name: r.project_name });

// ---------- SharePoint -------------------------------------------------------------------------------------

async function pushToSharePoint(qr) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_qrt SET sharepoint_status = 'non_configure', sharepoint_error = NULL, updated_at = now() WHERE id = $1", [qr.id]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_qrt SET sharepoint_status = 'attente', sharepoint_error = NULL WHERE id = $1", [qr.id]);
  try {
    const f = await latestFile(qr.id, 'response');
    if (!f) throw new Error('PDF de réponse introuvable.');
    const name = qr.ref + ' - ' + (spName(String(qr.object || '').replace(/[._-]+/g, ' ')).slice(0, 60).trim() || 'QRT') + '.pdf';
    const out = await sp.uploadQrt(qr, f.bytes, name);
    await q("UPDATE fin_qrt SET sharepoint_status = 'reussi', sharepoint_url = $2, sharepoint_error = NULL, updated_at = now() WHERE id = $1", [qr.id, (out && out.webUrl) || null]);
    await logEvent(qr.id, 'sharepoint_ok', 'systeme', out && out.path);
    return { status: 'reussi', url: out && out.webUrl, path: out && out.path };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_qrt SET sharepoint_status = 'echec', sharepoint_error = $2, updated_at = now() WHERE id = $1", [qr.id, msg]);
    await logEvent(qr.id, 'sharepoint_echec', 'systeme', msg);
    return { status: 'echec', error: msg };
  }
}

// ---------- Actions ---------------------------------------------------------------------------------------

function distinctProjects(rows) {
  const m = new Map();
  rows.forEach(r => { if (r.project_item_id && !m.has(r.project_item_id)) m.set(r.project_item_id, { id: String(r.project_item_id), number: r.project_number, name: r.project_name || '' }); });
  return Array.from(m.values());
}

const ACTIONS = {
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }, disciplines: DISCIPLINES,
      projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name) })) };
  },

  /** Toutes les QRT (non supprimées) des projets accessibles : vue « tous les projets ». */
  async listAll(user) {
    const w = await who(user);
    // Comptabilité/admin : tout est lu dans Neon (aucun appel à Monday => affichage rapide). Chargé de projet : ses projets selon Monday.
    const mine = w.isAccounting ? null : (await monday.fetchProjectsLite(false)).filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    const ids = mine ? mine.map(p => String(p.id)) : [];
    const all = !mine;
    const rows = (all || ids.length) ? await q(`SELECT ${COLS} FROM fin_qrt WHERE ($2::boolean OR project_item_id = ANY($1::text[])) AND deleted_at IS NULL ORDER BY project_number, discipline, seq`, [ids, all]) : [];
    return { projects: mine ? mine.map(p => ({ id: String(p.id), number: p.number, name: p.name })) : distinctProjects(rows), items: rows.map(rowOut) };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT ${COLS}, (SELECT count(*)::int FROM fin_qrt_file f WHERE f.qrt_id = fin_qrt.id AND f.kind = 'attachment') AS n_att,
        (SELECT count(*)::int FROM fin_qrt_file f WHERE f.qrt_id = fin_qrt.id AND f.kind = 'response') AS n_resp
        FROM fin_qrt WHERE project_item_id = $1 ORDER BY discipline, seq`, [project.id]);
    return { project: { id: project.id, number: project.number, name: project.name }, items: rows.map(rowOut), sharepointConfigured: sp.isConfigured() };
  },

  /** Tableau sommaire PDF de l'avancement des QRT (à transmettre aux professionnels et au client). */
  async summary(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT ref, discipline, seq, qrt_date, object, pro_company, impact_schedule, impact_budget, status, sent_pro_at, answered_at, returned_at, legacy
        FROM fin_qrt WHERE project_item_id = $1 AND deleted_at IS NULL AND status NOT IN ('brouillon','revision','annule') ORDER BY discipline, seq`, [project.id]);
    if (!rows.length) throw { status: 400, message: "Aucune QRT envoyée à inclure dans le sommaire." };
    const ST = { chez_pro: 'En attente du professionnel', repondu: 'Réponse reçue', retourne: 'Réponse reçue et retournée' };
    const YNL = { oui: 'Oui', non: 'Non', a_determiner: 'À déterminer' };
    const items = rows.map(r => ({ ref: r.ref, object: r.object, pro: r.pro_company || '', qrt_date: fmtD(r.qrt_date), sent: fmtD(r.sent_pro_at), answered: fmtD(r.answered_at || r.returned_at),
      impact: [r.impact_schedule ? 'Horaire : ' + (YNL[r.impact_schedule] || r.impact_schedule) : '', r.impact_budget ? 'Budget : ' + (YNL[r.impact_budget] || r.impact_budget) : ''].filter(Boolean).join(' / '),
      status: r.status, statusTxt: (r.legacy && r.status !== 'chez_pro') ? 'Traitée' : (ST[r.status] || r.status), discipline: r.discipline }));
    items.forEach(i => { i.st = i.statusTxt; });
    const done = items.filter(i => i.status !== 'chez_pro').length;
    const order = Object.keys(DISCIPLINES);
    const groups = order.map(d => ({ name: DISCIPLINES[d], items: items.filter(i => i.discipline === d).map(i => Object.assign({}, i, { status: i.status })) })).filter(g => g.items.length);
    const bytes = await require('./_lib/sumpdf').buildGenericSummary({
      docTitle: 'Sommaire QRT', titleLines: ['Sommaire des questions et', 'réponses techniques (QRT)'], project: { number: project.number, name: project.name },
      headline: 'Avancement global : ' + done + ' réponse' + (done > 1 ? 's' : '') + ' reçue' + (done > 1 ? 's' : '') + ' sur ' + items.length + ' QRT (' + Math.round(done * 100 / items.length) + ' %)',
      subline: 'En attente du professionnel : ' + (items.length - done) + '   |   Réponses reçues : ' + done,
      groups: groups.map(g => ({ name: g.name, items: g.items.map(i => Object.assign({}, i, { status: i.status, st: i.st })) })),
      cols: [{ k: 'ref', t: 'Réf.', w: 60, bold: true }, { k: 'object', t: 'Objet', w: 140 }, { k: 'pro', t: 'Professionnel', w: 80 }, { k: 'qrt_date', t: 'Date', w: 62, date: true }, { k: 'sent', t: 'Envoyée', w: 62, date: true }, { k: 'answered', t: 'Réponse', w: 62, date: true }, { k: 'impact', t: 'Impacts', w: 70 }, { k: 'st', t: 'Statut', w: 72, status: true }],
      statusKey: 'status', good: ['repondu', 'retourne'], bad: [], emptyText: 'Aucune QRT.' });
    return { pdfBase64: Buffer.from(bytes).toString('base64'), filename: 'Sommaire QRT - ' + fileSafe(project.number) + '.pdf' };
  },

  /** Valeurs par défaut pour une nouvelle QRT : parties, professionnels, sous-traitants, demandeur. */
  async defaults(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const d = await projectParties(project);
    return { parties: d.parties, pros: d.pros, subs: d.subs, disciplines: DISCIPLINES, requester: { name: user.name || '', email: user.email }, cc: ccFor(user, project, [], []) };
  },

  /** Création / modification. Brouillon : tous les champs; sinon seulement les infos du sous-traitant. */
  async save(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const object = str(b.object, 300);
    const supplierVals = [isId(b.supplierItemId) ? String(b.supplierItemId) : null, str(b.supplierName, 200) || null, str(b.supplierContact, 120) || null, str(b.supplierEmail, 200).toLowerCase() || null];
    if (supplierVals[3] && !po.isEmail(supplierVals[3])) throw { status: 400, message: 'Courriel invalide : ' + supplierVals[3] };
    if (b.id) {
      if (!isUuid(b.id)) throw { status: 400, message: 'Identifiant invalide.' };
      const cur = (await q('SELECT * FROM fin_qrt WHERE id = $1 AND project_item_id = $2', [b.id, project.id]))[0];
      if (!cur) throw { status: 404, message: 'QRT introuvable.' };
      if (!DRAFTY.includes(cur.status)) {
        await q('UPDATE fin_qrt SET supplier_item_id=$2, supplier_name=$3, supplier_contact=$4, supplier_email=$5, updated_by=$6, updated_at=now() WHERE id=$1', [cur.id].concat(supplierVals, [user.email]));
        await logEvent(cur.id, 'modifie', user.email, 'sous-traitant');
        return { ok: true, id: cur.id, ref: cur.ref };
      }
    }
    if (!object) throw { status: 400, message: "L'objet de la QRT est obligatoire." };
    const disc = DISCIPLINES[b.discipline] ? b.discipline : 'A';
    const vals = {
      qrt_date: dateOrNull(b.qrtDate) || today(), object,
      impact_schedule: YN.includes(b.impactSchedule) ? b.impactSchedule : 'a_determiner',
      impact_budget: YN.includes(b.impactBudget) ? b.impactBudget : 'a_determiner',
      directive: YN.includes(b.directive) ? b.directive : 'a_determiner',
      requester_name: str(b.requesterName, 120) || user.name || null, requester_email: str(b.requesterEmail, 200).toLowerCase() || user.email,
      question: String(b.question || '').replace(/\r/g, '').slice(0, 8000),
      parties: JSON.stringify(cleanParties(b.parties)),
      pro_company: str(b.proCompany, 200) || null, pro_name: str(b.proName, 120) || null, pro_email: str(b.proEmail, 200).toLowerCase() || null
    };
    if (vals.requester_email && !po.isEmail(vals.requester_email)) throw { status: 400, message: 'Courriel invalide : ' + vals.requester_email };
    if (vals.pro_email && !po.isEmail(vals.pro_email)) throw { status: 400, message: 'Courriel invalide : ' + vals.pro_email };
    if (b.id) {
      const cur = (await q('SELECT * FROM fin_qrt WHERE id = $1', [b.id]))[0];
      let ref = cur.ref, seq = cur.seq;
      if (disc !== cur.discipline) {                                   // changement de discipline : nouveau numéro dans la nouvelle série
        for (let t = 0; t < 4; t++) {
          seq = await nextSeq(project.id, disc); ref = refOf(disc, seq);
          try {
            await q('UPDATE fin_qrt SET discipline=$2, seq=$3, ref=$4 WHERE id=$1', [cur.id, disc, seq, ref]); break;
          } catch (e) { if (!/duplicate|unique/i.test(String(e && e.message)) || t === 3) throw e; }
        }
      }
      await q(`UPDATE fin_qrt SET qrt_date=$2, object=$3, impact_schedule=$4, impact_budget=$5, directive=$6, requester_name=$7, requester_email=$8, question=$9, parties=$10::jsonb,
          pro_company=$11, pro_name=$12, pro_email=$13, supplier_item_id=$14, supplier_name=$15, supplier_contact=$16, supplier_email=$17, updated_by=$18, updated_at=now() WHERE id=$1`,
        [cur.id, vals.qrt_date, vals.object, vals.impact_schedule, vals.impact_budget, vals.directive, vals.requester_name, vals.requester_email, vals.question, vals.parties,
          vals.pro_company, vals.pro_name, vals.pro_email].concat(supplierVals, [user.email]));
      await logEvent(cur.id, 'modifie', user.email, null);
      return { ok: true, id: cur.id, ref };
    }
    let id = null, ref = null;
    for (let t = 0; t < 4 && !id; t++) {
      const seq = await nextSeq(project.id, disc); ref = refOf(disc, seq);
      try {
        const ins = await q(`INSERT INTO fin_qrt (project_item_id, project_number, project_name, discipline, seq, ref, qrt_date, object, impact_schedule, impact_budget, directive,
            requester_name, requester_email, question, parties, pro_company, pro_name, pro_email, supplier_item_id, supplier_name, supplier_contact, supplier_email, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$23) RETURNING id`,
          [project.id, project.number, project.name, disc, seq, ref, vals.qrt_date, vals.object, vals.impact_schedule, vals.impact_budget, vals.directive, vals.requester_name,
            vals.requester_email, vals.question, vals.parties, vals.pro_company, vals.pro_name, vals.pro_email].concat(supplierVals, [user.email]));
        id = ins[0].id;
      } catch (e) { if (!/duplicate|unique/i.test(String(e && e.message))) throw e; }
    }
    if (!id) throw { status: 409, message: 'Impossible de réserver un numéro. Réessayez.' };
    await logEvent(id, 'cree', user.email, ref);
    return { ok: true, id, ref };
  },

  /** Demandes reçues par courriel qui n'ont pas (encore) donné de QRT : en attente de précisions ou à traiter manuellement. */
  inboxList: (user) => require('./_lib/coordo').INBOX.inboxList(user, { kind: 'qrt' }),
  inboxGet: (user, b) => require('./_lib/coordo').INBOX.inboxGet(user, b),
  inboxDismiss: (user, b) => require('./_lib/coordo').INBOX.inboxDismiss(user, b),

  /** Supprime une QRT. Tant que le professionnel n'a pas répondu : suppression définitive (le numéro redevient disponible). Sinon : corbeille. */
  async deleteItem(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    if (['brouillon', 'revision', 'chez_pro', 'annule'].includes(qrt.status)) {
      await q('DELETE FROM fin_qrt WHERE id = $1', [qrt.id]);       // fichiers et événements supprimés en cascade
      return { ok: true, hard: true, ref: qrt.ref };
    }
    await q('UPDATE fin_qrt SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1', [qrt.id, user.email]);
    await logEvent(qrt.id, 'supprime', user.email, qrt.status);
    return { ok: true, ref: qrt.ref };
  },
  async restoreItem(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    await q('UPDATE fin_qrt SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1', [qrt.id]);
    await logEvent(qrt.id, 'restaure', user.email, null);
    return { ok: true };
  },
  /** Annule (abandonne) une QRT : conservée dans la liste avec le statut « Annulée ». */
  async cancel(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    await q("UPDATE fin_qrt SET status = 'annule', updated_by = $2, updated_at = now() WHERE id = $1", [qrt.id, user.email]);
    await logEvent(qrt.id, 'annule', user.email, null);
    return { ok: true };
  },

  async get(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    const [files, events] = await Promise.all([
      q('SELECT id, kind, rev, filename, size_bytes, uploaded_by, created_at FROM fin_qrt_file WHERE qrt_id = $1 ORDER BY created_at, id', [qrt.id]),
      q('SELECT event, actor, detail, at FROM fin_qrt_event WHERE qrt_id = $1 ORDER BY at DESC, id DESC LIMIT 100', [qrt.id])
    ]);
    let origin = null;
    if (qrt.inbox_id) {
      const ib = (await q('SELECT subject, body, from_email, from_name, thread, received_at FROM fin_qrt_inbox WHERE id = $1', [qrt.inbox_id]))[0];
      if (ib) origin = { subject: ib.subject, from: ib.from_name ? ib.from_name + ' <' + ib.from_email + '>' : ib.from_email, body: String(ib.body || '').slice(0, 8000), thread: String(ib.thread || '').slice(0, 4000), receivedAt: ib.received_at };
    }
    return { item: rowOut(qrt), files, events, origin };
  },

  /** Aperçu du formulaire PDF (ne modifie rien). */
  async preview(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    const atts = await allFiles(qrt.id, 'attachment'), rep = {};
    const bytes = await qrtpdf.buildQrt(projOf(qrt), pdfInput(qrt), atts, rep);
    return { merged: rep.merged || [], skipped: rep.skipped || [], pdfBase64: Buffer.from(bytes).toString('base64'), filename: fileSafe(qrt.ref + '.pdf') };
  },

  /** Envoi du formulaire PDF (+ pièces jointes du sous-traitant) au professionnel. */
  async sendToPro(user, b) {
    const { qrt, project } = await loadQrt(user, b.id);
    if (!['brouillon', 'revision', 'chez_pro'].includes(qrt.status)) throw { status: 409, message: 'Cette QRT a déjà été traitée.' };
    const to = cleanEmails(b.to && b.to.length ? b.to : [qrt.pro_email]);
    if (!to.length) throw { status: 400, message: 'Choisissez le professionnel destinataire.' };
    const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
    const atts = await allFiles(qrt.id, 'attachment'), rep = {};
    const form = Buffer.from(await qrtpdf.buildQrt(projOf(qrt), pdfInput(qrt), atts, rep));     // pièces jointes fusionnées dans le PDF
    const formName = fileSafe(qrt.ref + ' - ' + (qrt.object || '').slice(0, 40) + '.pdf');
    const mergedSet = new Set(rep.merged || []);
    const loose = atts.filter(a => !mergedSet.has(a.filename));                                  // non fusionnables : jointes à part
    const total = form.length + loose.reduce((s, a) => s + a.bytes.length, 0);
    if (total * 1.37 > mailLimit()) throw { status: 413, message: 'Pièces jointes trop volumineuses pour un courriel (' + Math.round(total / 1048576) + ' Mo). Retirez-en ou compressez-les.' };
    const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000) ||
      ('Bonjour' + (qrt.pro_name ? ' ' + qrt.pro_name : '') + ',\n\nVeuillez trouver ci-joint la question technique ' + qrt.ref + ' pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\n' +
        (mergedSet.size ? 'Les pièces jointes sont incluses dans le PDF (annexes).\n' : '') + 'Merci de répondre directement dans le formulaire PDF (dernière page, zone « Réponse du professionnel »), de l\'enregistrer puis de nous le retourner par courriel.');
    const blk = mx.table(['Réf.', 'Objet'], [[qrt.ref, qrt.object]]);
    await mx.send({ user, to, cc, subject: str(b.subject, 200) || (qrt.ref + ' — Projet ' + project.number + ' ' + project.name), message: message.indexOf('{{LISTE}}') >= 0 ? message : message + '\n\n{{LISTE}}',
      blockHtml: blk.html, blockText: blk.text,
      attachments: [{ filename: formName, content: form, contentType: 'application/pdf' }].concat(loose.map(a => ({ filename: fileSafe(a.filename), content: a.bytes }))) });
    await storeFile(qrt.id, 'form', 0, formName, form, user.email);
    const first = DRAFTY.includes(qrt.status);
    await q(`UPDATE fin_qrt SET status = 'chez_pro', sent_pro_at = CASE WHEN $2 THEN now() ELSE sent_pro_at END, pro_email = COALESCE(pro_email, $3),
        reminders = CASE WHEN $2 THEN reminders ELSE reminders + 1 END, last_reminder_at = CASE WHEN $2 THEN last_reminder_at ELSE now() END, updated_by = $4, updated_at = now() WHERE id = $1`,
      [qrt.id, first, to[0], user.email]);
    await logEvent(qrt.id, first ? 'envoye_pro' : 'relance', user.email, to.join(', '));
    return { ok: true, to };
  },

  // --- Fichiers par blocs (limite de corps Vercel 4,5 Mo) ---
  async fileChunk(user, b) {
    await loadQrt(user, b.id);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10);
    const data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },

  /** kind : attachment (pièce du sous-traitant, tout format) ou response (PDF rempli par le professionnel -> « Répondu » + SharePoint). */
  async fileFinish(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    const kind = ['attachment', 'response'].includes(b.kind) ? b.kind : null;
    if (!kind) throw { status: 400, message: 'Type de document invalide.' };
    if (qrt.status === 'annule') throw { status: 409, message: 'QRT annulée.' };
    if (kind === 'attachment' && !DRAFTY.includes(qrt.status)) throw { status: 409, message: 'Les pièces jointes se déposent avant l\'envoi au professionnel.' };
    if (kind === 'response' && DRAFTY.includes(qrt.status)) throw { status: 409, message: "La QRT n'a pas encore été envoyée au professionnel." };
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const filename = fileSafe(b.filename || (kind === 'response' ? 'reponse.pdf' : 'piece-jointe')) || 'document';
    const n = parseInt(b.count, 10);
    const cnt = await q('SELECT count(*)::int AS n FROM fin_change_chunk WHERE upload_id = $1', [up]);
    if (!(n > 0) || cnt[0].n !== n) throw { status: 400, message: 'Téléversement incomplet (' + cnt[0].n + '/' + n + ' blocs). Réessayez.' };
    const rev = kind === 'response' ? ((await q("SELECT count(*)::int AS n FROM fin_qrt_file WHERE qrt_id = $1 AND kind = 'response'", [qrt.id]))[0].n) : 0;
    const ins = await q(`INSERT INTO fin_qrt_file (qrt_id, kind, rev, filename, size_bytes, data_b64, uploaded_by)
        SELECT $1, $2, $3, $4, 0, string_agg(data_b64, '' ORDER BY idx), $6 FROM fin_change_chunk WHERE upload_id = $5 RETURNING id, length(data_b64) AS len`,
      [qrt.id, kind, rev, filename, up, user.email]);
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const size = Math.floor(Number(ins[0].len) * 3 / 4);
    if (size > MAX_FILE) { await q('DELETE FROM fin_qrt_file WHERE id = $1', [ins[0].id]); throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' }; }
    if (kind === 'response') {
      const head = await q('SELECT substr(data_b64, 1, 8) AS h FROM fin_qrt_file WHERE id = $1', [ins[0].id]);
      if (Buffer.from(head[0].h, 'base64').toString('latin1').slice(0, 4) !== '%PDF') {
        await q('DELETE FROM fin_qrt_file WHERE id = $1', [ins[0].id]);
        throw { status: 400, message: 'La réponse doit être un PDF.' };
      }
    }
    await q('UPDATE fin_qrt_file SET size_bytes = $2 WHERE id = $1', [ins[0].id, size]);
    await logEvent(qrt.id, 'fichier_' + kind, user.email, filename);
    let sharepoint = null;
    if (kind === 'response') {
      await q("UPDATE fin_qrt SET status = 'repondu', answered_at = now(), returned_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1", [qrt.id, user.email]);
      const fresh = (await q('SELECT * FROM fin_qrt WHERE id = $1', [qrt.id]))[0];
      sharepoint = await pushToSharePoint(fresh);
    }
    return { ok: true, id: ins[0].id, sharepoint };
  },

  async fileDelete(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const r = await q("DELETE FROM fin_qrt_file WHERE id = $1 AND qrt_id = $2 AND kind <> 'form' RETURNING filename, kind", [b.fileId, qrt.id]);
    if (r[0]) {
      await logEvent(qrt.id, 'fichier_supprime', user.email, r[0].filename);
      if (r[0].kind === 'response' && qrt.status === 'repondu') {
        const left = await q("SELECT 1 FROM fin_qrt_file WHERE qrt_id = $1 AND kind = 'response' LIMIT 1", [qrt.id]);
        if (!left[0]) await q("UPDATE fin_qrt SET status = 'chez_pro', answered_at = NULL, updated_at = now() WHERE id = $1", [qrt.id]);
      }
    }
    return { ok: true };
  },

  async fileGetChunk(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = await q('SELECT filename, length(data_b64) AS len, substr(data_b64, $3::int, $4::int) AS part FROM fin_qrt_file WHERE id = $1 AND qrt_id = $2', [b.fileId, qrt.id, idx * CHUNK_B64 + 1, CHUNK_B64]);
    if (!r[0]) throw { status: 404, message: 'Fichier introuvable.' };
    return { filename: r[0].filename, data: r[0].part || '', chunks: Math.max(1, Math.ceil(Number(r[0].len) / CHUNK_B64)), idx };
  },

  async spRetry(user, b) {
    const { qrt } = await loadQrt(user, b.id);
    if (!['repondu', 'retourne'].includes(qrt.status)) throw { status: 409, message: "La QRT n'a pas encore de réponse." };
    return { sharepoint: await pushToSharePoint(qrt) };
  },

  /** Retourne la réponse (PDF rempli) au sous-traitant par courriel. */
  async sendToSub(user, b) {
    const { qrt, project } = await loadQrt(user, b.id);
    if (!['repondu', 'retourne'].includes(qrt.status)) throw { status: 409, message: "Déposez d'abord le PDF de réponse du professionnel." };
    const f = await latestFile(qrt.id, 'response');
    if (!f) throw { status: 400, message: 'PDF de réponse introuvable.' };
    const to = cleanEmails(b.to && b.to.length ? b.to : [qrt.supplier_email]);
    if (!to.length) throw { status: 400, message: 'Courriel du sous-traitant manquant.' };
    const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
    const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000) ||
      ('Bonjour' + (qrt.supplier_contact ? ' ' + qrt.supplier_contact : '') + ',\n\nLe professionnel a répondu à votre question technique pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nVous trouverez la réponse dans le document ci-joint.\n\nMerci de votre collaboration.');
    const blk = mx.table(['Réf.', 'Objet'], [[qrt.ref, qrt.object]]);
    await mx.send({ user, to, cc, subject: str(b.subject, 200) || ('Réponse à la QRT ' + qrt.ref + ' — Projet ' + project.number + ' ' + project.name),
      message: message.indexOf('{{LISTE}}') >= 0 ? message : message + '\n\n{{LISTE}}', blockHtml: blk.html, blockText: blk.text,
      attachments: [{ filename: fileSafe(qrt.ref + ' - Reponse.pdf'), content: f.bytes, contentType: 'application/pdf' }] });
    await q("UPDATE fin_qrt SET status = 'retourne', returned_at = now(), supplier_email = COALESCE(supplier_email, $2), updated_by = $3, updated_at = now() WHERE id = $1", [qrt.id, to[0], user.email]);
    await logEvent(qrt.id, 'retourne_sous_traitant', user.email, to.join(', '));
    return { ok: true, to };
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Déclencheur externe (cron-job.org) : lit la boîte de coordination (COORDO_MAILBOX) et prépare QRT, DA / FT et documents de fin de chantier (statut « À réviser »)
  if (req.method === 'GET') {
    const secret = process.env.QRT_CRON_SECRET || process.env.INVOICE_CRON_SECRET;
    const key = String((req.query && req.query.key) || req.headers['x-cron-secret'] || '');
    if (!secret || key !== secret) { res.status(401).json({ error: 'Non autorisé.' }); return; }
    try { res.status(200).json(await require('./_lib/coordo').poll(3)); }
    catch (e) { console.error('cron qrt', e); res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }
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
    if (status >= 500) console.error('qrt.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
