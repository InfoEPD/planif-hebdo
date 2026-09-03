// api/employee-messages.js
// Historique des messages envoyés par l'employé connecté depuis le mobile, incluant la
// réponse de l'administrateur le cas échéant. Nécessite un jeton de session Clerk avec
// publicMetadata.role === 'employee'.

const { verifyToken } = require('@clerk/backend');

const MESSAGES_BOARD = 18427410933;
const M_EMPLOYE = 'board_relation_mm6dwczs';
const M_MESSAGE = 'long_text_mm6dxv7r';
const M_DATE = 'date_mm6dxf1a';
const M_STATUT = 'color_mm6dfb7s';
const M_REPONSE = 'long_text_mm6deccf';
const M_REPONSE_DATE = 'date_mm6da4sc';

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
  // Garde multi-tenant : ce fichier est réservé aux comptes EPD (voir Plan-Technique-Multi-Entite-Exacto.md).
  // Un tenantId défini et différent de 'EPD' n'a pas accès ici.
  if (claims.tenantId && claims.tenantId !== 'EPD') {
    res.status(403).json({ error: "Ce compte n'a pas accès à cette application." });
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
              items_page(query_params: { rules: [{ column_id: $empCol, compare_value: $empId, operator: any_of }] }, limit: 200) {
                items {
                  id
                  column_values(ids: ["${M_MESSAGE}", "${M_DATE}", "${M_STATUT}", "${M_REPONSE}", "${M_REPONSE_DATE}"]) {
                    id text
                  }
                }
              }
            }
          }
        `,
        variables: { board: [String(MESSAGES_BOARD)], empId: [employeeItemId], empCol: M_EMPLOYE }
      })
    });
    const data = await r.json();
    if (data.errors) {
      res.status(502).json({ error: 'Erreur monday.com: ' + data.errors.map(e => e.message).join('; ') });
      return;
    }

    const items = ((data.data.boards[0] && data.data.boards[0].items_page.items) || []);
    const messages = items.map(it => {
      const cv = {};
      (it.column_values || []).forEach(c => { cv[c.id] = c; });
      return {
        itemId: it.id,
        message: (cv[M_MESSAGE] && cv[M_MESSAGE].text) || '',
        date: (cv[M_DATE] && cv[M_DATE].text) || '',
        statut: (cv[M_STATUT] && cv[M_STATUT].text) || 'Nouveau',
        reponse: (cv[M_REPONSE] && cv[M_REPONSE].text) || '',
        reponseDate: (cv[M_REPONSE_DATE] && cv[M_REPONSE_DATE].text) || ''
      };
    }).filter(m => m.date).sort((a, b) => b.date.localeCompare(a.date));

    res.status(200).json({ messages });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
