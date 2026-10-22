// Sprill — staged feature flags.
//
// This file is the ONLY thing that differs between the Chrome Web Store build
// and a later release that turns a staged feature on. Nothing in manifest.json
// changes, so the submitted zip and the follow-up build are byte-identical
// there — which is a nice property when a reviewer diffs them.
//
// NOTE: content scripts are classic scripts and cannot `import` this module.
// Do not duplicate a flag there. Instead, gate the *entry point* (the button
// that starts the feature) in the panel, and make the content-script half
// inert unless the panel has already created state for it.

export const FLAGS = {
  // "Record for X minutes" — passive handle capture on a timer while you browse.
  //
  // ON since 0.11.0. It was held back from the first store submission with no
  // recorded reason; it is a core feature, not a nice-to-have, so it ships.
  // Because it collects browsing activity it MUST be described prominently on
  // the Chrome Web Store listing, not only in the privacy policy — see
  // STORE_ELIGIBILITY.md risk 4.
  recorder: true,

  // Shared lead lists — cross-account lead sharing via a 20-char capability code.
  //
  // OFF for v1, deliberately, and this one is not a staging decision — it is a
  // policy and security decision. Two independent blockers:
  //
  //   1. The Chrome Web Store Limited Use tightening effective 1 Aug 2026 requires
  //      collected user data to be "strictly necessary to the extension's disclosed
  //      single purpose". This feature transfers NON-CONSENTING third parties'
  //      bios, emails and phone numbers between unrelated users. There is no
  //      version of that argument worth a first-submission rejection.
  //   2. firestore.rules grants any list member unconstrained write on
  //      `lists/{id}/prospects/{doc}`. A member can therefore delete every lead in
  //      the list, or overwrite another member's LOCAL record — including
  //      profileUrl and outlierTopUrl, which the panel passes straight to
  //      chrome.tabs.update/create. Before this ships the rules need a field
  //      allowlist plus a `sharedBy == request.auth.uid` check on write and delete,
  //      and pullFromList needs to treat every incoming field as untrusted.
  //
  // Turning this on without doing (2) ships a phishing vector. Do not flip it as
  // a convenience.
  lists: false,
};

// A flag is on if the build enables it, OR the user unlocked it locally.
// Never the other way round: a build-off flag can be unlocked for dogfooding,
// but a build-on flag can't be forced off by stale storage.
export async function flagOn(name) {
  if (FLAGS[name]) return true;
  try {
    const { flagOverrides = {} } = await chrome.storage.local.get({ flagOverrides: {} });
    return !!flagOverrides[name];
  } catch (_) {
    return false;
  }
}

export async function setFlagOverride(name, on) {
  const { flagOverrides = {} } = await chrome.storage.local.get({ flagOverrides: {} });
  flagOverrides[name] = !!on;
  await chrome.storage.local.set({ flagOverrides });
}

export async function getFlagOverride(name) {
  const { flagOverrides = {} } = await chrome.storage.local.get({ flagOverrides: {} });
  return !!flagOverrides[name];
}
