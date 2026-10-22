// Sprill: integration config.
//
// The committed values are BLANK, so a fresh clone runs 100% local: no account,
// no server, no keys. To turn on Google sign-in, Sheets export and cloud backup,
// copy config.local.example.js to config.local.js (gitignored) and fill it in.
// It is merged over CONFIG below. See README.md, "Optional cloud features".
//
// These are public identifiers, NOT secrets: an OAuth client id (no client
// secret in the launchWebAuthFlow flow) and a Firebase web apiKey (access is
// controlled by firestore.rules and API-key restrictions). They stay out of the
// public repo so that forks point at their own project, not ours.
//
// NEVER put a real secret in either file. No service-account JSON, no private
// key, no OAuth client secret: anything here ships inside the extension and can
// be unpacked. assertClientSafe() below is a tripwire for that.
//
// The merge uses top-level await and dynamic import(). Both work in extension
// pages (the side panel), which is the only place this module is loaded. They
// are NOT allowed in a service worker, so service-worker.js must never import
// this file, directly or through another module.

export const CONFIG = {
  // OAuth 2.0 *Web application* client ID.
  // Redirect URI to register: https://<extension id>.chromiumapp.org/
  // (the id is pinned by manifest.json "key").
  GOOGLE_OAUTH_CLIENT_ID: "",

  // Firebase web config. Only apiKey + projectId are needed for the REST calls
  // we use.
  FIREBASE: {
    apiKey: "",
    projectId: "",
  },
};

// Optional local override. A missing file is the normal case on a fresh clone.
const local = (await import("./config.local.js").catch(() => null))?.LOCAL_CONFIG;
if (local) {
  const { FIREBASE, ...rest } = local;
  Object.assign(CONFIG, rest);
  if (FIREBASE) Object.assign(CONFIG.FIREBASE, FIREBASE);
}

export const hasGoogle = () => !!CONFIG.GOOGLE_OAUTH_CLIENT_ID;
export const hasFirebase = () => !!(CONFIG.FIREBASE.apiKey && CONFIG.FIREBASE.projectId);

// --- Secret tripwire ---------------------------------------------------------
// Refuse to run (and warn loudly) if something that looks like a real secret was
// pasted into the frontend config. Public identifiers (client id, web apiKey)
// pass; private-key PEM blocks and secret-looking field names do not. This is a
// guardrail against accidentally leaking a credential into the shipped bundle —
// it is NOT a substitute for keeping true secrets on a backend.
function flatten(o, out = {}, prefix = "") {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, out, key);
    else out[key] = v;
  }
  return out;
}

export function assertClientSafe(cfg = CONFIG) {
  const flat = flatten(cfg);
  const blob = JSON.stringify(flat);

  // Hard fail: an actual private key must never ship in a client.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(blob)) {
    throw new Error(
      "config.js contains a PRIVATE KEY. Secrets must never ship in the " +
      "extension bundle — move it to a Cloud Function backend.",
    );
  }

  // Soft warn: field names that usually indicate a real secret.
  const banned = ["private_key", "privatekey", "client_secret", "clientsecret",
                  "service_account", "serviceaccount", "gemini", "stripe_secret"];
  const keyNames = Object.keys(flat).join("|").toLowerCase();
  for (const b of banned) {
    if (keyNames.includes(b)) {
      console.error(
        `[Sprill] config.js has a suspicious field matching "${b}". Real secrets ` +
        "must not ship in the frontend. Use a backend.",
      );
    }
  }
}

// Run the tripwire once at load so a leaked secret is caught immediately.
try {
  assertClientSafe();
} catch (e) {
  console.error("[Sprill]", e.message);
  throw e;
}
