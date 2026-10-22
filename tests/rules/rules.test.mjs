// firestore.rules, exercised against the real rules engine in the emulator.
//
// NOT part of `node tests/run.mjs`: it needs the emulator running. See "Run the
// tests" in the root README.md.
//
// The emulator accepts unsigned JWTs (alg:none), so identities can be minted
// here without any Firebase SDK. That is why this suite has zero dependencies.

import { check, report } from "../helpers/assert.mjs";

const HOST = "http://127.0.0.1:8099";
const PROJECT = "demo-sprill";
const BASE = `${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(uid) {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: "none", typ: "JWT" }),
    b64({
      iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
      sub: uid, user_id: uid, auth_time: now, iat: now, exp: now + 3600,
      email: `${uid}@example.com`, email_verified: true,
      firebase: { identities: {}, sign_in_provider: "password" },
    }),
    "",
  ].join(".");
}
const ALICE = token("uidAlice"), BOB = token("uidBob"), MAL = token("uidMallory");

const fsVal = (v) =>
  v == null ? { nullValue: null }
  : typeof v === "boolean" ? { booleanValue: v }
  : typeof v === "number" ? { integerValue: String(v) }
  : Array.isArray(v) ? { arrayValue: { values: v.map(fsVal) } }
  : { stringValue: String(v) };
const fields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fsVal(v)]));

async function req(method, path, tok, body, qs = "") {
  const r = await fetch(`${BASE}/${path}${qs}`, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.status;
}
const mask = (o) => "?" + Object.keys(o).map((k) => `updateMask.fieldPaths=${k}`).join("&");
const patch = (path, tok, obj) => req("PATCH", path, tok, { fields: fields(obj) }, mask(obj));
const get = (path, tok) => req("GET", path, tok);

async function runQuery(tok, structuredQuery) {
  const r = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ structuredQuery }),
  });
  return r.status;
}

// Fail fast and legibly if the emulator isn't up, rather than 27 opaque errors.
try {
  await fetch(BASE, { method: "GET" });
} catch (e) {
  console.error(
    `\nCannot reach the Firestore emulator at ${HOST}.\n` +
    "Start it first, from the repo root:\n" +
    "  npx firebase emulators:start --only firestore --project demo-sprill\n",
  );
  process.exit(2);
}

// A FRESH list id per run. With a fixed id the suite only passed against a
// clean emulator: a second run found the list already there, so "alice creates
// her own list" was an update rather than a create and the join assertions ran
// against a doc bob had already joined. A test that only works once is a test
// you stop trusting. Real list ids are 20-char client-minted tokens, so this
// also matches production shape.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LIST = Array.from({ length: 20 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

console.log("\n-- existing users/{uid} isolation must still hold --");
check("alice writes her own doc", await patch("users/uidAlice", ALICE, { businessName: "Acme" }), 200);
check("bob cannot read alice's doc", await get("users/uidAlice", BOB), 403);
check("bob cannot write alice's doc", await patch("users/uidAlice", BOB, { businessName: "hax" }), 403);
check("anonymous cannot read alice's doc", await get("users/uidAlice", null), 403);

console.log("\n-- creating a list --");
check("alice cannot create a list owned by someone else",
  await patch(`lists/${LIST}`, ALICE, { name: "X", ownerUid: "uidBob", memberUids: ["uidBob"], createdAt: "t" }), 403);
check("alice cannot create pre-seeded with extra members",
  await patch(`lists/${LIST}`, ALICE, { name: "X", ownerUid: "uidAlice", memberUids: ["uidAlice", "uidBob"], createdAt: "t" }), 403);
check("alice creates her own list",
  await patch(`lists/${LIST}`, ALICE, { name: "Team", ownerUid: "uidAlice", memberUids: ["uidAlice"], createdAt: "t" }), 200);

console.log("\n-- the lead data is members-only --");
check("alice (member) writes a lead",
  await patch(`lists/${LIST}/prospects/h_lead1`, ALICE, { username: "lead1" }), 200);
check("bob (not yet a member) cannot read leads", await get(`lists/${LIST}/prospects/h_lead1`, BOB), 403);
check("bob (not yet a member) cannot write leads",
  await patch(`lists/${LIST}/prospects/h_evil`, BOB, { username: "evil" }), 403);
check("anonymous cannot read leads", await get(`lists/${LIST}/prospects/h_lead1`, null), 403);

console.log("\n-- joining by code --");
check("bob may read the list doc to join", await get(`lists/${LIST}`, BOB), 200);
check("bob cannot rename the list", await patch(`lists/${LIST}`, BOB, { name: "hijacked" }), 403);
check("bob cannot add a third party",
  await patch(`lists/${LIST}`, BOB, { memberUids: ["uidAlice", "uidMallory"] }), 403);
check("bob cannot remove the owner",
  await patch(`lists/${LIST}`, BOB, { memberUids: ["uidBob"] }), 403);
check("bob joins by appending only himself",
  await patch(`lists/${LIST}`, BOB, { memberUids: ["uidAlice", "uidBob"] }), 200);
check("bob can now read leads", await get(`lists/${LIST}/prospects/h_lead1`, BOB), 200);
check("bob can now write leads",
  await patch(`lists/${LIST}/prospects/h_lead2`, BOB, { username: "lead2" }), 200);
check("mallory still cannot read leads", await get(`lists/${LIST}/prospects/h_lead1`, MAL), 403);

console.log("\n-- joining must not wipe the list metadata --");
const r = await fetch(`${BASE}/lists/${LIST}`, { headers: { Authorization: `Bearer ${ALICE}` } });
const doc = await r.json();
check("name survived the join", doc.fields?.name?.stringValue, "Team");
check("ownerUid survived the join", doc.fields?.ownerUid?.stringValue, "uidAlice");

console.log("\n-- enumeration must be blocked --");
check("unconstrained list query is denied",
  await runQuery(MAL, { from: [{ collectionId: "lists" }] }), 403);
check("mallory cannot query as if she were a member",
  await runQuery(MAL, { from: [{ collectionId: "lists" }], where: { fieldFilter: {
    field: { fieldPath: "memberUids" }, op: "ARRAY_CONTAINS", value: { stringValue: "uidAlice" } } } }), 403);
check("bob can query his own memberships",
  await runQuery(BOB, { from: [{ collectionId: "lists" }], where: { fieldFilter: {
    field: { fieldPath: "memberUids" }, op: "ARRAY_CONTAINS", value: { stringValue: "uidBob" } } } }), 200);

console.log("\n-- leaving --");
check("bob removes only himself", await patch(`lists/${LIST}`, BOB, { memberUids: ["uidAlice"] }), 200);
check("bob loses lead access after leaving", await get(`lists/${LIST}/prospects/h_lead1`, BOB), 403);

console.log("\n-- default deny elsewhere --");
check("random top-level collection denied", await patch("random/doc", ALICE, { a: 1 }), 403);

report();
