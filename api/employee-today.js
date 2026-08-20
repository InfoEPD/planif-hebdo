// api/employee-today.js
// Point d'accès ALLÉGÉ (interface mobile employé) : retourne uniquement ce dont
// l'employé connecté a besoin pour poinçonner aujourd'hui — pas tout le board
// de planification comme le fait api/monday.js pour l'app bureau. Nécessite un
// jeton de session Clerk valide dont les claims contiennent
// { role: 'employee', employeeItemId: '<id de l'item Monday employé>' }.
//
// IMPORTANT — configuration Clerk requise (une seule fois), Dashboard Clerk :
// Sessions → Edit → "Customize session token", coller dans l'éditeur de claims :
//   { "role": "{{user.public_metadata.role}}",
//     "employeeItemId": "{{user.public_metadata.employeeItemId}}",
//     "employeeName": "{{user.public_metadata.employeeName}}" }

const { verifyToken } = require('@clerk/backend');

const PLANNING_BOARD = 18426416285;
const COL_PROJET = 'board_relation_mm66kzga';
const COL_DATE = 'date_mm66w0ga';
const COL_MENUISIERS = 'board_relation_mm66fec0';

const PROJECTS_BOARD = 8371776057;
const PROJECT_STAGE_COL = 'status3';
const PROJECT_ACTIVE_INDEX = 0; // "Projet en cours"

const DISTANCES_BOARD = 18426435716;
const DIST_EMP_ID_COL = 'text_mm66z9bc';
const DIST_JSON_COL = 'long_text_mm668qje';

function todayInMontreal() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!secretKey || !mondayToken) {
    res.status(500).json({ error: 'Configuration serveur incomplète.' });
    return;
  }
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
  const today = todayInMontreal();

  const query = `
    query($planningBoard: ID!, $today: [String]!, $projectsBoard: ID!, $stageCol: String!, $stageVal: [String], $distBoard: ID!, $distCol: String!, $empId: [String]!) {
      planningToday: items_page_by_column_values(board_id: $planningBoard, columns: [{ column_id: "${COL_DATE}", column_values: $today }], limit: 100) {
        items {
          id
          created_at
          column_values(ids: ["${COL_PROJET}", "${COL_MENUISIERS}"]) {
            id
            ... on BoardRelationValue { linked_item_ids linked_items { id name } }
          }
        }
      }
      activeProjects: boards(ids: [$projectsBoard]) {
        items_page(query_params: { rules: [{ column_id: $stageCol, compare_value: [${PROJECT_ACTIVE_INDEX}], operator: any_of }] }, limit: 200) {
          items { id name }
        }
      }
      distanceCache: items_page_by_column_values(board_id: $distBoard, columns: [{ column_id: $distCol, column_values: $empId }], limit: 1) {
        items { id column_values(ids: ["${DIST_JSON_COL}"]) { text } }
      }
    }
  `;

  try {
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
      body: JSON.stringify({
        query,
        variables: {
          planningBoard: String(PLANNING_BOARD), today: [today],
          projectsBoard: String(PROJECTS_BOARD), stageCol: PROJECT_STAGE_COL, stageVal: [String(PROJECT_ACTIVE_INDEX)],
          distBoard: String(DISTANCES_BOARD), distCol: DIST_EMP_ID_COL, empId: [employeeItemId]
        }
      })
    });
    const data = await r.json();
    if (data.errors) {
      res.status(502).json({ error: 'Erreur monday.com: ' + data.errors.map(e => e.message).join('; ') });
      return;
    }

    const planningItems = (data.data.planningToday && data.data.planningToday.items) || [];
    const mine = planningItems.filter(it => {
      const cv = (it.column_values || []).find(c => c.id === COL_MENUISIERS);
      const ids = (cv && cv.linked_item_ids) || [];
      return ids.map(String).includes(employeeItemId);
    }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const plannedProjects = mine.map(it => {
      const cv = (it.column_values || []).find(c => c.id === COL_PROJET);
      const linked = (cv && cv.linked_items && cv.linked_items[0]) || null;
      return linked ? { id: linked.id, name: linked.name } : null;
    }).filter(Boolean);

    const activeProjectsBoard = (data.data.activeProjects && data.data.activeProjects[0]) || null;
    const activeProjects = ((activeProjectsBoard && activeProjectsBoard.items_page && activeProjectsBoard.items_page.items) || [])
      .map(it => ({ id: it.id, name: it.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let kmSuggested = null;
    const distItems = (data.data.distanceCache && data.data.distanceCache.items) || [];
    if (distItems.length && plannedProjects.length) {
      try {
        const cv = (distItems[0].column_values || []).find(c => true);
        const json = JSON.parse((cv && cv.text) || '{}');
        const km = json[plannedProjects[0].id];
        if (typeof km === 'number') kmSuggested = km;
      } catch (e) { /* ignore, pas de suggestion */ }
    }

    res.status(200).json({ today, plannedProjects, activeProjects, kmSuggested });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
