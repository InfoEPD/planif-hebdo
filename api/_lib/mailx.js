// api/_lib/mailx.js — petits utilitaires de courriel partagés par les modules QRT et Fin de chantier.

const mail = require('./mail');
const po = require('./po');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = po.str;

function cleanEmails(arr) {
  const list = Array.from(new Set((Array.isArray(arr) ? arr : String(arr || '').split(/[,;\s]+/)).map(e => str(e, 200).toLowerCase()).filter(Boolean)));
  const bad = list.find(e => !po.isEmail(e));
  if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad };
  return list;
}
/** Copie : l'utilisateur + les chargés de projet du projet (sans doublon avec les destinataires). */
function ccFor(user, project, extra, to) {
  return Array.from(new Set([user.email].concat((project.cp || []).map(c => (c.email || '').toLowerCase()), (extra || []).map(e => String(e).toLowerCase()))
    .filter(e => e && po.isEmail(e) && !to.includes(e))));
}
const fileSafe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);

/** Courriel dont le corps peut contenir {{LISTE}} remplacé par un tableau HTML (blockHtml) / texte (blockText). */
async function send({ user, to, cc, subject, message, blockHtml, blockText, attachments }) {
  const parts = String(message || '').replace(/\r/g, '').split('{{LISTE}}');
  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:640px">' + esc(parts[0]).replace(/\n/g, '<br>');
  if (parts.length > 1) html += (blockHtml || '') + esc(parts.slice(1).join('')).replace(/\n/g, '<br>');
  html += '<p style="margin-top:18px">' + esc(user.name || user.email) + '<br>Les Entreprises Philippe Denis inc.</p>' +
    '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
  const text = parts.join(blockText ? '\n' + blockText + '\n' : '') + '\n\n' + (user.name || user.email) + '\nLes Entreprises Philippe Denis inc.';
  await mail.sendMail({ to: to.join(', '), cc: (cc || []).join(', '), replyTo: user.email, subject, html, text, attachments: attachments || [] });
}
const TH = 'style="text-align:left;padding:5px 8px;background:#eef2fa;border:1px solid #dde3ee;font-size:12.5px"';
const TD = 'style="padding:5px 8px;border:1px solid #dde3ee;font-size:13px;vertical-align:top"';
/** Tableau simple : headers [..], rows [[..]] */
function table(headers, rows) {
  const html = '<table style="border-collapse:collapse;margin:12px 0;width:100%"><tr>' + headers.map(h => '<th ' + TH + '>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map(c => '<td ' + TD + '>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';
  const text = rows.map(r => '  - ' + r.filter(Boolean).join(' — ')).join('\n');
  return { html, text };
}
module.exports = { esc, str, cleanEmails, ccFor, fileSafe, send, table };
