'use strict';
/**
 * Lectures Monday « en direct ». Les boards déjà synchronisés dans Exacto-Finance sont DÉCONNECTÉS
 * (bons de commande, demandes de changement, DA, QRT) : leurs données vivent maintenant dans Neon.
 * Le board Factures reste connecté jusqu'à la synchronisation finale.
 * Pour rebrancher temporairement un board : variable d'environnement MONDAY_LIVE_PO=1 / MONDAY_LIVE_DDC=1.
 */
module.exports = {
  po: process.env.MONDAY_LIVE_PO === '1',
  ddc: process.env.MONDAY_LIVE_DDC === '1',
  invoices: process.env.MONDAY_LIVE_INVOICES !== '0',
  // Facture importée de Monday encore en attente d'approbation DANS Monday : Monday reste la source,
  // la copie Neon est masquée des files d'approbation/listes tant que la facture n'est pas finalisée.
  LEGACY_PENDING: "(legacy IS TRUE AND status IN ('a_approuver','a_valider','a_determiner'))",
  NOT_LEGACY_PENDING: "NOT (legacy IS TRUE AND status IN ('a_approuver','a_valider','a_determiner'))"
};
