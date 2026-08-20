// api/employee-today.js
// Point d'accès ALLÉGÉ (interface mobile employé) : retourne uniquement ce dont
// l'employé connecté a besoin pour poinçonner aujourd'hui — pas tout le board
// de planification comme le fait api/monday.js pour l'app bureau. Nécessite un
// jeton de session Clerk valide dont les publicMetadata contiennent
// { role: 'employee', employeeItemId: '<id de l'item Monday employé>' }.
//
// IMPORTANT — étape de configuration Clerk requise (une seule fois) :
// Dans le Clerk Dashboard → Configure → Sessions → Edit → "Customize session token",
// ajouter la réclamation personnalisée :
//   "metadata": "{{user.public_metadata}}"
// Sans cette étape, publicMetadata n'apparaît pas dans le jeton vérifié ici et
// l'authentification échouera pour tous les comptes employé.

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

// Retourne les dates (YYYY-MM-DD) du lundi au vendredi de la semaine contenant `dateStr`.
function weekdayDates(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=dim .. 6=sam
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    dates.push(dd.toISOString().slice(0, 10));
  }
  return dates;
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
  const weekDates = weekdayDates(today);

  const query = `
    query($planningBoard: ID!, $week: [String]!, $projectsBoard: ID!, $stageCol: ID!, $stageVal: CompareValue!, $distBoard: ID!, $distCol: String!, $empId: [String]!) {
      planningWeek: items_page_by_column_values(board_id: $planningBoard, columns: [{ column_id: "${COL_DATE}", column_values: $week }], limit: 500) {
        items {
          id
          created_at
          column_values(ids: ["${COL_PROJET}", "${COL_MENUISIERS}", "${COL_DATE}"]) {
            id text
            ... on BoardRelationValue { linked_item_ids linked_items { id name } }
          }
        }
      }
      activeProjects: boards(ids: [$projectsBoard]) {
        items_page(query_params: { rules: [{ column_id: $stageCol, compare_value: $stageVal, operator: any_of }] }, limit: 200) {
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
          planningBoard: String(PLANNING_BOARD), week: weekDates,
          projectsBoard: String(PROJECTS_BOARD), stageCol: PROJECT_STAGE_COL, stageVal: [PROJECT_ACTIVE_INDEX],
          distBoard: String(DISTANCES_BOARD), distCol: DIST_EMP_ID_COL, empId: [employeeItemId]
        }
      })
    });
    const data = await r.json();
    if (data.errors) {
      res.status(502).json({ error: 'Erreur monday.com: ' + data.errors.map(e => e.message).join('; ') });
      return;
    }

    const weekItems = (data.data.planningWeek && data.data.planningWeek.items) || [];

    const dateOf = (it) => {
      const cv = (it.column_values || []).find(c => c.id === COL_DATE);
      return (cv && cv.text) || '';
    };
    const projectOf = (it) => {
      const cv = (it.column_values || []).find(c => c.id === COL_PROJET);
      const linked = (cv && cv.linked_items && cv.linked_items[0]) || null;
      return linked ? { id: linked.id, name: linked.name } : null;
    };

    // Projet(s) où l'employé connecté est planifié AUJOURD'HUI — présélectionné par défaut.
    const todayItems = weekItems.filter(it => dateOf(it) === today);
    const mine = todayItems.filter(it => {
      const cv = (it.column_values || []).find(c => c.id === COL_MENUISIERS);
      const ids = (cv && cv.linked_item_ids) || [];
      return ids.map(String).includes(employeeItemId);
    }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const plannedProjects = mine.map(projectOf).filter(Boolean);

    // Planification de l'employé pour CHAQUE jour de la semaine en cours (lecture seule,
    // ne va jamais au-delà de la semaine courante — voir bouton "Ma planification" mobile).
    const mineWeek = weekItems.filter(it => {
      const cv = (it.column_values || []).find(c => c.id === COL_MENUISIERS);
      const ids = (cv && cv.linked_item_ids) || [];
      return ids.map(String).includes(employeeItemId);
    });
    const scheduleByDate = new Map();
    mineWeek.forEach(it => {
      const d = dateOf(it);
      const p = projectOf(it);
      if (!d || !p) return;
      if (!scheduleByDate.has(d)) scheduleByDate.set(d, []);
      const arr = scheduleByDate.get(d);
      if (!arr.some(x => String(x.id) === String(p.id))) arr.push(p);
    });
    const mySchedule = weekDates.map(d => ({ date: d, projects: scheduleByDate.get(d) || [] }));

    // Tous les projets ayant au moins une personne RÉELLEMENT planifiée dans la semaine en cours
    // (tous employés confondus). On exclut les items dont la liste de menuisiers est vide —
    // ces projets sont "sans besoin de main d'œuvre" cette semaine-là et ne doivent pas apparaître.
    const weekProjectsMap = new Map();
    weekItems.forEach(it => {
      const menCv = (it.column_values || []).find(c => c.id === COL_MENUISIERS);
      const hasWorkers = ((menCv && menCv.linked_item_ids) || []).length > 0;
      if (!hasWorkers) return;
      const p = projectOf(it);
      if (p && !weekProjectsMap.has(String(p.id))) weekProjectsMap.set(String(p.id), p);
    });
    const weekProjects = Array.from(weekProjectsMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    // Filet de sécurité : projets marqués "actifs" au board Projets, même si personne n'y est
    // encore planifié cette semaine (permet quand même de poinçonner dessus au besoin).
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

    res.status(200).json({ today, plannedProjects, weekProjects, activeProjects, kmSuggested, mySchedule });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
