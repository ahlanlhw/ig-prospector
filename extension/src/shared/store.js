// Sprill — storage + usage helpers (chrome.storage.local).
// M0 keeps everything local. At M1 the same records sync to a Google Sheet and
// quota/scoring move server-side.

export const LIMITS = { DAILY: 5, MONTHLY: 30 };
// Comments are a separate channel with a separate budget — commenting must not
// spend your DM allowance. Higher than the DM cap because a comment is public,
// consumes no message-request quota, and is a normal human volume; still capped,
// because Instagram's action-block heuristics cover commenting and near-identical
// comment text is the classic spam signature.
//
// These four numbers are POLICY GUESSES, not measured Instagram limits. Tune here.
export const COMMENT_LIMITS = { DAILY: 10, MONTHLY: 60 };
export const COMMENT_PACE_MIN_MS = 45000;    // 45s floor between comments
export const COMMENT_PACE_JITTER_MS = 45000; // + up to 45s

// Soft pacing between one-click / batch sends: next send allowed after MIN +
// random JITTER, so sends don't look robotic. Advisory in M0 (client-side);
// enforced server-side at M1.
export const PACE_MIN_MS = 12000;   // default floor
export const PACE_JITTER_MS = 18000;
export const PACE_FLOOR_MS = 8000;  // hard minimum, for safety

export async function getPaceMinMs() {
  const { paceMinMs } = await get({ paceMinMs: PACE_MIN_MS });
  return Math.max(PACE_FLOOR_MS, paceMinMs);
}
export async function setPaceMinMs(ms) {
  await set({ paceMinMs: Math.max(PACE_FLOOR_MS, Number(ms) || PACE_MIN_MS) });
}

// Fields available for CSV export / column customization.
export const ALL_FIELDS = [
  "userId", "username", "displayName", "profileUrl", "accountType", "category", "bio",
  "followers", "following", "posts", "verified",
  "score", "reasons",
  "businessSignals", "linkInBio", "links", "emails", "phones", "mentionedHandles",
  "publicContactButtons", "sourceType", "sourceUrl",
  "status", "capturedAt", "lastContactedAt", "outreachCount",
  // sourceAccount = the IG account this lead was CAPTURED under (stamped at
  // capture). lastSourceHandle = the account a DM was last SENT from (stamped
  // on send). They usually match, but only sourceAccount is set for leads you
  // haven't contacted yet — it's what separates accounts in a shared Sheet.
  "sourceAccount", "lastSourceHandle",
  "seenAt", "repliedAt",
  // Grid outliers. Appended at the END on purpose: exportCsv writes columns in
  // the STORED order, so appending is safe for anyone with a saved column set.
  "outlierCount", "outlierTopRatio", "outlierTopUrl", "outlierCheckedAt",
  // Newest post we could date, and the input to the cleanup's "stale" half. Same
  // backup argument as shortlistedAt and outreach: without it in the file, an
  // export → Clear all → import leaves the stale check permanently empty until
  // every lead is re-enriched one at a time.
  "lastPostAt",
  // When you vetted them into the Pipeline. `status` alone round-trips MEMBERSHIP
  // but not recency, so an export → Clear all → import used to restore the right
  // people in the wrong order — and "most recently shortlisted" is the order you
  // actually work down. Same reasoning as `outreach` below: if it isn't in the
  // file, the file isn't a backup.
  "shortlistedAt",
  // The outreach log, JSON-encoded (csv.js JSON_FIELDS). NOT in DEFAULT_FIELDS —
  // it's a wide, ugly column most people don't want in a Sheet. It's here so
  // that "export everything" is a real backup: the Metrics tab is computed
  // entirely from this array, and without it export → Clear all data → import
  // silently lost every message body and every timestamp, unrecoverably.
  "outreach",
];

export const DEFAULT_FIELDS = [
  "userId", "username", "displayName", "profileUrl", "category", "followers",
  // `posts` sits next to `followers` because they are read together — the two
  // numbers that say how big an account is and whether it is actually active.
  // It was extracted, stored, rendered and sortable long before it was
  // exportable, so a hitlist enriched for exactly these two counts lost one of
  // them on the way to the CSV.
  "posts",
  "accountType", "score", "reasons", "linkInBio", "emails", "phones",
  "sourceType", "status", "capturedAt", "lastContactedAt",
  "sourceAccount", "lastSourceHandle", "outlierTopRatio",
];

function get(keys) { return new Promise((res) => chrome.storage.local.get(keys, res)); }

// Writes REJECT on failure instead of resolving silently.
//
// chrome.storage.local.set reports errors via chrome.runtime.lastError, not by
// throwing — so the old version swallowed every failure. The one that actually
// bites is QUOTA_BYTES: importing a large CSV and then enriching it can fill
// the quota, and the import would cheerfully report "Imported 4,000" while
// nothing had been written. Callers can now catch and tell the user the truth.
function set(obj) {
  return new Promise((res, rej) => chrome.storage.local.set(obj, () => {
    const err = chrome.runtime.lastError;
    if (err) rej(new Error(err.message || "storage_write_failed"));
    else res();
  }));
}

// Bytes currently used, and how close we are to the cap.
//
// chrome.storage.local allows 10 MB unless the extension declares
// "unlimitedStorage" — which manifest.json:9 does. QUOTA_BYTES still reports the
// 10 MB constant regardless, so dividing by it told CSV-import users they were
// at "84% full" against a ceiling that does not apply to them. With the
// permission granted there is no fixed quota, so report bytes and say so.
export const SOFT_QUOTA_BYTES = 10485760;

export async function storageUsage() {
  const bytes = await new Promise((res) =>
    chrome.storage.local.getBytesInUse(null, (n) => res(n || 0)));
  const unlimited = !!(chrome.runtime.getManifest
    && (chrome.runtime.getManifest().permissions || []).includes("unlimitedStorage"));
  const quota = chrome.storage.local.QUOTA_BYTES || SOFT_QUOTA_BYTES;
  return {
    bytes,
    quota,
    unlimited,
    // Only meaningful when a ceiling actually applies.
    pct: unlimited ? null : Math.round((bytes / quota) * 100),
  };
}

// ---- ICP ----
export async function getICP() {
  const { icp } = await get({ icp: { keywords: [], description: "" } });
  return icp;
}
export async function setICP(icp) { await set({ icp }); }

// Starter ICPs for the first-run wizard. Picking one seeds real keywords so a
// new user gets a meaningful score on their first profile instead of the
// "no ICP keywords set" neutral 35. Everything here is editable afterwards in
// Settings — these are a starting point, not a lock-in.
export const ICP_PRESETS = [
  {
    id: "agency",
    label: "Clients for my agency",
    hint: "Founders and brands who might hire you",
    keywords: ["founder", "ceo", "co-founder", "d2c", "ecommerce", "brand", "startup", "saas"],
    description: "Founder-led brands and businesses that could hire my agency.",
  },
  {
    id: "creators",
    label: "Creators to partner with",
    hint: "Influencers and UGC creators for collabs",
    keywords: ["creator", "influencer", "content creator", "ugc", "collab", "brand deals", "podcast"],
    description: "Creators and influencers open to brand partnerships or collaborations.",
  },
  {
    id: "d2c",
    label: "D2C / ecommerce brands",
    hint: "Online stores selling their own products",
    keywords: ["d2c", "dtc", "ecommerce", "shopify", "online store", "brand", "products", "shop"],
    description: "Direct-to-consumer ecommerce brands running their own online store.",
  },
  {
    id: "local",
    label: "Local businesses",
    hint: "Bricks-and-mortar businesses near you",
    keywords: ["restaurant", "cafe", "salon", "gym", "studio", "clinic", "boutique", "local business"],
    description: "Local bricks-and-mortar businesses in my area.",
  },
];

// ---- First-run onboarding ----
// A single flag gates the wizard. Existing users (who already have an ICP or
// captured prospects) are treated as onboarded so an update never re-runs the
// wizard on someone mid-workflow.
export async function isOnboarded() {
  const { onboarded } = await get({ onboarded: false });
  if (onboarded) return true;
  const icp = await getICP();
  if ((icp.keywords || []).length) return true;
  const { prospects } = await get({ prospects: {} });
  return Object.keys(prospects || {}).length > 0;
}
export async function setOnboarded(v = true) { await set({ onboarded: !!v }); }

// ---- Write serialization ----
//
// Every prospects/drafts mutation below is a read-modify-write of ONE blob with
// an await boundary in the middle. There was no lock, so any two concurrent
// writers raced and the loser's changes vanished — and the writers genuinely
// coexist: rescoreAll() rewrites the whole map on every panel boot, a recording
// session's commitHarvest() fires unawaited from a storage.onChanged callback,
// enrichList() writes once per profile for minutes, and every user click writes.
// The observed failure was a 380-handle recording session being overwritten by a
// stale rescoreAll() while reporting "Saved 380 new handles".
//
// Same six lines as service-worker.js's serialize(), which guards the recording
// keys for the same reason. One chain per storage key, so a drafts write never
// waits behind a 5,000-record prospects write.
const _chains = new Map();
function withLock(key, fn) {
  const prev = _chains.get(key) || Promise.resolve();
  // .then(fn, fn) so a rejected predecessor still lets the next writer run —
  // one failed write must not wedge the queue forever.
  const next = prev.then(fn, fn);
  // Swallow only for the chain copy; the caller still sees the real rejection.
  _chains.set(key, next.catch(() => {}));
  return next;
}

// ---- Prospects ----
// Records are keyed by a STABLE key: the numeric Instagram user id when we have
// it (`id:<userId>`), else the handle (`h:<username>`). Keying on user id means
// a prospect who changes their @handle is still the same record (no duplicate).
function keyFor(rec) {
  return rec.userId ? `id:${rec.userId}` : `h:${(rec.username || "").toLowerCase()}`;
}
// `for...in` rather than Object.entries(): entries() allocates a fresh
// n-element array of 2-element arrays on EVERY call — twice per record when
// there's a userId. Bulk paths (CSV import, enrich, a recorded session) call
// this once per record, so that allocation churn dominates the actual
// comparisons. Same behaviour, no garbage.
function findExistingKey(prospects, p) {
  if (p.userId) {
    const wanted = String(p.userId);
    for (const k in prospects) {
      const r = prospects[k];
      if (r.userId && String(r.userId) === wanted) return k;
    }
  }
  const uname = (p.username || "").toLowerCase();
  if (uname) {
    for (const k in prospects) {
      if ((prospects[k].username || "").toLowerCase() === uname) return k;
    }
  }
  return null;
}

export async function getProspects() {
  const { prospects } = await get({ prospects: {} });
  return prospects;
}
export function saveProspect(p) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    const existingKey = findExistingKey(prospects, p);
    const merged = { ...(existingKey ? prospects[existingKey] : {}), ...p };
    const newKey = keyFor(merged);
    if (existingKey && existingKey !== newKey) delete prospects[existingKey]; // migrate handle-key → id-key
    prospects[newKey] = merged;
    await set({ prospects });
    return merged;
  });
}

// Overwrite the whole map. The ONLY legitimate caller is rescoreAll(), which
// recomputes every score after an ICP change. It goes through the lock like
// everything else — it used to call chrome.storage.local.set directly, which is
// exactly how it clobbered concurrent writes.
export function replaceProspects(mutate) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    const next = await mutate(prospects);
    await set({ prospects: next || prospects });
    return next || prospects;
  });
}
// Bulk upsert. One read + one write for the whole batch, where calling
// saveProspect() in a loop would rewrite the entire prospects map once per
// record — noticeably slow for a few hundred CSV rows.
//
// `defaults` are applied ONLY when creating a new record. That matters: an
// import must not reset an already-contacted prospect back to status "New",
// and must not overwrite the capturedAt of a lead you found weeks ago.
export function saveProspects(list, defaults = {}) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    let added = 0, merged = 0;
    for (const p of list) {
      const existingKey = findExistingKey(prospects, p);
      const rec = existingKey
        ? { ...prospects[existingKey], ...p }
        : { ...defaults, ...p };
      const newKey = keyFor(rec);
      if (existingKey) {
        merged++;
        if (existingKey !== newKey) delete prospects[existingKey]; // migrate handle-key → id-key
      } else {
        added++;
      }
      prospects[newKey] = rec;
    }
    await set({ prospects });
    return { added, merged };
  });
}
export function updateProspect(ref, patch) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    const p = typeof ref === "string" ? { username: ref } : ref;
    const key = findExistingKey(prospects, p);
    if (!key) return null;
    prospects[key] = { ...prospects[key], ...patch };
    await set({ prospects });
    return prospects[key];
  });
}
export function removeProspect(ref) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    const p = typeof ref === "string" ? { username: ref } : ref;
    const key = findExistingKey(prospects, p);
    if (key) { delete prospects[key]; await set({ prospects }); }
  });
}
// Merge enrichment WITHOUT letting empty/degraded values overwrite good data.
//
// The enrich path (panel.js enrichList) spread a fresh scrape over the stored
// record. `extractCurrentProfile` returns a fully-populated object whenever the
// page LOOKS like a profile — which is still true for a login wall, a rate-limit
// interstitial, or a half-hydrated SPA render. In that state bio is whatever the
// longest-span heuristic found, followers/following/posts are null and every
// array is empty, and all of it overwrote the stored truth.
//
// Self-concealing, too: the fabricated bio makes computeScore's hasText check
// truthy, so the record leaves "Needs enrich" and evaluateMore() never retries
// it — and the fake bio then feeds the DM the prospect actually reads.
//
// This is the same rule csv.js:mapCsvRows already applies on the import path:
// empty values are DROPPED, never written.
export function mergeEnrichment(ref, incoming) {
  return withLock("prospects", async () => {
    const prospects = await getProspects();
    const p = typeof ref === "string" ? { username: ref } : ref;
    const key = findExistingKey(prospects, p);
    if (!key) return null;
    const rec = prospects[key];
    for (const [k, v] of Object.entries(incoming)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      rec[k] = v;
    }
    const newKey = keyFor(rec);
    if (key !== newKey) { delete prospects[key]; }
    prospects[newKey] = rec;
    await set({ prospects });
    return rec;
  });
}
// Does a fresh scrape look like a real profile render, or like a login wall?
//
// Two conditions. The handle must match what we asked for — a login wall or a
// redirect gives us someone else's page, or the viewer's. And at least one
// substantive field must be present; a real profile page always yields a
// follower count, a category, or a bio.
export function looksLikeRealProfile(scrape, expectedUsername) {
  if (!scrape) return false;
  const got = (scrape.username || "").toLowerCase();
  const want = (expectedUsername || "").toLowerCase();
  if (!got || (want && got !== want)) return false;
  return scrape.followers != null || !!scrape.category || !!scrape.bio;
}

// ---- how finished is a scrape? ----
//
// extractCurrentProfile() returns a fully-shaped object the moment pageType()
// says "profile", which is true on the very first paint — before Instagram has
// hydrated the header, the bio or the grid. A temp-tab reader that stops at the
// first non-null response therefore reads a skeleton and closes the tab: counts
// arrive in og:description (present in the initial HTML) while the bio and grid
// arrive later, which is why an enriched lead could end up with 138K followers
// and still say "needs enrich".
//
// These two answer "keep waiting, or is this as good as it gets?". Pure, so the
// rule is testable without a browser.

/**
 * How much a scrape actually managed to READ. Not a judgement of the prospect —
 * a monotonic-ish measure of page completeness, used to keep the best read seen
 * and to notice when polling has stopped improving.
 */
export function readQuality(scrape) {
  if (!scrape) return 0;
  let q = 0;
  if (scrape.followers != null) q += 2;
  if (scrape.following != null) q += 1;
  if (scrape.posts != null) q += 1;
  if (scrape.bio) q += 2;
  if (scrape.category) q += 1;
  if (scrape.accountType) q += 1;
  if (scrape.displayName && scrape.displayName !== scrape.username) q += 1;
  if (Array.isArray(scrape.links) && scrape.links.length) q += 1;
  if (Array.isArray(scrape.gridPosts)) q += Math.min(4, scrape.gridPosts.length);
  return q;
}

/**
 * Everything worth waiting for has arrived — stop polling now rather than
 * burning the rest of the budget.
 *
 * `gridFloor` is analyzeGrid's MIN_SAMPLE: below it the outlier analysis refuses
 * to speak, so a grid with fewer tiles than that is still worth waiting on. This
 * is only an EARLY EXIT — an account that genuinely has no bio or three posts
 * never satisfies it, and the caller falls back to "quality stopped improving".
 */
export function readLooksSettled(scrape, gridFloor = 6) {
  if (!scrape) return false;
  if (scrape.followers == null) return false;
  if (!scrape.bio && !scrape.category) return false;
  return Array.isArray(scrape.gridPosts) && scrape.gridPosts.length >= gridFloor;
}

// ---- reels-first enrichment ----
//
// Enrich reads /{handle}/reels/ rather than /{handle}/, because the mixed main
// grid cannot answer the question the feature is named after. analyzeGrid buckets
// video posts on plays and image posts on likes and needs MIN_SAMPLE (6) in a
// bucket before it will say anything. A creator who posts carousels AND reels
// routinely has only 4-5 reels among the first 12 tiles, so the video bucket
// never clears the floor — the reels are never evaluated, while the image bucket
// cheerfully reports "nothing stands out". The reels tab yields 12 reels and a
// full bucket.
//
// The risk in switching is that every extractor was written against /{handle}/:
// og:description is where followers/following/posts come from, and nobody has
// ever checked whether the sub-route serves it. So the switch is guarded rather
// than assumed — these two functions are that guard, and they are pure so the
// rule is pinned by tests instead of by a browser session nobody has run.

/**
 * Is a reels-tab read complete on its own, or do we still owe a second page load?
 *
 * Stricter than looksLikeRealProfile on purpose: that only needs ONE substantive
 * field, and the reels page is very likely to have a header (so a bio and a
 * category) while missing og:description. Accepting it on those grounds would
 * leave `followers` null forever — mergeEnrichment drops nulls, so the count
 * would never be written, every follower bound would read the lead as unknown,
 * and the failure would be completely silent.
 */
export function reelsReadIsComplete(scrape, expectedUsername) {
  if (!looksLikeRealProfile(scrape, expectedUsername)) return false;
  return scrape.followers != null;
}

/**
 * Profile fields from the canonical read, grid from the reels read.
 *
 * Used only when the reels page didn't carry the counts. The reels grid is still
 * the better sample, so it is kept — but only when that read is provably the same
 * account, because attaching someone else's grid would put another person's post
 * behind this prospect's "▶ Watch" button.
 */
export function withReelsGrid(main, reels, expectedUsername) {
  if (!main) return main;
  const want = (expectedUsername || "").toLowerCase();
  const got = reels && (reels.username || "").toLowerCase();
  const usable = !!got && got === want && Array.isArray(reels.gridPosts) && reels.gridPosts.length > 0;
  return usable ? { ...main, gridPosts: reels.gridPosts } : main;
}
export async function hasProspect(ref) {
  const prospects = await getProspects();
  const p = typeof ref === "string" ? { username: ref } : ref;
  return !!findExistingKey(prospects, p);
}
// Append an outreach event to a prospect's history (the outreach log).
export function logOutreach(ref, event) {
  return withLock("prospects", () => _logOutreach(ref, event));
}
async function _logOutreach(ref, event) {
  const prospects = await getProspects();
  const p = typeof ref === "string" ? { username: ref } : ref;
  const key = findExistingKey(prospects, p);
  if (!key) return null;
  const rec = prospects[key];
  rec.outreach = rec.outreach || [];
  rec.outreach.push(event);
  rec.outreachCount = rec.outreach.length;
  rec.lastContactedAt = event.at; // last touch of ANY channel — sync.js reads it,
                                  // so it keeps its meaning. Per-channel stamps
                                  // below.
  if ((event.channel || "dm") === "comment") rec.lastCommentAt = event.at;
  else rec.lastDmAt = event.at;
  // Never demote a prospect that has already progressed. Without this guard a
  // later touch — a follow-up DM, or a comment — walks "Won" back to
  // "Contacted". CLOSED_STATUSES already enumerates exactly the right set.
  if (!CLOSED_STATUSES.includes(rec.status)) rec.status = "Contacted";
  if (event.source && event.source.username) rec.lastSourceHandle = event.source.username;
  // Schedule the next follow-up unless the caller opts out.
  if (!event.noFollowUp) {
    const days = await getFollowUpDays();
    rec.followUpAt = new Date(Date.now() + days * 86400000).toISOString();
  }
  await set({ prospects });
  return rec;
}

// Set an outcome/stage. Closing statuses clear the pending follow-up.
export async function setOutcome(ref, status) {
  const patch = { status };
  if (CLOSED_STATUSES.includes(status)) patch.followUpAt = null;
  if (status === "Replied") patch.repliedAt = new Date().toISOString();
  return updateProspect(ref, patch);
}
// Mark that the recipient has seen the DM (read receipt).
export async function markSeen(ref) {
  return updateProspect(ref, { seenAt: new Date().toISOString() });
}
// Snooze a follow-up by N days from now.
export async function snoozeFollowUp(ref, days) {
  return updateProspect(ref, { followUpAt: new Date(Date.now() + days * 86400000).toISOString(), status: "Contacted" });
}

export async function getFollowUpDays() {
  const { followUpDays } = await get({ followUpDays: 3 });
  return followUpDays;
}
export async function setFollowUpDays(n) {
  await set({ followUpDays: Math.max(1, Math.min(60, Number(n) || 3)) });
}

// The generic outbound webhook was removed in 0.13.0 — see the note in
// panel.html. It was the only consumer of `optional_host_permissions: https://*/*`.
// Any stored `webhook` key on an existing install is simply never read again;
// nothing migrates it, because nothing has shipped yet.

// ---- Usage / send limits / warm-up history ----
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// DMs and comments are different actions that Instagram rate-limits
// differently, so they get separate budgets. Comment counters live in a
// SUB-OBJECT (usage.comment) so the existing top-level DM fields stay
// byte-identical and old records need no migration.
function bucket(u, kind) { return kind === "comment" ? u.comment : u; }
function limitsFor(kind) { return kind === "comment" ? COMMENT_LIMITS : LIMITS; }
async function paceFor(kind) {
  return kind === "comment"
    ? { min: COMMENT_PACE_MIN_MS, jitter: COMMENT_PACE_JITTER_MS }
    : { min: await getPaceMinMs(), jitter: PACE_JITTER_MS };
}

export async function getUsage() {
  const { usage } = await get({ usage: null });
  const day = todayStr(), month = monthStr();
  let u = usage || { day, dayCount: 0, month, monthCount: 0, history: {} };
  u.history = u.history || {};
  let changed = false;
  if (u.day !== day) { u.day = day; u.dayCount = 0; changed = true; }
  if (u.month !== month) { u.month = month; u.monthCount = 0; changed = true; }
  // Comment bucket, created lazily with the same rollover self-heal.
  if (!u.comment) { u.comment = { day, dayCount: 0, month, monthCount: 0, history: {} }; changed = true; }
  u.comment.history = u.comment.history || {};
  if (u.comment.day !== day) { u.comment.day = day; u.comment.dayCount = 0; changed = true; }
  if (u.comment.month !== month) { u.comment.month = month; u.comment.monthCount = 0; changed = true; }
  if (changed) await set({ usage: u });
  return u;
}
// kind defaults to "dm", so every existing caller keeps working unchanged.
export async function canSend(kind = "dm") {
  const u = await getUsage();
  const b = bucket(u, kind), L = limitsFor(kind);
  return {
    ok: b.dayCount < L.DAILY && b.monthCount < L.MONTHLY,
    dayCount: b.dayCount, monthCount: b.monthCount,
    dayLeft: Math.max(0, L.DAILY - b.dayCount),
    monthLeft: Math.max(0, L.MONTHLY - b.monthCount),
  };
}
export async function recordSend(kind = "dm") {
  const u = await getUsage();
  const b = bucket(u, kind);
  const { min, jitter } = await paceFor(kind);
  b.dayCount += 1;
  b.monthCount += 1;
  b.lastSendAt = Date.now();
  b.nextAllowedAt = Date.now() + min + Math.floor(Math.random() * jitter);
  b.history[b.day] = (b.history[b.day] || 0) + 1;
  const keys = Object.keys(b.history).sort();
  while (keys.length > 60) delete b.history[keys.shift()];
  await set({ usage: u });
  return u;
}
export async function paceStatus(kind = "dm") {
  const u = await getUsage();
  const waitMs = Math.max(0, (bucket(u, kind).nextAllowedAt || 0) - Date.now());
  return { ready: waitMs <= 0, waitMs };
}
export async function resetUsage() {
  const day = todayStr(), month = monthStr();
  await set({ usage: {
    day, dayCount: 0, month, monthCount: 0, history: {},
    comment: { day, dayCount: 0, month, monthCount: 0, history: {} },
  } });
}

// Warm-up stats: today's count, consecutive-day streak, and last N days.
export async function warmupStats(days = 14) {
  const u = await getUsage();
  const target = await getDailyTarget();
  const out = [];
  const d = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push({ date: todayStr(dt), count: u.history[todayStr(dt)] || 0 });
  }
  let streak = 0;
  for (let i = 0; ; i++) {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    if ((u.history[todayStr(dt)] || 0) >= 1) streak++;
    else break;
  }
  return { today: u.history[u.day] || 0, target, streak, days: out };
}

export async function getDailyTarget() {
  const { dailyTarget } = await get({ dailyTarget: LIMITS.DAILY });
  return dailyTarget;
}
export async function setDailyTarget(n) {
  await set({ dailyTarget: Math.max(1, Math.min(LIMITS.DAILY, Number(n) || LIMITS.DAILY)) });
}

// ---- Quality filter: public accounts only (skip private) ----
// Account type (business/creator) detection from page JSON is best-effort and
// NOT reliable enough to filter on, so we only drop PRIVATE accounts. Account
// type/category are shown when detected, but never used to exclude a handle.
// Public accounts only. This is a RULE as of 0.13.0, not a setting.
//
// It used to be a toggle (default on) with a "Capture anyway" escape hatch on the
// Current tab, so private accounts could still enter the queue. That is the wrong
// shape for two reasons. Product: a private account cannot be evaluated — no bio,
// no counts, no contact route — so it is not a lead, it is a row that will never
// score. Policy: "does not collect private content" is a claim on the listing and
// in privacy.html, and a switch that lets a user opt into collecting it makes the
// claim conditional. A rule with no exception is the only version that is
// verifiable.
//
// `isPrivate` is only known once a profile has actually been read, so the funnel
// enforces this in three places rather than one: capture refuses, shortlisting
// refuses, and enrich deletes (that is where a scanned handle first reveals
// itself). See PUBLIC_ONLY_NOTE consumers in panel.js.
export function failsPublicFilter(p) {
  return !!p.isPrivate;
}
// Auto-enrich the top N handles right after a scan (0 = off).
export async function getAutoEnrichN() {
  const { autoEnrichN } = await get({ autoEnrichN: 10 });
  return autoEnrichN;
}
export async function setAutoEnrichN(n) { await set({ autoEnrichN: Math.max(0, Number(n) || 0) }); }
// True if a profile fails the public-only filter (i.e. it's private).


// ---- One-click send flag ----
export async function getOneClick() {
  const { oneClickSend } = await get({ oneClickSend: false });
  return !!oneClickSend;
}
export async function setOneClick(v) { await set({ oneClickSend: !!v }); }

// ---- Default DM template ----
// Which template a fresh draft box opens on. Empty string means "the first Auto
// opener", which is what every draft used to do. Stored as an id rather than an
// index so deleting another template can't silently repoint it, and validated on
// read — a default pointing at a template you deleted must fall back rather than
// leave every draft box empty.
export async function getDefaultTpl() {
  const { defaultTplId } = await get({ defaultTplId: "" });
  if (!defaultTplId) return "";
  const list = await getTemplates("dm");
  return list.some((t) => t.id === defaultTplId) ? defaultTplId : "";
}
export async function setDefaultTpl(id) { await set({ defaultTplId: String(id || "") }); }

// ---- Auto-post comment flag ----
// DELIBERATELY separate from oneClickSend. Someone who accepted DM automation
// has not thereby accepted public posting under their own name — two different
// risks, two separate acknowledgements.
export async function getAutoComment() {
  const { autoComment } = await get({ autoComment: false });
  return !!autoComment;
}
export async function setAutoComment(v) { await set({ autoComment: !!v }); }

// ---- Unsent drafts ----
//
// A draft box used to be a detached DOM textarea and nothing else, so anything
// you had typed died on: switching panel tabs, switching browser tabs, the
// Instagram page finishing a load, or closing the panel — all of which call
// refreshCurrent(), which clears the body. For comments that is the common case,
// because you write a comment WHILE looking around the post.
//
// Stored in one object rather than a key per draft: chrome.storage.local writes
// are whole-value, and a few hundred short strings are far cheaper as one blob
// than as N keys the panel would have to enumerate.
//
// Keys are "dm:<username>" and "comment:<shortcode>" — see draftKey().
export const DRAFT_MAX = 200;
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function draftKey(kind, id) {
  // Handles are case-insensitive on Instagram, so lowercasing a DM key is right.
  // Shortcodes are NOT — they're case-sensitive [A-Za-z0-9_-], so /p/DAbc.../ and
  // /p/Dabc.../ are different posts and used to collide on one draft key.
  if (kind === "comment") return `comment:${String(id || "")}`;
  return `dm:${String(id || "").toLowerCase()}`;
}

export async function getDraftText(key) {
  if (!key) return "";
  const { drafts } = await get({ drafts: {} });
  const d = drafts[key];
  if (!d) return "";
  // An abandoned draft is worse than no draft — it reappears months later
  // attached to a prospect whose situation has changed.
  if (Date.now() - (d.at || 0) > DRAFT_TTL_MS) return "";
  return d.text || "";
}

// Locked: draftSelected() mounts up to eight draft boxes at once, each with its
// own 400ms debounce against this one shared blob. Typing in two of them inside
// the same debounce window meant both read the same `drafts` and both wrote —
// and the first person's text was gone.
export function setDraftText(key, text) {
  return withLock("drafts", () => _setDraftText(key, text));
}
async function _setDraftText(key, text) {
  if (!key) return;
  const { drafts } = await get({ drafts: {} });
  const t = String(text || "");
  if (!t.trim()) { delete drafts[key]; await set({ drafts }); return; }

  drafts[key] = { text: t, at: Date.now() };

  // Bound it. Oldest-first eviction, and drop anything past the TTL while we're
  // here, so the blob can't grow without limit across a long-running install.
  const cutoff = Date.now() - DRAFT_TTL_MS;
  for (const [k, v] of Object.entries(drafts)) {
    if ((v.at || 0) < cutoff) delete drafts[k];
  }
  const keys = Object.keys(drafts);
  if (keys.length > DRAFT_MAX) {
    keys.sort((a, b) => (drafts[a].at || 0) - (drafts[b].at || 0));
    for (const k of keys.slice(0, keys.length - DRAFT_MAX)) delete drafts[k];
  }
  await set({ drafts });
}

export function clearDraftText(key) {
  return withLock("drafts", async () => {
    if (!key) return;
    const { drafts } = await get({ drafts: {} });
    if (!(key in drafts)) return;
    delete drafts[key];
    await set({ drafts });
  });
}

// ---- Templates ----
// `kind` splits DM templates from comment templates. Pre-existing records have
// no kind and are treated as "dm" on read, so nothing needs migrating on disk.
export const DEFAULT_TEMPLATES = [
  { id: "t_intro", kind: "dm", name: "Warm intro", body: "Hi {first_name} — came across {topic} and wanted to reach out. I think there may be a good reason for us to connect. Open to a quick chat this week?" },
  { id: "t_partner", kind: "dm", name: "Partnership", body: "Hi {first_name}, really like what you're doing with {topic}. We work with similar {category} accounts and I think there's a partnership worth exploring — would you be open to it?" },
  { id: "t_followup", kind: "dm", name: "Follow-up", body: "Hi {first_name}, just floating this back to the top in case it slipped by. Still happy to share how we could help with {topic} — worth a quick chat?" },
  // Comment starters. These model SPECIFICITY, not a pitch: a generic
  // "great content 🔥" plus a product link is the exact pattern Instagram's
  // comment-spam classifier targets, and it's what gets accounts blocked.
  // No CTA, no link, no {business} merge field — the pitch belongs in the DM.
  { id: "c_specific", kind: "comment", name: "Specific observation", body: "The part about {topic} is the bit that stuck with me — that's the hard one to get right." },
  { id: "c_question", kind: "comment", name: "Genuine question", body: "How long did it take you to land on this format? Genuinely curious." },
];

// ---- The funnel ----
//
// Queue -> Shortlist -> Outreach. Three tabs, one field.
//
// This is `status`, not a separate collection, deliberately: a second store would
// be a second source of truth to keep in sync, and every path that already writes
// a prospect (capture, CSV import, scan, harvest, enrich) would need to learn
// about it. One field means the funnel cannot desynchronise from the record.
//
// QUEUE_STATUSES has three members because three paths already wrote three
// different things for "captured, not yet contacted": "Captured" from the capture
// button and Scan, "New" from CSV import, and "" from the earliest records. All
// three mean the same thing and all three belong in the Queue.
export const STAGE = {
  QUEUE: "Captured",         // scanned or captured — no human has looked yet
  SHORTLIST: "Shortlisted",  // human-QC'd. This is the list we DM from.
  CONTACTED: "Contacted",
};
export const QUEUE_STATUSES = ["Captured", "New", ""];

/** In the Queue: captured but not yet shortlisted, contacted or closed. */
export function isQueued(p) {
  return QUEUE_STATUSES.includes(p.status || "");
}
/** On the Shortlist: vetted, not yet contacted. Leaves once a message is sent. */
export function isShortlisted(p) {
  return p.status === STAGE.SHORTLIST;
}
/** Has been messaged at least once, on any channel. */
export function isContacted(p) {
  return !!(p.outreach && p.outreach.length);
}

// Statuses that CLOSE a prospect (stop follow-ups from surfacing).
export const CLOSED_STATUSES = ["Replied", "Interested", "Meeting", "Won", "Not interested", "No response", "Do not contact"];
export function isOpen(p) {
  return !CLOSED_STATUSES.includes(p.status);
}

// ---- Cleanup: what has gone quiet, and what has gone stale ----
//
// A prospect list decays in two different ways and they need different answers,
// so this reports them separately rather than as one "dead" pile:
//
//   quiet — you messaged them, they never replied, and enough time has passed
//           that they are not going to. Removing them is losing a real record, so
//           this is always REVIEWED, never automatic.
//   stale — the account itself has gone quiet: nothing posted in a long time.
//           These are the ones worth dropping BEFORE you spend a message on them.
//
// Both are deliberately conservative. Anyone who replied, or who you marked with
// any closing outcome you'd want to keep, is never proposed — the point is to
// clear noise, and a tool that proposes deleting your won deals is a tool nobody
// presses twice.
// checkedWithinDays: how recently we must have actually READ an account's grid
// before we're willing to call it dormant. Beyond this the data is too old to
// distinguish "they stopped posting" from "we stopped looking".
export const CULL_DEFAULTS = { quietDays: 30, staleDays: 120, checkedWithinDays: 30 };

export function cullCandidates(all, opts = {}) {
  const { quietDays, staleDays, checkedWithinDays } = { ...CULL_DEFAULTS, ...opts };
  const now = Date.now();
  const days = (iso) => (iso ? (now - new Date(iso).getTime()) / 86400000 : null);

  const quiet = [], stale = [];
  for (const p of all) {
    // Never propose anyone who engaged, or who you deliberately marked.
    if (p.repliedAt) continue;
    if (CLOSED_STATUSES.includes(p.status) && p.status !== "No response") continue;

    const events = p.outreach || [];
    // DMs only, for the same reason splitOutreach is DM-only: a comment has no
    // reply mechanic, so "no reply" is not a fact about a comment. A comment-only
    // prospect is not quiet — they were never asked anything.
    const dmmed = events.some((e) => (e.channel || "dm") === "dm");
    // The most recent touch on ANY channel, not the most recent DM. `lastDmAt` is
    // only stamped for DMs (see logOutreach), so preferring it proposes deleting
    // someone you DMed in March and commented on last week.
    const lastTouch = Math.max(
      p.lastContactedAt ? new Date(p.lastContactedAt).getTime() : 0,
      p.lastDmAt ? new Date(p.lastDmAt).getTime() : 0,
    ) || null;
    const sinceTouch = lastTouch ? (now - lastTouch) / 86400000 : null;

    if (dmmed && sinceTouch != null && sinceTouch >= quietDays) {
      quiet.push({ ...p, why: `last contacted ${Math.round(sinceTouch)}d ago, no reply` });
      continue;
    }
    if (events.length) continue; // contacted but not yet quiet — never also "stale"

    // Stale at source. Two things have to be true, and the second is the one that
    // is easy to forget: we need a post date AND that reading has to be recent.
    // `lastPostAt` is written once, at capture or enrich, and never refreshed — so
    // on its own it measures the age of our DATA, not the age of the account. A
    // lead enriched five months ago would be reported as "last posted 150d ago"
    // however busy they have been since. `outlierCheckedAt` is when we actually
    // looked; if that is stale too, the honest answer is that we don't know.
    if (!p.lastPostAt) continue;
    const sinceCheck = days(p.outlierCheckedAt);
    if (sinceCheck == null || sinceCheck > checkedWithinDays) continue;
    const sincePost = days(p.lastPostAt);
    if (sincePost != null && sincePost >= staleDays) {
      stale.push({ ...p, why: `last posted ${Math.round(sincePost)}d ago (checked ${Math.round(sinceCheck)}d ago)` });
    }
  }
  return { quiet, stale };
}
// Read-side migration only — nothing is rewritten on disk. Templates saved
// before comment support have no `kind` and are DMs.
export async function getTemplates(kind = null) {
  const { templates } = await get({ templates: null });
  let list = templates && templates.length ? templates : DEFAULT_TEMPLATES.slice();
  list = list.map((t) => (t.kind ? t : { ...t, kind: "dm" }));
  // A user who customized their templates before this release has no comment
  // starters at all; hand them the defaults rather than an empty dropdown.
  if (!list.some((t) => t.kind === "comment")) {
    list = list.concat(DEFAULT_TEMPLATES.filter((t) => t.kind === "comment"));
  }
  return kind ? list.filter((t) => t.kind === kind) : list;
}
export async function saveTemplate(t) {
  const templates = await getTemplates();
  if (!t.id) t.id = "t_" + Date.now();
  const i = templates.findIndex((x) => x.id === t.id);
  if (i >= 0) templates[i] = t; else templates.push(t);
  await set({ templates });
  return t;
}
export async function deleteTemplate(id) {
  const templates = (await getTemplates()).filter((t) => t.id !== id);
  await set({ templates });
}

// ---- CSV field selection ----
export async function getCsvFields() {
  const { csvFields } = await get({ csvFields: null });
  if (!csvFields || !csvFields.length) return DEFAULT_FIELDS.slice();
  // Migration: sourceAccount shipped after the first release, so a user who has
  // already customized their columns would otherwise never get the field that
  // separates their IG accounts in a consolidated Sheet. Insert it once.
  if (!csvFields.includes("sourceAccount")) {
    const next = csvFields.slice();
    const i = next.indexOf("lastSourceHandle");
    next.splice(i >= 0 ? i : next.length, 0, "sourceAccount");
    await set({ csvFields: next });
    return next;
  }
  // Migration: outlierTopRatio shipped later. Only this one is migrated in —
  // the other three outlier columns are noise for most users and stay opt-in
  // chips in Settings. Keyed on a separate marker so removing the column by
  // hand doesn't make it reappear on every load.
  if (!csvFields.includes("outlierTopRatio")) {
    const { outlierColMigrated } = await get({ outlierColMigrated: false });
    if (!outlierColMigrated) {
      const next = csvFields.concat(["outlierTopRatio"]);
      await set({ csvFields: next, outlierColMigrated: true });
      return next;
    }
  }
  // Migration: `posts` became a default column later than the rest. Marker-keyed
  // like outlierTopRatio above and NOT like sourceAccount, which tests only for
  // the field's own absence and so re-inserts a column the user deleted by hand
  // every single time getCsvFields() runs.
  if (!csvFields.includes("posts")) {
    const { postsColMigrated } = await get({ postsColMigrated: false });
    if (!postsColMigrated) {
      const next = csvFields.slice();
      const i = next.indexOf("followers");
      next.splice(i >= 0 ? i + 1 : next.length, 0, "posts");
      await set({ csvFields: next, postsColMigrated: true });
      return next;
    }
  }
  return csvFields;
}
export async function setCsvFields(fields) { await set({ csvFields: fields }); }

// Aggregate outreach metrics for the Metrics tab (computed from local data).
export async function computeMetrics() {
  const all = Object.values(await getProspects());
  const contacted = all.filter((p) => p.outreach && p.outreach.length);
  const isReplied = (p) => !!p.repliedAt || ["Replied", "Interested", "Meeting", "Won"].includes(p.status);
  // Events written before comments existed have no `channel` and are DMs, so
  // every existing user's numbers are unchanged by this split.
  const chan = (e) => e.channel || "dm";
  const dmEvents = (p) => (p.outreach || []).filter((e) => chan(e) === "dm");
  const cmEvents = (p) => (p.outreach || []).filter((e) => chan(e) === "comment");

  const dmContacted = contacted.filter((p) => dmEvents(p).length);
  const cmContacted = contacted.filter((p) => cmEvents(p).length);

  const sent = dmContacted.reduce((n, p) => n + dmEvents(p).length, 0);
  const comments = cmContacted.reduce((n, p) => n + cmEvents(p).length, 0);
  const people = contacted.length;      // touched by any channel
  const dmPeople = dmContacted.length;
  const commentPeople = cmContacted.length;

  // Rates are DM-only. A comment has no read receipt and no reply mechanic, so
  // counting comment-only prospects in the denominator would drag seen/reply
  // rate down for no reason.
  const seen = dmContacted.filter((p) => p.seenAt).length;
  const replied = dmContacted.filter(isReplied).length;
  const meetings = contacted.filter((p) => p.status === "Meeting").length;
  const won = contacted.filter((p) => p.status === "Won").length;
  const bySource = {};
  for (const p of contacted) {
    const s = p.lastSourceHandle || "—";
    // `people`, not messages: one row per prospect. The "messages sent" tile
    // counts events, so the two columns legitimately differ — the header says
    // people so they can't be read as contradicting each other.
    bySource[s] = bySource[s] || { people: 0, replied: 0 };
    bySource[s].people += 1;
    if (isReplied(p)) bySource[s].replied += 1;
  }

  // Read rate and reply rate BY TEMPLATE. This is the number the product is
  // built around — "which message works" — and it did not exist: logOutreach
  // stored the rendered `text` but no template id, so there was nothing to group
  // by. Events written before `tpl` was recorded fall into "—" and are excluded
  // from any per-template comparison rather than being lumped together.
  //
  // Attribution rule: a prospect is credited to the template of their FIRST DM,
  // because that's the message that had to earn the open. A follow-up sent with
  // a different template does not re-attribute them.
  const byTemplate = {};
  for (const p of dmContacted) {
    const first = dmEvents(p)[0];
    const t = (first && first.tpl) || "—";
    byTemplate[t] = byTemplate[t] || { people: 0, seen: 0, replied: 0 };
    byTemplate[t].people += 1;
    if (p.seenAt) byTemplate[t].seen += 1;
    if (isReplied(p)) byTemplate[t].replied += 1;
  }

  return {
    people, dmPeople, sent, comments, commentPeople, seen, replied, meetings, won,
    // "Never read yet" — the bucket that says the message didn't land, as
    // opposed to landed-and-ignored. The distinction is the whole product.
    unread: dmPeople - seen,
    seenRate: dmPeople ? Math.round((seen / dmPeople) * 100) : 0,
    replyRate: dmPeople ? Math.round((replied / dmPeople) * 100) : 0,
    // Of the people who DID open it, how many replied. This separates "nobody
    // sees my DMs" from "people see them and don't care" — two different fixes.
    replyRateOfRead: seen ? Math.round((replied / seen) * 100) : 0,
    bySource, byTemplate,
  };
}

export async function clearAll() {
  await new Promise((res) => chrome.storage.local.clear(res));
}
