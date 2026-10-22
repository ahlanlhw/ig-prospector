// Sprill — Instagram content script (M0, zero-build).
//
// Runs on instagram.com. Extracts the PUBLIC profile the user is currently
// viewing, scans a page for visible handles, and inserts a draft into the DM
// composer. Everything is user-triggered from the side panel.
//
// NOTE ON FRAGILITY: Instagram's DOM/class names are obfuscated and change
// often. We lean on stable-ish signals first (og: meta tags, URL) and fall
// back to DOM heuristics. Selectors marked "tune on live IG" are the ones
// most likely to need adjustment against the live site. See PLAN.md §4.1.

(function () {
  "use strict";
  if (window.__igpLoaded) return; // avoid double-injection
  window.__igpLoaded = true;

  // Reserved first-path segments — these are Instagram's own routes, not people.
  // The second group was added for recording sessions: a one-shot Scan only ever
  // saw a page's worth of links, but a multi-minute passive session sweeps up
  // every footer and nav link on the site. Tune this against a real session.
  const RESERVED = new Set([
    "explore", "reels", "reel", "p", "direct", "stories", "accounts",
    "about", "directory", "web", "challenge", "tv", "igtv", "lite",
    "your_activity", "settings", "emails", "session", "graphql",
    // site chrome / footer / help routes
    "legal", "privacy", "terms", "developer", "developers", "api", "help",
    "press", "ads", "business", "creators", "topics", "locations", "nametag",
    "qr", "create", "favorites", "archive", "saved", "notifications",
    "instagram", "meta", "threads", "download", "blog", "jobs", "security",
    "oauth", "push", "data",
  ]);

  function segments() {
    return location.pathname.split("/").filter(Boolean);
  }

  const MEDIA_SEG = new Set(["p", "reel", "tv"]);

  // Sub-tabs of a profile. `/{handle}/reels/` IS that handle's profile — the
  // header, the og: tags and the embedded JSON are all still theirs — but
  // pageType() used to fall through to "other" for anything with two segments,
  // so the Current tab said "open a profile" while you were standing on one.
  // That is the tab a prospector actually browses on a creator account.
  //
  // NOTE the singular/plural distinction, and don't collapse it: "reel" is a
  // MEDIA_SEG (a permalink, `/reel/{code}/`), "reels" is this — the profile's
  // reels grid. They are different pages.
  const PROFILE_TABS = new Set([
    "reels", "tagged", "tv", "channel", "saved",
    // Instagram serves these as real routes on web, and the profile header is
    // still rendered above the list — so Current can capture the account while
    // Scan harvests the list. Both are useful at once.
    "followers", "following",
  ]);

  // A post/reel permalink, in either form Instagram serves:
  //   /p/{code}/  /reel/{code}/  /tv/{code}/
  //   /{username}/p/{code}/  /{username}/reel/{code}/
  // Returns null for anything else, including /{username}/reels/ — the profile's
  // reels TAB, which pageType() resolves to "profile" via PROFILE_TABS.
  function mediaFromPath(s) {
    if (s.length >= 2 && MEDIA_SEG.has(s[0].toLowerCase()) && /^[A-Za-z0-9_-]{5,}$/.test(s[1]))
      return { shortcode: s[1], kind: s[0].toLowerCase(), authorFromUrl: null };
    if (s.length >= 3 && MEDIA_SEG.has(s[1].toLowerCase()) && /^[A-Za-z0-9_-]{5,}$/.test(s[2]) &&
        !RESERVED.has(s[0].toLowerCase()))
      return { shortcode: s[2], kind: s[1].toLowerCase(), authorFromUrl: s[0] };
    return null;
  }

  function pageType() {
    const s = segments();
    if (s.length === 0) return "home";
    if (s[0] === "explore") return "explore";
    if (s[0] === "direct") return "direct";
    // MUST sit above the RESERVED check: "p" and "reel" are IN that set, which
    // is why post pages read as "other" today. RESERVED itself must NOT lose
    // them — it doubles as the handle blacklist for extractVisibleProfiles()
    // and extractViewer(), and the recorder would start saving "p" and "reel"
    // as prospect handles.
    if (mediaFromPath(s)) return "post";
    if (RESERVED.has(s[0].toLowerCase())) return "other";
    if (s.length === 1) return "profile";
    // A profile sub-tab is still that profile. extractCurrentProfile() reads
    // segments()[0] for the handle, which is already correct here, so nothing
    // downstream needs to know the difference.
    if (s.length === 2 && PROFILE_TABS.has(s[1].toLowerCase())) return "profile";
    return "other";
  }

  function meta(prop) {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    return el ? el.getAttribute("content") || "" : "";
  }

  // "15K", "1,234", "2.3M" -> number
  function parseCount(raw) {
    if (!raw) return null;
    const t = String(raw).trim().replace(/,/g, "").toUpperCase();
    const m = t.match(/^([\d.]+)\s*([KMB]?)$/);
    if (!m) {
      const n = parseInt(t.replace(/[^\d]/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    }
    const n = parseFloat(m[1]);
    const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
    return Math.round(n * mult);
  }

  // Decode Instagram's link-shim: https://l.instagram.com/?u=<encoded>&...
  function decodeIgLink(href) {
    try {
      const u = new URL(href, location.href);
      if (u.hostname.endsWith("l.instagram.com")) {
        const real = u.searchParams.get("u");
        if (real) return decodeURIComponent(real);
      }
      return u.href;
    } catch {
      return href;
    }
  }

  function extractContacts(text) {
    const out = { emails: [], phones: [], handles: [], urls: [] };
    if (!text) return out;
    const emails = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    const urls = text.match(/https?:\/\/[^\s)]+/gi) || [];
    // phone: loose international/local, 7+ digits
    const phones = text.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || [];
    const handles = text.match(/(?:^|\s)@([a-z0-9._]{2,30})/gi) || [];
    out.emails = uniq(emails.map((e) => e.toLowerCase()));
    out.urls = uniq(urls);
    out.phones = uniq(phones.map((p) => p.trim())).filter((p) => (p.replace(/\D/g, "").length >= 8));
    out.handles = uniq(handles.map((h) => h.trim().replace(/^@/, "")));
    return out;
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  // Best-effort bio text from the profile header. Tune on live IG.
  function extractBio(header) {
    if (!header) return "";
    // Prefer spans with dir="auto" that aren't the username/counts.
    const candidates = Array.from(
      header.querySelectorAll('span[dir="auto"], h1 + div, section span, div._aa_c, div[role="button"] + div')
    );
    let best = "";
    for (const el of candidates) {
      const t = (el.innerText || el.textContent || "").trim();
      if (!t) continue;
      if (/Followers|Following|Posts/i.test(t)) continue;
      if (t.length > best.length && t.length <= 500) best = t;
    }
    return best;
  }

  function extractLinks(header) {
    if (!header) return [];
    const anchors = Array.from(header.querySelectorAll("a[href]"));
    const links = anchors
      .map((a) => a.getAttribute("href") || "")
      .filter((h) => /l\.instagram\.com|^https?:\/\//i.test(h))
      .map(decodeIgLink)
      .filter((h) => !/instagram\.com\/(?!$)/i.test(new URL(h, location.href).pathname === "/" ? "x" : h) || /l\.instagram\.com/.test(h));
    return uniq(links);
  }

  // Instagram's STABLE numeric user id (pk). Unlike the @handle, it never
  // changes, so it's the durable key for a prospect. Not in a clean DOM slot —
  // we mine embedded JSON in the page's scripts. Tune on live IG.
  function extractUserId(username) {
    const html = document.documentElement.innerHTML;
    const uname = (username || "").toLowerCase();
    // ORDER MATTERS, and it used to be backwards.
    //
    // A logged-in Instagram page embeds JSON for the viewer, the suggestions
    // sidebar and the following list. The four unanchored patterns below match
    // ANY of those — so on a profile page they could return the VIEWER'S id.
    // They ran first; the two patterns that actually anchor on the target's
    // handle ran last, as a fallback.
    //
    // The consequence was silent data corruption, not a wrong display: keyFor()
    // prefers `id:<userId>` and findExistingKey() matches on userId FIRST, so two
    // different prospects that both mined the viewer's id collapse into ONE
    // record — and the second capture overwrites the first, outreach log included.
    //
    // extractAccountMeta() below documents this exact hazard and scopes for it.
    // This function now respects the same rule: anchored first, unanchored only
    // as a last resort.
    const anchored = uname ? [
      new RegExp(`"id"\\s*:\\s*"(\\d{3,})"\\s*,\\s*"username"\\s*:\\s*"${uname}"`, "i"),
      new RegExp(`"username"\\s*:\\s*"${uname}"[^}]*?"id"\\s*:\\s*"(\\d{3,})"`, "i"),
      new RegExp(`"pk"\\s*:\\s*"?(\\d{3,})"?[^}]*?"username"\\s*:\\s*"${uname}"`, "i"),
    ] : [];
    const patterns = [
      ...anchored,
      // Unanchored. Kept because a logged-OUT profile page often has only these,
      // and there the page belongs to exactly one account so the ambiguity does
      // not arise. On a logged-in page they are a guess, and they now only run
      // when every anchored pattern has failed.
      /"profile_id"\s*:\s*"?(\d{3,})"?/,
      /"owner"\s*:\s*\{\s*"id"\s*:\s*"(\d{3,})"/,
      /"user_id"\s*:\s*"?(\d{3,})"?/,
      /profilePage_(\d{3,})/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  // Account type + category + private flag for the TARGET profile.
  // IMPORTANT: a logged-in IG page embeds JSON for many OTHER accounts
  // (suggestions, your following, sidebar). Scanning the whole page for
  // "is_private":true false-positives on those and wrongly flags the target as
  // private — which was dropping every handle on enrich. So we scope to a window
  // around the target's own "username":"<uname>" block, and prefer the on-page
  // "This account is private" text (target-specific). Tune on live IG.
  function extractAccountMeta(username) {
    const uname = (username || "").toLowerCase();
    const html = document.documentElement.innerHTML;
    let scope = "";
    if (uname) {
      const esc = uname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`"username"\\s*:\\s*"${esc}"`, "i").exec(html);
      if (m) scope = html.slice(Math.max(0, m.index - 2000), m.index + 2000);
    }
    const inScope = (rx) => (scope ? rx.test(scope) : false);

    const isBiz = inScope(/"is_business_account"\s*:\s*true/);
    const isPro = inScope(/"is_professional_account"\s*:\s*true/);
    const accountType = isBiz ? "business" : (isPro ? "creator" : null);

    let category = null;
    const cm = scope.match(/"category_name"\s*:\s*"([^"]+)"/) || scope.match(/"category"\s*:\s*"([^"]{2,40})"/);
    if (cm && cm[1] && cm[1].toLowerCase() !== "none") category = cm[1];

    // Private: DOM text (only shown for the target you don't follow) OR the
    // target's own scoped JSON. Never the whole-page JSON.
    const bodyText = ((document.querySelector("main, section, header") || document.body).innerText || "");
    const domPrivate = /this account is private/i.test(bodyText);
    const isPrivate = domPrivate || inScope(/"is_private"\s*:\s*true/);
    return { accountType, category, isPrivate };
  }

  // Business-intent phrases in the bio — a reliable "this is a business/creator
  // worth contacting" signal that doesn't depend on IG's account-type flags.
  function extractBusinessSignals(bio) {
    if (!bio) return [];
    const t = bio.toLowerCase();
    const rules = [
      [/\bdm\s+(for|to|us|me|open)\b/, "DM for …"],
      [/\bfor\s+(business|collab|collabs?|booking|bookings?|enquir|inquir|pr|partnership|sponsor)/, "for business/collab"],
      [/\b(business|general|brand)\s+(enquir|inquir)/, "business enquiries"],
      [/\benquir|inquir/, "enquiries"],
      [/\bcollab(s|oration|orations)?\b/, "collabs"],
      [/\bpartnerships?\b/, "partnerships"],
      [/\bbook\s+(now|a\s+call|here|below)/, "book now"],
      [/\bemail\s+(for|us|me|:|👇|below)/, "email for …"],
      [/\bwork\s+with\s+(me|us)\b/, "work with me"],
      [/\bshop\s+(now|here|link)|link\s+in\s+bio/, "shop / link in bio"],
      [/\b(founder|co-?founder|ceo|owner|director)\b/, "founder/owner"],
      [/\bsponsor(ship|ed)?\b/, "sponsorship"],
      [/\bpr\s*[:|]|\bpr\s+&|\bpress\b/, "PR/press"],
    ];
    const hits = [];
    for (const [rx, label] of rules) if (rx.test(t)) hits.push(label);
    return Array.from(new Set(hits));
  }

  // ---- Grid post metrics (outlier detection) ----
  //
  // Numbers come from the JSON Instagram embeds in the page, but every number is
  // anchored to a shortcode taken from a DOM grid anchor — i.e. a post that is
  // definitionally on the page in front of us. That is the same discipline as
  // extractAccountMeta() above, which exists because an unscoped search matched
  // OTHER accounts' JSON (suggestions, sidebar) and was dropping every handle.
  //
  // It is also the defence against SPA staleness: after an in-app navigation the
  // original SSR blobs describe a different profile, its shortcodes will not
  // match the current anchors, mining yields nothing, and we fall back to the
  // DOM — which IS current. Never accept a mined number without its anchor.

  const MEDIA_HREF = /^\/(?:([A-Za-z0-9._]+)\/)?(p|reel|tv)\/([A-Za-z0-9_-]+)\//;

  // Strict parser for grid overlay counts. Returns null for anything it cannot
  // read EXACTLY, rather than parseCount()'s plausible-but-wrong fallback
  // ("15K views" -> 15). Unlike parseCount, 0 is a valid answer here.
  function parseCountStrict(raw) {
    if (raw == null) return null;
    const t = String(raw).replace(/[  ]/g, " ").trim().replace(/,/g, "").toUpperCase();
    const m = t.match(/^(\d+(?:\.\d+)?)\s*([KMB]?)$/);
    if (!m) return null;
    const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]];
    return Math.round(parseFloat(m[1]) * mult);
  }

  // Index every media-code marker in the page, in document order, so each post's
  // window can be CLAMPED to its neighbours. A media node routinely runs past
  // 3000 chars (image_versions2.candidates), so a fixed radius either truncates
  // the node or bleeds into the next post's numbers.
  //
  // "code" is a common JSON key (country codes, error codes), so this index has
  // false positives — but a spurious marker only makes a window SMALLER, which
  // loses data rather than inventing it. That is the correct failure direction.
  function mediaMarkers(html) {
    const rx = /"(?:short)?code"\s*:\s*"([A-Za-z0-9_-]{5,24})"/g;
    const out = [];
    let m;
    while ((m = rx.exec(html))) out.push({ i: m.index, code: m[1] });
    return out;
  }

  function windowFor(html, markers, shortcode, radius = 2500) {
    const at = markers.findIndex((k) => k.code === shortcode);
    if (at < 0) return null; // not on this page — do not guess
    const idx = markers[at].i;
    const lo = Math.max(at > 0 ? markers[at - 1].i : 0, idx - radius);
    const hi = Math.min(at < markers.length - 1 ? markers[at + 1].i : html.length, idx + radius);
    return html.slice(lo, hi);
  }

  function jsonNum(win, keys) {
    for (const k of keys) {
      const m = win.match(new RegExp(`"${k}"\\s*:\\s*(-?\\d{1,12})`));
      // like_count: -1 is Instagram's "hidden likes" sentinel. Letting it through
      // would give a median of -1 and make every post an infinite-ratio outlier.
      if (m) { const n = Number(m[1]); if (n >= 0) return n; }
    }
    return null;
  }
  function edgeCount(win, edge) {
    const m = win.match(new RegExp(`"${edge}"\\s*:\\s*\\{\\s*"count"\\s*:\\s*(\\d{1,12})`));
    return m ? Number(m[1]) : null;
  }

  // Grid <img alt> reads "Photo by <Name> on July 28, 2026. May be an image of…".
  // Day precision, and ENGLISH ONLY — null in every other Instagram locale, which
  // is acceptable for a fallback but means windowDays copy must not overclaim.
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  function dateFromAlt(a) {
    const img = a.querySelector("img[alt]");
    const alt = img ? img.getAttribute("alt") || "" : "";
    const m = alt.match(/\bon\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return null;
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return null;
    return Date.UTC(Number(m[3]), mo, Number(m[2]));
  }

  // Tiles currently rendered on a profile grid. The first paint is 3x4, so 12 is
  // what we can read without scroll-driving the page — which we deliberately
  // don't do. Returns raw per-post facts; the ANALYSIS lives panel-side in
  // shared/outliers.js, the same split as computeScore.
  function extractGridPosts(limit = 12) {
    const anchors = Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"], main a[href*="/tv/"]'));
    const html = document.documentElement.innerHTML; // serialized ONCE
    const markers = mediaMarkers(html);
    const out = [];
    const seen = new Set();

    for (const a of anchors) {
      if (out.length >= limit) break;
      const mm = MEDIA_HREF.exec(a.getAttribute("href") || "");
      if (!mm) continue;
      const shortcode = mm[3];
      if (seen.has(shortcode)) continue; // dedup on shortcode, not raw href
      seen.add(shortcode);

      const kind = mm[2];
      const pinned = !!a.querySelector('svg[aria-label*="pinned" i]');
      const win = windowFor(html, markers, shortcode);

      let plays = null, likes = null, comments = null, takenAt = null;
      let isVideo = kind !== "p";
      let src = "none";

      if (win) {
        src = "json";
        plays = jsonNum(win, ["play_count", "ig_play_count", "video_view_count", "view_count"]);
        likes = jsonNum(win, ["like_count"]);
        if (likes == null) likes = edgeCount(win, "edge_media_preview_like");
        if (likes == null) likes = edgeCount(win, "edge_liked_by");
        comments = jsonNum(win, ["comment_count"]);
        if (comments == null) comments = edgeCount(win, "edge_media_to_comment");
        const ts = jsonNum(win, ["taken_at", "taken_at_timestamp"]);
        if (ts) takenAt = ts * 1000; // Instagram ships UNIX SECONDS
        if (/"is_video"\s*:\s*true/.test(win) || /"media_type"\s*:\s*2/.test(win) ||
            /"product_type"\s*:\s*"clips"/.test(win)) isVideo = true;
      }

      // DOM fallback. innerText is read ONCE per tile and split on lines: the old
      // per-span loop reported the same number several times (IG nests spans) and
      // forced a layout flush for each one.
      if (plays == null && likes == null) {
        const nums = String(a.innerText || "")
          .split("\n").map((s) => s.trim()).filter(Boolean)
          .map(parseCountStrict).filter((n) => n != null);
        if (isVideo && nums.length) { plays = nums[0]; src = "dom"; }
        else if (nums.length) src = "dom-ambiguous"; // can't attribute — store nothing
      }
      if (takenAt == null) takenAt = dateFromAlt(a);

      out.push({
        shortcode, kind, isVideo, pinned,
        url: `https://www.instagram.com/${kind}/${shortcode}/`,
        plays, likes, comments, takenAt, src,
      });
    }
    return out;
  }

  // Console helper: the JSON-mining assumption above is unverified against live
  // Instagram. Run `window.__sprillGridDiag()` on a few profiles — if `json` is 0
  // everywhere, mining is dead on this account and outlier detection degrades to
  // reel view counts only (see the plan's risk 1).
  //
  // Run it on BOTH `/{handle}/` and `/{handle}/reels/` for the same account.
  // `reelsOnly` says whether the sample was all reels, so the two calls answer
  // whether the reels sub-tab is the richer source — which is the evidence
  // needed before pointing Enrich at that URL instead of the canonical one.
  window.__sprillGridDiag = function () {
    const posts = extractGridPosts(12);
    const by = (k) => posts.filter((p) => p.src === k).length;
    return {
      page: pageType(), url: location.pathname, tiles: posts.length,
      reelsOnly: posts.length > 0 && posts.every((p) => p.kind === "reel"),
      src: { json: by("json"), dom: by("dom"), ambiguous: by("dom-ambiguous"), none: by("none") },
      withPlays: posts.filter((p) => p.plays != null).length,
      withLikes: posts.filter((p) => p.likes != null).length,
      withDates: posts.filter((p) => p.takenAt != null).length,
      pinned: posts.filter((p) => p.pinned).length,
      sample: posts.slice(0, 3),
    };
  };

  function extractCurrentProfile() {
    if (pageType() !== "profile") return null;
    const username = segments()[0];
    const ogTitle = meta("og:title"); // "Name (@user) • Instagram photos and videos"
    const ogDesc = meta("og:description");

    let displayName = "";
    const nameMatch = ogTitle.match(/^(.*?)\s*\(@[^)]+\)/);
    if (nameMatch) displayName = nameMatch[1].trim();

    // Counts from og:description
    let followers = null, following = null, posts = null;
    const cm = ogDesc.match(
      /([\d.,KMB]+)\s+Followers,\s+([\d.,KMB]+)\s+Following,\s+([\d.,KMB]+)\s+Posts/i
    );
    if (cm) {
      followers = parseCount(cm[1]);
      following = parseCount(cm[2]);
      posts = parseCount(cm[3]);
    }

    // NO `|| document.body` FALLBACK.
    //
    // It used to widen to the whole document when `header` was missing, and
    // extractBio() then returned the longest span ON THE ENTIRE PAGE — a
    // suggested-user blurb, a "Followed by ... and 12 others" string, a cookie
    // banner. That text was scored, mined for business signals, and interpolated
    // into the DM the prospect reads, so the PROSPECT saw the breakage before the
    // user did. The same fallback also made `verified` true if any verified badge
    // existed anywhere on the page, and let extractLinks() harvest every external
    // link on it.
    //
    // No header means the profile did not render. An empty bio is the honest
    // answer, and looksLikeRealProfile() in store.js is built to reject it.
    const header = document.querySelector("header");
    const bio = extractBio(header);
    if (!displayName && header) {
      const h = header.querySelector("h1, h2");
      if (h) displayName = (h.innerText || "").trim();
    }
    const verified = !!(header && header.querySelector('svg[aria-label="Verified"]'));
    const acct = extractAccountMeta(username);
    const gridPosts = extractGridPosts(12);
    const businessSignals = extractBusinessSignals(bio);

    // Contacts: from bio text + header external links (incl. Linktree/link-in-bio)
    const headerLinks = extractLinks(header);
    const bioContacts = extractContacts(bio);
    const links = uniq([...headerLinks, ...bioContacts.urls]);
    const linkInBio = links.find((l) => /linktr\.ee|beacons\.ai|stan\.store|lnk\.bio|linkin\.bio|link\.tree|tap\.bio|carrd\.co/i.test(l)) || null;

    // Business "Email"/"Call" action buttons (label only in M0)
    const actionText = ((header && header.innerText) || "").toLowerCase();
    const hasEmailBtn = /(^|\s)email(\s|$)/.test(actionText);
    const hasCallBtn = /(^|\s)call(\s|$)/.test(actionText);

    return {
      platform: "instagram",
      userId: extractUserId(username),
      username,
      displayName: displayName || username,
      profileUrl: `https://www.instagram.com/${username}/`,
      bio,
      accountType: acct.accountType, // business | creator | null (best-effort)
      category: acct.category,       // e.g. "Digital creator", "Marketing agency"
      isPrivate: acct.isPrivate,     // scoped to target; only private accounts are dropped
      businessSignals,               // bio phrases like "DM for business enquiries"
      gridPosts,                     // up to 12 grid tiles w/ raw metrics (see outliers.js)
      followers,
      following,
      posts,
      verified,
      links,
      linkInBio,
      emails: bioContacts.emails,
      phones: bioContacts.phones,
      mentionedHandles: bioContacts.handles.filter((h) => h.toLowerCase() !== (username || "").toLowerCase()),
      publicContactButtons: [hasEmailBtn ? "email" : null, hasCallBtn ? "call" : null].filter(Boolean),
      sourceType: "current_profile",
      sourceUrl: location.href,
    };
  }

  // Scan the page for visible profile handles (followers dialog / explore /
  // search / commenters). Lightweight: usernames + urls only.
  //
  // `known` is a Set of already-harvested lowercase handles, passed by a
  // recording session. Two reasons it exists:
  //
  //  1. Cost. `innerText` forces a synchronous style+layout flush per anchor.
  //     Fine once per manual Scan; called every 1.5s over hundreds of anchors
  //     for twenty minutes it is a real jank source. Skipping known handles
  //     BEFORE touching text drops that to ~zero reads in steady state.
  //  2. Budget. With a fixed cap and no `known` set, the first N anchors in
  //     document order are the nav rail and the suggestion sidebar — so the
  //     followers dialog never gets reached. Learning site chrome on tick one
  //     and skipping it forever means the budget always goes to new content.
  //
  // Defaults keep GET_VISIBLE / scanPage() behaviour byte-identical.
  // ---- Explore tiles -> author handles -------------------------------------
  //
  // The Explore grid is entirely /p/<code> and /reel/<code> tiles, so the
  // single-segment rule below skips ALL of it: scanning Explore used to return
  // nav-rail and sidebar links while still stamping sourceType "explore". The
  // panel text has always promised Explore works, and it did not.
  //
  // 0.11.0 tried to fix that two ways, and BOTH are now dead. Measured on live
  // Instagram 2026-08-15, on a logged-in /explore/:
  //   1. The href prefix — MEDIA_HREF's optional /{user}/ group. Never present;
  //      every tile is a bare /p/{code}/.
  //   2. The embedded owner JSON. `"owner":{"username":"` -> 0 matches,
  //      `"shortcode":"` -> 0 matches (so windowFor had nothing to clamp to),
  //      and the ONLY "username" in the whole document was the viewer's own.
  // That is exactly the failure __sprillScanDiag was written to detect, and it
  // detected it. PLAN_v2.md §2 called this the least-proven code in the build.
  //
  // The replacement is the post's own public embed page. It is server-rendered,
  // names the author outright, and throws in the follower count and verified
  // badge for free. Measured: 7 of 8 real shortcodes resolved, ~500ms each,
  // 210-330 KB per response, no 429 at 400ms spacing. The 8th returned HTTP 200
  // with no UsernameText at all (a deleted or restricted post) — a normal miss,
  // which is why every path below returns null rather than throwing or guessing.
  //
  // `/p/{code}/embed/captioned/` is the canonical form for ALL media types: a
  // tile whose anchor says /reel/ or /tv/ still resolves through /p/.
  const EMBED_MAX_PER_SCAN = 12;     // product decision, not a technical limit
  const EMBED_TIMEOUT_MS = 8000;
  const EMBED_SCAN_BUDGET_MS = 45000; // stop STARTING requests past this
  const EMBED_COOLDOWN_MS = 300000;   // after a 429/401/403
  const EMBED_HIT_TTL_MS = Infinity;  // a resolved author is a fact for this page
  const EMBED_MISS_TTL_MS = 600000;   // a miss may be transient — retry after 10m
  const EMBED_MAX_ENTRIES = 800;      // an Explore session walks thousands of tiles

  // shortcode -> { username, followers?, verified, at } | { miss: true, at }
  // ONE map, deliberately: the old code kept a second `tileAuthors` map and that
  // is how two caches drift out of sync.
  const embedCache = new Map();
  let embedCooldownUntil = 0;
  let embedBusy = false;       // single-flight across the manual scan AND the
                               // recorder drain — they must never fetch at once
  let embedMissStreak = 0;     // a dead endpoint should be discoverable without
                               // anyone running the diagnostic

  function embedPaceMs() {
    // Mirrors recorder.js burstPaceMs(). A metronome-regular request pattern is
    // precisely what behavioural rate-limiting looks for, so this is jittered.
    return 1500 + Math.random() * 1500;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function embedUrl(shortcode) {
    // Reject before fetching: a shortcode is the only user-influenced part of
    // this URL and it comes off an href we did not write.
    if (!shortcode || !/^[A-Za-z0-9_-]{5,24}$/.test(shortcode)) return null;
    return `/p/${shortcode}/embed/captioned/`;
  }

  // (html) -> { username, followers?, verified } | null
  //
  // PURE. No DOM, no network — which is what lets it be unit-tested with no
  // jsdom and no install. Reject-on-doubt at every step: a wrong handle here
  // means DMing a stranger, so ambiguity is a miss, never a guess.
  function parseEmbed(html) {
    if (!html || typeof html !== "string") return null;

    const byText = /class="UsernameText"[^>]*>([^<]{1,40})</.exec(html);
    const byHref = /href="https:\/\/www\.instagram\.com\/([A-Za-z0-9._]{1,30})\/\?/.exec(html);

    const clean = (raw) => {
      if (!raw) return null;
      const s = String(raw).trim();
      // Never half-decode. If it carries an entity we don't handle, drop it.
      if (/&/.test(s)) return null;
      const lc = s.toLowerCase();
      if (!lc || lc.length > 30) return null;
      if (/[^a-z0-9._]/.test(lc)) return null;
      if (RESERVED.has(lc)) return null;
      return s;
    };

    const a = clean(byText && byText[1]);
    const b = clean(byHref && byHref[1]);
    // Both present and disagreeing means we are reading something that is not a
    // simple post embed. Bail rather than pick a side.
    if (a && b && a.toLowerCase() !== b.toLowerCase()) return null;
    const username = a || b;
    if (!username) return null;

    // Verified badge. The real markup, checked against a live embed of a verified
    // account (@nasa) and an unverified one:
    //   <span class="UsernameText">nasa</span>
    //   <i class="Sprite VerifiedSprite img sp_… sx_…"><u>Verified</u></i>
    // The unverified account's response contains the string "Verified" ZERO
    // times, so this is a clean signal rather than a heuristic.
    //
    // Anchored to a class attribute on purpose: the embed also carries the post
    // caption, and matching a bare word there would let someone mark themselves
    // verified by typing it. `VerifiedBadge` — the name this originally guessed
    // at — does not exist anywhere in the response.
    const out = { username, verified: /class="[^"]*\bVerifiedSprite\b/.test(html) };

    // Follower count: extract the NUMERIC TOKEN first, then parseCountStrict.
    // Not parseCount — parseCount("175K followers") returns 175, because its
    // anchored regex rejects the trailing word and falls through to parseInt on
    // the digits. A silent 1000x error. parseCountStrict exists for this trap
    // and returns null instead. When we can't read it, the key is OMITTED, not
    // set to null or 0: store.saveProspect() spreads whatever keys it is given,
    // and a 0 there would both survive into exports and suppress the
    // "Thin data extracted" concern in score.js.
    const fc = /class="FollowerCountText"[^>]*>([^<]+)</.exec(html);
    if (fc) {
      const tok = /^([\d.,]+\s*[KMB]?)\s*follower/i.exec(fc[1].trim());
      const n = tok ? parseCountStrict(tok[1]) : null;
      if (n != null) out.followers = n;
    }
    return out;
  }

  // (codes, cache, now, max) -> string[]
  //
  // PURE. The backlog is DERIVED, never stored: it is whatever is on screen
  // minus what the cache already answered. That is why "scan again continues
  // where it left off" falls out for free, and why a page reload costs only
  // refetches rather than correctness.
  function pickUnresolved(codes, cache, now, max) {
    const out = [];
    const seenCode = new Set();
    for (const code of codes) {
      if (out.length >= max) break;
      if (seenCode.has(code)) continue;
      seenCode.add(code);
      const hit = cache.get(code);
      if (hit) {
        if (!hit.miss) continue;                          // resolved already
        if (now - hit.at < EMBED_MISS_TTL_MS) continue;   // fresh miss, don't retry
      }
      out.push(code);
    }
    return out;
  }

  function embedCacheSet(code, val) {
    if (embedCache.size >= EMBED_MAX_ENTRIES) {
      // Oldest-first trim. Map preserves insertion order.
      let n = 200;
      for (const k of embedCache.keys()) { embedCache.delete(k); if (--n <= 0) break; }
    }
    embedCache.set(code, val);
  }

  // (shortcode) -> { username, followers?, verified } | null
  // null covers every failure: bad code, non-200, no author in the body,
  // timeout, network error. A miss is normal (1 in 8 live) and never throws.
  async function fetchEmbedAuthor(shortcode) {
    const url = embedUrl(shortcode);
    if (!url) return null;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), EMBED_TIMEOUT_MS) : null;
    try {
      // credentials:"omit" is LOAD-BEARING, not a default worth tidying away.
      // It keeps these reads off the user's logged-in session, which is the
      // whole reason this is safer than opening twelve background tabs. There
      // is a test asserting this exact init field — see tests/unit/embed.test.mjs.
      const res = await fetch(url, { credentials: "omit", signal: ctl ? ctl.signal : undefined });
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        embedCooldownUntil = Date.now() + EMBED_COOLDOWN_MS;
        return null;
      }
      if (!res.ok) return null;
      return parseEmbed(await res.text());
    } catch {
      return null;                    // abort, network error — a miss, not a crash
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function tileAnchors() {
    return document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]');
  }

  // Shortcodes of the post tiles currently in the DOM, in document order.
  function tileShortcodes() {
    const out = [];
    for (const a of tileAnchors()) {
      const mm = MEDIA_HREF.exec(a.getAttribute("href") || "");
      if (mm) out.push(mm[3]);
    }
    return out;
  }

  // Fill `seen` with authors of the post tiles currently on screen.
  //
  // `srcUrl`/`srcType` are captured by the CALLER before its first await and
  // threaded through, because there are awaits in the loop below: the user can
  // SPA-navigate mid-scan, and reading location.href at addProfile() time would
  // stamp records with a page they moved to afterwards.
  async function harvestTileAuthors(seen, limit, known, budget, srcUrl, srcType) {
    const stats = { tiles: 0, resolved: 0, fromCache: 0, misses: 0, pending: 0, throttled: false };
    const codes = tileShortcodes();
    stats.tiles = codes.length;

    // Free first: the href prefix, when Instagram emits it. It is one regex
    // group we already extracted, so it costs nothing measurable, and it is
    // exact when present. Deleting it would mean paying a 260 KB fetch for a
    // handle already sitting in the href.
    for (const a of tileAnchors()) {
      if (seen.size >= limit) break;
      const mm = MEDIA_HREF.exec(a.getAttribute("href") || "");
      if (mm && mm[1]) {
        embedCacheSet(mm[3], { username: mm[1], verified: false, at: Date.now() });
        addProfile(seen, mm[1], mm[1], known, "tile", srcUrl, srcType);
      }
    }

    // Then the cache — free too, and it is what makes a second Scan continue
    // rather than re-resolve.
    for (const code of codes) {
      if (seen.size >= limit) break;
      const hit = embedCache.get(code);
      if (!hit || hit.miss) continue;
      if (addProfile(seen, hit.username, hit.username, known, "tile", srcUrl, srcType,
                     { followers: hit.followers, verified: hit.verified })) {
        stats.fromCache++;
      }
    }

    const now = Date.now();
    const todo = pickUnresolved(codes, embedCache, now, Math.max(0, budget | 0));
    stats.pending = Math.max(0, pickUnresolved(codes, embedCache, now, 1e9).length - todo.length);
    if (!todo.length) return stats;

    if (embedBusy || now < embedCooldownUntil) {
      stats.throttled = now < embedCooldownUntil;
      stats.pending += todo.length;
      return stats;
    }

    embedBusy = true;
    const startedAt = Date.now();
    try {
      for (let i = 0; i < todo.length; i++) {
        if (seen.size >= limit) { stats.pending += todo.length - i; break; }
        if (Date.now() - startedAt > EMBED_SCAN_BUDGET_MS) { stats.pending += todo.length - i; break; }
        if (Date.now() < embedCooldownUntil) {
          stats.throttled = true;
          stats.pending += todo.length - i;
          break;
        }
        if (i > 0) await sleep(embedPaceMs());
        progress(i + 1, todo.length);
        const rec = await fetchEmbedAuthor(todo[i]);
        if (!rec) {
          embedCacheSet(todo[i], { miss: true, at: Date.now() });
          stats.misses++;
          if (++embedMissStreak === 8) {
            console.warn("[Sprill] 8 consecutive embed misses — /p/<code>/embed/captioned/ " +
                         "may have changed or be rate-limiting. Run window.__sprillEmbedDiag().");
          }
          continue;
        }
        embedMissStreak = 0;
        embedCacheSet(todo[i], { ...rec, at: Date.now() });
        if (addProfile(seen, rec.username, rec.username, known, "tile", srcUrl, srcType,
                       { followers: rec.followers, verified: rec.verified })) {
          stats.resolved++;
        }
      }
    } finally {
      embedBusy = false;
    }
    return stats;
  }

  function progress(done, total) {
    try {
      chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", done, total }, () => {
        void chrome.runtime.lastError;   // the panel may be closed; not an error
      });
    } catch { /* extension context gone mid-scan */ }
  }

  // Shared by both paths so the record shape can't drift between them.
  //
  // `srcUrl`/`srcType` are parameters rather than reads of location.href /
  // pageType(): the tile path awaits between calls, and an SPA navigation
  // mid-scan would otherwise stamp records with the page the user landed on
  // afterwards. The sync path passes today's values and is unchanged.
  //
  // `extra` carries optional followers/verified from the embed. Keys with no
  // value are OMITTED, never written as null or 0 — saveProspect() spreads what
  // it is given, and a 0 follower count would suppress score.js's thin-data
  // concern and survive into exports as fact.
  //
  // Returns true when a record was added, so callers can count.
  function addProfile(seen, rawName, text, known, via, srcUrl, srcType, extra) {
    const uname = String(rawName || "").toLowerCase();
    if (!uname) return false;
    if (RESERVED.has(uname)) return false;
    if (/[^a-z0-9._]/.test(uname)) return false;
    if (seen.has(uname)) return false;
    if (known && known.has(uname)) return false;
    const rec = {
      platform: "instagram",
      username: rawName,
      displayName: text && text.length <= 60 ? text : rawName,
      profileUrl: `https://www.instagram.com/${rawName}/`,
      sourceType: srcType || (pageType() === "explore" ? "explore" : "list"),
      sourceUrl: srcUrl || location.href,
      via,
    };
    if (extra) {
      if (typeof extra.followers === "number") rec.followers = extra.followers;
      if (extra.verified === true) rec.verified = true;
    }
    seen.set(uname, rec);
    return true;
  }

  function extractVisibleProfiles(limit = 60, known = null) {
    const anchors = document.querySelectorAll('a[href^="/"]');
    const seen = new Map();
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const s = href.split("/").filter(Boolean);
      if (s.length !== 1) continue;
      // These four cheap rejects stay INLINE, ahead of the text read: innerText
      // forces a layout flush, and the recorder calls this every 1.5s against a
      // list where most handles are already known.
      const uname = s[0].toLowerCase();
      if (RESERVED.has(uname)) continue;
      if (/[^a-z0-9._]/.test(uname)) continue;
      if (seen.has(uname)) continue;
      if (known && known.has(uname)) continue;
      const text = (known ? (a.textContent || "") : (a.innerText || "")).trim();
      addProfile(seen, s[0], text, known, "link");
      if (seen.size >= limit) break;
    }

    // NOTE: no tile resolution here, and this function MUST STAY SYNCHRONOUS.
    //
    // This is load-bearing, not stylistic. recHarvest() below calls it as
    //   const found = extractVisibleProfiles(HARVEST_LIMIT, recKnown);
    //   if (!found.length) { recEmptyTicks++; return; }
    // If this returned a Promise, `found.length` would be undefined, every
    // recorder tick would take the empty branch, recPending would never fill,
    // and the recorder card would cheerfully report "0 found" while harvesting
    // NOTHING — on followers lists and search too, not just Explore. recExpire()
    // makes the same synchronous call on the way out. Resolving tile authors now
    // costs a network round-trip, so it lives in scanVisibleProfiles() instead.
    return Array.from(seen.values());
  }

  // The async counterpart: everything extractVisibleProfiles finds, plus the
  // Explore tile authors, which cost one paced fetch each.
  //
  // Callers: GET_VISIBLE and __sprillScanDiag. NEVER the recorder tick — its
  // network path is recDrainTiles(), gated to idle ticks only.
  async function scanVisibleProfiles(limit = 60, opts = {}) {
    const budget = Math.max(0, opts.resolve | 0);
    const srcUrl = location.href;      // captured BEFORE any await, see addProfile
    const srcType = pageType() === "explore" ? "explore" : "list";

    const seen = new Map();
    for (const p of extractVisibleProfiles(limit, opts.known || null)) {
      seen.set(String(p.username).toLowerCase(), p);
    }

    let stats = { tiles: 0, resolved: 0, fromCache: 0, misses: 0, pending: 0, throttled: false };
    if (budget > 0 && pageType() === "explore" && seen.size < limit) {
      stats = await harvestTileAuthors(seen, limit, opts.known || null, budget, srcUrl, srcType);
    } else if (pageType() === "explore") {
      stats.tiles = tileShortcodes().length;
    }
    return { profiles: Array.from(seen.values()), ...stats };
  }

  // Console helper, same contract as __sprillGridDiag. ASYNC as of 0.18.0 —
  // `await` it, the DevTools console handles that fine.
  //
  // NOTE: content scripts run in an isolated world, so this is undefined in the
  // default DevTools console — switch the console's context dropdown from `top`
  // to the Sprill content script first.
  //
  //   await window.__sprillScanDiag()                 // resolves up to 12 tiles
  //   await window.__sprillScanDiag({ resolve: 0 })   // zero-network snapshot
  //
  // What you want to see on /explore/: `tiles` well above 0 and `resolved`
  // well above 0. `resolved` at 0 with `tiles` high means the embed endpoint is
  // no longer naming authors — send me the whole object, that's a code fix.
  // `throttled` true means Instagram is rate-limiting; wait five minutes.
  window.__sprillScanDiag = async function (opts = {}) {
    const t0 = Date.now();
    const budget = opts.resolve == null ? EMBED_MAX_PER_SCAN : opts.resolve;
    const r = await scanVisibleProfiles(200, { resolve: budget });
    const by = (k) => r.profiles.filter((p) => p.via === k).length;
    return {
      page: pageType(),
      url: location.href,
      tiles: r.tiles,
      found: r.profiles.length,
      via: { link: by("link"), tile: by("tile") },
      resolved: r.resolved,
      fromCache: r.fromCache,
      misses: r.misses,
      pending: r.pending,
      throttled: r.throttled,
      cacheSize: embedCache.size,
      cooldownMs: Math.max(0, embedCooldownUntil - Date.now()),
      ms: Date.now() - t0,
      sample: r.profiles.slice(0, 8).map((p) => `${p.username} (${p.via})`),
    };
  };

  // One-shot resolve of a single shortcode, so the endpoint can be verified in
  // isolation without running a whole scan. Paste the result when reporting.
  //   await window.__sprillEmbedDiag("Da2kbVtjFvm")
  window.__sprillEmbedDiag = async function (shortcode) {
    const t0 = Date.now();
    const url = embedUrl(shortcode);
    if (!url) return { ok: false, error: "bad_shortcode", shortcode };
    const rec = await fetchEmbedAuthor(shortcode);
    return {
      ok: !!rec,
      shortcode,
      url,
      result: rec,
      ms: Date.now() - t0,
      cooldownMs: Math.max(0, embedCooldownUntil - Date.now()),
    };
  };

  // ---- Post pages: author + comment box ----
  //
  // Returns only what the comment feature needs. Deliberately NO post metrics:
  // there is no data path between commenting and grid-outlier detection, and
  // keeping it that way is a product decision, not an oversight.
  function extractCurrentPost() {
    const m = mediaFromPath(segments());
    if (!m) return null;
    const html = document.documentElement.innerHTML;
    let username = m.authorFromUrl;
    let userId = null;

    // Shortcode-anchored window, same discipline as extractAccountMeta: an
    // unscoped search matches every OTHER account embedded in the page. And if
    // this shortcode isn't in the HTML at all, the blob is stale from an SPA
    // navigation — mine nothing, fall to the DOM, which IS current.
    const esc = m.shortcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchor = new RegExp(`"(?:short)?code"\\s*:\\s*"${esc}"`).exec(html);
    if (anchor) {
      const win = html.slice(Math.max(0, anchor.index - 3000), anchor.index + 3000);
      const om = win.match(/"owner"\s*:\s*\{[^{}]*?"username"\s*:\s*"([A-Za-z0-9._]+)"/) ||
                 win.match(/"user"\s*:\s*\{[^{}]*?"username"\s*:\s*"([A-Za-z0-9._]+)"/);
      if (om && !username) username = om[1];
      const im = win.match(/"owner"\s*:\s*\{[^{}]*?"id"\s*:\s*"(\d{3,})"/);
      if (im) userId = im[1];
    }

    // DOM fallback: the first single-segment profile link in the post header.
    if (!username) {
      const root = commentScope();
      const header = root.querySelector("header") || root;
      for (const a of header.querySelectorAll('a[href^="/"]')) {
        const seg = (a.getAttribute("href") || "").split("/").filter(Boolean);
        if (seg.length === 1 && !RESERVED.has(seg[0].toLowerCase()) && !/[^a-z0-9._]/i.test(seg[0])) {
          username = seg[0];
          break;
        }
      }
    }
    if (!username) return { shortcode: m.shortcode, kind: m.kind, author: null, error: "post_author_not_found" };

    const ogTitle = meta("og:title"); // "<Name> on Instagram: ..."
    const nm = ogTitle.match(/^(.*?)\s+on Instagram/);
    const viewer = extractViewer();
    return {
      shortcode: m.shortcode,
      kind: m.kind,
      postUrl: `https://www.instagram.com/${m.kind}/${m.shortcode}/`,
      author: { username, userId, displayName: nm ? nm[1].trim() : username },
      isOwnPost: !!(viewer && viewer.username && viewer.username.toLowerCase() === username.toLowerCase()),
      viewer,
    };
  }

  function commentScope() {
    return document.querySelector('div[role="dialog"] article') // post opened over the grid
      || document.querySelector("article")                      // permalink / feed
      || document.querySelector("main")
      || document.body;
  }

  // NOT a reuse of findComposer(): its fallback chain ends with document-wide
  // [contenteditable="true"] / textarea / [role="textbox"], which matches a
  // comment box (and vice versa). This one is scoped and has NO unscoped final
  // fallback — returning null is the correct answer when we can't be sure.
  function findCommentBox() {
    if (pageType() !== "post") return null;
    const root = commentScope();
    const sels = [
      'textarea[aria-label*="Add a comment" i]',
      'textarea[placeholder*="Add a comment" i]',
      'div[contenteditable="true"][aria-label*="Add a comment" i]',
      'div[role="textbox"][aria-label*="comment" i]',
      "form textarea",
      'form div[contenteditable="true"]',
    ];
    for (const s of sels) {
      const hit = Array.from(root.querySelectorAll(s)).find(isVisible);
      if (hit) return hit;
    }
    return null;
  }

  // /^post$/i collides with nav chrome (the create menu), so scope to the
  // comment form. Instagram mounts this only once text exists and often ships
  // it disabled, so call it AFTER inserting — same as sendInThread polling for
  // Send.
  function findCommentSubmit() {
    const root = commentScope();
    const form = root.querySelector("form") || root;
    const cands = Array.from(form.querySelectorAll('div[role="button"], button[type="submit"], button'));
    return cands.find((b) =>
      isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" &&
      /^(post|share)$/i.test((b.innerText || "").trim())) || null;
  }

  function commentDiag() {
    const root = commentScope();
    return {
      url: location.href, page: pageType(),
      hasArticle: !!document.querySelector("article"),
      forms: root.querySelectorAll("form").length,
      textareas: root.querySelectorAll("textarea").length,
      editables: root.querySelectorAll('[contenteditable="true"]').length,
      buttons: Array.from(root.querySelectorAll('div[role="button"], button')).slice(0, 8)
        .map((b) => (b.innerText || "").trim().slice(0, 20)),
    };
  }

  function insertComment(text, expect) {
    if (pageType() !== "post") return { ok: false, error: "not_a_post_page" };
    const cur = mediaFromPath(segments());
    if (expect && (!cur || cur.shortcode !== expect)) return { ok: false, error: "wrong_post" };
    const box = findCommentBox();
    if (!box) return { ok: false, error: "comment_box_not_found", diag: commentDiag() };
    return insertInto(box, text); // reused verbatim — it's element-agnostic
  }

  async function postComment(text, expect) {
    if (!text) return { ok: false, error: "empty_text" };
    if (pageType() !== "post") return { ok: false, error: "not_a_post_page" };
    const cur = mediaFromPath(segments());
    // MANDATORY. The user can SPA-navigate between the panel rendering the
    // composer and this firing. A public comment on the wrong post is the worst
    // failure mode in either feature.
    if (!cur || (expect && cur.shortcode !== expect)) return { ok: false, error: "wrong_post" };

    let box = findCommentBox();
    for (let i = 0; !box && i < 20; i++) { await wait(150); box = findCommentBox(); }
    if (!box) return { ok: false, error: "comment_box_not_found", diag: commentDiag() };
    const ins = insertInto(box, text);
    if (!ins.ok) return ins;
    const viewer = extractViewer();

    let btn = findCommentSubmit();
    for (let i = 0; !btn && i < 12; i++) { await wait(120); btn = findCommentSubmit(); }
    // NO Enter fallback here, unlike sendInThread. On a contenteditable box
    // Enter may insert a newline instead of submitting, and if it DOES submit we
    // can't tell that apart from a failed click without risking a duplicate —
    // and a duplicate PUBLIC comment is a different class of harm to a duplicate
    // DM. If the button isn't there, the text stays put and the user presses it.
    if (!btn) return { ok: false, error: "comment_submit_not_found", viewer };
    btn.click();

    // 500ms was not enough for a comment POST round-trip on a slow connection,
    // and a false negative here is the worst copy in the product: the panel told
    // the user "your text is still there, press Post" and the comment then
    // landed, so they posted it twice — publicly, under their own name.
    // Poll to ~3s, and if we still cannot tell, say we cannot tell.
    let leftover = text;
    let cleared = false;
    for (let i = 0; i < 20; i++) {
      await wait(150);
      const still = findCommentBox();
      leftover = still ? (still.value || still.innerText || "").trim() : "";
      if (!leftover) { cleared = true; break; }
    }
    if (cleared) return { ok: true, method: "click", viewer };
    if (leftover && leftover.length >= Math.min(8, text.length)) {
      // Full text still sitting there after 3s and a click that did nothing
      // visible. Safe to say it did not post.
      return { ok: false, error: "comment_not_submitted", viewer };
    }
    // Partially cleared, or a shape we don't recognise. Do NOT tell the user to
    // press Post again — a duplicate public comment is unrecoverable.
    return { ok: false, error: "comment_uncertain", viewer };
  }

  // ---- DM composer helpers (insert + one-click send) ----
  //
  // `offsetParent` is null for ANY position:fixed element, and Instagram renders
  // the DM composer and every modal inside fixed-position portals. The old
  // implementation therefore rejected the correct element and fell through to a
  // less specific candidate — which is what made a DM land in a comment box.
  // Measure the box instead.
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  // Scope for the DM composer. Mirrors commentScope(): a DM thread lives in
  // /direct/ or in a message dialog, and NOTHING outside that scope may be
  // treated as a composer.
  function composerScope() {
    return (
      document.querySelector('div[role="dialog"] div[aria-label="Message"]')?.closest('div[role="dialog"]') ||
      (pageType() === "direct" ? document.querySelector("main, section") : null) ||
      null
    );
  }

  // Deliberately NO document-wide fallback chain. The previous version ended in
  // a bare document.querySelector('[contenteditable="true"]'), so on any page
  // where the real composer was missing it returned the search box, or a comment
  // box — and sendInThread would then type the DM into it. findCommentBox() has
  // carried the same "no unscoped fallback" rule since it was written; this is
  // the other half of it.
  function findComposer() {
    const scope = composerScope();
    if (!scope) return null;
    const sels = [
      'div[aria-label="Message"][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Message" i]',
      'textarea[placeholder]',
      '[contenteditable="true"][role="textbox"]',
    ];
    for (const s of sels) {
      const vis = Array.from(scope.querySelectorAll(s)).find(isVisible);
      if (vis) return vis;
    }
    return null;
  }

  // Diagnostics when we can't find the composer — read from the console to tune.
  function composerDiag() {
    const ce = Array.from(document.querySelectorAll('[contenteditable="true"]'));
    const ta = Array.from(document.querySelectorAll("textarea"));
    const tb = Array.from(document.querySelectorAll('[role="textbox"]'));
    return {
      url: location.href, page: pageType(),
      contentEditable: ce.length, textareas: ta.length, textboxes: tb.length,
      labels: [...ce, ...ta, ...tb].slice(0, 6).map(
        (e) => e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("role") || e.tagName
      ),
    };
  }

  // The "Message" button on a profile opens the DM thread.
  function findMessageButton() {
    const c = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
    return c.find((b) => b.offsetParent !== null && /^message$/i.test((b.innerText || "").trim())) || null;
  }

  // The visible "Send" control next to the composer.
  function findSendButton() {
    const c = Array.from(document.querySelectorAll('div[role="button"], button'));
    return c.find((b) => b.offsetParent !== null && /^send$/i.test((b.innerText || "").trim())) || null;
  }

  // The logged-in ("viewer") account currently active in this tab — i.e. the
  // handle the DM will be SENT FROM. Matters when the user runs several IG
  // accounts. Best-effort: embedded JSON first, then the profile nav avatar.
  function extractViewer() {
    const html = document.documentElement.innerHTML;
    let username = null, userId = null;
    let m = html.match(/"viewer"\s*:\s*\{[^{}]*?"username"\s*:\s*"([^"]+)"/);
    if (m) username = m[1];
    m = html.match(/"viewer_?[iI]d"\s*:\s*"(\d+)"/);
    if (m) userId = m[1];
    if (!username) {
      // The nav "Profile" link points at the logged-in user's own handle and
      // holds their avatar (alt "... profile picture/photo").
      const links = Array.from(document.querySelectorAll('a[href^="/"]'));
      for (const a of links) {
        const img = a.querySelector("img[alt]");
        const alt = (img && img.getAttribute("alt")) || "";
        if (/profile picture|profile photo/i.test(alt)) {
          const seg = (a.getAttribute("href") || "").split("/").filter(Boolean);
          if (seg.length === 1 && !RESERVED.has(seg[0].toLowerCase())) { username = seg[0]; break; }
        }
      }
    }
    return username ? { username, userId } : null;
  }

  // Insert text into a composer element; dispatches events React listens for.
  // What the composer currently holds. Used to verify an insert actually
  // replaced rather than appended — see insertInto.
  function composerText(el) {
    if (!el) return "";
    return el.tagName === "TEXTAREA" ? (el.value || "") : (el.innerText || el.textContent || "");
  }
  const normText = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Empty the composer through the editor's OWN command pipeline.
  //
  // Instagram's DM composer is a Lexical editor: it keeps an internal selection
  // model and reconciles it from the DOM only when the browser tells it the
  // selection moved. Building a Range by hand and calling insertText in the same
  // tick is therefore NOT a replace — Lexical still believes the caret is where
  // the user left it, and the text lands at the END of what is already there.
  //
  // That is the mechanism behind a real observed failure: pressing Insert twice
  // produced one message containing the whole draft twice, it was sent that way
  // to a real prospect, and on a longer draft the doubled text tripped
  // Instagram's own length limit — which read as "your message is too long"
  // rather than as a bug in here.
  //
  // execCommand("selectAll") goes through the browser rather than around it, so
  // the editor sees the selection it is about to be asked to delete.
  function clearComposer(el) {
    if (!el) return;
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    document.execCommand("selectAll", false, null);
    if (composerText(el).trim()) document.execCommand("delete", false, null);
  }

  function writeInto(el, text) {
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    clearComposer(el);
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }

  // Insert, then READ THE BOX BACK. One retry, then an honest failure — never a
  // silent ✓ over a composer holding something other than what we were given.
  // `doubled` is called out separately because it is the specific shape of the
  // bug above and it is the one a caller must never send.
  function insertInto(el, text) {
    if (!el) return { ok: false, error: "composer_not_found" };
    const want = normText(text);
    try {
      el.focus();
      writeInto(el, text);
      if (normText(composerText(el)) === want) return { ok: true, verified: true };
      // Second attempt: clear explicitly, then write again.
      clearComposer(el);
      writeInto(el, text);
      const got = normText(composerText(el));
      if (got === want) return { ok: true, verified: true };
      return {
        ok: false,
        error: "insert_mismatch",
        doubled: got === normText(String(text) + String(text)),
        wantLen: want.length,
        gotLen: got.length,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function insertDraft(text) {
    return insertInto(findComposer(), text);
  }

  function dispatchEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Click the profile's "Message" button to open the DM thread. The PANEL
  // orchestrates the navigation (this just clicks); it returns immediately.
  function openDM() {
    const btn = findMessageButton();
    if (!btn) return { ok: false, error: "message_button_not_found" };
    btn.click();
    return { ok: true };
  }

  // Insert into an ALREADY-OPEN composer and send. Does NOT navigate — the
  // panel makes sure we're in the thread first. Click Send, fall back to Enter.
  // Waits for the composer to appear (thread may still be rendering).
  async function sendInThread(text) {
    if (!text) return { ok: false, error: "empty_text" };
    // MANDATORY, and the mirror of postComment's shortcode check. The panel
    // navigates to /direct/ before calling this, but that navigation can time
    // out (IG sometimes opens the thread as an in-page dialog, or serves a
    // challenge at the same URL) and the panel used to discard the result. If we
    // are not demonstrably in a DM thread we do not type anything anywhere.
    if (pageType() !== "direct" && !document.querySelector('div[role="dialog"] div[aria-label="Message"]')) {
      return { ok: false, error: "not_a_dm_thread", page: pageType() };
    }
    let el = findComposer();
    for (let i = 0; !el && i < 30; i++) { await wait(150); el = findComposer(); } // poll ~4.5s, returns instantly when ready
    if (!el) {
      const diag = composerDiag();
      console.debug("[Sprill] composer_not_found", diag);
      return { ok: false, error: "composer_not_found", diag };
    }
    const ins = insertInto(el, text);
    if (!ins.ok) return ins;
    const viewer = extractViewer(); // the account this DM is sent FROM
    // Try to click Send as soon as it appears (poll briefly rather than sleep).
    let sendBtn = findSendButton();
    for (let i = 0; !sendBtn && i < 10; i++) { await wait(120); sendBtn = findSendButton(); }
    if (sendBtn) { sendBtn.click(); return { ok: true, method: "click", viewer }; }
    // Enter fallback. Only reachable now that we've proven we're inside a DM
    // scope — before the composerScope() change this could fire on a comment box
    // and publish the DM text publicly.
    el.focus();
    dispatchEnter(el);
    // Poll rather than sleep once: 200ms was not enough on a slow connection, and
    // a false "still there" reads to the user as "press send again".
    let leftover = text;
    for (let i = 0; i < 20; i++) {
      await wait(150);
      const still = findComposer();
      leftover = still ? (still.value || still.innerText || "").trim() : "";
      if (!leftover) break;
    }
    if (leftover && leftover.length >= Math.min(8, text.length)) {
      console.debug("[Sprill] send_control_not_found — text still in composer");
      return { ok: false, error: "send_control_not_found", viewer };
    }
    // The box cleared, but we never saw a Send control — so we are inferring the
    // send from an empty box, which a re-render also produces. Flag it so the
    // panel can tell the user to eyeball the thread instead of silently logging.
    return { ok: true, method: "enter", unverified: true, viewer };
  }

  // Best-effort read/reply status for an open DM thread. IG shows "Seen" under
  // the last sent message once read. Reply detection is approximate. Tune on live IG.
  function readThreadStatus() {
    // The old version scoped to `main`, which in a DM view INCLUDES the
    // conversation sidebar — so any other thread showing "Seen" marked this
    // prospect as read, and so did the words "Seen it, thanks" in a message
    // body. Read state is the product's headline number; a false positive
    // fabricates it and sends a follow-up to someone who never opened the first
    // message.
    //
    // Scope by finding the composer and walking up to the thread pane. The
    // sidebar never contains the composer, so this excludes it structurally
    // rather than by guessing at obfuscated class names.
    if (pageType() !== "direct" && !document.querySelector('div[role="dialog"] div[aria-label="Message"]')) {
      return { seen: null, hasReply: null, page: pageType(), reason: "not_a_dm_thread" };
    }
    const composer = findComposer();
    let pane = null;
    for (let el = composer; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.5) { pane = el; break; }
    }
    if (!pane) return { seen: null, hasReply: null, page: pageType(), reason: "thread_pane_not_found" };

    // IG renders the marker as the LAST thing under the last outgoing message,
    // so only the tail of the pane is a legitimate place to find it. Looking at
    // the whole pane would re-admit "Seen it, thanks" from any message body.
    const text = (pane.innerText || "").trim();
    const tail = text.split("\n").slice(-4).join("\n");
    const seen = /\bSeen\b/.test(tail);
    // Reply detection over the DOM is unreliable, so we leave it to the user's
    // manual "Reply" mark and only auto-set the read/seen state here.
    // `seen: false` here means "we looked in the right place and it wasn't
    // there", which is different from the `null` returns above.
    return { seen, hasReply: false, page: pageType() };
  }

  // -------------------------------------------------------------------------
  // Recording session ("Record for X minutes")
  //
  // THIS BLOCK MUST NOT TOUCH chrome.storage. It is a classic script and cannot
  // import shared/recorder.js, so it has no access to the key names — and more
  // importantly, two Instagram tabs harvesting at once would silently lose
  // batches through overlapping read-modify-write cycles. Every write goes
  // through the service worker, which serializes them. Ask, don't write.
  //
  // Everything here is inert unless a session already exists. The only thing
  // that can create one is the flag-gated Record button in the panel, so this
  // costs one sendMessage at document_idle when the feature is off.
  // -------------------------------------------------------------------------

  const TICK_MS = 1500;      // rows survive several seconds in IG's virtualized
  const IDLE_TICK_MS = 4000; // list at human scroll speed; 1.5s catches them
  const IDLE_AFTER = 5;      // consecutive empty ticks before backing off
  const FLUSH_AT = 25;       // pending records
  const FLUSH_MS = 8000;
  const HARVEST_LIMIT = 400; // per tick, vs. 60 for a manual Scan
  const REC_TILE_BUDGET = 60; // embed resolutions per SESSION — without a cap a
                              // 20-minute sit on Explore becomes 300 requests

  let rec = null;                 // the active session
  let recKnown = new Set();       // lowercase handles already harvested
  let recPending = [];            // not yet flushed to the SW
  let recDirty = true;            // start dirty so tick 1 harvests
  let recEmptyTicks = 0;
  let recTilesResolved = 0;       // against REC_TILE_BUDGET, per session
  let recTimer = null;
  let recObserver = null;
  let recLastUrl = location.href;
  let recLastFlush = 0;

  // The extension context dies on reload/update; without this the tick throws
  // every 1.5s forever.
  function alive() {
    try { return !!chrome.runtime && !!chrome.runtime.id; } catch (_) { return false; }
  }
  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError; // panel closed / SW asleep — not fatal
          resolve(r || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  function recTeardown() {
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
    if (recObserver) { recObserver.disconnect(); recObserver = null; }
    rec = null;
    recPending = [];
    recKnown = new Set();
  }

  function recSchedule() {
    clearTimeout(recTimer);
    recTimer = setTimeout(recTick, recEmptyTicks >= IDLE_AFTER ? IDLE_TICK_MS : TICK_MS);
  }

  async function recFlush(force) {
    if (!rec || !recPending.length) return;
    if (!force && recPending.length < FLUSH_AT && Date.now() - recLastFlush < FLUSH_MS) return;
    const batch = recPending;
    recPending = [];
    recLastFlush = Date.now();
    const r = await ask({ type: "REC_HARVEST", id: rec.id, records: batch });
    if (r && r.stale) recTeardown();          // session superseded or ended
    else if (r && r.capped) recTeardown();    // MAX_HARVEST — stop observing
  }

  function recHarvest() {
    const found = extractVisibleProfiles(HARVEST_LIMIT, recKnown);
    if (!found.length) { recEmptyTicks++; return; }
    recEmptyTicks = 0;
    for (const p of found) {
      recKnown.add(p.username.toLowerCase());
      recPending.push(p);
    }
  }

  async function recExpire() {
    if (!rec) return;
    const id = rec.id;
    if (pageType() !== "direct") recHarvest();
    await recFlush(true);
    await ask({ type: "REC_FINALIZE", id });
    recTeardown();
  }

  // Is the session allowed to spend a network request on this tick?
  //
  // PURE, so the gate can be unit-tested without a DOM or a clock. The whole
  // point is condition 1: `emptyTicks >= IDLE_AFTER` is the SAME variable
  // recSchedule() uses to pick IDLE_TICK_MS, so by construction a drain can only
  // happen on a tick that was scheduled at 4s. That is how "the 1.5s hot tick
  // never touches the network" is guaranteed rather than merely intended.
  function canDrainTiles(s) {
    return !!s
      && s.active
      && s.page === "explore"
      && s.emptyTicks >= IDLE_AFTER
      && s.visible
      && !s.busy
      && s.now >= s.cooldownUntil
      && s.used < REC_TILE_BUDGET;
  }

  // At most ONE resolution per idle tick — roughly one request per 4s, gentler
  // than the manual scan's own pace.
  async function recDrainTiles() {
    if (!canDrainTiles({
      active: !!rec,
      page: pageType(),
      emptyTicks: recEmptyTicks,
      visible: document.visibilityState === "visible",
      busy: embedBusy,
      now: Date.now(),
      cooldownUntil: embedCooldownUntil,
      used: recTilesResolved,
    })) return;

    const todo = pickUnresolved(tileShortcodes(), embedCache, Date.now(), 1);
    if (!todo.length) return;

    embedBusy = true;
    let rc;
    try {
      rc = await fetchEmbedAuthor(todo[0]);
    } finally {
      embedBusy = false;
    }

    // REC_STOP can land via the message listener while that await is pending.
    // Harvesting into a torn-down session would push records nobody flushes.
    if (!alive() || !rec) return;

    recTilesResolved++;
    if (!rc) { embedCacheSet(todo[0], { miss: true, at: Date.now() }); return; }
    embedCacheSet(todo[0], { ...rc, at: Date.now() });

    const uname = String(rc.username).toLowerCase();
    if (recKnown.has(uname)) return;
    const seen = new Map();
    if (addProfile(seen, rc.username, rc.username, recKnown, "tile",
                   location.href, "explore", { followers: rc.followers, verified: rc.verified })) {
      recKnown.add(uname);
      recPending.push(seen.get(uname));
    }
    // Deliberately NOT resetting recEmptyTicks. If a successful resolution reset
    // it, the recorder would drop back to hot 1.5s ticks for three cycles after
    // every hit and the drain rate would oscillate instead of settling.
  }

  async function recTick() {
    if (!alive()) return recTeardown();
    if (!rec) return;
    if (Date.now() >= rec.endsAt) return recExpire();

    if (location.href !== recLastUrl) {
      recLastUrl = location.href;
      recDirty = true;          // SPA navigation. Patching history.pushState
      recEmptyTicks = 0;        // would not work — content scripts run in an
    }                           // isolated world and never see the page's call.

    if (recDirty) {
      recDirty = false;
      // Never harvest a user's own DM contact list.
      if (pageType() !== "direct") recHarvest();
    }
    await recFlush(false);
    // Ticks are a setTimeout chain, not an interval, so this await stretches the
    // gap to the next tick rather than overlapping one.
    await recDrainTiles();
    if (!rec) return;           // recDrainTiles awaited; a stop may have landed
    recSchedule();
  }

  function recArm(session, known) {
    recTeardown();
    rec = session;
    recKnown = new Set(known || []);
    recDirty = true;
    recEmptyTicks = 0;
    recTilesResolved = 0;      // the tile budget is per SESSION, not per tab
    recLastUrl = location.href;
    recLastFlush = Date.now();

    // childList + subtree only. `attributes` and `characterData` are where
    // Instagram's chattiness lives (hover, video frames, intersection-driven
    // class toggles) and would fire constantly for nothing.
    //
    // The callback does NOT iterate mutations — it sets a boolean. The
    // observer is a change *notifier*; the tick is the only reader.
    recObserver = new MutationObserver(() => { recDirty = true; });
    recObserver.observe(document.body, { childList: true, subtree: true });

    // Body is right, not <main>: followers/following dialogs mount into
    // portals near the body, outside main.
    recSchedule();
  }

  // Flush on the way out so a tab close or a background switch doesn't lose
  // the tail of a batch.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") recFlush(true);
  });
  window.addEventListener("pagehide", () => { recFlush(true); });

  // On load (including every full page reload mid-session), ask the service
  // worker whether a session is live. Returns the harvested handles too, so
  // the dedup set is rebuilt in one round-trip.
  async function recBoot() {
    const r = await ask({ type: "REC_RESUME" });
    if (!r || !r.session) return;
    if (Date.now() >= r.session.endsAt) {
      await ask({ type: "REC_FINALIZE", id: r.session.id });
      return;
    }
    recArm(r.session, r.known);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg && msg.type) {
          case "PING":
            sendResponse({ ok: true, page: pageType(), url: location.href });
            break;
          case "GET_VIEWER":
            sendResponse({ ok: true, viewer: extractViewer() });
            break;
          case "GET_CURRENT_PROFILE":
            sendResponse({ ok: true, page: pageType(), profile: extractCurrentProfile() });
            break;
          case "GET_VISIBLE": {
            // `resolve` is the embed budget. It defaults to 0, so every caller
            // that doesn't ask for it keeps today's zero-network behaviour; it
            // is only ever spent on Explore.
            const r = await scanVisibleProfiles(msg.limit || 60, { resolve: msg.resolve | 0 });
            sendResponse({ ok: true, page: pageType(), ...r });
            break;
          }
          case "INSERT_DRAFT":
            sendResponse(insertDraft(String(msg.text || "")));
            break;
          case "OPEN_DM":
            sendResponse(openDM());
            break;
          case "SEND_MESSAGE":
            sendResponse(await sendInThread(String(msg.text || "")));
            break;
          case "COMPOSER_DIAG":
            sendResponse({ ok: true, diag: composerDiag() });
            break;
          case "GET_POST":
            sendResponse({ ok: true, page: pageType(), post: extractCurrentPost() });
            break;
          case "INSERT_COMMENT":
            sendResponse(insertComment(String(msg.text || ""), msg.shortcode || null));
            break;
          case "POST_COMMENT":
            sendResponse(await postComment(String(msg.text || ""), msg.shortcode || null));
            break;
          case "COMMENT_DIAG":
            sendResponse({ ok: true, diag: commentDiag() });
            break;
          case "THREAD_STATUS":
            sendResponse({ ok: true, status: readThreadStatus() });
            break;
          case "REC_START":
            recArm(msg.session, msg.known || []);
            sendResponse({ ok: true });
            break;
          case "REC_STOP":
            await recExpire();
            sendResponse({ ok: true });
            break;
          case "REC_STATUS":
            sendResponse({
              ok: true,
              active: !!rec,
              found: rec ? recKnown.size : 0,
              pending: recPending.length,
              tilesPending: pageType() === "explore"
                ? pickUnresolved(tileShortcodes(), embedCache, Date.now(), 1e9).length : 0,
              tilesResolved: recTilesResolved,
            });
            break;
          default:
            sendResponse({ ok: false, error: "unknown_message" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep channel open for async sendResponse
  });

  // -------------------------------------------------------------------------
  // Fixture capture — turns one manual console call into a permanent test.
  //
  // The two diagnostics above tell a human whether mining works TODAY. They
  // cannot tell you it stopped working next month, because nothing re-runs them.
  // This copies the serialized page to the clipboard so it can be saved under
  // tests/fixtures/ and asserted against forever — see tests/unit/extract.test.mjs.
  //
  // ⚠️ A fixture from a logged-in session contains YOUR handle, your suggestions
  // sidebar, and possibly your session-scoped ids. Scrub it before committing.
  // The reminder is printed on every call rather than left in a doc.
  window.__sprillDumpFixture = async function () {
    const html = "<!doctype html>\n" + document.documentElement.outerHTML;
    const info = { page: pageType(), url: location.href, bytes: html.length };
    try {
      await navigator.clipboard.writeText(html);
      console.log("[Sprill] fixture copied to clipboard", info);
    } catch (e) {
      // Clipboard writes need a focused document and can be blocked. Fall back to
      // returning the string, which is still paste-able out of the console.
      console.log("[Sprill] clipboard blocked — returning the HTML instead", info, e);
      return html;
    }
    console.log(
      "[Sprill] SCRUB BEFORE COMMITTING: this contains your own handle and " +
      "whatever accounts Instagram put in your sidebar. Save to " +
      "tests/fixtures/<name>.html"
    );
    return info;
  };

  // -------------------------------------------------------------------------
  // Test seam.
  //
  // Fourteen functions above are pure (html | DOM) -> object, and they hold
  // essentially every fragile assumption in the product — yet they had ZERO
  // automated coverage, because this file is an IIFE with no exports and content
  // scripts are classic scripts that cannot be ES modules.
  //
  // This block is the cheapest seam that fixes it: `module` is undefined in a
  // browser, so it is dead code there, and it makes the extractors require-able
  // from a .cjs test running against jsdom. Ugly, zero-risk, and it unlocks
  // regression coverage for the layer most likely to break on an IG deploy.
  //
  // Anything added here MUST stay a pure function of the DOM — or, since 0.18.0,
  // pure given the injected `fetch`. `fetchEmbedAuthor` is exported because the
  // test harness supplies its own fetch through the compile's parameter list, so
  // it does no I/O the test didn't hand it. Do not export anything that writes
  // storage or clicks.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      segments, mediaFromPath, pageType, meta, parseCount, parseCountStrict,
      decodeIgLink, extractContacts, extractBio, extractLinks, extractUserId,
      extractAccountMeta, extractBusinessSignals, extractGridPosts,
      extractVisibleProfiles, extractViewer, extractCurrentProfile,
      extractCurrentPost, analyzeGridSource: mediaMarkers,
      // 0.18.0 — Explore tile authors via the post's public embed page.
      parseEmbed, embedUrl, pickUnresolved, fetchEmbedAuthor, canDrainTiles,
      scanVisibleProfiles,
      __embedCache: embedCache,
      __embedState: () => ({ cooldownUntil: embedCooldownUntil, busy: embedBusy }),
      __resetEmbed: () => { embedCache.clear(); embedCooldownUntil = 0; embedBusy = false; embedMissStreak = 0; },
    };
  }

  console.debug("[Sprill] content script ready:", pageType(), location.href);
  recBoot();
})();
