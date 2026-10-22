// Sprill — shared lead lists (cross-account sharing).
//
// A list is a Firestore document whose random 20-char id doubles as the share
// code. You send someone the code out of band; they enter it, which appends
// their uid to memberUids, and from then on both sides can push and pull leads
// from lists/{listId}/prospects.
//
// See firestore.rules for the access model and its accepted limitations
// (anyone with the code can join; removing a member means rotating the list).

import { hasFirebase } from "./config.js";
import {
  firebaseIdToken, getDoc, patchDoc, commitWrites, listDocs, runQuery, randomId,
} from "./firebase.js";
import { getProspects, saveProspects } from "./store.js";

// The subset of a prospect worth sharing. Deliberately excludes the local
// outreach log, follow-up schedule and per-user status — those are the sharer's
// private workflow, not the lead itself.
const SHARED_FIELDS = [
  "userId", "username", "displayName", "profileUrl", "accountType", "category",
  "bio", "followers", "following", "posts", "verified", "score", "band",
  "linkInBio", "links", "emails", "phones", "businessSignals",
  "sourceType", "sourceUrl", "sourceAccount", "capturedAt",
  // Outliers are a property of the lead, not the sharer's workflow.
  "outlierCount", "outlierTopRatio", "outlierTopUrl", "outlierCheckedAt",
];

const docIdFor = (key) => key.replace(/\//g, "_");
const storeKey = (p) => (p.userId ? `id:${p.userId}` : `h:${(p.username || "").toLowerCase()}`);

function shareable(p) {
  const out = {};
  for (const f of SHARED_FIELDS) {
    if (p[f] !== undefined && p[f] !== null && p[f] !== "") out[f] = p[f];
  }
  return out;
}

function assertConfigured() {
  if (!hasFirebase()) throw new Error("firebase_not_configured");
}

// ---- local record of which lists we're in (for fast UI render) ----
async function cacheLists(lists) {
  await chrome.storage.local.set({ sharedLists: lists, sharedListsAt: Date.now() });
}
export async function cachedLists() {
  const { sharedLists } = await chrome.storage.local.get({ sharedLists: [] });
  return sharedLists;
}

// ---- CRUD ----
export async function createList(name) {
  assertConfigured();
  const { idToken, uid } = await firebaseIdToken();
  const listId = randomId(20);
  await patchDoc(`lists/${listId}`, {
    name: String(name || "Shared leads").slice(0, 80),
    ownerUid: uid,
    memberUids: [uid],
    createdAt: new Date().toISOString(),
  }, idToken);
  await refreshLists();
  return { id: listId, name, ownerUid: uid, memberUids: [uid] };
}

export async function joinList(code) {
  assertConfigured();
  const listId = String(code || "").trim();
  if (!/^[A-Za-z0-9]{20}$/.test(listId)) throw new Error("bad_code");

  const { idToken, uid } = await firebaseIdToken();
  const doc = await getDoc(`lists/${listId}`, idToken);
  if (!doc) throw new Error("list_not_found");

  const members = doc.memberUids || [];
  if (!members.includes(uid)) {
    // The rules accept exactly this shape: memberUids only, old array plus me.
    await patchDoc(`lists/${listId}`, { memberUids: [...members, uid] }, idToken);
  }
  await refreshLists();
  return { id: listId, name: doc.name, ownerUid: doc.ownerUid };
}

export async function leaveList(listId) {
  assertConfigured();
  const { idToken, uid } = await firebaseIdToken();
  const doc = await getDoc(`lists/${listId}`, idToken);
  if (!doc) return;
  // Drop ourselves server-side (the rules allow self-removal), otherwise the
  // list would simply reappear on the next refresh.
  const members = doc.memberUids || [];
  if (members.includes(uid)) {
    await patchDoc(`lists/${listId}`, {
      memberUids: members.filter((m) => m !== uid),
    }, idToken);
  }
  const rest = (await cachedLists()).filter((l) => l.id !== listId);
  await cacheLists(rest);
}

// Lists I'm a member of. The rules only allow this query when it's constrained
// to my own uid, which is why the filter is not optional.
export async function refreshLists() {
  assertConfigured();
  const { idToken, uid } = await firebaseIdToken();
  const lists = await runQuery({
    from: [{ collectionId: "lists" }],
    where: {
      fieldFilter: {
        field: { fieldPath: "memberUids" },
        op: "ARRAY_CONTAINS",
        value: { stringValue: uid },
      },
    },
  }, idToken);
  await cacheLists(lists);
  return lists;
}

// ---- sync ----
// Push local prospects into a shared list. Batched via :commit — one request
// per 400 leads instead of one per lead.
export async function pushToList(listId, prospects) {
  assertConfigured();
  const { idToken, uid } = await firebaseIdToken();
  const now = new Date().toISOString();
  const writes = prospects
    .filter((p) => p && p.username)
    .map((p) => ({
      path: `lists/${listId}/prospects/${docIdFor(storeKey(p))}`,
      obj: { ...shareable(p), sharedBy: uid, sharedAt: now },
    }));
  if (!writes.length) return 0;
  return commitWrites(writes, idToken);
}

export async function pushAllToList(listId) {
  const all = Object.values(await getProspects());
  return pushToList(listId, all);
}

// Pull a shared list into the local queue. Merges via saveProspects, so pulling
// never overwrites your own enrichment, status or outreach history.
export async function pullFromList(listId) {
  assertConfigured();
  const { idToken } = await firebaseIdToken();
  const docs = await listDocs(`lists/${listId}/prospects`, idToken);

  // EVERY field here came from another user's browser. The old version stripped
  // only id/sharedBy/sharedAt and merged the rest into the local store, so a list
  // member could rewrite an existing local lead's `profileUrl` — which the panel
  // passes straight to chrome.tabs.update() when you click Open. Firestore rules
  // now allowlist fields on write, but rules protect that collection, not this
  // store: a document written before the rules were tightened is still in there.
  //
  // Two defences. Allowlist on the way in, and DERIVE profileUrl from the handle
  // rather than accepting it — a URL is the one field here that is also an action.
  const records = docs
    .map((doc) => {
      const out = {};
      for (const f of SHARED_FIELDS) {
        if (f === "profileUrl") continue; // derived below, never trusted
        if (doc[f] !== undefined && doc[f] !== null) out[f] = doc[f];
      }
      const handle = String(out.username || "").trim().replace(/^@/, "");
      // Instagram handles are [A-Za-z0-9._] only. Anything else is not a handle,
      // and a non-handle here is an attempt at something.
      if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
      out.username = handle;
      out.profileUrl = `https://www.instagram.com/${handle}/`;
      // outlierTopUrl is the other field the panel navigates to. Keep it only if
      // it is an instagram.com permalink.
      if (out.outlierTopUrl && !/^https:\/\/www\.instagram\.com\/[A-Za-z0-9._/-]*$/.test(out.outlierTopUrl)) {
        delete out.outlierTopUrl;
      }
      return out;
    })
    .filter(Boolean);

  if (!records.length) return { added: 0, merged: 0 };

  return saveProspects(records, {
    status: "New",
    sourceType: "shared",
    capturedAt: new Date().toISOString(),
  });
}
