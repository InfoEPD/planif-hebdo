// api/auto-close-punches.js
// Tâche automatisée (Vercel Cron, voir vercel.json) qui tourne une fois par jour vers 20h00,
// heure de Toronto. Elle ferme de force, à 15h15, tout poinçon encore ouvert (aucune heure de
// fin entrée) sur le board Monday "⏱️ Poinçons" — un employé qui a oublié de terminer son
// poinçon ne doit pas rester "en cours" indéfiniment.
//
// Pour chaque poinçon fermé de force :
//   - Heure de fin  = 15:15 (valeur fixe, à corriger ensuite par l'admin/l'employé).
//   - Brut/Ajusté   = calculés sur Début → 15h15, SANS ajustement de pause (on ignore les
//                     pauses puisqu'on ne les connaît pas — même convention que les segments
//                     intermédiaires de l'action 'switch' dans api/punch.js : Ajusté = Brut).
//                     L'admin ou l'employé pourra corriger le total une fois l'heure réelle
//                     confirmée (voir editPending / Vue par employé, qui recalculent déjà).
//   - Colonne "Arrêt automatique" (boolean_mm6db27f) cochée — affichée en rouge dans
//     admin-poincon.html pour signaler qu'il s'agit d'une fermeture système, pas réelle.
//   - Un message est envoyé à l'employé dans le fil de messages de la semaine en cours,
//     lui demandant de confirmer son heure réelle de fin.
//
// SÉCURITÉ : cette route n'exige PAS de jeton Clerk (elle n'est pas appelée par un utilisateur
// connecté) — elle est protégée par le header "Authorization: Bearer <CRON_SECRET>" que Vercel
// Cron ajoute automatiquement à chaque invocation planifiée, à condition que la variable
// d'environnement CRON_SECRET soit définie sur le projet Vercel (Settings → Environment
// Variables → CRON_SECRET, n'importe quelle chaîne aléatoire). Voir vercel.json pour
// l'horaire du cron.

const POINCONS_BOARD = 18427410930;
const P_EMPLOYE = 'board_relation_mm6d1zaz';
const P_PROJET = 'board_relation_mm6ddgy';
const P_DATE = 'date_mm6d1p6e';
const P_SEMAINE = 'text_mm6d1bk5';
const P_HDEBUT = 'hour_mm6dfaha';
const P_HFIN = 'hour_mm6dfqfg';
const P_GPS_FIN = 'text_mm6ddr4z';
const P_TOTAL_BRUT = 'numeric_mm6d12a7';
const P_TOTAL_AJUSTE = 'numeric_mm6d8c9m';
const P_ARRET_AUTO = 'boolean_mm6db27f';

const MESSAGES_BOARD = 18427410933;
const M_EMPLOYE = 'board_relation_mm6dwczs';
const M_MESSAGE = 'long_text_mm6dxv7r';
const M_DATE = 'date_mm6dxf1a';
const M_STATUT = 'color_mm6dfb7s';
const M_AUTEUR = 'color_mm6dd12s';
const M_LU_ADMIN = 'boolean_mm6dm8mb';
const M_LU_EMPLOYE = 'boolean_mm6dc4ar';

const MESSAGE_TEXT = "Salut, ton punch de fin n'a pas été entré. Peux-tu me confirmer à quelle heure tu as fini, svp?";

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
  const mondayToken = process.env.MONDAY_API_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  if (!mondayToken) { res.status(500).json({ error: 'Configuration serveur incomplète.' }); return; }

  // Protège la route : n'accepte que les appels de Vercel Cron (header signé avec CRON_SECRET)
  // ou, à défaut de CRON_SECRET configuré, refuse tout appel par prudence.
  if (!cronSecret) { res.status(500).json({ error: "CRON_SECRET n'est pas configuré sur le projet Vercel." }); return; }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (bearerToken !== cronSecret) { res.status(401).json({ error: 'Non autorisé.' }); return; }

  const now = nowInToronto();
  const currentMinutes = now.hour * 60 + now.minute;
  const currentWeekKey = mondayOfWeek(now.date);
  const prevWeekKey = mondayOfWeek((() => { const d = new Date(now.date + 'T12:00:00'); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })());

  try {
    // On limite la recherche à la semaine en cours + la précédente (couvre le cas d'un poinçon
    // resté ouvert depuis vendredi et jamais fermé le week-end) plutôt que de parcourir tout
    // l'historique du board.
    const data = await mondayGraphQL(mondayToken, `
      query($board: ID!, $col: String!, $val: [String]!) {
        items_page_by_column_values(board_id: $board, columns: [{ column_id: $col, column_values: $val }], limit: 300) {
          items {
            id
            column_values(ids: ["${P_EMPLOYE}", "${P_DATE}", "${P_HDEBUT}", "${P_HFIN}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      }
    `, { board: String(POINCONS_BOARD), col: P_SEMAINE, val: [currentWeekKey, prevWeekKey] });

    const items = (data.items_page_by_column_values.items || []);
    const toClose = items.filter(it => {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      const fin = cv[P_HFIN];
      const isOpen = !fin || fin.hour == null;
      if (!isOpen) return false;
      const itemDate = (cv[P_DATE] && cv[P_DATE].text) || '';
      if (!itemDate) return false;
      // Ferme seulement les poinçons d'AUJOURD'HUI (une fois 20h00 passé) ou de jours
      // antérieurs — jamais un poinçon "futur" (protection théorique, ne devrait pas arriver).
      if (itemDate === now.date) return currentMinutes >= 20 * 60;
      return itemDate < now.date;
    });

    const closedItemIds = [];
    const employeeIdsToNotify = new Set();
    // Recueille toute erreur PARTIELLE (une étape échoue sur un item précis) sans jamais faire
    // échouer tout le run — avant, les 5 colonnes (heure/totaux/GPS/drapeau) étaient écrites en
    // UN SEUL appel ; si Monday rejetait silencieusement une colonne malformée, rien ne le
    // signalait (c'est ce qui s'est produit le 25 août : l'heure/les totaux ont bien été écrits,
    // mais ni le drapeau "Arrêt automatique" ni le message n'ont suivi, sans aucune trace). Les
    // deux étapes ci-dessous sont maintenant des mutations SÉPARÉES, chacune avec son propre
    // try/catch, journalisées via console.error (visible dans Vercel → Logs) ET renvoyées dans
    // la réponse JSON sous "warnings" pour un diagnostic rapide.
    const warnings = [];

    for (const it of toClose) {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      const empCv = cv[P_EMPLOYE];
      const empId = ((empCv && empCv.linked_item_ids) || [])[0];
      const startCv = cv[P_HDEBUT];
      const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
      const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;

      let elapsedMin = (15 * 60 + 15) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440;
      const brutH = Math.round((round15(elapsedMin) / 60) * 100) / 100;

      // Étape 1/2 — CRITIQUE : Fin + totaux. Sans elle, le poinçon reste ouvert indéfiniment,
      // donc si ça échoue on log et on N'AJOUTE PAS l'employé aux notifications (on ne veut pas
      // lui dire "confirme ton heure" si le poinçon n'a même pas été fermé).
      try {
        await mondayGraphQL(mondayToken, `
          mutation($board: ID!, $item: ID!, $cv: JSON!) {
            change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
          }
        `, {
          board: String(POINCONS_BOARD), item: String(it.id),
          cv: JSON.stringify({
            [P_HFIN]: { hour: 15, minute: 15 },
            [P_TOTAL_BRUT]: brutH,
            [P_TOTAL_AJUSTE]: brutH
          })
        });
        closedItemIds.push(it.id);
        if (empId) employeeIdsToNotify.add(String(empId));
      } catch (err) {
        console.error(`auto-close-punches: échec fermeture (heure/totaux) item ${it.id}:`, err.message);
        warnings.push({ itemId: it.id, step: 'fermeture', error: err.message });
        continue; // pas la peine de tenter l'étape 2 si l'étape 1 a échoué
      }

      // Étape 2/2 — informatif : drapeau "Arrêt automatique" (rouge dans l'admin) + note GPS.
      try {
        await mondayGraphQL(mondayToken, `
          mutation($board: ID!, $item: ID!, $cv: JSON!) {
            change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
          }
        `, {
          board: String(POINCONS_BOARD), item: String(it.id),
          cv: JSON.stringify({
            [P_GPS_FIN]: 'Système — arrêt automatique (poinçon non fermé à 20h00)',
            [P_ARRET_AUTO]: { checked: 'true' }
          })
        });
      } catch (err) {
        console.error(`auto-close-punches: échec drapeau/GPS item ${it.id}:`, err.message);
        warnings.push({ itemId: it.id, step: 'drapeau', error: err.message });
      }
    }

    // Un seul message par employé (même s'il avait, en théorie, plusieurs poinçons ouverts).
    const messagedEmployeeIds = [];
    for (const empId of employeeIdsToNotify) {
      const timeStr = String(now.hour).padStart(2, '0') + ':' + String(now.minute).padStart(2, '0');
      const cv = {
        [M_EMPLOYE]: { item_ids: [Number(empId)] },
        [M_MESSAGE]: { text: MESSAGE_TEXT },
        [M_DATE]: { date: now.date, time: timeStr + ':00' },
        [M_STATUT]: { label: 'Nouveau' },
        [M_AUTEUR]: { label: 'Admin' },
        [M_LU_ADMIN]: { checked: 'true' },
        [M_LU_EMPLOYE]: { checked: 'false' }
      };
      try {
        await mondayGraphQL(mondayToken, `
          mutation($board: ID!, $name: String!, $cv: JSON!) {
            create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
          }
        `, { board: String(MESSAGES_BOARD), name: `Système — ${now.date}`, cv: JSON.stringify(cv) });
        messagedEmployeeIds.push(empId);
      } catch (err) {
        console.error(`auto-close-punches: échec message employé ${empId}:`, err.message);
        warnings.push({ employeeId: empId, step: 'message', error: err.message });
      }
    }

    res.status(200).json({ ok: true, closed: closedItemIds, messaged: messagedEmployeeIds, warnings });
  } catch (err) {
    console.error('auto-close-punches: erreur générale:', err.message);
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
