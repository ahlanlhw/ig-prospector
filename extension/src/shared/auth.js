// Sprill — Google sign-in via chrome.identity (zero-build, REST).
// Uses the OAuth 2.0 implicit flow through launchWebAuthFlow so it works from
// the side panel without the Firebase SDK. Requires CONFIG.GOOGLE_OAUTH_CLIENT_ID
// and the extension's redirect URL registered on the OAuth client (README.md, Optional cloud features).

import { CONFIG } from "./config.js";

// drive.file = only files THIS app creates/opens (minimal; avoids restricted-
// scope audit). openid/email/profile for identity.
//
// ⚠️ Do NOT add "…/auth/spreadsheets" back. Google classifies that scope as
// SENSITIVE, which forces OAuth app verification + brand verification (weeks of
// review) before the consent screen can leave Testing mode. drive.file is
// NON-sensitive and is sufficient here: sheets.js only ever touches the single
// spreadsheet it created itself via ensureSheet(), and drive.file grants full
// access to app-created files. Broad Sheets access buys us nothing and costs
// the entire verification timeline.
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid", "email", "profile",
].join(" ");

function parseHash(redirectUrl) {
  const out = {};
  const h = (redirectUrl.split("#")[1] || "");
  for (const kv of h.split("&")) {
    const [k, v] = kv.split("=");
    if (k) out[k] = decodeURIComponent(v || "");
  }
  return out;
}

export async function signIn(interactive = true) {
  if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID) throw new Error("google_not_configured");
  const redirect = chrome.identity.getRedirectURL();
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CONFIG.GOOGLE_OAUTH_CLIENT_ID)}` +
    "&response_type=token" +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    (interactive ? "&prompt=consent" : "");
  const res = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!res) throw new Error("no_response");
  const { access_token, expires_in } = parseHash(res);
  if (!access_token) throw new Error("no_token");
  let who = {};
  try {
    who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    }).then((r) => r.json());
  } catch (_) {}
  const google = {
    token: access_token,
    expiresAt: Date.now() + (Number(expires_in) || 3500) * 1000,
    email: who.email || null,
    name: who.name || null,
    sub: who.sub || null,
  };
  await chrome.storage.local.set({ google });
  return google;
}

export async function getGoogleUser() {
  const { google } = await chrome.storage.local.get({ google: null });
  return google;
}

// A valid token, refreshing silently (then interactively) if expired.
export async function getToken() {
  const { google } = await chrome.storage.local.get({ google: null });
  if (google && google.token && google.expiresAt - 60000 > Date.now()) return google.token;
  try { return (await signIn(false)).token; } catch (_) {}
  return (await signIn(true)).token;
}

export async function signOut() {
  await chrome.storage.local.remove(["google", "sheetId"]);
}
