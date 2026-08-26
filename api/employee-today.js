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
// Coché = sur ce projet, l'employé ne peut poinçonner que des Tâches non-CCQ (voir Configuration
// dans admin-poincon.html).
const PROJECT_HORS_CCQ_COL = 'boolean_mm6eweyh';
 
const DISTANCES_BOARD = 18426435716;
const DIST_EMP_ID_COL = 'text_mm66z9bc';
const DIST_JSON_COL = 'long_text_mm668qje';
 
const EMPLOYEES_BOARD = 8371777574;
const EMP_TITRE_COL = 'statut_mkmx1x42'; // "Titre d'emploi" — détermine le Métier de l'employé
 
// ----- Poinçons (même board que api/punch.js) — utilisé UNIQUEMENT pour détecter un poinçon
// "ouvert" (début renseigné, fin manquante) créé manuellement par l'admin (admin.html, ajout
// manuel avec Début seul) : l'employé doit alors voir dès l'ouverture de l'app qu'il est
// actuellement poinçonné sur ce projet, sans avoir à cliquer "Débuter" lui-même.
const POINCONS_BOARD = 18427410930;
const COL_P_EMPLOYE = 'board_relation_mm6d1zaz';
const COL_P_PROJET = 'board_relation_mm6ddgy';
const COL_P_DATE = 'date_mm6d1p6e';
const COL_P_HEURE_DEBUT = 'hour_mm6dfaha';
const COL_P_HEURE_FIN = 'hour_mm6dfqfg';
const COL_P_TACHE = 'text_mm6enx2b';
 
// ----- Configuration Métiers / Tâches (voir admin-poincon.html, onglet Configuration) -----
const METIERS_BOARD = 18427580793;
const TACHES_BOARD = 18427580795;
const TACHE_METIER = 'board_relation_mm6exv06';
const TACHE_CCQ = 'boolean_mm6e9yfa';
 
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
    query($planningBoard: ID!, $week: [String]!, $projectsBoard: ID!, $stageCol: ID!, $stageVal: CompareValue!, $distBoard: ID!, $distCol: String!, $empId: [String]!, $empIds: [ID!], $metBoard: [ID!], $tachBoard: [ID!], $poinconsBoard: ID!, $pDateCol: String!, $pDate: [String]!) {
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
      poinconsToday: items_page_by_column_values(board_id: $poinconsBoard, columns: [{ column_id: $pDateCol, column_values: $pDate }], limit: 50) {
        items {
          id
          column_values(ids: ["${COL_P_EMPLOYE}", "${COL_P_PROJET}", "${COL_P_HEURE_DEBUT}", "${COL_P_HEURE_FIN}", "${COL_P_TACHE}"]) {
            id text
            ... on BoardRelationValue { linked_item_ids linked_items { id name } }
            ... on HourValue { hour minute }
          }
        }
      }
      activeProjects: boards(ids: [$projectsBoard]) {
        items_page(query_params: { rules: [{ column_id: $stageCol, compare_value: $stageVal, operator: any_of }] }, limit: 200) {
          items { id name column_values(ids: ["${PROJECT_HORS_CCQ_COL}"]) { id text } }
        }
      }
      distanceCache: items_page_by_column_values(board_id: $distBoard, columns: [{ column_id: $distCol, column_values: $empId }], limit: 1) {
        items { id column_values(ids: ["${DIST_JSON_COL}"]) { text } }
      }
      moi: items(ids: $empIds) {
        id column_values(ids: ["${EMP_TITRE_COL}"]) { id text }
      }
      metiers: boards(ids: $metBoard) { items_page(limit: 200) { items { id name } } }
      taches: boards(ids: $tachBoard) {
        items_page(limit: 500) {
          items {
            id name
            column_values(ids: ["${TACHE_METIER}", "${TACHE_CCQ}"]) {
              id text
              ... on BoardRelationValue { linked_items { id name } }
            }
          }
        }
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
          distBoard: String(DISTANCES_BOARD), distCol: DIST_EMP_ID_COL, empId: [employeeItemId],
          empIds: [employeeItemId], metBoard: [String(METIERS_BOARD)], tachBoard: [String(TACHES_BOARD)],
          poinconsBoard: String(POINCONS_BOARD), pDateCol: COL_P_DATE, pDate: [today]
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
    const horsCcqMap = new Map();
    const activeProjects = ((activeProjectsBoard && activeProjectsBoard.items_page && activeProjectsBoard.items_page.items) || [])
      .map(it => {
        const cv = (it.column_values || []).find(c => c.id === PROJECT_HORS_CCQ_COL);
        const horsCcq = (cv && cv.text) === 'v';
        horsCcqMap.set(String(it.id), horsCcq);
        return { id: it.id, name: it.name, horsCcq };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // plannedProjects/weekProjects viennent du board de planification (pas du board Projets) —
    // on leur annexe le flag horsCcq via la map ci-dessus (par défaut false si projet non actif).
    const withHorsCcq = p => ({ ...p, horsCcq: horsCcqMap.get(String(p.id)) || false });
    const plannedProjectsFlagged = plannedProjects.map(withHorsCcq);
    const weekProjectsFlagged = weekProjects.map(withHorsCcq);
    const mySchedule2 = mySchedule.map(d => ({ ...d, projects: d.projects.map(withHorsCcq) }));
 
    // Titre d'emploi de l'employé connecté → détermine son Métier et donc ses Tâches poinçonnables.
    const moiItem = (data.data.moi || [])[0];
    const moiCv = moiItem ? (moiItem.column_values || []).find(c => c.id === EMP_TITRE_COL) : null;
    const titre = (moiCv && moiCv.text) || '';
 
    const metierItems = ((data.data.metiers[0] && data.data.metiers[0].items_page.items) || []);
    const monMetier = metierItems.find(m => m.name === titre) || null;
    const tacheItems = ((data.data.taches[0] && data.data.taches[0].items_page.items) || []);
    const taches = tacheItems
      .map(it => {
        const cv = {};
        (it.column_values || []).forEach(c => { cv[c.id] = c; });
        const metCv = cv[TACHE_METIER];
        const met = (metCv && metCv.linked_items && metCv.linked_items[0]) || null;
        return { id: it.id, name: it.name, metierId: met ? met.id : '', ccq: (cv[TACHE_CCQ] && cv[TACHE_CCQ].text) === 'v' };
      })
      .filter(t => monMetier && t.metierId === monMetier.id)
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
 
    // Poinçon "ouvert" (début renseigné, fin manquante) créé pour aujourd'hui — que ce soit par
    // l'employé lui-même (app déjà en cours) ou manuellement par l'admin (ajout manuel avec Début
    // seul, voir handleManualAdd() dans admin.html). Le mobile s'en sert pour afficher l'écran
    // "actuellement poinçonné" dès l'ouverture, même si l'employé n'a jamais cliqué "Débuter" sur
    // cet appareil (localStorage vide).
    const poinconItems = (data.data.poinconsToday && data.data.poinconsToday.items) || [];
    let openPunch = null;
    for (const it of poinconItems) {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      const empCv = cv[COL_P_EMPLOYE];
      const empIds = (empCv && empCv.linked_item_ids) || [];
      if (!empIds.map(String).includes(employeeItemId)) continue;
      const debutCv = cv[COL_P_HEURE_DEBUT];
      const finCv = cv[COL_P_HEURE_FIN];
      const hasDebut = debutCv && typeof debutCv.hour === 'number';
      const hasFin = finCv && typeof finCv.hour === 'number';
      if (!hasDebut || hasFin) continue; // pas ouvert : soit pas de début, soit déjà terminé
      const projCv = cv[COL_P_PROJET];
      const proj = (projCv && projCv.linked_items && projCv.linked_items[0]) || null;
      openPunch = {
        itemId: it.id,
        projectId: proj ? proj.id : null,
        projectName: proj ? proj.name : '',
        tache: (cv[COL_P_TACHE] && cv[COL_P_TACHE].text) || '',
        hour: debutCv.hour, minute: debutCv.minute,
        date: today
      };
      break;
    }
 
    res.status(200).json({
      today, plannedProjects: plannedProjectsFlagged, weekProjects: weekProjectsFlagged, activeProjects,
      kmSuggested, mySchedule: mySchedule2, titre, taches, openPunch
    });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
