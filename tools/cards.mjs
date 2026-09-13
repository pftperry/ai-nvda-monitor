/**
 * Social cards, generated from the indexed artifacts.
 *
 * Every figure comes out of web/data at run time. Nothing is typed in, so a card
 * cannot quietly go stale and anyone who checks a number against the site finds
 * the same one. Complete days only, for the reason completeDays() exists on the
 * site: a partial final bucket manufactures a trend.
 *
 * The three cards are one argument in order, and each says its own link out loud:
 *   1  the launchpad mints at scale        -> every token needs a base pair
 *   2  a quarter of AI volume is routing   -> AI is the road others travel
 *   3  every route pays a fee in AI        -> the float shrinks mechanically
 *
 *   node tools/cards.mjs
 */
import fs from "node:fs";
import path from "node:path";

const DATA = "web/data";
const OUT = "tools/cards";
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f + ".json"), "utf8"));

const lp = read("launchpad");
const burns = read("burns");
const routing = read("routing");

const W = 1600, H = 900;
const C = {
  bg: "#0d0f12",
  panel: "#151a20",
  text: "#f2f4f7",
  dim: "#93a0b0",
  faint: "#5c6875",
  accent: "#3fd28b",
  other: "#3a444f",
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x) => Math.round(x).toLocaleString("en-US");
const pctS = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const dayLbl = (t) => new Date(t * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const DAY_NOW = Math.floor(Date.now() / 86400000) * 86400;
const complete = (rows) => rows.filter((d) => d.t < DAY_NOW);

function frame(inner, { step, footnote }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <text x="72" y="66" font-family="${MONO}" font-size="22" fill="${C.accent}" letter-spacing="2">${esc(step)}</text>
  ${inner}
  <text x="72" y="${H - 40}" font-family="${MONO}" font-size="21" fill="${C.faint}">pftperry.github.io/ai-nvda-monitor</text>
  ${footnote ? `<text x="${W - 72}" y="${H - 40}" text-anchor="end" font-family="${FONT}" font-size="21" fill="${C.faint}">${esc(footnote)}</text>` : ""}
</svg>`;
}
const title = (t) => `<text x="72" y="140" font-family="${FONT}" font-size="56" font-weight="700" fill="${C.text}">${esc(t)}</text>`;
const sub = (t) => `<text x="72" y="188" font-family="${FONT}" font-size="26" fill="${C.dim}">${esc(t)}</text>`;

/* The "so what" block. Every card carries one, because a number without the
   mechanism behind it is a statistic and not an argument. */
const why = (y, claim, because) => {
  /* SVG text does not wrap, so the caller passes the lines it wants and the box
     sizes itself to them. The first draft took one long string and ran it off the
     right edge of two cards. */
  const lines = Array.isArray(because) ? because : [because];
  const h = 64 + lines.length * 36;
  return `
  <rect x="72" y="${y}" width="${W - 144}" height="${h}" rx="12" fill="${C.panel}"/>
  <rect x="72" y="${y}" width="6" height="${h}" rx="3" fill="${C.accent}"/>
  <text x="108" y="${y + 46}" font-family="${FONT}" font-size="27" font-weight="700" fill="${C.text}">${esc(claim)}</text>
  ${lines.map((l, i) => `<text x="108" y="${y + 88 + i * 36}" font-family="${FONT}" font-size="25" fill="${C.dim}">${esc(l)}</text>`).join("")}`;
};

/* ---------- 1. Tokens launched per day ---------- */
function cardLaunches() {
  const all = complete(lp.launchesByDay);
  const rows = all.slice(-45);
  const x0 = 132, x1 = W - 80, top = 256, h = 330;
  const max = Math.max(...rows.map((d) => d.launched)) * 1.08;
  const bw = (x1 - x0) / rows.length;
  const w = Math.min(22, bw - 4);

  const grid = [0, 0.5, 1].map((f) => {
    const y = top + h - f * h;
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.other}" stroke-width="1" opacity="0.5"/>
      <text x="${x0 - 18}" y="${y + 8}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.faint}">${n(max * f)}</text>`;
  }).join("");
  const bars = rows.map((d, i) => {
    const bh = (d.launched / max) * h;
    return `<rect x="${(x0 + i * bw + (bw - w) / 2).toFixed(1)}" y="${(top + h - bh).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" rx="4" fill="${C.accent}"/>`;
  }).join("");

  const last7 = rows.slice(-7).reduce((s, d) => s + d.launched, 0);
  const prior7 = rows.slice(-14, -7).reduce((s, d) => s + d.launched, 0);
  const trend = prior7 ? last7 / prior7 - 1 : null;
  const secs = last7 > 0 ? (7 * 86400) / last7 : null;
  const total = all.at(-1).cumulative;
  const aiRank = lp.aiAnchorRank?.rank ?? 3;

  return frame(`
  ${title(secs ? `Long is minting a new token every ${secs.toFixed(0)} seconds` : "Long is minting tokens at scale")}
  ${sub(`Tokens launched per day · ${n(total)} since July · every pool carrying the LONG hook, so this is a census`)}
  ${grid}${bars}
  <text x="${x0}" y="${top + h + 40}" font-family="${MONO}" font-size="20" fill="${C.faint}">${dayLbl(rows[0].t)}</text>
  <text x="${x1}" y="${top + h + 40}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.faint}">${dayLbl(rows.at(-1).t)}</text>
  <text x="${x0}" y="${top + h + 96}" font-family="${MONO}" font-size="34" font-weight="700" fill="${C.text}">${n(last7)}</text>
  <text x="${x0 + 20 + String(n(last7)).length * 21}" y="${top + h + 96}" font-family="${FONT}" font-size="26" fill="${C.dim}">in the last 7 days${trend == null ? "" : `, ${trend >= 0 ? "up" : "down"} ${pctS(Math.abs(trend), 0)} on the week before`}</text>
  ${why(top + h + 128, `Why this matters: every one of those tokens needs a base pair, and AI is the #${aiRank} choice on the platform.`, [
    "A pool anchored in AI has to be seeded with AI before it can trade, so mint volume converts into",
    "AI demand mechanically — no one has to decide they like the token first.",
  ])}`,
    { step: "1 OF 3 · THE FUNNEL", footnote: "census of every LONG-hook pool" });
}

/* ---------- 2. Hub conversion ---------- */
function cardHub() {
  const direct = routing.directAI, cross = routing.crossRoutedAI;
  const share = direct + cross > 0 ? cross / (direct + cross) : 0;
  const kappa = routing.measuredKappaRatio;
  const days = routing.kappaWindowDays;

  /* One bar, one unit, two parts of a total that means something. The site's kappa
     is cross DIVIDED BY direct, a larger number and a different claim; both are
     here, each labelled as the thing it actually is. */
  const bx = 72, bw = W - 144, by = 288, bh = 104;
  const cw = Math.max(60, bw * share);

  return frame(`
  ${title(`${pctS(share, 0)} of AI volume is not people buying AI`)}
  ${sub(`It is other tokens routing through it · last ${days} days · read from transaction structure, not assumed`)}
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="14" fill="${C.other}"/>
  <rect x="${bx}" y="${by}" width="${cw.toFixed(1)}" height="${bh}" rx="14" fill="${C.accent}"/>
  <text x="${bx + 32}" y="${by + 68}" font-family="${MONO}" font-size="44" font-weight="700" fill="#08110d">${pctS(share, 0)}</text>
  <text x="${bx + bw - 32}" y="${by + 68}" text-anchor="end" font-family="${MONO}" font-size="44" font-weight="700" fill="${C.dim}">${pctS(1 - share, 0)}</text>
  <text x="${bx}" y="${by + bh + 42}" font-family="${FONT}" font-size="25" fill="${C.accent}">Routed through AI · ${(cross / 1e6).toFixed(1)}M AI</text>
  <text x="${bx + bw}" y="${by + bh + 42}" text-anchor="end" font-family="${FONT}" font-size="25" fill="${C.dim}">Someone wanted AI · ${(direct / 1e6).toFixed(1)}M AI</text>

  <text x="72" y="${by + bh + 156}" font-family="${MONO}" font-size="66" font-weight="700" fill="${C.text}">κ = ${pctS(kappa, 1)}</text>
  <text x="480" y="${by + bh + 136}" font-family="${FONT}" font-size="25" fill="${C.dim}">cross-routed volume as a share of direct volume,</text>
  <text x="480" y="${by + bh + 170}" font-family="${FONT}" font-size="25" fill="${C.dim}">the ratio the model is built on. Measured, not assumed.</text>
  ${why(by + bh + 236, "Why this matters: routing demand does not need anyone to have an opinion on AI.", [
    "A rotation like BONER → AI → MEME emits two swaps in one transaction. AI is the road, not the",
    "destination — and a road keeps collecting tolls after the traffic stops caring where it is going.",
  ])}`,
    { step: "2 OF 3 · THE CONVERSION", footnote: "observed per transaction" });
}

/* ---------- 3. Float removal ---------- */
function cardFloat() {
  const rows = complete(burns.daily).filter((d) => d.cumBurnAI > 0);
  const gen = burns.genesisSupply;
  /* The chart gives up height so the stats and the "why" block clear the footer.
     At h = 300 the explanation printed straight over the source line. */
  const x0 = 158, x1 = W - 80, top = 248, h = 248;
  const tot = (d) => d.cumBurnAI + d.cumLockAI;
  const max = Math.max(...rows.map(tot)) * 1.1;
  const px = (i) => x0 + (i / (rows.length - 1)) * (x1 - x0);
  const py = (v) => top + h - (v / max) * h;

  const line = rows.map((d, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(tot(d)).toFixed(1)}`).join(" ");
  const area = `${line} L${px(rows.length - 1).toFixed(1)},${top + h} L${px(0).toFixed(1)},${top + h} Z`;
  const grid = [0, 0.5, 1].map((f) => {
    const y = top + h - f * h;
    return `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.other}" stroke-width="1" opacity="0.5"/>
      <text x="${x0 - 18}" y="${y + 8}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.faint}">${((max * f) / 1e6).toFixed(1)}M</text>`;
  }).join("");

  const burned = burns.burned, locked = burns.vault.aiBalance;
  const removed = burned + locked;
  const d30 = rows.length > 30 ? tot(rows.at(-1)) - tot(rows.at(-31)) : null;

  const stat = (x, v, l, c) => `
    <text x="${x}" y="${top + h + 108}" font-family="${MONO}" font-size="48" font-weight="700" fill="${c}">${esc(v)}</text>
    <text x="${x}" y="${top + h + 144}" font-family="${FONT}" font-size="23" fill="${C.dim}">${esc(l)}</text>`;

  return frame(`
  ${title(`${(removed / 1e6).toFixed(1)}M AI has left the float and cannot come back`)}
  ${sub("Burned plus vault-locked, accumulating every single time the fee is taken")}
  ${grid}
  <path d="${area}" fill="${C.accent}" opacity="0.16"/>
  <path d="${line}" fill="none" stroke="${C.accent}" stroke-width="4" stroke-linejoin="round"/>
  <circle cx="${px(rows.length - 1)}" cy="${py(tot(rows.at(-1)))}" r="9" fill="${C.accent}" stroke="${C.bg}" stroke-width="4"/>
  <text x="${x0}" y="${top + h + 40}" font-family="${MONO}" font-size="20" fill="${C.faint}">${dayLbl(rows[0].t)}</text>
  <text x="${x1}" y="${top + h + 40}" text-anchor="end" font-family="${MONO}" font-size="20" fill="${C.faint}">${dayLbl(rows.at(-1).t)}</text>
  ${stat(72, `${(burned / 1e6).toFixed(2)}M`, "burned, destroyed outright", C.accent)}
  ${stat(430, `${(locked / 1e6).toFixed(2)}M`, "locked in the community vault", C.accent)}
  ${stat(820, pctS(removed / gen, 2), "of the genesis supply", C.text)}
  ${d30 == null ? "" : stat(1150, d30 >= 1e6 ? `${(d30 / 1e6).toFixed(2)}M` : `${(d30 / 1e3).toFixed(0)}K`, "removed in the last 30 days", C.text)}
  ${why(top + h + 174, "Why this matters: the burn is not a schedule, it is a function of usage.", [
    "Every swap that routes through AI pays its fee in AI, and that fee splits exactly 1:1 — half",
    "destroyed, half locked in the vault. More activity is less float, automatically.",
  ])}`,
    { step: "3 OF 3 · THE PAYOFF", footnote: "summed from the splitter's own transfers" });
}

fs.mkdirSync(OUT, { recursive: true });
const cards = { "launches-per-day": cardLaunches(), "hub-conversion": cardHub(), "float-removal": cardFloat() };
for (const [name, svg] of Object.entries(cards)) {
  fs.writeFileSync(path.join(OUT, name + ".svg"), svg);
  console.log(`  wrote ${OUT}/${name}.svg`);
}
