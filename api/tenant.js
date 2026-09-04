// api/tenant.js
//
// Endpoint unique self-service pour un tenant non-EPD (fusion de tenant-employees.js,
// tenant-projects.js et tenant-config.js — fusionnés pour rester sous la limite de 12
// fonctions Serverless du plan Vercel Hobby). Réservé aux comptes avec un tenantId défini
// et role === 'admin'. Complètement indépendant des fichiers EPD (monday.js, employee-admin.js,
// etc.) — ne les modifie pas, ne les importe pas.
//
// Body attendu (POST) : { resource, action, ...params }
//
//   resource: 'employees'
//     action: list          {}
//     action: create        { fullName, phone, email, jobTitle, employeeNumber }
//     action: update         { id, fullName, phone, email, jobTitle, employeeNumber, status,
//                              address, homeLat, homeLng, excludeFromPayroll, primeId }
//                            // status: 'actif' | 'inactif' — address nécessite homeLat/homeLng
//                            // (sélection dans la recherche d'adresse, comme les projets)
//     action: remove         { id }
//     action: createAccess   { id, email, password }  // crée l'accès Clerk de connexion (module Poinçon)
//
//   resource: 'projects'
//     action: list    {}
//     action: create  { name, code, address, status }   // status: 'en_planification' | 'en_cours' | 'termine'
//     action: update  { id, name, code, address, status }
//     action: remove  { id }
//
//   resource: 'config'
//     action: get               {}                                    // réglages + métiers + primes
//     action: updateSettings    { primesEnabled, payrollSoftware }     // ccqEnabled/planifEnabled gérés par le superuser
//     action: createJobTitle    { name }
//     action: updateJobTitle    { id, name }
//     action: deleteJobTitle    { id }
//     action: createPrime       { name, percentage, code }
//     action: updatePrime       { id, name, percentage, code }
//     action: deletePrime       { id }
//
//   resource: 'punches'   — réservé aux comptes employés (role === 'employee', module Poinçon)
//     action: activeProjects  {}                                       // liste des projets 'en_cours' (choix au poinçon)
//     action: myTaches        {}                                       // tâches configurées pour le métier de l'employé (Configuration > Métiers & Tâches)
//     action: start           { projectId, lat, lng, clientTimestamp, tache }
//     action: switch          { punchId, newProjectId, lat, lng, clientTimestamp, tache }
//     action: finish          { punchId, lat, lng, breakMorning, breakLunch, breakAfternoon, clientTimestamp }
//     action: editPending     { punchId, projectId, breakMorning, breakLunch, breakAfternoon, tache }
//                             // uniquement si status === 'ferme' (pas encore traité par l'admin)
//                             // tache : requise si des Tâches sont configurées pour le métier de l'employé
//                             // (voir resolveTache) ; ignorée si aucune Tâche n'est configurée (rétrocompatible).
//     action: listToday       {}
//     action: listHistory     { weekStart }                            // weekStart = dimanche (YYYY-MM-DD), défaut semaine en cours
//
//   resource: 'punchesAdmin'   — réservé aux administrateurs
//     action: listWeek        { weekStart }                             // chaque poinçon retourné inclut tache, projectLat/Lng/RayonM/HorsCcq (geofencing)
//     action: listByEmployee  { employeeId, weekStart }
//     action: listByProject   { projectId, weekStart }
//     action: manualAdd       { employeeId, projectId, date, clockIn, clockOut, tache }   // heures locales HH:mm, l'une des deux optionnelle
//     action: editPunch       { id, patch: { projectId, clockIn, clockOut, breakMorning, breakLunch,
//                                             breakAfternoon, overtime15, overtime2, kmTraveled, primeApplied, tache } }
//     action: approve         { id }
//     action: reject          { id }
//     action: restore         { id }                                   // remet approuvé/rejeté -> ferme
//     action: exportPayroll   { weekStart }                             // bloqué si poinçons en attente (ouvert/ferme) cette semaine
//
//   resource: 'tenantMessages'
//     action: send      { body }                     // employé — envoie un message à l'administrateur
//     action: list      {}                            // employé — ses messages (avec réponses admin)
//     action: markRead  {}                             // employé — marque les messages admin comme lus
//     action: listAll   {}                            // admin — un employé par ligne, dernier message + non lus
//     action: thread     { employeeId }               // admin — historique complet pour un employé (marque lu par admin)
//     action: reply      { employeeId, body }         // admin — répond à un employé

const { eq, and, ne, inArray } = require('drizzle-orm');
const { createClerkClient } = require('@clerk/backend');
const { getDb, schema } = require('./_db/client');
const { requireTenantContext } = require('./_lib/tenant-context');

const VALID_PROJECT_STATUSES = ['en_planification', 'en_cours', 'termine'];
// Statuts poinçon : ouvert (en cours) -> ferme (en attente d'approbation, fermé par l'employé ou
// par le cron auto-close) -> approuve | rejete -> exporte (verrouillé après export de paie).
const OPEN_PUNCH_STATUS = 'ouvert';
const PENDING_PUNCH_STATUSES = ['ouvert', 'ferme'];

// ───────────────────────── Helpers module Poinçon (Phase 5) ────────────────────────────────────

// Écart maximal toléré entre l'horloge du téléphone et l'heure réelle du serveur — même principe
// et même seuil que api/punch.js (EPD) : empêche un employé d'avancer/reculer l'heure de son
// appareil pour poinçonner à un moment différent de la réalité.
const MAX_CLOCK_DRIFT_MS = 3 * 60 * 1000;

function isValidCoord(v) { return typeof v === 'number' && isFinite(v); }

function checkClientClock(clientTimestamp) {
  if (typeof clientTimestamp !== 'number' || !isFinite(clientTimestamp) || clientTimestamp <= 0) {
    return "Impossible de valider l'heure de votre téléphone. Veuillez réessayer.";
  }
  if (Math.abs(Date.now() - clientTimestamp) > MAX_CLOCK_DRIFT_MS) {
    return "L'heure de votre téléphone ne correspond pas à l'heure réelle. Veuillez activer \"Date et heure automatiques\" dans les réglages de votre téléphone, puis réessayer.";
  }
  return null;
}

// Arrondit un instant au quart d'heure le plus proche. Comme le décalage horaire au Québec
// (EST/EDT) ne change jamais qu'à l'heure pile, arrondir sur les millisecondes epoch équivaut à
// arrondir sur l'heure locale — pas besoin de conversion de fuseau horaire ici.
function roundToNearest15(date) {
  const quarterMs = 15 * 60 * 1000;
  return new Date(Math.round(date.getTime() / quarterMs) * quarterMs);
}

function round15Min(minutes) { return Math.round(minutes / 15) * 15; }

// Date calendaire (YYYY-MM-DD) d'un instant, dans le fuseau America/Toronto.
function torontoDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

// Heure locale (0-23) d'un instant, dans le fuseau America/Toronto — sert à déterminer si le
// dîner/la pause PM sont applicables (voir computePunchHours ci-dessous).
function torontoMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  return hour * 60 + Number(map.minute);
}

// Dimanche (00:00 local) de la semaine contenant dateStr (YYYY-MM-DD). Convention "dimanche à
// samedi" — même convention que la dernière version des vues Poinçon EPD.
function sundayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(isValidCoord)) return null;
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

// Calcule les heures brutes/ajustées d'UN poinçon fermé (clockIn/clockOut tous deux définis).
// Convention CCQ commerciale (Québec), identique à api/punch.js (EPD) — voir ce fichier pour le
// détail du raisonnement. Simplification volontaire pour le module tenant (voir schema.js) : les
// cases de pause sont gérées par poinçon (segment), pas au niveau de la journée entière.
//   - Dîner (30 min) : pris -> déduit (non payé) ; non pris -> neutre (déjà payé, aucun ajout).
//   - Pauses matin/PM (15 min chacune, normalement payées) : non prise -> +15 min ajoutées.
//   - Le dîner n'est considéré applicable que si la fin du poinçon est à 13h ou plus tard ; la
//     pause PM, que si la fin est à 14h ou plus tard (mêmes seuils que EPD).
//   - Le total est ensuite arrondi au quart d'heure le plus proche.
function computePunchHours(punch, pauseConfig) {
  if (!punch.clockIn || !punch.clockOut) return { brutH: null, ajusteH: null };
  const pc = pauseConfig || { matin: 15, diner: 30, pm: 15 };
  const rawMin = Math.max(0, (new Date(punch.clockOut).getTime() - new Date(punch.clockIn).getTime()) / 60000);
  const brutMin = round15Min(rawMin);
  const finishMinutes = torontoMinutesOfDay(new Date(punch.clockOut));
  const lunchApplicable = finishMinutes >= 13 * 60;
  const afternoonApplicable = finishMinutes >= 14 * 60;
  const lunchAdjust = lunchApplicable ? (punch.breakLunch ? -pc.diner : 0) : 0;
  const morningAdjust = punch.breakMorning ? 0 : pc.matin;
  const afternoonAdjust = afternoonApplicable ? (punch.breakAfternoon ? 0 : pc.pm) : 0;
  const ajusteMin = Math.max(0, round15Min(rawMin + lunchAdjust + morningAdjust + afternoonAdjust));
  return {
    brutH: Math.round((brutMin / 60) * 100) / 100,
    ajusteH: Math.round((ajusteMin / 60) * 100) / 100,
  };
}

// Empêche le chevauchement de deux poinçons du même employé (double paiement — même contrôle que
// EPD, voir audit du module Poinçon). `excludeId` sert lors d'une modification/restauration pour
// ne pas comparer un poinçon avec lui-même.
async function hasOverlap(db, schema, tenantId, employeeId, clockIn, clockOut, excludeId) {
  const rows = await db.select().from(schema.punches).where(and(
    eq(schema.punches.tenantId, tenantId),
    eq(schema.punches.employeeId, employeeId),
    ne(schema.punches.status, 'rejete'),
  ));
  const startA = new Date(clockIn).getTime();
  const endA = clockOut ? new Date(clockOut).getTime() : Date.now();
  return rows.some(r => {
    if (excludeId && r.id === excludeId) return false;
    if (!r.clockIn) return false;
    const startB = new Date(r.clockIn).getTime();
    const endB = r.clockOut ? new Date(r.clockOut).getTime() : Date.now();
    return startA < endB && startB < endA;
  });
}

// Résout et valide le nom de tâche fourni par le client au regard des Tâches configurées
// (Configuration > Métiers & Tâches) pour le métier de l'employé, et de la restriction
// "Hors CCQ seulement" du projet visé. Parité avec EPD (rowTacheOptionsHtml) — voir admin.html.
//   - Si le métier de l'employé n'existe pas ou n'a aucune tâche configurée : aucune contrainte
//     (rétrocompatibilité pour les tenants qui n'ont pas encore rempli la Configuration).
//   - Si des tâches existent : une tâche valide est requise (sauf en mode "souple", utilisé côté
//     admin, où l'absence de tâche est tolérée pour ne pas bloquer les corrections manuelles).
// Retourne { ok:true, tache } ou { ok:false, error }.
async function resolveTache(db, schema, tenantId, jobTitleName, project, tacheName, opts) {
  const strict = !opts || opts.strict !== false;
  if (!jobTitleName) return { ok: true, tache: tacheName || null };
  const [jt] = await db.select().from(schema.jobTitles)
    .where(and(eq(schema.jobTitles.tenantId, tenantId), eq(schema.jobTitles.name, jobTitleName)));
  if (!jt) return { ok: true, tache: tacheName || null };
  const taches = await db.select().from(schema.taches)
    .where(and(eq(schema.taches.tenantId, tenantId), eq(schema.taches.jobTitleId, jt.id)));
  if (!taches.length) return { ok: true, tache: tacheName || null };
  if (!tacheName) {
    if (strict) return { ok: false, error: 'Veuillez sélectionner une tâche.' };
    return { ok: true, tache: null };
  }
  const match = taches.find(t => t.name === tacheName);
  if (!match) return { ok: false, error: 'Tâche invalide pour ce métier.' };
  if (project && project.horsCcq && match.ccq) {
    return { ok: false, error: 'Ce chantier est réservé aux tâches hors CCQ — veuillez choisir une tâche hors CCQ.' };
  }
  return { ok: true, tache: match.name };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  let ctx;
  try {
    ctx = await requireTenantContext(req);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Non autorisé.' });
    return;
  }
  // NOTE : contrairement aux versions précédentes de ce fichier, l'accès n'est plus filtré
  // globalement à role === 'admin' ici — le module Poinçon (Phase 5) doit aussi être accessible
  // aux comptes employés (role === 'employee', voir createAccess ci-dessus). Chaque bloc de
  // resource ci-dessous applique donc son propre contrôle de rôle.
  const db = getDb();
  const { resource, action } = req.body || {};
  const tenantId = ctx.tenantId;
  // Durées de pause configurables (Configuration → Pauses, voir mon-entreprise.html) — chargées
  // une seule fois par requête et passées à computePunchHours() partout où c'est nécessaire.
  // Défauts historiques (15/30/15) si la ligne tenant_settings n'a pas encore ces colonnes remplies.
  let pauseConfig = { matin: 15, diner: 30, pm: 15 };
  try {
    const [settingsRow] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
    if (settingsRow) {
      pauseConfig = {
        matin: settingsRow.pauseMatinMin != null ? settingsRow.pauseMatinMin : 15,
        diner: settingsRow.pauseDinerMin != null ? settingsRow.pauseDinerMin : 30,
        pm: settingsRow.pausePmMin != null ? settingsRow.pausePmMin : 15,
      };
    }
  } catch (err) { /* garde les défauts si la lecture échoue — ne bloque jamais un poinçon */ }

  try {
    // ===================== Employés =====================
    if (resource === 'employees') {
      if (ctx.role !== 'admin' && ctx.role !== 'lecture-seule') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      // Un compte "lecture-seule" peut consulter la liste, mais ne peut rien créer/modifier/supprimer
      // ni créer d'accès de connexion (parité EPD — voir admin-access.js/READONLY_LOCK_SELECTOR).
      if (ctx.role !== 'admin' && action !== 'list') { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
      if (action === 'list') {
        const rows = await db.select().from(schema.employees).where(eq(schema.employees.tenantId, tenantId));
        res.status(200).json({ employees: rows });
        return;
      }
      if (action === 'create') {
        const { fullName, phone, email, jobTitle, employeeNumber } = req.body || {};
        if (!fullName) { res.status(400).json({ error: 'Le nom complet est requis.' }); return; }
        const [row] = await db.insert(schema.employees).values({
          tenantId, fullName, phone: phone || null, email: email || null,
          jobTitle: jobTitle || null, employeeNumber: employeeNumber || null,
        }).returning();
        res.status(200).json({ ok: true, employee: row });
        return;
      }
      if (action === 'update') {
        const { id, fullName, phone, email, jobTitle, employeeNumber, status, address, homeLat, homeLng, excludeFromPayroll, primeId } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (fullName !== undefined) patch.fullName = fullName;
        if (phone !== undefined) patch.phone = phone || null;
        if (email !== undefined) patch.email = email || null;
        if (jobTitle !== undefined) patch.jobTitle = jobTitle || null;
        if (employeeNumber !== undefined) patch.employeeNumber = employeeNumber || null;
        if (status !== undefined) patch.status = (status === 'inactif') ? 'inactif' : 'actif';
        if (excludeFromPayroll !== undefined) patch.excludeFromPayroll = !!excludeFromPayroll;
        if (primeId !== undefined) patch.primeId = primeId || null;
        if (address !== undefined) {
          if (address && (typeof homeLat !== 'number' || typeof homeLng !== 'number' || !isFinite(homeLat) || !isFinite(homeLng))) {
            res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
            return;
          }
          patch.address = address || null;
          patch.homeLat = address ? homeLat : null;
          patch.homeLng = address ? homeLng : null;
        }
        await db.update(schema.employees).set(patch)
          .where(and(eq(schema.employees.id, id), eq(schema.employees.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'remove') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.employees)
          .where(and(eq(schema.employees.id, id), eq(schema.employees.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createAccess') {
        const { id, email, password } = req.body || {};
        if (!id || !email || !password) { res.status(400).json({ error: 'id, email et password sont requis.' }); return; }
        if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }
        const [emp] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, id), eq(schema.employees.tenantId, tenantId)));
        if (!emp) { res.status(404).json({ error: 'Employé introuvable.' }); return; }
        if (emp.clerkUserId) { res.status(400).json({ error: 'Cet employé a déjà un accès de connexion.' }); return; }
        const secretKey = process.env.CLERK_SECRET_KEY;
        const clerk = createClerkClient({ secretKey });
        const parts = String(emp.fullName || '').trim().split(/\s+/);
        const firstName = parts.shift() || undefined;
        const lastName = parts.length ? parts.join(' ') : undefined;
        // Même patron que superuser-tenants.js (createFirstAdmin) et admin-access.js (EPD) : mot de
        // passe temporaire marqué "compromis" pour forcer une réinitialisation à la première connexion.
        const user = await clerk.users.createUser({
          emailAddress: [email],
          password,
          firstName,
          lastName,
          skipPasswordChecks: true,
          publicMetadata: { tenantId, role: 'employee', employeeItemId: emp.id, employeeName: emp.fullName },
        });
        await clerk.users.setPasswordCompromised(user.id, { revokeAllSessions: true });
        await db.update(schema.employees).set({ clerkUserId: user.id, email: emp.email || email })
          .where(eq(schema.employees.id, id));
        res.status(200).json({ ok: true, clerkUserId: user.id });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Gestion des accès (Portail — admin / lecture seule DE CE TENANT) =====
    // Réservé aux comptes à accès complet (role === 'admin' — un compte "lecture-seule" ne peut
    // donc pas modifier les accès des autres, ni le sien) — même patron que admin-access.js côté
    // EPD, mais scopé au tenantId de l'appelant (jamais aux autres entreprises ni à EPD/superuser).
    // Ne concerne PAS les comptes employés (module Poinçon mobile, gérés dans resource 'employees').
    //   action: list      {}
    //   action: create    { name, email, password, role }   // role: 'admin' | 'lecture-seule' (défaut 'admin')
    //   action: setRole   { clerkUserId, role }
    //   action: remove    { clerkUserId }
    if (resource === 'tenantAccess') {
      if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs à accès complet de votre entreprise.' }); return; }
      const secretKey = process.env.CLERK_SECRET_KEY;
      if (!secretKey) { res.status(500).json({ error: 'Configuration serveur incomplète.' }); return; }
      const clerk = createClerkClient({ secretKey });
      const callerId = ctx.callerId;

      if (action === 'list') {
        const list = await clerk.users.getUserList({ limit: 200 });
        const rawUsers = Array.isArray(list) ? list : (list.data || []);
        const users = rawUsers
          .filter(u => {
            const m = u.publicMetadata || {};
            if (m.tenantId !== tenantId) return false;
            return m.role !== 'employee' && m.role !== 'employee_disabled';
          })
          .map(u => ({
            clerkUserId: u.id,
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || '(sans nom)',
            email: (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || '',
            role: (u.publicMetadata && u.publicMetadata.role === 'lecture-seule') ? 'lecture-seule' : 'admin',
            isSelf: u.id === callerId,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        res.status(200).json({ users });
        return;
      }

      if (action === 'setRole') {
        const { clerkUserId, role: newRole } = req.body || {};
        if (!clerkUserId || (newRole !== 'admin' && newRole !== 'lecture-seule')) {
          res.status(400).json({ error: "clerkUserId et role ('admin' ou 'lecture-seule') sont requis." });
          return;
        }
        if (clerkUserId === callerId) { res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre accès.' }); return; }
        const user = await clerk.users.getUser(clerkUserId);
        if (!user.publicMetadata || user.publicMetadata.tenantId !== tenantId) {
          res.status(403).json({ error: "Ce compte n'appartient pas à votre entreprise." });
          return;
        }
        const nextMeta = Object.assign({}, user.publicMetadata || {}, { role: newRole === 'admin' ? 'admin' : 'lecture-seule' });
        await clerk.users.updateUser(clerkUserId, { publicMetadata: nextMeta });
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'create') {
        const { name, email, password, role: newRole } = req.body || {};
        if (!email || !password) { res.status(400).json({ error: 'email et password sont requis.' }); return; }
        if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }
        const parts = String(name || '').trim().split(/\s+/);
        const firstName = parts.shift() || undefined;
        const lastName = parts.length ? parts.join(' ') : undefined;
        const user = await clerk.users.createUser({
          emailAddress: [email],
          password,
          firstName,
          lastName,
          skipPasswordChecks: true,
          publicMetadata: { tenantId, role: newRole === 'lecture-seule' ? 'lecture-seule' : 'admin' },
        });
        await clerk.users.setPasswordCompromised(user.id, { revokeAllSessions: true });
        res.status(200).json({ ok: true, clerkUserId: user.id });
        return;
      }

      if (action === 'remove') {
        const { clerkUserId } = req.body || {};
        if (!clerkUserId) { res.status(400).json({ error: 'clerkUserId est requis.' }); return; }
        if (clerkUserId === callerId) { res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre accès.' }); return; }
        const user = await clerk.users.getUser(clerkUserId);
        if (!user.publicMetadata || user.publicMetadata.tenantId !== tenantId) {
          res.status(403).json({ error: "Ce compte n'appartient pas à votre entreprise." });
          return;
        }
        await clerk.users.deleteUser(clerkUserId);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Projets =====================
    if (resource === 'projects') {
      if (ctx.role !== 'admin' && ctx.role !== 'lecture-seule') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      if (ctx.role !== 'admin' && action !== 'list') { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
      if (action === 'list') {
        const rows = await db.select().from(schema.projects).where(eq(schema.projects.tenantId, tenantId));
        res.status(200).json({ projects: rows });
        return;
      }
      if (action === 'create') {
        const { name, code, address, lat, lng, status, numAvantage, horsCcq, rayonM } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom du projet est requis.' }); return; }
        if (address && (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))) {
          res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
          return;
        }
        let rayon = 500;
        if (rayonM !== undefined && rayonM !== null && rayonM !== '') {
          const n = Number(rayonM);
          if (!isFinite(n) || n <= 0) { res.status(400).json({ error: 'Le rayon toléré doit être un nombre positif.' }); return; }
          rayon = Math.round(n);
        }
        const [row] = await db.insert(schema.projects).values({
          tenantId, name, code: code || null, address: address || null,
          lat: address ? lat : null, lng: address ? lng : null,
          status: VALID_PROJECT_STATUSES.includes(status) ? status : 'en_planification',
          numAvantage: numAvantage || null,
          horsCcq: !!horsCcq,
          rayonM: rayon,
        }).returning();
        res.status(200).json({ ok: true, project: row });
        return;
      }
      if (action === 'update') {
        const { id, name, code, address, lat, lng, status, numAvantage, horsCcq, rayonM } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (code !== undefined) patch.code = code || null;
        if (address !== undefined) {
          if (address && (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))) {
            res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
            return;
          }
          patch.address = address || null;
          patch.lat = address ? lat : null;
          patch.lng = address ? lng : null;
        }
        if (status !== undefined) {
          if (!VALID_PROJECT_STATUSES.includes(status)) { res.status(400).json({ error: 'Statut invalide.' }); return; }
          patch.status = status;
        }
        if (numAvantage !== undefined) patch.numAvantage = numAvantage || null;
        if (horsCcq !== undefined) patch.horsCcq = !!horsCcq;
        if (rayonM !== undefined) {
          const n = Number(rayonM);
          if (!isFinite(n) || n <= 0) { res.status(400).json({ error: 'Le rayon toléré doit être un nombre positif.' }); return; }
          patch.rayonM = Math.round(n);
        }
        await db.update(schema.projects).set(patch)
          .where(and(eq(schema.projects.id, id), eq(schema.projects.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'remove') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.projects)
          .where(and(eq(schema.projects.id, id), eq(schema.projects.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Configuration =====================
    if (resource === 'config') {
      if (ctx.role !== 'admin' && ctx.role !== 'lecture-seule') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      if (ctx.role !== 'admin' && action !== 'get') { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
      if (action === 'get') {
        const [settings] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
        const jobTitles = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.tenantId, tenantId));
        const primes = await db.select().from(schema.primes).where(eq(schema.primes.tenantId, tenantId));
        const taches = await db.select().from(schema.taches).where(eq(schema.taches.tenantId, tenantId));
        res.status(200).json({ settings: settings || null, jobTitles, primes, taches });
        return;
      }
      if (action === 'updateSettings') {
        const { primesEnabled, payrollSoftware, companyName, companyAddress, companyLogo, companyCodeAvantage,
          pauseMatinMin, pauseDinerMin, pausePmMin } = req.body || {};
        const patch = {
          primesEnabled: !!primesEnabled,
          payrollSoftware: payrollSoftware || null,
        };
        if (companyName !== undefined) patch.companyName = companyName || null;
        if (companyAddress !== undefined) patch.companyAddress = companyAddress || null;
        if (companyLogo !== undefined) patch.companyLogo = companyLogo || null;
        if (companyCodeAvantage !== undefined) patch.companyCodeAvantage = companyCodeAvantage || null;
        // Durées de pause configurables (min. 0, entier) — voir Configuration → Pauses.
        if (pauseMatinMin !== undefined) patch.pauseMatinMin = Math.max(0, Math.round(Number(pauseMatinMin)) || 0);
        if (pauseDinerMin !== undefined) patch.pauseDinerMin = Math.max(0, Math.round(Number(pauseDinerMin)) || 0);
        if (pausePmMin !== undefined) patch.pausePmMin = Math.max(0, Math.round(Number(pausePmMin)) || 0);
        await db.update(schema.tenantSettings)
          .set(patch)
          .where(eq(schema.tenantSettings.tenantId, tenantId));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createTache') {
        const { jobTitleId, name, ccq, codeAvantage } = req.body || {};
        if (!jobTitleId || !name) { res.status(400).json({ error: 'jobTitleId et name sont requis.' }); return; }
        const [jt] = await db.select().from(schema.jobTitles)
          .where(and(eq(schema.jobTitles.id, jobTitleId), eq(schema.jobTitles.tenantId, tenantId)));
        if (!jt) { res.status(404).json({ error: 'Métier introuvable.' }); return; }
        const [row] = await db.insert(schema.taches).values({
          tenantId, jobTitleId, name,
          ccq: ccq === undefined ? true : !!ccq,
          codeAvantage: codeAvantage || null,
        }).returning();
        res.status(200).json({ ok: true, tache: row });
        return;
      }
      if (action === 'updateTache') {
        const { id, name, ccq, codeAvantage } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (ccq !== undefined) patch.ccq = !!ccq;
        if (codeAvantage !== undefined) patch.codeAvantage = codeAvantage || null;
        await db.update(schema.taches).set(patch)
          .where(and(eq(schema.taches.id, id), eq(schema.taches.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'deleteTache') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.taches)
          .where(and(eq(schema.taches.id, id), eq(schema.taches.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createJobTitle') {
        const { name } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom est requis.' }); return; }
        const [row] = await db.insert(schema.jobTitles).values({ tenantId, name }).returning();
        res.status(200).json({ ok: true, jobTitle: row });
        return;
      }
      if (action === 'updateJobTitle') {
        const { id, name } = req.body || {};
        if (!id || !name) { res.status(400).json({ error: 'id et name sont requis.' }); return; }
        await db.update(schema.jobTitles).set({ name })
          .where(and(eq(schema.jobTitles.id, id), eq(schema.jobTitles.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'deleteJobTitle') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.jobTitles)
          .where(and(eq(schema.jobTitles.id, id), eq(schema.jobTitles.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createPrime') {
        const { name, percentage, code } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom est requis.' }); return; }
        const [row] = await db.insert(schema.primes).values({
          tenantId, name, percentage: percentage || null, code: code || null,
        }).returning();
        res.status(200).json({ ok: true, prime: row });
        return;
      }
      if (action === 'updatePrime') {
        const { id, name, percentage, code } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (percentage !== undefined) patch.percentage = percentage || null;
        if (code !== undefined) patch.code = code || null;
        await db.update(schema.primes).set(patch)
          .where(and(eq(schema.primes.id, id), eq(schema.primes.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'deletePrime') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.primes)
          .where(and(eq(schema.primes.id, id), eq(schema.primes.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Poinçon — employé =====================
    if (resource === 'punches') {
      if (ctx.role !== 'employee' || !ctx.claims.employeeItemId) {
        res.status(403).json({ error: "Ce compte n'a pas accès à l'interface de poinçon." });
        return;
      }
      const employeeId = String(ctx.claims.employeeItemId);
      const [me] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, employeeId), eq(schema.employees.tenantId, tenantId)));
      if (!me || me.status !== 'actif') {
        res.status(403).json({ error: 'Ce compte employé est inactif.' });
        return;
      }

      if (action === 'activeProjects') {
        const rows = await db.select().from(schema.projects)
          .where(and(eq(schema.projects.tenantId, tenantId), eq(schema.projects.status, 'en_cours')));
        res.status(200).json({ projects: rows });
        return;
      }

      if (action === 'myTaches') {
        // Liste des tâches configurées (Configuration > Métiers & Tâches) pour le métier de
        // l'employé — utilisée par mon-poincon.html pour afficher (ou non) le sélecteur de tâche.
        if (!me.jobTitle) { res.status(200).json({ taches: [] }); return; }
        const [jt] = await db.select().from(schema.jobTitles)
          .where(and(eq(schema.jobTitles.tenantId, tenantId), eq(schema.jobTitles.name, me.jobTitle)));
        if (!jt) { res.status(200).json({ taches: [] }); return; }
        const taches = await db.select().from(schema.taches)
          .where(and(eq(schema.taches.tenantId, tenantId), eq(schema.taches.jobTitleId, jt.id)));
        res.status(200).json({ taches });
        return;
      }

      if (action === 'start') {
        const { projectId, lat, lng, clientTimestamp, tache } = req.body || {};
        if (!projectId) { res.status(400).json({ error: 'Projet manquant.' }); return; }
        if (!isValidCoord(lat) || !isValidCoord(lng)) {
          res.status(400).json({ error: 'Localisation (GPS) requise pour débuter un poinçon. Veuillez activer la localisation.' });
          return;
        }
        const clockError = checkClientClock(clientTimestamp);
        if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
        const [project] = await db.select().from(schema.projects)
          .where(and(eq(schema.projects.id, projectId), eq(schema.projects.tenantId, tenantId)));
        if (!project || project.status !== 'en_cours') {
          res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
          return;
        }
        const tacheResult = await resolveTache(db, schema, tenantId, me.jobTitle, project, tache);
        if (!tacheResult.ok) { res.status(400).json({ error: tacheResult.error }); return; }

        // Évite un doublon si l'employé a déjà un poinçon ouvert.
        const [openPunch] = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId), eq(schema.punches.status, OPEN_PUNCH_STATUS)));
        if (openPunch) { res.status(200).json({ punch: openPunch, resumed: true }); return; }

        const now = new Date();
        const kmTraveled = haversineKm(me.homeLat, me.homeLng, project.lat, project.lng);
        const primeApplied = !!me.primeId;
        const [row] = await db.insert(schema.punches).values({
          tenantId, employeeId, projectId, clockIn: now, status: OPEN_PUNCH_STATUS,
          gpsLatIn: lat, gpsLngIn: lng, kmTraveled, primeApplied, tache: tacheResult.tache,
        }).returning();
        res.status(200).json({ punch: row, resumed: false });
        return;
      }

      if (action === 'switch') {
        const { punchId, newProjectId, lat, lng, clientTimestamp, tache } = req.body || {};
        if (!punchId || !newProjectId) { res.status(400).json({ error: 'Poinçon ou nouveau projet manquant.' }); return; }
        if (!isValidCoord(lat) || !isValidCoord(lng)) {
          res.status(400).json({ error: 'Localisation (GPS) requise pour changer de chantier. Veuillez activer la localisation.' });
          return;
        }
        const clockError = checkClientClock(clientTimestamp);
        if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
        const [punch] = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.id, punchId), eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status !== OPEN_PUNCH_STATUS) { res.status(400).json({ error: 'Ce poinçon est déjà terminé.' }); return; }
        const [newProject] = await db.select().from(schema.projects)
          .where(and(eq(schema.projects.id, newProjectId), eq(schema.projects.tenantId, tenantId)));
        if (!newProject || newProject.status !== 'en_cours') {
          res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
          return;
        }
        const tacheResult = await resolveTache(db, schema, tenantId, me.jobTitle, newProject, tache);
        if (!tacheResult.ok) { res.status(400).json({ error: tacheResult.error }); return; }

        // Ferme le segment actif à l'heure arrondie au quart d'heure, et ouvre le nouveau segment
        // EXACTEMENT à cette même heure — aucune seconde perdue ni dupliquée (même patron que
        // api/punch.js chez EPD).
        const rounded = roundToNearest15(new Date());
        const [oldProject] = await db.select().from(schema.projects)
          .where(and(eq(schema.projects.id, punch.projectId), eq(schema.projects.tenantId, tenantId)));
        const [closed] = await db.update(schema.punches).set({
          clockOut: rounded, gpsLatOut: lat, gpsLngOut: lng, status: 'ferme',
          kmTraveled: haversineKm(me.homeLat, me.homeLng, oldProject ? oldProject.lat : null, oldProject ? oldProject.lng : null),
        }).where(eq(schema.punches.id, punchId)).returning();

        const [created] = await db.insert(schema.punches).values({
          tenantId, employeeId, projectId: newProjectId, clockIn: rounded, status: OPEN_PUNCH_STATUS,
          gpsLatIn: lat, gpsLngIn: lng,
          kmTraveled: haversineKm(me.homeLat, me.homeLng, newProject.lat, newProject.lng),
          primeApplied: !!me.primeId, tache: tacheResult.tache,
        }).returning();

        res.status(200).json({ closedPunch: closed, newPunch: created });
        return;
      }

      if (action === 'finish') {
        const { punchId, lat, lng, breakMorning, breakLunch, breakAfternoon, clientTimestamp } = req.body || {};
        if (!punchId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }
        if (!isValidCoord(lat) || !isValidCoord(lng)) {
          res.status(400).json({ error: 'Localisation (GPS) requise pour terminer un poinçon. Veuillez activer la localisation.' });
          return;
        }
        const clockError = checkClientClock(clientTimestamp);
        if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
        const [punch] = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.id, punchId), eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status !== OPEN_PUNCH_STATUS) { res.status(400).json({ error: 'Ce poinçon est déjà terminé.' }); return; }

        const now = new Date();
        const [row] = await db.update(schema.punches).set({
          clockOut: now, gpsLatOut: lat, gpsLngOut: lng, status: 'ferme',
          breakMorning: !!breakMorning, breakLunch: !!breakLunch, breakAfternoon: !!breakAfternoon,
        }).where(eq(schema.punches.id, punchId)).returning();

        const hours = computePunchHours(row, pauseConfig);
        res.status(200).json({ punch: row, ...hours });
        return;
      }

      if (action === 'editPending') {
        // Permet à l'employé de corriger lui-même un poinçon déjà fermé, mais seulement tant
        // qu'il n'a pas encore été traité (approuvé/rejeté/exporté) par l'admin.
        const { punchId, projectId, breakMorning, breakLunch, breakAfternoon, tache } = req.body || {};
        if (!punchId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }
        const [punch] = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.id, punchId), eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status !== 'ferme') {
          res.status(403).json({ error: 'Ce poinçon a déjà été traité par l\'administrateur et ne peut plus être modifié.' });
          return;
        }
        const patch = {};
        if (breakMorning !== undefined) patch.breakMorning = !!breakMorning;
        if (breakLunch !== undefined) patch.breakLunch = !!breakLunch;
        if (breakAfternoon !== undefined) patch.breakAfternoon = !!breakAfternoon;
        let effectiveProject = null;
        if (projectId !== undefined && projectId !== punch.projectId) {
          const [project] = await db.select().from(schema.projects)
            .where(and(eq(schema.projects.id, projectId), eq(schema.projects.tenantId, tenantId)));
          if (!project || project.status !== 'en_cours') {
            res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
            return;
          }
          patch.projectId = projectId;
          patch.kmTraveled = haversineKm(me.homeLat, me.homeLng, project.lat, project.lng);
          effectiveProject = project;
        } else {
          const [project] = await db.select().from(schema.projects)
            .where(and(eq(schema.projects.id, punch.projectId), eq(schema.projects.tenantId, tenantId)));
          effectiveProject = project || null;
        }
        if (tache !== undefined) {
          const tacheResult = await resolveTache(db, schema, tenantId, me.jobTitle, effectiveProject, tache);
          if (!tacheResult.ok) { res.status(400).json({ error: tacheResult.error }); return; }
          patch.tache = tacheResult.tache;
        }
        if (!Object.keys(patch).length) { res.status(400).json({ error: 'Aucune modification envoyée.' }); return; }
        const [row] = await db.update(schema.punches).set(patch).where(eq(schema.punches.id, punchId)).returning();
        res.status(200).json({ punch: row, ...computePunchHours(row, pauseConfig) });
        return;
      }

      if (action === 'listToday') {
        const todayKey = torontoDateKey(new Date());
        const rows = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        const todays = rows.filter(r => r.clockIn && torontoDateKey(new Date(r.clockIn)) === todayKey);
        res.status(200).json({ punches: todays.map(r => ({ ...r, ...computePunchHours(r, pauseConfig) })) });
        return;
      }

      if (action === 'listHistory') {
        const { weekStart } = req.body || {};
        const wk = weekStart || sundayOfWeek(torontoDateKey(new Date()));
        const rows = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        const nextWk = addDays(wk, 7);
        const weekRows = rows.filter(r => r.clockIn && torontoDateKey(new Date(r.clockIn)) >= wk && torontoDateKey(new Date(r.clockIn)) < nextWk);
        const projectIds = [...new Set(weekRows.map(r => r.projectId).filter(Boolean))];
        const projects = projectIds.length
          ? await db.select().from(schema.projects).where(and(eq(schema.projects.tenantId, tenantId)))
          : [];
        const projectMap = Object.fromEntries(projects.map(p => [p.id, p]));
        res.status(200).json({
          weekStart: wk,
          punches: weekRows
            .sort((a, b) => new Date(a.clockIn) - new Date(b.clockIn))
            .map(r => ({ ...r, ...computePunchHours(r, pauseConfig), projectName: (projectMap[r.projectId] || {}).name || null })),
        });
        return;
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Poinçon — administration =====================
    if (resource === 'punchesAdmin') {
      if (ctx.role !== 'admin' && ctx.role !== 'lecture-seule') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      // Un compte "lecture-seule" peut consulter (Tableau de bord, Vue de la semaine/employé/
      // projet) et générer l'export de paie, mais ne peut rien modifier, approuver, rejeter,
      // restaurer ni ajouter de poinçon manuellement (parité EPD — voir READONLY_LOCK_SELECTOR
      // côté mon-entreprise.html et admin-access.js côté EPD).
      const PUNCHESADMIN_READONLY_ALLOWED = ['listWeek', 'listByEmployee', 'listByProject', 'listToday', 'exportPayroll'];
      if (ctx.role !== 'admin' && !PUNCHESADMIN_READONLY_ALLOWED.includes(action)) {
        res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' });
        return;
      }

      async function weekPunchesWithNames(weekStart) {
        const nextWk = addDays(weekStart, 7);
        const rows = await db.select().from(schema.punches).where(eq(schema.punches.tenantId, tenantId));
        const weekRows = rows.filter(r => r.clockIn && torontoDateKey(new Date(r.clockIn)) >= weekStart && torontoDateKey(new Date(r.clockIn)) < nextWk);
        const employees = await db.select().from(schema.employees).where(eq(schema.employees.tenantId, tenantId));
        const projects = await db.select().from(schema.projects).where(eq(schema.projects.tenantId, tenantId));
        const empMap = Object.fromEntries(employees.map(e => [e.id, e]));
        const projMap = Object.fromEntries(projects.map(p => [p.id, p]));
        return weekRows
          .sort((a, b) => new Date(a.clockIn) - new Date(b.clockIn))
          .map(r => {
            const proj = projMap[r.projectId] || {};
            return {
              ...r,
              ...computePunchHours(r, pauseConfig),
              employeeName: (empMap[r.employeeId] || {}).fullName || '(supprimé)',
              employeeNumber: (empMap[r.employeeId] || {}).employeeNumber || null,
              employeeJobTitle: (empMap[r.employeeId] || {}).jobTitle || null,
              employeePrimeId: (empMap[r.employeeId] || {}).primeId || null,
              employeeExcludeFromPayroll: !!(empMap[r.employeeId] || {}).excludeFromPayroll,
              projectName: proj.name || null,
              projectLat: proj.lat != null ? proj.lat : null,
              projectLng: proj.lng != null ? proj.lng : null,
              projectRayonM: proj.rayonM != null ? proj.rayonM : 500,
              projectHorsCcq: !!proj.horsCcq,
              projectNumAvantage: proj.numAvantage || null,
            };
          });
      }

      if (action === 'listWeek') {
        const { weekStart } = req.body || {};
        const wk = weekStart || sundayOfWeek(torontoDateKey(new Date()));
        res.status(200).json({ weekStart: wk, punches: await weekPunchesWithNames(wk) });
        return;
      }

      if (action === 'listByEmployee') {
        const { employeeId, weekStart } = req.body || {};
        if (!employeeId) { res.status(400).json({ error: 'employeeId est requis.' }); return; }
        const wk = weekStart || sundayOfWeek(torontoDateKey(new Date()));
        const all = await weekPunchesWithNames(wk);
        res.status(200).json({ weekStart: wk, punches: all.filter(p => p.employeeId === employeeId) });
        return;
      }

      if (action === 'listByProject') {
        const { projectId, weekStart } = req.body || {};
        if (!projectId) { res.status(400).json({ error: 'projectId est requis.' }); return; }
        const wk = weekStart || sundayOfWeek(torontoDateKey(new Date()));
        const all = await weekPunchesWithNames(wk);
        res.status(200).json({ weekStart: wk, punches: all.filter(p => p.projectId === projectId) });
        return;
      }

      // Tableau de bord — tous les poinçons d'AUJOURD'HUI (tenant entier, tous employés/projets),
      // avec noms + coordonnées GPS déjà jointes (mêmes champs que listWeek) — parité loadDashboard
      // côté EPD (admin.html), sans le volet "planifiés aujourd'hui" (pas encore de module de
      // planification pour les tenants Postgres).
      if (action === 'listToday') {
        const wk = sundayOfWeek(torontoDateKey(new Date()));
        const todayKey = torontoDateKey(new Date());
        const all = await weekPunchesWithNames(wk);
        res.status(200).json({ punches: all.filter(p => p.clockIn && torontoDateKey(new Date(p.clockIn)) === todayKey) });
        return;
      }

      if (action === 'manualAdd') {
        const { employeeId, projectId, date, clockIn, clockOut, tache, breakMorning, breakLunch, breakAfternoon } = req.body || {};
        if (!employeeId || !projectId || !date) { res.status(400).json({ error: 'employeeId, projectId et date sont requis.' }); return; }
        if (!clockIn && !clockOut) { res.status(400).json({ error: "Au moins l'une des deux heures (début ou fin) est requise." }); return; }
        const [emp] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, employeeId), eq(schema.employees.tenantId, tenantId)));
        if (!emp) { res.status(404).json({ error: 'Employé introuvable.' }); return; }
        const [project] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.tenantId, tenantId)));
        if (!project) { res.status(404).json({ error: 'Projet introuvable.' }); return; }
        // Mode "souple" (strict:false) : un ajout manuel par l'admin ne doit pas être bloqué par
        // l'absence de tâche (utile pour les entrées historiques ou les tenants sans Tâches
        // configurées), mais la restriction Hors CCQ du projet reste appliquée si une tâche est fournie.
        const tacheResult = await resolveTache(db, schema, tenantId, emp.jobTitle, project, tache, { strict: false });
        if (!tacheResult.ok) { res.status(400).json({ error: tacheResult.error }); return; }
        const clockInDate = clockIn ? new Date(`${date}T${clockIn}:00`) : null;
        const clockOutDate = clockOut ? new Date(`${date}T${clockOut}:00`) : null;
        if (clockInDate && clockOutDate && await hasOverlap(db, schema, tenantId, employeeId, clockInDate, clockOutDate)) {
          res.status(400).json({ error: 'Ce poinçon chevauche un poinçon existant pour cet employé (double paiement évité).' });
          return;
        }
        const [row] = await db.insert(schema.punches).values({
          tenantId, employeeId, projectId,
          clockIn: clockInDate, clockOut: clockOutDate,
          status: clockOutDate ? 'ferme' : OPEN_PUNCH_STATUS,
          kmTraveled: haversineKm(emp.homeLat, emp.homeLng, project.lat, project.lng),
          primeApplied: !!emp.primeId, tache: tacheResult.tache,
          // Pauses (matin/dîner/PM) — mêmes 3 cases que le formulaire d'ajout manuel EPD (parité
          // admin.html manualAddFormHtml), défaut matin/dîner pris, PM non pris.
          breakMorning: breakMorning === undefined ? true : !!breakMorning,
          breakLunch: breakLunch === undefined ? true : !!breakLunch,
          breakAfternoon: !!breakAfternoon,
        }).returning();
        res.status(200).json({ ok: true, punch: row });
        return;
      }

      if (action === 'editPunch') {
        const { id, patch: rawPatch } = req.body || {};
        if (!id || !rawPatch) { res.status(400).json({ error: 'id et patch sont requis.' }); return; }
        const [punch] = await db.select().from(schema.punches).where(and(eq(schema.punches.id, id), eq(schema.punches.tenantId, tenantId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status === 'exporte') { res.status(400).json({ error: 'Ce poinçon a déjà été exporté à la paie et ne peut plus être modifié.' }); return; }
        const patch = {};
        if (rawPatch.projectId !== undefined) patch.projectId = rawPatch.projectId;
        if (rawPatch.clockIn !== undefined) patch.clockIn = rawPatch.clockIn ? new Date(rawPatch.clockIn) : null;
        if (rawPatch.clockOut !== undefined) patch.clockOut = rawPatch.clockOut ? new Date(rawPatch.clockOut) : null;
        if (rawPatch.breakMorning !== undefined) patch.breakMorning = !!rawPatch.breakMorning;
        if (rawPatch.breakLunch !== undefined) patch.breakLunch = !!rawPatch.breakLunch;
        if (rawPatch.breakAfternoon !== undefined) patch.breakAfternoon = !!rawPatch.breakAfternoon;
        if (rawPatch.overtime15 !== undefined) patch.overtime15 = (rawPatch.overtime15 === null || rawPatch.overtime15 === '') ? null : Number(rawPatch.overtime15);
        if (rawPatch.overtime2 !== undefined) patch.overtime2 = (rawPatch.overtime2 === null || rawPatch.overtime2 === '') ? null : Number(rawPatch.overtime2);
        if (rawPatch.kmTraveled !== undefined) patch.kmTraveled = (rawPatch.kmTraveled === null || rawPatch.kmTraveled === '') ? null : Number(rawPatch.kmTraveled);
        if (rawPatch.primeApplied !== undefined) patch.primeApplied = !!rawPatch.primeApplied;
        const [emp] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, punch.employeeId), eq(schema.employees.tenantId, tenantId)));
        if (rawPatch.tache !== undefined) {
          const effProjectId = patch.projectId !== undefined ? patch.projectId : punch.projectId;
          const [proj] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, effProjectId), eq(schema.projects.tenantId, tenantId)));
          const tacheResult = await resolveTache(db, schema, tenantId, emp ? emp.jobTitle : null, proj, rawPatch.tache, { strict: false });
          if (!tacheResult.ok) { res.status(400).json({ error: tacheResult.error }); return; }
          patch.tache = tacheResult.tache;
        }

        const nextClockIn = patch.clockIn !== undefined ? patch.clockIn : punch.clockIn;
        const nextClockOut = patch.clockOut !== undefined ? patch.clockOut : punch.clockOut;
        if (nextClockIn && nextClockOut && await hasOverlap(db, schema, tenantId, punch.employeeId, nextClockIn, nextClockOut, id)) {
          res.status(400).json({ error: 'Ce poinçon chevauche un poinçon existant pour cet employé (double paiement évité).' });
          return;
        }

        // Valide le temps 1.5x/2x AVANT d'écrire : jamais sur une tâche Hors CCQ, et jamais
        // au-delà des heures Ajusté qui résulteront de cette modification — ce sont des heures
        // RÉPARTIES parmi l'Ajusté, pas des heures ajoutées (parité EPD — saveDayGroup()/exportTxt()).
        const nextOvertime15 = patch.overtime15 !== undefined ? patch.overtime15 : punch.overtime15;
        const nextOvertime2 = patch.overtime2 !== undefined ? patch.overtime2 : punch.overtime2;
        if ((Number(nextOvertime15) || 0) + (Number(nextOvertime2) || 0) > 0) {
          const effectiveTacheName = patch.tache !== undefined ? patch.tache : punch.tache;
          let tacheIsHorsCcq = false;
          if (effectiveTacheName && emp && emp.jobTitle) {
            const [jt] = await db.select().from(schema.jobTitles)
              .where(and(eq(schema.jobTitles.tenantId, tenantId), eq(schema.jobTitles.name, emp.jobTitle)));
            if (jt) {
              const [tacheRow] = await db.select().from(schema.taches)
                .where(and(eq(schema.taches.tenantId, tenantId), eq(schema.taches.jobTitleId, jt.id), eq(schema.taches.name, effectiveTacheName)));
              if (tacheRow && !tacheRow.ccq) tacheIsHorsCcq = true;
            }
          }
          if (tacheIsHorsCcq) {
            res.status(400).json({ error: 'Temps 1.5x/2x impossible sur une tâche Hors CCQ.' });
            return;
          }
          const nextBreakMorning = patch.breakMorning !== undefined ? patch.breakMorning : punch.breakMorning;
          const nextBreakLunch = patch.breakLunch !== undefined ? patch.breakLunch : punch.breakLunch;
          const nextBreakAfternoon = patch.breakAfternoon !== undefined ? patch.breakAfternoon : punch.breakAfternoon;
          const projected = computePunchHours({ clockIn: nextClockIn, clockOut: nextClockOut, breakMorning: nextBreakMorning, breakLunch: nextBreakLunch, breakAfternoon: nextBreakAfternoon }, pauseConfig);
          const ajusteH = projected.ajusteH || 0;
          if ((Number(nextOvertime15) || 0) + (Number(nextOvertime2) || 0) > ajusteH + 0.01) {
            res.status(400).json({ error: `Le total temps 1.5x + 2x dépasse les heures Ajusté de ce poinçon (${ajusteH.toFixed(2)} h).` });
            return;
          }
        }

        const [row] = await db.update(schema.punches).set(patch).where(eq(schema.punches.id, id)).returning();
        res.status(200).json({ ok: true, punch: row, ...computePunchHours(row, pauseConfig) });
        return;
      }

      if (action === 'approve') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const [punch] = await db.select().from(schema.punches).where(and(eq(schema.punches.id, id), eq(schema.punches.tenantId, tenantId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status === OPEN_PUNCH_STATUS) { res.status(400).json({ error: 'Ce poinçon est toujours en cours — impossible de l\'approuver.' }); return; }
        if (punch.status === 'exporte') { res.status(400).json({ error: 'Ce poinçon a déjà été exporté.' }); return; }
        await db.update(schema.punches).set({ status: 'approuve' }).where(eq(schema.punches.id, id));
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'reject') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const [punch] = await db.select().from(schema.punches).where(and(eq(schema.punches.id, id), eq(schema.punches.tenantId, tenantId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status === OPEN_PUNCH_STATUS) { res.status(400).json({ error: 'Ce poinçon est toujours en cours — impossible de le rejeter.' }); return; }
        if (punch.status === 'exporte') { res.status(400).json({ error: 'Ce poinçon a déjà été exporté.' }); return; }
        await db.update(schema.punches).set({ status: 'rejete' }).where(eq(schema.punches.id, id));
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'restore') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const [punch] = await db.select().from(schema.punches).where(and(eq(schema.punches.id, id), eq(schema.punches.tenantId, tenantId)));
        if (!punch) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
        if (punch.status === 'exporte') { res.status(400).json({ error: 'Ce poinçon a déjà été exporté et ne peut plus être restauré.' }); return; }
        if (await hasOverlap(db, schema, tenantId, punch.employeeId, punch.clockIn, punch.clockOut, id)) {
          res.status(400).json({ error: 'Restauration impossible : ce poinçon chevaucherait maintenant un autre poinçon existant.' });
          return;
        }
        await db.update(schema.punches).set({ status: 'ferme' }).where(eq(schema.punches.id, id));
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'exportPayroll') {
        const { weekStart } = req.body || {};
        const wk = weekStart || sundayOfWeek(torontoDateKey(new Date()));
        const punches = await weekPunchesWithNames(wk);
        if (!punches.length) { res.status(400).json({ error: 'Aucun poinçon pour cette semaine.' }); return; }
        const pending = punches.filter(p => PENDING_PUNCH_STATUSES.includes(p.status));
        if (pending.length) {
          res.status(400).json({ error: `${pending.length} poinçon(s) en attente de traitement (approbation/rejet) cette semaine — impossible d'exporter.` });
          return;
        }
        const approved = punches.filter(p => p.status === 'approuve');
        // Sommaire par employé : heures régulières (ajusté - temps 1.5x/2x déjà comptés à part par
        // l'admin), temps 1.5x, temps 2x, prime appliquée (oui si au moins un poinçon de la
        // semaine a primeApplied === true).
        const byEmployee = {};
        for (const p of approved) {
          const key = p.employeeId;
          if (!byEmployee[key]) {
            byEmployee[key] = { employeeName: p.employeeName, employeeNumber: p.employeeNumber, regularH: 0, overtime15H: 0, overtime2H: 0, prime: false };
          }
          const ot15 = Number(p.overtime15) || 0;
          const ot2 = Number(p.overtime2) || 0;
          const ajuste = p.ajusteH || 0;
          byEmployee[key].regularH += Math.max(0, ajuste - ot15 - ot2);
          byEmployee[key].overtime15H += ot15;
          byEmployee[key].overtime2H += ot2;
          if (p.primeApplied) byEmployee[key].prime = true;
        }
        const rows = Object.values(byEmployee).map(e => ({
          ...e,
          regularH: Math.round(e.regularH * 100) / 100,
          overtime15H: Math.round(e.overtime15H * 100) / 100,
          overtime2H: Math.round(e.overtime2H * 100) / 100,
        }));
        // Export générique CSV — toujours généré, indépendant du logiciel de paie configuré.
        const csvLines = ['Employé;N° employé;Heures régulières;Temps 1.5x;Temps 2x;Prime;Semaine du'];
        for (const r of rows) {
          csvLines.push([r.employeeName, r.employeeNumber || '', r.regularH, r.overtime15H, r.overtime2H, r.prime ? 'Oui' : 'Non', wk].join(';'));
        }

        // Export .txt exact format Avantage (SDK W08 — feuilles de temps), UNIQUEMENT si ce
        // tenant a réglé Configuration > Logiciel de paie = "Export Avantage" (voir schéma
        // parité EPD phase 5h/5i). Une ligne par poinçon approuvé — voir exportTxt() côté EPD
        // (admin.html) pour la référence exacte du format ; même structure de champs reproduite
        // ici à partir des données Postgres du tenant plutôt que des colonnes Monday.
        let avantageTxt = null;
        const missing = { emp: new Set(), proj: new Set(), tache: new Set() };
        const overtimeWarnings = [];
        const [settingsRow] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
        if (settingsRow && settingsRow.payrollSoftware === 'avantage') {
          const codeEntreprise = settingsRow.companyCodeAvantage || '';
          const weekEnd = addDays(wk, 6);
          const sdebut = wk.replace(/-/g, '/');
          const sfin = weekEnd.replace(/-/g, '/');
          const allTaches = await db.select().from(schema.taches).where(eq(schema.taches.tenantId, tenantId));
          const allJobTitles = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.tenantId, tenantId));
          const jobTitleByName = Object.fromEntries(allJobTitles.map(jt => [jt.name, jt]));
          const allPrimes = await db.select().from(schema.primes).where(eq(schema.primes.tenantId, tenantId));
          const primeById = Object.fromEntries(allPrimes.map(p => [p.id, p]));

          const fmtHoursFixed5 = h => Math.max(0, Number(h) || 0).toFixed(2).padStart(5, '0');
          const fmtPctFixed6 = pct => (Number(pct) / 100 || 0).toFixed(4);

          const approvedForPaie = approved.filter(p => !p.employeeExcludeFromPayroll);
          const lineEntries = [];
          approvedForPaie.forEach(p => {
            const jt = p.employeeJobTitle ? jobTitleByName[p.employeeJobTitle] : null;
            const tacheRow = jt ? allTaches.find(t => t.jobTitleId === jt.id && t.name === p.tache) : null;

            if (!p.employeeNumber) missing.emp.add(p.employeeName || p.employeeId);
            if (!p.projectNumAvantage) missing.proj.add(p.projectName || p.projectId);
            if (!tacheRow || !tacheRow.codeAvantage) missing.tache.add(p.tache || '(sans tâche)');

            const semp = String(p.employeeNumber || '').padStart(4, '0');
            const scont = p.projectNumAvantage || '';
            const smodnum = (tacheRow && tacheRow.codeAvantage) || '';

            const totalAjusteH = Number(p.ajusteH) || 0;
            const demiH = Number(p.overtime15) || 0;
            const doubleH = Number(p.overtime2) || 0;
            if (demiH + doubleH > totalAjusteH + 0.01) {
              overtimeWarnings.push(`${p.employeeName || '?'} (${torontoDateKey(new Date(p.clockIn))}) : temps 1.5x + 2x (${(demiH + doubleH).toFixed(2)}h) dépasse l'Ajusté (${totalAjusteH.toFixed(2)}h)`);
            }
            const regH = Math.round(Math.max(0, totalAjusteH - demiH - doubleH) * 100) / 100;

            let fields = `SEMP="${semp}",SDEBUT="${sdebut}",SFIN="${sfin}",SREG="${regH.toFixed(2)}"`;
            if (demiH > 0) fields += `,SDEM="${demiH.toFixed(2)}"`;
            if (doubleH > 0) fields += `,SDOU="${doubleH.toFixed(2)}"`;
            fields += `,SCONT="${scont}",SMODNUM="${smodnum}"`;

            const prime = p.employeePrimeId ? primeById[p.employeePrimeId] : null;
            if (prime && p.primeApplied && totalAjusteH > 0) {
              const primeCode = String(prime.code || '').slice(0, 5);
              if (primeCode) {
                fields += `,SPRIM="${primeCode}",SPRIPRC="${fmtPctFixed6(prime.percentage)}",SPRIREG="${fmtHoursFixed5(totalAjusteH)}"`;
              }
            }

            lineEntries.push(`W08,${codeEntreprise},${fields}`);
          });
          const lines = lineEntries.map((entry, i) => `RQ${i + 1},${entry}`);
          avantageTxt = lines.join('\r\n') + (lines.length ? '\r\n' : '');
        }

        await db.update(schema.punches).set({ status: 'exporte' })
          .where(inArray(schema.punches.id, approved.map(p => p.id)));
        res.status(200).json({
          ok: true, weekStart: wk, csv: csvLines.join('\n'), summary: rows,
          avantageTxt,
          avantageFilename: avantageTxt ? `${addDays(wk, 6)}.TXT` : null,
          warnings: avantageTxt ? {
            missingEmployeeCode: [...missing.emp],
            missingProjectNumAvantage: [...missing.proj],
            missingTacheCode: [...missing.tache],
            overtime: overtimeWarnings,
          } : null,
        });
        return;
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Messages (employé ↔ admin) =====================
    if (resource === 'tenantMessages') {
      if (action === 'send' || action === 'list' || action === 'markRead') {
        if (ctx.role !== 'employee' || !ctx.claims.employeeItemId) {
          res.status(403).json({ error: "Ce compte n'a pas accès à la messagerie employé." });
          return;
        }
        const employeeId = String(ctx.claims.employeeItemId);
        if (action === 'send') {
          const { body } = req.body || {};
          if (!body || !body.trim()) { res.status(400).json({ error: 'Le message est vide.' }); return; }
          const [row] = await db.insert(schema.tenantMessages).values({
            tenantId, employeeId, author: 'employee', body: body.trim(),
          }).returning();
          res.status(200).json({ ok: true, message: row });
          return;
        }
        if (action === 'list') {
          const rows = await db.select().from(schema.tenantMessages)
            .where(and(eq(schema.tenantMessages.tenantId, tenantId), eq(schema.tenantMessages.employeeId, employeeId)));
          res.status(200).json({ messages: rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) });
          return;
        }
        if (action === 'markRead') {
          await db.update(schema.tenantMessages).set({ readByEmployee: true })
            .where(and(eq(schema.tenantMessages.tenantId, tenantId), eq(schema.tenantMessages.employeeId, employeeId), eq(schema.tenantMessages.author, 'admin')));
          res.status(200).json({ ok: true });
          return;
        }
      }

      if (action === 'listAll' || action === 'thread' || action === 'reply') {
        if (ctx.role !== 'admin' && ctx.role !== 'lecture-seule') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
        // "reply" (envoyer un message) est une action de modification — non permise en lecture seule.
        if (ctx.role !== 'admin' && action === 'reply') { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
        if (action === 'listAll') {
          const employees = await db.select().from(schema.employees).where(eq(schema.employees.tenantId, tenantId));
          const messages = await db.select().from(schema.tenantMessages).where(eq(schema.tenantMessages.tenantId, tenantId));
          const byEmployee = {};
          for (const m of messages) {
            if (!byEmployee[m.employeeId]) byEmployee[m.employeeId] = [];
            byEmployee[m.employeeId].push(m);
          }
          const summary = employees
            .map(e => {
              const msgs = (byEmployee[e.id] || []).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
              const last = msgs[msgs.length - 1];
              const unread = msgs.filter(m => m.author === 'employee' && !m.readByAdmin).length;
              return last ? { employeeId: e.id, employeeName: e.fullName, lastMessage: last.body, lastAuthor: last.author, lastAt: last.createdAt, unread } : null;
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
          res.status(200).json({ threads: summary });
          return;
        }
        if (action === 'thread') {
          const { employeeId } = req.body || {};
          if (!employeeId) { res.status(400).json({ error: 'employeeId est requis.' }); return; }
          const rows = await db.select().from(schema.tenantMessages)
            .where(and(eq(schema.tenantMessages.tenantId, tenantId), eq(schema.tenantMessages.employeeId, employeeId)));
          await db.update(schema.tenantMessages).set({ readByAdmin: true })
            .where(and(eq(schema.tenantMessages.tenantId, tenantId), eq(schema.tenantMessages.employeeId, employeeId), eq(schema.tenantMessages.author, 'employee')));
          res.status(200).json({ messages: rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) });
          return;
        }
        if (action === 'reply') {
          const { employeeId, body } = req.body || {};
          if (!employeeId || !body || !body.trim()) { res.status(400).json({ error: 'employeeId et body sont requis.' }); return; }
          const [emp] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, employeeId), eq(schema.employees.tenantId, tenantId)));
          if (!emp) { res.status(404).json({ error: 'Employé introuvable.' }); return; }
          const [row] = await db.insert(schema.tenantMessages).values({
            tenantId, employeeId, author: 'admin', body: body.trim(),
          }).returning();
          res.status(200).json({ ok: true, message: row });
          return;
        }
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    res.status(400).json({ error: 'Resource inconnue.' });
  } catch (err) {
    const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
    res.status(502).json({ error: 'Erreur: ' + msg });
  }
};
