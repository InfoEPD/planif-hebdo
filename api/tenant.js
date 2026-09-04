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
//     action: start           { projectId, lat, lng, clientTimestamp }
//     action: switch          { punchId, newProjectId, lat, lng, clientTimestamp }
//     action: finish          { punchId, lat, lng, breakMorning, breakLunch, breakAfternoon, clientTimestamp }
//     action: editPending     { punchId, projectId, breakMorning, breakLunch, breakAfternoon }
//                             // uniquement si status === 'ferme' (pas encore traité par l'admin)
//     action: listToday       {}
//     action: listHistory     { weekStart }                            // weekStart = dimanche (YYYY-MM-DD), défaut semaine en cours
//
//   resource: 'punchesAdmin'   — réservé aux administrateurs
//     action: listWeek        { weekStart }
//     action: listByEmployee  { employeeId, weekStart }
//     action: listByProject   { projectId, weekStart }
//     action: manualAdd       { employeeId, projectId, date, clockIn, clockOut }   // heures locales HH:mm, l'une des deux optionnelle
//     action: editPunch       { id, patch: { projectId, clockIn, clockOut, breakMorning, breakLunch,
//                                             breakAfternoon, overtime15, overtime2, kmTraveled, primeApplied } }
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
function computePunchHours(punch) {
  if (!punch.clockIn || !punch.clockOut) return { brutH: null, ajusteH: null };
  const rawMin = Math.max(0, (new Date(punch.clockOut).getTime() - new Date(punch.clockIn).getTime()) / 60000);
  const brutMin = round15Min(rawMin);
  const finishMinutes = torontoMinutesOfDay(new Date(punch.clockOut));
  const lunchApplicable = finishMinutes >= 13 * 60;
  const afternoonApplicable = finishMinutes >= 14 * 60;
  const lunchAdjust = lunchApplicable ? (punch.breakLunch ? -30 : 0) : 0;
  const morningAdjust = punch.breakMorning ? 0 : 15;
  const afternoonAdjust = afternoonApplicable ? (punch.breakAfternoon ? 0 : 15) : 0;
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

  try {
    // ===================== Employés =====================
    if (resource === 'employees') {
      if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
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

    // ===================== Projets =====================
    if (resource === 'projects') {
      if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      if (action === 'list') {
        const rows = await db.select().from(schema.projects).where(eq(schema.projects.tenantId, tenantId));
        res.status(200).json({ projects: rows });
        return;
      }
      if (action === 'create') {
        const { name, code, address, lat, lng, status } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom du projet est requis.' }); return; }
        if (address && (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))) {
          res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
          return;
        }
        const [row] = await db.insert(schema.projects).values({
          tenantId, name, code: code || null, address: address || null,
          lat: address ? lat : null, lng: address ? lng : null,
          status: VALID_PROJECT_STATUSES.includes(status) ? status : 'en_planification',
        }).returning();
        res.status(200).json({ ok: true, project: row });
        return;
      }
      if (action === 'update') {
        const { id, name, code, address, lat, lng, status } = req.body || {};
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
      if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
      if (action === 'get') {
        const [settings] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
        const jobTitles = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.tenantId, tenantId));
        const primes = await db.select().from(schema.primes).where(eq(schema.primes.tenantId, tenantId));
        res.status(200).json({ settings: settings || null, jobTitles, primes });
        return;
      }
      if (action === 'updateSettings') {
        const { primesEnabled, payrollSoftware } = req.body || {};
        await db.update(schema.tenantSettings)
          .set({
            primesEnabled: !!primesEnabled,
            payrollSoftware: payrollSoftware || null,
          })
          .where(eq(schema.tenantSettings.tenantId, tenantId));
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

      if (action === 'start') {
        const { projectId, lat, lng, clientTimestamp } = req.body || {};
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

        // Évite un doublon si l'employé a déjà un poinçon ouvert.
        const [openPunch] = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId), eq(schema.punches.status, OPEN_PUNCH_STATUS)));
        if (openPunch) { res.status(200).json({ punch: openPunch, resumed: true }); return; }

        const now = new Date();
        const kmTraveled = haversineKm(me.homeLat, me.homeLng, project.lat, project.lng);
        const primeApplied = !!me.primeId;
        const [row] = await db.insert(schema.punches).values({
          tenantId, employeeId, projectId, clockIn: now, status: OPEN_PUNCH_STATUS,
          gpsLatIn: lat, gpsLngIn: lng, kmTraveled, primeApplied,
        }).returning();
        res.status(200).json({ punch: row, resumed: false });
        return;
      }

      if (action === 'switch') {
        const { punchId, newProjectId, lat, lng, clientTimestamp } = req.body || {};
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
          primeApplied: !!me.primeId,
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

        const hours = computePunchHours(row);
        res.status(200).json({ punch: row, ...hours });
        return;
      }

      if (action === 'editPending') {
        // Permet à l'employé de corriger lui-même un poinçon déjà fermé, mais seulement tant
        // qu'il n'a pas encore été traité (approuvé/rejeté/exporté) par l'admin.
        const { punchId, projectId, breakMorning, breakLunch, breakAfternoon } = req.body || {};
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
        if (projectId !== undefined && projectId !== punch.projectId) {
          const [project] = await db.select().from(schema.projects)
            .where(and(eq(schema.projects.id, projectId), eq(schema.projects.tenantId, tenantId)));
          if (!project || project.status !== 'en_cours') {
            res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
            return;
          }
          patch.projectId = projectId;
          patch.kmTraveled = haversineKm(me.homeLat, me.homeLng, project.lat, project.lng);
        }
        if (!Object.keys(patch).length) { res.status(400).json({ error: 'Aucune modification envoyée.' }); return; }
        const [row] = await db.update(schema.punches).set(patch).where(eq(schema.punches.id, punchId)).returning();
        res.status(200).json({ punch: row, ...computePunchHours(row) });
        return;
      }

      if (action === 'listToday') {
        const todayKey = torontoDateKey(new Date());
        const rows = await db.select().from(schema.punches)
          .where(and(eq(schema.punches.tenantId, tenantId), eq(schema.punches.employeeId, employeeId)));
        const todays = rows.filter(r => r.clockIn && torontoDateKey(new Date(r.clockIn)) === todayKey);
        res.status(200).json({ punches: todays.map(r => ({ ...r, ...computePunchHours(r) })) });
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
            .map(r => ({ ...r, ...computePunchHours(r), projectName: (projectMap[r.projectId] || {}).name || null })),
        });
        return;
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }

    // ===================== Poinçon — administration =====================
    if (resource === 'punchesAdmin') {
      if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }

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
          .map(r => ({
            ...r,
            ...computePunchHours(r),
            employeeName: (empMap[r.employeeId] || {}).fullName || '(supprimé)',
            employeeNumber: (empMap[r.employeeId] || {}).employeeNumber || null,
            projectName: (projMap[r.projectId] || {}).name || null,
          }));
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

      if (action === 'manualAdd') {
        const { employeeId, projectId, date, clockIn, clockOut } = req.body || {};
        if (!employeeId || !projectId || !date) { res.status(400).json({ error: 'employeeId, projectId et date sont requis.' }); return; }
        if (!clockIn && !clockOut) { res.status(400).json({ error: "Au moins l'une des deux heures (début ou fin) est requise." }); return; }
        const [emp] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, employeeId), eq(schema.employees.tenantId, tenantId)));
        if (!emp) { res.status(404).json({ error: 'Employé introuvable.' }); return; }
        const [project] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.tenantId, tenantId)));
        if (!project) { res.status(404).json({ error: 'Projet introuvable.' }); return; }
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
          primeApplied: !!emp.primeId,
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

        const nextClockIn = patch.clockIn !== undefined ? patch.clockIn : punch.clockIn;
        const nextClockOut = patch.clockOut !== undefined ? patch.clockOut : punch.clockOut;
        if (nextClockIn && nextClockOut && await hasOverlap(db, schema, tenantId, punch.employeeId, nextClockIn, nextClockOut, id)) {
          res.status(400).json({ error: 'Ce poinçon chevauche un poinçon existant pour cet employé (double paiement évité).' });
          return;
        }
        const [row] = await db.update(schema.punches).set(patch).where(eq(schema.punches.id, id)).returning();
        res.status(200).json({ ok: true, punch: row, ...computePunchHours(row) });
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
        // Export générique CSV pour V1 (indépendant du logiciel de paie). Un format spécifique
        // Avantage (comme chez EPD) pourra être ajouté plus tard une fois qu'un export de
        // référence sera disponible pour ce tenant (voir tenantSettings.payrollSoftware).
        const csvLines = ['Employé;N° employé;Heures régulières;Temps 1.5x;Temps 2x;Prime;Semaine du'];
        for (const r of rows) {
          csvLines.push([r.employeeName, r.employeeNumber || '', r.regularH, r.overtime15H, r.overtime2H, r.prime ? 'Oui' : 'Non', wk].join(';'));
        }
        await db.update(schema.punches).set({ status: 'exporte' })
          .where(inArray(schema.punches.id, approved.map(p => p.id)));
        res.status(200).json({ ok: true, weekStart: wk, csv: csvLines.join('\n'), summary: rows });
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
        if (ctx.role !== 'admin') { res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' }); return; }
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
