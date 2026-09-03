// Petite fonction serverless (Vercel) qui envoie les courriels d'horaire via votre
// boîte courriel Outlook / Microsoft 365, en utilisant SMTP. Les identifiants
// (SMTP_USER, SMTP_PASSWORD) sont lus depuis les variables d'environnement Vercel
// — ils ne se trouvent jamais dans le code ni dans le dépôt GitHub. Chaque requête
// doit fournir un jeton de session Clerk valide (utilisateur connecté).
const nodemailer = require('nodemailer');
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
