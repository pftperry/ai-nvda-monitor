/* One-off local backfill of the holder replay, outside the full indexer so it
   does not rewrite every other artifact at reduced coverage. Same task, same
   store key, same artifact the indexer produces. */
import { Store, writeData } from "../src/store.mjs";
import { TimeMap } from "../src/timemap.mjs";
import { blockNumber } from "../src/rpc.mjs";
import { indexHolders, usdPriceLookup } from "../src/tasks/holders.mjs";
import fs from "node:fs";

const store = new Store();
const tm = TimeMap.fromJSON(store.get("timemap"));
const latest = await blockNumber();
await tm.build(tm.toJSON().at(-1)?.[0] ?? latest, latest);
const flow = JSON.parse(fs.readFileSync("web/data/flow.json", "utf8"));
const t0 = Date.now();
const out = await indexHolders(latest, tm, { state: store.get("holders"), priceAt: usdPriceLookup(flow.pools) });
store.set("holders", out.state);
store.save();
writeData("holders.json", { updatedAt: Math.floor(Date.now() / 1000), ...out.artifact });
const last = out.artifact.snapshots.at(-1);
console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min; complete=${out.artifact.complete}`);
console.log("reconciliation", JSON.stringify(out.artifact.reconciliation));
console.log("latest snapshot", JSON.stringify(last));
