// api/sign.js
//
// Point d'entrée PUBLIC (sans compte Clerk) utilisé par le fournisseur pour consulter et signer
// un bon de commande. L'accès repose sur un jeton secret de 48 caractères propre à chaque bon de
// commande (lien reçu par courriel). Aucune autre donnée de la base n'est exposée.
//
//   GET  /api/sign?t=JETON&a=info    -> résumé du bon de commande (+ marque « consulté »)
//   GET  /api/sign?t=JETON&a=pdf     -> PDF à signer (bon de commande + conditions + soumission)
//   GET  /api/sign?t=JETON&a=signed  -> copie signée (une fois signé)
//   POST /api/sign  { t, name, title, accept, signature }  -> signe (une seule fois)

const { q } = require('./_lib/db');
const mail = require('./_lib/mail');
const pdf = require('./_lib/pdf');
const po = require('./_lib/po');

function fail(res, status, message) { res.status(status).json({ error: message }); }

async function byToken(t) {
  if (!/^[0-9a-f]{48}$/.test(String(t || ''))) return null;
  const rows = await q('SELECT * FROM fin_po WHERE token = $1', [t]);
  return rows[0] ? po.rowToPo(rows[0]) : null;
}

function publicView(r) {
  return {
    po_number: r.po_number, project_number: r.project_number, project_name: r.project_name,
    supplier_name: r.supplier_name, supplier_email: r.supplier_email, total: r.total, subtotal: r.subtotal, tps: r.tps, tvq: r.tvq,
    po_date: r.po_date, status: r.status, signed_at: r.signed_at, signer_name: r.signer_name, lines: r.lines
  };
}

async function currentPdf(r) {
  const quote = await po.getFile(r.id, 'quote');
  return pdf.buildPoPdf(Object.assign({}, r), { quoteBytes: quote ? quote.bytes : null });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const r = await byToken(req.query.t);
      if (!r) return fail(res, 404, "Lien invalide ou expiré.");
      if (r.status === 'annule') return fail(res, 410, "Ce bon de commande a été annulé. Communiquez avec l'émetteur.");
      if (r.status === 'brouillon') return fail(res, 404, "Lien invalide ou expiré. Si le bon de commande a été modifié, un nouveau lien vous a été transmis par courriel.");
      const a = req.query.a || 'info';

      if (a === 'info') {
        if (r.status === 'envoye') {
          await q("UPDATE fin_po SET status = 'vu', viewed_at = COALESCE(viewed_at, now()) WHERE id = $1 AND status = 'envoye'", [r.id]);
          await po.logEvent(r.id, 'consulte', null, po.clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
        }
        return res.status(200).json({ po: publicView(r) });
      }
      if (a === 'pdf') {
        const bytes = r.status === 'signe' ? (await po.getFile(r.id, 'signed') || {}).bytes : await currentPdf(r);
        if (!bytes) return fail(res, 404, 'Document introuvable.');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(po.safeFilename(r)) + '"');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(Buffer.from(bytes));
      }
      if (a === 'signed') {
        if (r.status !== 'signe') return fail(res, 404, "Ce bon de commande n'est pas encore signé.");
        const f = await po.getFile(r.id, 'signed');
        if (!f) return fail(res, 404, 'Document introuvable.');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.filename) + '"');
        return res.status(200).send(f.bytes);
      }
      return fail(res, 400, 'Requête invalide.');
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const r = await byToken(b.t);
      if (!r || r.status === 'brouillon') return fail(res, 404, 'Lien invalide ou expiré.');
      if (r.status === 'annule') return fail(res, 410, "Ce bon de commande a été annulé. Communiquez avec l'émetteur.");
      if (r.status === 'signe') return fail(res, 409, 'Ce bon de commande est déjà signé.');

      const name = po.str(b.name, 120), title = po.str(b.title, 120);
      if (name.length < 2) return fail(res, 400, 'Indiquez votre nom complet.');
      if (b.accept !== true) return fail(res, 400, "Vous devez cocher « J'accepte » pour signer.");
      const sigUrl = String(b.signature || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sigUrl) || sigUrl.length > 400000) return fail(res, 400, 'Signature invalide : dessinez ou tapez votre signature.');
      if (sigUrl.length < 600) return fail(res, 400, 'La signature est vide.');

      const ip = po.clientIp(req);
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const signedAt = new Date();
      const hash = r.doc_hash || pdf.sha256Hex(await currentPdf(r));

      // 1) construire le PDF signé AVANT de verrouiller (échec = rien n'est modifié)
      const quote = await po.getFile(r.id, 'quote');
      const bytes = await pdf.buildPoPdf(Object.assign({}, r), {
        quoteBytes: quote ? quote.bytes : null,
        signature: { name, title, signedAt, ip, ua, viewedAt: r.viewed_at, sentAt: r.sent_at, sentTo: r.sent_to || r.supplier_email, pngDataUrl: sigUrl, docHash: hash }
      });

      // 2) verrou atomique : un seul signataire possible
      const claim = await q(`UPDATE fin_po SET status = 'signe', signed_at = $2, signer_name = $3, signer_title = $4, signer_ip = $5,
          signer_ua = $6, signature_png = $7, doc_hash = $8, updated_at = now()
        WHERE id = $1 AND status IN ('envoye','vu') RETURNING id`, [r.id, signedAt.toISOString(), name, title || null, ip, ua, sigUrl, hash]);
      if (!claim.length) return fail(res, 409, 'Ce bon de commande vient d\'être signé.');

      await po.putFile(r.id, 'signed', po.safeFilename(r, '(signé)'), bytes);
      await po.logEvent(r.id, 'signe', name, ip, title || null);

      const signedPo = Object.assign({}, r, { signer_name: name, signer_title: title });
      const attachment = [{ filename: po.safeFilename(r, '(signé)'), content: Buffer.from(bytes), contentType: 'application/pdf' }];

      // 3) courriels de confirmation (un échec n'annule pas la signature)
      const internal = Array.from(new Set([r.issuer_email, ...String(process.env.FINANCE_NOTIFY_EMAILS || '').split(',').map(s => s.trim())].filter(Boolean)));
      try {
        if (internal.length) { const m = mail.signedMail({ po: signedPo, forSupplier: false }); await mail.sendMail({ to: internal.join(', '), subject: m.subject, html: m.html, text: m.text, attachments: attachment }); }
        if (r.supplier_email) { const m2 = mail.signedMail({ po: signedPo, forSupplier: true }); await mail.sendMail({ to: r.supplier_email, replyTo: r.issuer_email || undefined, subject: m2.subject, html: m2.html, text: m2.text, attachments: attachment }); }
      } catch (e) { await po.logEvent(r.id, 'courriel_confirmation_echec', 'systeme', null, e && e.message); }

      // 4) dépôt SharePoint (statut suivi : attente -> reussi | echec | non_configure)
      const spRes = await po.pushToSharePoint(Object.assign({}, r, { id: r.id }));
      return res.status(200).json({ ok: true, sharepoint: spRes.status });
    }

    res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('sign.js', e);
    fail(res, status, (e && e.message) || 'Erreur serveur.');
  }
};
