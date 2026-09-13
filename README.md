# AI / NVDA Monitor

Live on-chain monitor for the **Artificial Inu (`AI`) / `NVDA`** Uniswap v4 pair on
**Robinhood Chain** (chain id `4663`), built to answer three questions:

1. **Flow** — is AI being net bought or net sold, right now, and at what imbalance?
2. **Float** — how much AI is permanently gone (burned + vault-locked) and how much is
   immobilised as pool inventory, leaving what actually free to trade?
3. **Routing** — how much volume passes *through* AI as a bridge between other tokens,
   which is the mechanism the liquidity-hub thesis rests on?

Everything is read from chain logs. There is no backend and no database: an indexer writes
JSON into `web/data/`, and the page is static. The indexer uses a dedicated RPC endpoint when
`RPC_URL` is set in the environment (a GitHub Actions secret in CI) and the chain's public
endpoint otherwise; the key never appears in a file or an artifact. The browser page reads
live state from the public endpoint directly.

```
npm run index      # full backfill (~59 days of history) into web/data/
npm run index:fast # quick mode: shorter windows, fewer pools
npm run verify     # assert the invariants below; exits non-zero if any fail
npm run serve      # http://localhost:8099
```

No dependencies — Node 20+ and nothing else. Re-running `index` is **incremental**:
each pool stores a resume cursor, so a refresh only scans blocks since the last run.
Use `--rebuild` to force a full re-scan.

## Built for a phone

The primary viewing surface is an iPhone, so the mobile path is the designed one
rather than a fallback:

- Charts size their `viewBox` to real container pixels and re-render on resize. They are
  deliberately **not** stretched with `preserveAspectRatio="none"`, which distorts every
  axis glyph.
- Tooltips work on touch (`touchstart`/`touchmove`), and on a narrow screen they pin to the
  top of the chart instead of following the finger — which would put them under it.
  A single overlay picks the nearest bar, because a fingertip is far wider than one bar.
- 44px minimum touch targets; 16px form controls so iOS Safari does not zoom on focus;
  `viewport-fit=cover` plus safe-area insets for the notch; momentum scrolling on wide
  tables; the tab row scrolls horizontally rather than wrapping.
- Stat tiles stay two-up on a phone so the page does not become a scroll marathon, and
  `apple-mobile-web-app-*` tags make Add to Home Screen behave like an app.

## Why it is built this way

The public RPC sends `access-control-allow-origin: *`, so the **browser can query the
chain directly**. Live state (head block, supply, latest pool price) is therefore read
client-side on a 20s timer, while the expensive history comes from pre-indexed JSON.
That makes the whole thing hostable on GitHub Pages for free, with a scheduled Action
refreshing the data.

Blockscout is behind Cloudflare and rejects programmatic access, so nothing here depends
on an explorer API.

## Verification log

No address below was taken from a directory or a social post. Each was established by
tracing real on-chain behaviour, and the figures quoted were true at the time of writing.

| Role | Address | How it was established |
|---|---|---|
| v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Has code; emits the Swap/Initialize/ModifyLiquidity topics observed in a log histogram |
| AI token | `0x2e8c31162b855a2ffa90f6f8634643ad6f111e18` | `symbol()` = `AI`; exactly one mint event ever, of 1,000,000,000 |
| NVDA stock token | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | `name()` = `NVIDIA • Robinhood Token`; total supply only ~95,308 |
| LONG hook | `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544` | The `hooks` field of the AI/NVDA pool's `Initialize` event; shared by ~4,870 pools |
| Fee splitter | `0x4f6c50a87bf234c45191f88ed4cbb9f021b7dc67` | Source of 910 of the 911 AI burn transfers; holds no balance (splits atomically) |
| Community vault | `0xd14d2eeb9648f53fa153a218eeed908789c28630` | Destination of the splitter's AI and NVDA legs; no outflow observed |
| Platform fee recipient | `0x4a0cb7eef4b4dc31c75eac705e03463cfc3c5cb2` | Receives exactly half the burn leg's size on every split |
| AI/NVDA pool | `0xcbdfea90…f2f1ce27` | First pool ever created containing AI, at block 9,721,433 |

### Things worth knowing that are not obvious

**The fee is dynamic, and it really is 0.70%.** The AI/NVDA pool's `Initialize` event
carries fee `0x800000`, which is v4's dynamic-fee sentinel rather than a rate — the hook
sets the rate per swap. Reading the `fee` field off live `Swap` logs shows it resolving to
`7000` pips, i.e. 0.70%.

**The fee split is measured, not assumed — and the filter matters.** The split must be
read from the splitter's *own outflows*, constraining both `from` and `to`. Summing
everything that merely lands on the platform address conflates the fee leg with that
wallet's other income and reports the split as `1 : 1 : 6.06` instead of the truth. Measured
correctly over one 400k-block window, the vault received 8,459.63 AI and `0x0` received
exactly 8,459.63 AI, with 4,229.81 going to the platform receiver — burn and lock move in
lockstep. The indexer re-measures every run rather than hardcoding the ratio, and `verify`
asserts the lockstep relationship while allowing the platform share to move, since its size
is a policy choice rather than a structural fact.

**Buy vs sell is easy to get backwards.** In the v4 `Swap` event, `amount0`/`amount1` are
the *swapper's* deltas, so a positive AI delta means the trader **received** AI — a buy.
This was verified rather than assumed: across 484 consecutive AI/NVDA swaps, a negative AI
delta coincided with a falling pool price **483 times and a rising price zero times**,
which is only possible if a negative delta means AI flowing into the pool. The resulting
buy/sell skew independently matches GeckoTerminal's counts for the same window, and the
price computed from `sqrtPriceX96` (1.3037e-3 NVDA per AI) matches its reported
0.00132279.

**Pool existence means nothing.** v4 lets anyone initialise a pool for any
(pair, fee, tickSpacing, hook) combination, and the LONG launchpad creates one per launch,
so there are **5,396** pools containing AI of which only ~470 have ever seen a swap. Every
ranking here is by measured activity, never by existence.

**κ is measurable.** The valuation writeup treats cross-routing intensity as
"hardly measurable" and assigns it (0.05 / 0.20 / 0.25 / 0.30). It is directly observable:
a `BONER → AI → MEME` rotation emits two `Swap` logs under one transaction hash, one where
the trader receives AI and one where they spend it. AI is a pass-through hop exactly to the
extent those legs overlap, so `min(AI received, AI spent)` per transaction is routed
volume, and the remainder is genuine directional demand. The dashboard reports the measured
figure against that model's four scenarios. A first measurement over a ~0.7-day window put
it at **37.7% of direct volume**, between the writeup's "bull" (34%) and "extra-bull" (40%)
assumptions — worth treating as provisional until it has been watched over longer windows.

**Native launches are not bridges.** A token the LONG launchpad created against AI settles
~100% of its volume on its AI pair by construction — OPEN, HENT and DANGEROUS all measure
98–99%. That is a fact about how the token was minted, not evidence that AI is winning
flow. Tokens are therefore labelled `native` or `organic` (had its own venues first, grew
an AI pool later) and the two populations are summarised separately, because a blended
average would badly flatter the hub thesis.

**Supply reconciles exactly.** `1,000,000,000 − burned = live totalSupply`. The page
asserts this on the Method tab and fails loudly if it ever stops holding.

## RPC constraints the indexer has to survive

- `eth_getLogs` caps at **10,000 logs** per query and times out on wide ranges. The scanner
  halves its chunk on either failure and creeps back up after a success, so it adapts to
  log density instead of using a fixed window.
- Logs come back with **`blockTimestamp` zeroed**, so block times are sampled every 250k
  blocks and interpolated. Production is steady at ~0.102 s/block (~845,649 blocks/day),
  which keeps interpolation error well inside the one-hour buckets.
- The endpoint rate-limits, so calls are spaced and retried with backoff.

## Layout

```
src/
  config.mjs        verified contract map and constants
  rpc.mjs           adaptive log scanner, batching, backoff
  decode.mjs        event decoders + the sign-convention proof
  timemap.mjs       block -> time by sampled anchors
  tokens.mjs        batched symbol/decimals/balance resolution
  store.mjs         resumable cursor state + data writer
  indexer.mjs       orchestrator
  tasks/
    pools.mjs       pool discovery and activity ranking
    flow.mjs        hourly buy/sell aggregation
    burns.mjs       burn / lock / vault ledger, and the measured effective fee rate
    routing.mjs     measured cross-routing (κ), incremental by day, self-repairing
    depth.mjs       tick-ladder liquidity, near-spot bands
    bridges.mjs     AI-pair share per token
    launchpad.mjs   LONG-hook census, launch cadence, token prices as a series
    holders.mjs     balance replay: counts, concentration, churn, cohorts, whale tape
    prices.mjs      NVDA in dollars from its own USDG pool (2-3 calls a run)
    kpis.mjs        hourly panel of every dial input beside price, for the weighting study
  verify.mjs        ~110 invariants; gates the deploy
  audit.mjs         cross-derivations; reports only
  smoke.mjs         offline tests of the pure task logic; gates CI before indexing
tools/
  backfill-holders.mjs   genesis replay of the holder state (--rebuild writes the seed)
  cards.mjs              social cards from the artifacts
web/
  index.html  style.css  app.js
  data/             generated JSON (committed, so Pages can serve it)
```

## The two dials

The Investor View opens with two dials instead of a rating word. **Structure** ranks the
protocol's inputs (fee capture, toll leakage, hub conversion κ, AI's share of new LONG pools,
NVDA accretion, fee run-rate trend); **Demand** ranks what holders are doing (net flow, wallets
above a fixed AI balance, distinct buyers, near-spot book lean, launch cadence, the live tail).
Each input is a trailing-7-day level ranked inside AI's own last 30 days, inputs are
equal-weighted within a dial, and a reading is taken over the pair. `web/data/kpis.json`
records every input hourly so the weights can be earned from evidence later. Neither dial is a
price forecast, and the page says so.

## Deploying

Enable GitHub Pages (Settings → Pages → Source: GitHub Actions). The included workflow
re-indexes on a schedule, commits refreshed data, and publishes `web/`.

## Limits

- Volumes are denominated in AI and each pool's quote token, **not converted to USD** —
  the chain has no single reliable USD oracle and mixing one in would distort history. The
  header shows a USD cross-check from a public aggregator, clearly separated.
- AI-pair share is measured over a recent window, not all time.
- PoolManager AI inventory is an aggregate across all pools, attributed to AI in total
  rather than split per pool.

Not investment advice.
