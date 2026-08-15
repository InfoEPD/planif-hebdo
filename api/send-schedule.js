// api/send-schedule.js
// Petite fonction serverless (Vercel) qui envoie les courriels d'horaire via l'API
// Resend. La clé API Resend (RESEND_API_KEY) et le mot de passe d'équipe
// (APP_PASSWORD) sont lus depuis les variables d'environnement Vercel — ils ne se
// trouvent jamais dans le code ni dans le dépôt GitHub.

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

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    res.status(500).json({ error: "RESEND_API_KEY n'est pas configuré sur le serveur." });
    return;
  }
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const { emails } = req.body || {};
  if (!Array.isArray(emails) || !emails.length) {
    res.status(400).json({ error: 'Aucun courriel à envoyer.' });
    return;
  }
  if (emails.length > 200) {
    res.status(400).json({ error: 'Trop de destinataires en une seule fois (max 200).' });
    return;
  }

  const results = [];
  for (const item of emails) {
    const { to, subject, text, html } = item || {};
    if (!to || !subject || (!text && !html)) {
      results.push({ to: to || '?', ok: false, error: 'Champs manquants (to/subject/text ou html).' });
      continue;
    }
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`
        },
        body: JSON.stringify({ from: fromEmail, to: [to], subject, text, html })
      });
      const data = await resendRes.json();
      if (resendRes.ok) {
        results.push({ to, ok: true, id: data.id });
      } else {
        results.push({ to, ok: false, error: (data && (data.message || data.error)) || `HTTP ${resendRes.status}` });
      }
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }

  res.status(200).json({ results });
};
