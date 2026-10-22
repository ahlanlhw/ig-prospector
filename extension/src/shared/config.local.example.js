// Copy this file to config.local.js (gitignored) to turn on Google sign-in,
// Sheets export and cloud backup. Leave it out and Sprill stays 100% local.
// 1. GOOGLE_OAUTH_CLIENT_ID: Google Cloud console, APIs and Services, Credentials, OAuth client (Web application).
// 2. Redirect URI to register: https://<your extension id>.chromiumapp.org/
// 3. FIREBASE.apiKey and projectId: Firebase console, Project settings, General, Web app config.

export const LOCAL_CONFIG = {
  GOOGLE_OAUTH_CLIENT_ID: "",
  FIREBASE: {
    apiKey: "",
    projectId: "",
  },
};
