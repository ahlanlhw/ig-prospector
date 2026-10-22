// sheets.js — the living-spreadsheet upsert.
//
// The case this suite exists for is #2: exporting from a second Instagram
// account must APPEND, never clear. 0.9.x cleared the sheet on every export, so
// a second account silently destroyed the first one's rows. That is TESTING.md
// §24, and `calls.clear === 0` is the assertion that guards it.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

installChromeStub({
  seed: { google: { token: "tok", expiresAt: Date.now() + 3600e3 }, sheetId: "SHEET1" },
  identity: true,
});

// The fake spreadsheet: a 2D array of strings.
let GRID = [];
const calls = { batchUpdate: 0, append: 0, headerWrite: 0, clear: 0, firebase: 0 };

const colNum = (letters) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
function parseRange(range) {
  const m = range.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/);
  if (m) return { c1: colNum(m[1]), r1: m[2] ? +m[2] : null, c2: colNum(m[3]), r2: m[4] ? +m[4] : null };
  const s = range.match(/^([A-Z]+)(\d+)$/);
  if (s) return { c1: colNum(s[1]), r1: +s[2], c2: colNum(s[1]), r2: +s[2] };
  return null;
}
function readRange(range) {
  const p = parseRange(range);
  const r1 = p.r1 || 1;
  const r2 = p.r2 || GRID.length;
  const out = [];
  for (let r = r1; r <= r2; r++) {
    const row = GRID[r - 1];
    if (!row) { out.push([]); continue; }
    out.push(row.slice(p.c1 - 1, p.c2));
  }
  while (out.length && out[out.length - 1].every((v) => !v)) out.pop();
  return out;
}
function writeRange(range, values) {
  const p = parseRange(range);
  values.forEach((row, i) => {
    const r = (p.r1 || 1) + i - 1;
    GRID[r] = GRID[r] || [];
    row.forEach((v, j) => { GRID[r][p.c1 - 1 + j] = v; });
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

  // With a filled config.local.js hasFirebase() is TRUE and
  // ensureSheet()'s cloud path is live code — it is only skipped here because
  // the seeded sheetId still exists. Answer with a NON-retryable 401 (a 503
  // would send withRetry into ~3.5s of real backoff and make the suite look
  // hung) and count the call, so an unintended path shows up as a failure
  // instead of as a slow pass.
  if (url.includes("identitytoolkit") || url.includes("firestore.googleapis.com")) {
    calls.firebase++;
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
  }

  if (/spreadsheets\/[^/?]+\?fields=spreadsheetId/.test(url)) return ok({ spreadsheetId: "SHEET1" });
  if (url.endsWith("/v4/spreadsheets") && opts.method === "POST") return ok({ spreadsheetId: "NEW" });
  if (url.includes("values:batchUpdate")) {
    calls.batchUpdate++;
    for (const d of JSON.parse(opts.body).data) writeRange(d.range, d.values);
    return ok({});
  }
  if (url.includes(":append")) {
    calls.append++;
    for (const row of JSON.parse(opts.body).values) GRID.push(row.slice());
    return ok({});
  }
  if (url.includes(":clear")) { calls.clear++; GRID = []; return ok({}); }
  const m = url.match(/\/values\/([^?]+)/);
  if (m) {
    const range = decodeURIComponent(m[1]);
    if (opts.method === "PUT") { calls.headerWrite++; writeRange(range, JSON.parse(opts.body).values); return ok({}); }
    return ok({ values: readRange(range) });
  }
  throw new Error("unmocked " + url);
};

const { exportToSheet, colA1 } = await import("../../extension/src/shared/sheets.js");

// colA1 must survive past column Z — ALL_FIELDS is 31 entries plus _key.
eq("colA1 A", colA1(1), "A");
eq("colA1 Z", colA1(26), "Z");
eq("colA1 AA", colA1(27), "AA");
eq("colA1 AF", colA1(32), "AF");
eq("colA1 BA", colA1(53), "BA");

const FIELDS = ["username", "score", "sourceAccount"];

// --- 1. fresh sheet: header + all rows appended ---
GRID = [];
const r1 = await exportToSheet(
  [{ userId: "1", username: "alice", score: 90, sourceAccount: "acctA" },
   { username: "bob", score: 50, sourceAccount: "acctA" }],
  FIELDS,
);
eq("fresh appended", [r1.appended, r1.updated], [2, 0]);
eq("header written", GRID[0], ["_key", "username", "score", "sourceAccount"]);
eq("row alice", GRID[1], ["id:1", "alice", "90", "acctA"]);
eq("row bob", GRID[2], ["h:bob", "bob", "50", "acctA"]);

// --- 2. THE KEY CASE: exporting from a second IG account must not wipe the first ---
const r2 = await exportToSheet(
  [{ username: "carol", score: 70, sourceAccount: "acctB" }],
  FIELDS,
);
eq("second account appended only", [r2.appended, r2.updated], [1, 0]);
eq("clear never called", calls.clear, 0);
eq("acctA rows survive", GRID.length, 4);
eq("alice still there", GRID[1], ["id:1", "alice", "90", "acctA"]);
eq("carol added with her own source", GRID[3], ["h:carol", "carol", "70", "acctB"]);

// --- 3. re-export updates in place, does not duplicate ---
const r3 = await exportToSheet(
  [{ userId: "1", username: "alice", score: 95, sourceAccount: "acctA" }],
  FIELDS,
);
eq("re-export updates", [r3.appended, r3.updated], [0, 1]);
eq("no new row", GRID.length, 4);
eq("score updated in place", GRID[1], ["id:1", "alice", "95", "acctA"]);

// --- 4. legacy sheet with no _key column: match on username, backfill _key ---
GRID = [["username", "score"], ["dave", "10"], ["erin", "20"]];
const r4 = await exportToSheet(
  [{ username: "dave", score: 11, sourceAccount: "acctA" },
   { username: "frank", score: 30, sourceAccount: "acctA" }],
  FIELDS,
);
eq("legacy: dave matched, frank appended", [r4.appended, r4.updated], [1, 1]);
eq("legacy header extended", GRID[0], ["username", "score", "_key", "sourceAccount"]);
eq("legacy dave updated + _key backfilled", GRID[1], ["dave", "11", "h:dave", "acctA"]);
eq("legacy erin untouched", GRID[2], ["erin", "20"]);
eq("legacy frank appended", GRID[3], ["frank", "30", "h:frank", "acctA"]);

// --- 5. @-prefixed handles in the sheet still match ---
GRID = [["_key", "username"], ["", "@gina"]];
const r5 = await exportToSheet([{ username: "gina" }], ["username"]);
eq("@handle matched not duplicated", [r5.appended, r5.updated], [0, 1]);

// --- 6. a 429 is retried rather than aborting the export ---
GRID = [];
let hit429 = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (url.includes(":append") && !hit429) {
    hit429 = true;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  }
  return realFetch(url, opts);
};
const r6 = await exportToSheet([{ username: "hal" }], ["username"]);
eq("429 retried, export completed", r6.appended, 1);
eq("429 actually fired", hit429, true);
globalThis.fetch = realFetch;

// Nothing above should have touched Firestore. If this trips, ensureSheet()'s
// cloud path went live and the mock's answers are no longer representative.
eq("no unintended Firebase calls", calls.firebase, 0);

report();
