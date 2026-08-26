// api/punch.js
// Début / changement de chantier / fin de poinçon (interface mobile employé). Écrit dans le
// board Monday "⏱️ Poinçons". Nécessite un jeton de session Clerk avec publicMetadata.role
// === 'employee' (voir api/employee-today.js pour la note de configuration Clerk requise).
//
// Convention CCQ commerciale (Québec) utilisée pour ajuster le total payable :
//   - Dîner (30 min) : pris = 30 min déduites du temps écoulé (pause non payée) ; NON pris =
//     AUCUNE déduction (l'employé a travaillé pendant sa pause, donc payé pour ce temps —
//     par rapport au cas "pris", cela revient à "ajouter" les 30 min qui auraient sinon été
//     déduites, mais l'ajustement lui-même reste neutre, jamais positif).
//   - Pause matin (15 min) et pause après-midi (15 min) : payées, donc normalement non
//     déduites. Si NON prises, on AJOUTE 15 min au total payable (l'employé a soit
//     travaillé pendant la pause, soit quitté plus tôt sans la prendre).
//   - Le total payable est ensuite arrondi au 15 minutes le plus proche (haut ou bas).
//   - Cette déduction/ajustement ne s'applique qu'UNE SEULE FOIS par journée, sur le
//     dernier segment de travail (voir action 'switch' ci-dessous pour les changements
//     de chantier en cours de journée — un employé peut avoir plusieurs poinçons/segments
//     le même jour, un par chantier).
//
// Actions :
//   start  — débute un poinçon sur un projet.
//   switch — change de chantier en cours de poinçon : ferme le segment actif (heure de fin
//            arrondie au 15 min le plus proche) et ouvre immédiatement un nouveau segment sur
//            le nouveau projet à CETTE MÊME heure arrondie (aucune seconde perdue/dupliquée).
//   finish — termine la journée : calcule le total payable sur l'ENSEMBLE des segments du
//            jour (tous chantiers confondus) et applique la déduction/ajustement des pauses
//            une seule fois, imputée au dernier segment.
//
// La géolocalisation (lat/lng) est OBLIGATOIRE pour start/switch/finish — validée ici côté
// serveur pour qu'elle ne puisse pas être contournée depuis le client.

const { verifyToken } = require('@clerk/backend');

const POINCONS_BOARD = 18427410930;
const COL_EMPLOYE = 'board_relation_mm6d1zaz';
const COL_PROJET = 'board_relation_mm6ddgy';
const COL_DATE = 'date_mm6d1p6e';
const COL_SEMAINE = 'text_mm6d1bk5';
const COL_HEURE_DEBUT = 'hour_mm6dfaha';
const COL_HEURE_FIN = 'hour_mm6dfqfg';
const COL_GPS_DEBUT = 'text_mm6d2r65';
const COL_GPS_FIN = 'text_mm6ddr4z';
const COL_MATIN_NON_PRISE = 'boolean_mm6dbmf2';
const COL_RAISON_MATIN = 'text_mm6dp8f9';
const COL_DINER_NON_PRIS = 'boolean_mm6dczby';
const COL_RAISON_DINER = 'text_mm6djdex';
const COL_PM_PRISE = 'boolean_mm6dpdmf';
const COL_TOTAL_BRUT = 'numeric_mm6d12a7';
const COL_TOTAL_AJUSTE = 'numeric_mm6d8c9m';
const COL_KM_SUGGERE = 'numeric_mm6d4hvv';
const COL_KM_AJUSTE = 'numeric_mm6dxafw';
const COL_STATUT = 'color_mm6dxpt7';
// Nom de la Tâche choisie par l'employé (copie figée en texte — voir admin-poincon.html /
// api/employee-today.js pour la Configuration Métiers/Tâches).
const COL_TACHE = 'text_mm6enx2b';

// Validation serveur du projet (voir audit du 26 août 2026, point #6) : le client (mobile) ne
// propose que les projets actifs dans sa liste déroulante, mais rien n'empêchait auparavant un
// appel direct à l'API d'assigner un poinçon à N'IMPORTE QUEL item de Monday (projet terminé,
// inexistant, ou même un item d'un autre board). Même board/colonne que employee-today.js.
const PROJECTS_BOARD = 8371776057;
const PROJECT_STAGE_COL = 'status3';
const PROJECT_ACTIVE_LABEL = 'Projet en cours';

async function isProjectActive(mondayToken, projectId) {
  if (!projectId) return false;
  const detail = await mondayGraphQL(mondayToken, `
    query($ids: [ID!]) {
      items(ids: $ids) { id board { id } column_values(ids: ["${PROJECT_STAGE_COL}"]) { id text } }
    }
  `, { ids: [String(projectId)] });
  const item = (detail.items || [])[0];
  if (!item || String((item.board || {}).id) !== String(PROJECTS_BOARD)) return false;
  const stageCv = (item.column_values || []).find(c => c.id === PROJECT_STAGE_COL);
  return !!(stageCv && stageCv.text === PROJECT_ACTIVE_LABEL);
}

function nowInToronto() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { date: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour === '24' ? '0' : map.hour), minute: Number(map.minute) };
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=dim
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function round15(minutes) {
  return Math.round(minutes / 15) * 15;
}

// Arrondit une HEURE DE L'HORLOGE (pas une durée) au 15 minutes le plus proche.
function roundClockToNearest15(hour, minute) {
  const total = hour * 60 + minute;
  const rounded = Math.round(total / 15) * 15;
  const wrapped = ((rounded % 1440) + 1440) % 1440;
  return { hour: Math.floor(wrapped / 60), minute: wrapped % 60 };
}

function isValidCoord(v) { return typeof v === 'number' && isFinite(v); }

// Écart maximal toléré entre l'horloge du téléphone (clientTimestamp, ms epoch envoyés par
// pointeuse.html) et l'heure réelle du serveur, avant de refuser le poinçon. Ceci ne peut pas
// forcer le réglage "Date et heure automatiques" du téléphone, mais empêche un employé d'avancer
// ou de reculer manuellement l'heure de son appareil pour poinçonner à un moment différent de la
// réalité — la validation ci-dessous est faite avec l'heure du SERVEUR, non contournable.
const MAX_CLOCK_DRIFT_MS = 3 * 60 * 1000; // 3 minutes

function checkClientClock(clientTimestamp) {
  if (typeof clientTimestamp !== 'number' || !isFinite(clientTimestamp) || clientTimestamp <= 0) {
    return "Impossible de valider l'heure de votre téléphone. Veuillez réessayer.";
  }
  const drift = Math.abs(Date.now() - clientTimestamp);
  if (drift > MAX_CLOCK_DRIFT_MS) {
    return "L'heure de votre téléphone ne correspond pas à l'heure réelle. Veuillez activer \"Date et heure automatiques\" dans les réglages de votre téléphone, puis réessayer.";
  }
  return null;
}

async function mondayGraphQL(mondayToken, query, variables) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!secretKey || !mondayToken) { res.status(500).json({ error: 'Configuration serveur incomplète.' }); return; }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearerToken) { res.status(401).json({ error: 'Non authentifié.' }); return; }

  let claims;
  try {
    claims = await verifyToken(bearerToken, { secretKey });
  } catch (err) {
    res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
    return;
  }
  const meta = claims || {};
  if (meta.role !== 'employee' || !meta.employeeItemId) {
    res.status(403).json({ error: "Ce compte n'a pas accès à l'interface de poinçon." });
    return;
  }
  const employeeItemId = String(meta.employeeItemId);

  const { action } = req.body || {};

  try {
    if (action === 'start') {
      const { projectId, tache, lat, lng, kmSuggested, clientTimestamp } = req.body || {};
      if (!projectId) { res.status(400).json({ error: 'Projet manquant.' }); return; }
      if (!tache || !String(tache).trim()) { res.status(400).json({ error: 'Tâche manquante.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour débuter un poinçon. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (!(await isProjectActive(mondayToken, projectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }
      const now = nowInToronto();

      // Éviter un doublon si l'employé a déjà un poinçon ouvert aujourd'hui.
      const existing = await mondayGraphQL(mondayToken, `
        query($board: ID!, $dateCol: String!, $date: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
            items { id column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_FIN}"]) { id text ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [now.date] });

      const openItem = (existing.items_page_by_column_values.items || []).find(it => {
        const empCv = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
        const finCv = (it.column_values || []).find(c => c.id === COL_HEURE_FIN);
        const ids = (empCv && empCv.linked_item_ids) || [];
        return ids.map(String).includes(employeeItemId) && (!finCv || !finCv.text);
      });
      if (openItem) {
        res.status(200).json({ itemId: openItem.id, resumed: true });
        return;
      }

      const columnValues = {
        [COL_EMPLOYE]: { item_ids: [Number(employeeItemId)] },
        [COL_PROJET]: { item_ids: [Number(projectId)] },
        [COL_DATE]: { date: now.date },
        [COL_SEMAINE]: mondayOfWeek(now.date),
        [COL_HEURE_DEBUT]: { hour: now.hour, minute: now.minute },
        [COL_GPS_DEBUT]: `${lat},${lng}`,
        [COL_STATUT]: { label: 'En attente' },
        [COL_TACHE]: String(tache).trim()
      };
      if (typeof kmSuggested === 'number') columnValues[COL_KM_SUGGERE] = kmSuggested;

      const created = await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $name: String!, $cv: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), name: `Poinçon ${now.date}`, cv: JSON.stringify(columnValues) });

      res.status(200).json({ itemId: created.create_item.id, resumed: false, startedAt: now });
      return;
    }

    if (action === 'switch') {
      const { itemId, newProjectId, tache, lat, lng, clientTimestamp } = req.body || {};
      if (!itemId || !newProjectId) { res.status(400).json({ error: 'Poinçon ou nouveau projet manquant.' }); return; }
      if (!tache || !String(tache).trim()) { res.status(400).json({ error: 'Tâche manquante.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour changer de chantier. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (!(await isProjectActive(mondayToken, newProjectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_DATE}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const finCv = item.column_values.find(c => c.id === COL_HEURE_FIN);
      if (finCv && finCv.text) { res.status(400).json({ error: 'Ce poinçon est déjà terminé.' }); return; }
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
      const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;

      const now = nowInToronto();
      const rounded = roundClockToNearest15(now.hour, now.minute);

      let elapsedMin = (rounded.hour * 60 + rounded.minute) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440;
      // Brut ET ajusté sont exprimés sur la même base décimale (arrondi au quart d'heure le
      // plus proche) pour éviter toute confusion entre les deux colonnes à l'affichage.
      const brutH = Math.round((round15(elapsedMin) / 60) * 100) / 100;

      // Ferme le segment actif — sans déduction de pause ici (appliquée une seule fois, à la
      // toute fin de journée, sur le dernier segment).
      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, {
        board: String(POINCONS_BOARD), item: String(itemId),
        cv: JSON.stringify({
          [COL_HEURE_FIN]: { hour: rounded.hour, minute: rounded.minute },
          [COL_GPS_FIN]: `${lat},${lng}`,
          [COL_TOTAL_BRUT]: brutH,
          [COL_TOTAL_AJUSTE]: brutH
        })
      });

      // Ouvre le nouveau segment EXACTEMENT à l'heure arrondie de fin du précédent — aucune
      // seconde perdue ni dupliquée pour l'employé.
      const columnValues = {
        [COL_EMPLOYE]: { item_ids: [Number(employeeItemId)] },
        [COL_PROJET]: { item_ids: [Number(newProjectId)] },
        [COL_DATE]: { date: itemDate },
        [COL_SEMAINE]: mondayOfWeek(itemDate),
        [COL_HEURE_DEBUT]: { hour: rounded.hour, minute: rounded.minute },
        [COL_GPS_DEBUT]: `${lat},${lng}`,
        [COL_STATUT]: { label: 'En attente' },
        [COL_TACHE]: String(tache).trim()
      };
      const created = await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $name: String!, $cv: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), name: `Poinçon ${itemDate}`, cv: JSON.stringify(columnValues) });

      res.status(200).json({ oldItemId: itemId, newItemId: created.create_item.id, switchedAt: rounded });
      return;
    }

    if (action === 'finish') {
      const { itemId, lat, lng, morningSkipped, morningReason, lunchSkipped, lunchReason, afternoonTaken, clientTimestamp } = req.body || {};
      if (!itemId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour terminer un poinçon. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (morningSkipped && !(morningReason || '').trim()) {
        res.status(400).json({ error: "Raison obligatoire si la pause du matin n'a pas été prise." });
        return;
      }
      if (lunchSkipped && !(lunchReason || '').trim()) {
        res.status(400).json({ error: "Raison obligatoire si le dîner n'a pas été pris." });
        return;
      }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_DATE}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
      const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;

      const now = nowInToronto();
      let elapsedMin = (now.hour * 60 + now.minute) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440; // au cas où le poinçon chevauche minuit
      // Le total PAYABLE (plus bas) est calculé à partir du temps RÉEL écoulé (elapsedMin, non
      // arrondi) pour rester précis. Le total BRUT affiché, lui, est exprimé sur la même base
      // décimale que l'ajusté (arrondi au quart d'heure) pour éviter toute confusion à l'écran.
      const brutH = Math.round((round15(elapsedMin) / 60) * 100) / 100;

      // Retrouve les AUTRES segments (chantiers) déjà fermés aujourd'hui pour cet employé
      // (résultat d'un ou plusieurs changements de chantier via l'action 'switch'), afin de
      // calculer le total payable de la journée ENTIÈRE, pas seulement ce dernier segment.
      const dayItems = await mondayGraphQL(mondayToken, `
        query($board: ID!, $dateCol: String!, $date: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
            items {
              id
              column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_FIN}", "${COL_TOTAL_AJUSTE}"]) {
                id text
                ... on BoardRelationValue { linked_item_ids }
              }
            }
          }
        }
      `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [itemDate] });

      const otherClosedItems = (dayItems.items_page_by_column_values.items || []).filter(it => {
        if (String(it.id) === String(itemId)) return false;
        const empCv2 = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
        const finCv2 = (it.column_values || []).find(c => c.id === COL_HEURE_FIN);
        const idsOther = (empCv2 && empCv2.linked_item_ids) || [];
        return idsOther.map(String).includes(employeeItemId) && finCv2 && finCv2.text;
      });
      const sumPrevAjusteMin = otherClosedItems.reduce((sum, it) => {
        const ajCv = (it.column_values || []).find(c => c.id === COL_TOTAL_AJUSTE);
        const h = Number((ajCv && ajCv.text) || 0);
        return sum + (isFinite(h) ? h * 60 : 0);
      }, 0);
      const sumPrevBrutMin = sumPrevAjusteMin; // segments antérieurs = brut non ajusté (voir action 'switch')

      const grandTotalBrutMin = sumPrevBrutMin + elapsedMin;
      // La question du dîner/pause PM n'a de sens que si la journée s'est réellement
      // rendue à ce moment-là. Calculé ici côté serveur (autoritatif, non contournable)
      // à partir de l'heure de fin RÉELLE, peu importe ce que le client a envoyé.
      const finishMinutes = now.hour * 60 + now.minute;
      const lunchApplicable = finishMinutes >= 13 * 60;
      const afternoonApplicable = finishMinutes >= 14 * 60;
      const afternoonSkipped = afternoonApplicable && afternoonTaken === false;
      // Dîner : pris = 30 min déduites (pause non payée) ; NON pris = AUCUNE déduction
      // (l'employé a travaillé pendant sa pause, donc payé pour ce temps). L'ajustement
      // reste neutre (0) quand non pris — ne JAMAIS ajouter 30 min positivement, sinon on
      // paierait l'employé deux fois pour le même 30 minutes.
      const lunchSkippedEffective = lunchApplicable && lunchSkipped === true;
      const lunchAdjust = lunchApplicable ? (lunchSkippedEffective ? 0 : -30) : 0;
      const dayPayableRaw = grandTotalBrutMin
        + lunchAdjust
        + (morningSkipped ? 15 : 0)
        + (afternoonSkipped ? 15 : 0);
      const dayPayableMin = Math.max(0, round15(dayPayableRaw));
      // La déduction/l'ajustement de la journée est imputé entièrement à CE dernier segment,
      // de façon à ce que la somme de tous les segments du jour égale le total payable exact.
      const lastAjusteMin = Math.max(0, dayPayableMin - sumPrevAjusteMin);

      const columnValues = {
        [COL_HEURE_FIN]: { hour: now.hour, minute: now.minute },
        [COL_GPS_FIN]: `${lat},${lng}`,
        [COL_MATIN_NON_PRISE]: { checked: morningSkipped ? 'true' : 'false' },
        [COL_RAISON_MATIN]: morningReason || '',
        [COL_DINER_NON_PRIS]: { checked: lunchSkipped ? 'true' : 'false' },
        [COL_RAISON_DINER]: lunchReason || '',
        [COL_PM_PRISE]: { checked: afternoonTaken ? 'true' : 'false' },
        [COL_TOTAL_BRUT]: brutH,
        [COL_TOTAL_AJUSTE]: Math.round((lastAjusteMin / 60) * 100) / 100
      };

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), item: String(itemId), cv: JSON.stringify(columnValues) });

      res.status(200).json({
        itemId,
        totalBrutH: brutH,
        totalAjusteH: Math.round((lastAjusteMin / 60) * 100) / 100,
        dayTotalAjusteH: Math.round((dayPayableMin / 60) * 100) / 100
      });
      return;
    }

    if (action === 'editPending') {
      // Permet à l'employé de corriger LUI-MÊME un poinçon déjà terminé, mais SEULEMENT tant
      // qu'il n'a pas encore été traité (Approuvé/Rejeté) par l'admin. Il peut changer le
      // chantier et les 3 cases de pause. Les heures de début/fin ne sont JAMAIS modifiables
      // ici (elles restent celles réellement poinçonnées, avec GPS/horodatage serveur).
      const { itemId, projectId, morningSkipped, morningReason, lunchSkipped, lunchReason, afternoonTaken } = req.body || {};
      if (!itemId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_DATE}", "${COL_STATUT}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const statutCv = item.column_values.find(c => c.id === COL_STATUT);
      const statut = (statutCv && statutCv.text) || 'En attente';
      if (statut !== 'En attente') {
        res.status(403).json({ error: 'Ce poinçon a déjà été traité par l\'administrateur (' + statut + ') et ne peut plus être modifié.' });
        return;
      }
      const finCv = item.column_values.find(c => c.id === COL_HEURE_FIN);
      if (!finCv || finCv.hour == null) { res.status(400).json({ error: 'Ce poinçon est toujours en cours — impossible de le modifier ici.' }); return; }
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;

      if (projectId && !(await isProjectActive(mondayToken, projectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }

      const columnValues = {};
      if (projectId) columnValues[COL_PROJET] = { item_ids: [Number(projectId)] };

      const pauseFieldsSent = (morningSkipped !== undefined) || (lunchSkipped !== undefined) || (afternoonTaken !== undefined);
      if (pauseFieldsSent) {
        // Les cases de pause n'ont de sens payable que pour une journée à UN SEUL segment
        // (aucun changement de chantier en cours de route) — sur une journée à plusieurs
        // segments, la répartition des pauses entre segments est ambiguë et reste réservée à
        // l'admin. On vérifie donc que c'est le seul poinçon de cet employé ce jour-là.
        const dayItems = await mondayGraphQL(mondayToken, `
          query($board: ID!, $dateCol: String!, $date: [String]!) {
            items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
              items { id column_values(ids: ["${COL_EMPLOYE}"]) { id ... on BoardRelationValue { linked_item_ids } } }
            }
          }
        `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [itemDate] });
        const empDayItems = (dayItems.items_page_by_column_values.items || []).filter(it => {
          const c = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
          return ((c && c.linked_item_ids) || []).map(String).includes(employeeItemId);
        });
        if (empDayItems.length > 1) {
          res.status(400).json({ error: "Journée avec changement de chantier : les pauses ne peuvent pas être modifiées ici. Contactez l'administrateur." });
          return;
        }

        if (morningSkipped && !(morningReason || '').trim()) {
          res.status(400).json({ error: "Raison obligatoire si la pause du matin n'a pas été prise." });
          return;
        }
        if (lunchSkipped && !(lunchReason || '').trim()) {
          res.status(400).json({ error: "Raison obligatoire si le dîner n'a pas été pris." });
          return;
        }

        const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
        const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;
        const finHour = finCv.hour, finMinute = finCv.minute;
        let elapsedMin = (finHour * 60 + finMinute) - (startHour * 60 + startMinute);
        if (elapsedMin < 0) elapsedMin += 1440;
        const finishMinutes = finHour * 60 + finMinute;
        const lunchApplicable = finishMinutes >= 13 * 60;
        const afternoonApplicable = finishMinutes >= 14 * 60;
        const afternoonSkipped = afternoonApplicable && afternoonTaken === false;
        // Dîner : pris = 30 min déduites (pause non payée) ; NON pris = AUCUNE déduction
        // (l'employé a travaillé pendant sa pause, donc payé pour ce temps). L'ajustement
        // reste neutre (0) quand non pris — ne JAMAIS ajouter 30 min positivement, sinon on
        // paierait l'employé deux fois pour le même 30 minutes.
        const lunchSkippedEffective = lunchApplicable && lunchSkipped === true;
        const lunchAdjust = lunchApplicable ? (lunchSkippedEffective ? 0 : -30) : 0;
        const payableRaw = elapsedMin
          + lunchAdjust
          + (morningSkipped ? 15 : 0)
          + (afternoonSkipped ? 15 : 0);
        const payableMin = Math.max(0, round15(payableRaw));

        columnValues[COL_MATIN_NON_PRISE] = { checked: morningSkipped ? 'true' : 'false' };
        columnValues[COL_RAISON_MATIN] = morningReason || '';
        columnValues[COL_DINER_NON_PRIS] = { checked: (lunchApplicable && lunchSkipped) ? 'true' : 'false' };
        columnValues[COL_RAISON_DINER] = lunchReason || '';
        columnValues[COL_PM_PRISE] = { checked: afternoonTaken ? 'true' : 'false' };
        columnValues[COL_TOTAL_AJUSTE] = Math.round((payableMin / 60) * 100) / 100;
      }

      if (!Object.keys(columnValues).length) { res.status(400).json({ error: 'Aucune modification envoyée.' }); return; }

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), item: String(itemId), cv: JSON.stringify(columnValues) });

      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
