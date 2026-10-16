// api/_lib/projstatus.js — un projet Monday est « en cours » tant que son statut n'indique pas qu'il est terminé / fermé / annulé.
const DONE = /termin|ferm|annul|libération|liberation|complét|complet|archiv|perdu/i;
const inProgress = p => !!(p && p.status) && !DONE.test(p.status);
module.exports = { inProgress, DONE };
