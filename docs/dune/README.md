# Matching LONG's Dune dashboard

The site's RWA figures follow the definitions in Nate Benesh's dashboard
(dune.com/natan_benish2001/long-on-robinhood-chain) so that our numbers agree with the
protocol's own posts. `queries.sql` holds every public query in the dependency graph of
its counters, fetched 17 Sep 2026 through Dune's `FindQuery` GraphQL (Cloudflare blocks
non-browser clients; fetch from a page at dune.com). Re-fetch when the dashboard changes.

## The definitions, as identifiers

| Piece | Dune | Where |
|---|---|---|
| LONG launches | `LaunchCreated` topic0 `0xadc6f1f7…267b` from factories `0x9c88…0845`, `0x22e9…eeed`, `0x1eef…2104`; asset = topic2, numeraire = topic3 (address(0) → WETH `0x0bd7…ad73`); since 2026-07-01 | 8032167 |
| LONG pools | v4: PoolManager `Initialize` (`0xdd466e67…6438`) with hook `0x4e34…a544` at data[77:97], matched to a launch by currency pair. Graduated: `Airlock.Migrate` (`0x2a05bb71…22ca`) on `0xeb7c…0862`, asset = topic1, pool = topic2 | 8032178 |
| LONG swaps | Hook event topic0 `0x1d9f7b5e…7183` on the hook; sender = topic1, poolId = topic3, amount0/amount1 int256 at data[97], data[129]. Graduated v2 `Swap` `0xd78ad95f…d822`, v3 `Swap` `0xc42079f9…ca67` on the migrated pool. Numeraire leg only. Buyback = sender `0x6f02324d…0f77`. Trader = tx.from | 8032229 |
| Prices | Hourly, forward-filled. Feed tokens: Chainlink aggregator `AnswerUpdated` (`0x0559884f…fc5f`), answer = topic1 / 1e8, 30-token feed map incl. WETH and USDG. Feedless stocks: hourly USDG-weighted VWAP of settlement prints (tx moving stock + USDG; per-tx MAX leg; per-symbol sanity band; ±10% of hourly median), 38-token watch list. Pairs quoted in AI or memecoins have no price row and are excluded by design | 8032188, 8391616 |
| Volume | Σ numeraire amount × hourly price at the trade's hour. Gross includes buyback legs; user excludes them. Headline "Total Volume" = gross since 2026-07-01; "24h" = NOW() − 24h | 8032287 |
| Stock TVL | Per stock: Σ pool-perspective numeraire delta over v4 swaps of unmigrated pools (buybacks included) + ERC-20 transfer accounting for graduated pools; × latest price. Circulating supply = mints − burns (Transfer from/to zero) | 8032293, 8032324 |
| Stock universe | Token registry: creations from `0x4783c67b…c046` event `0xd9b0c6a1…76d6` since 2026-06-01 (name, symbol in data) plus Rialto-wrapped tokens created by `0x8bc71ae8…169e`; drop names containing "Dollar"; asset_class by name (treasury / commodity / etf / stock). 394 tokens on 17 Sep | 8071980 |
| Market volume | `dex.trades` (every decoded DEX) since 2026-07-01 (widget) / 2026-07-10 (RWA dashboard), rows with exactly one stock side; stock/stock excluded; "routed legs" excluded (a row with no launchpad token inside a tx that also has a stock × launchpad row). USD = `amount_usd`, else stock raw/1e18 × hourly price (8076065: feeds matched by ticker regex on aggregator bytecode, Rialto-VWAP fallback). Plus Rialto: txs `to` `0x4262efbd…c7e8` containing a stock Transfer; per tx MAX USDG Transfer / 1e6 | 8071940, 8237276 |
| Stock-pair share | LONG legs (other side is a LONG asset) ÷ all stock × launchpad-token rows; launchpad set = 7979183 (`launchpad <> 'other'`) ∪ LONG assets. All-time, 7d and 24h columns | 8237276 |
| Stock-trading share | LONG legs ÷ (all stock rows excl. routed legs + Rialto). All-time since 2026-07-01 | 8237276 |
| Trader share | distinct tx.from of stock-side `dex.trades` since 2026-06-01 ∪ Rialto tx senders, vs distinct non-buyback LONG traders | 8237922 |

## Where the indexer differed on 17 Sep 2026

| Metric | Dune | Ours | Cause |
|---|---|---|---|
| Total LONG volume | $1.332B | $1.374B (+3.2%) | we valued every trade at today's price; Dune at the hour's price |
| Share of all stock trading | 15.9% | 20.9% since launch, 24.5% 24h | universe 169 vs 394 tokens; venues v4 + Rialto only (a v3 factory `0x1f7d7550…2efa` and a v2 factory `0x8bceaa40…937f` exist); Rialto counted from a fill event, not per tx |
| Stock TVL | $14.5M | $14.6M | agrees |
| Share of tokenized stock | 9% | 9.3% | agrees (denominator = total value of registry tokens) |
| Stock-pair share, trader share | 37.7%, 30.6% | not computed | missing |
| Rialto, same day | | $1.23M daily vs $26K rolling | two folds disagree; the tx-based definition replaces both |

## Measured on chain, 17-18 Sep 2026

- **Registry**: the stock factory has announced **204** tokens (182 stock, 16 etf, 3 commodity, 3 treasury) after dropping names containing "Dollar". Our bytecode universe had 169 and every one of them is in the registry, so the gap is 35 listed tokens we never counted (ARM, GLW, NOK, FICO, BND, INOD, XNDU, JEPQ, CRDO and others). Dune reports 394 rows because its registry also carries the Rialto-wrapped copies.
- **Feeds**: **65** Chainlink aggregators exist on the chain. `description()` returns the same string Dune regexes out of the aggregator's bytecode ("Robinhood PLTR / USD", "RHNVDA / USD"), so an `eth_call` replaces the bytecode regex. Dune's LONG-side price map is a hard-coded 30 plus a 38-token derived list; live discovery is a superset, so our LONG volume can exceed his for pairs whose numeraire only recently got a feed. Worth stating rather than hiding.
- **Rialto changed its venue event on 15 Sep 2026.** The old fill event `0x4b02af49…` stops at block 64,676,631. The venue now emits `0x824a7dbf…`: topic1 = trader, topic2 = token in, topic3 = token out, 15 data words, where w0 = amount out (quoted), w1 = w2 = amount in, w3 = amount out (actual). On a buy (token in = USDG) w1 equals the transaction's largest USDG transfer exactly; on a sell (token out = USDG) w3 is net of the venue fee and runs about 0.7% under Dune's max-transfer figure. **This alone explains the 46x disagreement between our two Rialto folds:** the rolling window still reads the dead event, so it reports almost nothing.
- **v3 stock liquidity**: the v3 factory `0x1f7d7550…2efa` holds about $4.10M of stock across 112 pools, led by GOOGL $1.0M and RDDT $0.87M. Real, but too small on its own to explain the volume-share gap.

## Plan

1. **Hourly prices** (`stockpx`): fold `AnswerUpdated` per hour, forward-fill; add the
   derived-print VWAP for the feedless watch list. Value every trade at its hour.
2. **Registry** (`registry`): scan the token factory event and the Rialto-wrapped creations;
   classify by name. Replaces the bytecode universe.
3. **Venue census**: v2 `PairCreated` and v3 `PoolCreated` from the two factories plus v4
   `Initialize`; keep pools with exactly one registry token; fold v2/v3/v4 `Swap` events into the
   market series with the routed-leg rule.
4. **Rialto**: stock Transfer logs whose counterparty is `0x4262…c7e8` give the tx set; the
   tx's largest USDG Transfer is its volume.
5. **Shares**: stock-trading share and stock-pair share per 8237276, gross/user headline per
   8032287, all-time since 2026-07-01 with 7d and 24h.
6. **Approximations, stated on the page**: the launchpad-token set is every non-registry,
   non-quote (USDG/WETH/ETH) token that appears opposite a stock, not Adam Tehc's 85-heuristic
   classifier; trader share needs `tx.from` per trade and is deferred.
