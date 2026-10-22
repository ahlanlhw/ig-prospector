// Sprill — side panel controller (M0, zero-build ES module).
import {
  LIMITS, COMMENT_LIMITS, ALL_FIELDS,
  getAutoComment, setAutoComment,
  getICP, setICP,
  getProspects, saveProspect, saveProspects, updateProspect, removeProspect, hasProspect,
  replaceProspects, mergeEnrichment, looksLikeRealProfile, reelsReadIsComplete, withReelsGrid,
  readQuality, readLooksSettled,
  canSend, recordSend, getUsage,
  getCsvFields, setCsvFields, clearAll,
  paceStatus, getOneClick, setOneClick, getDefaultTpl, setDefaultTpl,
  logOutreach, warmupStats, getDailyTarget, setDailyTarget,
  getTemplates, saveTemplate, deleteTemplate,
  isOpen, setOutcome, snoozeFollowUp, getFollowUpDays, setFollowUpDays,
  cullCandidates,
  markSeen,
  failsPublicFilter,
  STAGE, QUEUE_STATUSES, isQueued, isShortlisted, isContacted,
  getAutoEnrichN, setAutoEnrichN,
  computeMetrics, getPaceMinMs, setPaceMinMs, storageUsage,
  draftKey, getDraftText, setDraftText, clearDraftText,
  ICP_PRESETS, isOnboarded, setOnboarded,
} from "../shared/store.js";
import { csvValue, csvField, parseCsv, mapCsvRows, parseHandleList } from "../shared/csv.js";
import { computeScore } from "../shared/score.js";
import { analyzeGrid, shouldPersistFromCapture, OUTLIER_TUNING } from "../shared/outliers.js";
import { buildDraft, OBJECTIVE_OPTIONS } from "../shared/draft.js";
import { renderTemplate, topicFor } from "../shared/templates.js";
import { hasGoogle, hasFirebase } from "../shared/config.js";
import { signIn as googleSignIn, getGoogleUser, signOut as googleSignOut } from "../shared/auth.js";
import { exportToSheet } from "../shared/sheets.js";
import { syncNow } from "../shared/sync.js";
import {
  createList, joinList, leaveList, refreshLists, cachedLists,
  pushAllToList, pushToList, pullFromList,
} from "../shared/lists.js";
import { FLAGS, flagOn, setFlagOverride, getFlagOverride } from "../shared/flags.js";
import {
  REC_KEY, DURATIONS, DEFAULT_DURATION_MIN, ENRICH_CAPS, DEFAULT_ENRICH_CAP,
  CHROME_PAGE_THRESHOLD, burstPaceMs,
  newSession, readSession, writeSession, readHarvest, clearSession, reconcile,
} from "../shared/recorder.js";

// selection state for batch send
const selected = new Set();
let batchStop = false;

// recorder state (panel-side view of the session in storage)
let recSession = null;
let recTicker = null;
let recBursting = false;
let recWired = false;

// ---------- tab messaging ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}
function isInstagram(tab) {
  return tab && tab.url && /^https:\/\/www\.instagram\.com\//.test(tab.url);
}

// The panel had no runtime.onMessage listener at all before 0.18.0 — it only
// ever spoke to tabs. An Explore scan now takes tens of seconds, so the content
// script streams progress here rather than leaving the user staring at a frozen
// button. No conflict with the service worker: its listener returns early on
// anything not starting with "REC_".
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "SCAN_PROGRESS") return;
  const p = $("#scan-progress");
  if (p) p.textContent = `Reading post authors — ${msg.done}/${msg.total}…`;
});
async function getViewer(tab) {
  const r = await sendToTab(tab.id, { type: "GET_VIEWER" });
  return r && r.ok ? r.viewer : null;
}
// Handle of the IG account currently logged in. Stamped onto every lead at
// CAPTURE time (not just on send) so someone running several accounts can tell
// their sources apart in one consolidated Sheet. Never throws — attribution is
// best-effort and must not block a capture.
async function viewerHandle(tab) {
  try {
    const t = tab || (await activeTab());
    if (!isInstagram(t)) return null;
    const v = await getViewer(t);
    return (v && v.username) || null;
  } catch {
    return null;
  }
}
// Spreadable attribution stamp. Returns {} when the account can't be detected,
// so we never write `sourceAccount: undefined` over a value already on record.
async function sourceStamp(tab) {
  const h = await viewerHandle(tab);
  return h ? { sourceAccount: h } : {};
}
async function updateAccountBar() {
  const bar = document.getElementById("account-bar");
  if (!bar) return;
  const tab = await activeTab();
  if (!isInstagram(tab)) { bar.textContent = "Account: open Instagram to detect"; bar.classList.add("none"); return; }
  await ensureContent(tab);
  const v = await getViewer(tab);
  if (v && v.username) { bar.innerHTML = `Sending as <b>@${esc(v.username)}</b>`; bar.classList.remove("none"); }
  else { bar.textContent = "Account: not detected"; bar.classList.add("none"); }
}

async function ensureContent(tab) {
  let r = await sendToTab(tab.id, { type: "PING" });
  if (r && r.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content/instagram.js"] });
    r = await sendToTab(tab.id, { type: "PING" });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// ---------- small utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmtNum(n) {
  if (n == null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- quota ----------
async function refreshQuota() {
  const c = await canSend();
  const q = $("#quota");
  q.textContent = `${c.dayCount} / ${LIMITS.DAILY} today`;
  q.classList.toggle("blocked", !c.ok);
  q.title = `Free tier: ${LIMITS.DAILY} DMs/day, ${LIMITS.MONTHLY}/month · ${c.monthCount}/${LIMITS.MONTHLY} this month`;
  // Comments have their own budget. Stay out of the way until one is used.
  const cc = await canSend("comment");
  const qc = $("#quota-comments");
  if (qc) {
    qc.hidden = cc.dayCount === 0 && cc.monthCount === 0;
    qc.textContent = `${cc.dayCount} / ${COMMENT_LIMITS.DAILY} 💬`;
    qc.classList.toggle("blocked", !cc.ok);
    qc.title = `Comments: ${COMMENT_LIMITS.DAILY}/day, ${COMMENT_LIMITS.MONTHLY}/month · ${cc.monthCount}/${COMMENT_LIMITS.MONTHLY} this month — separate from DMs`;
  }
}

// The generic outbound webhook was REMOVED in 0.13.0.
//
// It POSTed a JSON entity payload to any HTTPS URL the user typed, which meant it
// was the only consumer of `optional_host_permissions: https://*/*` — the single
// broadest thing in the manifest, and per STORE_ELIGIBILITY.md the one most likely
// to slow a Web Store review. The justification was defensible (Google's own
// chrome.permissions docs prescribe exactly that pattern for runtime-discovered
// hosts) but it was defending a feature nobody had asked for yet, at the cost of
// the permission a reviewer reads first.
//
// CSV export and the Google Sheet remain the generic integration paths: both are
// consumable by anything, and neither needs a host permission.
//
// If it ever comes back, it should come back as an explicit per-domain grant with
// the origin declared in `optional_host_permissions` — not a wildcard.

// Single place that turns a style-select value into message text. This logic
// used to be duplicated in makeDraftBox.regen() and batchSend(), so any new
// drafting mode had to be added in two places or silently diverge.
//   "obj:<objective>" — generated DM
//   "tpl:<id>"        — saved template (DM or comment)
//   "blank:"          — empty, the default for comments (you write those)
async function renderFor(profile, selValue, ctx = {}) {
  const v = selValue || "obj:networking";
  if (v === "blank:") return "";
  const icp = ctx.icp || (await getICP());
  const businessName = ctx.businessName != null
    ? ctx.businessName
    : (await chrome.storage.local.get({ businessName: "" })).businessName;
  if (v.startsWith("tpl:")) {
    const t = (await getTemplates()).find((x) => x.id === v.slice(4));
    return t ? renderTemplate(t.body, profile, { business: businessName, icp }) : "";
  }
  return buildDraft(profile, icp, v.slice(4), { businessName });
}

// Storage in words. With "unlimitedStorage" granted there is no percentage to
// quote — quoting one against the waived 10 MB cap is how we used to tell people
// they were nearly full when they weren't.
async function storageBlurb() {
  const u = await storageUsage();
  const mb = (u.bytes / 1048576).toFixed(1);
  return u.unlimited ? `storage holds ${mb} MB` : `storage is ${u.pct}% full`;
}

// ---------- draft durability ----------
//
// Both draft boxes are detached DOM nodes that get rebuilt constantly:
// refreshCurrent() does `body.innerHTML = ""` and renderQueue() does the same to
// the list, and between them they fire on every panel-tab switch, every BROWSER
// tab switch, and every Instagram page load. Without this, anything you had
// typed and not yet sent was simply gone — worst for comments, which you write
// while looking around the post.
//
// Two jobs, deliberately in one place:
//   1. Persist what you type (debounced) and restore it when the box is rebuilt.
//   2. Stop generated text from silently overwriting your edits. Moving the
//      template dropdown used to clobber the box, so comparing two templates
//      against something you had written destroyed it.
function attachDraftPersistence(ta, key) {
  let generated = "";   // the last text WE put in the box
  let timer = null;

  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { setDraftText(key, ta.value).catch(() => {}); }, 400);
  };
  ta.addEventListener("input", save);

  return {
    /** Restore a saved draft into the box. True if there was one. */
    async restore() {
      const saved = await getDraftText(key).catch(() => "");
      if (!saved) return false;
      ta.value = saved;
      return true;
    },

    /**
     * Put generated text in the box. Refuses — and returns false — when you have
     * edited it, unless `force` (the explicit Regenerate / Fill button).
     * Generated text is never persisted: it costs nothing to rebuild, and
     * storing it would make the next open look like an edit.
     */
    replace(next, force) {
      const dirty = !!ta.value.trim() && ta.value !== generated;
      if (dirty && !force) return false;
      ta.value = next;
      generated = next;
      clearTimeout(timer);
      clearDraftText(key).catch(() => {});
      return true;
    },

    /** After a send/log the draft is spent. */
    async clear() {
      clearTimeout(timer);
      generated = "";
      await clearDraftText(key).catch(() => {});
    },
  };
}

// ---------- reusable draft box ----------
function makeDraftBox(profile, opts = {}) {
  const box = el("div", "draft-box card");
  const styleSel = el("select", "inline");
  const ta = el("textarea");
  ta.rows = 5;

  async function populateStyles() {
    styleSel.innerHTML = "";
    for (const o of OBJECTIVE_OPTIONS) {
      const opt = el("option"); opt.value = "obj:" + o.value; opt.textContent = "Auto · " + o.label; styleSel.appendChild(opt);
    }
    for (const t of await getTemplates("dm")) {
      const opt = el("option"); opt.value = "tpl:" + t.id; opt.textContent = "Template · " + t.name; styleSel.appendChild(opt);
    }
  }

  // Everything you type survives a re-render. See attachDraftPersistence.
  const dkey = draftKey("dm", profile && profile.username);
  const draft = attachDraftPersistence(ta, dkey);

  // `force` distinguishes "you asked for new text" from "the dropdown moved".
  // Only the first may discard what you wrote.
  const regen = async (force) => {
    const next = await renderFor(profile, styleSel.value || "obj:networking");
    if (!draft.replace(next, force)) toast("Kept your edits — press ↻ Regenerate to replace");
  };
  styleSel.addEventListener("change", () => regen(false));

  const genBtn = el("button", "btn ghost sm", "↻ Regenerate");
  genBtn.addEventListener("click", () => regen(true));

  // Open this prospect's DM thread in THIS tab.
  //
  // Insert needs a composer, and a lead you have never messaged has no thread to
  // insert into — so every first message meant leaving the panel, pressing IG's
  // ✎ New message, typing the handle and picking a row from the results. Two
  // routes, in order of how little can go wrong:
  //
  //  1. `ig.me/m/{handle}` — Instagram's own "message this account" deep link.
  //     One navigation, nothing to click, and no English button text to match,
  //     so it is the only route here that a non-English UI cannot break.
  //  2. The profile page's Message button — what sendViaTempTab has always used.
  //     `findMessageButton` matches /^message$/i, hence route 1 first.
  //
  // Deliberately NOT the ✎ New message dialog: that means typing into a search
  // box, waiting on async results and clicking a row — and picking the wrong row
  // messages the wrong person. Both routes above are addressed by handle and
  // cannot select the wrong account.
  const openBtn = el("button", "btn ghost sm", "Open DM ↗");
  openBtn.addEventListener("click", async () => {
    if (!profile || !profile.username) return toast("No handle for this lead");
    const tab = await activeTab();
    if (!tab) return toast("No active tab");
    openBtn.disabled = true;
    const label = openBtn.textContent;
    openBtn.textContent = "Opening…";
    try {
      await chrome.tabs.update(tab.id, { url: `https://ig.me/m/${encodeURIComponent(profile.username)}` });
      let ok = await waitForUrl(tab.id, /\/direct\//, 12000);
      if (!ok) {
        // Fall back to the profile page and its Message button.
        await chrome.tabs.update(tab.id, { url: profile.profileUrl || `https://www.instagram.com/${profile.username}/` });
        for (let i = 0; i < 40; i++) {
          if (await ensureContent(tab)) {
            const r = await sendToTab(tab.id, { type: "OPEN_DM" });
            if (r && r.ok) break;
          }
          await sleep(200);
        }
        ok = await waitForUrl(tab.id, /\/direct\//, 12000);
      }
      toast(ok
        ? `Thread open with @${profile.username} — press Insert`
        : "Couldn’t open the thread — open it yourself, then press Insert");
    } finally {
      openBtn.disabled = false;
      openBtn.textContent = label;
    }
  });

  // Insert-and-send, opt-in per draft and never sticky. It sends into the thread
  // that is open in front of you — it never navigates and never opens a temp
  // tab, so the recipient you can see IS the recipient, which is a stronger
  // per-message confirmation than the temp-tab path can offer.
  const sendChk = el("input");
  sendChk.type = "checkbox";
  let sendChkConfirmed = false;
  sendChk.addEventListener("change", () => {
    if (!sendChk.checked || sendChkConfirmed) return;
    const ok = confirm(
      "Insert and send\n\n" +
      "Sprill will type the message into the thread you have open and click Send, " +
      "without stopping for you to press it.\n\n" +
      "It only ever sends into the thread already open in this tab, and it refuses " +
      "if the message box doesn't take the text cleanly.\n\n" +
      "Automated sending is what Instagram's detection looks for, and the account at " +
      "risk is yours. Leave this off and press Send yourself if you'd rather.",
    );
    if (!ok) sendChk.checked = false;
    else sendChkConfirmed = true;
  });
  const sendChkLabel = el("label", "chk");
  sendChkLabel.append(sendChk, el("span", null, "Insert <b>and send</b>"));

  async function doInsert() {
    const alsoSend = sendChk.checked;
    const text = ta.value;
    if (!text.trim()) return toast("Nothing to insert");
    const tab = await activeTab();
    if (!isInstagram(tab)) return toast("Open Instagram in this tab first");
    if (!/\/direct\//.test(tab.url || "")) return toast("Open the DM thread first — press Open DM ↗");
    if (alsoSend) {
      const c = await canSend();
      if (!c.ok) return toast(`Free limit reached (${LIMITS.DAILY}/day, ${LIMITS.MONTHLY}/mo)`);
      const pace = await paceStatus();
      if (!pace.ready) return toast(`Pacing — wait ${Math.ceil(pace.waitMs / 1000)}s before the next send`);
    }
    await ensureContent(tab);
    if (!alsoSend) {
      const r = await sendToTab(tab.id, { type: "INSERT_DRAFT", text });
      return toast(r && r.ok ? "Inserted — review & press Send in Instagram" : sendErr(r));
    }
    insertBtn.disabled = true;
    const label = insertBtn.textContent;
    insertBtn.textContent = "Sending…";
    const r = await sendToTab(tab.id, { type: "SEND_MESSAGE", text });
    insertBtn.disabled = false;
    insertBtn.textContent = label;
    if (!(r && r.ok)) return toast(sendErr(r));
    await recordSend();
    await logOutreach(profile, { at: new Date().toISOString(), channel: "dm", type: "insert_send", text, tpl: styleSel.value, method: r.method, source: r.viewer });
    await draft.clear();
    await refreshQuota();
    sendChk.checked = false; // one message, one decision
    toast(r.unverified
      ? `Logged as sent as @${(r.viewer && r.viewer.username) || "?"} — we never saw a Send button, so check the thread`
      : `Sent ✓ as @${(r.viewer && r.viewer.username) || "?"}`);
    renderQueue(); renderPipeline();
  }

  const insertBtn = el("button", "btn sm", "Insert into DM →");
  insertBtn.addEventListener("click", doInsert);

  const sentBtn = el("button", "btn ghost sm", "✓ Mark as sent");
  sentBtn.addEventListener("click", async () => {
    const c = await canSend();
    if (!c.ok) return toast(`Free limit reached (${LIMITS.DAILY}/day, ${LIMITS.MONTHLY}/mo)`);
    const tab = await activeTab();
    const source = isInstagram(tab) ? await getViewer(tab) : null;
    await recordSend();
    const rec = await logOutreach(profile, { at: new Date().toISOString(), channel: "dm", type: "manual", text: ta.value, tpl: styleSel.value, source });
    await draft.clear();
    await refreshQuota();
    toast("Logged as sent");
    renderQueue(); renderPipeline();
  });

  // Send from this panel (opt-in). Hidden unless enabled in Settings.
  const sendNowBtn = el("button", "btn send", "Confirm & Send");
  sendNowBtn.style.display = "none";
  sendNowBtn.addEventListener("click", async () => {
    const c = await canSend();
    if (!c.ok) return toast(`Free limit reached (${LIMITS.DAILY}/day, ${LIMITS.MONTHLY}/mo)`);
    const pace = await paceStatus();
    if (!pace.ready) return toast(`Pacing — wait ${Math.ceil(pace.waitMs / 1000)}s before the next send`);
    sendNowBtn.disabled = true;
    const label = sendNowBtn.textContent;
    sendNowBtn.textContent = "Sending…";
    const r = await sendViaTempTab(profile, ta.value); // opens a temp tab, sends, closes it
    sendNowBtn.disabled = false;
    sendNowBtn.textContent = label;
    if (r && r.ok) {
      await recordSend();
      const rec = await logOutreach(profile, { at: new Date().toISOString(), channel: "dm", type: "oneclick", text: ta.value, tpl: styleSel.value, method: r.method, source: r.viewer });
      await draft.clear();
      await refreshQuota();
      toast(r.unverified
        ? `Logged as sent as @${(r.viewer && r.viewer.username) || "?"} — we never saw a Send button, so check the thread`
        : `Sent ✓ as @${(r.viewer && r.viewer.username) || "?"}`);
      renderQueue(); renderPipeline();
    } else {
      toast(sendErr(r));
    }
  });
  getOneClick().then((on) => { sendNowBtn.style.display = on ? "" : "none"; });

  const row1 = el("div", "row-between");
  row1.append(styleSel, genBtn);
  const row2 = el("div", "row-gap");
  insertBtn.style.flex = "1"; sentBtn.style.flex = "1";
  row2.append(insertBtn, sentBtn);
  const row0 = el("div", "row-between");
  row0.append(openBtn, sendChkLabel);

  box.append(el("div", "muted", "Draft message · editable"), ta, row1, row0, sendNowBtn, row2);
  box.append(el("p", "fine", "No thread yet? <b>Open DM ↗</b> opens one with this account in this tab. Then Insert → you review → you press Send. Tick <b>Insert and send</b> and Sprill presses Send for you, in the thread you have open — it unticks itself after every message."));
  (async () => {
    await populateStyles();
    // Explicit ask (a Follow-up draft) wins; otherwise the template you set as
    // the default in Settings; otherwise the first Auto opener.
    const preferred = opts.preferTemplateId || (await getDefaultTpl());
    if (preferred) {
      const val = "tpl:" + preferred;
      if ([...styleSel.options].some((o) => o.value === val)) styleSel.value = val;
    }
    // An unsent draft wins over a fresh generation — it's the only thing here
    // that can't be reproduced.
    if (!(await draft.restore())) await regen(true);
  })();
  return box;
}

// ---------- CURRENT tab ----------
// Re-entrancy guards.
//
// refreshCurrent() and renderQueue() both clear their container and then await
// several times before appending, and both are called unawaited from a dozen
// places plus two global tab listeners. Two interleaved runs appended TWO profile
// cards, and the stale card's Capture button closed over the wrong profile — so
// clicking the button you could see captured an account you were not looking at.
// Each run takes a generation number and bails at every await boundary if a newer
// run has started.
let currentGen = 0;
let queueGen = 0;
// Tabs the panel itself opened (send, enrich, read-status). chrome.tabs.onUpdated
// fires for EVERY tab, so during a 100-profile enrich burst the listener re-ran
// refreshCurrent() once per temp tab, against the temp tab.
const tempTabs = new Set();

async function refreshCurrent() {
  const gen = ++currentGen;
  const stale = () => gen !== currentGen;
  const body = $("#current-body");
  body.innerHTML = "";
  const tab = await activeTab();
  if (stale()) return;
  if (!isInstagram(tab)) {
    body.append(el("div", "empty", "Open <b>instagram.com</b> in this tab to capture profiles."));
    return;
  }
  const ok = await ensureContent(tab);
  if (!ok) {
    body.append(el("div", "empty", "Couldn’t connect to the page. Reload Instagram and reopen this panel."));
    return;
  }
  const resp = await sendToTab(tab.id, { type: "GET_CURRENT_PROFILE" });
  const profile = resp && resp.ok ? resp.profile : null;
  if (!profile) {
    // The response already carries `page`, so the post branch costs no extra
    // round-trip on every other kind of page.
    if (resp && resp.page === "post") return renderPostCard(body, tab);
    body.append(el("div", "empty",
      "No profile on this page.<br/>Open someone at <b>instagram.com/username</b> to capture — or use <b>Scan page</b> in the Queue tab on a followers/explore/search page."));
    return;
  }

  const icp = await getICP();
  const s = computeScore(profile, icp);
  const saved = await hasProspect(profile.username);

  // Header card
  const card = el("div", "card");
  const head = el("div", "row");
  head.append(
    el("div", null,
      `<div class="p-name">@${esc(profile.username)}${profile.verified ? " ✔︎" : ""}</div>
       <div class="p-sub">${esc(profile.displayName || "")}${profile.followers != null ? " · " + fmtNum(profile.followers) + " followers" : ""}</div>`),
  );
  const scoreEl = el("div", `score ${s.band === "High fit" ? "high" : s.band === "Low fit" || s.band === "Needs enrich" ? "low" : ""}`,
    `<b>${s.score == null ? "—" : s.score}</b><span>${esc(s.band)}</span>`);
  head.append(scoreEl);
  card.append(head);

  card.append(el("div", "muted", profile.userId
    ? `ID ${esc(profile.userId)} · stable across handle changes`
    : "No stable ID found on this page · tracked by handle"));

  // account type + category (+ private flag)
  if (profile.accountType || profile.category || profile.isPrivate) {
    const meta = el("div", "chips");
    if (profile.accountType) meta.append(el("span", "chip", esc(profile.accountType)));
    if (profile.category) meta.append(el("span", "chip", esc(profile.category)));
    if (profile.isPrivate) meta.append(el("span", "chip", "🔒 private"));
    card.append(meta);
  }
  if (profile.businessSignals && profile.businessSignals.length) {
    const bs = el("div", "chips");
    for (const sig of profile.businessSignals.slice(0, 4)) bs.append(el("span", "chip", `💼 ${esc(sig)}`));
    card.append(bs);
  }

  if (profile.bio) card.append(el("p", "p-sub", esc(profile.bio)));

  // grid posts → outliers (research only; never feeds the score)
  if (profile.gridPosts && profile.gridPosts.length) card.append(buildOutlierBlock(profile.gridPosts));

  const reasons = el("ul", "reasons");
  for (const r of s.reasons.slice(0, 4)) reasons.append(el("li", null, esc(r)));
  for (const c of s.concerns.slice(0, 2)) reasons.append(el("li", "con", esc(c)));
  card.append(reasons);

  // contacts
  const contactChips = el("div", "chips");
  if (profile.linkInBio) contactChips.append(el("span", "chip", `🔗 link-in-bio: ${esc(profile.linkInBio)}`));
  for (const link of (profile.links || []).filter((l) => l !== profile.linkInBio).slice(0, 3))
    contactChips.append(el("span", "chip", `🔗 ${esc(link)}`));
  for (const e of (profile.emails || [])) contactChips.append(el("span", "chip", `✉︎ ${esc(e)}`));
  for (const p of (profile.phones || [])) contactChips.append(el("span", "chip", `☎ ${esc(p)}`));
  for (const b of (profile.publicContactButtons || [])) contactChips.append(el("span", "chip", `● public ${esc(b)}`));
  if (contactChips.childNodes.length) card.append(contactChips);

  body.append(card);

  // capture / saved state + draft
  if (saved) {
    const badge = el("div", "row-between");
    badge.append(el("span", "saved-badge", "✓ Saved to queue"));
    const rm = el("button", "icon-btn danger", "Remove");
    rm.addEventListener("click", async () => { await removeProspect(profile.username); toast("Removed"); refreshCurrent(); renderQueue(); });
    badge.append(rm);
    body.append(badge);
    body.append(makeDraftBox(profile));
  } else if (failsPublicFilter(profile)) {
    // PUBLIC_ONLY_NOTE — see store.js:failsPublicFilter. No "Capture anyway"
    // button any more: a private account has no bio, no counts and no contact
    // route, so it can never be scored or contacted, and "we never collect
    // private accounts" has to be true without an asterisk.
    body.append(el("p", "fine warn",
      "Private account. Sprill works on public accounts only — there's no bio, "
      + "follower count or contact route to read here, so there's nothing to score."));
  } else {
    const capBtn = el("button", "btn", "＋ Capture to queue");
    capBtn.addEventListener("click", async () => {
      // Keep the reels evidence you can see on screen. Until 0.14.0 the chips
      // rendered live and then died with the card: only enrich persisted a
      // verdict, so a hand-captured profile showed no ⚡ chip in the queue and
      // never appeared under "Top performing reels".
      const stored = storedFor(await getProspects(), profile);
      const rec = await saveProspect({
        ...stripGrid(profile), ...capturePatch(profile, stored),
        score: s.score, band: s.band, reasons: s.reasons, concerns: s.concerns,
        status: "Captured", capturedAt: new Date().toISOString(),
        ...(await sourceStamp()),
      });
      toast("Captured");
      refreshCurrent(); renderQueue(); renderPipeline();
    });
    body.append(capBtn);
    body.append(el("p", "fine", "Saves the handle, account type, score, and contacts — locally now, exportable to CSV / your Sheet."));
  }
}

// ---------- POST pages: comment as outreach ----------
// A separate surface from the profile card, and a separate builder from
// makeDraftBox — a comment is public, short, and has no call-to-action.

function commentErr(r) {
  const e = (r && r.error) || "no_response";
  if (e === "not_a_post_page") return "Open the post first, then comment";
  if (e === "wrong_post") return "You've moved to a different post — reopen the panel";
  if (e === "comment_box_not_found") return "Couldn't find the comment box — click it once, then try again";
  if (e === "comment_submit_not_found") return "Your text is in the box — press Post yourself";
  if (e === "comment_not_submitted") return "Instagram didn\u2019t accept it — your text is still there, press Post";
  // Deliberately does NOT say "press Post". We could not establish whether the
  // comment landed, and a duplicate public comment under your own name is not
  // recoverable — so the instruction is to look, not to retry.
  if (e === "comment_uncertain") return "Can\u2019t tell if that posted — check the post before trying again";
  if (e === "post_author_not_found") return "Couldn't tell whose post this is — open their profile to capture them";
  return `Comment failed (${e})`;
}

// logOutreach returns null for anyone not already in the CRM, so a comment on a
// stranger's post has to capture them first.
async function logComment(post, text, extra = {}) {
  const a = post && post.author;
  if (!a || !a.username) return toast(commentErr({ error: "post_author_not_found" }));
  if (post.isOwnPost) return toast("That's your own post");

  if (!(await hasProspect(a.username))) {
    const seed = {
      platform: "instagram", username: a.username, userId: a.userId || null,
      displayName: a.displayName || a.username,
      profileUrl: `https://www.instagram.com/${a.username}/`,
      sourceType: "post", sourceUrl: post.postUrl,
      status: "Captured", capturedAt: new Date().toISOString(),
      ...(await sourceStamp()),
    };
    const s = computeScore(seed, await getICP()); // "Needs enrich" — correct, we only saw a post
    await saveProspect({ ...seed, score: s.score, band: s.band, reasons: s.reasons });
  }

  await recordSend("comment");
  const rec = await logOutreach(a.username, {
    at: new Date().toISOString(),
    channel: "comment",
    type: "manual",
    text,
    method: extra.method || null,
    source: extra.viewer || null,
    postUrl: post.postUrl,
    // A comment has no read receipt and no reply mechanic, so a 3-day follow-up
    // would be work with no defined next action.
    noFollowUp: true,
  });
  await refreshQuota();
  toast("Comment logged");
  renderQueue(); renderPipeline();
}

function makeCommentBox(post) {
  const box = el("div", "draft-box card");
  box.append(el("div", "muted", "Comment · public · you write it"));

  const ta = el("textarea");
  ta.rows = 3;
  ta.placeholder = "Say something specific about this post…";
  const counter = el("div", "fine", "0 characters");
  const sync = () => {
    const n = ta.value.length;
    counter.textContent = `${n} character${n === 1 ? "" : "s"}`;
    counter.className = n > 150 ? "fine warn" : "fine";
  };
  ta.addEventListener("input", sync);

  // Keyed on the post, not the author — you can be part-way through comments on
  // two different posts by the same person.
  const dkey = draftKey("comment", post && post.shortcode);
  const draft = attachDraftPersistence(ta, dkey);

  const styleSel = el("select", "inline");
  const regen = async (force) => {
    const next = await renderFor(post.author || {}, styleSel.value || "blank:");
    if (!draft.replace(next, force)) return toast("Kept your edits — press ↻ Fill to replace");
    sync();
  };
  styleSel.addEventListener("change", () => regen(false));
  const genBtn = el("button", "btn ghost sm", "↻ Fill");
  genBtn.addEventListener("click", () => regen(true));

  (async () => {
    const blank = el("option"); blank.value = "blank:"; blank.textContent = "Write my own"; styleSel.appendChild(blank);
    for (const t of await getTemplates("comment")) {
      const o = el("option"); o.value = "tpl:" + t.id; o.textContent = "Template · " + t.name; styleSel.appendChild(o);
    }
    // The default is "Write my own", so there is nothing to generate — an
    // unsent comment is the only thing worth restoring here.
    if (await draft.restore()) sync();
  })();

  const row = el("div", "row-between");
  row.append(styleSel, genBtn);
  box.append(ta, counter, row);

  // Auto-post: hidden unless explicitly enabled, same fire-and-forget reveal as
  // the DM "Send now" button.
  const postNowBtn = el("button", "btn send", "⚡ Post comment");
  postNowBtn.style.display = "none";
  postNowBtn.addEventListener("click", async () => {
    if (!ta.value.trim()) return toast("Write the comment first");
    const c = await canSend("comment");
    if (!c.ok) return toast(`Comment limit reached (${COMMENT_LIMITS.DAILY}/day, ${COMMENT_LIMITS.MONTHLY}/mo)`);
    const pace = await paceStatus("comment");
    if (pace.waitMs > 0) return toast(`Pacing — ${Math.ceil(pace.waitMs / 1000)}s to go`);
    const tab = await activeTab();
    await ensureContent(tab);
    const r = await sendToTab(tab.id, { type: "POST_COMMENT", text: ta.value, shortcode: post.shortcode });
    if (!(r && r.ok)) return toast(commentErr(r)); // never log on failure
    await logComment(post, ta.value, { method: r.method, viewer: r.viewer });
    await draft.clear();
    refreshCurrent();
  });
  getAutoComment().then((on) => { postNowBtn.style.display = on ? "" : "none"; });
  box.append(postNowBtn);

  const actions = el("div", "row-gap");
  const insertBtn = el("button", "btn sm", "Insert into comment box →");
  insertBtn.style.flex = "1";
  insertBtn.addEventListener("click", async () => {
    if (!ta.value.trim()) return toast("Write the comment first");
    const tab = await activeTab();
    await ensureContent(tab);
    const r = await sendToTab(tab.id, { type: "INSERT_COMMENT", text: ta.value, shortcode: post.shortcode });
    // Insert logs nothing, exactly like "Insert into DM" — logging is the
    // separate deliberate click below.
    if (r && r.ok) toast("Inserted — read it back, then press Post");
    else toast(commentErr(r));
  });
  const logBtn = el("button", "btn ghost sm", "✓ Log comment");
  logBtn.style.flex = "1";
  logBtn.addEventListener("click", async () => {
    if (!ta.value.trim()) return toast("Nothing to log");
    const c = await canSend("comment");
    if (!c.ok) return toast(`Comment limit reached (${COMMENT_LIMITS.DAILY}/day, ${COMMENT_LIMITS.MONTHLY}/mo)`);
    await logComment(post, ta.value);
    await draft.clear();
    refreshCurrent();
  });
  actions.append(insertBtn, logBtn);
  box.append(actions);
  box.append(el("p", "fine warn",
    "A comment is public and attached to your name. Insert → read it back → press Post."));
  return box;
}

async function renderPostCard(body, tab) {
  const r = await sendToTab(tab.id, { type: "GET_POST" });
  const post = r && r.ok ? r.post : null;
  if (!post || !post.author) {
    body.append(el("div", "empty",
      "On a post, but couldn’t tell whose it is.<br/>Open the author’s profile from the post header to capture them."));
    return;
  }
  const card = el("div", "card");
  const head = el("div", "row-between");
  head.append(el("div", "", `<div class="n">Post by @${esc(post.author.username)}</div>` +
    `<div class="muted">${esc(post.kind === "p" ? "post" : post.kind)} · ${esc(post.shortcode)}</div>`));
  card.append(head);

  if (post.isOwnPost) {
    card.append(el("p", "fine warn", "This is your own post."));
    body.append(card);
    return;
  }

  const row = el("div", "row-gap");
  const openBtn = el("button", "btn ghost sm", `Open @${esc(post.author.username)}'s profile`);
  openBtn.addEventListener("click", () => chrome.tabs.create({ url: `https://www.instagram.com/${post.author.username}/` }));
  row.append(openBtn);
  if (!(await hasProspect(post.author.username))) {
    const capBtn = el("button", "btn ghost sm", `＋ Capture @${esc(post.author.username)}`);
    capBtn.addEventListener("click", async () => {
      const seed = {
        platform: "instagram", username: post.author.username, userId: post.author.userId || null,
        displayName: post.author.displayName || post.author.username,
        profileUrl: `https://www.instagram.com/${post.author.username}/`,
        sourceType: "post", sourceUrl: post.postUrl,
        status: "Captured", capturedAt: new Date().toISOString(),
        ...(await sourceStamp()),
      };
      const s = computeScore(seed, await getICP());
      const rec = await saveProspect({ ...seed, score: s.score, band: s.band, reasons: s.reasons });
      toast("Captured"); refreshCurrent(); renderQueue();
    });
    row.append(capBtn);
  }
  card.append(row);
  body.append(card);
  body.append(makeCommentBox(post));
}

// ---------- QUEUE tab ----------
function refKey(p) { return p.userId ? `id:${p.userId}` : `h:${(p.username || "").toLowerCase()}`; }

// The stored record this profile would merge onto, or null. Mirrors store.js's
// findExistingKey — user id first, handle second — rather than indexing by
// refKey(), so a prospect whose @handle changed still resolves to their record.
function storedFor(all, p) {
  const id = p.userId ? String(p.userId) : null;
  const uname = (p.username || "").toLowerCase();
  let byName = null;
  for (const k in all) {
    const r = all[k];
    if (id && r.userId && String(r.userId) === id) return r;
    if (!byName && uname && (r.username || "").toLowerCase() === uname) byName = r;
  }
  return byName;
}

// ---------- grid outliers ----------
// Research surface only: which of this account's posts got unusual reach FOR
// THEM. It never touches computeScore — reach is not ICP fit, and folding it in
// would silently re-rank everyone's queue.
function buildOutlierBlock(gridPosts) {
  const g = analyzeGrid(gridPosts);
  const wrap = el("div");
  wrap.append(el("div", "muted",
    `Recent grid · ${g.sample} post${g.sample === 1 ? "" : "s"}${g.windowDays ? ` · last ${g.windowDays}d` : ""}`));

  if (g.outliers.length) {
    const chips = el("div", "chips");
    for (const o of g.outliers) {
      const label = `${o.kind === "video" ? "▶" : "▦"} ${fmtNum(o.value)} ${o.metric === "plays" ? "views" : "likes"}` +
        ` · ${o.ratio}× their median${o.ageDays != null ? ` · ${o.ageDays}d ago` : ""}`;
      const b = el("button", "chip outlier", esc(label));
      b.title = "Open the post in a new tab";
      // New tab, not tabs.update like the queue's Open button — don't throw away
      // the profile the user is in the middle of evaluating.
      b.addEventListener("click", () => chrome.tabs.create({ url: o.url }));
      chips.append(b);
    }
    wrap.append(chips);
  }
  wrap.append(el("p", "fine", esc(g.note)));

  // The mixed-grid trap, said out loud. Video and image posts are measured in
  // separate buckets and each needs MIN_SAMPLE before analyzeGrid will speak, so
  // a creator with 4 reels among 12 tiles gets a verdict computed entirely from
  // their photos — which reads as "nothing stands out" about the reels when in
  // fact the reels were never looked at. Enrich avoids this by loading the Reels
  // tab; someone standing on the main grid has to be told.
  const reelsSeen = gridPosts.filter((p) => p.isVideo).length;
  if (gridKind(gridPosts) !== "reels" && reelsSeen < OUTLIER_TUNING.MIN_SAMPLE) {
    wrap.append(el("p", "fine warn",
      `Only ${reelsSeen} reel${reelsSeen === 1 ? "" : "s"} on this grid — too few to compare, so `
      + `nothing above is about their reels. Open this account's <b>Reels</b> tab for a `
      + `reels-only read, or Enrich them, which does it for you.`));
  }
  return wrap;
}

// gridPosts is 12 objects (~2KB) of raw scrape output. It's the INPUT to the
// analysis, never something to persist — every prospect write rewrites the whole
// prospects blob, so a few thousand leads would carry megabytes of it for
// nothing. Only outlierPatch()'s summary is stored.
function stripGrid(profile) {
  if (!profile || !profile.gridPosts) return profile;
  const { gridPosts, ...rest } = profile;
  return rest;
}

// Which grid did the sample come from? On /{handle}/reels/ every tile is a reel,
// so the whole sample is measured on plays against a reels-only median — a
// cleaner comparison than the mixed main grid, and the one the "Top performing
// reels" panel actually claims to show.
function gridKind(gridPosts) {
  return gridPosts.every((p) => p.kind === "reel") ? "reels" : "mixed";
}

// Compact patch persisted onto a prospect. Flat scalars are the export/sort
// surface (csvValue renders arrays-of-objects as "[object Object]"); the nested
// object is the UI surface.
//
// `stored` is the record this will be merged onto, when there is one. It is read
// for one rule only: PREFER REELS. A reels-only sample beat a reels-only median,
// so a later mixed-grid pass must not quietly replace it with a weaker answer —
// it may only overwrite when it, too, found something.
function outlierPatch(profile, stored = null) {
  if (!profile || !profile.gridPosts || !profile.gridPosts.length) return {};
  const g = analyzeGrid(profile.gridPosts);
  const grid = gridKind(profile.gridPosts);
  if (grid !== "reels"
      && stored && stored.outliers && stored.outliers.grid === "reels"
      && !g.outliers.length) {
    return {};
  }
  const at = new Date().toISOString();
  const top = g.outliers.slice(0, 2).map((o) => ({
    c: o.shortcode, k: o.kind === "video" ? "v" : "i", m: o.metric,
    v: o.value, b: o.baseline, r: o.ratio, a: o.ageDays,
  }));
  // Newest post we could date, for the "gone stale" cleanup. Only set when the
  // grid actually yielded dates — `takenAt` is parsed out of an ENGLISH date in
  // img[alt] and is simply absent on a non-English Instagram. Writing a null or a
  // fallback here would make "we couldn't read the dates" indistinguishable from
  // "this account hasn't posted in a year", and the cleanup would then propose
  // deleting perfectly active leads. Absent means absent, and cullCandidates
  // skips anyone without it.
  const stamps = profile.gridPosts
    .map((p) => p.takenAt)
    .filter((t) => typeof t === "number" && t > 0);
  const patch = {
    outliers: { at, n: g.sample, basis: g.basis, windowDays: g.windowDays, grid, top },
    outlierCount: top.length,
    outlierTopRatio: top.length ? top[0].r : null,
    outlierTopUrl: g.outliers.length ? g.outliers[0].url : null,
    outlierCheckedAt: at,
  };
  if (stamps.length) patch.lastPostAt = new Date(Math.max(...stamps)).toISOString();
  return patch;
}

// The capture-time patch. Same summary, but POSITIVE VERDICTS ONLY — see
// shouldPersistFromCapture() in shared/outliers.js for why a "nothing stands out"
// read off the user's own SPA-navigated tab must never be written down.
function capturePatch(profile, stored = null) {
  if (!profile || !profile.gridPosts || !profile.gridPosts.length) return {};
  if (!shouldPersistFromCapture(analyzeGrid(profile.gridPosts))) return {};
  return outlierPatch(profile, stored);
}

// Recompute every prospect's fit against the CURRENT ICP and persist — fixes
// the "35 across / never updates" bug (scores used to be frozen at capture).
// Rewrites EVERY record, so it is the most destructive writer in the panel — and
// it used to call chrome.storage.local.set directly, outside the store's lock.
// A recording session committing 380 handles while this was mid-flight lost all
// 380 and still reported success. replaceProspects() puts it in the same queue as
// every other writer.
async function rescoreAll() {
  const icp = await getICP();
  await replaceProspects((prospects) => {
    for (const k of Object.keys(prospects)) {
      const s = computeScore(prospects[k], icp);
      prospects[k].score = s.score; prospects[k].band = s.band; prospects[k].reasons = s.reasons;
      // recentMedia was persisted accidentally (spread from the extractor), was in
      // no schema list, and held unlabeled duplicate numbers. gridPosts replaced
      // it; drop the stale field here since this already rewrites every record.
      if (prospects[k].recentMedia) delete prospects[k].recentMedia;
    }
    return prospects;
  });
}

// Queue and Shortlist each keep their OWN selection. One shared Set would mean
// ticking three handles in the Queue and switching tabs silently armed "Confirm &
// Send selected (3)" against people who were never on the shortlist — the exact
// mistake the two-stage funnel exists to prevent.
let lastQueueKeys = [];
let lastSlKeys = [];
const slSelected = new Set();
// How many rows to build at once (see renderQueue for why this is capped).
const QUEUE_PAGE = 200;
let queueLimit = QUEUE_PAGE;
let slLimit = QUEUE_PAGE;
let slGen = 0;

// ---------- numeric filters: posts, followers, following ----------
//
// Explicit lower and upper bounds per field, not preset buckets. Buckets were the
// first version and they were wrong for this job: prospecting criteria are
// personal and they move ("2k–20k followers, at least 30 posts, follows under
// 1500"), and no set of four fixed ranges expresses that. Either bound can be left
// empty, so "min only", "max only" and "both" all work without a mode selector.
//
// Bounds are INCLUSIVE at both ends. A range written as 1000–5000 should contain
// 1000 and 5000 — half-open would be defensible for tiling buckets and is just
// surprising for a range someone typed.
//
// One shared "include not-yet-enriched" switch rather than an "unknown" option per
// field. A scanned handle has no counts until Enrich has opened it, and null is not
// zero: silently dropping those leads would make the queue look empty right after
// a scan, which is exactly when it is fullest. Default is OFF, because when you are
// filtering on a number you almost always mean "leads I know this about".
const NUM_FIELDS = [
  { field: "posts", label: "Posts", title: "Post count. Under ~10 usually means a new, dormant or placeholder account." },
  { field: "followers", label: "Followers", title: "Audience size. Accepts 2k, 1.5m." },
  { field: "following", label: "Following", title: "How many accounts they follow. Thousands against a small audience is the follow-for-follow pattern." },
];

// "2k" / "1.5m" / "12,000" -> number. Followers are written this way everywhere on
// Instagram, so requiring 15000 instead of 15k would be a small tax on every use.
function parseBound(raw) {
  const t = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[, _]/g, "");
  if (!t) return null;
  const m = t.match(/^([0-9]*\.?[0-9]+)([km])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
}

function numMatch(p, field, min, max, includeUnknown) {
  if (min == null && max == null) return true;   // no bound set — field is inactive
  const raw = p[field];
  const n = raw == null || raw === "" ? null : Number(raw);
  if (n == null) return !!includeUnknown;
  if (min != null && n < min) return false;
  if (max != null && n > max) return false;
  return true;
}

// ---------- outlier filtering ----------
//
// An account whose recent posts beat its OWN median is on the way up, and that is
// a better prospect than a bigger but flat audience. The ratio is per-account, so
// it is not a follower-count proxy — a 2k account can outrank a 200k one.
//
// `unchecked` is a first-class answer, not an error: outliers are only computed
// during Enrich (each one costs a background tab), so a freshly scanned handle
// legitimately has no verdict. Conflating "no outliers" with "never looked" would
// hide the accounts most worth enriching next.

// The account's best recent post, as a ratio — 0 when there wasn't one.
// outlierCount is the single source of truth for "did this account have any".
// The flat outlierTopRatio / outlierTopUrl can be STALE: mergeEnrichment drops
// null values field-by-field, so a later "nothing stands out" writes
// outlierCount: 0 while leaving a previous run's ratio and URL in place. Every
// read below is gated on the count so that leftover can never resurrect a chip,
// a row, or a filter match.
function topRatio(p) {
  return (p.outlierCount || 0) ? Number(p.outlierTopRatio) || 0 : 0;
}
function topUrl(p) {
  return (p.outlierCount || 0) ? p.outlierTopUrl || "" : "";
}
function outlierMatch(p, mode) {
  const checked = !!p.outlierCheckedAt;
  const count = p.outlierCount || 0;
  const ratio = topRatio(p);
  switch (mode) {
    case "has": return checked && count > 0;
    case "3x": return checked && ratio >= 3;
    case "none": return checked && count === 0;
    case "unchecked": return !checked;
    default: return true;
  }
}

const SORTS = {
  // Unscored ("needs enrich") sinks rather than sorting as 0, so an un-enriched
  // lead never displaces a scored one at the top of the list.
  score: (a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score),
  outlier: (a, b) => topRatio(b) - topRatio(a),
  followers: (a, b) => (b.followers == null ? -1 : b.followers) - (a.followers == null ? -1 : a.followers),
  following: (a, b) => (b.following == null ? -1 : b.following) - (a.following == null ? -1 : a.following),
  posts: (a, b) => (b.posts == null ? -1 : b.posts) - (a.posts == null ? -1 : a.posts),
  recent: (a, b) => new Date(b.shortlistedAt || b.capturedAt || 0) - new Date(a.shortlistedAt || a.capturedAt || 0),
};
const SORT_OPTS = [
  ["score", "by fit score"],
  ["outlier", "by outlier strength"],
  ["followers", "by followers"],
  ["following", "by following"],
  ["posts", "by post count"],
  ["recent", "most recently added"],
];

// One place both lists go through, so a filter added here appears on both and
// cannot behave differently between them.
function applyView(list, o = {}) {
  const out = list.filter((p) =>
    outlierMatch(p, o.outlier || "all")
    && NUM_FIELDS.every(({ field }) => {
      const b = o[field] || {};
      return numMatch(p, field, b.min, b.max, o.includeUnknown);
    }));
  out.sort(SORTS[o.sort] || SORTS.score);
  return out;
}

// Build a tab's filter row. `prefix` is "q" (Queue) or "sl" (Shortlist); ids come
// out as q-outlier, q-posts-min, q-posts-max, …, q-unknown, q-sort.
function buildFilterRow(prefix, onChange) {
  const host = $("#" + prefix + "-filters");
  if (!host || host.dataset.built) return;

  const sel = (id, label, title, opts) => {
    const wrap = el("label", "fine", esc(label) + " ");
    const e = el("select", "inline");
    e.id = prefix + "-" + id;
    if (title) e.title = title;
    for (const [v, t] of opts) {
      const o = el("option"); o.value = v; o.textContent = t; e.appendChild(o);
    }
    e.addEventListener("change", onChange);
    wrap.append(e);
    host.append(wrap);
  };

  sel("outlier", "Reels", "How far their best recent post beat their own median.", [
    ["all", "any"], ["has", "outperforming"], ["3x", "3×+ their median"],
    ["none", "no outliers"], ["unchecked", "not checked yet"],
  ]);

  for (const f of NUM_FIELDS) {
    const wrap = el("label", "fine", esc(f.label) + " ");
    wrap.title = f.title;
    for (const which of ["min", "max"]) {
      const inp = el("input", "filt-num");
      inp.id = `${prefix}-${f.field}-${which}`;
      inp.type = "text";              // text, not number: "2k" must be typeable
      inp.inputMode = "numeric";
      inp.placeholder = which;
      inp.autocomplete = "off";
      // `input`, not `change`: a filter that only applies when the field loses
      // focus feels broken. Debounced so a four-keystroke number is one render.
      let t = null;
      inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(onChange, 250); });
      if (which === "max") wrap.append(el("span", "muted", "–"));
      wrap.append(inp);
    }
    host.append(wrap);
  }

  const unk = el("label", "fine switch-inline");
  const cb = el("input");
  cb.type = "checkbox";
  cb.id = prefix + "-unknown";
  cb.title = "Counts are only known after Enrich. Off means a bound excludes leads you haven't enriched.";
  cb.addEventListener("change", onChange);
  unk.append(cb, el("span", "", "incl. un-enriched"));
  host.append(unk);

  sel("sort", "Sort", "", SORT_OPTS);
  host.dataset.built = "1";
}

// Reads a tab's filter row. A missing element reads as "no bound", so a render
// that happens before the row is built returns everything rather than nothing.
function viewOpts(prefix) {
  const val = (id) => { const e = $("#" + prefix + "-" + id); return e ? e.value : ""; };
  const o = {
    outlier: val("outlier") || "all",
    sort: val("sort") || "score",
    includeUnknown: !!($("#" + prefix + "-unknown") || {}).checked,
  };
  for (const { field } of NUM_FIELDS) {
    o[field] = { min: parseBound(val(field + "-min")), max: parseBound(val(field + "-max")) };
  }
  return o;
}

// Is anything actually being filtered on? Sort is not a filter, and neither is
// "incl. un-enriched" on its own. Used to stay quiet after a harvest when the
// row is empty — "380 of 380 match your filters" is noise, not information.
function hasActiveFilters(o) {
  if ((o.outlier || "all") !== "all") return true;
  return NUM_FIELDS.some(({ field }) => {
    const b = o[field] || {};
    return b.min != null || b.max != null;
  });
}

// Describe the active bounds in words, for the cull's confirm dialog. Deleting
// leads against criteria the user can't see restated is how you delete the wrong
// ones.
function describeFilters(o) {
  const parts = [];
  if ((o.outlier || "all") !== "all") {
    const label = { has: "outperforming", "3x": "3×+ their median", none: "no outliers", unchecked: "not checked yet" };
    parts.push(`Reels: ${label[o.outlier] || o.outlier}`);
  }
  for (const { field, label } of NUM_FIELDS) {
    const b = o[field] || {};
    if (b.min == null && b.max == null) continue;
    if (b.min != null && b.max != null) parts.push(`${label} ${fmtNum(b.min)}–${fmtNum(b.max)}`);
    else if (b.min != null) parts.push(`${label} ${fmtNum(b.min)}+`);
    else parts.push(`${label} up to ${fmtNum(b.max)}`);
  }
  return parts.join(" · ");
}

// ---------- one row builder for both lists ----------
//
// Queue and Shortlist rows differ only in their action buttons. Duplicating the
// ~40 lines that build the score chip, the detail line and the outlier affordance
// would guarantee they drift.
function prospectRow(p, { selection, onChange, actions, marks = [], note = "" }) {
  const item = el("div", "q-item");
  const chk = el("input", "q-check");
  chk.type = "checkbox";
  chk.checked = selection.has(refKey(p));
  chk.addEventListener("change", () => {
    if (chk.checked) selection.add(refKey(p)); else selection.delete(refKey(p));
    onChange();
  });
  item.append(chk);

  // State marks (Pipeline): ★ vetted, ☑ messaged. These replace the tab you used
  // to have to be looking at in order to know either fact.
  if (marks.length) {
    const mk = el("div", "q-marks");
    for (const m of marks) {
      const s = el("span", "q-mark " + m.cls, m.txt);
      s.title = m.title;
      mk.append(s);
    }
    item.append(mk);
  }

  const scoreTxt = p.score == null ? "—" : String(p.score);
  const sc = el("div", `q-score ${p.score != null && p.score >= 75 ? "high" : ""}`, scoreTxt);
  if (p.score == null) sc.title = "Needs enrich — no bio captured";

  const main = el("div", "q-main");
  const details = [
    p.displayName && p.displayName !== p.username ? p.displayName : "",
    p.accountType && p.accountType !== "personal" ? p.accountType : "",
    p.category || "",
    p.followers != null ? fmtNum(p.followers) + " followers" : "",
    p.posts != null ? fmtNum(p.posts) + " posts" : "",
    p.following != null ? "follows " + fmtNum(p.following) : "",
    p.band === "Needs enrich" ? "needs enrich" : "",
    p.sourceType === "recording" ? "recorded" : "",
    p.outlierCount ? `⚡ ${topRatio(p)}× outlier` : "",
    p.isPrivate ? "🔒 private" : "",
  ].filter(Boolean).join(" · ");
  const contactMark = p.linkInBio || (p.emails && p.emails.length) ? " ✉︎" : "";
  main.innerHTML = `<div class="n">@${esc(p.username)}${esc(contactMark)}</div><div class="muted">${esc(details)}</div>`
    + (note ? `<div class="muted q-note">${esc(note)}</div>` : "");

  const act = el("div", "q-actions");
  const openBtn = el("button", "icon-btn", "Open");
  openBtn.title = "Open this profile in the current tab";
  openBtn.addEventListener("click", async () => {
    const tab = await activeTab();
    chrome.tabs.update(tab.id, { url: p.profileUrl });
  });
  if (topUrl(p)) {
    const watch = el("button", "icon-btn", "▶");
    watch.title = `Top post · ${topRatio(p)}× their median — open it`;
    watch.addEventListener("click", () => chrome.tabs.create({ url: topUrl(p) }));
    act.append(watch);
  }
  act.append(openBtn);
  for (const b of actions(p, item)) act.append(b);
  item.append(sc, main, act);
  return item;
}
// ---------- QUEUE — captured, nobody has looked yet ----------
//
// The bulk action here is PROMOTION, not outreach: no draft box and no batch send,
// because you should not be able to message someone no human has assessed. That is
// the whole reason the Shortlist exists.
async function renderQueue() {
  const gen = ++queueGen;
  const list = $("#queue-list");
  const icp = await getICP();
  const all = Object.values(await getProspects()).map((p) => ({ ...p, ...computeScore(p, icp) }));
  if (gen !== queueGen) return; // a newer render started while we were reading storage

  const queued = all.filter((p) => isQueued(p) && !isContacted(p));
  const view = applyView(queued, viewOpts("q"));

  // Selection spans the whole FILTERED view, not the rendered page, so "select
  // all" still works on an imported list of thousands — but it can never select
  // something the filter is hiding, which would be invisible and surprising.
  lastQueueKeys = view.map(refKey);
  const hidden = queued.length - view.length;
  $("#queue-count").textContent = `${view.length} in queue`
    + (hidden ? ` · ${hidden} hidden by filter` : "");
  list.innerHTML = "";
  await updateQueueBar();

  if (!view.length) {
    list.append(el("div", "empty", queued.length
      ? "Nothing matches this filter.<br/>Outliers are only measured when a profile is opened — captured or enriched — so try “not checked yet”."
      : "Nothing in the queue.<br/>Capture from a profile, or “Scan page” on a followers / explore list."));
    $("#queue-more").hidden = true;
    return;
  }

  // Render a page at a time. Each row costs ~10 elements and 4 listeners, so a
  // CSV import of a few thousand leads would otherwise build tens of thousands of
  // nodes on every render and lock up the side panel.
  const shown = view.slice(0, queueLimit);
  for (const p of shown) {
    list.append(prospectRow(p, {
      selection: selected,
      onChange: updateQueueBar,
      actions: (pr) => {
        // ★ promotes into the Pipeline. Icon rather than a worded button because
        // it is the single most-repeated action in the product — but it keeps the
        // full explanation in its tooltip, and it stays DISABLED (not silently
        // inert) for a private account. PUBLIC_ONLY_NOTE in store.js.
        const add = el("button", "icon-btn star", "★");
        add.title = pr.isPrivate
          ? "Private account — can't be shortlisted"
          : "Shortlist — vet it into the Pipeline, ready to message";
        add.disabled = !!pr.isPrivate;
        add.addEventListener("click", async () => {
          await shortlistOne(pr);
          renderQueue(); renderPipeline();
        });
        const rm = el("button", "icon-btn danger", "✕");
        rm.addEventListener("click", async () => {
          selected.delete(refKey(pr));
          await removeProspect(pr);
          renderQueue();
        });
        return [add, rm];
      },
    }));
  }

  const more = $("#queue-more");
  if (view.length > shown.length) {
    more.hidden = false;
    more.textContent = `Show ${Math.min(QUEUE_PAGE, view.length - shown.length)} more (${shown.length} of ${view.length})`;
    more.onclick = () => { queueLimit += QUEUE_PAGE; renderQueue(); };
  } else {
    more.hidden = true;
  }
}

// ---------- PIPELINE — vetted, messaged, and what happened next ----------
//
// Shortlist, Outreach and Metrics were three tabs over the same people at three
// moments. One list now, with the state on the ROW (★ vetted, ☑ messaged, plus a
// read chip) and the counts in one strip that doubles as the segment filter.
//
// The segments are ordered by what you act on: who you still owe a message, then
// who hasn't opened it, then who opened it and said nothing (the follow-up bucket
// the product exists for), then who replied.
const PL_SEGMENTS = [
  { id: "todo", icon: "★", label: "to message", hint: "Vetted by you, not messaged yet" },
  { id: "await", icon: "✉", label: "awaiting read", hint: "Sent, no read detected yet" },
  { id: "read", icon: "👁", label: "read · no reply", hint: "They opened it and said nothing — your best follow-ups" },
  { id: "replied", icon: "↩", label: "replied", hint: "They wrote back" },
];
let plSegment = "todo";

// Pure split of the post-send population. DMs only: a comment has no read receipt
// and no reply mechanic, so a comment-only prospect would sit in "awaiting read"
// forever and every bucket here would be a lie about them.
function splitOutreach(all) {
  const hasDm = (p) => (p.outreach || []).some((e) => (e.channel || "dm") === "dm");
  const sent = all.filter((p) => p.outreach && p.outreach.length && hasDm(p));
  const when = (p) => p.lastDmAt || p.lastContactedAt || 0;
  const replied = sent.filter((p) => !isOpen(p) || p.repliedAt)
    .sort((a, b) => new Date(b.repliedAt || when(b)) - new Date(a.repliedAt || when(a)));
  const open = sent.filter((p) => isOpen(p) && !p.repliedAt);
  const read = open.filter((p) => p.seenAt).sort((a, b) => new Date(a.followUpAt || 0) - new Date(b.followUpAt || 0));
  const awaiting = open.filter((p) => !p.seenAt).sort((a, b) => new Date(when(b)) - new Date(when(a)));
  return { awaiting, read, replied };
}

async function renderPipeline() {
  const gen = ++slGen;
  const list = $("#pipeline-list");
  if (!list) return;
  const icp = await getICP();
  const all = Object.values(await getProspects()).map((p) => ({ ...p, ...computeScore(p, icp) }));
  if (gen !== slGen) return; // a newer render started while we were reading storage

  const todo = all.filter((p) => isShortlisted(p) && !isContacted(p));
  const { awaiting, read, replied } = splitOutreach(all);
  const buckets = { todo, await: awaiting, read, replied };

  renderStatStrip(buckets);
  updatePipelineBadge(read.length);
  // Re-check the generation after EVERY await, not just the first. Segment chips
  // are un-debounced buttons and every row action re-renders, so two renders
  // overlap easily — and without these checks both pass the initial guard, both
  // reach `list.innerHTML = ""` below, and the loser appends its rows (possibly
  // from a different segment) underneath the winner's. Same pattern as
  // refreshCurrent().
  await renderOutlierPosts(all);
  if (gen !== slGen) return;
  await renderSent();
  if (gen !== slGen) return;
  await renderMetrics();
  if (gen !== slGen) return;

  const base = buckets[plSegment] || todo;
  const view = applyView(base, viewOpts("sl"));

  // Selection spans the whole FILTERED view, not the rendered page — but it can
  // never select something the filter is hiding, which would be invisible.
  lastSlKeys = view.map(refKey);
  const hidden = base.length - view.length;
  const seg = PL_SEGMENTS.find((s) => s.id === plSegment);
  $("#pl-count").textContent = base.length
    ? `${view.length} ${seg.label}` + (hidden ? ` · ${hidden} hidden by filter` : "")
    : `Nothing ${seg.label}`;
  $("#pl-blurb").textContent = seg.hint;

  // The batch bar's visibility has ONE owner — updateBatchBar() — because it is
  // gated on two independent things (the opt-in AND the segment) and a second
  // writer here would race it depending on call order.
  $("#sl-unshortlist").style.display = plSegment === "todo" ? "" : "none";
  await updateBatchBar();
  if (gen !== slGen) return;
  // Clear only AFTER the last await, so a render that is about to be superseded
  // never blanks the list the winner has already filled.
  list.innerHTML = "";

  if (!view.length) {
    list.append(el("div", "empty", base.length
      ? "Nothing matches this filter."
      : plSegment === "todo"
        ? "Nothing shortlisted yet.<br/>Work down the <b>Queue</b> and press <b>★</b> on the ones worth a message."
        : "Nobody here yet."));
    $("#sl-more").hidden = true;
    return;
  }

  const shown = view.slice(0, slLimit);
  for (const p of shown) list.append(pipelineRow(p, plSegment));

  const more = $("#sl-more");
  if (view.length > shown.length) {
    more.hidden = false;
    more.textContent = `Show ${Math.min(QUEUE_PAGE, view.length - shown.length)} more (${shown.length} of ${view.length})`;
    more.onclick = () => { slLimit += QUEUE_PAGE; renderPipeline(); };
  } else {
    more.hidden = true;
  }
}

// The stat strip. Icon + number, and an em-dash when the bucket is empty — a row
// of zeroes reads as failure, a dash reads as "not yet". Each chip is also the
// segment filter, so the number you are looking at is the list you get.
function renderStatStrip(buckets) {
  const strip = $("#pl-stats");
  if (!strip) return;
  strip.innerHTML = "";
  for (const seg of PL_SEGMENTS) {
    const n = (buckets[seg.id] || []).length;
    const chip = el("button", "pl-stat" + (plSegment === seg.id ? " is-active" : "") + (n ? "" : " is-empty"));
    chip.title = seg.hint;
    chip.innerHTML = `<span class="pl-ico">${seg.icon}</span><b>${n || "—"}</b><span>${esc(seg.label)}</span>`;
    chip.addEventListener("click", () => {
      plSegment = seg.id;
      slLimit = QUEUE_PAGE;
      slSelected.clear();
      renderPipeline();
    });
    strip.append(chip);
  }
}

// One row, whatever segment it is in. The marks carry the state that used to be
// carried by which tab you were looking at: ★ vetted, ☑ messaged.
function pipelineRow(p, segment) {
  const messaged = segment !== "todo";
  const row = prospectRow(p, {
    selection: slSelected,
    onChange: updateBatchBar,
    marks: [
      // Data-derived, not segment-derived: `shortlistedAt` is stamped by
      // shortlistOne/shortlistSelected and by nothing else. A lead you DMed
      // straight from the Profile tab was never vetted, and must not wear a
      // vetted mark just because it is now in a post-send segment.
      p.shortlistedAt
        ? { cls: "mk-star is-on", txt: "★", title: "Vetted by you" }
        : { cls: "mk-star", txt: "☆", title: "Messaged without being shortlisted" },
      messaged
        ? { cls: "mk-sent is-on", txt: "☑", title: "Message sent" }
        : { cls: "mk-sent", txt: "☐", title: "Not messaged yet" },
    ],
    note: messaged ? outreachNote(p, segment) : "",
    actions: (pr, item) => {
      const draftBtn = el("button", "icon-btn", segment === "read" ? "Follow up" : "Draft");
      draftBtn.title = segment === "read"
        ? "Write a follow-up — they opened it and said nothing"
        : "Write the message, then insert it into Instagram's composer";
      draftBtn.addEventListener("click", () => {
        const existing = item.nextSibling;
        if (existing && existing.__draftFor === refKey(pr)) { existing.remove(); return; }
        const box = makeDraftBox(pr, segment === "read" ? { preferTemplateId: "t_followup" } : {});
        box.__draftFor = refKey(pr);
        item.after(box);
      });
      const btns = [draftBtn];

      if (segment === "todo") {
        const back = el("button", "icon-btn", "←");
        back.title = "Back to the Queue";
        back.addEventListener("click", async () => {
          slSelected.delete(refKey(pr));
          await updateProspect(pr, { status: STAGE.QUEUE, shortlistedAt: null });
          renderPipeline(); renderQueue();
        });
        btns.push(back);
      }
      if (segment === "await") {
        const seenBtn = el("button", "icon-btn", "👁");
        seenBtn.title = "Mark as seen (they read it)";
        seenBtn.addEventListener("click", async () => { await markSeen(pr); toast("Marked seen"); renderPipeline(); });
        btns.push(seenBtn);
      }
      if (segment === "await" || segment === "read") {
        const repliedBtn = el("button", "icon-btn", "✓");
        repliedBtn.title = "Mark as replied";
        repliedBtn.addEventListener("click", async () => { await setOutcome(pr, "Replied"); toast("Marked replied"); renderPipeline(); });
        btns.push(repliedBtn);
      }
      if (segment === "read") {
        const snoozeBtn = el("button", "icon-btn", "💤");
        snoozeBtn.title = "Snooze 3 days";
        snoozeBtn.addEventListener("click", async () => { await snoozeFollowUp(pr, 3); toast("Snoozed 3 days"); renderPipeline(); });
        btns.push(snoozeBtn);
      }
      const rm = el("button", "icon-btn danger", "✕");
      rm.addEventListener("click", async () => {
        slSelected.delete(refKey(pr));
        await removeProspect(pr);
        renderPipeline();
      });
      btns.push(rm);
      return btns;
    },
  });
  return row;
}

// ---------- cleanup: review, then remove ----------
//
// Deliberately a REVIEW, not a sweep. It proposes, shows you exactly who and why,
// and removes only what is still ticked. A prospect list is the one thing in here
// that cannot be re-derived — a wrong bulk delete is unrecoverable without a CSV.
async function openCull() {
  const all = Object.values(await getProspects());
  const { quiet, stale } = cullCandidates(all);
  const box = $("#pl-cull-box");
  box.innerHTML = "";
  box.hidden = false;

  if (!quiet.length && !stale.length) {
    box.append(el("div", "muted", "Nothing to clean up — no lead has gone quiet or stale yet."));
    const close = el("button", "btn ghost sm", "Close");
    close.addEventListener("click", () => { box.hidden = true; });
    box.append(close);
    return;
  }

  const picked = new Set();
  const section = (title, why, rows) => {
    if (!rows.length) return;
    box.append(el("div", "cull-head", `${title} (${rows.length})`));
    box.append(el("p", "fine", why));
    for (const p of rows) {
      const line = el("label", "switch-row");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
      picked.add(refKey(p));
      cb.addEventListener("change", () => {
        if (cb.checked) picked.add(refKey(p)); else picked.delete(refKey(p));
        $("#pl-cull-go").textContent = `Remove ${picked.size} selected`;
      });
      line.append(cb, el("span", "", `@${esc(p.username)} — ${esc(p.why)}`));
      box.append(line);
    }
  };
  section("Gone quiet", "Messaged, never replied, and past the point where a reply is likely. Removing them deletes their message history too — export first if you want it.", quiet);
  section("Stale accounts", "The account itself has stopped posting. These are worth dropping before you spend a message on them. Only shown where a post date could actually be read.", stale);

  const go = el("button", "btn danger sm", `Remove ${picked.size} selected`);
  go.id = "pl-cull-go";
  go.addEventListener("click", async () => {
    if (!picked.size) return toast("Nothing ticked");
    if (!confirm(`Permanently remove ${picked.size} lead${picked.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    const map = await getProspects();
    for (const k of picked) {
      const p = Object.values(map).find((v) => refKey(v) === k);
      if (p) await removeProspect(p);
    }
    toast(`Removed ${picked.size}`);
    box.hidden = true;
    renderPipeline(); renderQueue();
  });
  const close = el("button", "btn ghost sm", "Cancel");
  close.addEventListener("click", () => { box.hidden = true; });
  box.append(el("div", "row-gap", ""), go, close);
}

function outreachNote(p, segment) {
  const src = p.lastSourceHandle ? " · from @" + p.lastSourceHandle : "";
  if (segment === "replied") return "replied " + relDay(p.repliedAt) + src;
  if (segment === "read") return "seen " + relDay(p.seenAt) + (p.followUpAt ? " · follow up " + relDay(p.followUpAt) : "") + src;
  return "sent " + relDay(p.lastContactedAt) + src;
}

// Promote one lead. Refuses private accounts — PUBLIC_ONLY_NOTE in store.js.
async function shortlistOne(p) {
  if (failsPublicFilter(p)) { toast(`@${p.username} is private — public accounts only`); return false; }
  await updateProspect(p, { status: STAGE.SHORTLIST, shortlistedAt: new Date().toISOString() });
  return true;
}

async function shortlistSelected() {
  const all = Object.values(await getProspects());
  const picks = all.filter((p) => selected.has(refKey(p)));
  if (!picks.length) return toast("Tick some handles first");
  let moved = 0, priv = 0;
  for (const p of picks) {
    if (failsPublicFilter(p)) { priv++; continue; }
    await updateProspect(p, { status: STAGE.SHORTLIST, shortlistedAt: new Date().toISOString() });
    selected.delete(refKey(p));
    moved++;
  }
  toast(`Shortlisted ${moved}` + (priv ? `, skipped ${priv} private` : ""));
  renderQueue(); renderPipeline();
}

// ---------- top performing reels, across the shortlist ----------
//
// Separate from the filter, because it answers a different question: the filter
// picks WHO to message, this shows WHAT is working — which is the specific thing
// you reference in the message instead of "love your content".
async function renderOutlierPosts(all) {
  const listEl = $("#sl-outlier-list");
  if (!listEl) return;
  const rows = all
    .filter((p) => isShortlisted(p) && topUrl(p) && topRatio(p) > 0)
    .sort((a, b) => topRatio(b) - topRatio(a))
    .slice(0, 50);
  $("#sl-outlier-count").textContent = String(rows.length);
  listEl.innerHTML = "";
  if (!rows.length) {
    listEl.append(el("div", "empty",
      "No outliers measured yet.<br/>They're read when you <b>capture</b> a profile and re-checked during <b>Enrich</b> — do either on some shortlisted accounts and they'll appear here."));
    return;
  }
  for (const p of rows) {
    const item = el("div", "q-item");
    const ratio = el("div", "q-score high", `${topRatio(p)}×`);
    ratio.title = "How far their best recent post beat their own median";
    const main = el("div", "q-main");
    main.innerHTML = `<div class="n">@${esc(p.username)}</div>`
      + `<div class="muted">${esc(String(p.outlierCount || 1))} outlier post${(p.outlierCount || 1) === 1 ? "" : "s"}`
      + `${p.followers != null ? " · " + esc(fmtNum(p.followers)) + " followers" : ""}</div>`;
    const act = el("div", "q-actions");
    const watch = el("button", "icon-btn", "▶ Watch");
    watch.addEventListener("click", () => chrome.tabs.create({ url: topUrl(p) }));
    act.append(watch);
    item.append(ratio, main, act);
    listEl.append(item);
  }
}

// Queue selection bar. Separate from updateBatchBar(), which serves the Shortlist:
// the Queue has no send control at all, so it has nothing to gate.
async function updateQueueBar() {
  const n = selected.size;
  const sc = $("#sel-count"); if (sc) sc.textContent = `${n} selected`;
  const sb = $("#shortlist-btn");
  if (sb) { sb.textContent = n ? `→ Shortlist selected (${n})` : "→ Shortlist selected"; sb.disabled = !n; }
  const sa = $("#sel-all");
  if (sa) sa.checked = n > 0 && lastQueueKeys.length > 0 && lastQueueKeys.every((k) => selected.has(k));
}

async function updateBatchBar() {
  const tplSel = $("#batch-template");
  if (tplSel && !tplSel.dataset.filled) {
    tplSel.innerHTML = "";
    for (const o of OBJECTIVE_OPTIONS) {
      const opt = el("option"); opt.value = "obj:" + o.value; opt.textContent = "Auto · " + o.label; tplSel.appendChild(opt);
    }
    for (const t of await getTemplates("dm")) {
      const opt = el("option"); opt.value = "tpl:" + t.id; opt.textContent = "Template · " + t.name; tplSel.appendChild(opt);
    }
    tplSel.dataset.filled = "1";
  }
  // Batch send is an auto-send surface, gated on TWO independent things:
  //   1. "Send from this panel" is on — it is opt-in, like the per-draft button.
  //   2. You are on the "to message" segment. Bulk-sending to people already
  //      mid-conversation is a follow-up, which is a per-person decision.
  // Selection itself stays available regardless — it also drives Draft / Back to
  // Queue / Remove. This bar reads slSelected, never `selected`.
  const bar = $("#batch-bar");
  if (bar) bar.style.display = ((await getOneClick()) && plSegment === "todo") ? "" : "none";

  const n = slSelected.size;
  const sb = $("#batch-send"); if (sb) sb.textContent = `Confirm & Send selected (${n})`;
  const sc = $("#sl-sel-count"); if (sc) sc.textContent = `${n} selected`;
  const sa = $("#sl-sel-all");
  if (sa) sa.checked = n > 0 && lastSlKeys.length > 0 && lastSlKeys.every((k) => slSelected.has(k));
}

// How many Explore tiles one scan may resolve. Each costs a paced ~260 KB
// request to the post's own embed page, so this is a real budget, not a guard.
// It is inert off Explore — the content script only spends it there.
const EXPLORE_RESOLVE = 12;

// Turn a keyword or #tag into the Explore search URL. A leading # needs no
// special case: /explore/tags/<tag>/ redirects to exactly this with q=%23<tag>.
function exploreSearchUrl(raw) {
  const q = String(raw || "").trim();
  return q
    ? `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`
    : "https://www.instagram.com/explore/";
}

// Inverse, for display: "…?q=%23yoga" -> "#yoga". Deliberately derived rather
// than stored — a `sourceQuery` field would mean touching ALL_FIELDS, the CSV
// column picker, the Sheets column layout (already past column Z, so a new
// column is a live-sheet migration) and sync.js's Firestore subset, all to
// re-state something sourceUrl already carries verbatim.
function exploreQueryFromUrl(href) {
  try {
    const u = new URL(href);
    if (!/^\/explore\//.test(u.pathname)) return null;
    return u.searchParams.get("q");
  } catch { return null; }
}

// Shared tail for both scan entry points: dedupe, score, save, report.
async function commitScan(resp, tab) {
  const icp = await getICP();
  const stamp = await sourceStamp(tab); // detect the account once, not per handle
  const added = [];
  for (const prof of resp.profiles) {
    if (await hasProspect(prof.username)) continue;
    const s = computeScore(prof, icp);
    const rec = await saveProspect({
      ...prof, score: s.score, band: s.band, reasons: s.reasons,
      status: "Captured", capturedAt: new Date().toISOString(), ...stamp,
    });
    added.push(rec);
  }

  // Say what happened, including what did NOT work. A throttled or half-read
  // scan must not look identical to a clean one.
  const bits = [];
  bits.push(added.length ? `Added ${added.length} handle${added.length > 1 ? "s" : ""}` : "No new handles found");
  if (resp.tiles) bits.push(`${resp.tiles} tiles`);
  if (resp.misses) bits.push(`${resp.misses} couldn’t be read (post removed or restricted)`);
  if (resp.throttled) {
    bits.push("Instagram rate-limited the lookups — try again in a few minutes");
  } else if (resp.pending) {
    bits.push(`${resp.pending} still queued — scroll and scan again, or start a recording`);
  } else if (resp.tiles && added.length && added.length <= 3) {
    bits.push("scroll to load more tiles, then scan again");
  }
  toast(bits.join(" · "));
  renderQueue();

  // Auto-enrich the top N so account-type filtering + real scores apply now.
  const n = await getAutoEnrichN();
  if (n > 0 && added.length) {
    const { done, skipped } = await enrichList(added.slice(0, n));
    toast(`Auto-enriched ${done}${skipped ? `, dropped ${skipped}` : ""}${added.length > n ? ` · ${added.length - n} left (Enrich selected)` : ""}`);
  }
}

function scanBusy(on, msg) {
  const b1 = $("#scan-btn"), b2 = $("#explore-btn"), p = $("#scan-progress");
  if (b1) b1.disabled = on;
  if (b2) b2.disabled = on;
  if (p && msg != null) p.textContent = msg;
}

async function scanPage() {
  const tab = await activeTab();
  if (!isInstagram(tab)) return toast("Open Instagram first");
  scanBusy(true, "Reading this page…");
  try {
    await ensureContent(tab);
    // resolve: without this, Scan page on /explore/ resolves nothing — the
    // content script's budget defaults to 0 so no other caller pays for it.
    const resp = await sendToTab(tab.id, { type: "GET_VISIBLE", resolve: EXPLORE_RESOLVE });
    if (!resp || !resp.ok) return toast("Couldn’t scan this page");
    if (!resp.profiles.length && resp.tiles && !resp.resolved && !resp.fromCache) {
      return toast("Couldn’t read any post authors (Instagram may be throttling — wait a few minutes)");
    }
    await commitScan(resp, tab);
  } finally {
    scanBusy(false, "");
  }
}

// Search Explore for a keyword or #tag, then scan the grid it renders.
//
// Note what this does NOT do: wait for the grid to fill. Measured on live
// Instagram, a fresh keyword grid sits at 3 tile anchors for 13.7s and only
// grows when a human scrolls — so a grace period would be waiting for nothing.
// Scan what exists, then say so.
async function scanExplore() {
  const tab = await activeTab();
  if (!tab) return toast("Open a tab first");
  const q = ($("#explore-q") ? $("#explore-q").value : "").trim();
  scanBusy(true, q ? `Searching Explore for “${q}”…` : "Opening Explore…");
  try {
    await chrome.tabs.update(tab.id, { url: exploreSearchUrl(q) });
    await waitForTabComplete(tab.id, 15000);   // full navigation kills the content
    await ensureContent(tab);                  // script, so re-inject after it
    // Just the first paint, not a fill-up: poll briefly for any tile at all.
    for (let i = 0; i < 5; i++) {
      const ping = await sendToTab(tab.id, { type: "PING" });
      if (ping && ping.ok) break;
      await sleep(400);
    }
    scanBusy(true, "Reading post authors…");
    const resp = await sendToTab(tab.id, { type: "GET_VISIBLE", resolve: EXPLORE_RESOLVE });
    if (!resp || !resp.ok) return toast("Couldn’t scan the Explore grid");
    if (!resp.tiles) return toast("No post tiles on this page");
    await commitScan(resp, tab);
  } finally {
    scanBusy(false, "");
  }
}

// ---------- recording sessions ----------
// The content script owns the timer (it lives in the Instagram tab, so it
// survives this panel closing). The panel owns the UI and the enrich burst.
// The two communicate only through storage, which is what makes "panel closed
// at expiry" work: the session just sits at "ended" until someone opens up.

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function startRecording() {
  const tab = await activeTab();
  if (!isInstagram(tab)) return toast("Open Instagram first");
  await ensureContent(tab);
  const mins = Number($("#rec-duration").value) || DEFAULT_DURATION_MIN;
  const stamp = await sourceStamp(tab); // resolve the viewer account once
  const session = newSession({
    durationMin: mins,
    tabId: tab.id,
    sourceAccount: stamp.sourceAccount || "",
  });
  await chrome.storage.local.remove("recHarvest");
  await writeSession(session);
  const r = await sendToTab(tab.id, { type: "REC_START", session, known: [] });
  if (!r || !r.ok) {
    await clearSession();
    return toast("Couldn't start on this tab");
  }
  recSession = session;
  toast(`Recording ${mins} min — browse normally`);
  renderRecorder();
}

async function stopRecording() {
  const s = recSession || (await readSession());
  if (!s) return;
  // Ask the tab to do a final harvest + flush. If that tab is gone, finalize
  // here instead so the session can't get stuck "active".
  let ok = false;
  if (s.tabId) {
    const r = await sendToTab(s.tabId, { type: "REC_STOP" }).catch(() => null);
    ok = !!(r && r.ok);
  }
  if (!ok) {
    const cur = await readSession();
    if (cur && cur.status === "active") {
      cur.status = "ended";
      cur.endedAt = Date.now();
      await writeSession(cur);
    }
  }
  toast("Recording stopped");
}

async function discardHarvest() {
  await clearSession();
  recSession = null;
  $("#rec-progress").textContent = "";
  toast("Discarded");
  renderRecorder();
}

// Drop the junk a multi-minute passive sweep collects that a one-shot Scan
// never surfaced. Items 1 and 3 are not optional — without them the queue
// fills with Instagram's own navigation links.
function filterJunk(records, session) {
  const me = String(session && session.sourceAccount || "").toLowerCase().replace(/^@/, "");
  return records.filter((r) => {
    const u = String(r.username || "").toLowerCase();
    if (!u) return false;
    if (me && u === me) return false;                                  // the viewer
    if ((r.pages || []).length >= CHROME_PAGE_THRESHOLD) return false; // site chrome
    return true;
  });
}

// Stage → prospects. One read + one write for the whole harvest.
async function commitHarvest(session) {
  const raw = Object.values(await readHarvest());
  const list = filterJunk(raw, session);
  const existing = await getProspects();
  const known = new Set();
  for (const k in existing) known.add((existing[k].username || "").toLowerCase());
  // Pre-filtering against what we already have isn't just speed: it guarantees
  // `defaults` can never reset an already-Contacted prospect back to
  // "Captured". saveProspects only applies defaults to NEW records, but not
  // passing them at all for existing ones is belt and braces.
  const fresh = list.filter((h) => !known.has(h.username.toLowerCase()));
  const records = fresh.map((h) => ({
    platform: "instagram",
    username: h.username,
    displayName: h.displayName,
    profileUrl: h.profileUrl,
    sourceUrl: h.sourceUrl,
  }));
  const defaults = {
    status: "Captured",
    sourceType: "recording",
    capturedAt: new Date().toISOString(),
    recordingId: session.id,
    ...(session.sourceAccount ? { sourceAccount: session.sourceAccount } : {}),
  };
  try {
    const { added } = await saveProspects(records, defaults);
    return { added, records, junk: raw.length - list.length, dupes: list.length - fresh.length };
  } catch (e) {
    toast(`Couldn't save — ${await storageBlurb()}`);
    return { added: 0, records: [], junk: 0, dupes: 0 };
  }
}

async function runBurst() {
  if (recBursting) return;
  const session = await readSession();
  if (!session) return;
  // Claim the session by writing "enriching" before doing any work, so a second
  // panel in another window sees the claim rather than bursting over the same
  // handles.
  if (session.status === "enriching") return toast("Evaluating in another window");
  if (session.status !== "ended") return;
  recBursting = true;
  session.status = "enriching";
  await writeSession(session);
  recSession = session;
  renderRecorder();

  const note = $("#rec-progress");
  try {
    const { added, records, junk, dupes } = await commitHarvest(session);
    // commitHarvest saved every fresh handle, not just the batch about to be
    // enriched — so the staging map is now redundant. Drop it rather than
    // leaving ~90KB of duplicate data behind.
    await chrome.storage.local.remove("recHarvest");
    session.committed = added;
    const cap = Number($("#rec-cap").value) || DEFAULT_ENRICH_CAP;
    const batch = records.slice(0, cap);
    note.textContent = `Saved ${added} new handle${added === 1 ? "" : "s"}${junk ? `, filtered ${junk}` : ""}${dupes ? `, ${dupes} already known` : ""}.`;
    renderQueue();

    if (batch.length) {
      $("#rec-stop-burst").hidden = false;
      // Records were just written by saveProspects; re-read so enrichList gets
      // the stored shape (and the key it needs to merge back onto).
      const all = await getProspects();
      const byName = new Map();
      for (const k in all) byName.set((all[k].username || "").toLowerCase(), all[k]);
      const picks = batch.map((r) => byName.get(r.username.toLowerCase())).filter(Boolean);
      const { done, skipped, stopped } = await enrichList(picks, {
        progressEl: note,
        paceMs: burstPaceMs,
      });
      session.enriched = done;
      session.dropped = skipped;
      const left = Math.max(0, added - done - skipped);
      note.textContent =
        `${done} evaluated${skipped ? `, ${skipped} private dropped` : ""}` +
        `${left ? `, ${left} not evaluated` : ""}${stopped ? " — stopped" : ""}.` +
        await filterBlurb(session.id);
    }
  } finally {
    $("#rec-stop-burst").hidden = true;
    recBursting = false;
    const cur = await readSession();
    if (cur) {
      cur.status = "done";
      cur.committed = session.committed;
      cur.enriched = session.enriched;
      cur.dropped = session.dropped;
      await writeSession(cur);
      recSession = cur;
    }
    renderRecorder();
  }
}

// Evaluate the next N that are still unscored from this session.
async function evaluateMore() {
  const session = recSession || (await readSession());
  if (!session) return;
  const cap = Number($("#rec-cap").value) || DEFAULT_ENRICH_CAP;
  const all = await getProspects();
  const picks = [];
  for (const k in all) {
    const p = all[k];
    if (p.recordingId === session.id && p.score == null) picks.push(p);
    if (picks.length >= cap) break;
  }
  if (!picks.length) return toast("Nothing left to evaluate");
  $("#rec-stop-burst").hidden = false;
  try {
    const { done, skipped, stopped } = await enrichList(picks, {
      progressEl: $("#rec-progress"),
      paceMs: burstPaceMs,
    });
    $("#rec-progress").textContent =
      `${done} evaluated${skipped ? `, ${skipped} private dropped` : ""}${stopped ? " — stopped" : ""}.` +
      await filterBlurb(session.id);
  } finally {
    $("#rec-stop-burst").hidden = true;
    await renderRecorder();   // refresh the "remove the N that don't match" button
  }
}

// ---------- post-harvest: apply the Queue's filters to what a session found ----------
//
// The bound filters are a VIEW — they hide rows and never touch the store. That
// is right for a queue you work down and wrong for a harvest, where the question
// is "how many of these 380 are actually my kind of account", and then be rid of
// the rest. This reuses applyView()/viewOpts("q") rather than introducing a
// second set of criteria, so what gets removed is exactly what the Queue is
// already showing you as hidden.
//
// Three eligibility rules, all load-bearing:
//   this session only  — recordingId, so an earlier harvest is never in scope
//   still in the Queue — a shortlisted or messaged lead is never a candidate
//   measured only      — a profile the burst never got to, or that Instagram
//                        threw a wall at, has no counts at all and therefore
//                        fails EVERY bound. Removing those would delete leads
//                        that were merely slow, so they are held back and
//                        reported separately.
function sessionFilterStats(all, sessionId, opts) {
  const mine = Object.values(all).filter(
    (p) => p.recordingId === sessionId && isQueued(p) && !isContacted(p));
  const measured = mine.filter(
    (p) => !!p.outlierCheckedAt || NUM_FIELDS.some(({ field }) => p[field] != null));
  const keep = new Set(applyView(measured, opts).map(refKey));
  return {
    total: mine.length,
    unmeasured: mine.length - measured.length,
    match: keep.size,
    fails: measured.filter((p) => !keep.has(refKey(p))),
  };
}

// One line appended to the burst's progress text. Silent when no bound is set —
// "24 of 24 match your filters" is noise.
async function filterBlurb(sessionId) {
  const opts = viewOpts("q");
  if (!hasActiveFilters(opts)) return "";
  const s = sessionFilterStats(await getProspects(), sessionId, opts);
  const measured = s.total - s.unmeasured;
  if (!measured) return "";   // nothing loaded — "0 of 0 match" would read as a verdict
  return ` · ${s.match} of ${measured} match your Queue filters`;
}

async function updateCullButton() {
  const btn = $("#rec-cull");
  if (!btn) return;
  const s = recSession;
  const opts = viewOpts("q");
  if (!s || !hasActiveFilters(opts)) { btn.hidden = true; return; }
  const stats = sessionFilterStats(await getProspects(), s.id, opts);
  btn.hidden = stats.fails.length === 0;
  btn.textContent = `Remove the ${stats.fails.length} that don’t match`;
  btn.title = `Doesn't match: ${describeFilters(opts)}`;
}

async function cullSession() {
  const s = recSession;
  if (!s) return;
  const opts = viewOpts("q");
  if (!hasActiveFilters(opts)) return toast("Set a filter on the Queue first");
  const stats = sessionFilterStats(await getProspects(), s.id, opts);
  if (!stats.fails.length) return toast("Nothing to remove — everything matches");
  const n = stats.fails.length;
  const ok = confirm(
    `Remove ${n} lead${n === 1 ? "" : "s"} from this recording session?\n\n`
    + `They don't match: ${describeFilters(opts)}\n\n`
    + `Keeping ${stats.match} that do`
    + (stats.unmeasured
      ? `, plus ${stats.unmeasured} that never loaded — those are never removed, because a lead `
        + `Instagram threw a wall at has no counts to judge.`
      : ".")
    + `\n\nThis deletes them from Sprill entirely. Anything you've already shortlisted or `
    + `messaged is untouched.`);
  if (!ok) return;
  for (const p of stats.fails) { await removeProspect(p); selected.delete(refKey(p)); }
  toast(`Removed ${n}`);
  await renderQueue();
  await renderRecorder();
}

async function renderRecorder() {
  const card = $("#rec-card");
  if (!card) return;
  if (!(await flagOn("recorder"))) { card.hidden = true; return; }
  card.hidden = false;

  const s = recSession;
  const idle = $("#rec-idle"), live = $("#rec-live"), pend = $("#rec-pending");
  const active = !!s && s.status === "active";
  const ended = !!s && (s.status === "ended" || s.status === "enriching" || s.status === "done");

  idle.hidden = active || (ended && s.status !== "done");
  live.hidden = !active;
  pend.hidden = !ended;

  if (recTicker) { clearInterval(recTicker); recTicker = null; }

  if (active) {
    $("#rec-state").textContent = "Recording";
    const paint = () => {
      const left = Math.max(0, s.endsAt - Date.now());
      $("#rec-left").textContent = fmtLeft(left);
      const pct = Math.min(100, ((s.durationMs - left) / s.durationMs) * 100);
      $("#rec-fill").style.width = `${pct}%`;
      if (left <= 0 && recTicker) { clearInterval(recTicker); recTicker = null; }
    };
    paint();
    $("#rec-found").textContent = String(s.found || 0);
    // Poll the tab for a live count; fall back to the stored count when the
    // tab is gone (the counter then correctly stops moving).
    let n = 0;
    recTicker = setInterval(async () => {
      paint();
      if (++n % 2 === 0 && s.tabId) {
        const r = await sendToTab(s.tabId, { type: "REC_STATUS" }).catch(() => null);
        if (r && r.ok) $("#rec-found").textContent = String(r.found);
      }
    }, 1000);
  } else if (ended) {
    const harvest = await readHarvest();
    const n = Object.keys(harvest).length;
    const summary = $("#rec-summary");
    if (s.status === "done") {
      $("#rec-state").textContent = "Finished";
      const mins = Math.round(s.durationMs / 60000);
      // How many from this session are still unscored, so "Evaluate next" only
      // shows when there's actually something left.
      const all = await getProspects();
      let left = 0;
      for (const k in all) {
        if (all[k].recordingId === s.id && all[k].score == null) left++;
      }
      summary.innerHTML =
        `Recorded ${mins} min · <b>${s.committed || 0}</b> saved · ${s.enriched || 0} evaluated` +
        `${s.dropped ? ` · ${s.dropped} private dropped` : ""}` +
        `${left ? ` · ${left} not evaluated` : ""}`;
      $("#rec-evaluate").textContent = "Evaluate next";
      $("#rec-evaluate").hidden = left === 0;
    } else {
      $("#rec-state").textContent = s.status === "enriching" ? "Evaluating…" : "Finished";
      summary.innerHTML = `<b>${n}</b> handle${n === 1 ? "" : "s"} waiting to be evaluated`;
      $("#rec-evaluate").textContent = "Evaluate";
      $("#rec-evaluate").hidden = false;
    }
    $("#rec-evaluate").disabled = s.status === "enriching";
  } else {
    $("#rec-state").textContent = "Ready";
  }
  await updateCullButton();
}

// Storage is the durable handoff. A best-effort runtime message from the
// content script would be lost whenever the panel is closed — which is exactly
// when it matters.
function onSessionChanged(next) {
  const prev = recSession;
  recSession = next || null;
  renderRecorder();
  if (next && next.status === "ended" && (!prev || prev.status === "active")) {
    runBurst(); // panel was open at expiry — go straight into evaluation
  }
}

// ---------- queue selection actions ----------
function selectedProspects(all) {
  return all.filter((p) => selected.has(refKey(p)));
}
/** Shortlist selection — the only set any SEND path is allowed to read. */
function slSelectedProspects(all) {
  return all.filter((p) => slSelected.has(refKey(p)));
}
// Lives on the Shortlist, so it reads the shortlist selection and renders into the
// shortlist container. Capped at 8: each box mounts its own persistence listener
// and debounce timer against the shared drafts blob.
async function draftSelected() {
  const all = Object.values(await getProspects());
  const picks = slSelectedProspects(all);
  if (!picks.length) return toast("Tick some handles in the Pipeline first");
  const list = $("#pipeline-list");
  list.querySelectorAll(".draft-box").forEach((n) => n.remove());
  for (const p of picks.slice(0, 8)) list.append(makeDraftBox(p));
  toast(`Drafts ready for ${Math.min(picks.length, 8)}${picks.length > 8 ? " (first 8)" : ""}`);
}
async function removeSelected() {
  const all = Object.values(await getProspects());
  const picks = selectedProspects(all);
  if (!picks.length) return toast("Tick some handles first");
  for (const p of picks) { await removeProspect(p); selected.delete(refKey(p)); }
  toast(`Removed ${picks.length}`);
  renderQueue();
}
// " (~7 min left)" for a long enrich run, or "" until there is evidence to
// estimate from. Averages every profile completed so far rather than the last
// one, so a single slow page doesn't make the number jump around.
function etaSuffix(startedAt, doneCount, total) {
  if (doneCount < 1) return "";
  const remaining = total - doneCount;
  if (remaining < 1) return "";
  const ms = ((Date.now() - startedAt) / doneCount) * remaining;
  const mins = Math.round(ms / 60000);
  if (mins >= 1) return ` (~${mins} min left)`;
  return ` (~${Math.max(1, Math.round(ms / 1000))}s left)`;
}

// Open a list of profiles in temp tabs to fetch bio + account type + real
// score; DELETES private accounts — this is where a scanned handle first
// reveals whether it is private at all.
// opts.progressEl — where to write progress (defaults to the batch bar).
// opts.paceMs    — () => ms to wait between profiles. Defaults to burstPaceMs(),
//                  the SAME jittered 1.5-3s the recording burst uses. It used to
//                  default to a fixed 400ms, which was fine for a handful of
//                  hand-picked profiles and was the most machine-looking thing
//                  this extension did at volume — a metronome-regular request
//                  pattern is exactly what behavioural rate-limiting looks for,
//                  and an imported hitlist is precisely the run that hits it.
//                  The other half of that asymmetry, a monthly enrichment
//                  ceiling, is still open (see BACKLOG.md).
async function enrichList(list, opts = {}) {
  if (!list.length) return { done: 0, skipped: 0, stopped: false };
  batchStop = false; // each run starts un-stopped, mirroring batchSend()
  const note = opts.progressEl || $("#batch-progress");
  const pace = opts.paceMs || burstPaceMs;
  const icp = await getICP();
  let done = 0, skipped = 0, stopped = false, degraded = 0, secondLoads = 0;
  // Why a run produced no reel data. Without these, "the grid had no tiles",
  // "the tiles had no view counts" and "nothing beat their median" are one
  // indistinguishable silence — and the first two are bugs while the third is the
  // feature working.
  let gridless = 0, gridNoMetrics = 0;
  // ETA from a ROLLING AVERAGE of real elapsed time, not from the pace constant.
  // The page read dominates — up to a 12s budget, typically a second or two to
  // settle — so predicting from the 1.5-3s pace alone would understate a
  // 200-handle run badly enough to be worse than saying nothing. Without any
  // estimate a long import just looks hung.
  const startedAt = Date.now();
  for (let i = 0; i < list.length; i++) {
    if (batchStop) { stopped = true; break; }
    const p = list[i];
    note.textContent = `Enriching ${i + 1}/${list.length}: @${p.username}…${etaSuffix(startedAt, i, list.length)}`;
    const { prof, secondLoad } = await fetchProfileForEnrich(p, pace);
    if (secondLoad) secondLoads++;
    // GATE THE SCRAPE before trusting a word of it. extractCurrentProfile()
    // returns a fully-populated object whenever the page merely LOOKS like a
    // profile — which is still true for a login wall, a rate-limit interstitial,
    // or a half-hydrated render. Those are exactly the states Instagram serves
    // during a long enrich burst, i.e. precisely when this runs.
    if (prof && !looksLikeRealProfile(prof, p.username)) {
      console.debug("[Sprill] enrich rejected (page did not render as a profile):", p.username, {
        got: prof.username, followers: prof.followers, category: prof.category,
      });
      degraded++;
    } else if (prof) {
      if (failsPublicFilter(prof)) {   // PUBLIC_ONLY_NOTE — always, not a setting
        console.debug("[Sprill] enrich dropped (private):", p.username);
        await removeProspect(p); selected.delete(refKey(p)); skipped++;
      } else {
        const s = computeScore(prof, icp);
        // Grid telemetry. The reels verdict is the one part of enrich that can
        // fail completely while everything else looks perfect, so say where it
        // broke rather than leaving a silent zero.
        const tiles = Array.isArray(prof.gridPosts) ? prof.gridPosts : [];
        const withMetric = tiles.filter((t) => t.plays != null || t.likes != null).length;
        if (!tiles.length) gridless++;
        else if (!withMetric) gridNoMetrics++;
        console.debug("[Sprill] enrich grid", p.username, {
          tiles: tiles.length,
          reels: tiles.filter((t) => t.kind === "reel").length,
          withPlays: tiles.filter((t) => t.plays != null).length,
          withLikes: tiles.filter((t) => t.likes != null).length,
          withDates: tiles.filter((t) => t.takenAt != null).length,
          src: tiles.reduce((a, t) => ({ ...a, [t.src]: (a[t.src] || 0) + 1 }), {}),
          verdict: analyzeGrid(tiles).note,
        });
        // This is the only path allowed to persist a NEGATIVE verdict ("nothing
        // stands out"), because it is the only clean full page load via
        // fetchProfileViaTempTab. Capture reads the user's own SPA-navigated tab
        // where the embedded JSON can be stale, so it may only write good news —
        // see capturePatch(). gridPosts itself is dropped either way.
        //
        // sourceType/sourceUrl are dropped too, and that is a fix rather than
        // housekeeping: extractCurrentProfile stamps every read as
        // `current_profile`, so enriching a harvested lead used to overwrite
        // `recording` — the "recorded" chip vanished from the queue the moment
        // the burst evaluated it, and the CSV lost where the lead came from.
        // Enrichment is not a source. It became more visible with the Reels tab,
        // which would have written a /reels/ URL over the followers list the
        // handle was actually scanned from.
        const { gridPosts, sourceType, sourceUrl, ...rest } = prof;
        // mergeEnrichment, not saveProspect: field-by-field, dropping empties, so
        // a thin render can never blank a bio or a follower count we already had.
        await mergeEnrichment(p, { ...rest, score: s.score, band: s.band, reasons: s.reasons, ...outlierPatch(prof, p) });
        done++;
      }
    } else {
      degraded++;
    }
    if (i < list.length - 1) await sleep(pace());
  }
  // Report the degraded count. It used to be invisible, so a burst that Instagram
  // throttled halfway looked identical to one that worked — and the honest signal
  // ("slow down") never reached the user.
  //
  // secondLoads answers the one open question about reading the Reels tab: does
  // that sub-route serve og:description? A run where this is 0 means it does and
  // enrichment costs exactly what it used to. A run where it equals `done` means
  // it doesn't, and every profile is being opened twice — worth knowing, because
  // enrichment is the most rate-limit-exposed thing the extension does.
  note.textContent = `Enriched ${done}`
    + (skipped ? `, dropped ${skipped} private/personal` : "")
    + (degraded ? `, ${degraded} didn't load (Instagram may be throttling — wait a few minutes)` : "")
    + (secondLoads ? `, ${secondLoads} needed a second page load` : "")
    + (stopped ? " — stopped." : ".")
    + (gridless ? ` No grid tiles read on ${gridless} — the reels feature got nothing from those.` : "")
    + (gridNoMetrics ? ` ${gridNoMetrics} had tiles but no view counts.` : "");
  renderQueue();
  return { done, skipped, stopped };
}
async function enrichSelected() {
  const picks = selectedProspects(Object.values(await getProspects()));
  if (!picks.length) return toast("Tick some handles to enrich");
  await enrichList(picks);
}

// ---------- CSV export ----------
// `scope` decides WHICH selection narrows the export — the Queue button and the
// Shortlist button share this function but have separate tick-boxes, and exporting
// the wrong tab's selection is a silent wrong answer.
async function exportCsv(scope = "queue") {
  const sel = scope === "shortlist" ? slSelected : selected;
  let prospects = Object.values(await getProspects());
  if (sel.size) prospects = prospects.filter((p) => sel.has(refKey(p))); // export selection if any
  if (!prospects.length) return toast("Nothing to export");
  prospects.sort((a, b) => (b.score || 0) - (a.score || 0));
  const fields = await getCsvFields();
  const header = fields.join(",");
  const rows = prospects.map((p) => fields.map((f) => csvValue(csvField(p, f))).join(","));
  const csv = [header, ...rows].join("\n");
  // Leading BOM. parseCsv strips one on the way in, so Sprill round-trips either
  // way — but without it Excel renders every emoji and accented character in a
  // bio as mojibake, and bios are mostly emoji.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = url; a.download = `ig_prospects_${stamp}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`Exported ${prospects.length} rows`);
}

// A starter file for a hitlist. Header row only, NO example rows — a sample
// handle left in place would import as a real lead, and the whole point of this
// button is the file the user hands straight back to Import.
//
// Same BOM/Blob/anchor dance as exportCsv(): the BOM keeps Excel from mangling
// anything the user types in, and parseCsv() strips it on the way back in.
function downloadTemplate() {
  const blob = new Blob(["﻿", "username,profileUrl\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "sprill_hitlist_template.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast("Template downloaded — fill in the username column");
}

// ---------- CSV import ----------
// Accepts three shapes, in this order of preference:
//   1. Sprill's own export (every recognized column round-trips)
//   2. a hand-made CSV with nothing but a username or profileUrl column
//   3. a plain list with NO header at all — one handle, @handle or profile URL
//      per line, which is the shape a hitlist arrives in
// Rows from 2 and 3 land with no score, show as "Needs enrich", and feed
// straight into the existing enrich pipeline.
async function importCsvFile(file) {
  const note = $("#batch-progress");
  let text;
  try {
    text = await file.text();
  } catch {
    return toast("Couldn't read that file");
  }

  const parsed = parseCsv(text);
  if (!parsed.headers.length) return toast("That CSV looks empty");

  // Header-CSV FIRST, always. The headerless fallback runs only when no column
  // name was recognized at all — gated on `headerRecognized` rather than on
  // "mapCsvRows found nothing", because those are different failures. A real
  // Sprill export with a good header and no usable rows must keep its existing
  // error; re-reading it as a handle list would import its own header cell
  // ("userId") as lead #1.
  let { records, skipped, headerRecognized } = mapCsvRows(parsed);
  let asHandleList = false;
  if (!records.length && !headerRecognized) {
    ({ records, skipped } = parseHandleList(parsed));
    asHandleList = records.length > 0;
  }
  if (!records.length) {
    return toast('No usable rows — needs a "username" or "profileUrl" column, or one handle per line');
  }

  // Attribute imported leads to the IG account currently in view so
  // multi-account consolidation can tell them apart. A sourceAccount column in
  // the file wins over this.
  let viewer = null;
  const tab = await activeTab();
  if (isInstagram(tab) && (await ensureContent(tab))) {
    const v = await getViewer(tab);
    viewer = (v && v.username) || null;
  }

  const defaults = {
    status: "New",
    sourceType: "csv",
    capturedAt: new Date().toISOString(),
  };
  if (viewer) defaults.sourceAccount = viewer;

  let added, merged;
  try {
    ({ added, merged } = await saveProspects(records, defaults));
  } catch (e) {
    // Say so plainly rather than reporting a success that didn't happen.
    console.error("[Sprill] import write failed", e);
    return toast(`Import failed — ${await storageBlurb()}. Remove some leads and try again.`);
  }

  const bits = [`Imported ${added} new`];
  if (asHandleList) bits.push("read as a plain handle list (no header row)");
  if (merged) bits.push(`${merged} merged into existing`);
  if (skipped) bits.push(`${skipped} skipped (${asHandleList ? "not a handle, or a repeat" : "no handle"})`);
  // Limits stay at 5/day by design — be honest about how long this takes.
  const days = Math.ceil((added + merged) / LIMITS.DAILY);
  if (days > 1) bits.push(`~${days} days of sending at ${LIMITS.DAILY}/day`);
  // Say WHICH reading produced this. Silently reinterpreting the user's file is
  // the same class of quiet wrong answer the enrich path refuses elsewhere.
  toast(`Imported ${added} new${merged ? `, ${merged} merged` : ""}`
    + (asHandleList ? " — read as a plain handle list" : ""));

  // Jump to the Queue so the result is visible (the tab handler re-renders).
  const queueTab = document.querySelector('.tab[data-tab="queue"]');
  if (queueTab) queueTab.click(); else await renderQueue();
  if (note) note.textContent = bits.join(" · "); // set after render, which clears it
}

// ---------- SENT / outreach log ----------
function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
async function renderSent() {
  const listEl = $("#sent-list");
  if (!listEl) return;
  const all = Object.values(await getProspects()).filter((p) => p.outreach && p.outreach.length);
  all.sort((a, b) => new Date(b.lastContactedAt || 0) - new Date(a.lastContactedAt || 0));
  const chan = (e) => e.channel || "dm";
  const dms = all.reduce((n, p) => n + p.outreach.filter((e) => chan(e) === "dm").length, 0);
  const cms = all.reduce((n, p) => n + p.outreach.filter((e) => chan(e) === "comment").length, 0);
  const logCount = $("#sent-log-count");
  if (logCount) logCount.textContent = String(dms + cms);
  listEl.innerHTML = "";
  if (!all.length) {
    listEl.append(el("div", "empty", "Your outreach log.<br/>Sends (one-click, insert + mark as sent, or batch) are recorded here with date and message."));
    return;
  }
  for (const p of all) {
    const last = p.outreach[p.outreach.length - 1];
    const item = el("div", "sent-item");
    const src = (last.source && last.source.username) || p.lastSourceHandle;
    const head = el("div", null,
      `<div class="row-between"><b>@${esc(p.username)}</b><span class="when">${esc(fmtDate(last.at))}</span></div>
       <div class="when">${p.outreach.length} touch${p.outreach.length > 1 ? "es" : ""} · ${esc(chan(last) === "comment" ? "comment" : (last.type || "sent"))}${last.method ? " · " + esc(last.method) : ""}${src ? " · from @" + esc(src) : ""}${p.status && p.status !== "Contacted" ? " · " + esc(p.status) : ""}</div>
       <div class="msg">${esc(last.text || "")}</div>`);
    item.append(head);
    if (chan(last) === "comment" && last.postUrl) {
      const onPost = el("button", "icon-btn", "View post");
      onPost.addEventListener("click", () => chrome.tabs.create({ url: last.postUrl }));
      item.append(onPost);
    }
    // quick outcome buttons (feed the Metrics tab)
    const oc = el("div", "row-gap");
    for (const [label, status] of [["Replied", "Replied"], ["Meeting", "Meeting"], ["Won", "Won"], ["Lost", "Not interested"]]) {
      const b = el("button", "icon-btn" + (p.status === status ? " on" : ""), label);
      b.addEventListener("click", async () => { const r = await setOutcome(p, status); toast(`Marked ${label}`); renderPipeline(); });
      oc.append(b);
    }
    item.append(oc);
    listEl.append(item);
  }
}

// ---------- METRICS ----------
async function renderMetrics() {
  const body = $("#metrics-body");
  if (!body) return;
  const m = await computeMetrics();
  body.innerHTML = "";
  if (!m.people) {
    body.append(el("div", "empty", "No outreach yet — your reply rate, seen rate and conversions will show here once you start sending."));
    return;
  }
  const tiles = el("div", "metrics-grid");
  const tile = (label, val, sub) => {
    const t = el("div", "metric");
    t.innerHTML = `<b>${esc(String(val))}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ""}`;
    return t;
  };
  // Read rate leads. It is the number the product exists to give you, and the one
  // no other tool reports — everything below it is context for it.
  tiles.append(
    tile("read rate", m.seenRate + "%", `${m.seen} of ${m.dmPeople} opened it`),
    tile("never opened", m.unread, m.dmPeople ? `${100 - m.seenRate}% of DMs sent` : ""),
    // The distinction the whole product turns on: a low reply rate with a HIGH
    // read rate is a message problem. A low reply rate with a LOW read rate is a
    // deliverability problem. Averaging them together hides which one you have.
    tile("replied, of those who read", m.replyRateOfRead + "%", `${m.replied} of ${m.seen}`),
    tile("reply rate overall", m.replyRate + "%", `${m.replied} of ${m.dmPeople}`),
    tile("people contacted", m.people),
    tile("messages sent", m.sent, `${m.dmPeople} people`),
    tile("meetings", m.meetings),
    tile("won", m.won),
  );
  // Comments are a separate channel: they have no read receipt and no reply
  // mechanic, so they get their own tile rather than inflating "messages sent".
  if (m.comments) {
    tiles.append(tile("comments posted", m.comments, `${m.commentPeople} people`));
  }
  body.append(tiles);
  // By template. This is "which message works", and it is the reason `tpl` is now
  // recorded on every outreach event. A prospect is credited to the template of
  // their FIRST DM — that is the message that had to earn the open.
  //
  // Small samples lie loudly here, so the row states n and says so below rather
  // than presenting 1-of-1 as "100%".
  const tpls = Object.entries(m.byTemplate).filter(([k]) => k !== "—");
  if (tpls.length > 1) {
    body.append(el("div", "muted", "By first message"));
    const names = new Map((await getTemplates("dm")).map((t) => ["tpl:" + t.id, t.name]));
    const label = (k) => names.get(k)
      || (k.startsWith("obj:") ? "Auto · " + k.slice(4) : k.startsWith("blank:") ? "Written by hand" : k);
    for (const [k, v] of tpls.sort((a, b) => b[1].people - a[1].people)) {
      const r = el("div", "q-item");
      const readRate = v.people ? Math.round((v.seen / v.people) * 100) : 0;
      const repRate = v.people ? Math.round((v.replied / v.people) * 100) : 0;
      r.innerHTML = `<div class="q-main"><div class="n">${esc(label(k))}</div>`
        + `<div class="muted">${v.people} sent · ${readRate}% read · ${repRate}% replied</div></div>`;
      body.append(r);
    }
    body.append(el("p", "fine", "Attributed to the first message sent to each person. Under about 30 people per template these percentages move a lot on one reply — read them as a direction, not a result."));
  }
  // by source account
  const srcs = Object.entries(m.bySource);
  if (srcs.length > 1) {
    body.append(el("div", "muted", "By sending account"));
    for (const [s, v] of srcs.sort((a, b) => b[1].people - a[1].people)) {
      const r = el("div", "q-item");
      const rate = v.people ? Math.round((v.replied / v.people) * 100) : 0;
      r.innerHTML = `<div class="q-main"><div class="n">@${esc(s)}</div><div class="muted">${v.people} people · ${v.replied} replied · ${rate}%</div></div>`;
      body.append(r);
    }
  }
  body.append(el("p", "fine", "Read status comes from Instagram\u2019s \u201cSeen\u201d marker \u2014 refresh it at the top of this tab. Sprill cannot see which folder a message landed in, only whether the thread has been opened. Meetings and Won are what you mark yourself."));
}

// ---------- FOLLOW-UPS ----------
function relDay(iso) {
  if (!iso) return "";
  const ms = new Date(iso) - Date.now();
  const d = Math.round(ms / 86400000);
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}
// Storage-reading wrapper over splitOutreach(), for callers that don't already
// hold a scored list. renderPipeline() does, and calls splitOutreach directly.
async function computeFollowups() {
  return splitOutreach(Object.values(await getProspects()));
}

function updatePipelineBadge(n) {
  const btn = $("#tab-btn-pipeline");
  if (!btn) return;
  // The badge counts READ-AND-NO-REPLY only. Not everyone messaged, and not
  // everyone overdue: it is the number of people who demonstrably opened your
  // message and said nothing, which is the only bucket where a follow-up is
  // worth writing.
  btn.innerHTML = "Pipeline" + (n ? ` <span class="badge">${n}</span>` : "");
}

// ---------- send via a temporary tab (keeps your browsing tab untouched) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForTabComplete(tabId, timeout = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(v);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // A small page can finish loading between tabs.create() and this listener
    // attaching, and onUpdated never fires again — so the caller sat out the
    // whole timeout for a tab that was ready immediately.
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return;         // tab is gone; let the timeout own it
      if (t && t.status === "complete") finish(true);
    });
    setTimeout(() => finish(false), timeout);
  });
}
function waitForUrl(tabId, re, timeout = 12000) {
  return new Promise((resolve) => {
    const listener = (id, info, tab) => {
      const url = (tab && tab.url) || "";
      if (id === tabId && info.status === "complete" && re.test(url)) { chrome.tabs.onUpdated.removeListener(listener); resolve(true); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, timeout);
  });
}
function sendErr(r) {
  const e = (r && r.error) || "no_response";
  if (e === "message_button_not_found") return "Couldn’t find the Message button (are you logged in / can you DM them?)";
  if (e === "composer_not_found") return "Couldn’t find the message box — check the console for [Sprill] and send it over";
  // The composer took the text but not as given — most often the whole draft
  // twice. Nothing is sent in that state, and the user is told to look, because
  // what is in the box is wrong in a way that reads as normal.
  if (e === "insert_mismatch") return r && r.doubled
    ? "The message box ended up with the draft in it twice — clear it, then Insert again"
    : "The message box didn’t take the text cleanly — clear it and try again";
  if (e === "send_control_not_found") return "Typed the message but couldn\u2019t click Send — tune the Send selector";
  if (e === "not_a_dm_thread") return "Instagram didn\u2019t open the DM thread — nothing was typed. Try again, or DM them manually";
  return `Send failed (${e})`;
}

// Open the prospect's DM in a temp tab, insert, send, then close it — so your
// current tab never leaves the profile you're browsing.
// Speed: polls for readiness instead of fixed sleeps, so each step advances the
// moment it can. (Batch pacing between prospects stays — that floor is safety.)
async function sendViaTempTab(profile, text) {
  const tab = await new Promise((res) => chrome.tabs.create({ url: profile.profileUrl, active: true }, res));
  tempTabs.add(tab.id);
  try {
    // Click "Message" the instant it's clickable — poll without waiting for the
    // whole profile to finish loading.
    let opened = null;
    for (let i = 0; i < 40; i++) { // ~10s ceiling, exits early
      if (await ensureContent(tab)) {
        opened = await sendToTab(tab.id, { type: "OPEN_DM" });
        if (opened && opened.ok) break;
      }
      await sleep(200);
    }
    if (!opened || !opened.ok) return opened || { ok: false, error: "message_button_not_found" };
    // Once we're in the thread, send — SEND_MESSAGE polls for the composer and
    // fires the moment it appears.
    //
    // The return value used to be DISCARDED. On timeout — IG opening the thread
    // as an in-page dialog, or serving a challenge at the same URL — the panel
    // sent anyway, into whatever the content script's fallback chain happened to
    // find. The content script now refuses outside a DM scope, so this is the
    // second of two independent guards; we keep both, because this one produces
    // a useful error and that one produces a safe one.
    const inThread = await waitForUrl(tab.id, /\/direct\//, 12000);
    if (!inThread) {
      // Not a hard failure: IG may render the thread in a dialog without
      // changing the URL. Ask the content script whether a real composer exists
      // before deciding, and let SEND_MESSAGE's own guard have the final word.
      console.debug("[Sprill] waitForUrl(/direct/) timed out — deferring to the content-script guard");
    }
    let r = null;
    for (let i = 0; i < 3; i++) {
      await ensureContent(tab);
      r = await sendToTab(tab.id, { type: "SEND_MESSAGE", text });
      if (r && (r.ok || r.error !== "composer_not_found")) break;
      await sleep(250);
    }
    if (r && r.ok) await sleep(700); // brief grace so the send request completes before close
    return r || { ok: false, error: "no_response" };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (_) {} tempTabs.delete(tab.id); }, 250);
  }
}

// Open a profile in a temp tab, read it, close — used by Enrich.
// How long to let a background profile tab finish rendering before giving up on
// it. Generous on purpose: Chrome deprioritises background tabs, and the cost of
// reading too early is a permanently half-filled record, while the cost of
// waiting is seconds — which enrichment should be spending anyway (PLAN_v2 §4).
const READ_BUDGET_MS = 12000;
const READ_STEP_MS = 400;
const READ_STABLE_ROUNDS = 3;   // ~1.2s of no improvement means the page is done
// ...except for the GRID, which is the slowest thing on the page: the tiles are
// lazy-loaded images rendered well after the header text has settled. Letting
// "quality stopped improving" end the wait while gridPosts is still empty is how
// an enrich comes back complete in every field except the one the reels feature
// needs. So a gridless read keeps polling until this grace period is up.
const READ_GRID_GRACE_MS = 6000;

async function fetchProfileViaTempTab(profileUrl) {
  const tab = await new Promise((res) => chrome.tabs.create({ url: profileUrl, active: false }, res));
  tempTabs.add(tab.id);
  try {
    await waitForTabComplete(tab.id, 12000);
    // POLL UNTIL THE READ IS GOOD, not until it is non-null.
    //
    // This loop used to break on the first response that was an object at all —
    // and extractCurrentProfile() returns a fully-shaped object the moment
    // pageType() says "profile", which is true on first paint. So it always
    // exited on iteration 0 with a skeleton, never spent its retry budget, and
    // closed the tab while the page was still rendering. Counts come from
    // og:description in the initial HTML, so a lead could be "enriched" with a
    // follower count and no bio — and then sit at "needs enrich" forever,
    // because computeScore has nothing to score.
    //
    // Keeps the BEST read rather than the last: a later poll can hit a
    // rate-limit interstitial and would otherwise overwrite a good one.
    let best = null, bestQ = -1, stale = 0;
    const startedAt = Date.now();
    const deadline = startedAt + READ_BUDGET_MS;
    while (Date.now() < deadline) {
      if (await ensureContent(tab)) {
        const r = await sendToTab(tab.id, { type: "GET_CURRENT_PROFILE" });
        const prof = r && r.ok ? r.profile : null;
        const q = readQuality(prof);
        if (q > bestQ) { best = prof; bestQ = q; stale = 0; } else if (best) stale++;
        if (best && readLooksSettled(best, OUTLIER_TUNING.MIN_SAMPLE)) break;
        // Text has settled. Only stop here if the grid arrived too, or if we have
        // already given it its grace period — an account can legitimately have no
        // posts, and waiting the full budget for every one of those is just slow.
        const gridSeen = Array.isArray(best && best.gridPosts) && best.gridPosts.length > 0;
        const graceOver = Date.now() - startedAt > READ_GRID_GRACE_MS;
        if (best && stale >= READ_STABLE_ROUNDS && (gridSeen || graceOver)) break;
      }
      await sleep(READ_STEP_MS);
    }
    return best;
  } catch (e) {
    return null;
  } finally {
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (_) {} tempTabs.delete(tab.id); }, 200);
  }
}

// The account's Reels tab. Derived from the HANDLE, never from a stored
// profileUrl — that field is the one piece of a record that is also an action the
// panel performs (chrome.tabs.create), and lists.js already treats it as
// untrusted for exactly that reason.
function reelsUrlFor(p) {
  const h = String(p.username || "").trim();
  return h ? `https://www.instagram.com/${encodeURIComponent(h)}/reels/` : p.profileUrl;
}

// Enrich reads the REELS TAB first. See reelsReadIsComplete() in store.js for the
// why: on the mixed main grid the video bucket usually falls under analyzeGrid's
// 6-post floor, so "top performing reels" silently never appears for exactly the
// creators it is meant to find.
//
// The canonical page is loaded only when the reels tab didn't carry the counts —
// so this is ONE page load in the normal case, not two. Whether that fallback
// ever fires is the open question about the sub-route, which is why enrichList
// counts it and says so.
async function fetchProfileForEnrich(p, pace) {
  const reels = await fetchProfileViaTempTab(reelsUrlFor(p));
  if (reelsReadIsComplete(reels, p.username)) return { prof: reels, secondLoad: false };
  // Pay for the second load at the same pace as any other profile open — a
  // back-to-back pair is a more machine-looking pattern than a single one.
  await sleep(pace());
  const main = await fetchProfileViaTempTab(p.profileUrl);
  return { prof: withReelsGrid(main, reels, p.username), secondLoad: true };
}

// Open a sent prospect's DM in a background temp tab, read "Seen", close.
async function fetchThreadStatusViaTempTab(profile) {
  const tab = await new Promise((res) => chrome.tabs.create({ url: profile.profileUrl, active: false }, res));
  tempTabs.add(tab.id);
  try {
    await waitForTabComplete(tab.id, 12000);
    let opened = null;
    for (let i = 0; i < 12; i++) {
      if (await ensureContent(tab)) { opened = await sendToTab(tab.id, { type: "OPEN_DM" }); if (opened && opened.ok) break; }
      await sleep(200);
    }
    if (!opened || !opened.ok) return null;
    await waitForUrl(tab.id, /\/direct\//, 12000);
    await ensureContent(tab);
    const r = await sendToTab(tab.id, { type: "THREAD_STATUS" });
    return r && r.ok ? r.status : null;
  } catch (e) {
    return null;
  } finally {
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch (_) {} tempTabs.delete(tab.id); }, 200);
  }
}
async function refreshReadStatus() {
  const { awaiting } = await computeFollowups();
  if (!awaiting.length) return toast("Nothing awaiting read");
  $("#refresh-status").disabled = true;
  let seenCount = 0;
  for (let i = 0; i < awaiting.length; i++) {
    const p = awaiting[i];
    $("#fu-progress").textContent = `Checking ${i + 1}/${awaiting.length}: @${p.username}…`;
    const st = await fetchThreadStatusViaTempTab(p);
    if (st && st.seen) { await markSeen(p); seenCount++; }
    await sleep(400);
  }
  $("#refresh-status").disabled = false;
  $("#fu-progress").textContent = `Done — ${seenCount} newly seen.`;
  renderPipeline();
}

// ---------- batch (bundle) send ----------
async function batchSend() {
  if (!(await getOneClick())) return toast("Enable \u201cSend from this panel\u201d in Settings first");
  // slSelected, NOT selected. Batch send may only ever target vetted people —
  // reading the Queue's selection here is the one bug that would make the
  // two-stage funnel pointless.
  if (!slSelected.size) return toast("Tick some handles in the Pipeline first");
  // Belt as well as braces: the batch bar is hidden outside the "to message"
  // segment, but hiding a control is a presentation fact, not a guarantee. Sending
  // in bulk to people who are already mid-conversation is a follow-up — a
  // per-person decision — so refuse it here too rather than trusting the CSS.
  if (plSegment !== "todo") return toast("Batch send only works on “to message”");
  const cap = await canSend();
  if (!cap.ok) return toast("Free daily/monthly limit reached");
  const map = await getProspects();
  // Re-check vetting at send time against STORAGE, not against the rendered list:
  // a second panel may have moved someone back to the Queue since this render.
  const targets = Object.entries(map)
    .filter(([k, v]) => slSelected.has(k) && isShortlisted(v) && !isContacted(v))
    .map(([, v]) => v);
  if (!targets.length) return toast("Those handles are no longer waiting for a first message");
  const budget = Math.min(cap.dayLeft, cap.monthLeft, targets.length);
  if (budget < targets.length) toast(`Cap: sending to ${budget} of ${targets.length} (free limit)`);
  const tplVal = $("#batch-template").value || "obj:networking";
  const icp = await getICP();
  const { businessName } = await chrome.storage.local.get({ businessName: "" });

  batchStop = false;
  $("#batch-stop").style.display = "";
  $("#batch-send").disabled = true;
  let sent = 0, failed = 0;
  for (const p of targets) {
    if (batchStop || sent >= budget) break;
    if (!(await canSend()).ok) break;
    const pace = await paceStatus();
    if (pace.waitMs > 0) {
      $("#batch-progress").textContent = `Pacing ${Math.ceil(pace.waitMs / 1000)}s before next…`;
      await sleep(pace.waitMs);
    }
    if (batchStop) break;
    const text = await renderFor(p, tplVal, { icp, businessName });
    $("#batch-progress").textContent = `Sending ${sent + 1}/${budget}: @${p.username}…`;
    const r = await sendViaTempTab(p, text);
    if (r && r.ok) {
      await recordSend();
      const rec = await logOutreach(p, { at: new Date().toISOString(), channel: "dm", type: "batch", text, tpl: tplVal, method: r.method, source: r.viewer });
      sent++;
      await refreshQuota();
    } else {
      failed++;
    }
    slSelected.delete(refKey(p));
  }
  $("#batch-stop").style.display = "none";
  $("#batch-send").disabled = false;
  $("#batch-progress").textContent = `Done — ${sent} sent${failed ? `, ${failed} failed (open those manually)` : ""}.`;
  renderQueue(); renderPipeline();
}

// ---------- SETTINGS tab ----------
// ---------- shared lists ----------
async function renderSharing({ refresh = false } = {}) {
  const card = $("#sharing-card");
  if (!card) return;
  // CUT FROM v1 — see the comment on #sharing-card in panel.html. Gated at the
  // entry point only; every function in lists.js is untouched and the Firestore
  // documents of anyone who already made a list are left alone. Flipping
  // FLAGS.lists (or unlocking it locally) restores the whole feature.
  if (!(await flagOn("lists"))) { card.hidden = true; return; }
  if (!hasFirebase()) { card.hidden = true; return; }
  card.hidden = false;

  const status = $("#sharing-status");
  let lists = await cachedLists();
  if (refresh) {
    try {
      status.textContent = "Refreshing…";
      lists = await refreshLists();
    } catch (e) {
      status.textContent = "Sign in to use sharing";
      console.debug("[Sprill] list refresh failed", e);
    }
  }
  status.textContent = lists.length ? `${lists.length} list${lists.length > 1 ? "s" : ""}` : "No lists yet";

  const box = $("#list-container");
  box.innerHTML = "";
  for (const l of lists) {
    const item = el("div", "card");
    const members = (l.memberUids || []).length;
    item.append(el("div", null,
      `<div class="row-between"><b>${esc(l.name || "Shared leads")}</b><span class="when">${members} member${members > 1 ? "s" : ""}</span></div>
       <div class="when">Code: <code>${esc(l.id)}</code></div>`));

    const row = el("div", "row-gap");
    const copy = el("button", "icon-btn", "Copy code");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(l.id); toast("Code copied"); }
      catch { toast("Couldn't copy — select the code manually"); }
    });

    const push = el("button", "icon-btn", "Push selected");
    push.addEventListener("click", async () => {
      const all = Object.values(await getProspects());
      const picks = [...selectedProspects(all), ...slSelectedProspects(all)]
        .filter((p, i, a) => a.findIndex((q) => refKey(q) === refKey(p)) === i);
      const payload = picks.length ? picks : null;
      try {
        toast(payload ? `Pushing ${payload.length}…` : "Pushing everything…");
        const n = payload ? await pushToList(l.id, payload) : await pushAllToList(l.id);
        toast(`Pushed ${n} lead${n === 1 ? "" : "s"}`);
      } catch (e) { toast("Push failed: " + (e.message || e)); }
    });

    const pull = el("button", "icon-btn", "Pull");
    pull.addEventListener("click", async () => {
      try {
        toast("Pulling…");
        const { added, merged } = await pullFromList(l.id);
        toast(`Pulled ${added} new${merged ? `, ${merged} merged` : ""}`);
        renderQueue();
      } catch (e) { toast("Pull failed: " + (e.message || e)); }
    });

    const leave = el("button", "icon-btn danger", "Leave");
    leave.addEventListener("click", async () => {
      try { await leaveList(l.id); toast("Left the list"); renderSharing(); }
      catch (e) { toast("Couldn't leave: " + (e.message || e)); }
    });

    row.append(copy, push, pull, leave);
    item.append(row);
    box.append(item);
  }
}

async function loadSettings() {
  const icp = await getICP();
  $("#icp-keywords").value = (icp.keywords || []).join(", ");
  $("#icp-desc").value = icp.description || "";
  const { businessName } = await chrome.storage.local.get({ businessName: "" });
  $("#biz-name").value = businessName || "";

  // Warm-up card
  const w = await warmupStats(14);
  $("#warm-streak").textContent = `🔥 ${w.streak}-day streak`;
  $("#warm-today").textContent = `Today: ${w.today} / target ${w.target}`;
  const bars = $("#warm-bars"); bars.innerHTML = "";
  const maxC = Math.max(1, ...w.days.map((d) => d.count));
  w.days.forEach((d, i) => {
    const b = el("div", "bar" + (d.count ? "" : " empty") + (i === w.days.length - 1 ? " today" : ""));
    b.style.height = (d.count ? 8 + (d.count / maxC) * 36 : 2) + "px";
    b.title = `${d.date}: ${d.count} sent`;
    bars.append(b);
  });
  const dt = $("#daily-target"); dt.innerHTML = "";
  for (let n = 1; n <= LIMITS.DAILY; n++) {
    const o = el("option"); o.value = String(n); o.textContent = `${n} / day`; dt.appendChild(o);
  }
  dt.value = String(await getDailyTarget());

  // CSV field chips
  const csvSel = new Set(await getCsvFields());
  const wrap = $("#csv-fields");
  wrap.innerHTML = "";
  for (const f of ALL_FIELDS) {
    const chip = el("span", "chip toggle" + (csvSel.has(f) ? " on" : ""), esc(f));
    chip.addEventListener("click", async () => {
      if (csvSel.has(f)) csvSel.delete(f); else csvSel.add(f);
      chip.classList.toggle("on");
      await setCsvFields(ALL_FIELDS.filter((x) => csvSel.has(x)));
    });
    wrap.append(chip);
  }

  // Templates list
  const tlist = $("#template-list"); tlist.innerHTML = "";
  for (const t of await getTemplates()) {
    const row = el("div", "tpl-row");
    row.append(el("span", "tpl-name", `${esc(t.name)} <span class="muted">· ${t.kind === "comment" ? "comment" : "DM"}</span>`));
    const editB = el("button", "icon-btn", "Edit");
    editB.addEventListener("click", () => {
      $("#tpl-id").value = t.id; $("#tpl-name").value = t.name; $("#tpl-body").value = t.body;
      $("#tpl-kind").value = t.kind === "comment" ? "comment" : "dm";
    });
    const delB = el("button", "icon-btn danger", "✕");
    delB.addEventListener("click", async () => {
      await deleteTemplate(t.id);
      $("#batch-template").dataset.filled = "";
      loadSettings();
    });
    row.append(editB, delB);
    tlist.append(row);
  }

  // Which template a fresh draft box opens on. Rebuilt with the list above, so
  // deleting a template can't leave a stale name in here.
  const tdef = $("#tpl-default");
  if (tdef) {
    tdef.innerHTML = "";
    const auto = el("option"); auto.value = ""; auto.textContent = "Auto · Networking opener";
    tdef.appendChild(auto);
    for (const t of await getTemplates("dm")) {
      const o = el("option"); o.value = t.id; o.textContent = t.name; tdef.appendChild(o);
    }
    tdef.value = await getDefaultTpl();
    tdef.onchange = async () => { await setDefaultTpl(tdef.value); toast(tdef.value ? "Default template set" : "Back to the auto opener"); };
  }

  $("#one-click").checked = await getOneClick();
  $("#auto-comment").checked = await getAutoComment();

  // Account & sync status
  const gUser = await getGoogleUser();
  $("#acct-status").textContent = gUser && gUser.email ? `Signed in: ${gUser.email}` : (hasGoogle() ? "Not signed in" : "Local only");
  $("#acct-note").textContent = hasGoogle() ? "" : "Google sign-in, Sheets export and cloud backup need setup. See README.md (config.local.js).";

  // Pacing
  const pm = $("#pace-min"); pm.innerHTML = "";
  for (const sec of [8, 12, 20, 30, 45, 60]) {
    const o = el("option"); o.value = String(sec * 1000); o.textContent = `${sec}s`; pm.appendChild(o);
  }
  pm.value = String(await getPaceMinMs());

  const ae = $("#auto-enrich"); ae.innerHTML = "";
  for (const [val, label] of [[0, "Off"], [5, "Top 5"], [10, "Top 10"], [20, "Top 20"], [40, "Top 40"]]) {
    const o = el("option"); o.value = String(val); o.textContent = label; ae.appendChild(o);
  }
  ae.value = String(await getAutoEnrichN());

  // Follow-up cadence
  const fd = $("#followup-days"); fd.innerHTML = "";
  for (const n of [1, 2, 3, 4, 5, 7, 10, 14]) {
    const o = el("option"); o.value = String(n); o.textContent = `${n} day${n > 1 ? "s" : ""}`; fd.appendChild(o);
  }
  fd.value = String(await getFollowUpDays());

  const u = await getUsage();
  $("#usage-detail").textContent = `${u.dayCount}/${LIMITS.DAILY} today · ${u.monthCount}/${LIMITS.MONTHLY} this month`;

  // Shared lists — render from cache immediately, then refresh from the server
  // only when we're actually signed in (refreshing would otherwise trigger an
  // interactive sign-in prompt just for opening Settings).
  await renderSharing({ refresh: !!(gUser && gUser.token) });
}

function wireSettings() {
  $("#list-create").addEventListener("click", async () => {
    const name = $("#list-name").value.trim();
    if (!name) return toast("Give the list a name first");
    try {
      await createList(name);
      $("#list-name").value = "";
      toast("List created — share the code");
      renderSharing();
    } catch (e) { toast("Couldn't create list: " + (e.message || e)); }
  });
  $("#list-join").addEventListener("click", async () => {
    const code = $("#list-code").value.trim();
    if (!code) return toast("Paste a code first");
    try {
      const l = await joinList(code);
      $("#list-code").value = "";
      toast(`Joined "${l.name || "Shared leads"}"`);
      renderSharing();
    } catch (e) {
      const msg = e.message === "bad_code" ? "That doesn't look like a valid code"
        : e.message === "list_not_found" ? "No list with that code"
        : "Couldn't join: " + (e.message || e);
      toast(msg);
    }
  });
  $("#save-icp").addEventListener("click", async () => {
    const keywords = $("#icp-keywords").value.split(",").map((s) => s.trim()).filter(Boolean);
    const description = $("#icp-desc").value.trim();
    await setICP({ keywords, description });
    await chrome.storage.local.set({ businessName: $("#biz-name").value.trim() });
    await rescoreAll(); // re-rank the whole queue against the new keywords
    toast("Targeting saved — re-scored queue");
    refreshCurrent(); renderQueue();
  });
  $("#one-click").addEventListener("change", async (e) => {
    // Turning auto-send ON is the one setting that can cost the user their
    // Instagram account — make them acknowledge it, not just tick a box.
    if (e.target.checked) {
      const ok = confirm(
        "Enable sending from this panel?\n\n" +
        "Instagram's Terms prohibit automated interaction. Accounts that automate " +
        "sending can be action-blocked, restricted, or permanently banned.\n\n" +
        "Insert-only (the default) puts the message in the composer and you press " +
        "Send yourself — that is the safer option.\n\n" +
        "You are responsible for your own account.",
      );
      if (!ok) { e.target.checked = false; return; }
    }
    await setOneClick(e.target.checked);
    toast(e.target.checked ? "Sending from the panel is ON — you still confirm each message" : "Off — insert-only (Sprill fills the composer, you press Send)");
    refreshCurrent(); renderQueue();
  });
  $("#auto-comment").addEventListener("change", async (e) => {
    // A separate acknowledgement from one-click send on purpose: accepting DM
    // automation is not the same as accepting public posting under your name.
    if (e.target.checked) {
      const ok = confirm(
        "Enable auto-post comments?\n\n" +
        "A comment is PUBLIC. If Sprill posts the wrong text, or on the wrong post, " +
        "everyone who follows that account can see it — including people who know you.\n\n" +
        "Instagram's Terms prohibit automated interaction, and automated commenting is one " +
        "of the patterns it enforces against hardest: accounts get comment-blocked, " +
        "shadow-limited, or banned.\n\n" +
        "Insert-only (the default) puts the text in the comment box and you press Post " +
        "yourself — that is the safer option.\n\n" +
        "You are responsible for your own account, and for what appears under your name.",
      );
      if (!ok) { e.target.checked = false; return; }
    }
    await setAutoComment(e.target.checked);
    toast(e.target.checked ? "Auto-post comments ON" : "Auto-post comments off (insert-only)");
    refreshCurrent();
  });
  // Staged-feature unlock: 5 clicks on the wordmark. Lets a shipped zip be
  // dogfooded without a code change; a store reviewer will never find it.
  let brandTaps = 0, brandTimer = null;
  const brand = document.querySelector(".brand");
  if (brand) {
    brand.addEventListener("click", async () => {
      clearTimeout(brandTimer);
      brandTimer = setTimeout(() => { brandTaps = 0; }, 1200);
      if (++brandTaps < 5) return;
      brandTaps = 0;
      await renderFlagRows();
      toast("Staged features unlocked in Settings");
    });
  }
  $("#tpl-save").addEventListener("click", async () => {
    const name = $("#tpl-name").value.trim();
    const body = $("#tpl-body").value.trim();
    if (!name || !body) return toast("Template needs a name and body");
    await saveTemplate({ id: $("#tpl-id").value || undefined, name, body, kind: $("#tpl-kind").value || "dm" });
    $("#tpl-id").value = ""; $("#tpl-name").value = ""; $("#tpl-body").value = ""; $("#tpl-kind").value = "dm";
    $("#batch-template").dataset.filled = "";
    toast("Template saved");
    loadSettings();
  });
  $("#tpl-clear").addEventListener("click", () => {
    $("#tpl-id").value = ""; $("#tpl-name").value = ""; $("#tpl-body").value = ""; $("#tpl-kind").value = "dm";
  });
  $("#daily-target").addEventListener("change", async (e) => {
    await setDailyTarget(e.target.value);
    toast(`Daily target: ${e.target.value}/day`);
    loadSettings();
  });
  $("#followup-days").addEventListener("change", async (e) => {
    await setFollowUpDays(e.target.value);
    toast(`Follow-up in ${e.target.value} day(s) after each send`);
  });
  $("#auto-enrich").addEventListener("change", async (e) => {
    await setAutoEnrichN(e.target.value);
    toast(Number(e.target.value) ? `Auto-enrich top ${e.target.value} after scan` : "Auto-enrich off");
  });
  $("#pace-min").addEventListener("change", async (e) => { await setPaceMinMs(e.target.value); toast(`Min gap ${Math.round(e.target.value / 1000)}s`); });
  $("#google-connect").addEventListener("click", async () => {
    if (!hasGoogle()) return toast("Google is not set up yet. See README.md, Optional cloud features");
    try { const u = await googleSignIn(true); toast("Connected " + (u.email || "")); loadSettings(); }
    catch (e) { toast("Sign-in failed: " + (e.message || e)); }
  });
  $("#google-signout").addEventListener("click", async () => { await googleSignOut(); toast("Signed out"); loadSettings(); });
  $("#sheet-export").addEventListener("click", async () => {
    if (!hasGoogle()) return toast("Connect Google first. See README.md, Optional cloud features");
    try {
      let ps = Object.values(await getProspects());
      if (selected.size) ps = ps.filter((p) => selected.has(refKey(p)));
      if (!ps.length) return toast("Nothing to export");
      toast("Exporting to Google Sheet…");
      const { url, updated, appended } = await exportToSheet(ps, await getCsvFields());
      toast(`Sheet updated — ${appended} added, ${updated} updated`);
      chrome.tabs.create({ url });
    } catch (e) { toast("Sheet export failed: " + (e.message || e)); }
  });
  $("#cloud-sync").addEventListener("click", async () => {
    if (!hasFirebase()) return toast("Cloud backup is not set up. See README.md, Optional cloud features");
    try { toast("Backing up…"); const { count } = await syncNow(); toast(`Backed up ${count} prospects`); loadSettings(); }
    catch (e) { toast("Backup failed: " + (e.message || e)); }
  });
  $("#open-privacy").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("privacy.html") }));
  $("#open-terms").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("terms.html") }));
  // Irreversible, and it sat one misclick away from "Reset counters" with no
  // confirmation at all — while merely ENABLING a setting got a full paragraph.
  // It wipes prospects, the outreach log, templates, drafts, the ICP and the
  // Google token. Nothing is recoverable without an export (the outreach log is
  // CSV-round-trippable as of 0.12.0, so an export IS a real backup now).
  $("#clear-all").addEventListener("click", async () => {
    const n = Object.keys(await getProspects()).length;
    if (!confirm(
      `Delete everything?\n\n` +
      `This erases ${n} lead${n === 1 ? "" : "s"}, your entire outreach history and every message ` +
      `you have logged, your templates, your unsent drafts, your targeting keywords and your Google ` +
      `connection.\n\nIt cannot be undone. Cancel and use Export CSV first if you want a backup — ` +
      `the export includes your outreach log and can be re-imported.`
    )) return;
    // Second gate. The first dialog is easy to dismiss on autopilot; typing the
    // word is not, and this is the only destructive action in the product.
    const typed = prompt('Type DELETE to confirm.');
    if ((typed || "").trim().toUpperCase() !== "DELETE") return toast("Cancelled — nothing was deleted");
    await clearAll();
    toast("All data cleared");
    await refreshQuota(); await loadSettings(); renderQueue(); refreshCurrent();
  });
}

// Built from FLAGS at runtime, so adding a flag to flags.js is the only step —
// the previous version hardcoded a single `recorder` row, which is exactly how it
// came to describe a feature that had already shipped.
async function renderFlagRows() {
  const row = $("#flag-row");
  const list = $("#flag-list");
  if (!row || !list) return;
  row.hidden = false;
  list.innerHTML = "";
  for (const name of Object.keys(FLAGS)) {
    const shippedOn = !!FLAGS[name];
    const label = el("label", "switch-row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = shippedOn || (await getFlagOverride(name));
    // flagOn() ORs the build flag with the local override, so a build-ON flag
    // cannot be forced off here. Showing a live toggle for it would be a lie.
    cb.disabled = shippedOn;
    cb.addEventListener("change", async (e) => {
      await setFlagOverride(name, e.target.checked);
      toast(e.target.checked
        ? `${name} on — reopen the panel`
        : `${name} off`);
      if (name === "recorder") await wireRecorder();
      renderQueue(); renderPipeline(); loadSettings();
    });
    label.append(cb, el("span", "", esc(name) + (shippedOn ? " — shipped, on for everyone" : " — off in this build")));
    list.append(label);
  }
}

// ---------- first-run onboarding ----------
// A 3-step overlay shown once, so a new user reaches a scored profile without
// having to find Settings and invent ICP keywords first. Picking a preset seeds
// real keywords (see ICP_PRESETS in store.js) — everything stays editable after.
let obStep = 1;
let obPick = null;

function obRender() {
  const dots = $("#ob-dots");
  dots.innerHTML = "";
  for (let i = 1; i <= 3; i++) dots.appendChild(el("i", i <= obStep ? "on" : ""));
  document.querySelectorAll(".ob-step").forEach((s) => {
    s.classList.toggle("is-active", Number(s.dataset.step) === obStep);
  });
  if (obStep === 2) setTimeout(() => $("#ob-biz").focus(), 30);
}

// Skipping still marks onboarding done (we don't nag), it just saves nothing.
async function obFinish(skipped) {
  if (!skipped) {
    if (obPick) await setICP({ keywords: obPick.keywords, description: obPick.description });
    const biz = $("#ob-biz").value.trim();
    if (biz) await chrome.storage.local.set({ businessName: biz });
  }
  await setOnboarded(true);
  $("#onboarding").hidden = true;
  await rescoreAll();          // apply the new ICP to anything already captured
  await refreshCurrent();
  await renderQueue();
  if (!skipped && obPick) toast(`Targeting set — ${obPick.label.toLowerCase()}`);
}

function startOnboarding() {
  obStep = 1;
  obPick = null;
  $("#ob-biz").value = "";
  $("#onboarding").hidden = false;
  obRender();
}

function wireOnboarding() {
  const wrap = $("#ob-presets");
  ICP_PRESETS.forEach((p) => {
    const b = el("button", "ob-preset", `<b>${esc(p.label)}</b><span>${esc(p.hint)}</span>`);
    b.addEventListener("click", () => { obPick = p; obStep = 2; obRender(); });
    wrap.appendChild(b);
  });
  $("#ob-back").addEventListener("click", () => { obStep = 1; obRender(); });
  $("#ob-next").addEventListener("click", () => { obStep = 3; obRender(); });
  $("#ob-biz").addEventListener("keydown", (e) => { if (e.key === "Enter") { obStep = 3; obRender(); } });
  $("#ob-done").addEventListener("click", () => obFinish(false));
  $("#ob-skip").addEventListener("click", () => obFinish(true));
  $("#rerun-onboarding").addEventListener("click", startOnboarding);
}

// ---------- tabs + boot ----------
function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("is-active"));
      document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("is-active"));
      btn.classList.add("is-active");
      $("#tab-" + btn.dataset.tab).classList.add("is-active");
      if (btn.dataset.tab === "profile") refreshCurrent();
      if (btn.dataset.tab === "queue") renderQueue();
      if (btn.dataset.tab === "pipeline") renderPipeline();
      if (btn.dataset.tab === "settings") loadSettings();
    });
  });
}

async function wireRecorder() {
  if (!(await flagOn("recorder"))) {
    $("#rec-card").hidden = true;
    return; // no listeners, no storage watcher — the feature does not exist
  }
  if (recWired) { await renderRecorder(); return; } // unlocked mid-session
  recWired = true;
  const dur = $("#rec-duration");
  dur.innerHTML = "";
  for (const m of DURATIONS) {
    const o = el("option", "", `${m} min`);
    o.value = String(m);
    if (m === DEFAULT_DURATION_MIN) o.selected = true;
    dur.appendChild(o);
  }
  const cap = $("#rec-cap");
  cap.innerHTML = "";
  for (const n of ENRICH_CAPS) {
    const o = el("option", "", `Top ${n}`);
    o.value = String(n);
    if (n === DEFAULT_ENRICH_CAP) o.selected = true;
    cap.appendChild(o);
  }

  $("#rec-start").addEventListener("click", startRecording);
  $("#rec-stop").addEventListener("click", stopRecording);
  $("#rec-discard").addEventListener("click", discardHarvest);
  $("#rec-stop-burst").addEventListener("click", () => {
    batchStop = true;
    toast("Stopping after this profile…");
  });
  $("#rec-evaluate").addEventListener("click", async () => {
    const s = recSession || (await readSession());
    if (s && s.status === "done") await evaluateMore();
    else await runBurst();
  });
  $("#rec-cull").addEventListener("click", cullSession);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[REC_KEY]) return;
    onSessionChanged(changes[REC_KEY].newValue);
  });

  // Self-heal a session whose tab died before the deadline: the content script
  // is the only timer holder, so nothing else would ever move it off "active".
  recSession = await reconcile();
  // A burst only runs while a panel is open, so an "enriching" session found at
  // boot belongs to a panel that was closed mid-burst — otherwise Evaluate stays
  // disabled forever with the handles stranded. (Two panels open at once would
  // both claim; the duplicate enrich is harmless, saveProspect merges.)
  if (recSession && recSession.status === "enriching") {
    recSession.status = "ended";
    await writeSession(recSession);
  }
  await renderRecorder();
  if (recSession && recSession.status === "ended") {
    $("#rec-progress").textContent = "Recording finished — ready to evaluate.";
  }
}

async function boot() {
  wireTabs();
  wireSettings();
  wireOnboarding();
  // Show the wizard before the heavy renders so a first-run user sees it instantly.
  if (!(await isOnboarded())) startOnboarding();
  $("#scan-btn").addEventListener("click", scanPage);
  $("#explore-btn").addEventListener("click", scanExplore);
  $("#explore-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); scanExplore(); }
  });
  $("#export-btn").addEventListener("click", () => exportCsv("queue"));
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#template-btn").addEventListener("click", downloadTemplate);
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // reset so re-picking the same file fires change again
    if (file) await importCsvFile(file);
  });
  // ---- Queue ----
  $("#shortlist-btn").addEventListener("click", shortlistSelected);
  $("#enrich-btn").addEventListener("click", enrichSelected);
  $("#removesel-btn").addEventListener("click", removeSelected);
  $("#sel-all").addEventListener("change", (e) => {
    // Only the keys currently in view — never something the filter is hiding.
    if (e.target.checked) lastQueueKeys.forEach((k) => selected.add(k));
    else lastQueueKeys.forEach((k) => selected.delete(k));
    renderQueue();
  });

  // ---- Pipeline ----
  $("#batch-send").addEventListener("click", batchSend);
  $("#batch-stop").addEventListener("click", () => { batchStop = true; toast("Stopping after current send…"); });
  $("#sl-draft").addEventListener("click", draftSelected);
  $("#pl-export").addEventListener("click", () => exportCsv("shortlist"));
  $("#pl-cull").addEventListener("click", openCull);
  $("#sl-unshortlist").addEventListener("click", async () => {
    const all = Object.values(await getProspects());
    const picks = slSelectedProspects(all);
    if (!picks.length) return toast("Tick some handles first");
    for (const p of picks) {
      await updateProspect(p, { status: STAGE.QUEUE, shortlistedAt: null });
      slSelected.delete(refKey(p));
    }
    toast(`Moved ${picks.length} back to the Queue`);
    renderPipeline(); renderQueue();
  });
  $("#sl-remove").addEventListener("click", async () => {
    const all = Object.values(await getProspects());
    const picks = slSelectedProspects(all);
    if (!picks.length) return toast("Tick some handles first");
    if (!confirm(`Remove ${picks.length} lead${picks.length === 1 ? "" : "s"} entirely?\n\n`
      + `They leave Sprill altogether, not just the shortlist. Use “← Back to Queue” if you `
      + `only meant to un-shortlist them.`)) return;
    for (const p of picks) { await removeProspect(p); slSelected.delete(refKey(p)); }
    toast(`Removed ${picks.length}`);
    renderPipeline(); renderQueue();
  });
  $("#sl-sel-all").addEventListener("change", (e) => {
    if (e.target.checked) lastSlKeys.forEach((k) => slSelected.add(k));
    else lastSlKeys.forEach((k) => slSelected.delete(k));
    renderPipeline();
  });

  // The cull reads the same bounds, so its label has to move when they do.
  buildFilterRow("q", () => { queueLimit = QUEUE_PAGE; renderQueue(); updateCullButton(); });
  buildFilterRow("sl", () => { slLimit = QUEUE_PAGE; renderPipeline(); });

  // ---- Outreach ----
  $("#refresh-status").addEventListener("click", refreshReadStatus);
  await wireRecorder();
  await rescoreAll();       // fix any stale/frozen scores on startup
  await refreshQuota();
  await refreshCurrent();
  await renderQueue();
  await renderPipeline();
  await updateAccountBar();

  // Re-read the current profile + active account when the user navigates IG.
  chrome.tabs.onActivated.addListener((info) => {
    if (tempTabs.has(info.tabId)) return;
    refreshCurrent(); updateAccountBar();
  });
  chrome.tabs.onUpdated.addListener((id, info) => {
    // Skip tabs we opened ourselves. Without this, every temp tab load during a
    // batch send or an enrich burst triggered a full Current re-render against
    // that temp tab — hundreds of times, and each one racing the last.
    if (tempTabs.has(id)) return;
    if (info.status === "complete") { refreshCurrent(); updateAccountBar(); }
  });
}

boot();
