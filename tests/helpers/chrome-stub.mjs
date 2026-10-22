// Sprill — one chrome.* stub for every suite that needs one.
//
// Why this exists: store.js calls `chrome.storage.local.get(keys, cb)` in
// callback style (store.js:58,67-73,78-79) while sheets.js and auth.js call
// `await chrome.storage.local.get({...})` in promise style (sheets.js:62,85,90).
// Both are valid MV3 — Chrome returns a Promise when you omit the callback and
// undefined when you pass one. The suites used to carry two different stubs
// encoding two different beliefs about the platform. This one supports both, so
// the divergence is tested rather than assumed.

/**
 * Wrap a synchronous implementation so it works callback-style AND promise-style,
 * the way the real chrome.* APIs do.
 */
function dual(fn) {
  return (...args) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const out = fn(...args);
    if (cb) { cb(out); return undefined; }
    return Promise.resolve(out);
  };
}

/**
 * Install a fake `globalThis.chrome`.
 *
 * @param {object}   opts
 * @param {object}   opts.seed         initial contents of chrome.storage.local
 * @param {boolean}  opts.identity     also stub chrome.identity (sheets/auth need it)
 * @param {string[]} opts.permissions  what getManifest() reports; storageUsage()
 *                                     reads this to decide whether a quota
 *                                     percentage is meaningful at all
 * @returns handles for inspecting and perturbing the fake storage
 */
export function installChromeStub({ seed = {}, identity = false, permissions = ["storage", "unlimitedStorage"] } = {}) {
  let DB = structuredClone(seed);
  let failNext = null;

  const local = {
    QUOTA_BYTES: 10485760,
    // `keys` is an object of key -> default, which is the only form Sprill uses.
    get: dual((keys) => {
      const out = {};
      for (const [k, d] of Object.entries(keys || {})) out[k] = k in DB ? DB[k] : d;
      return out;
    }),
    set: (obj, cb) => {
      // Real chrome reports write failures through runtime.lastError inside the
      // callback rather than throwing. failNextSet() reproduces that exactly,
      // which is what store.js:67-73 is written to survive.
      if (failNext) {
        const message = failNext;
        failNext = null;
        chrome.runtime.lastError = { message };
        if (cb) { cb(); chrome.runtime.lastError = undefined; return undefined; }
        chrome.runtime.lastError = undefined;
        return Promise.reject(new Error(message));
      }
      Object.assign(DB, obj);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    remove: dual((keys) => {
      for (const k of [].concat(keys)) delete DB[k];
    }),
    getBytesInUse: dual(() => new TextEncoder().encode(JSON.stringify(DB)).length),
    clear: dual(() => { DB = {}; }),
  };

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ permissions: permissions.slice() }),
    },
    storage: { local },
    ...(identity ? { identity: { getRedirectURL: () => "https://ext.chromiumapp.org/" } } : {}),
  };

  return {
    /** Current contents of the fake storage. */
    db: () => DB,
    /** Replace the contents wholesale. */
    seed: (obj) => { DB = structuredClone(obj); },
    /** Make exactly the next set() fail with this lastError message. */
    failNextSet: (message = "QUOTA_BYTES quota exceeded") => { failNext = message; },
  };
}
