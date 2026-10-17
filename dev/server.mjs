/* Local preview with working comments: `npm run dev`, then open http://localhost:8888
   (the admin page is at /admin/). Posts are kept in memory and vanish when you stop the server.
   Set ADMIN_KEY to choose the admin key; it defaults to "local-admin-key". The access code
   starts as ACCESS_CODE, or "local code" if that isn't set. */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createMemoryBlobs } from "./memory-blobs.mjs";
import { handleSubmit, handleFeed, handleAdmin, handleAccess, handlePlan, netlifyStores } from "../netlify/lib/core.mjs";
import { PLAN_HTML } from "../netlify/lib/page.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PORT = Number(process.env.PORT || 8888);
const env = { ...process.env, ADMIN_KEY: process.env.ADMIN_KEY || "local-admin-key", IP_SALT: process.env.IP_SALT || "local", ACCESS_CODE: process.env.ACCESS_CODE || "local code" };
const stores = netlifyStores(createMemoryBlobs().getStore);
const plan = (req, context, deps) => handlePlan(req, context, deps, PLAN_HTML);
const routes = { "/api/submit": handleSubmit, "/api/feed": handleFeed, "/api/admin": handleAdmin, "/api/access": handleAccess, "/plan": plan, "/plan/": plan };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const handler = routes[url.pathname];
    if (handler) {
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
      // Lets tests pretend to be different people. Netlify supplies the real address in production.
      const ip = req.headers["x-test-ip"] || req.socket.remoteAddress;
      const response = await handler(request, { ip }, { stores, env });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    const missing = e && (e.code === "ENOENT" || e.code === "EISDIR");
    res.writeHead(missing ? 404 : 500, { "content-type": "text/plain; charset=utf-8" }).end(missing ? "Not found" : "Server error");
    if (!missing) console.error(e);
  }
}).listen(PORT, () => {
  console.log("Bylaws site running at http://localhost:" + PORT + "  (access code: " + (process.env.ACCESS_CODE ? "from ACCESS_CODE" : "local code") + "; admin: /admin/, key: " + (process.env.ADMIN_KEY ? "from ADMIN_KEY" : "local-admin-key") + ")");
});
