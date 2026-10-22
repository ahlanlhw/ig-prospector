// Sprill — Firestore REST helpers (zero-build, no SDK).
//
// Model: exchange the Google OAuth token for a Firebase ID token
// (Identity Platform signInWithIdp), then call Firestore with that ID token so
// security rules can scope data to request.auth.uid.
//
// Shared by sync.js (personal backup), lists.js (shared lists) and sheets.js
// (looking up the consolidated sheet id across Chrome profiles).

import { CONFIG, hasFirebase } from "./config.js";
import { getToken } from "./auth.js";
import { withRetry } from "./http.js";

export const DOC_BASE =
  `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE.projectId}/databases/(default)/documents`;

let cached = null; // { idToken, uid, exp }

export async function firebaseIdToken(force = false) {
  if (!hasFirebase()) throw new Error("firebase_not_configured");
  if (!force && cached && Date.now() < cached.exp) return cached;

  const googleToken = await getToken();
  const redirect = chrome.identity.getRedirectURL();
  const r = await withRetry(() => fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${CONFIG.FIREBASE.apiKey}`,
    {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${googleToken}&providerId=google.com`,
        requestUri: redirect, returnIdpCredential: true, returnSecureToken: true,
      }),
    },
  ), { label: "firebase signin" });

  if (!r.ok) throw new Error("firebase_signin_" + r.status);
  const j = await r.json();
  // ID tokens last an hour; refresh a little early.
  cached = { idToken: j.idToken, uid: j.localId, exp: Date.now() + 50 * 60 * 1000 };
  return cached;
}

export function clearFirebaseToken() { cached = null; }

// ---- value codecs ----
export function fsVal(v) {
  if (v == null) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsVal) } };
  if (typeof v === "object") return { mapValue: { fields: fsFields(v) } };
  return { stringValue: String(v) };
}
export function fsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fsVal(v);
  return out;
}
// Inverse of fsVal — needed now that we read documents back, not just write.
export function fromFsVal(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("stringValue" in v) return v.stringValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFsVal);
  if ("mapValue" in v) return fromFsFields(v.mapValue.fields || {});
  return null;
}
export function fromFsFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromFsVal(v);
  return out;
}

// ---- requests ----
async function authed(url, opts, idToken, label) {
  return withRetry(() => fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}), Authorization: `Bearer ${idToken}` },
  }), { label });
}

// Read one document. Returns null on 404 (missing is not an error here).
export async function getDoc(path, idToken) {
  const r = await authed(`${DOC_BASE}/${path}`, { method: "GET" }, idToken, `get ${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("firestore_get_" + r.status);
  const j = await r.json();
  return fromFsFields(j.fields || {});
}

// Partial update.
//
// The updateMask is NOT optional. A Firestore REST PATCH without one replaces
// the whole document, so writing a single field would silently delete the rest
// — joining a list would wipe its name and ownerUid, and recording a sheetId
// would wipe the user's backed-up ICP. It also matters for the rules: the
// self-join rule requires that memberUids is the ONLY affected key, which is
// false if every other field is being dropped.
export async function patchDoc(path, obj, idToken) {
  const mask = Object.keys(obj)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const r = await authed(`${DOC_BASE}/${path}?${mask}`, {
    method: "PATCH", body: JSON.stringify({ fields: fsFields(obj) }),
  }, idToken, `patch ${path}`);
  if (!r.ok) throw new Error("firestore_write_" + r.status);
  return true;
}

// Batched writes via the :commit endpoint.
//
// This replaces per-document PATCH loops. It matters more than it looks: the
// shared-list rules call get() on the parent list document to check membership,
// which costs an extra read per operation, so a few hundred one-at-a-time
// writes is both slow and needlessly expensive.
const COMMIT_MAX = 400; // Firestore caps a commit at 500 writes; leave headroom.

export async function commitWrites(writes, idToken) {
  let done = 0;
  for (let i = 0; i < writes.length; i += COMMIT_MAX) {
    const chunk = writes.slice(i, i + COMMIT_MAX).map(({ path, obj }) => ({
      update: { name: `${DOC_BASE}/${path}`, fields: fsFields(obj) },
      // Without an updateMask Firestore replaces the whole document; that's
      // what we want (the client is the source of truth for these records).
    }));
    const r = await authed(
      `https://firestore.googleapis.com/v1/projects/${CONFIG.FIREBASE.projectId}/databases/(default)/documents:commit`,
      { method: "POST", body: JSON.stringify({ writes: chunk }) },
      idToken, "commit",
    );
    if (!r.ok) throw new Error("firestore_commit_" + r.status);
    done += chunk.length;
  }
  return done;
}

// List a collection, following pagination.
export async function listDocs(collectionPath, idToken, pageSize = 300) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${DOC_BASE}/${collectionPath}?pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await authed(url, { method: "GET" }, idToken, `list ${collectionPath}`);
    if (r.status === 404) return out;
    if (!r.ok) throw new Error("firestore_list_" + r.status);
    const j = await r.json();
    for (const d of j.documents || []) {
      out.push({ id: (d.name || "").split("/").pop(), ...fromFsFields(d.fields || {}) });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Structured query. Used to find the lists I'm a member of; the rules only
// accept this when it's constrained to memberUids array-contains my uid.
export async function runQuery(structuredQuery, idToken) {
  const r = await authed(
    `${DOC_BASE}:runQuery`,
    { method: "POST", body: JSON.stringify({ structuredQuery }) },
    idToken, "runQuery",
  );
  if (!r.ok) throw new Error("firestore_query_" + r.status);
  const j = await r.json();
  return (j || [])
    .filter((row) => row && row.document)
    .map((row) => ({
      id: (row.document.name || "").split("/").pop(),
      ...fromFsFields(row.document.fields || {}),
    }));
}

// Firestore auto-ids are 20 chars of [A-Za-z0-9]. We mint list ids client-side
// because the id doubles as the share code / capability token.
export function randomId(len = 20) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
