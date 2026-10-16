// api/_lib/mail.js
// Envoi de courriels via la boîte Microsoft 365 existante (SMTP, mêmes variables que l'horaire Planif) :
//   SMTP_USER, SMTP_PASSWORD   (obligatoires)
//   FINANCE_FROM_NAME          nom affiché (défaut « Les Entreprises Philippe Denis »)

const nodemailer = require('nodemailer');

let _tx = null;
function transporter() {
  if (_tx) return _tx;
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) throw { status: 500, message: "SMTP_USER / SMTP_PASSWORD ne sont pas configurés sur le serveur." };
  _tx = nodemailer.createTransport({
    host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true,
    auth: { user, pass }
  });
  return _tx;
}

function fromHeader() {
  const name = (process.env.FINANCE_FROM_NAME || 'Les Entreprises Philippe Denis').replace(/["\r\n]/g, '');
  return '"' + name + '" <' + process.env.SMTP_USER + '>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendMail({ to, cc, bcc, replyTo, subject, html, text, attachments, headers }) {
  const tx = transporter();
  try {
    return await tx.sendMail({ from: fromHeader(), to, cc, bcc, replyTo, subject, html, text, attachments, headers });
  } catch (e) {
    throw { status: 502, message: "Échec de l'envoi du courriel : " + (e.message || e) };
  }
}

function shell(inner) {
  return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:560px">' + inner +
    '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
}

// ---------- Gabarit du courriel d'envoi du bon de commande ------------------------------------
// Variables remplacées : [NOM DU PROJET], [NOM DU SOUS-TRAITANT], [NUMERO DU PROJET].
// {{LIEN}} = lien de signature (affiché « Utilisez ce lien pour l'accepter. »).
// Mise en forme reconnue : ligne « * texte » = puce ; **texte** = gras ; ligne vide = nouveau paragraphe.

const LINK_TOKEN = '{{LIEN}}';
const DEFAULT_SUBJECT = 'Votre bon de commande - [NOM DU PROJET]';
const DEFAULT_BODY = [
  'Bonjour [NOM DU SOUS-TRAITANT],',
  '',
  'À la suite des derniers échanges et à la confirmation officielle de notre client, nous avons le plaisir de vous transmettre votre bon de commande pour le projet [NOM DU PROJET] (No. de projet : [NUMERO DU PROJET]).',
  '',
  'Veuillez cliquer sur le lien ci-dessous afin de signer le bon de commande.',
  '',
  LINK_TOKEN,
  '',
  'Votre implication dans ce projet est grandement appréciée, et nous avons confiance que les travaux se dérouleront dans le même esprit de rigueur et de collaboration que vous démontrez déjà.',
  '',
  'Voici les documents que vous avez à nous fournir :',
  '',
  '* Le nom et les coordonnées complètes de tous les intervenants qui devront être ajoutés dans les communications sur ce projet, soit : chargé de projets, adjoint/adjointe, contremaître, etc.',
  '* Guide de prévention',
  '* Dessins d\'atelier pour approbation',
  '* Attestation Revenu Québec',
  '* Preuve d\'assurance',
  '* Bon de commande signé',
  '* Copie de licence RBQ',
  '',
  '**Pour toutes communications en lien avec ce projet, le chargé de projets doit être ajouté en copie conforme.**',
  '',
  'Également, afin d\'assurer une bonne communication pendant la durée du mandat, veuillez conserver notre numéro de référence/projet à l\'interne.',
  '',
  'N\'hésitez pas à communiquer avec nous pour toute précision. Toute l\'équipe EPD est mobilisée pour livrer ce projet avec qualité, dans le respect des engagements et des échéanciers.',
  '',
  'Au plaisir de collaborer avec vous sur ce chantier !'
].join('\n');

// Gabarit utilisé quand le bon de commande a été rouvert puis renvoyé (révision ≥ 1).
const REVISED_SUBJECT = 'Bon de commande révisé - [NOM DU PROJET]';
const REVISED_BODY = [
  'Bonjour [NOM DU SOUS-TRAITANT],',
  '',
  'À la suite de nos échanges, veuillez trouver ci-joint la version révisée de votre bon de commande pour le projet [NOM DU PROJET] (No. de projet : [NUMERO DU PROJET]).',
  '',
  'Cette version remplace la précédente : le lien de signature que vous aviez reçu n\'est plus valide. Veuillez cliquer sur le lien ci-dessous afin de signer la version révisée.',
  '',
  LINK_TOKEN,
  '',
  '**Pour toutes communications en lien avec ce projet, le chargé de projets doit être ajouté en copie conforme.**',
  '',
  'N\'hésitez pas à communiquer avec nous pour toute précision.',
  '',
  'Au plaisir de collaborer avec vous sur ce chantier !'
].join('\n');

function fillVars(str, po) {
  return String(str)
    .replace(/\[NOM DU PROJET\]/g, po.project_name || po.project_number || '')
    .replace(/\[NOM DU SOUS-TRAITANT\]/g, po.supplier_name || '')
    .replace(/\[NUMERO DU PROJET\]/g, po.project_number || '');
}

/** Objet + corps proposés (variables déjà remplacées ; modifiables par l'utilisateur avant l'envoi). */
function emailDraft(po) {
  const rev = po.revision > 0;
  return { subject: fillVars(rev ? REVISED_SUBJECT : DEFAULT_SUBJECT, po), body: fillVars(rev ? REVISED_BODY : DEFAULT_BODY, po) };
}

function inline(s) { return esc(s).replace(/\*\*\s*(.+?)\s*\*\*/g, '<b>$1</b>'); }

function bodyToHtml(body, signUrl) {
  const linkHtml = '<a href="' + esc(signUrl) + '" style="color:#2f5bea;font-weight:600">Utilisez ce lien pour l\'accepter.</a>';
  const blocks = String(body).replace(/\r/g, '').split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n');
    if (lines.every(l => /^\s*[*-]\s+/.test(l))) {
      return '<ul style="margin:6px 0 6px 18px;padding:0">' + lines.map(l => '<li style="margin:3px 0">' + inline(l.replace(/^\s*[*-]\s+/, '')) + '</li>').join('') + '</ul>';
    }
    return '<p style="margin:0 0 12px">' + lines.map(l => l.trim() === LINK_TOKEN ? linkHtml : inline(l).split(LINK_TOKEN).join(linkHtml)).join('<br>') + '</p>';
  }).join('');
}

/** Courriel au fournisseur : texte du gabarit (modifié ou non) + lien de signature ; le PDF est joint par l'appelant. */
function supplierMail({ po, signUrl, subject, body }) {
  const d = emailDraft(po);
  const subj = (subject && String(subject).trim()) || d.subject;
  let text = (body && String(body).trim()) || d.body;
  if (text.indexOf(LINK_TOKEN) === -1) text += '\n\n' + LINK_TOKEN; // le lien de signature ne doit jamais manquer
  const html = shell(bodyToHtml(text, signUrl));
  const plain = text.replace(/\*\*\s*(.+?)\s*\*\*/g, '$1').split(LINK_TOKEN).join("Utilisez ce lien pour l'accepter : " + signUrl);
  return { subject: subj, html, text: plain };
}

/** Courriel de confirmation (interne + fournisseur) avec le PDF signé. */
function signedMail({ po, forSupplier }) {
  const who = esc(po.signer_name) + (po.signer_title ? ', ' + esc(po.signer_title) : '');
  const html = shell(
    '<p>Bonjour,</p>' +
    (forSupplier
      ? '<p>Nous confirmons la réception de votre signature sur le bon de commande <b>' + esc(po.po_number) + '</b>. Vous trouverez en pièce jointe la copie signée.</p><p>Rappel : toute facture doit indiquer le numéro <b>' + esc(po.po_number) + '</b>.</p>'
      : '<p>Le bon de commande <b>' + esc(po.po_number) + '</b> (' + esc(po.supplier_name) + ') a été <b>signé</b> par ' + who + '.</p><p>La copie signée est en pièce jointe.</p>') +
    '<p>Merci,<br>Exacto-Finance</p>'
  );
  const text = forSupplier
    ? 'Nous confirmons la réception de votre signature sur le bon de commande ' + po.po_number + '. Copie signée en pièce jointe.'
    : 'Le bon de commande ' + po.po_number + ' (' + po.supplier_name + ') a été signé par ' + po.signer_name + '. Copie signée en pièce jointe.';
  return {
    subject: (forSupplier ? 'Copie signée — ' : 'Signé — ') + 'bon de commande ' + po.po_number + ' — ' + po.supplier_name,
    html, text
  };
}

function moneyFr(n) { return Number(n || 0).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $'; }

/** Avis au chargé de projet : une facture l'attend. */
function invoiceApprovalMail({ inv, url }) {
  const html = shell(
    '<p>Bonjour,</p>' +
    '<p>Une facture du projet <b>' + esc(inv.project_number) + (inv.project_name ? ' — ' + esc(inv.project_name) : '') + '</b> attend votre approbation :</p>' +
    '<ul style="margin:6px 0 12px 18px;padding:0"><li>Fournisseur : <b>' + esc(inv.supplier_name) + '</b></li>' +
    '<li>No. de facture : <b>' + esc(inv.invoice_number) + '</b></li>' +
    '<li>Montant total : <b>' + esc(moneyFr(inv.total)) + '</b>' + (inv.po_number ? ' (bon de commande ' + esc(inv.po_number) + ')' : '') + '</li></ul>' +
    '<p><a href="' + esc(url) + '" style="color:#2f5bea;font-weight:600">Ouvrir Exacto-Finance pour approuver</a></p>'
  );
  return {
    subject: 'Facture à approuver — ' + inv.supplier_name + ' — ' + inv.project_number,
    html,
    text: 'Une facture du projet ' + inv.project_number + ' attend votre approbation : ' + inv.supplier_name + ', facture ' + inv.invoice_number + ', ' + moneyFr(inv.total) + '. ' + url
  };
}

/** Récapitulatif quotidien aux chargés de projet : factures en attente d'approbation. */
function invoiceDigestMail({ invoices, url }) {
  const fresh = invoices.filter(i => !i.cp_notified_at), old = invoices.filter(i => i.cp_notified_at);
  const d = v => { if (!v) return ''; const x = String(v instanceof Date ? v.toISOString() : v).slice(0, 10); const mm = x.match(/^(\d{4})-(\d{2})-(\d{2})$/); return mm ? mm[3] + '/' + mm[2] + '/' + mm[1] : x; };
  const table = list => '<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>' +
    ['Date facture', 'Fournisseur', 'N° facture', 'Projet', 'Montant avant taxes'].map((h, i) => '<th style="text-align:' + (i === 4 ? 'right' : 'left') + ';padding:6px 8px;border-bottom:2px solid #dde3ee;color:#5b6a85;font-size:12px">' + h + '</th>').join('') + '</tr></thead><tbody>' +
    list.map(i => '<tr><td style="padding:6px 8px;border-bottom:1px solid #eef1f7;white-space:nowrap">' + esc(d(i.invoice_date)) + '</td><td style="padding:6px 8px;border-bottom:1px solid #eef1f7">' + esc(i.supplier_name) + '</td><td style="padding:6px 8px;border-bottom:1px solid #eef1f7">' + esc(i.invoice_number) + '</td><td style="padding:6px 8px;border-bottom:1px solid #eef1f7">' + esc(i.project_number) + (i.project_name ? ' — ' + esc(i.project_name) : '') + '</td><td style="padding:6px 8px;border-bottom:1px solid #eef1f7;text-align:right;white-space:nowrap">' + esc(moneyFr(i.subtotal)) + '</td></tr>').join('') + '</tbody></table>';
  const sum = list => list.reduce((s, i) => s + (Number(i.subtotal) || 0), 0);
  const html = shell(
    '<p>Bonjour,</p><p>Voici le récapitulatif des factures qui attendent votre approbation (<b>' + fresh.length + ' nouvelle' + (fresh.length > 1 ? 's' : '') + '</b>' + (old.length ? ', ' + old.length + ' déjà signalée' + (old.length > 1 ? 's' : '') : '') + ').</p>' +
    '<h3 style="margin:14px 0 6px;font-size:14px">Nouvelles factures — ' + esc(moneyFr(sum(fresh))) + '</h3>' + table(fresh) +
    (old.length ? '<h3 style="margin:18px 0 6px;font-size:14px;color:#5b6a85">Toujours en attente — ' + esc(moneyFr(sum(old))) + '</h3>' + table(old) : '') +
    '<p style="margin-top:16px"><a href="' + esc(url) + '" style="color:#2f5bea;font-weight:600">Ouvrir Exacto-Finance pour approuver</a></p>'
  ).replace('max-width:560px', 'max-width:760px');
  const line = i => '- ' + d(i.invoice_date) + ' | ' + i.supplier_name + ' | ' + i.invoice_number + ' | ' + i.project_number + ' | ' + moneyFr(i.subtotal);
  return {
    subject: 'Factures à approuver — ' + fresh.length + ' nouvelle' + (fresh.length > 1 ? 's' : '') + (invoices.length > fresh.length ? ' (' + invoices.length + ' en attente)' : ''),
    html,
    text: 'Factures à approuver :\n' + invoices.map(line).join('\n') + '\n\n' + url
  };
}

/** Avis à la comptabilité : le chargé de projet a refusé la facture. */
function invoiceRefusedMail({ inv, by, comment, url }) {
  const html = shell(
    '<p>Bonjour,</p>' +
    '<p><b>' + esc(by) + '</b> a refusé la facture <b>' + esc(inv.invoice_number) + '</b> de ' + esc(inv.supplier_name) + ' (projet ' + esc(inv.project_number) + ').</p>' +
    '<p style="background:#fff1d9;border-radius:8px;padding:9px 12px">' + esc(comment) + '</p>' +
    '<p>Elle est retournée à la comptabilité pour correction. <a href="' + esc(url) + '" style="color:#2f5bea;font-weight:600">Ouvrir Exacto-Finance</a></p>'
  );
  return {
    subject: 'Facture refusée — ' + inv.supplier_name + ' — ' + inv.invoice_number,
    html,
    text: by + ' a refusé la facture ' + inv.invoice_number + ' de ' + inv.supplier_name + ' : ' + comment + ' ' + url
  };
}

module.exports = { sendMail, shell, esc, supplierMail, signedMail, emailDraft, LINK_TOKEN, invoiceApprovalMail, invoiceDigestMail, invoiceRefusedMail };
