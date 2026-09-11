import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(path.resolve(import.meta.dirname, ".."), "web");
const PORT = Number(process.env.PORT || 8099);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store, max-age=0" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`AI/NVDA monitor -> http://localhost:${PORT}`));
