// api/employee-history.js
// Historique des poinçons de l'employé connecté, regroupé par semaine (avec totaux
// brut et ajusté par semaine). Nécessite un jeton de session Clerk avec
// publicMetadata.role === 'employee'.

const { verifyToken } = require('@clerk/backend');

const POINCONS_BOARD = 18427410930;
const COL_EMPLOYE = 'board_relation_mm6d1zaz';
const COL_PROJET = 'board_relation_mm6ddgy';
const COL_DATE = 'date_mm6d1p6e';
const COL_HEURE_DEBUT = 'hour_mm6dfaha';
const COL_HEURE_FIN = 'hour_mm6dfqfg';
const COL_TOTAL_BRUT = 'numeric_mm6d12a7';
const COL_TOTAL_AJUSTE = 'numeric_mm6d8c9m';
const COL_STATUT = 'color_mm6dxpt7';

function hourText(cv) {
  if (!cv || cv.hour == null) return '';
  return String(cv.hour).padStart(2, '0') + ':' + String(cv.minute).padStart(2, '0');
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function fmtWeekLabel(monday) {
  const start = new Date(monday + 'T12:00:00');
  const end = new Date(start); end.setDate(end.getDate() + 4);
  const f = d => d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
  return `Semaine du ${f(start)} au ${f(end)}`;
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
  const employeeItemId = Number(meta.employeeItemId);

  try {
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
      body: JSON.stringify({
        query: `
          query($board: [ID!], $empId: CompareValue!, $empCol: ID!) {
            boards(ids: $board) {
              items_page(query_params: { rules: [{ column_id: $empCol, compare_value: $empId, operator: any_of }], order_by: [{ column_id: "${COL_DATE}", direction: desc }] }, limit: 200) {
                items {
                  id
                  column_values(ids: ["${COL_PROJET}", "${COL_DATE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_TOTAL_BRUT}", "${COL_TOTAL_AJUSTE}", "${COL_STATUT}"]) {
                    id text
                    ... on BoardRelationValue { linked_items { id name } }
                    ... on HourValue { hour minute }
                  }
                }
              }
            }
          }
        `,
        variables: { board: [String(POINCONS_BOARD)], empId: [employeeItemId], empCol: COL_EMPLOYE }
      })
    });
    const data = await r.json();
    if (data.errors) {
      res.status(502).json({ error: 'Erreur monday.com: ' + data.errors.map(e => e.message).join('; ') });
      return;
    }

    const items = ((data.data.boards[0] && data.data.boards[0].items_page.items) || []);
    const punches = items.map(it => {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      const proj = (cv[COL_PROJET] && cv[COL_PROJET].linked_items && cv[COL_PROJET].linked_items[0]) || null;
      return {
        date: (cv[COL_DATE] && cv[COL_DATE].text) || '',
        projectName: proj ? proj.name : '',
        heureDebut: hourText(cv[COL_HEURE_DEBUT]),
        heureFin: hourText(cv[COL_HEURE_FIN]),
        brutH: Number((cv[COL_TOTAL_BRUT] && cv[COL_TOTAL_BRUT].text) || 0) || 0,
        ajusteH: Number((cv[COL_TOTAL_AJUSTE] && cv[COL_TOTAL_AJUSTE].text) || 0) || 0,
        statut: (cv[COL_STATUT] && cv[COL_STATUT].text) || 'En attente'
      };
    }).filter(p => p.date);

    const weeksMap = new Map();
    punches.forEach(p => {
      const wk = mondayOfWeek(p.date);
      if (!weeksMap.has(wk)) weeksMap.set(wk, { weekStart: wk, weekLabel: fmtWeekLabel(wk), totalBrutH: 0, totalAjusteH: 0, punches: [] });
      const g = weeksMap.get(wk);
      g.totalBrutH += p.brutH;
      g.totalAjusteH += p.ajusteH;
      g.punches.push(p);
    });

    const weeks = Array.from(weeksMap.values())
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
      .map(g => ({
        ...g,
        totalBrutH: Math.round(g.totalBrutH * 100) / 100,
        totalAjusteH: Math.round(g.totalAjusteH * 100) / 100,
        punches: g.punches.sort((a, b) => b.date.localeCompare(a.date))
      }));

    res.status(200).json({ weeks });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
