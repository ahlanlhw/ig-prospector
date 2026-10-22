// Sprill — recording sessions ("Record for X minutes").
//
// A session lets the user browse Instagram normally while Sprill collects the
// handles it sees. When the timer expires the panel evaluates a capped batch
// of them.
//
// TWO STORAGE KEYS, deliberately separate:
//
//   recording   — small, hot, ~300 bytes. The panel watches it via
//                 chrome.storage.onChanged. Holds counts, never handles.
//   recHarvest  — the staging map of harvested handles.
//
// Handles are staged rather than written straight into `prospects` because
// flushing into that single blob every few seconds would rewrite the whole CRM
// a hundred times per session, and would permanently pollute the queue if the
// user stopped early. Staging keeps "Evaluate / Discard" resumable and reduces
// the commit to exactly one saveProspects() call.
//
// WHO WRITES: only the service worker. The content script cannot import this
// module (classic script) and must not touch storage directly — two Instagram
// tabs harvesting at once would silently lose batches. It messages the SW,
// which serializes every write.

export const REC_KEY = "recording";
export const HARVEST_KEY = "recHarvest";

// Durations offered in the panel, in minutes.
export const DURATIONS = [5, 10, 20];
export const DEFAULT_DURATION_MIN = 10;

// Hard ceiling on a single session's harvest. Past this the burst is
// meaningless anyway — 1000 profiles at ~4s each is over an hour.
export const MAX_HARVEST = 1000;

// How many handles the burst opens. Never offer "all": at ~4s a profile,
// 100 is already ~7 minutes of background tabs.
export const ENRICH_CAPS = [25, 40, 100];
export const DEFAULT_ENRICH_CAP = 25;

// A session whose deadline passed more than this long ago is discarded rather
// than offered for evaluation. Without it, a session the user forgot about
// ambushes them a week later with a 40-tab burst.
export const STALE_MS = 24 * 60 * 60 * 1000;

// Pacing for the burst. Deliberately slower and jittered vs. the fixed 400ms
// used by manual "Enrich selected" — a metronome-regular request pattern is
// exactly what behavioural rate-limiting looks for.
export const BURST_PACE_MIN_MS = 1500;
export const BURST_PACE_JITTER_MS = 1500;

// A handle seen on this many distinct URLs is site chrome (nav rail, footer,
// suggestion sidebar), not someone the user was looking at.
export const CHROME_PAGE_THRESHOLD = 3;

export function burstPaceMs() {
  return BURST_PACE_MIN_MS + Math.random() * BURST_PACE_JITTER_MS;
}

// ---- session lifecycle ----

export function newSession({ durationMin, tabId, sourceAccount }) {
  const now = Date.now();
  const mins = DURATIONS.includes(Number(durationMin)) ? Number(durationMin) : DEFAULT_DURATION_MIN;
  return {
    v: 1,
    id: `rec_${now}_${Math.floor(Math.random() * 1e6)}`,
    status: "active", // active | ended | enriching | done
    durationMs: mins * 60 * 1000,
    startedAt: now,
    endsAt: now + mins * 60 * 1000, // ABSOLUTE — the only timer truth
    tabId: tabId || null,
    sourceAccount: sourceAccount || "",
    found: 0,
    capped: false,
    endedAt: null,
    committed: 0,
    enriched: 0,
    dropped: 0,
  };
}

export async function readSession() {
  const o = await chrome.storage.local.get({ [REC_KEY]: null });
  return o[REC_KEY] || null;
}

export async function writeSession(session) {
  await chrome.storage.local.set({ [REC_KEY]: session });
  return session;
}

export async function readHarvest() {
  const o = await chrome.storage.local.get({ [HARVEST_KEY]: {} });
  return o[HARVEST_KEY] || {};
}

export async function clearSession() {
  await chrome.storage.local.remove([REC_KEY, HARVEST_KEY]);
}

export function isActive(s) {
  return !!s && s.status === "active";
}
export function isStale(s) {
  return !!s && !!s.endsAt && Date.now() - s.endsAt > STALE_MS;
}
export function msLeft(s) {
  return !s ? 0 : Math.max(0, s.endsAt - Date.now());
}

// Merge a batch of harvested records into the staging map.
// Returns the new total. Records already present bump their sighting count and
// remember the distinct pages they appeared on — that's what identifies site
// chrome later (see CHROME_PAGE_THRESHOLD).
export function mergeInto(harvest, records) {
  for (const r of records || []) {
    const key = String(r.username || "").toLowerCase();
    if (!key) continue;
    const existing = harvest[key];
    if (existing) {
      existing.n = (existing.n || 1) + 1;
      const url = r.sourceUrl || "";
      if (url && !existing.pages.includes(url) && existing.pages.length < 5) {
        existing.pages.push(url);
      }
      // Keep the better display name if we only had the handle before.
      if (existing.displayName === existing.username && r.displayName && r.displayName !== r.username) {
        existing.displayName = r.displayName;
      }
    } else {
      if (Object.keys(harvest).length >= MAX_HARVEST) return { harvest, capped: true };
      harvest[key] = {
        username: r.username,
        displayName: r.displayName || r.username,
        profileUrl: r.profileUrl,
        sourceType: r.sourceType || "list",
        sourceUrl: r.sourceUrl || "",
        at: Date.now(),
        n: 1,
        pages: r.sourceUrl ? [r.sourceUrl] : [],
      };
    }
  }
  return { harvest, capped: false };
}

// Self-healing, run from BOTH the content script boot and the panel boot.
// The content script is the only timer holder, so if its tab closed before
// endsAt the timer never fired and the session is stuck "active" with a
// deadline in the past. Returns the session as it should now be, or null if it
// was discarded.
export async function reconcile() {
  const s = await readSession();
  if (!s) return null;
  if (isStale(s)) {
    await clearSession();
    return null;
  }
  if (s.status === "active" && Date.now() >= s.endsAt) {
    s.status = "ended";
    s.endedAt = s.endsAt;
    await writeSession(s);
  }
  return s;
}
