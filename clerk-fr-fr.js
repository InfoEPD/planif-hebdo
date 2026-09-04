// clerk-fr-fr.js
//
// Traduction française pour l'interface de connexion Clerk (composants "Sign In" et
// "User Button" uniquement — ce projet n'utilise ni inscription libre, ni organisations,
// ni facturation Clerk, donc ces sections ne sont pas traduites ici).
//
// Traduction communautaire adaptée de @clerk/localizations (frFR), fournie par la
// communauté Clerk (non officiellement maintenue par Clerk).
//
// Utilisation : charger ce fichier AVANT d'appeler Clerk.load(), puis passer
// `localization: window.CLERK_LOCALIZATION_FR` dans les options de Clerk.load().
window.CLERK_LOCALIZATION_FR = {
  locale: 'fr-FR',
  backButton: 'Retour',
  dividerText: 'ou',
  socialButtonsBlockButton: 'Continuer avec {{provider|titleize}}',
  formButtonPrimary: 'Continuer',
  formButtonPrimary__verify: 'Vérifier',
  formFieldAction__forgotPassword: 'Mot de passe oublié ?',
  formFieldError__matchingPasswords: 'Les mots de passe correspondent.',
  formFieldError__notMatchingPasswords: 'Les mots de passe ne correspondent pas.',
  formFieldError__verificationLinkExpired: 'Le lien de vérification a expiré. Merci de demander un nouveau lien.',
  formFieldHintText__optional: 'Optionnel',
  formFieldInputPlaceholder__emailAddress: 'Adresse e-mail',
  formFieldInputPlaceholder__emailAddress_username: "Nom d'utilisateur ou adresse e-mail",
  formFieldInputPlaceholder__password: 'Mot de passe',
  formFieldLabel__confirmPassword: 'Confirmer le mot de passe',
  formFieldLabel__currentPassword: 'Mot de passe actuel',
  formFieldLabel__emailAddress: 'Adresse e-mail',
  formFieldLabel__emailAddress_username: "Adresse e-mail ou nom d'utilisateur",
  formFieldLabel__newPassword: 'Nouveau mot de passe',
  formFieldLabel__password: 'Mot de passe',
  signInEnterPasswordTitle: 'Entrez votre mot de passe',
  signIn: {
    alternativeMethods: {
      actionLink: "Obtenir de l'aide",
      actionText: 'Aucune de ces méthodes ne fonctionne ?',
      blockButton__backupCode: 'Utiliser un code de récupération',
      blockButton__emailCode: 'Envoyer le code à {{identifier}}',
      blockButton__emailLink: 'Envoyer le lien à {{identifier}}',
      blockButton__passkey: 'Utiliser une clé de sécurité',
      blockButton__password: 'Connectez-vous avec votre mot de passe',
      blockButton__phoneCode: 'Envoyer le code à {{identifier}}',
      blockButton__totp: "Utilisez votre application d'authentification",
      getHelp: {
        blockButton__emailSupport: 'Assistance par e-mail',
        content:
          "Si vous rencontrez des difficultés pour vous connecter à votre compte, envoyez-nous un e-mail et nous travaillerons avec vous pour rétablir l'accès dès que possible.",
        title: "Obtenir de l'aide",
      },
      subtitle: "Vous rencontrez des problèmes ? Vous pouvez utiliser l'une de ces méthodes pour vous connecter.",
      title: 'Utiliser une autre méthode',
    },
    emailCode: {
      formTitle: 'Le code de vérification',
      resendButton: 'Renvoyer le code',
      subtitle: 'pour continuer vers {{applicationName}}',
      title: 'Vérifiez votre messagerie',
    },
    forgotPassword: {
      formTitle: 'Code de réinitialisation du mot de passe',
      resendButton: "Vous n'avez pas reçu de code ? Renvoyer",
      subtitle: 'pour réinitialiser votre mot de passe',
      subtitle_email: "Tout d'abord, saisissez le code envoyé à votre adresse e-mail.",
      subtitle_phone: "Tout d'abord, saisissez le code envoyé à votre téléphone.",
      title: 'Réinitialiser le mot de passe',
    },
    forgotPasswordAlternativeMethods: {
      blockButton__resetPassword: 'Réinitialiser votre mot de passe',
      label__alternativeMethods: 'Ou connectez-vous avec une autre méthode.',
      title: 'Mot de passe oublié ?',
    },
    newDeviceVerificationNotice:
      'Vous vous connectez depuis un nouvel appareil. Nous demandons une vérification pour sécuriser votre compte.',
    noAvailableMethods: {
      message: "Impossible de poursuivre la connexion. Aucun facteur d'authentification n'est disponible.",
      subtitle: "Une erreur s'est produite",
      title: 'Impossible de se connecter',
    },
    password: {
      actionLink: 'Utiliser une autre méthode',
      subtitle: 'pour continuer vers {{applicationName}}',
      title: 'Entrez votre mot de passe',
    },
    passwordPwned: {
      title: 'Mot de passe compromis',
    },
    resetPassword: {
      formButtonPrimary: 'Réinitialiser',
      requiredMessage: 'Pour des raisons de sécurité, il est nécessaire de réinitialiser votre mot de passe.',
      successMessage:
        'Votre mot de passe a été modifié avec succès. Nous vous reconnectons, veuillez patienter un instant.',
      title: 'Réinitialiser le mot de passe',
    },
    start: {
      actionLink: "S'inscrire",
      actionLink__use_email: 'Utiliser e-mail',
      actionLink__use_email_username: "Utiliser l'e-mail ou le nom d'utilisateur",
      actionLink__use_passkey: 'Utiliser une clé de sécurité',
      actionLink__use_phone: 'Utiliser téléphone',
      actionLink__use_username: "Utiliser le nom d'utilisateur",
      actionText: "Vous n'avez pas encore de compte ?",
      subtitle: 'pour continuer vers {{applicationName}}',
      title: 'Se connecter',
      titleCombined: 'Continuer vers {{applicationName}}',
    },
  },
  unstable__errors: {
    form_code_incorrect: 'Code incorrect',
    form_identifier_not_found: "Nous n'avons pas trouvé de compte avec ces détails.",
    form_param_format_invalid: 'Le format est invalide',
    form_param_format_invalid__email_address: "L'adresse e-mail doit être une adresse e-mail valide.",
    form_param_nil: 'Ce champ est requis.',
    form_param_value_invalid: 'La valeur fournie est invalide.',
    form_password_incorrect: 'Mot de passe incorrect',
    form_password_length_too_short: 'Votre mot de passe est trop court.',
    form_password_not_strong_enough: "Votre mot de passe n'est pas assez fort.",
    form_password_or_identifier_incorrect:
      "Le mot de passe ou l'adresse e-mail est incorrect. Réessayez ou utilisez une autre méthode.",
    form_password_pwned:
      'Ce mot de passe a été compromis et ne peut pas être utilisé. Veuillez essayer un autre mot de passe à la place.',
    form_password_pwned__sign_in: 'Mot de passe compromis. Veuillez le réinitialiser.',
    form_password_validation_failed: 'Mot de passe incorrect',
    session_exists: 'Vous êtes déjà connecté.',
  },
  userButton: {
    action__addAccount: 'Ajouter un compte',
    action__closeUserMenu: 'Fermer le menu utilisateur',
    action__manageAccount: 'Gérer mon compte',
    action__openUserMenu: 'Ouvrir le menu utilisateur',
    action__signOut: 'Déconnexion',
    action__signOutAll: 'Se déconnecter de tous les comptes',
    label__accountActions: 'Actions du compte',
    label__activeSessions: 'Sessions actives',
    label__userButtonPopover: 'Panneau du compte',
  },
};
