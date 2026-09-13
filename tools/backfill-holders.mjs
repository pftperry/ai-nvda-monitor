/* Local backfill of the holder replay, outside the full indexer so it does not
   rewrite every other artifact at reduced coverage. Same task as the indexer runs.

   Two modes:
     node tools/backfill-holders.mjs            resume the cached replay, save to the
                                                store and write holders.json
     node tools/backfill-holders.mjs --rebuild  replay from genesis into a fresh
                                                state and write ONLY the committed
                                                seed (seed/holders-state.json.gz)

   --rebuild never touches .cache/state.json, so it can run beside an indexer run
   without the two overwriting each other's holder state; the next indexer run
   adopts the seed because its schema is newer (see pickHolderState). */
import { Store, writeData } from "../src/store.mjs";
import { TimeMap } from "../src/timemap.mjs";
import { blockNumber } from "../src/rpc.mjs";
import { indexHolders, usdPriceLookup } from "../src/tasks/holders.mjs";
import fs from "node:fs";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const rebuild = argv.includes("--rebuild");
const seedPath = "seed/holders-state.json.gz";

const store = new Store();
const tm = TimeMap.fromJSON(store.get("timemap"));
const latest = await blockNumber();
await tm.build(tm.toJSON().at(-1)?.[0] ?? latest, latest);
const flow = JSON.parse(fs.readFileSync("web/data/flow.json", "utf8"));
const t0 = Date.now();
const out = await indexHolders(latest, tm, {
  state: rebuild ? null : store.get("holders"),
  priceAt: usdPriceLookup(flow.pools),
});
if (rebuild) {
  fs.mkdirSync("seed", { recursive: true });
  fs.writeFileSync(seedPath, zlib.gzipSync(JSON.stringify(out.state)));
  const kb = (fs.statSync(seedPath).size / 1024).toFixed(0);
  console.log(`wrote ${seedPath} (${kb} KB, schema ${out.state.schema}, cursor ${out.state.cursor.toLocaleString()})`);
} else {
  store.set("holders", out.state);
  store.save();
  writeData("holders.json", { updatedAt: Math.floor(Date.now() / 1000), ...out.artifact });
}
const last = out.artifact.snapshots.at(-1);
console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min; complete=${out.artifact.complete}`);
console.log("reconciliation", JSON.stringify(out.artifact.reconciliation));
console.log("latest snapshot", JSON.stringify(last));
console.log(`cohorts ${out.artifact.cohorts.length} weeks; whale moves kept ${out.artifact.whales.length}; first-seen from genesis: ${out.artifact.firstSeenFromGenesis}`);
