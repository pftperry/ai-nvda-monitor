-- Nate Benesh's LONG dashboard (dune.com/natan_benish2001/long-on-robinhood-chain),
-- every public query in the dependency graph of its counters, fetched 17 Sep 2026.
-- This is the methodology the indexer mirrors. Re-fetch when the dashboard changes.
--
-- Counters -> queries:
--   LONG share of stock pair volumes / LONG share of stock trading volume -> 8237276
--   LONG share of stock traders                                          -> 8237922
--   Total Volume / 24h Volume                                            -> 8032287
--   Stock TVL in LONG Pools                                              -> 8032324 -> 8032293
-- Foundations: 8032167 launches, 8032178 pools, 8032188 Chainlink hourly prices,
--   8391616 derived prices for feedless stocks, 8032229 swaps.
-- Market side (Adam Tehc's RWA dashboard, reused by Nate): 8071980 token registry,
--   8076065 stock prices, 8071940 RWA on-chain trading volume, 7979183 launchpad classifier.

-- ===================================================================================
-- query_8032167  LONG: launches (foundation)
-- ===================================================================================
-- LONG foundation 1/4: long_launches
-- Every asset launched by LONG on Robinhood Chain, from TickerAirlockFactory.LaunchCreated
-- (validated complete: 344 launches == 344 Airlock creates with LONG integrator calldata).
-- 2026-09-13: + LongLaunchFactory 0x1eef…2104 (signature-gated UUPS proxy, live since
-- block 56086428 / Sept 2026 cutover; emits the byte-identical LaunchCreated).
SELECT
    l.block_time AS launch_time,
    l.block_date AS launch_date,
    varbinary_substring(l.topic2, 13, 20) AS asset,
    varbinary_substring(l.topic3, 13, 20) AS numeraire,
    varbinary_substring(l.data, 45, 20) AS launcher,
    TRY(from_utf8(varbinary_substring(l.data, 225, CAST(varbinary_to_bigint(varbinary_ltrim(varbinary_substring(l.data, 193, 32))) AS int)))) AS ticker,
    l.contract_address AS factory,
    l.tx_hash
FROM robinhood.logs l
WHERE l.topic0 = 0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b
  AND l.contract_address IN (
      0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845,
      0x22e99278308b393ea1260859b181ad7e78f5eeed,
      0x1eef016f22a943abc7dd11422edee9d235942104
  )
  AND l.block_date >= DATE '2026-07-01'

-- ===================================================================================
-- query_8032178  LONG: pools (foundation)
-- ===================================================================================
-- v4 bonding pools (PoolManager Initialize with our hook, matched to launches)
-- + graduated v2/v3 pools (Airlock.Migrate), with token orientation flags.
WITH launches AS (
    SELECT
        asset,
        -- native-ETH launches carry numeraire = address(0); their v4 pools quote in
        -- native ETH but price/aggregate identically to WETH — normalize here
        CASE WHEN numeraire = 0x0000000000000000000000000000000000000000
             THEN 0x0bd7d308f8e1639fab988df18a8011f41eacad73
             ELSE numeraire END AS numeraire,
        ticker,
        launch_time
    FROM query_8032167
),
inits AS (
    SELECT
        l.topic1 AS pool_id,
        CASE WHEN varbinary_substring(l.topic2, 13, 20) = 0x0000000000000000000000000000000000000000
             THEN 0x0bd7d308f8e1639fab988df18a8011f41eacad73
             ELSE varbinary_substring(l.topic2, 13, 20) END AS currency0,
        CASE WHEN varbinary_substring(l.topic3, 13, 20) = 0x0000000000000000000000000000000000000000
             THEN 0x0bd7d308f8e1639fab988df18a8011f41eacad73
             ELSE varbinary_substring(l.topic3, 13, 20) END AS currency1,
        l.block_time AS init_time
    FROM robinhood.logs l
    WHERE l.topic0 = 0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
      AND l.contract_address = 0x8366a39cc670b4001a1121b8f6a443a643e40951
      AND varbinary_substring(l.data, 77, 20) = 0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544
      AND l.block_date >= DATE '2026-07-01'
),
migrations AS (
    SELECT
        varbinary_substring(l.topic1, 13, 20) AS asset,
        varbinary_substring(l.topic2, 13, 20) AS pool,
        l.block_time AS migrate_time
    FROM robinhood.logs l
    WHERE l.topic0 = 0x2a05bb717043f3a794e94382bf63f2e275ecafc41be9b63c34f16d58da9822ca
      AND l.contract_address = 0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862
)
SELECT 'v4' AS pool_type, i.pool_id, CAST(NULL AS varbinary) AS pool_address, la.asset, la.numeraire, la.ticker,
    (i.currency0 = la.asset) AS asset_is_currency0, la.launch_time, m.migrate_time
FROM inits i
JOIN launches la ON (i.currency0 = la.asset AND i.currency1 = la.numeraire) OR (i.currency0 = la.numeraire AND i.currency1 = la.asset)
LEFT JOIN migrations m ON m.asset = la.asset
UNION ALL
SELECT 'graduated', CAST(NULL AS varbinary), m.pool, la.asset, la.numeraire, la.ticker,
    (la.asset < la.numeraire) AS asset_is_currency0, la.launch_time, m.migrate_time
FROM migrations m
JOIN launches la ON la.asset = m.asset

-- ===================================================================================
-- query_8032188  LONG: numeraire prices hourly (foundation)
-- ===================================================================================
-- Hourly USD price for every LONG numeraire (stock tokens + WETH + USDG) from the
-- Chainlink AGGREGATORS behind Robinhood's feed proxies (proxies emit nothing).
-- Forward-filled per hour: equity feeds pause outside market hours. Feed decimals = 8.
WITH feed_map(token, symbol, token_decimals, aggregator) AS (VALUES
    (0x0bd7d308f8e1639fab988df18a8011f41eacad73, 'WETH',  18, 0x6091e64eb7138eef066a80fd3a0d7427b91f2721),
    (0x5fc5360d0400a0fd4f2af552add042d716f1d168, 'USDG',   6, 0x8beee3503f6860d5dac4ce26b5eee92982951c2e),
    (0xaf3d76f1834a1d425780943c99ea8a608f8a93f9, 'AAPL',  18, 0xbb11a21267cfdb63d4935d99a499133dd1744acb),
    (0x86923f96303d656e4aa86d9d42d1e57ad2023fdc, 'AMD',   18, 0xdad54b8ee51af258e5a6faa9a84a3300f4775f7d),
    (0x12f190a9f9d7d37a250758b26824b97ce941bf54, 'AMZN',  18, 0x93503dfc97157cdb8aadccaf70452621d598fdeb),
    (0xad25ac6c84d497db898fa1e8387bf6af3532a1c4, 'BABA',  18, 0xff5f85e4888782e66f1dd9cabadf4822fbeb1439),
    (0x6330d8c3178a418788df01a47479c0ce7ccf450b, 'COIN',  18, 0x30398b0b0df82a009bb2d507bc7fe1dc6d3ca294),
    (0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5, 'CRCL',  18, 0x901d8df245e48dfc82d6483fc45b5be6ddc5281a),
    (0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3, 'CRWV',  18, 0xd9c04b7353421fc4deb1614ed13fe10d90e586cc),
    (0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3, 'GOOGL', 18, 0x11ed6d598ef565dda86fafe7e779303e7cc6b2bd),
    (0xc72b96e0e48ecd4dc75e1e45396e26300bc39681, 'INTC',  18, 0x95fb52f75aecbca8e12aa4403f840c8bc18cfbd4),
    (0xc0d6457c16cc70d6790dd43521c899c87ce02f35, 'META',  18, 0xc190b6164b9e320a6400cdab0085a2e0e2b9738e),
    (0xe93237c50d904957cf27e7b1133b510c669c2e74, 'MSFT',  18, 0xc3b117f52cf17dd4369eaf5eaf7cf0e2f91b4e30),
    (0xff080c8ce2e5feadaca0da81314ae59d232d4afd, 'MU',    18, 0xa088fad0a0a62693af068e2edb80b1578c8a9365),
    (0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec, 'NVDA',  18, 0xc9d16e4f2569b9e3ea0468fd85844953713dc2a2),
    (0xb0992820e760d836549ba69bc7598b4af75dee03, 'ORCL',  18, 0x4a9abc759e0b7b0ba98b5fd39c419a5d3e962aaf),
    (0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a, 'PLTR',  18, 0x315afd0f71d5407b99ad19ab001a67af40fbaaf4),
    (0xb90a19ff0af67f7779aff50a882a9cff42446400, 'SNDK',  18, 0x7b2fdfcea772f093dd33b3acf8ee294b368f6c23),
    (0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea, 'SPCX',  18, 0x5eaa223c585f40cdca2d119ea91b97c491245631),
    (0x322f0929c4625ed5bad873c95208d54e1c003b2d, 'TSLA',  18, 0x7a6b81ba7fbcb90104d8c496158cf383cd7233b1),
    (0xd917b029c761d264c6a312bbbcda868658ef86a6, 'USAR',  18, 0x76ba75c6c362900b275d9d4d5c422f0275e85578),
    (0xd5f3879160bc7c32ebb4dc785f8a4f505888de68, 'QQQ',   18, 0x25e996ce8b3529885d429241156e83e7b7744049),
    (0x92fd66527192e3e61d4ddd13322aa222de86f9b5, 'SGOV',  18, 0x0e96b7708487f91baac09697593d3e8bf253f2d8),
    (0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f, 'SLV',   18, 0xcdf6f7043b3af6afa0caaace1230b355096b5386),
    (0x117cc2133c37b721f49de2a7a74833232b3b4c0c, 'SPY',   18, 0x78bcb218fa04b9b3a278ebc865ed320bf8defbac),
    (0x47f93d52cbec7c6d2cfc080e154002370a60daea, 'ASML',  18, 0xf795030a46ad6ca4b07bf5fb704dc36039118c9f),
    (0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd, 'DELL',  18, 0xd6ed4e7d4aba1111eb42a349899b5c72ee1c9fef),
    (0x1b0e319c6a659f002271b69db8a7df2f911c153e, 'GME',   18, 0xf83cde62d1cd90de8d2bf3332b90c590985ad679),
    (0xec262a75e413fafd0df80480274532c79d42da09, 'MSTR',  18, 0x55bd01f666c99e4590e084fdeff88041bb50ccd1),
    (0x58ffe4a942d3885baa22d7520691f611ef09e7aa, 'TSM',   18, 0x2b3a9a18998e9464760658233ab093e6aebf45d0)
),
updates AS (
    SELECT l.contract_address AS aggregator, CAST(DATE_TRUNC('hour', l.block_time) AS TIMESTAMP(3)) AS hr,
        MAX_BY(varbinary_to_int256(l.topic1), l.block_time) AS answer_raw
    FROM robinhood.logs l
    JOIN (SELECT DISTINCT aggregator FROM feed_map) f ON f.aggregator = l.contract_address
    WHERE l.topic0 = 0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f
      AND l.block_date >= DATE '2026-06-05'
    GROUP BY 1, 2
),
spine AS (
    SELECT a.aggregator, s.hr FROM (SELECT DISTINCT aggregator FROM feed_map) a
    CROSS JOIN UNNEST(SEQUENCE(TIMESTAMP '2026-06-22 00:00:00', CAST(DATE_TRUNC('hour', NOW()) AS TIMESTAMP(3)), INTERVAL '1' HOUR)) AS s(hr)
),
filled AS (
    SELECT sp.aggregator, sp.hr,
        LAST_VALUE(u.answer_raw) IGNORE NULLS OVER (PARTITION BY sp.aggregator ORDER BY sp.hr ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS answer_raw
    FROM spine sp LEFT JOIN updates u ON u.aggregator = sp.aggregator AND u.hr = sp.hr
)
SELECT fm.token, fm.symbol, fm.token_decimals, f.hr, CAST(f.answer_raw AS double) / 1e8 AS price_usd
FROM filled f JOIN feed_map fm ON fm.aggregator = f.aggregator
WHERE f.answer_raw IS NOT NULL

-- ===================================================================================
-- query_8391616  LONG: numeraire prices derived (foundation 3b)
-- ===================================================================================
-- Hourly USD price for numeraires WITHOUT a Chainlink feed, derived from ON-CHAIN
-- price prints: Rialto/Arcus/RH settlements move stock token + USDG in one tx, so
-- every such tx is a price observation. Estimator per (tx, token) = MAX single
-- transfer leg (robust to router-hop duplication; SUM double-counts hops).
-- Outlier gate: +/-10% band around the hourly median. Output shape identical to 8032188.
-- Scope note: AI and other launch-token/memecoin numeraires are deliberately ABSENT —
-- q4's inner price join therefore excludes those pairs from the dashboard (Nate 2026-08-19/20).
WITH watch(token, symbol, token_decimals, px_lo, px_hi) AS (VALUES
      (0x43b07d15ce533bec5476d70c22a78a1b2b662155, 'MRNA', 18, 40, 400)
    , (0x1d11f0496982706c5e14a514d4e79f2e6bde4516, 'DJT',  18, 2.5, 25)
    , (0xccee82fe024c36fa15e1005ede3e9e4787e23d09, 'HIMS', 18, 9.7, 97)
    , (0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619, 'IBM',  18, 70, 700)
    , (0x116f00968269b7bfbad4109ce591d6e74c0601d4, 'NET',  18, 84, 840)
    , (0x5e81213613b6b86eab4c6c50d718d34359459786, 'TTWO', 18, 72, 720)
    , (0x84cab63bc87912e71ad199ff14a0ba45de68fef8, 'SKHY', 18, 48, 484)
    , (0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8, 'NFLX', 18, 24, 242)
    , (0x408c14038a04f7bd235329e26d2bf569ee20e250, 'NU',   18, 4.3, 43)
    , (0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8, 'RBLX', 18, 11.5, 115)
    , (0x05b37fb53a299a1b874a619e1c4c404d52c36f4c, 'RDDT', 18, 44, 438)
    , (0x98e75885157c80992a8d41b696d8c9c6fb30a926, 'SOFI', 18, 5.4, 54)
    , (0xf23250dac154d05bb671cb0d0ebef3c635c79ce2, 'UPS',  18, 31, 309)
    , (0x9651342cea770ae9a2969ba2a52611523146aef9, 'CCL',  18, 7.6, 76)
    , (0x4ea005168d7f09a7a0ba9d1def21a479950e44c2, 'COST', 18, 280, 2795)
    , (0x822cc93ffd030293e9842c30bbd678f530701867, 'BE',   18, 60, 600)
    , (0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e, 'GLD',  18, 124, 1243)
    , (0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344, 'USO',  18, 47, 426)
    , (0x15cd20759ce7f3285c29a319de2d1a2e098c6f43, 'XLK',  18, 55, 548)
    , (0xfde6b5d9bb419b10c23268c74e369abff39c0460, 'RCAT', 18, 2.8, 28)
    , (0x05a3d1cd21d0c88145e82600e62e7e496e0f222b, 'AMC',  18, 0.75, 7.5)
    , (0x2d427692e928fa156ec22acfabafa0447c5805b7, 'GLXY', 18, 6.9, 69)
    , (0x48e39e56acdba37b09020c0b734a613c9a2f100a, 'BB',   18, 2.2, 25)
    , (0x4d21483a44bf67a86b77e3da301411880797d452, 'BA',   18, 70, 632)
    , (0x41f4267525a8aff329540ef24fd83d9044758b33, 'FIG',  18, 8.4, 76)
    , (0x8005d266423c7ea827372c9c864491e5786600ea, 'LLY',  18, 386, 3478)
    , (0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4, 'QUBT', 18, 2.7, 24)
    , (0xf6589f11bc40b669e584073f428b05562f568733, 'SNAP', 18, 1.9, 17)
    , (0x4e62068525ab11fe768e29dfd00ef909b9803016, 'LULU', 18, 33.4, 301)
    , (0x25c288e6d899b9bc30160965ad9644c67e73be0c, 'F',    18, 4.9, 44)
    , (0x03dfbbe0ac4e7bcdafd08ed41a400326b77d8c80, 'JNJ',  18, 89, 799)
    , (0x329fcaceb9ad6f9580dd5f643fed0646900d043c, 'LMT',  18, 163, 1470)
    , (0x9d9c6684f596f66a64c030b93a886d51fd4d7931, 'NBIS', 18, 75, 676)
    , (0x7066a64c24e4206cd62e83bf198c1e7eb361f51e, 'PFE',  18, 9.4, 84)
    , (0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b, 'RIVN', 18, 5.2, 47)
    , (0xf53f66751b1eff985311b693531e3290f600c410, 'SHOP', 18, 48, 434)
    , (0xba0cab75495255d0cb58e22b648bfed4ecd1f47e, 'SNOW', 18, 113, 1019)
),
tx_tok AS (
    SELECT t.tx_hash, t.contract_address, MAX(CAST(t.amount_raw AS double)) AS max_leg, MAX(t.block_time) AS ts
    FROM tokens.transfers t
    WHERE t.blockchain = 'robinhood' AND t.block_month >= DATE '2026-07-01'
      AND t.contract_address IN (SELECT token FROM watch UNION ALL SELECT 0x5fc5360d0400a0fd4f2af552add042d716f1d168)
    GROUP BY 1, 2
),
prints AS (
    SELECT w.token, w.symbol, w.token_decimals, CAST(DATE_TRUNC('hour', s.ts) AS TIMESTAMP(3)) AS hr,
        (u.max_leg / 1e6) / (s.max_leg / POWER(10, w.token_decimals)) AS px, u.max_leg / 1e6 AS usdg_amt
    FROM tx_tok s JOIN watch w ON w.token = s.contract_address
    JOIN tx_tok u ON u.tx_hash = s.tx_hash AND u.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
    WHERE s.max_leg / POWER(10, w.token_decimals) > 0.000001 AND u.max_leg / 1e6 > 1
      AND (u.max_leg / 1e6) / (s.max_leg / POWER(10, w.token_decimals)) BETWEEN w.px_lo AND w.px_hi
),
hourly_med AS (SELECT token, hr, APPROX_PERCENTILE(px, 0.5) AS med FROM prints GROUP BY 1, 2),
vwap AS (
    SELECT p.token, p.symbol, p.token_decimals, p.hr, SUM(p.px * p.usdg_amt) / SUM(p.usdg_amt) AS price_usd
    FROM prints p JOIN hourly_med m ON m.token = p.token AND m.hr = p.hr
    WHERE p.px BETWEEN m.med * 0.90 AND m.med * 1.10
    GROUP BY 1, 2, 3, 4
),
spine AS (
    SELECT w.token, w.symbol, w.token_decimals, s.hr FROM watch w
    CROSS JOIN UNNEST(SEQUENCE(TIMESTAMP '2026-07-01 00:00:00', CAST(DATE_TRUNC('hour', NOW()) AS TIMESTAMP(3)), INTERVAL '1' HOUR)) AS s(hr)
),
filled AS (
    SELECT sp.token, sp.symbol, sp.token_decimals, sp.hr,
        LAST_VALUE(v.price_usd) IGNORE NULLS OVER (PARTITION BY sp.token ORDER BY sp.hr ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS price_usd
    FROM spine sp LEFT JOIN vwap v ON v.token = sp.token AND v.hr = sp.hr
)
SELECT token, symbol, token_decimals, hr, price_usd FROM filled WHERE price_usd IS NOT NULL

-- ===================================================================================
-- query_8032229  LONG: swaps (foundation)
-- ===================================================================================
-- Every swap in a LONG pool (v4 bonding + graduated v2/v3), with the numeraire-side
-- amount, buyback flag (sender = fee manager), USD value from Chainlink hourly prices,
-- and the tx sender as trader identity.
WITH pools AS (SELECT * FROM query_8032178),
prices AS (SELECT * FROM query_8032188 UNION ALL SELECT * FROM query_8391616),
v4_swaps AS (
    SELECT l.block_time, l.block_date, l.tx_hash, l.index AS evt_index,
        varbinary_substring(l.topic1, 13, 20) AS sender, l.topic3 AS pool_id,
        varbinary_to_int256(varbinary_substring(l.data,  97, 32)) AS amount0,
        varbinary_to_int256(varbinary_substring(l.data, 129, 32)) AS amount1
    FROM robinhood.logs l
    WHERE l.topic0 = 0x1d9f7b5e406d8c887155e1a78e070d2d41c5d0444dab8b21612f846835c27183
      AND l.contract_address = 0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544
      AND l.block_date >= DATE '2026-07-01'
),
v4_rows AS (
    SELECT s.block_time, s.block_date, s.tx_hash, s.evt_index, p.asset, p.numeraire, p.ticker, 'v4' AS venue,
        (s.sender = 0x6f02324d20cc679d0e585290caa6b16bacbc0f77) AS is_buyback,
        ABS(CASE WHEN p.asset_is_currency0 THEN s.amount1 ELSE s.amount0 END) AS numeraire_amount_raw,
        -(CASE WHEN p.asset_is_currency0 THEN s.amount1 ELSE s.amount0 END) AS pool_numeraire_delta_raw
    FROM v4_swaps s JOIN pools p ON p.pool_type = 'v4' AND p.pool_id = s.pool_id
),
grad_pools AS (SELECT pool_address, asset, numeraire, ticker, asset_is_currency0 FROM pools WHERE pool_type = 'graduated'),
v2_rows AS (
    SELECT l.block_time, l.block_date, l.tx_hash, l.index AS evt_index, g.asset, g.numeraire, g.ticker, 'graduated_v2' AS venue, FALSE AS is_buyback,
        CAST(CASE WHEN g.asset_is_currency0
            THEN varbinary_to_uint256(varbinary_substring(l.data, 33, 32)) + varbinary_to_uint256(varbinary_substring(l.data, 97, 32))
            ELSE varbinary_to_uint256(varbinary_substring(l.data,  1, 32)) + varbinary_to_uint256(varbinary_substring(l.data, 65, 32)) END AS int256) AS numeraire_amount_raw,
        CAST(CASE WHEN g.asset_is_currency0
            THEN varbinary_to_uint256(varbinary_substring(l.data, 33, 32)) - varbinary_to_uint256(varbinary_substring(l.data, 97, 32))
            ELSE varbinary_to_uint256(varbinary_substring(l.data,  1, 32)) - varbinary_to_uint256(varbinary_substring(l.data, 65, 32)) END AS int256) AS pool_numeraire_delta_raw
    FROM robinhood.logs l JOIN grad_pools g ON g.pool_address = l.contract_address
    WHERE l.topic0 = 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
),
v3_rows AS (
    SELECT l.block_time, l.block_date, l.tx_hash, l.index AS evt_index, g.asset, g.numeraire, g.ticker, 'graduated_v3' AS venue, FALSE AS is_buyback,
        ABS(varbinary_to_int256(CASE WHEN g.asset_is_currency0 THEN varbinary_substring(l.data, 33, 32) ELSE varbinary_substring(l.data, 1, 32) END)) AS numeraire_amount_raw,
        varbinary_to_int256(CASE WHEN g.asset_is_currency0 THEN varbinary_substring(l.data, 33, 32) ELSE varbinary_substring(l.data, 1, 32) END) AS pool_numeraire_delta_raw
    FROM robinhood.logs l JOIN grad_pools g ON g.pool_address = l.contract_address
    WHERE l.topic0 = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
),
all_rows AS (SELECT * FROM v4_rows UNION ALL SELECT * FROM v2_rows UNION ALL SELECT * FROM v3_rows)
SELECT a.block_time, a.block_date, a.tx_hash, a.evt_index, a.asset, a.numeraire, pr.symbol AS numeraire_symbol, a.ticker, a.venue, a.is_buyback,
    t."from" AS trader,
    CAST(a.numeraire_amount_raw AS double) / POWER(10, pr.token_decimals) AS numeraire_amount,
    CAST(a.numeraire_amount_raw AS double) / POWER(10, pr.token_decimals) * pr.price_usd AS amount_usd,
    CAST(a.pool_numeraire_delta_raw AS double) / POWER(10, pr.token_decimals) AS pool_numeraire_delta
FROM all_rows a
JOIN prices pr ON pr.token = a.numeraire AND pr.hr = CAST(DATE_TRUNC('hour', a.block_time) AS TIMESTAMP(3))
JOIN robinhood.transactions t ON t.hash = a.tx_hash AND t.block_date = a.block_date

-- ===================================================================================
-- query_8032287  LONG: headline counters   (Total Volume, 24h Volume)
-- ===================================================================================
-- gross = every swap incl. protocol buyback legs; user = trader-initiated swaps only
WITH s AS (SELECT * FROM query_8032229)
SELECT
    (SELECT SUM(amount_usd) FROM s) AS gross_volume_usd,
    (SELECT SUM(amount_usd) FROM s WHERE NOT is_buyback) AS user_volume_usd,
    (SELECT SUM(amount_usd) FROM s WHERE is_buyback) AS buyback_volume_usd,
    (SELECT SUM(amount_usd) FROM s WHERE block_time >= NOW() - INTERVAL '24' HOUR) AS gross_volume_24h_usd,
    (SELECT SUM(amount_usd) FROM s WHERE NOT is_buyback AND block_time >= NOW() - INTERVAL '24' HOUR) AS user_volume_24h_usd,
    (SELECT SUM(amount_usd) FROM s WHERE block_time >= NOW() - INTERVAL '7' DAY) AS gross_volume_7d_usd,
    (SELECT COUNT(*) FROM s WHERE NOT is_buyback) AS user_trades,
    (SELECT COUNT(DISTINCT trader) FROM s WHERE NOT is_buyback) AS total_traders,
    (SELECT COUNT(DISTINCT trader) FROM s WHERE NOT is_buyback AND block_time >= NOW() - INTERVAL '24' HOUR) AS traders_24h,
    (SELECT COUNT(*) FROM query_8032167
      WHERE (CASE WHEN numeraire = 0x0000000000000000000000000000000000000000 THEN 0x0bd7d308f8e1639fab988df18a8011f41eacad73 ELSE numeraire END)
            IN (SELECT token FROM query_8032188 UNION SELECT token FROM query_8391616)) AS tokens_launched,
    (SELECT COUNT(DISTINCT numeraire) FROM s) AS stocks_traded

-- ===================================================================================
-- query_8032293  LONG: supply share per stock   ->  query_8032324 Stock TVL counter
-- ===================================================================================
-- circulating supply = mints − burns; held in LONG pools = v4 cumulative pool-perspective
-- numeraire deltas INCLUDING buyback legs, unmigrated pools only + graduated pools (ERC20 transfers).
WITH pools AS (SELECT * FROM query_8032178),
latest_prices AS (
    SELECT token, symbol, token_decimals, MAX_BY(price_usd, hr) AS price_usd
    FROM (SELECT * FROM query_8032188 UNION ALL SELECT * FROM query_8391616) GROUP BY 1, 2, 3
),
stock_supply AS (
    SELECT l.contract_address AS token,
        SUM(CASE WHEN l.topic1 = 0x0000000000000000000000000000000000000000000000000000000000000000
                 THEN CAST(varbinary_to_uint256(l.data) AS double) ELSE -CAST(varbinary_to_uint256(l.data) AS double) END) AS raw_supply
    FROM robinhood.logs l JOIN (SELECT DISTINCT numeraire FROM pools) n ON n.numeraire = l.contract_address
    WHERE l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef AND l.topic3 IS NULL
      AND (l.topic1 = 0x0000000000000000000000000000000000000000000000000000000000000000 OR l.topic2 = 0x0000000000000000000000000000000000000000000000000000000000000000)
    GROUP BY 1
),
v4_held AS (
    SELECT s.numeraire, SUM(s.pool_numeraire_delta) AS held FROM query_8032229 s
    JOIN (SELECT DISTINCT asset FROM pools WHERE pool_type = 'v4' AND migrate_time IS NULL) p ON p.asset = s.asset
    WHERE s.venue = 'v4' GROUP BY 1
),
grad_held AS (
    SELECT p.numeraire,
        SUM(CASE WHEN varbinary_substring(l.topic2, 13, 20) = p.pool_address THEN CAST(varbinary_to_uint256(l.data) AS double) ELSE -CAST(varbinary_to_uint256(l.data) AS double) END) AS held_raw
    FROM robinhood.logs l
    JOIN (SELECT DISTINCT pool_address, numeraire FROM pools WHERE pool_type = 'graduated') p
      ON l.contract_address = p.numeraire AND (varbinary_substring(l.topic1, 13, 20) = p.pool_address OR varbinary_substring(l.topic2, 13, 20) = p.pool_address)
    WHERE l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef AND l.topic3 IS NULL
    GROUP BY 1
)
SELECT pr.symbol AS stock, ss.raw_supply / POWER(10, pr.token_decimals) AS circulating_supply,
    COALESCE(v4.held, 0) + COALESCE(g.held_raw, 0) / POWER(10, pr.token_decimals) AS held_in_long_pools,
    100.0 * (COALESCE(v4.held, 0) + COALESCE(g.held_raw, 0) / POWER(10, pr.token_decimals)) / NULLIF(ss.raw_supply / POWER(10, pr.token_decimals), 0) AS pct_of_supply,
    (COALESCE(v4.held, 0) + COALESCE(g.held_raw, 0) / POWER(10, pr.token_decimals)) * pr.price_usd AS held_usd,
    pr.price_usd AS stock_price_usd
FROM stock_supply ss JOIN latest_prices pr ON pr.token = ss.token
LEFT JOIN v4_held v4 ON v4.numeraire = ss.token LEFT JOIN grad_held g ON g.numeraire = ss.token
ORDER BY held_usd DESC;
-- query_8032324:
SELECT SUM(held_usd) AS stock_tvl_usd, MAX_BY(stock, held_usd) AS largest_stock_position FROM query_8032293

-- ===================================================================================
-- query_8071980  rwa_token_registry (robinhood)   (Adam Tehc; the stock universe)
-- ===================================================================================
WITH native AS (
    SELECT varbinary_substring(l.data, 13, 20) AS token_address, CAST(l.block_time AS date) AS first_date,
        TRY(FROM_UTF8(varbinary_substring(l.data, varbinary_to_bigint(varbinary_substring(l.data, 57, 8)) + 33,
            varbinary_to_bigint(varbinary_substring(l.data, varbinary_to_bigint(varbinary_substring(l.data, 57, 8)) + 25, 8))))) AS name,
        TRY(FROM_UTF8(varbinary_substring(l.data, varbinary_to_bigint(varbinary_substring(l.data, 89, 8)) + 33,
            varbinary_to_bigint(varbinary_substring(l.data, varbinary_to_bigint(varbinary_substring(l.data, 89, 8)) + 25, 8))))) AS symbol
    FROM robinhood.logs l
    WHERE l.block_date >= DATE '2026-06-01' AND l.block_time >= TIMESTAMP '2026-06-01'
      AND l.contract_address = 0x4783c67b63de2b358ac5951a7d41f47a38f3c046
      AND l.topic0 = 0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6
),
rialto_names AS (
    SELECT ct.address AS token_address, CAST(ct.block_time AS date) AS first_date,
        MAX(TRY(FROM_UTF8(varbinary_substring(tr.input, 197, varbinary_to_bigint(varbinary_substring(tr.input, 189, 8)))))) AS name
    FROM robinhood.creation_traces ct
    JOIN robinhood.traces tr ON tr."to" = ct.address AND tr.block_date >= DATE '2026-06-01' AND varbinary_starts_with(tr.input, 0x6cf1dbed)
    WHERE ct.block_month >= DATE '2026-05-01' AND ct."from" = 0x8bc71ae8eac8b25f30c2990930cc3a80e72e169e
    GROUP BY 1, 2
),
unioned AS (
    SELECT token_address, first_date, 'robinhood' AS issuer, name, symbol FROM native
    UNION ALL
    SELECT token_address, first_date, 'rialto_wrapped' AS issuer, name, CAST(NULL AS varchar) AS symbol FROM rialto_names
)
SELECT token_address, first_date, issuer, name, symbol,
    CASE WHEN name LIKE '%T-Bill%' OR name LIKE '%Treasury%' THEN 'treasury'
         WHEN name LIKE '%Silver%' OR name LIKE '%Gold%' OR name LIKE '%Oil Fund%' THEN 'commodity'
         WHEN name LIKE '%ETF%' OR name LIKE '%QQQ%' OR name LIKE '%Trust%' OR LOWER(name) LIKE '%fund%' THEN 'etf'
         ELSE 'stock' END AS asset_class
FROM unioned WHERE name NOT LIKE '%Dollar%'

-- ===================================================================================
-- query_8076065  stock_prices (robinhood)   (hourly fallback pricing for the market side)
-- ===================================================================================
WITH feed_universe AS (
    SELECT DISTINCT contract_address AS feed FROM robinhood.logs
    WHERE topic0 = 0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f AND block_date >= DATE '2026-05-22'
),
feed_tickers AS (
    SELECT f.feed, COALESCE(
        regexp_extract(regexp_extract(from_utf8(ct.code), '[A-Za-z0-9 .&\-]{2,25} ?/ ?USD'), 'Robinhood ([A-Z]+) ?/ ?USD', 1),
        regexp_extract(regexp_extract(from_utf8(ct.code), '[A-Za-z0-9 .&\-]{2,25} ?/ ?USD'), '^RH([A-Z]+) ?/ ?USD', 1)) AS ticker
    FROM feed_universe f JOIN robinhood.creation_traces ct ON ct.address = f.feed
),
issued AS (SELECT token_address, name, symbol FROM query_8071980 WHERE issuer = 'robinhood'),
wrapped AS (SELECT w.token_address, i.symbol FROM query_8071980 w JOIN issued i ON i.name = REPLACE(w.name, 'Wrapped ', '') WHERE w.issuer = 'rialto_wrapped'),
overrides AS (SELECT * FROM (VALUES (0x70ae210e7dbca4e134d46070af520d19fe82df8d, 'SPCX')) AS t(token_address, symbol)),
tokens AS (SELECT token_address, symbol FROM issued UNION ALL SELECT token_address, symbol FROM wrapped UNION ALL SELECT token_address, symbol FROM overrides),
updates AS (
    SELECT contract_address AS feed, DATE_TRUNC('hour', block_time) AS hr, MAX_BY(varbinary_to_int256(topic1), block_time) / 1e8 AS price
    FROM robinhood.logs WHERE topic0 = 0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f AND block_date >= DATE '2026-06-30'
    GROUP BY 1, 2
),
hours AS (SELECT hr FROM UNNEST(sequence(TIMESTAMP '2026-06-30 00:00:00', CAST(DATE_TRUNC('hour', NOW()) AS TIMESTAMP), INTERVAL '1' HOUR)) AS h(hr)),
spine AS (SELECT ft.feed, ft.ticker, h.hr FROM feed_tickers ft CROSS JOIN hours h WHERE ft.ticker IS NOT NULL),
filled AS (SELECT s.feed, s.ticker, s.hr, LAST_VALUE(u.price) IGNORE NULLS OVER (PARTITION BY s.feed ORDER BY s.hr) AS price FROM spine s LEFT JOIN updates u ON u.feed = s.feed AND u.hr = s.hr),
oracle_out AS (SELECT t.token_address, fl.hr, fl.price, 'oracle' AS price_source FROM filled fl JOIN tokens t ON t.symbol = fl.ticker WHERE fl.price IS NOT NULL),
rialto_px_legs AS (
    SELECT l.tx_hash,
        MAX(CASE WHEN l.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168 THEN varbinary_to_uint256(varbinary_substring(l.data, 1, 32)) / 1e6 END) AS usdg,
        MAX(CASE WHEN s.token_address IS NOT NULL THEN varbinary_to_uint256(varbinary_substring(l.data, 1, 32)) / 1e18 END) AS qty,
        MAX(CASE WHEN s.token_address IS NOT NULL THEN l.contract_address END) AS token,
        COUNT(DISTINCT CASE WHEN s.token_address IS NOT NULL THEN l.contract_address END) AS n_tokens
    FROM robinhood.logs l
    JOIN robinhood.transactions t ON t.hash = l.tx_hash AND t.block_date >= CURRENT_DATE - INTERVAL '14' DAY AND t."to" = 0x4262efbd176f02824af27010bea218429c33c7e8
    LEFT JOIN query_8071980 s ON s.token_address = l.contract_address
    WHERE l.block_date >= CURRENT_DATE - INTERVAL '14' DAY AND l.block_time >= CURRENT_DATE - INTERVAL '14' DAY
      AND l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND l.topic1 != 0x0000000000000000000000000000000000000000000000000000000000000000
      AND (l.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168 OR l.contract_address IN (SELECT token_address FROM query_8071980))
    GROUP BY 1
),
rialto_px AS (
    SELECT token, approx_percentile(usdg / qty, 0.5) AS price FROM rialto_px_legs
    WHERE usdg > 0 AND qty > 0 AND token IS NOT NULL AND n_tokens = 1
    GROUP BY 1
    HAVING COUNT(*) >= 5 AND (approx_percentile(usdg / qty, 0.75) - approx_percentile(usdg / qty, 0.25)) / approx_percentile(usdg / qty, 0.5) < 0.1
),
fallback_out AS (SELECT rp.token AS token_address, h.hr, rp.price, 'rialto_vwap' AS price_source FROM rialto_px rp CROSS JOIN hours h WHERE rp.token NOT IN (SELECT DISTINCT token_address FROM oracle_out))
SELECT token_address, hr, price, price_source FROM oracle_out UNION ALL SELECT token_address, hr, price, price_source FROM fallback_out

-- ===================================================================================
-- query_8071940  RWA on-chain trading volume   (the market denominator, by series)
-- ===================================================================================
WITH stock_tokens AS (SELECT token_address AS address, asset_class FROM query_8071980),
pad_tokens AS (SELECT token_address AS address FROM query_7979183 WHERE launchpad <> 'other'),
rialto_txs AS (SELECT hash AS tx_hash FROM robinhood.transactions WHERE block_date >= DATE '2026-07-10' AND "to" = 0x4262efbd176f02824af27010bea218429c33c7e8),
venue_stock_txs AS (
    SELECT l.tx_hash, MAX_BY(s.asset_class, varbinary_to_uint256(varbinary_substring(l.data, 1, 32))) AS asset_class
    FROM robinhood.logs l JOIN rialto_txs r ON r.tx_hash = l.tx_hash JOIN stock_tokens s ON s.address = l.contract_address
    WHERE l.block_date >= DATE '2026-07-10' AND l.block_time >= DATE '2026-07-10'
      AND l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    GROUP BY 1
),
raw_venue_tx AS (
    SELECT vs.asset_class, l.block_date, l.tx_hash, MAX(varbinary_to_uint256(varbinary_substring(l.data, 1, 32)) / 1e6) AS quote_amt
    FROM robinhood.logs l JOIN venue_stock_txs vs ON vs.tx_hash = l.tx_hash
    WHERE l.block_date >= DATE '2026-07-10' AND l.block_time >= DATE '2026-07-10' AND l.block_date < CURRENT_DATE
      AND l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND l.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
    GROUP BY 1, 2, 3
),
pair_txs AS (
    SELECT tx_hash FROM (
        SELECT d.tx_hash, MAX(CASE WHEN s.address IS NOT NULL THEN 1 ELSE 0 END) AS has_stock, MAX(CASE WHEN p.address IS NOT NULL THEN 1 ELSE 0 END) AS has_pad
        FROM dex.trades d CROSS JOIN UNNEST(ARRAY[d.token_bought_address, d.token_sold_address]) AS u(tok)
        LEFT JOIN stock_tokens s ON s.address = u.tok LEFT JOIN pad_tokens p ON p.address = u.tok
        WHERE d.blockchain = 'robinhood' AND d.block_date >= DATE '2026-07-10' AND d.block_date < CURRENT_DATE
        GROUP BY 1
    ) WHERE has_stock = 1 AND has_pad = 1
),
dex_rows AS (
    SELECT d.block_date,
        CASE WHEN pb.address IS NOT NULL OR ps.address IS NOT NULL THEN 'memecoin × stock pairs'
             WHEN COALESCE(s_b.asset_class, s_s.asset_class) = 'stock' THEN 'stock trading (spot)'
             WHEN COALESCE(s_b.asset_class, s_s.asset_class) = 'commodity' THEN 'commodities'
             ELSE 'ETFs & treasuries' END AS series,
        SUM(COALESCE(d.amount_usd,
            CASE WHEN s_b.address IS NOT NULL THEN CAST(d.token_bought_amount_raw AS double) / 1e18
                 WHEN s_s.address IS NOT NULL THEN CAST(d.token_sold_amount_raw AS double) / 1e18 END * cl.price)) AS volume_usd
    FROM dex.trades d
    LEFT JOIN stock_tokens s_b ON s_b.address = d.token_bought_address LEFT JOIN stock_tokens s_s ON s_s.address = d.token_sold_address
    LEFT JOIN pad_tokens pb ON pb.address = d.token_bought_address LEFT JOIN pad_tokens ps ON ps.address = d.token_sold_address
    LEFT JOIN pair_txs p ON p.tx_hash = d.tx_hash
    LEFT JOIN query_8076065 cl ON cl.token_address = COALESCE(s_b.address, s_s.address) AND cl.hr = CAST(DATE_TRUNC('hour', d.block_time) AS TIMESTAMP) AND d.amount_usd IS NULL
    WHERE d.blockchain = 'robinhood' AND d.block_date >= DATE '2026-07-10' AND d.block_date < CURRENT_DATE
      AND (s_b.address IS NOT NULL OR s_s.address IS NOT NULL)
      AND NOT (s_b.address IS NOT NULL AND s_s.address IS NOT NULL)
      AND NOT (pb.address IS NULL AND ps.address IS NULL AND p.tx_hash IS NOT NULL)   -- routed legs of pad-routed trades excluded
    GROUP BY 1, 2
),
rialto_rows AS (
    SELECT block_date, CASE WHEN asset_class = 'stock' THEN 'stock trading (spot)' WHEN asset_class = 'commodity' THEN 'commodities' ELSE 'ETFs & treasuries' END AS series, SUM(quote_amt) AS volume_usd
    FROM raw_venue_tx GROUP BY 1, 2
)
SELECT block_date, series, SUM(volume_usd) AS volume_usd FROM (SELECT * FROM dex_rows UNION ALL SELECT * FROM rialto_rows) GROUP BY 1, 2 ORDER BY 1, 2

-- ===================================================================================
-- query_8237276  LONG widget: stock-pair share + share of ALL stock trading
-- ===================================================================================
-- dex.trades rows with exactly one tokenized-stock side (registry 8071980); pair rows have a
-- launchpad token (7979183, launchpad <> 'other', unioned with LONG's launch list) on the other
-- side; hourly-Chainlink fallback pricing (8076065) where Dune left amount_usd NULL; routed legs of
-- pad-routed trades excluded; Rialto venue volume added to the total-stock-trading denominator.
WITH stock_tokens AS (SELECT token_address AS address FROM query_8071980 GROUP BY 1),
long_tokens AS (SELECT DISTINCT asset AS address FROM query_8032167),
pad_tokens AS (SELECT token_address AS address FROM query_7979183 WHERE launchpad <> 'other' UNION SELECT address FROM long_tokens),
pair_txs AS (
    SELECT tx_hash FROM (
        SELECT d.tx_hash, MAX(CASE WHEN s.address IS NOT NULL THEN 1 ELSE 0 END) AS has_stock, MAX(CASE WHEN p.address IS NOT NULL THEN 1 ELSE 0 END) AS has_pad
        FROM dex.trades d CROSS JOIN UNNEST(ARRAY[d.token_bought_address, d.token_sold_address]) AS u(tok)
        LEFT JOIN stock_tokens s ON s.address = u.tok LEFT JOIN pad_tokens p ON p.address = u.tok
        WHERE d.blockchain = 'robinhood' AND d.block_date >= DATE '2026-07-01'
        GROUP BY 1
    ) WHERE has_stock = 1 AND has_pad = 1
),
stock_dex AS (
    SELECT d.block_time,
        (pb.address IS NOT NULL OR ps.address IS NOT NULL) AS is_pair,
        (lb.address IS NOT NULL OR ls.address IS NOT NULL) AS is_long,
        (pb.address IS NULL AND ps.address IS NULL AND p.tx_hash IS NOT NULL) AS is_routed_leg,
        COALESCE(d.amount_usd,
            CASE WHEN s_b.address IS NOT NULL THEN CAST(d.token_bought_amount_raw AS double) / 1e18
                 WHEN s_s.address IS NOT NULL THEN CAST(d.token_sold_amount_raw AS double) / 1e18 END * cl.price) AS volume_usd
    FROM dex.trades d
    LEFT JOIN stock_tokens s_b ON s_b.address = d.token_bought_address LEFT JOIN stock_tokens s_s ON s_s.address = d.token_sold_address
    LEFT JOIN pad_tokens pb ON pb.address = d.token_bought_address LEFT JOIN pad_tokens ps ON ps.address = d.token_sold_address
    LEFT JOIN long_tokens lb ON lb.address = d.token_bought_address LEFT JOIN long_tokens ls ON ls.address = d.token_sold_address
    LEFT JOIN pair_txs p ON p.tx_hash = d.tx_hash
    LEFT JOIN query_8076065 cl ON cl.token_address = COALESCE(s_b.address, s_s.address) AND cl.hr = CAST(DATE_TRUNC('hour', d.block_time) AS TIMESTAMP) AND d.amount_usd IS NULL
    WHERE d.blockchain = 'robinhood' AND d.block_date >= DATE '2026-07-01'
      AND (s_b.address IS NOT NULL OR s_s.address IS NOT NULL) AND NOT (s_b.address IS NOT NULL AND s_s.address IS NOT NULL)
),
rialto_txs AS (SELECT hash AS tx_hash FROM robinhood.transactions WHERE block_date >= DATE '2026-07-01' AND "to" = 0x4262efbd176f02824af27010bea218429c33c7e8),
venue_stock_txs AS (
    SELECT DISTINCT l.tx_hash FROM robinhood.logs l JOIN rialto_txs r ON r.tx_hash = l.tx_hash JOIN stock_tokens s ON s.address = l.contract_address
    WHERE l.block_date >= DATE '2026-07-01' AND l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
),
rialto_vol AS (
    SELECT COALESCE(SUM(quote_amt), 0) AS vol FROM (
        SELECT l.tx_hash, MAX(varbinary_to_uint256(varbinary_substring(l.data, 1, 32)) / 1e6) AS quote_amt
        FROM robinhood.logs l JOIN venue_stock_txs vs ON vs.tx_hash = l.tx_hash
        WHERE l.block_date >= DATE '2026-07-01' AND l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
          AND l.contract_address = 0x5fc5360d0400a0fd4f2af552add042d716f1d168
        GROUP BY 1)
)
SELECT
    100.0 * SUM(CASE WHEN is_long THEN volume_usd END) / NULLIF(SUM(CASE WHEN is_pair THEN volume_usd END), 0) AS long_share_pct,
    SUM(CASE WHEN is_long THEN volume_usd END) AS long_pair_volume_usd,
    SUM(CASE WHEN is_pair THEN volume_usd END) AS pair_volume_usd,
    100.0 * SUM(CASE WHEN is_long AND block_time >= NOW() - INTERVAL '7' DAY THEN volume_usd END) / NULLIF(SUM(CASE WHEN is_pair AND block_time >= NOW() - INTERVAL '7' DAY THEN volume_usd END), 0) AS long_share_pct_7d,
    100.0 * SUM(CASE WHEN is_long AND block_time >= NOW() - INTERVAL '24' HOUR THEN volume_usd END) / NULLIF(SUM(CASE WHEN is_pair AND block_time >= NOW() - INTERVAL '24' HOUR THEN volume_usd END), 0) AS long_share_pct_24h,
    SUM(CASE WHEN is_long AND block_time >= NOW() - INTERVAL '24' HOUR THEN volume_usd END) AS long_pair_volume_24h_usd,
    SUM(CASE WHEN is_pair AND block_time >= NOW() - INTERVAL '24' HOUR THEN volume_usd END) AS pair_volume_24h_usd,
    SUM(CASE WHEN NOT is_routed_leg THEN volume_usd END) + (SELECT vol FROM rialto_vol) AS total_stock_trading_volume_usd,
    100.0 * SUM(CASE WHEN is_long THEN volume_usd END) / NULLIF(SUM(CASE WHEN NOT is_routed_leg THEN volume_usd END) + (SELECT vol FROM rialto_vol), 0) AS long_of_all_stock_pct
FROM stock_dex

-- ===================================================================================
-- query_8237922  LONG widget: stock traders vs LONG traders
-- ===================================================================================
WITH stock_tokens AS (SELECT token_address FROM query_8071980 GROUP BY 1),
long_assets AS (SELECT DISTINCT asset FROM query_8032167),
dex_stock AS (
    SELECT d.tx_from AS trader, MAX(CASE WHEN la_b.asset IS NOT NULL OR la_s.asset IS NOT NULL THEN 1 ELSE 0 END) AS traded_long_pair
    FROM dex.trades d
    LEFT JOIN stock_tokens sb ON sb.token_address = d.token_bought_address LEFT JOIN stock_tokens ss ON ss.token_address = d.token_sold_address
    LEFT JOIN long_assets la_b ON la_b.asset = d.token_bought_address LEFT JOIN long_assets la_s ON la_s.asset = d.token_sold_address
    WHERE d.blockchain = 'robinhood' AND d.block_date >= DATE '2026-06-01' AND (sb.token_address IS NOT NULL OR ss.token_address IS NOT NULL)
    GROUP BY 1
),
rialto AS (SELECT DISTINCT "from" AS trader FROM robinhood.transactions WHERE block_date >= DATE '2026-06-01' AND "to" = 0x4262efbd176f02824af27010bea218429c33c7e8),
stock_traders AS (SELECT trader FROM dex_stock UNION SELECT trader FROM rialto),
long_traders AS (SELECT DISTINCT trader FROM query_8032229 WHERE NOT is_buyback)
SELECT
    (SELECT COUNT(*) FROM stock_traders) AS stock_traders_all_venues,
    (SELECT COUNT(*) FROM dex_stock) AS stock_traders_dex_only,
    (SELECT COUNT(*) FROM rialto) AS rialto_venue_traders,
    (SELECT COUNT(*) FROM long_traders) AS long_traders,
    (SELECT COUNT(*) FROM dex_stock WHERE traded_long_pair = 1) AS long_stockpair_traders_dex,
    (SELECT COUNT(*) FROM long_traders lt JOIN stock_traders st ON st.trader = lt.trader) AS overlap_traders,
    ROUND(100.0 * (SELECT COUNT(*) FROM long_traders) / (SELECT COUNT(*) FROM stock_traders), 2) AS long_vs_stock_pct

-- ===================================================================================
-- query_7979183  launchpad_logic -- robinhood   (Adam Tehc; 834 lines, not reproduced)
-- ===================================================================================
-- Classifies every token on the chain by launchpad from ~85 creator/factory heuristics
-- (v2_pairs from factory 0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f, then noxa, trench, bags,
-- flap, ape, clanker, leavehood, hoodfun, robinfun, balloon, bullmarkets, bowfun, retake, arch,
-- doppler (LONG appears as 'long.xyz' via 0x22e99278…), virtuals, klik, uniswap, launchhood,
-- memescash, vladdy, hoodx, dyorswap, pons, coinbarrel, revshare, scherwode, printr, launchfun,
-- veto, imf, recurve, degenlaunch, basedbid, padrush, stoxes, pewfun, potato, basedone, diggers,
-- feather, circus, littlejohn, bullshot, arrow, rain, motion, qian, stok, o1launchpad, revolt,
-- orynth, seven, four, flaunch, mint, fakenoxa, owlto, hoodsmeme, arena, lemon, oro, arrowpad,
-- nior, rialto, easya, stablepad, letscash, woofswap, anypad, rawbin, quiver, forgepad, sushi,
-- gekko, up, blink, higher, poolsfun, trancepad, agenspace, rallypad, feelcash, hooklabs, crayfun).
-- Output: token_address, launchpad ('other' when unmatched). Only `launchpad <> 'other'` is used
-- upstream, as the set of "launchpad tokens" for the stock-pair share. The indexer approximates
-- this set (see docs/dune/README.md) rather than porting 85 heuristics.
