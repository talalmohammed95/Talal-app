// Runs the built site and the API together on your computer, the way Vercel serves them.
//   DATABASE_URL=postgres://... ADMIN_EMAIL=you@company.com npm run dev
// Emails are written to dev-mail.log instead of being sent, unless SMTP_HOST is set.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

if (!process.env.SMTP_HOST && !process.env.MAIL_LOG_FILE) process.env.MAIL_LOG_FILE = "dev-mail.log";
const { default: api } = await import("../api/index.js");
const port = Number(process.env.PORT || 3000);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg" };

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) return api(req, res);
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join("dist", path.endsWith("/") ? path + "index.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(port, () => console.log(`Peninsula Offers running at http://localhost:${port}`));
