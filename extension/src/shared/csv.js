// Sprill — CSV serialization + parsing.
//
// Export and import share this module so a file Sprill writes is always a file
// Sprill can read back. The parser is a full state machine (not a split on
// commas) because exported bios and messages routinely contain commas, quotes
// and newlines.

import { ALL_FIELDS } from "./store.js";

// Fields stored as arrays; joined with "; " on export, split back on import.
export const ARRAY_FIELDS = [
  "reasons", "emails", "phones", "links",
  "businessSignals", "mentionedHandles", "publicContactButtons",
];
const NUMERIC_FIELDS = ["followers", "following", "posts", "score", "outreachCount",
  "outlierCount", "outlierTopRatio"];
const BOOLEAN_FIELDS = ["verified", "isPrivate"];

// Headers we accept on import: everything exportable, plus a few internal
// fields that are meaningful to round-trip but aren't offered as CSV columns.
const IMPORTABLE = new Set([...ALL_FIELDS, "isPrivate", "followUpAt", "band", "tags"]);

// Fields serialized as JSON, because they're structured and there is no
// flattening that survives a round trip. `outreach` is the important one: the
// Metrics tab is computed entirely from it, and until it was round-trippable an
// export → Clear all data → import lost every message body, timestamp and
// channel permanently. That is the only backup a user without Firebase has.
export const JSON_FIELDS = ["outreach"];

// ---- serialize ----
export function csvValue(v) {
  if (Array.isArray(v)) v = v.join("; ");
  if (v == null) v = "";
  v = String(v);
  // A lone \r was NOT quoted, and parseCsv treats an unquoted lone \r as a row
  // terminator — so a bio carrying a stray CR exported unquoted and re-imported
  // as two rows with every column shifted, silently.
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Value for one field of one record, ready for csvValue().
export function csvField(rec, field) {
  const v = rec[field];
  if (JSON_FIELDS.includes(field)) return v == null ? "" : JSON.stringify(v);
  return v;
}

// ---- parse ----
// Returns { headers: string[], rows: string[][] }. Handles quoted fields with
// embedded commas/newlines/doubled quotes, a leading BOM, and CRLF / LF / CR.
export function parseCsv(text) {
  if (text == null) return { headers: [], rows: [] };
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endRow = () => { row.push(field); rows.push(row); row = []; field = ""; };

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") {
      if (s[i + 1] === "\n") { i++; continue; } // CRLF — let the \n close the row
      endRow(); i++; continue;                  // lone CR
    }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  endRow(); // final field / row (no trailing newline)

  // Drop trailing blank rows (a trailing newline produces one).
  while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
  if (!rows.length) return { headers: [], rows: [] };

  const headers = rows.shift().map((h) => h.trim());
  return { headers, rows };
}

// ---- value coercion ----
function coerce(field, raw) {
  const v = typeof raw === "string" ? raw.trim() : raw;
  if (v === "" || v == null) return null;
  if (JSON_FIELDS.includes(field)) {
    // Never throw on a hand-edited file: a mangled outreach cell drops that one
    // field and the rest of the row still imports.
    try {
      const parsed = JSON.parse(String(v));
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch (_) { return null; }
  }
  if (ARRAY_FIELDS.includes(field)) {
    const parts = String(v).split(";").map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : null;
  }
  if (NUMERIC_FIELDS.includes(field)) {
    const n = Number(String(v).replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (BOOLEAN_FIELDS.includes(field)) {
    return /^(true|yes|y|1)$/i.test(String(v));
  }
  return String(v);
}

// Non-profile Instagram paths, so a URL like /p/abc123/ is never read as a handle.
const NOT_HANDLES = new Set(["p", "reel", "reels", "explore", "stories", "s", "tv", "accounts", "direct"]);

export function handleFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/instagram\.com\/([^/?#\s]+)/i);
  if (!m) return null;
  const h = m[1].replace(/^@/, "").trim();
  return h && !NOT_HANDLES.has(h.toLowerCase()) ? h : null;
}
export function normalizeHandle(u) {
  if (!u) return null;
  const h = String(u).trim().replace(/^@/, "").replace(/\/+$/, "").trim();
  if (!h) return null;
  return /instagram\.com/i.test(h) ? handleFromUrl(h) : h;
}
export const profileUrlFor = (username) => `https://www.instagram.com/${username}/`;

// ---- headerless handle lists ----
//
// Words that are a COLUMN NAME rather than a person. Without this, a file whose
// header Sprill doesn't recognize donates its header cell as lead #1 — and
// `userid` is the first cell of Sprill's own export header, so that lead would be
// created by the app's own file.
const HEADER_WORDS = new Set([
  "username", "usernames", "handle", "handles", "user", "userid", "user_id", "id",
  "account", "accounts", "profile", "profiles", "profileurl", "profile_url",
  "url", "ig", "instagram", "name", "link", "email",
]);

// Instagram's own handle charset. This is the guard that keeps the headerless
// fallback from mining prose: without it, a CSV carrying nothing but a `bio`
// column imports a lead per sentence fragment.
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

// Below this share of valid candidates the file is not a handle list, whatever
// it is. A hand-made list is ~100% valid; a malformed CSV yields a scattering of
// single-word cells, and importing those dregs would be a quiet wrong answer.
const HANDLE_LIST_MIN_VALID = 0.8;

// Read a parseCsv() result as a PLAIN LIST OF HANDLES — one per line, no header.
//
// Takes parseCsv output rather than raw text on purpose: BOM stripping, CRLF/CR
// and quoted cells are solved there, and a second parser would drift from the
// first. A headerless file's first line lands in `headers`, so that row is a
// candidate too.
//
// Only the FIRST cell of each line is read, so a single-column export from
// another tool works and a wide CSV can't contribute its second column.
export function parseHandleList({ headers, rows }) {
  const lines = [headers || [], ...(rows || [])];
  const records = [];
  const seen = new Set();
  let candidates = 0;   // lines that are EVIDENCE about what this file is
  let valid = 0;        // ...of those, ones that look like a handle
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = String((lines[i] && lines[i][0]) || "").trim();
    if (!raw) continue;                 // blank lines are not evidence either way

    const h = normalizeHandle(raw);
    const low = h ? h.toLowerCase() : "";

    // A column name on line 1 is an ordinary thing to find at the top of a
    // hand-made list, not a sign the file is something else. Counting it as a
    // failure made the ratio below reject short lists: "handle / alice / bob" is
    // 2-of-3 valid, under the floor, and would have been refused outright.
    if (i === 0 && h && HEADER_WORDS.has(low)) { skipped++; continue; }

    candidates++;
    if (!h || !HANDLE_RE.test(h) || NOT_HANDLES.has(low) || HEADER_WORDS.has(low)) {
      skipped++; continue;
    }
    // Counted as valid BEFORE the dedupe check: a repeated handle is still
    // evidence this file is a handle list, so it must not drag the ratio down.
    valid++;
    if (seen.has(low)) { skipped++; continue; }
    seen.add(low);
    records.push({ username: h, profileUrl: profileUrlFor(h) });
  }

  if (!candidates || valid / candidates < HANDLE_LIST_MIN_VALID) {
    return { records: [], skipped: candidates };
  }
  return { records, skipped };
}

// Map a parsed CSV into prospect records ready for saveProspect().
//
// Two rules matter here:
//  • Only headers we recognize are kept; unknown columns are ignored rather
//    than failing the row.
//  • Empty values are DROPPED, never written as "". saveProspect() merges with
//    {...existing, ...incoming}, so keeping blanks would let a sparse CSV wipe
//    enrichment (bio, followers, score) off an already-good record.
export function mapCsvRows({ headers, rows }) {
  const cols = headers.map((h) => {
    const key = String(h || "").trim();
    if (!key) return null;
    const match = [...IMPORTABLE].find((f) => f.toLowerCase() === key.toLowerCase());
    return match || null;
  });
  // Whether ANY column name was recognized. Returned to the caller so the
  // headerless fallback can be gated on it: a real Sprill export with a good
  // header but no usable rows must keep its existing error rather than being
  // re-read as a list of handles.
  const usable = cols.some(Boolean);

  const records = [];
  let skipped = 0;
  for (const row of rows) {
    if (!usable) { skipped++; continue; }
    if (row.every((v) => String(v || "").trim() === "")) continue; // blank line

    const rec = {};
    for (let i = 0; i < cols.length; i++) {
      const field = cols[i];
      if (!field) continue;
      const val = coerce(field, row[i]);
      if (val !== null) rec[field] = val;
    }

    // Resolve the handle from either column.
    const username = normalizeHandle(rec.username) || handleFromUrl(rec.profileUrl);
    if (!username) { skipped++; continue; }
    rec.username = username;
    rec.profileUrl = rec.profileUrl || profileUrlFor(username);

    records.push(rec);
  }
  return { records, skipped, headerRecognized: usable };
}
