// api/monday.js
// Petite fonction serverless (Vercel) qui relaie les requêtes GraphQL vers
// l'API monday.com. Le jeton API monday.com (MONDAY_API_TOKEN) et le mot de
// passe d'équipe (APP_PASSWORD) sont lus depuis les variables d'environnement
// Vercel — ils ne se trouvent jamais dans le code ni dans le dépôt GitHub.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  const appPassword = process.env.APP_PASSWORD;
  const suppliedPassword = req.headers['x-app-password'];
  if (!appPassword) {
    res.status(500).json({ error: "APP_PASSWORD n'est pas configuré sur le serveur." });
    return;
  }
  if (suppliedPassword !== appPassword) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }

  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!mondayToken) {
    res.status(500).json({ error: "MONDAY_API_TOKEN n'est pas configuré sur le serveur." });
    return;
  }

  const { query, variables } = req.body || {};
  if (!query) {
    res.status(400).json({ error: 'Requête GraphQL manquante.' });
    return;
  }

  try {
    const mondayRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': mondayToken,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({ query, variables })
    });
    const data = await mondayRes.json();
    res.status(mondayRes.ok ? 200 : mondayRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
