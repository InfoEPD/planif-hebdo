// api/finance.js
//
// Point d'entrée UNIQUE (authentifié par Clerk) du module Finance — Étape A : bons de commande.
// Même principe que api/tenant.js : { action, ...paramètres } -> un seul fichier = une seule
// fonction Vercel, quel que soit le nombre d'actions.
//
// Règles d'accès (vérifiées ici, côté serveur) :
//   - administrateur (FINANCE_ADMIN_EMAILS) : tous les projets et tous les bons de commande
//   - chargé de projet : uniquement les projets où il est « Chargé de projet » dans Monday
//     (reconnu par son courriel) et les bons de commande de ces projets
//
// Voir api/sign.js pour la page publique de signature (jeton à usage unique par bon de commande).

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const mail = require('./_lib/mail');
const pdf = require('./_lib/pdf');
const po = require('./_lib/po');
const DEFAULT_TERMS = require('./_lib/default-terms');

const MAX_QUOTE_BYTES = 3.2 * 1024 * 1024; // limite Vercel : corps de requête 4,5 Mo (base64 = +33 %)

function baseUrl(req) {
  if (process.env.FINANCE_BASE_URL) return process.env.FINANCE_BASE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host;
}

function adminOnly(user) { if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' }; }

function canAccess(user, r) {
  if (user.isAdmin) return true;
  if (r.issuer_user_id === user.userId) return true;
  return String(r.cp_emails || '').split(',').includes(user.email);
}
function cpReplyTo(r) {
  return String(r.cp_emails || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '';
}
function cpOf(user, project) {
  return user.isAdmin || project.cp.some(c => c.email && c.email.toLowerCase() === user.email);
}

async function loadPo(user, id, opts) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_po WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'Bon de commande introuvable.' };
  const r = po.rowToPo(rows[0]);
  if (!canAccess(user, r)) throw { status: 403, message: "Vous n'avez pas accès à ce bon de commande." };
  if (opts && opts.draftOnly && r.status !== 'brouillon') throw { status: 409, message: 'Ce bon de commande a déjà été envoyé : il ne peut plus être modifié.' };
  return r;
}

async function defaultTerms() {
  const r = await q("SELECT value FROM fin_settings WHERE key = 'terms_default'");
  return r[0] ? r[0].value : DEFAULT_TERMS;
}

function summary(r) {
  return {
    id: r.id, po_number: r.po_number, project_number: r.project_number, project_name: r.project_name,
    supplier_name: r.supplier_name, total: po.num(r.total), status: r.status, po_date: r.po_date,
    issuer_name: r.issuer_name, sent_at: r.sent_at, signed_at: r.signed_at, has_quote: !!r.has_quote,
    sharepoint_status: r.sharepoint_status, legacy: !!r.legacy, monday_url: r.monday_url || null
  };
}

function toPdfModel(r) { return Object.assign({}, r); }

/** Numéro de révision = nombre de réouvertures (0 = version initiale). */
async function withRevision(r) {
  const rev = await q("SELECT count(*)::int AS n FROM fin_po_event WHERE po_id = $1 AND event = 'rouvert'", [r.id]);
  r.revision = rev[0] ? rev[0].n : 0;
  return r;
}

async function buildCurrentPdf(r) {
  const quote = await po.getFile(r.id, 'quote');
  await withRevision(r);
  const model = toPdfModel(r); // « Révision n » dans l'en-tête du PDF
  return pdf.buildPoPdf(model, { quoteBytes: quote ? quote.bytes : null });
}

const ACTIONS = {
  async me(user) {
    return { email: user.email, name: user.name, isAdmin: user.isAdmin, tps: pdf.TPS_RATE, tvq: pdf.TVQ_RATE };
  },

  async projects(user, b) {
    const list = await monday.fetchProjects(!!b.refresh);
    const mine = list.filter(p => cpOf(user, p));
    mine.sort((a, c) => String(c.number).localeCompare(String(a.number), 'fr', { numeric: true }));
    return { projects: mine.map(p => ({ id: p.id, name: p.name, number: p.number, status: p.status, cp: p.cp.map(c => c.name) })) };
  },

  async projectGet(user, b) {
    const p = await monday.fetchProject(b.itemId);
    if (!cpOf(user, p)) throw { status: 403, message: "Vous n'êtes pas chargé(e) de projet de ce projet." };
    const c = await q('SELECT last_seq FROM fin_po_counter WHERE project_number = $1', [p.number]);
    const next = Math.max(c[0] ? Number(c[0].last_seq) : 0, p.maxPo || 0) + 1;
    const pick = (arr, role) => { const x = (arr || [])[0]; return { role, name: x ? x.name : '', phone: x ? x.phone : '', email: x ? x.email : '' }; };
    return {
      project: { id: p.id, name: p.name, number: p.number, status: p.status },
      defaults: {
        nextNumber: p.number + '-' + String(next).padStart(3, '0'),
        contacts: [pick(p.cm, 'Contremaître'), pick(p.coordo, 'Coordonnateur'), pick(p.cp, 'Chargé de projet')],
        owner: p.owner,
        link: p.link,
        retentionPct: 10
      }
    };
  },

  /** Contacts connus d'un fournisseur (saisis sur des bons de commande précédents + suggestions d'Avantage). */
  async supplierContacts(user, b) {
    const sup = await monday.fetchSupplier(b.supplierItemId);
    return { contacts: await require('./_lib/supplier-contacts').list(sup) };
  },
  async supplierContactDelete(user, b) {
    const sup = await monday.fetchSupplier(b.supplierItemId);
    return require('./_lib/supplier-contacts').remove(sup, b.contactId);
  },

  async suppliers(user, b) {
    const list = await monday.fetchSuppliers(!!b.refresh);
    return { suppliers: list };
  },

  /** Postes budgétaires (Monday) avec leur compte G/L. */
  async budgetItems(user, b) {
    const list = await monday.fetchBudgetItems(!!b.refresh);
    return { items: list };
  },

  // ---------- Configuration : postes budgétaires et charte comptable (administrateurs) ----------
  async cfgBudgetGet(user) {
    adminOnly(user);
    let items = [], gls = [], missing = false;
    try {
      items = await q('SELECT id, code, name, gl, gl_label, active FROM fin_budget_item ORDER BY name');
      gls = await q('SELECT account, label, active FROM fin_gl_account ORDER BY account');
    } catch (e) { missing = true; }
    return { missing, items, gls };
  },
  async cfgBudgetSave(user, b) {
    adminOnly(user);
    const name = po.str(b.name, 200), code = po.str(b.code, 20), gl = po.str(b.gl, 20), glLabel = po.str(b.glLabel, 200);
    if (!name) throw { status: 400, message: 'Le nom du poste est obligatoire (ex. « 4200 - Maçonnerie commercial »).' };
    if (!gl) throw { status: 400, message: 'Le compte G/L est obligatoire.' };
    const id = b.id ? String(b.id) : 'N-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const finalCode = code || (/^\s*(\S+)/.exec(name) || [])[1] || '';
    if (finalCode && b.active !== false) {
      const dup = await q('SELECT name FROM fin_budget_item WHERE active AND id <> $1 AND lower(btrim(code)) = lower(btrim($2)) LIMIT 1', [id, finalCode]);
      if (dup[0]) throw { status: 400, message: 'Le code « ' + finalCode + ' » est déjà utilisé par le poste « ' + dup[0].name + ' ». Chaque poste doit avoir un code unique (les montants du bordereau, bons de commande et factures sont rattachés au code).' };
    }
    await q(`INSERT INTO fin_budget_item (id, code, name, gl, gl_label, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, gl=EXCLUDED.gl, gl_label=EXCLUDED.gl_label, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [id, finalCode, name, gl, glLabel, b.active !== false, user.email]);
    if (gl) await q("INSERT INTO fin_gl_account (account, label, updated_by) VALUES ($1,$2,$3) ON CONFLICT (account) DO NOTHING", [gl, glLabel, user.email]);
    monday.resetBudgetCache();
    return { ok: true, id };
  },
  async cfgBudgetDelete(user, b) {
    adminOnly(user);
    const used = await q('SELECT 1 FROM fin_po WHERE budget_item_id = $1 LIMIT 1', [String(b.id)]);
    if (used[0]) { await q('UPDATE fin_budget_item SET active = FALSE, updated_by = $2, updated_at = now() WHERE id = $1', [String(b.id), user.email]); monday.resetBudgetCache(); return { ok: true, deactivated: true }; }
    await q('DELETE FROM fin_budget_item WHERE id = $1', [String(b.id)]);
    monday.resetBudgetCache();
    return { ok: true };
  },
  async cfgGlSave(user, b) {
    adminOnly(user);
    const account = po.str(b.account, 20), label = po.str(b.label, 200);
    if (!account) throw { status: 400, message: 'Le numéro de compte est obligatoire.' };
    await q(`INSERT INTO fin_gl_account (account, label, active, updated_by) VALUES ($1,$2,$3,$4)
        ON CONFLICT (account) DO UPDATE SET label=EXCLUDED.label, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`, [account, label, b.active !== false, user.email]);
    // le libellé suit dans les postes qui utilisent ce compte
    await q('UPDATE fin_budget_item SET gl_label = $2, updated_at = now() WHERE gl = $1', [account, label]);
    monday.resetBudgetCache();
    return { ok: true };
  },
  async cfgGlDelete(user, b) {
    adminOnly(user);
    const used = await q('SELECT 1 FROM fin_budget_item WHERE gl = $1 LIMIT 1', [String(b.account)]);
    if (used[0]) throw { status: 409, message: 'Ce compte est utilisé par au moins un poste budgétaire : modifiez d\'abord les postes.' };
    await q('DELETE FROM fin_gl_account WHERE account = $1', [String(b.account)]);
    return { ok: true };
  },

  // ---------- Synchronisation Monday → Exacto (administrateurs) ----------
  async msyncStatus(user) {
    adminOnly(user);
    return await require('./_lib/msync').status();
  },
  async msyncRun(user, b) {
    adminOnly(user);
    return await require('./_lib/msync').runPage(user, String(b.kind || ''), b.cursor ? String(b.cursor) : null);
  },

  async termsGet(user) {
    const r = await q("SELECT value, updated_by, updated_at FROM fin_settings WHERE key = 'terms_default'");
    return { terms: r[0] ? r[0].value : DEFAULT_TERMS, saved: !!r[0], updated_by: r[0] && r[0].updated_by, updated_at: r[0] && r[0].updated_at };
  },

  async termsSave(user, b) {
    if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' };
    const t = String(b.terms || '').replace(/\r/g, '');
    if (t.trim().length < 50) throw { status: 400, message: 'Le texte des conditions est trop court.' };
    if (t.length > 60000) throw { status: 400, message: 'Le texte des conditions est trop long.' };
    await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ('terms_default', $1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [t, user.email]);
    return { ok: true };
  },

  async termsReset(user) {
    if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' };
    await q("DELETE FROM fin_settings WHERE key = 'terms_default'");
    return { ok: true, terms: DEFAULT_TERMS };
  },

  async poList(user, b) {
    const params = [];
    let where = '';
    if (!user.isAdmin) {
      params.push(user.userId, user.email);
      where = "WHERE (p.issuer_user_id = $1 OR position(',' || $2 || ',' in ',' || p.cp_emails || ',') > 0)";
    }
    const rows = await q(`SELECT p.id, p.po_number, p.project_number, p.project_name, p.supplier_name, p.total, p.status, p.po_date,
        p.issuer_name, p.sent_at, p.signed_at, p.sharepoint_status, p.legacy, p.monday_url,
        EXISTS (SELECT 1 FROM fin_po_file f WHERE f.po_id = p.id AND f.kind = 'quote') AS has_quote
      FROM fin_po p ${where} ORDER BY p.created_at DESC LIMIT 800`, params);
    return { pos: rows.map(r => summary(po.rowToPo(r))) };
  },

  async poGet(user, b, req) {
    const r = await loadPo(user, b.id);
    const ev = await q('SELECT at, event, actor, ip, detail FROM fin_po_event WHERE po_id = $1 ORDER BY at ASC, id ASC', [r.id]);
    const files = await q('SELECT kind, filename, length(data_b64) AS len FROM fin_po_file WHERE po_id = $1', [r.id]);
    const out = Object.assign({}, r);
    delete out.token; delete out.signature_png;
    out.sign_url = (r.token && (r.status === 'envoye' || r.status === 'vu')) ? baseUrl(req) + '/sign?t=' + r.token : null;
    out.quote = (files.find(f => f.kind === 'quote') || null);
    out.has_signed = !!files.find(f => f.kind === 'signed');
    out.events = ev;
    out.editable = r.status === 'brouillon';
    return { po: out };
  },

  async poCreate(user, b, req) {
    const project = await monday.fetchProject(b.projectItemId);
    if (!cpOf(user, project)) throw { status: 403, message: "Vous n'êtes pas chargé(e) de projet de ce projet." };
    if (!/^[A-Za-z0-9-]{3,14}$/.test(project.number)) throw { status: 400, message: "Le numéro de projet dans Monday est manquant ou invalide (« " + project.number + " »)." };

    let sup = null;
    if (b.supplierItemId) sup = await monday.fetchSupplier(b.supplierItemId);
    const supplierName = po.str(sup ? sup.name : b.supplierName, 200);
    if (!supplierName) throw { status: 400, message: 'Choisissez un fournisseur / sous-traitant.' };
    if (sup && sup.active === false) throw { status: 400, message: 'Ce fournisseur est « Inactif » : impossible d\'émettre un bon de commande.' };
    if (sup && sup.blacklisted) throw { status: 400, message: 'Ce fournisseur est sur la liste noire (« Blacklist » dans Monday).' };
    const supplierEmail = po.str(b.supplierEmail != null ? b.supplierEmail : (sup && sup.emails[0]), 200);
    if (supplierEmail && !po.isEmail(supplierEmail)) throw { status: 400, message: 'Courriel du fournisseur invalide.' };
    const supplierPhone = po.str(b.supplierPhone != null ? b.supplierPhone : (sup && sup.phone), 60);

    if (!b.budgetItemId) throw { status: 400, message: 'Choisissez le poste budgétaire (il détermine le compte G/L de la dépense).' };
    const bud = await monday.fetchBudgetItem(b.budgetItemId);
    if (!bud.gl) throw { status: 400, message: 'Le poste « ' + bud.name + ' » n\'a pas de compte G/L (charte comptable) dans Monday.' };

    const lines = po.normalizeLines(b.lines);
    const totals = pdf.computeTotals(lines);
    const contacts = po.normalizeContacts(b.contacts);
    const owner = po.normalizeOwner(b.owner);
    const retention = po.normalizeRetention(b.retentionPct != null ? b.retentionPct : 10);
    const terms = (b.termsText && String(b.termsText).trim()) ? String(b.termsText).replace(/\r/g, '').slice(0, 60000) : await defaultTerms();
    const poDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.poDate || '')) ? b.poDate : new Date().toISOString().slice(0, 10);

    // Numéro : incrément atomique par projet, jamais en dessous de « Max # PO » de Monday.
    const cnt = await q(`INSERT INTO fin_po_counter (project_number, last_seq) VALUES ($1, $2 + 1)
        ON CONFLICT (project_number) DO UPDATE SET last_seq = GREATEST(fin_po_counter.last_seq, $2) + 1
        RETURNING last_seq`, [project.number, project.maxPo || 0]);
    const seq = Number(cnt[0].last_seq);
    const poNumber = project.number + '-' + String(seq).padStart(3, '0');

    const cpEmails = ',' + project.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean).join(',') + ',';
    const cpClean = cpEmails.replace(/^,+|,+$/g, '');

    const ins = await q(`INSERT INTO fin_po (po_number, project_number, seq, doc_ref, status, project_item_id, project_name, cp_emails,
        supplier_item_id, supplier_name, supplier_email, supplier_phone, supplier_avantage_id,
        issuer_user_id, issuer_email, issuer_name, po_date, soumission_number, project_link, info_additional,
        contacts, owner, lines, subtotal, tps, tvq, total, retention_pct, terms_text,
        budget_item_id, budget_label, budget_code, gl_account, gl_label)
      VALUES ($1,$2,$3,$4,'brouillon',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
      RETURNING id`,
      [poNumber, project.number, seq, po.newDocRef(), project.id, project.name, cpClean,
        sup ? sup.id : null, supplierName, supplierEmail || null, supplierPhone || null, sup ? (sup.avantageId || null) : null,
        user.userId, user.email, user.name, poDate, po.str(b.soumissionNumber, 80), po.str(b.projectLink, 400), po.str(b.infoAdditional, 1500),
        JSON.stringify(contacts), JSON.stringify(owner), JSON.stringify(lines), totals.subtotal, totals.tps, totals.tvq, totals.total, retention, terms,
        bud.id, bud.name, bud.code || null, bud.gl, bud.glLabel || null]);
    const id = ins[0].id;
    await po.logEvent(id, 'cree', user.email, po.clientIp(req), poNumber);
    // Max # PO mis à jour dès la création du brouillon. On attend la fin (sinon Vercel peut interrompre l'appel
    // après la réponse) ; setMaxPo ne lève jamais d'erreur : un échec n'empêche pas la création.
    await monday.setMaxPo(project.id, seq);
    // Le courriel / téléphone saisi rejoint la liste de contacts du fournisseur (meilleur effort : n'empêche jamais la création).
    if (sup && b.saveContact !== false && (supplierEmail || supplierPhone)) {
      try { await require('./_lib/supplier-contacts').remember(sup, { name: b.contactName, email: supplierEmail, phone: supplierPhone }); }
      catch (e) { console.error('supplier contact', e && e.message); }
    }
    return { id, po_number: poNumber };
  },

  async poUpdate(user, b, req) {
    const r = await loadPo(user, b.id, { draftOnly: true });
    const sets = [], params = [r.id];
    const set = (col, val, cast) => { params.push(val); sets.push(col + ' = $' + params.length + (cast || '')); };
    if ('supplierEmail' in b) { const e = po.str(b.supplierEmail, 200); if (e && !po.isEmail(e)) throw { status: 400, message: 'Courriel du fournisseur invalide.' }; set('supplier_email', e || null); }
    if ('supplierPhone' in b) set('supplier_phone', po.str(b.supplierPhone, 60) || null);
    if ('poDate' in b && /^\d{4}-\d{2}-\d{2}$/.test(String(b.poDate))) set('po_date', b.poDate);
    if ('soumissionNumber' in b) set('soumission_number', po.str(b.soumissionNumber, 80));
    if ('projectLink' in b) set('project_link', po.str(b.projectLink, 400));
    if ('infoAdditional' in b) set('info_additional', po.str(b.infoAdditional, 1500));
    if ('contacts' in b) set('contacts', JSON.stringify(po.normalizeContacts(b.contacts)), '::jsonb');
    if ('owner' in b) set('owner', JSON.stringify(po.normalizeOwner(b.owner)), '::jsonb');
    if ('retentionPct' in b) set('retention_pct', po.normalizeRetention(b.retentionPct));
    if (b.budgetItemId && String(b.budgetItemId) !== String(r.budget_item_id || '')) {
      const bud = await monday.fetchBudgetItem(b.budgetItemId);
      if (!bud.gl) throw { status: 400, message: 'Le poste « ' + bud.name + ' » n\'a pas de compte G/L (charte comptable) dans Monday.' };
      set('budget_item_id', bud.id); set('budget_label', bud.name); set('budget_code', bud.code || null); set('gl_account', bud.gl); set('gl_label', bud.glLabel || null);
    }
    if ('termsText' in b) {
      const t = String(b.termsText || '').replace(/\r/g, '');
      if (t.trim().length < 50) throw { status: 400, message: 'Le texte des conditions est trop court.' };
      set('terms_text', t.slice(0, 60000));
    }
    if ('lines' in b) {
      const lines = po.normalizeLines(b.lines);
      const t = pdf.computeTotals(lines);
      set('lines', JSON.stringify(lines), '::jsonb'); set('subtotal', t.subtotal); set('tps', t.tps); set('tvq', t.tvq); set('total', t.total);
    }
    if (!sets.length) return { ok: true };
    await q('UPDATE fin_po SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', params);
    await po.logEvent(r.id, 'modifie', user.email, po.clientIp(req));
    // Courriel / téléphone saisi à la main : mémorisé dans les contacts du fournisseur (comme à la création)
    if (b.saveContact !== false && r.supplier_item_id && (('supplierEmail' in b && b.supplierEmail) || ('supplierPhone' in b && b.supplierPhone))) {
      try { const sup = await monday.fetchSupplier(r.supplier_item_id); await require('./_lib/supplier-contacts').remember(sup, { name: b.contactName, email: b.supplierEmail, phone: b.supplierPhone }); }
      catch (e) { console.error('supplier contact', e && e.message); }
    }
    return { ok: true };
  },

  async poUploadQuote(user, b, req) {
    const r = await loadPo(user, b.id, { draftOnly: true });
    const data = String(b.dataBase64 || '').replace(/^data:application\/pdf;base64,/, '');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length < 100 || bytes.slice(0, 5).toString('latin1') !== '%PDF-') throw { status: 400, message: 'Le fichier doit être un PDF.' };
    if (bytes.length > MAX_QUOTE_BYTES) throw { status: 413, message: 'La soumission dépasse 3,2 Mo. Compressez le PDF (ou joignez-le au courriel manuellement).' };
    // validation : le PDF doit être lisible (sinon l'assemblage final échouerait)
    try { await pdf.buildPoPdf(toPdfModel(r), { quoteBytes: bytes }); }
    catch (e) { throw { status: e.status || 400, message: e.message || 'PDF illisible.' }; }
    const fname = po.str(b.filename, 160) || 'soumission.pdf';
    await po.putFile(r.id, 'quote', fname, bytes);
    await po.logEvent(r.id, 'soumission_ajoutee', user.email, po.clientIp(req), fname);
    return { ok: true, filename: fname, size: bytes.length };
  },

  async poRemoveQuote(user, b, req) {
    const r = await loadPo(user, b.id, { draftOnly: true });
    await q("DELETE FROM fin_po_file WHERE po_id = $1 AND kind = 'quote'", [r.id]);
    await po.logEvent(r.id, 'soumission_retiree', user.email, po.clientIp(req));
    return { ok: true };
  },

  /** Importe un bon de commande imprimé, signé à la main et numérisé : passe le bon au statut « Signé ». */
  async poImportSigned(user, b, req) {
    const r = await loadPo(user, b.id);
    if (r.status === 'signe') throw { status: 409, message: 'Ce bon de commande est déjà signé.' };
    if (r.status === 'annule') throw { status: 409, message: 'Ce bon de commande est annulé.' };
    const data = String(b.dataBase64 || '').replace(/^data:application\/pdf;base64,/, '');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length < 100 || bytes.slice(0, 5).toString('latin1') !== '%PDF-') throw { status: 400, message: 'Le fichier doit être un PDF (numérisez le bon signé en PDF).' };
    if (bytes.length > MAX_QUOTE_BYTES) throw { status: 413, message: 'Le fichier dépasse 3,2 Mo. Numérisez en résolution plus basse ou compressez le PDF.' };
    const signerName = po.str(b.signerName, 120);
    if (!signerName) throw { status: 400, message: 'Indiquez le nom du signataire (sous-traitant).' };
    const signerTitle = po.str(b.signerTitle, 120);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(b.signedDate || '')) ? b.signedDate : null;
    if (!d) throw { status: 400, message: 'Indiquez la date de signature.' };
    const signedAt = new Date(d + 'T12:00:00');
    if (isNaN(signedAt.getTime()) || signedAt.getTime() > Date.now() + 86400000) throw { status: 400, message: 'Date de signature invalide.' };

    const hash = pdf.sha256Hex(bytes);
    const claim = await q(`UPDATE fin_po SET status = 'signe', signed_at = $2, signer_name = $3, signer_title = $4, signer_ip = NULL,
        signer_ua = 'Import manuel (signature manuscrite)', signature_png = NULL, doc_hash = $5, token = NULL, sent_at = COALESCE(sent_at, now()), updated_at = now()
      WHERE id = $1 AND status IN ('brouillon','envoye','vu') RETURNING id`, [r.id, signedAt.toISOString(), signerName, signerTitle || null, hash]);
    if (!claim.length) throw { status: 409, message: 'Le bon de commande vient de changer de statut. Actualisez.' };

    await po.putFile(r.id, 'signed', po.safeFilename(r, '(signé)'), bytes);
    await po.logEvent(r.id, 'signe_manuscrit', user.email, po.clientIp(req), 'Signé par ' + signerName + ' le ' + d + (b.note ? ' — ' + po.str(b.note, 200) : ''));

    // Avis interne (un échec n'annule pas l'import)
    try {
      const signedPo = Object.assign({}, r, { signer_name: signerName, signer_title: signerTitle });
      const internal = Array.from(new Set([r.issuer_email, user.email, ...String(process.env.FINANCE_NOTIFY_EMAILS || '').split(',').map(x => x.trim())].filter(Boolean)));
      if (internal.length) {
        const m = mail.signedMail({ po: signedPo, forSupplier: false });
        await mail.sendMail({ to: internal.join(', '), subject: m.subject, html: m.html, text: m.text, attachments: [{ filename: po.safeFilename(r, '(signé)'), content: bytes, contentType: 'application/pdf' }] });
      }
    } catch (e) { await po.logEvent(r.id, 'courriel_confirmation_echec', 'systeme', null, e && e.message); }

    const sp = await po.pushToSharePoint(Object.assign({}, r, { id: r.id }));
    return { ok: true, sharepoint: sp.status };
  },

  async poPreview(user, b) {
    const r = await loadPo(user, b.id);
    const bytes = await buildCurrentPdf(r);
    return { filename: po.safeFilename(r, '(apercu)'), dataBase64: Buffer.from(bytes).toString('base64') };
  },

  async poDownload(user, b) {
    const r = await loadPo(user, b.id);
    if (b.which === 'signed') {
      const f = await po.getFile(r.id, 'signed');
      if (!f) throw { status: 404, message: "Ce bon de commande n'est pas encore signé." };
      return { filename: f.filename, dataBase64: f.bytes.toString('base64') };
    }
    const bytes = await buildCurrentPdf(r);
    return { filename: po.safeFilename(r), dataBase64: Buffer.from(bytes).toString('base64') };
  },

  /** Objet, message et destinataires proposés pour l'envoi (gabarit EPD, variables déjà remplacées). */
  async poEmailDraft(user, b) {
    const r = await withRevision(await loadPo(user, b.id));
    const d = mail.emailDraft(r);
    const cps = String(r.cp_emails || '').split(',').map(s => s.trim()).filter(Boolean);
    return { subject: d.subject, body: d.body, to: r.sent_to || r.supplier_email || '', cc: cps.filter(e => e !== user.email).join(', '), replyTo: cps[0] || user.email };
  },

  async poSend(user, b, req) {
    const r = await withRevision(await loadPo(user, b.id));
    if (r.status === 'signe') throw { status: 409, message: 'Ce bon de commande est déjà signé.' };
    if (r.status === 'annule') throw { status: 409, message: 'Ce bon de commande est annulé.' };
    const to = (Array.isArray(b.to) ? b.to : String(b.to || '').split(/[;,\s]+/)).map(s => po.str(s, 200)).filter(Boolean);
    const cc = (Array.isArray(b.cc) ? b.cc : String(b.cc || '').split(/[;,\s]+/)).map(s => po.str(s, 200)).filter(Boolean);
    if (!to.length) throw { status: 400, message: 'Indiquez au moins un destinataire.' };
    [...to, ...cc].forEach(e => { if (!po.isEmail(e)) throw { status: 400, message: 'Courriel invalide : ' + e }; });
    if (!r.lines || !r.lines.length) throw { status: 400, message: 'Le bon de commande ne contient aucune ligne.' };
    if (!r.budget_item_id || !r.gl_account) throw { status: 400, message: "Choisissez le poste budgétaire (G/L) du bon de commande avant de l'envoyer : enregistrez-le dans le formulaire." };

    const token = r.token || po.newToken();
    if (!r.token) await q('UPDATE fin_po SET token = $2 WHERE id = $1', [r.id, token]);
    r.token = token;

    // PDF tel qu'envoyé (empreinte conservée pour le certificat de signature)
    r.sent_at = r.sent_at || new Date().toISOString();
    const bytes = await buildCurrentPdf(r);
    const hash = pdf.sha256Hex(bytes);

    const signUrl = baseUrl(req) + '/sign?t=' + token;
    const ccAll = Array.from(new Set([...cc, user.email].filter(Boolean)));
    const m = mail.supplierMail({ po: r, signUrl, subject: po.str(b.subject, 300), body: String(b.body || '').slice(0, 8000) });
    // Réponses du fournisseur -> chargé de projet du projet (à défaut : l'émetteur)
    const replyTo = cpReplyTo(r) || user.email;
    await mail.sendMail({
      to: to.join(', '), cc: ccAll.join(', '), replyTo,
      subject: m.subject, html: m.html, text: m.text,
      attachments: [{ filename: po.safeFilename(r), content: Buffer.from(bytes), contentType: 'application/pdf' }]
    });

    await q(`UPDATE fin_po SET status = 'envoye', sent_at = COALESCE(sent_at, $2), sent_to = $3, doc_hash = $4, updated_at = now() WHERE id = $1`,
      [r.id, r.sent_at, to.join(', '), hash]);
    await po.logEvent(r.id, r.status === 'brouillon' ? 'envoye' : 'renvoye', user.email, po.clientIp(req), to.join(', '));
    return { ok: true, sign_url: signUrl };
  },

  // Rouvre un bon de commande envoyé (non signé) pour le modifier : le lien de signature actuel est
  // invalidé ; un nouvel envoi génère un nouveau lien. Le numéro de BC reste le même (« Révision n »).
  async poReopen(user, b, req) {
    const r = await loadPo(user, b.id);
    if (r.status === 'signe') throw { status: 409, message: 'Ce bon de commande est déjà signé : il ne peut plus être modifié.' };
    if (r.status === 'annule') throw { status: 409, message: 'Ce bon de commande est annulé.' };
    if (r.status === 'brouillon') return { ok: true };
    const upd = await q("UPDATE fin_po SET status = 'brouillon', token = NULL, updated_at = now() WHERE id = $1 AND status IN ('envoye','vu') RETURNING id", [r.id]);
    if (!upd[0]) throw { status: 409, message: "Le statut du bon de commande vient de changer (peut-être signé à l'instant). Actualisez." };
    await po.logEvent(r.id, 'rouvert', user.email, po.clientIp(req), po.str(b.reason, 300));
    return { ok: true };
  },

  async poCancel(user, b, req) {
    const r = await loadPo(user, b.id);
    if (!user.isAdmin && r.issuer_user_id !== user.userId) throw { status: 403, message: "Seul l'émetteur ou un administrateur peut annuler ce bon de commande." };
    if (r.status === 'signe') throw { status: 409, message: 'Un bon de commande signé ne peut pas être annulé ici.' };
    await q("UPDATE fin_po SET status = 'annule', updated_at = now() WHERE id = $1", [r.id]);
    await po.logEvent(r.id, 'annule', user.email, po.clientIp(req), po.str(b.reason, 300));
    return { ok: true };
  },

  async poSharepointRetry(user, b) {
    if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' };
    const r = await loadPo(user, b.id);
    if (r.status !== 'signe') throw { status: 409, message: "Le bon de commande n'est pas signé." };
    return await po.pushToSharePoint(r);
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
  let user;
  try { user = await requireUser(req); }
  catch (e) { res.status(e.status || 401).json({ error: e.message || 'Non authentifié.' }); return; }

  const body = req.body || {};
  const fn = ACTIONS[body.action];
  if (!fn) { res.status(400).json({ error: 'Action inconnue.' }); return; }
  try {
    const out = await fn(user, body, req);
    res.status(200).json(out);
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('finance.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
