// Sprill — Google Sheets export (drive.file scope).
//
// Keeps ONE living "Sprill — Prospects" sheet per Google account and UPSERTS
// into it: rows already present are updated in place, new rows are appended.
//
// Why not clear-and-rewrite (what this used to do): someone running several
// Instagram accounts wants all their leads in one sheet, with a sourceAccount
// column telling them apart. Clearing meant exporting from account B wiped
// account A's rows. Upserting also means a re-export doesn't duplicate.
//
// Rows are matched on a hidden `_key` column holding the store key
// (`id:<userId>` / `h:<handle>`). Sheets written by the old version have no
// `_key` column, so we fall back to matching on `username` and backfill `_key`
// as we go — the next export is then an exact match.
//
// The app can only touch sheets it created (drive.file), not the user's others.

import { getToken, signIn } from "./auth.js";
import { withRetry } from "./http.js";
import { hasFirebase } from "./config.js";
import { firebaseIdToken, getDoc, patchDoc } from "./firebase.js";

const KEY_COL = "_key";

async function api(url, opts = {}) {
  let t = await getToken();
  const call = (tok) => fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` },
  });
  let r = await withRetry(() => call(t), { label: "sheets" });
  if (r.status === 401) {
    t = (await signIn(true)).token;
    r = await withRetry(() => call(t), { label: "sheets retry" });
  }
  return r;
}

// 1-based column number → A1 letter. ALL_FIELDS + _key runs past column Z, so
// naive String.fromCharCode(64+n) would produce garbage like "[".
export function colA1(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const storeKey = (p) => (p.userId ? `id:${p.userId}` : `h:${(p.username || "").toLowerCase()}`);

async function sheetExists(id) {
  const r = await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId`);
  return r.ok;
}

// Remember the sheet id in Firestore as well as locally, so a second Chrome
// profile signed into the SAME Google account finds the existing sheet instead
// of creating a second one. chrome.storage.local does not cross profiles.
async function rememberSheetId(sheetId) {
  await chrome.storage.local.set({ sheetId });
  if (!hasFirebase()) return;
  try {
    const { idToken, uid } = await firebaseIdToken();
    await patchDoc(`users/${uid}`, { sheetId, sheetUpdatedAt: new Date().toISOString() }, idToken);
  } catch (e) {
    console.debug("[Sprill] could not record sheetId in Firestore", e); // local still works
  }
}

async function sheetIdFromCloud() {
  if (!hasFirebase()) return null;
  try {
    const { idToken, uid } = await firebaseIdToken();
    const doc = await getDoc(`users/${uid}`, idToken);
    return (doc && doc.sheetId) || null;
  } catch (e) {
    console.debug("[Sprill] could not read sheetId from Firestore", e);
    return null;
  }
}

export async function ensureSheet() {
  const { sheetId } = await chrome.storage.local.get({ sheetId: null });
  if (sheetId && (await sheetExists(sheetId))) return sheetId;

  const cloudId = await sheetIdFromCloud();
  if (cloudId && (await sheetExists(cloudId))) {
    await chrome.storage.local.set({ sheetId: cloudId });
    return cloudId;
  }

  const r = await api("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title: "Sprill — Prospects" } }),
  });
  if (!r.ok) throw new Error("create_failed_" + r.status);
  const created = (await r.json()).spreadsheetId;
  await rememberSheetId(created);
  return created;
}

function cell(v) {
  if (Array.isArray(v)) v = v.join("; ");
  return v == null ? "" : String(v);
}

async function readRange(sheetId, range) {
  const r = await api(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`);
  if (!r.ok) throw new Error("read_failed_" + r.status);
  return (await r.json()).values || [];
}

// Upsert prospects into the living sheet. Returns the sheet URL.
export async function exportToSheet(prospects, fields) {
  const sheetId = await ensureSheet();

  // --- resolve the header we will actually write against ---
  const existingHeader = (await readRange(sheetId, "A1:ZZ1"))[0] || [];
  let header = existingHeader.slice();
  let headerChanged = false;

  if (!header.length) {
    header = [KEY_COL, ...fields];
    headerChanged = true;
  } else {
    // Keep the user's existing column order; append anything new (including
    // _key on a sheet written by the old clear-and-rewrite version).
    for (const f of [KEY_COL, ...fields]) {
      if (!header.includes(f)) { header.push(f); headerChanged = true; }
    }
  }
  const lastCol = colA1(header.length);
  if (headerChanged) {
    const w = await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:${lastCol}1?valueInputOption=RAW`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: [header] }) },
    );
    if (!w.ok) throw new Error("write_failed_" + w.status);
  }

  const keyIdx = header.indexOf(KEY_COL);
  const userIdx = header.indexOf("username");

  // --- index existing rows by _key, and by handle for pre-_key sheets ---
  const rowByKey = new Map();
  const cols = [];
  if (keyIdx >= 0) cols.push({ idx: keyIdx, kind: "key" });
  if (userIdx >= 0) cols.push({ idx: userIdx, kind: "user" });

  for (const c of cols) {
    const letter = colA1(c.idx + 1);
    const values = await readRange(sheetId, `${letter}2:${letter}`);
    values.forEach((row, i) => {
      const raw = (row && row[0] ? String(row[0]) : "").trim();
      if (!raw) return;
      const k = c.kind === "key" ? raw : `h:${raw.replace(/^@/, "").toLowerCase()}`;
      if (!rowByKey.has(k)) rowByKey.set(k, i + 2); // +2: 1-based, skip header
    });
  }

  // --- partition into in-place updates and appends ---
  const updates = [];
  const appends = [];
  for (const p of prospects) {
    const key = storeKey(p);
    const values = header.map((h) => (h === KEY_COL ? key : cell(p[h])));
    const rowNum =
      rowByKey.get(key) ??
      rowByKey.get(`h:${(p.username || "").toLowerCase()}`);
    if (rowNum) updates.push({ range: `A${rowNum}:${lastCol}${rowNum}`, values: [values] });
    else appends.push(values);
  }

  // --- write ---
  const UPDATE_CHUNK = 200;
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const r = await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data: updates.slice(i, i + UPDATE_CHUNK) }),
      },
    );
    if (!r.ok) throw new Error("write_failed_" + r.status);
  }

  if (appends.length) {
    const r = await api(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: appends }) },
    );
    if (!r.ok) throw new Error("write_failed_" + r.status);
  }

  return {
    url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    updated: updates.length,
    appended: appends.length,
  };
}
