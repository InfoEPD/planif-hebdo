// api/_lib/sharepoint.js
//
// Dépôt des PDF dans SharePoint via Microsoft Graph (application Entra ID, permission d'application
// Sites.Selected, secret client). Optionnel : tant que les variables ne sont pas définies, le statut
// reste « non configuré » et les fichiers restent disponibles dans l'application.
//
// Arborescence EPD (un dossier par projet, déjà existant, « 26107-Entrepot Trecarre ») :
//   {base}/{dossier du projet}/0 - Projet partage/Bon de commande/{n° BC} - {fournisseur}.pdf
//   {base}/{dossier du projet}/Facture/{fournisseur} - {n° facture}.pdf
// Le dossier du projet est RETROUVÉ par son numéro (début du nom) dans le dossier de base : on ne le
// fabrique jamais à partir du nom Monday (les noms de dossiers sont sans accents, parfois abrégés).
//
// Variables d'environnement :
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
//   SHAREPOINT_SITE_URL         ex. https://coffrage1810.sharepoint.com/sites/EntreprisePhilippeDenis
//                               (ou SHAREPOINT_SITE_ID, ou SHAREPOINT_DRIVE_ID)
//   SHAREPOINT_BASE_PATH        dossier des projets dans la bibliothèque, ex. EPD/Projets
//   SHAREPOINT_PO_SUBPATH       (facultatif) défaut « 0 - Projet partage/Bon de commande »
//   SHAREPOINT_INVOICE_SUBPATH  (facultatif) défaut « Facture »
//   SHAREPOINT_DIRECTIVE_SUBPATH (facultatif) défaut « 0 - Projet partage/Directives »
//   SHAREPOINT_QRT_SUBPATH      (facultatif) défaut « 0 - Projet partage/QRT »
//   SHAREPOINT_FC_SUBPATH       (facultatif) défaut « Fin de chantier »

function isConfigured() {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET &&
    (process.env.SHAREPOINT_SITE_ID || process.env.SHAREPOINT_DRIVE_ID || process.env.SHAREPOINT_SITE_URL));
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const r = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(process.env.MS_TENANT_ID) + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Jeton Microsoft refusé : ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

function safeSegment(s) {
  return String(s || '').replace(/[\\/:*?"<>|#%~&{}]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || '_';
}

const G = 'https://graph.microsoft.com/v1.0';
let siteCache = null;

async function siteId(token) {
  if (process.env.SHAREPOINT_SITE_ID) return process.env.SHAREPOINT_SITE_ID;
  if (siteCache) return siteCache;
  let u;
  try { u = new URL(process.env.SHAREPOINT_SITE_URL); } catch (e) { throw new Error('SHAREPOINT_SITE_URL invalide.'); }
  const r = await fetch(G + '/sites/' + u.hostname + ':' + u.pathname.replace(/\/+$/, ''), { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('Site SharePoint introuvable (' + r.status + ') : ' + ((j.error && j.error.message) || 'vérifiez SHAREPOINT_SITE_URL et le droit accordé à l\'application sur ce site'));
  siteCache = j.id;
  return siteCache;
}

async function driveBase(token) {
  if (process.env.SHAREPOINT_DRIVE_ID) return G + '/drives/' + encodeURIComponent(process.env.SHAREPOINT_DRIVE_ID);
  return G + '/sites/' + encodeURIComponent(await siteId(token)) + '/drive';
}

function safeSegments(path) {
  return String(path || '').split('/').map(x => x.trim()).filter(Boolean).map(safeSegment);
}
const enc = parts => parts.map(encodeURIComponent).join('/');

function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

const folderCache = new Map(); // numéro de projet -> { at, name }

/** Retrouve le dossier existant du projet (« 26107-Entrepot Trecarre ») d'après son numéro. */
async function projectFolderName(token, base, projectNumber, projectName) {
  const num = String(projectNumber || '').trim();
  if (!num) throw new Error('Numéro de projet manquant : dossier SharePoint introuvable.');
  const hit = folderCache.get(num);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name;

  const basePath = enc(safeSegments(process.env.SHAREPOINT_BASE_PATH));
  let url = base + (basePath ? '/root:/' + basePath + ':' : '/root') + '/children?$top=999&$select=name,folder';
  const names = [];
  for (let i = 0; i < 6 && url; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('SharePoint (' + r.status + ') : lecture du dossier des projets impossible — ' + ((j.error && j.error.message) || ''));
    (j.value || []).forEach(x => { if (x.folder) names.push(x.name); });
    url = j['@odata.nextLink'] || null;
  }
  // Le numéro peut contenir des tirets (projets généraux « 00-99 ») : les séparateurs sont facultatifs entre ses segments.
  const tokens = num.split(/[^0-9A-Za-z]+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('^' + tokens.join('[-–_\\s.]*') + '(?![0-9])\\s*[-–_ ]', 'i');
  const cands = names.filter(n => re.test(n.replace(/[^0-9A-Za-z\s\-–_]/g, '')) || n === num);
  let pick = null;
  if (cands.length === 1) pick = cands[0];
  else if (cands.length > 1) {
    // plusieurs dossiers pour le même numéro : on retient celui dont le nom ressemble le plus au projet Monday
    const pn = norm(projectName);
    const scored = cands.map(n => ({ n, score: pn ? norm(n.replace(/^[0-9A-Za-z]+\s*[-–_ ]/, '')).split(' ').filter(w => w.length > 2 && pn.includes(w)).length : 0 })).sort((a, b) => b.score - a.score);
    if (scored[0].score >= 2 && scored[0].score > scored[1].score) pick = scored[0].n;
    else throw new Error('Plusieurs dossiers SharePoint commencent par ' + num + ' (' + cands.join(' ; ') + ') : impossible de choisir. Déposez le fichier à la main ou renommez un des dossiers.');
  }
  if (!pick) throw new Error('Dossier du projet ' + num + ' introuvable dans SharePoint (' + (process.env.SHAREPOINT_BASE_PATH || 'racine') + ').');
  folderCache.set(num, { at: Date.now(), name: pick });
  return pick;
}

async function fullPath(token, base, projectNumber, projectName, sub, filename) {
  const folder = await projectFolderName(token, base, projectNumber, projectName);
  const bp = safeSegments(process.env.SHAREPOINT_BASE_PATH);
  // le nom du dossier du projet est utilisé tel quel (déjà valide dans SharePoint)
  return enc(bp.concat([folder], safeSegments(sub), [safeSegment(filename)]));
}

/** Dépose le bon de commande signé ; retourne { webUrl, path }. */
async function uploadPdf(po, bytes) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_PO_SUBPATH || '0 - Projet partage/Bon de commande';
  const path = await fullPath(token, base, po.project_number, po.project_name, sub, po.po_number + ' - ' + safeSegment(po.supplier_name) + '.pdf');
  return putBytes(path, bytes, 'application/pdf');
}

/** Dépose la facture approuvée dans le dossier « Facture » du projet. */
async function uploadInvoice(inv, bytes, contentType, ext) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_INVOICE_SUBPATH || 'Facture';
  const path = await fullPath(token, base, inv.project_number, inv.project_name, sub, safeSegment(inv.supplier_name || 'Fournisseur') + ' - ' + safeSegment(inv.invoice_number || 'facture') + (ext || '.pdf'));
  return putBytes(path, bytes, contentType || 'application/pdf');
}

/** Dépose l'avis de changement approuvé (signé) dans « 0 - Projet partage/Directives » du projet. */
async function uploadDirective(chg, bytes, filename) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_DIRECTIVE_SUBPATH || '0 - Projet partage/Directives';
  const path = await fullPath(token, base, chg.project_number, chg.project_name, sub, filename);
  return putBytes(path, bytes, 'application/pdf');
}

/** Dépose un DA / fiche technique approuvé dans « 0 - Projet partage/DA et FT » du projet. */
async function uploadDa(da, bytes, filename) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_DA_SUBPATH || '0 - Projet partage/DA et FT';
  const path = await fullPath(token, base, da.project_number, da.project_name, sub, filename);
  return putBytes(path, bytes, 'application/pdf');
}

/** Dépose la réponse d'une QRT dans « 0 - Projet partage/QRT » du projet (SHAREPOINT_QRT_SUBPATH pour changer). */
async function uploadQrt(q, bytes, filename) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_QRT_SUBPATH || '0 - Projet partage/QRT';
  const path = await fullPath(token, base, q.project_number, q.project_name, sub, filename);
  return putBytes(path, bytes, 'application/pdf');
}

/** Dépose un document de fin de chantier dans « Fin de chantier » du projet (SHAREPOINT_FC_SUBPATH pour changer). */
async function uploadFinChantier(p, bytes, filename, contentType) {
  const token = await getToken();
  const base = await driveBase(token);
  const sub = process.env.SHAREPOINT_FC_SUBPATH || 'Fin de chantier';
  const path = await fullPath(token, base, p.project_number, p.project_name, sub, filename);
  return putBytes(path, bytes, contentType || 'application/octet-stream');
}

async function putBytes(path, bytes, contentType) {
  const token = await getToken();
  const buf = Buffer.from(bytes);
  const base = await driveBase(token);
  if (buf.length < 3.5 * 1024 * 1024) {
    const r = await fetch(base + '/root:/' + path + ':/content?@microsoft.graph.conflictBehavior=replace', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType || 'application/pdf' }, body: buf
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('SharePoint (' + r.status + ') : ' + ((j.error && j.error.message) || 'échec du dépôt'));
    return { webUrl: j.webUrl, path: decodeURIComponent(path) };
  }
  // Gros fichier : session de téléversement par blocs de 3 276 800 octets (multiple de 320 Kio)
  const s = await fetch(base + '/root:/' + path + ':/createUploadSession', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
  });
  const sj = await s.json().catch(() => ({}));
  if (!s.ok || !sj.uploadUrl) throw new Error('SharePoint (' + s.status + ') : ' + ((sj.error && sj.error.message) || 'session de téléversement refusée'));
  const CH = 3276800;
  let last = null;
  for (let start = 0; start < buf.length; start += CH) {
    const end = Math.min(start + CH, buf.length);
    const r = await fetch(sj.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(end - start), 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + buf.length },
      body: buf.subarray(start, end)
    });
    if (!r.ok && r.status !== 202) throw new Error('SharePoint (' + r.status + ') : échec du téléversement');
    last = await r.json().catch(() => ({}));
  }
  return { webUrl: last && last.webUrl, path: decodeURIComponent(path) };
}

module.exports = { isConfigured, uploadPdf, uploadInvoice, uploadDirective, uploadDa, uploadQrt, uploadFinChantier, getToken };
