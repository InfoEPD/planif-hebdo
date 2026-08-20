// api/employee-messages.js
// Fil de messages de l'employé connecté (messages envoyés par l'employé ET par l'admin),
// avec suivi de lecture. Nécessite un jeton de session Clerk avec publicMetadata.role
// === 'employee'.
//
// Actions (POST body { action }) :
//   'list'     (défaut) — retourne { messages: [...], unreadCount } où unreadCount = nombre
//              de messages envoyés par l'ADMIN que l'employé n'a pas encore lus (pour la
//              pastille rouge sur le bouton "Mes messages").
//   'markRead' — marque comme lus (côté employé) tous les messages admin non lus. Retourne
//              { ok: true }.

const { verifyToken } = require('@clerk/backend');

const MESSAGES_BOARD = 18427410933;
const M_EMPLOYE = 'board_relation_mm6dwczs';
const M_MESSAGE = 'long_text_mm6dxv7r';
const M_DATE = 'date_mm6dxf1a';
const M_STATUT = 'color_mm6dfb7s';
const M_REPONSE = 'long_text_mm6deccf';
const M_REPONSE_DATE = 'date_mm6da4sc';
const M_AUTEUR = 'color_mm6dd12s';
const M_LU_ADMIN = 'boolean_mm6dm8mb';
const M_LU_EMPLOYE = 'boolean_mm6dc4ar';

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
  const employeeItemId = Number(meta.employeeItemId);
  const action = (req.body && req.body.action) || 'list';

  try {
    const data = await mondayGraphQL(mondayToken, `
      query($board: [ID!], $empId: CompareValue!, $empCol: ID!) {
        boards(ids: $board) {
          items_page(query_params: { rules: [{ column_id: $empCol, compare_value: $empId, operator: any_of }] }, limit: 200) {
            items {
              id
              column_values(ids: ["${M_MESSAGE}", "${M_DATE}", "${M_STATUT}", "${M_REPONSE}", "${M_REPONSE_DATE}", "${M_AUTEUR}", "${M_LU_ADMIN}", "${M_LU_EMPLOYE}"]) {
                id text
              }
            }
          }
        }
      }
    `, { board: [String(MESSAGES_BOARD)], empId: [employeeItemId], empCol: M_EMPLOYE });

    const items = ((data.boards[0] && data.boards[0].items_page.items) || []);
    const parsed = items.map(it => {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      return {
        itemId: it.id,
        message: (cv[M_MESSAGE] && cv[M_MESSAGE].text) || '',
        date: (cv[M_DATE] && cv[M_DATE].text) || '',
        statut: (cv[M_STATUT] && cv[M_STATUT].text) || 'Nouveau',
        reponse: (cv[M_REPONSE] && cv[M_REPONSE].text) || '',
        reponseDate: (cv[M_REPONSE_DATE] && cv[M_REPONSE_DATE].text) || '',
        // Messages créés avant l'ajout de la colonne "Auteur" n'ont pas cette valeur —
        // on les traite comme envoyés par l'employé (comportement historique).
        auteur: (cv[M_AUTEUR] && cv[M_AUTEUR].text) || 'Employé',
        luAdmin: (cv[M_LU_ADMIN] && cv[M_LU_ADMIN].text) === 'v',
        luEmploye: (cv[M_LU_EMPLOYE] && cv[M_LU_EMPLOYE].text) === 'v'
      };
    }).filter(m => m.date);

    if (action === 'markRead') {
      const toMark = parsed.filter(m => m.auteur === 'Admin' && !m.luEmploye);
      for (const m of toMark) {
        await mondayGraphQL(mondayToken, `
          mutation($board: ID!, $item: ID!, $cv: JSON!) {
            change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
          }
        `, { board: String(MESSAGES_BOARD), item: String(m.itemId), cv: JSON.stringify({ [M_LU_EMPLOYE]: { checked: 'true' } }) });
      }
      res.status(200).json({ ok: true, marked: toMark.length });
      return;
    }

    // action === 'list' (défaut)
    const messages = parsed.slice().sort((a, b) => b.date.localeCompare(a.date));
    const unreadCount = parsed.filter(m => m.auteur === 'Admin' && !m.luEmploye).length;
    res.status(200).json({ messages, unreadCount });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
