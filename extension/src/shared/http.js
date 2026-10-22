// Sprill — shared fetch retry.
//
// Google Sheets and Firestore both rate-limit per user, and the Sheets export
// is now a multi-request upsert: a single 429 halfway through would otherwise
// leave the sheet half-written. Retry on 429 and 5xx with exponential backoff
// plus jitter; never retry a 4xx that isn't 429, since those don't get better.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// call() must perform the request and return a Response.
export async function withRetry(call, { attempts = 4, baseMs = 500, label = "request" } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let r;
    try {
      r = await call();
    } catch (e) {
      // Network-level failure — retry the same way as a 5xx.
      last = e;
      if (i === attempts - 1) throw e;
      await sleep(baseMs * 2 ** i + Math.floor(Math.random() * 250));
      continue;
    }
    if (!RETRY_STATUS.has(r.status)) return r;
    last = r;
    if (i === attempts - 1) return r; // out of attempts — hand the response back

    // Honour Retry-After when the server sends one.
    const ra = Number(r.headers && r.headers.get && r.headers.get("Retry-After"));
    const wait = Number.isFinite(ra) && ra > 0
      ? ra * 1000
      : baseMs * 2 ** i + Math.floor(Math.random() * 250);
    console.debug(`[Sprill] ${label} got ${r.status}, retrying in ${wait}ms`);
    await sleep(wait);
  }
  return last;
}
