// api/punch.js
// Début / fin de poinçon (interface mobile employé). Écrit dans le board Monday
// "⏱️ Poinçons". Nécessite un jeton Clerk avec claim role === 'employee'
// (voir api/employee-today.js pour la configuration Clerk requise).
//
// Convention CCQ commerciale (Québec) utilisée pour ajuster le total payable :
//   - Dîner (30 min) : toujours déduit du temps écoulé, que la pause ait été prise ou non.
//   - Pause matin (15 min) et pause après-midi (15 min) : payées, donc normalement non
//     déduites. Si NON prises, on AJOUTE 15 min au total payable (l'employé a soit
//     travaillé pendant la pause, soit quitté plus tôt sans la prendre).
//   - Le total payable est ensuite arrondi au 15 minutes le plus proche (haut ou bas).

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
      const { projectId, lat, lng, kmSuggested } = req.body || {};
      if (!projectId) { res.status(400).json({ error: 'Projet manquant.' }); return; }
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
        [COL_GPS_DEBUT]: (lat != null && lng != null) ? `${lat},${lng}` : '',
        [COL_STATUT]: { label: 'En attente' }
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

    if (action === 'finish') {
      const { itemId, lat, lng, morningSkipped, morningReason, lunchSkipped, lunchReason, afternoonTaken, kmAdjusted } = req.body || {};
      if (!itemId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }
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

      const now = nowInToronto();
      let elapsedMin = (now.hour * 60 + now.minute) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440; // au cas où le poinçon chevauche minuit
      const afternoonSkipped = afternoonTaken === false;
      const payableRaw = elapsedMin - 30 + (morningSkipped ? 15 : 0) + (afternoonSkipped ? 15 : 0);
      const payableRounded = Math.max(0, round15(payableRaw));

      const columnValues = {
        [COL_HEURE_FIN]: { hour: now.hour, minute: now.minute },
        [COL_GPS_FIN]: (lat != null && lng != null) ? `${lat},${lng}` : '',
        [COL_MATIN_NON_PRISE]: { checked: morningSkipped ? 'true' : 'false' },
        [COL_RAISON_MATIN]: morningReason || '',
        [COL_DINER_NON_PRIS]: { checked: lunchSkipped ? 'true' : 'false' },
        [COL_RAISON_DINER]: lunchReason || '',
        [COL_PM_PRISE]: { checked: afternoonTaken ? 'true' : 'false' },
        [COL_TOTAL_BRUT]: Math.round((elapsedMin / 60) * 100) / 100,
        [COL_TOTAL_AJUSTE]: Math.round((payableRounded / 60) * 100) / 100
      };
      if (typeof kmAdjusted === 'number') columnValues[COL_KM_AJUSTE] = kmAdjusted;

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), item: String(itemId), cv: JSON.stringify(columnValues) });

      res.status(200).json({ itemId, totalBrutH: Math.round((elapsedMin / 60) * 100) / 100, totalAjusteH: Math.round((payableRounded / 60) * 100) / 100 });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
