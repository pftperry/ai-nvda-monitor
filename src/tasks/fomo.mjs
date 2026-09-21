/* Names for the wallets that matter, from FOMO's trader leaderboard.
 *
 * Their API runs the direction we do not want: handle -> wallet. The leaderboard
 * endpoint is the way round it, because each row carries the trader's verified
 * EVM wallet alongside the handle, so one request yields a hundred pairs we can
 * invert. The EVM address is the same on Base, BNB, Ethereum and Robinhood Chain,
 * so their wallets join against ours with no translation.
 *
 * Coverage grows by accumulation. One call sees the hundred traders ranked in that
 * window; the map keeps every pair it has ever seen, so a trader who ranks this
 * week and not next keeps their name. Measured on the first pull: three windows
 * gave 159 distinct wallets and named 12 of our top 25 holders, every one of them
 * flagged verified.
 *
 * THE KEY NEVER LEAVES CI. It is read from the environment, used for the request,
 * and never written to state, to the artifact, or to a log line. The published
 * file carries address-to-name pairs and nothing else, which is what the browser
 * needs and all it may have: the site is static, so anything the page can read is
 * public.
 *
 * The free tier is roughly a thousand calls a month and the indexer runs every
 * five minutes, so this is age-gated rather than run every time. Three windows
 * every six hours is about 360 calls a month, comfortably inside the allowance,
 * and trader rankings do not move fast enough for more to tell us anything.
 */
const BASE = "https://api.fomoapi.io/v2";
const WINDOWS = ["24h", "7d", "30d"];
const MIN_AGE_SECS = 6 * 3600;

export async function indexNames(opts = {}) {
  const log = opts.log || console.log;
  const key = process.env.FOMO_API_KEY;
  const prior = opts.prior || null;
  const names = new Map(Object.entries(prior?.names || {}));
  const now = Math.floor(Date.now() / 1000);

  if (!key) {
    /* No key configured is a normal state, not a failure: the ledger renders with
       addresses and the site is complete without this. */
    log("  fomo: no FOMO_API_KEY, keeping " + names.size + " known names");
    return { artifact: build(names, prior, now, "no key") };
  }
  const age = prior?.updatedAt ? now - prior.updatedAt : Infinity;
  if (age < MIN_AGE_SECS && !opts.force) {
    log("  fomo: names refreshed " + Math.round(age / 60) + "m ago, skipping (quota)");
    return { artifact: build(names, prior, prior.updatedAt, "cached") };
  }

  let added = 0, calls = 0, failed = 0;
  for (const w of WINDOWS) {
    try {
      const r = await fetch(`${BASE}/leaderboard/${w}?limit=100`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      calls++;
      if (!r.ok) { failed++; log("  fomo: " + w + " HTTP " + r.status); continue; }
      const j = await r.json();
      for (const t of j.traders || []) {
        const a = t.wallets?.evm;
        if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
        const addr = a.toLowerCase();
        /* Unverified rows are inference, not a claim the trader made, so they are
           kept out: a wrong name on a wallet we then accuse of dumping is worse
           than no name. */
        if (!t.wallets?.verified) continue;
        if (!names.has(addr)) added++;
        names.set(addr, {
          handle: t.handle || null,
          name: t.displayName || t.handle || null,
          followers: typeof t.followers === "number" ? t.followers : null,
        });
      }
    } catch (e) {
      failed++;
      /* the message can carry the request URL, and the URL carries no key -- it is
         in a header -- but say nothing about the error body to be certain */
      log("  fomo: " + w + " request failed");
    }
  }
  log(`  fomo: ${calls} call(s), ${failed} failed, ${added} new name(s), ${names.size} known`);
  return { artifact: build(names, prior, failed === WINDOWS.length && prior ? prior.updatedAt : now, "live") };
}

function build(names, prior, updatedAt, mode) {
  return {
    updatedAt: updatedAt || null,
    source: "fomoapi.io trader leaderboard, verified wallets only",
    mode,
    count: names.size,
    names: Object.fromEntries([...names].sort((a, b) => a[0] < b[0] ? -1 : 1)),
  };
}
