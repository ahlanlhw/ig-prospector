// Sprill — background service worker (MV3).
// Opens the side panel from the toolbar icon, and owns every write to the
// recording-session storage keys.

import {
  HARVEST_KEY, MAX_HARVEST,
  readSession, writeSession, readHarvest, mergeInto, reconcile,
} from "../shared/recorder.js";

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.debug("[Sprill] setPanelBehavior", e));
});

// Belt-and-suspenders: also open on click for browsers that don't honor the
// behavior flag above.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.debug("[Sprill] sidePanel.open", e);
  }
});

// ---------------------------------------------------------------------------
// Recording sessions
//
// The content script never touches storage. It sends REC_* messages here and
// this file serializes every read-modify-write through one promise chain.
//
// That matters because "open followers in a second tab" is a normal part of
// this workflow, so two content scripts harvest concurrently. Two overlapping
// read-modify-write cycles on recHarvest would drop a batch *silently* — the
// losing tab has already marked those handles as harvested in memory and will
// never re-emit them.
//
// SW eviction is a non-issue here: we only wake on a message, every handler
// finishes in milliseconds, and this file holds no timer. The session deadline
// lives in storage as an absolute timestamp.
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {}); // a failed handler must not poison the chain
  return next;
}

async function handleResume(sender) {
  const session = await reconcile();
  if (!session || session.status !== "active") return { session: null };
  // Hand back the known usernames too, so the content script can rebuild its
  // in-memory dedup set in the same round-trip after a page reload.
  const harvest = await readHarvest();
  if (sender && sender.tab && sender.tab.id && !session.tabId) {
    session.tabId = sender.tab.id;
    await writeSession(session);
  }
  return { session, known: Object.keys(harvest) };
}

async function handleHarvest(msg) {
  const session = await readSession();
  // Drop writes from an orphaned tab whose session was superseded or ended.
  if (!session || session.status !== "active" || session.id !== msg.id) {
    return { ok: false, stale: true };
  }
  const harvest = await readHarvest();
  const { capped } = mergeInto(harvest, msg.records);
  const found = Object.keys(harvest).length;
  session.found = found;
  if (capped) session.capped = true;
  // One set() for both keys → one onChanged event for the panel, not two.
  await chrome.storage.local.set({ [HARVEST_KEY]: harvest, recording: session });
  return { ok: true, found, capped: capped || found >= MAX_HARVEST };
}

async function handleFinalize(msg) {
  const session = await readSession();
  if (!session || session.id !== msg.id) return { ok: false, stale: true };
  if (session.status === "active") {
    session.status = "ended";
    session.endedAt = Date.now();
    await writeSession(session);
  }
  return { ok: true, session };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (typeof type !== "string" || !type.startsWith("REC_")) return; // not ours
  serialize(async () => {
    try {
      switch (type) {
        case "REC_RESUME":
          sendResponse(await handleResume(sender));
          break;
        case "REC_HARVEST":
          sendResponse(await handleHarvest(msg));
          break;
        case "REC_FINALIZE":
          sendResponse(await handleFinalize(msg));
          break;
        default:
          sendResponse({ ok: false, error: "unknown_message" });
      }
    } catch (e) {
      console.debug("[Sprill] REC handler", type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  });
  return true; // keep the channel open for the async sendResponse
});
