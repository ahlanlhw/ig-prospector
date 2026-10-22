// Sprill — cloud backup to Firestore (zero-build, REST).
//
// Push-only backup of prefs + prospects + outreach under users/{uid}, so
// response-rate / metrics data lives on our side too.
//
// The REST plumbing (token exchange, value codecs, batched :commit) lives in
// firebase.js and is shared with lists.js and sheets.js.

import { hasFirebase } from "./config.js";
import { firebaseIdToken, patchDoc, commitWrites } from "./firebase.js";

export async function syncNow() {
  if (!hasFirebase()) throw new Error("firebase_not_configured");
  const { idToken, uid } = await firebaseIdToken();

  const local = await new Promise((res) => chrome.storage.local.get(null, res));

  await patchDoc(`users/${uid}`, {
    icp: JSON.stringify(local.icp || {}),
    businessName: local.businessName || "",
    updatedAt: new Date().toISOString(),
    // Preserve the consolidated sheet pointer so a second Chrome profile can
    // find the same sheet (see sheets.js ensureSheet).
    ...(local.sheetId ? { sheetId: local.sheetId } : {}),
  }, idToken);

  // One :commit per 400 prospects instead of one PATCH per prospect.
  const prospects = local.prospects || {};
  const writes = Object.entries(prospects).map(([key, p]) => ({
    path: `users/${uid}/prospects/${key.replace(/\//g, "_")}`,
    obj: {
      username: p.username, userId: p.userId || null, accountType: p.accountType || null,
      category: p.category || null, score: p.score ?? null, status: p.status || null,
      sourceAccount: p.sourceAccount || null,
      lastSourceHandle: p.lastSourceHandle || null, capturedAt: p.capturedAt || null,
      lastContactedAt: p.lastContactedAt || null, seenAt: p.seenAt || null,
      repliedAt: p.repliedAt || null,
      outreach: JSON.stringify(p.outreach || []),
    },
  }));

  const count = writes.length ? await commitWrites(writes, idToken) : 0;
  await chrome.storage.local.set({ lastSyncAt: Date.now() });
  return { uid, count };
}
