# Banques de temps, feuilles de temps, équipements et /heures

Aucun test en direct n'a été fait (syntaxe vérifiée seulement). Aucune migration SQL : les tables hb_* se créent seules au premier appel.

## Fichiers à remplacer / ajouter sur GitHub
- api/punch.js (remplacer) — nouvelle ressource « hours »
- api/_lib/hours-bank.js (NOUVEAU)
- api/_lib/planif-db.js (remplacer) — actions equipList / equipAssign
- heures.html (NOUVEAU, remplace admin.html) — SUPPRIMER admin.html après le dépôt. /admin redirige vers /heures.
- punch.html (remplacer) — « Mes banques » et « Feuille de temps »
- planif.html (remplacer) — bouton « Équipements »
- index.html (remplacer) — le lien du hub pointe vers /heures
- vercel.json (remplacer) — redirection /admin → /heures (les crons existants sont conservés)

Aucune nouvelle fonction Serverless (limite de 12 respectée). SMTP_USER / SMTP_PASSWORD (déjà utilisés par les absences) servent à l'envoi des feuilles de temps.

## Mode d'emploi
1. Exacto-Planif → menu d'actions → « Équipements » : menu déroulant par camion / appareil de levage pour changer de contremaître.
2. Exacto-Heures → Comptes employés : cocher « Feuille de temps (bureau) » et choisir le responsable qui reçoit la feuille.
3. Exacto-Heures → Banques de temps : « Détail / solde d'ouverture » pour inscrire les soldes d'ouverture (CCQ, hors CCQ, bureau, heures mobiles) et les ajustements.
4. Vue de la semaine : colonnes « Payé CCQ » / « Payé hors CCQ » (par défaut = travaillées). Mouvement = travaillées − payées. Les soldes s'affichent à côté.
5. Exacto-Punch (mobile) : « Mes banques » pour tous; « Feuille de temps » pour les employés cochés (hebdomadaire dimanche → samedi, commentaires, soumission par courriel).
6. Exacto-Heures → Feuilles de temps : consulter les feuilles soumises, « Rouvrir » pour permettre une correction (annule les mouvements de banque).

## Lot Équipements (camions et appareils de levage)
1. Dans Neon, exécuter `migration-equipements.sql` (ajoute les colonnes, supprime les « Inspection par… » / « Heures déclarées… » importés par erreur, charge 28 véhicules et 8 appareils de levage).
2. Remplacer `api/_lib/planif-db.js` et `planif.html`.
3. Dans Planif, bouton « Équipements » : réaffecter, + Ajouter, modifier (✏️), retirer (🗑️). Un équipement vendu se marque « Vendu » (conservé, grisé).
Rien n'a été supprimé dans Monday. Rien n'a été testé en direct.
