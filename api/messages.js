// api/messages.js
// Envoi d'un message libre depuis l'interface mobile employé (ex. oubli de poinçon,
// erreur). Écrit dans le board Monday "💬 Messages poinçon", visible par l'admin.

const { verifyToken } = require('@clerk/backend');

const MESSAGES_BOARD = 18427410933;
const COL_EMPLOYE = 'board_relation_mm6dwczs';
const COL_MESSAGE = 'long_text_mm6dxv7r';
const COL_DATE = 'date_mm6dxf1a';
const COL_STATUT = 'color_mm6dfb7s';

function nowInToronto() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour === '24' ? '00' : map.hour}:${map.minute}` };
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
  const employeeName = meta.employeeName || 'Employé';

  const { message } = req.body || {};
  if (!message || !message.trim()) { res.status(400).json({ error: 'Message vide.' }); return; }
  if (message.length > 2000) { res.status(400).json({ error: 'Message trop long (max 2000 caractères).' }); return; }

  const now = nowInToronto();
  const columnValues = {
    [COL_EMPLOYE]: { item_ids: [Number(employeeItemId)] },
    [COL_MESSAGE]: { text: message.trim() },
    [COL_DATE]: { date: now.date, time: now.time + ':00' },
    [COL_STATUT]: { label: 'Nouveau' }
  };

  try {
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
      body: JSON.stringify({
        query: `mutation($board: ID!, $name: String!, $cv: JSON!) { create_item(board_id: $board, item_name: $name, column_values: $cv) { id } }`,
        variables: { board: String(MESSAGES_BOARD), name: `${employeeName} — ${now.date}`, cv: JSON.stringify(columnValues) }
      })
    });
    const data = await r.json();
    if (data.errors) { res.status(502).json({ error: 'Erreur monday.com: ' + data.errors.map(e => e.message).join('; ') }); return; }
    res.status(200).json({ itemId: data.data.create_item.id });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
