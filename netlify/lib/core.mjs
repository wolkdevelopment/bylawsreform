/* Shared logic for the bylaws site's three functions: settings, validation, rate limits and storage.
   Storage is Netlify Blobs. Each function passes its stores in, so tests and the local dev server
   can use an in-memory copy (dev/memory-blobs.mjs). Nothing here touches the network itself. */
import crypto from "node:crypto";
import { REPAIR_IDS, BLOCK_UIDS } from "./ids.mjs";

const REPAIRS = new Set(REPAIR_IDS);
const BLOCKS = new Set(BLOCK_UIDS);

export const ROLES = {
  "pco-elected": "Elected PCO",
  "pco-appointed": "Appointed PCO",
  "captain": "Precinct Captain",
  "county-officer": "County party officer",
  "district-officer": "District officer",
  "member": "Dues-paying member",
  "other": "Other or guest"
};
const NEEDS_PRECINCT = new Set(["pco-elected", "pco-appointed", "captain"]);
export const POSITIONS = { support: "Support", oppose: "Oppose", changes: "Support with changes", question: "Question" };

/* ---------- settings ---------- */
// Every limit can be changed from the admin page at any time (saved in Blobs, no redeploy).
// Environment variables only change the starting values.
export const DEFAULTS = Object.freeze({
  open: true,               // accept new comments and proposals at all
  proposalsOpen: true,      // accept new member proposals
  moderation: "hold",       // "hold": nothing shows until approved; "publish": shows at once
  ipPerHour: 6,             // accepted submissions per person (IP address) per rolling hour
  ipPerDay: 20,             // ... per rolling 24 hours
  allPerHour: 100,          // accepted submissions from everyone together per rolling hour
  allPerDay: 500,           // ... per rolling 24 hours
  maxCommentChars: 2000,
  maxProposalChars: 8000
});
const RANGES = {
  ipPerHour: [1, 1000], ipPerDay: [1, 10000], allPerHour: [1, 100000], allPerDay: [1, 1000000],
  maxCommentChars: [100, 20000], maxProposalChars: [500, 50000]
};
const ENV_KEYS = {
  ipPerHour: "RL_IP_PER_HOUR", ipPerDay: "RL_IP_PER_DAY", allPerHour: "RL_ALL_PER_HOUR", allPerDay: "RL_ALL_PER_DAY",
  maxCommentChars: "MAX_COMMENT_CHARS", maxProposalChars: "MAX_PROPOSAL_CHARS"
};
const HOUR = 3600e3, DAY = 24 * HOUR;
const MAX_BODY = 64 * 1024;

export function cleanConfig(input, base = DEFAULTS) {
  const out = { ...base }, errors = {};
  if (!input || typeof input !== "object") return { config: out, errors };
  for (const k of ["open", "proposalsOpen"]) {
    if (!(k in input)) continue;
    if (input[k] === true || input[k] === "true") out[k] = true;
    else if (input[k] === false || input[k] === "false") out[k] = false;
    else errors[k] = "Choose yes or no.";
  }
  if ("moderation" in input) {
    if (input.moderation === "hold" || input.moderation === "publish") out.moderation = input.moderation;
    else errors.moderation = "Choose hold or publish.";
  }
  for (const [k, [lo, hi]] of Object.entries(RANGES)) {
    if (!(k in input)) continue;
    const n = typeof input[k] === "string" && input[k].trim() !== "" ? Number(input[k]) : input[k];
    if (!Number.isInteger(n) || n < lo || n > hi) errors[k] = `Use a whole number from ${lo} to ${hi}.`;
    else out[k] = n;
  }
  if (out.ipPerDay < out.ipPerHour) errors.ipPerDay = "The daily limit can't be lower than the hourly limit.";
  if (out.allPerDay < out.allPerHour) errors.allPerDay = "The daily limit can't be lower than the hourly limit.";
  return { config: out, errors };
}

function envConfig(env) {
  const o = {};
  for (const [k, name] of Object.entries(ENV_KEYS)) if (env && env[name] != null && env[name] !== "") o[k] = env[name];
  if (env && env.MODERATION) o.moderation = env.MODERATION;
  return o;
}

export async function readConfig(stores, env) {
  // Invalid environment values are ignored rather than breaking the site.
  const fromEnv = cleanConfig(envConfig(env)).config;
  const saved = await stores.config.get("settings", { type: "json" });
  return cleanConfig(saved || {}, fromEnv).config;
}

/* ---------- small helpers ---------- */
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

async function readJson(req) {
  const len = Number(req.headers.get("content-length") || 0);
  const tooLarge = () => ({ error: json(413, { error: "too_large", message: "That's too long to send." }) });
  if (len > MAX_BODY) return tooLarge();
  let text;
  try { text = await req.text(); } catch { return { error: json(400, { error: "bad_request", message: "The request couldn't be read." }) }; }
  if (text.length > MAX_BODY) return tooLarge();
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return { body: v };
  } catch {
    return { error: json(400, { error: "bad_json", message: "The request couldn't be read." }) };
  }
}

function clean(s, max) {
  if (typeof s !== "string") return "";
  return s.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max + 1);
}
function oneLine(s, max) { return clean(s, max).replace(/\s+/g, " "); }
function tooManyLinks(s) { return (s.match(/https?:\/\/|www\./gi) || []).length > 3; }
function firstMessage(errors) { const k = Object.keys(errors)[0]; return k ? errors[k] : "Something is missing."; }

export function ldOf(precinct) {
  const m = /^(\d{1,2})-\d{2,4}$/.exec(precinct || "");
  return m ? String(Number(m[1])) : null;
}
export function hashIp(ip, env) {
  const salt = (env && (env.IP_SALT || env.ADMIN_KEY)) || "pcrp-bylaws";
  return crypto.createHmac("sha256", salt).update(String(ip || "unknown")).digest("hex").slice(0, 32);
}
function makeId(t) { return t.toString(36) + "-" + crypto.randomBytes(5).toString("hex"); }
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function clientIp(req, context) {
  return (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
}
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  async function worker() { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function minutes(sec) {
  const m = Math.max(1, Math.ceil(sec / 60));
  if (m < 90) return m === 1 ? "a minute" : m + " minutes";
  const h = Math.round(m / 60);
  return h === 1 ? "an hour" : h + " hours";
}

/* ---------- compare-and-swap on one stored document ----------
   Netlify Blobs has no atomic increment, so counters and the public feed are updated with
   conditional writes (onlyIfMatch / onlyIfNew) and retried when two requests collide. */
export async function cas(store, key, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : null;
    const next = fn(data == null ? null : structuredClone(data));
    if (next === undefined) return { data, changed: false };
    const res = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag })
                    : await store.setJSON(key, next, { onlyIfNew: true });
    if (res && res.modified) return { data: next, changed: true };
    await wait(15 + Math.random() * 40 * (i + 1));
  }
  const err = new Error("busy");
  err.code = "busy";
  throw err;
}

/* ---------- rate limits ---------- */
function windowCheck(times, now, perHour, perDay) {
  const t = (Array.isArray(times) ? times : []).filter(x => typeof x === "number" && x > now - DAY).sort((a, b) => a - b);
  const inHour = t.filter(x => x > now - HOUR);
  if (inHour.length >= perHour) return { blocked: true, retryAfter: Math.max(1, Math.ceil((inHour[0] + HOUR - now) / 1000)), t };
  if (t.length >= perDay) return { blocked: true, retryAfter: Math.max(1, Math.ceil((t[0] + DAY - now) / 1000)), t };
  return { blocked: false, t };
}

export async function takeSlot(limits, ipHash, cfg, now) {
  const ipKey = "ip/" + ipHash;
  try {
    await cas(limits, ipKey, d => {
      const w = windowCheck(d && d.t, now, cfg.ipPerHour, cfg.ipPerDay);
      if (w.blocked) throw { limited: "ip", retryAfter: w.retryAfter };
      w.t.push(now);
      return { t: w.t.slice(-cfg.ipPerDay) };
    });
  } catch (e) {
    if (e && e.limited) return { ok: false, scope: e.limited, retryAfter: e.retryAfter };
    throw e;
  }
  try {
    await cas(limits, "all", d => {
      const w = windowCheck(d && d.t, now, cfg.allPerHour, cfg.allPerDay);
      if (w.blocked) throw { limited: "all", retryAfter: w.retryAfter };
      w.t.push(now);
      return { t: w.t.slice(-cfg.allPerDay) };
    });
  } catch (e) {
    // The site-wide limit was hit: give this person's slot back.
    await cas(limits, ipKey, d => (d && Array.isArray(d.t) ? { t: d.t.filter(x => x !== now) } : undefined)).catch(() => {});
    if (e && e.limited) return { ok: false, scope: e.limited, retryAfter: e.retryAfter };
    throw e;
  }
  return { ok: true };
}

function limitMessage(slot) {
  if (slot.scope === "ip") return "You've sent as many comments as this site allows for now. You can send more in about " + minutes(slot.retryAfter) + ".";
  if (slot.scope === "all") return "The site has reached its limit for new comments for now. Please try again in about " + minutes(slot.retryAfter) + ".";
  return "The site is busy. Please try again in a few seconds.";
}

/* ---------- validation ---------- */
function validatePerson(b, errors) {
  const name = oneLine(b.name, 80);
  if (name.length < 2 || name.length > 80) errors.name = "Enter your name.";
  const email = oneLine(b.email, 120).toLowerCase();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Enter a working email address.";
  const role = typeof b.role === "string" && Object.prototype.hasOwnProperty.call(ROLES, b.role) ? b.role : null;
  if (!role) errors.role = "Choose your role.";
  const precinct = oneLine(typeof b.precinct === "string" ? b.precinct : "", 16);
  if (precinct && !/^[0-9A-Za-z][0-9A-Za-z -]{0,15}$/.test(precinct)) errors.precinct = "Use your precinct number, like 27-488.";
  else if (!precinct && role && NEEDS_PRECINCT.has(role)) errors.precinct = "Enter your precinct number, like 27-488.";
  return { name, email, role, precinct: precinct || null, ld: ldOf(precinct), showName: b.showName !== false };
}

function validateComment(b, cfg, errors) {
  const target = typeof b.target === "string" ? b.target : "";
  let ok = false;
  if (/^r:[A-Za-z0-9]{1,8}$/.test(target)) ok = REPAIRS.has(target.slice(2));
  else if (/^p:[a-z0-9-]{8,40}$/.test(target)) ok = true; // checked against stored proposals below
  if (!ok) errors.target = "That item isn't open for comments.";
  const position = typeof b.position === "string" && Object.prototype.hasOwnProperty.call(POSITIONS, b.position) ? b.position : null;
  if (!position) errors.position = "Choose support, oppose, support with changes, or question.";
  const text = clean(b.text, cfg.maxCommentChars);
  if (!text) errors.text = "Write your comment.";
  else if (text.length > cfg.maxCommentChars) errors.text = "Keep your comment under " + cfg.maxCommentChars.toLocaleString("en-US") + " characters.";
  else if (tooManyLinks(text)) errors.text = "Please include no more than three links.";
  return { target, position, text };
}

const NEW_ID = /^(\d{1,2}(\.\d{1,2}){1,3}|SR [A-K](\.\d{1,2}){0,2}(\.[a-z])?)$/;
function validateProposal(b, cfg, errors) {
  const title = oneLine(b.title, 120);
  if (title.length < 4 || title.length > 120) errors.title = "Give your proposal a short title.";
  const why = clean(b.why, 3000);
  if (!why) errors.why = "Say in a sentence or two why it's needed.";
  else if (why.length > 3000) errors.why = "Keep the explanation under 3,000 characters.";
  else if (tooManyLinks(why)) errors.why = "Please include no more than three links.";
  const mode = b.mode === "add" || b.mode === "change" ? b.mode : null;
  if (!mode) errors.mode = "Choose whether you're changing a section or adding one.";
  const section = typeof b.section === "string" && BLOCKS.has(b.section) ? b.section : null;
  if (!section) errors.section = "Choose a section.";
  let newId = null, newTitle = null;
  if (mode === "add") {
    newId = oneLine(typeof b.newId === "string" ? b.newId : "", 16);
    if (!NEW_ID.test(newId)) errors.newId = "Give the new section a number, like 4.8.";
    else if (BLOCKS.has(newId)) errors.newId = "There is already a section " + newId + ".";
    newTitle = oneLine(typeof b.newTitle === "string" ? b.newTitle : "", 120) || null;
  }
  const nodes = [];
  let total = 0, bad = false;
  if (!Array.isArray(b.nodes) || b.nodes.length > 60) bad = true;
  else for (const n of b.nodes) {
    if (!n || typeof n !== "object") { bad = true; break; }
    const k = n.k === "i" || n.k === "h" ? n.k : "p";
    const t = clean(n.t, 4000).replace(/\s*\n\s*/g, " ");
    if (!t) continue;
    if (k === "i") {
      const l = oneLine(typeof n.l === "string" ? n.l : "", 4);
      if (!/^(([A-Za-z]|\d{1,2})\.|–)$/.test(l)) { bad = true; break; }
      nodes.push({ k, l, t });
    } else nodes.push({ k, t });
    total += t.length;
  }
  if (bad || !nodes.length) errors.nodes = "Write the wording of your amendment.";
  else if (total > cfg.maxProposalChars) errors.nodes = "Keep the wording under " + cfg.maxProposalChars.toLocaleString("en-US") + " characters.";
  return { title, why, mode, section, newId, newTitle, nodes };
}

/* ---------- the public feed ---------- */
export function publicView(r) {
  const show = r.showName !== false;
  const base = { id: r.id, kind: r.kind, created: r.created, role: r.role, ld: r.ld || null, name: show ? r.name : null, precinct: show ? (r.precinct || null) : null };
  if (r.kind === "comment") return { ...base, target: r.target, position: r.position, text: r.text };
  return { ...base, title: r.title, why: r.why, mode: r.mode, section: r.section, newId: r.newId || null, newTitle: r.newTitle || null, nodes: r.nodes };
}
const byCreated = (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);
async function upsertFeed(items, pub) {
  await cas(items, "feed", d => {
    const list = (d && Array.isArray(d.items)) ? d.items : [];
    const i = list.findIndex(x => x.id === pub.id);
    if (i >= 0) list[i] = pub; else list.push(pub);
    list.sort(byCreated);
    return { items: list, updated: new Date().toISOString() };
  });
}
async function removeFromFeed(items, id) {
  await cas(items, "feed", d => {
    if (!d || !Array.isArray(d.items)) return undefined;
    const list = d.items.filter(x => x.id !== id);
    if (list.length === d.items.length) return undefined;
    return { items: list, updated: new Date().toISOString() };
  });
}
async function allItems(items) {
  const { blobs } = await items.list({ prefix: "item/" });
  const list = await mapLimit(blobs || [], 16, x => items.get(x.key, { type: "json" }));
  return list.filter(Boolean);
}

/* ---------- POST /api/submit ---------- */
export async function handleSubmit(req, context, deps) {
  const { stores, env = {}, now = Date.now } = deps;
  if (req.method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json(415, { error: "type", message: "The request couldn't be read." });
  const r = await readJson(req);
  if (r.error) return r.error;
  const b = r.body;
  // Honeypot: a hidden field people never see. Bots fill it in; answer normally and save nothing.
  if (typeof b.website === "string" && b.website.trim()) return json(200, { ok: true, status: "pending", id: null, item: null });
  const cfg = await readConfig(stores, env);
  if (!cfg.open) return json(403, { error: "closed", message: "Comments are closed right now." });
  const kind = b.kind === "proposal" || b.kind === "comment" ? b.kind : null;
  if (!kind) return json(400, { error: "invalid", message: "The request couldn't be read.", fields: { kind: "Unknown kind." } });
  if (kind === "proposal" && !cfg.proposalsOpen) return json(403, { error: "closed", message: "New proposals are closed right now." });
  const errors = {};
  const person = validatePerson(b, errors);
  const item = kind === "comment" ? validateComment(b, cfg, errors) : validateProposal(b, cfg, errors);
  if (Object.keys(errors).length) return json(400, { error: "invalid", message: firstMessage(errors), fields: errors });
  if (kind === "comment" && item.target.startsWith("p:")) {
    const parent = await stores.items.get("item/" + item.target.slice(2), { type: "json" });
    if (!parent || parent.kind !== "proposal" || parent.status !== "live") {
      return json(400, { error: "invalid", message: "That proposal isn't open for comments.", fields: { target: "That proposal isn't open for comments." } });
    }
  }
  const t = now();
  const ipHash = hashIp(clientIp(req, context), env);
  let slot;
  try { slot = await takeSlot(stores.limits, ipHash, cfg, t); }
  catch { slot = { ok: false, scope: "busy", retryAfter: 5 }; }
  if (!slot.ok) {
    return json(429, { error: "rate_limited", scope: slot.scope, retryAfter: slot.retryAfter, message: limitMessage(slot) }, { "retry-after": String(slot.retryAfter) });
  }
  const rec = {
    id: makeId(t), kind, status: cfg.moderation === "publish" ? "live" : "pending",
    created: new Date(t).toISOString(), ...person, ...item, ipHash
  };
  await stores.items.setJSON("item/" + rec.id, rec, { onlyIfNew: true });
  if (rec.status === "live") await upsertFeed(stores.items, publicView(rec));
  return json(200, { ok: true, status: rec.status, id: rec.id, item: rec.status === "live" ? publicView(rec) : null });
}

/* ---------- GET /api/feed ---------- */
export async function handleFeed(req, context, deps) {
  const { stores, env = {} } = deps;
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method" }, { allow: "GET" });
  const [feed, cfg] = await Promise.all([stores.items.get("feed", { type: "json" }), readConfig(stores, env)]);
  return json(200, {
    items: (feed && Array.isArray(feed.items)) ? feed.items : [],
    config: { open: cfg.open, proposalsOpen: cfg.proposalsOpen, moderation: cfg.moderation, maxCommentChars: cfg.maxCommentChars, maxProposalChars: cfg.maxProposalChars }
  }, {
    // Browsers always ask again; Netlify's CDN may serve a copy up to 15 seconds old.
    "cache-control": "public, max-age=0, must-revalidate",
    "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=45"
  });
}

/* ---------- POST /api/admin ---------- */
function csvCell(v) {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running a cell as a formula
  return '"' + s.replace(/"/g, '""') + '"';
}
const CSV_COLS = ["id", "kind", "status", "created", "moderated", "target", "name", "email", "role", "precinct", "ld", "showName", "position", "title", "why", "text", "mode", "section", "newId", "newTitle", "nodes", "ipHash"];

export async function handleAdmin(req, context, deps) {
  const { stores, env = {}, now = Date.now } = deps;
  if (req.method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!env.ADMIN_KEY || String(env.ADMIN_KEY).length < 12) {
    return json(503, { error: "admin_disabled", message: "Set ADMIN_KEY (12 or more characters) in Netlify's environment variables, then redeploy." });
  }
  const t = now();
  const failKey = "adminfail/" + hashIp(clientIp(req, context), env);
  const fails = await stores.limits.get(failKey, { type: "json" });
  if (((fails && fails.t) || []).filter(x => x > t - HOUR).length >= 10) {
    return json(429, { error: "locked", message: "Too many wrong keys from this connection. Try again in an hour." });
  }
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_KEY)) {
    await cas(stores.limits, failKey, d => ({ t: [...((d && d.t) || []).filter(x => x > t - HOUR), t] })).catch(() => {});
    return json(401, { error: "unauthorized", message: "That key isn't right." });
  }
  const r = await readJson(req);
  if (r.error) return r.error;
  const b = r.body;
  const idOk = typeof b.id === "string" && /^[a-z0-9-]{8,40}$/.test(b.id);

  switch (b.action) {
    case "list": {
      const items = (await allItems(stores.items)).sort((x, y) => byCreated(y, x));
      const all = await stores.limits.get("all", { type: "json" });
      const times = ((all && all.t) || []).filter(x => typeof x === "number");
      return json(200, {
        items,
        config: await readConfig(stores, env),
        usage: { lastHour: times.filter(x => x > t - HOUR).length, lastDay: times.filter(x => x > t - DAY).length }
      });
    }
    case "set-status": {
      if (!idOk || !["live", "hidden", "pending"].includes(b.status)) return json(400, { error: "invalid", message: "Unknown item or status." });
      const res = await cas(stores.items, "item/" + b.id, d => (d ? { ...d, status: b.status, moderated: new Date(t).toISOString() } : undefined));
      if (!res.changed) return json(404, { error: "not_found", message: "That item no longer exists." });
      if (b.status === "live") await upsertFeed(stores.items, publicView(res.data));
      else await removeFromFeed(stores.items, b.id);
      return json(200, { ok: true, item: res.data });
    }
    case "delete": {
      if (!idOk) return json(400, { error: "invalid", message: "Unknown item." });
      await stores.items.delete("item/" + b.id);
      await removeFromFeed(stores.items, b.id);
      return json(200, { ok: true });
    }
    case "get-config":
      return json(200, { config: await readConfig(stores, env), defaults: DEFAULTS });
    case "set-config": {
      const { config, errors } = cleanConfig(b.config || {}, await readConfig(stores, env));
      if (Object.keys(errors).length) return json(400, { error: "invalid", message: firstMessage(errors), fields: errors });
      await stores.config.setJSON("settings", config);
      return json(200, { ok: true, config });
    }
    case "rebuild-feed": {
      const live = (await allItems(stores.items)).filter(x => x.status === "live").map(publicView).sort(byCreated);
      await stores.items.setJSON("feed", { items: live, updated: new Date(t).toISOString() });
      return json(200, { ok: true, count: live.length });
    }
    case "cleanup": {
      let removed = 0;
      for (const prefix of ["ip/", "adminfail/"]) {
        const { blobs } = await stores.limits.list({ prefix });
        await mapLimit(blobs || [], 16, async x => {
          const d = await stores.limits.get(x.key, { type: "json" });
          if (!d || !((d.t || []).some(v => v > t - DAY))) { await stores.limits.delete(x.key); removed++; }
        });
      }
      return json(200, { ok: true, removed });
    }
    case "export": {
      const items = (await allItems(stores.items)).sort(byCreated);
      const rows = [CSV_COLS.join(",")].concat(items.map(x => CSV_COLS.map(c => csvCell(x[c])).join(",")));
      return json(200, { csv: rows.join("\r\n") + "\r\n", count: items.length });
    }
    default:
      return json(400, { error: "action", message: "Unknown action." });
  }
}

/* ---------- wiring for Netlify ---------- */
export function netlifyStores(getStore) {
  const s = name => getStore({ name, consistency: "strong" });
  return { items: s("bylaws-items"), limits: s("bylaws-limits"), config: s("bylaws-config") };
}
