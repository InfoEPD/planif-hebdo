// api/send-schedule.js
// Petite fonction serverless (Vercel) qui envoie les courriels d'horaire via votre
// boîte courriel Outlook / Microsoft 365, en utilisant SMTP. Les identifiants
// (SMTP_USER, SMTP_PASSWORD) et le mot de passe d'équipe (APP_PASSWORD) sont lus
// depuis les variables d'environnement Vercel — ils ne se trouvent jamais dans le
// code ni dans le dépôt GitHub.

const nodemailer = require('nodemailer');

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

  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  if (!smtpUser || !smtpPassword) {
    res.status(500).json({ error: "SMTP_USER / SMTP_PASSWORD ne sont pas configurés sur le serveur." });
    return;
  }

  const { emails } = req.body || {};
  if (!Array.isArray(emails) || !emails.length) {
    res.status(400).json({ error: 'Aucun courriel à envoyer.' });
    return;
  }
  if (emails.length > 200) {
    res.status(400).json({ error: 'Trop de destinataires en une seule fois (max 200).' });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false, // STARTTLS sur le port 587
    requireTLS: true,
    auth: { user: smtpUser, pass: smtpPassword }
  });

  const results = [];
  for (const item of emails) {
    const { to, subject, text, html } = item || {};
    if (!to || !subject || (!text && !html)) {
      results.push({ to: to || '?', ok: false, error: 'Champs manquants (to/subject/text ou html).' });
      continue;
    }
    try {
      const info = await transporter.sendMail({ from: smtpUser, to, subject, text, html });
      results.push({ to, ok: true, id: info.messageId });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }

  res.status(200).json({ results });
};
