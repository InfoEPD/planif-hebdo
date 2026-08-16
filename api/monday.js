// api/monday.js
// Petite fonction serverless (Vercel) qui relaie les requêtes GraphQL vers
// l'API monday.com. Le jeton API monday.com (MONDAY_API_TOKEN) est lu depuis
// les variables d'environnement Vercel — il ne se trouve jamais dans le code
// ni dans le dépôt GitHub. Chaque requête doit fournir un jeton de session
// Clerk valide (utilisateur connecté) via l'en-tête Authorization.

const { verifyToken } = require('@clerk/backend');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: "CLERK_SECRET_KEY n'est pas configuré sur le serveur." });
    return;
  }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearerToken) {
    res.status(401).json({ error: 'Non authentifié.' });
    return;
  }
  try {
    await verifyToken(bearerToken, { secretKey });
  } catch (err) {
    res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
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
}
