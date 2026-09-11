import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const DATA_DIR = path.join(ROOT, "web", "data");
const STATE_FILE = path.join(ROOT, ".cache", "state.json");

/** Resumable key-value state so repeat runs only scan new blocks. */
export class Store {
  constructor() {
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { this.state = {}; }
  }
  get(k) { return this.state[k]; }
  set(k, v) { this.state[k] = v; return this; }
  save() {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state));
  }
}

/** Write a JSON artifact the static site will fetch. */
export function writeData(name, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = path.join(DATA_DIR, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  wrote web/data/${name} (${kb} KB)`);
}

export function readData(name, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8")); }
  catch { return fallback; }
}

/** BigInt-safe JSON: serialise as decimal strings. */
export const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
