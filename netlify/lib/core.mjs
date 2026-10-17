/* Shared logic for the bylaws site's functions: settings, the access code, validation, rate limits and storage.
   The plan page and its comments open only for people who have entered the access code. The front page
   takes the code, or a request for it, which waits on the admin page.
   The site takes one kind of post: a comment on one of the repairs.
   Storage is Netlify Blobs. Each function passes its stores in, so tests and the local dev server
   can use an in-memory copy (dev/memory-blobs.mjs). Nothing here touches the network itself. */
import crypto from "node:crypto";
import { REPAIR_IDS, REPAIR_REVS, REPAIR_LABELS } from "./ids.mjs";

const REPAIRS = new Set(REPAIR_IDS);
// The version of each repair's wording. A comment is stamped with the version it was written on.
export function repairRev(id) { return (REPAIR_REVS && REPAIR_REVS[id]) || 1; }

// The form offers PCO, Precinct Captain, party member and guest, all optional. The older roles stay so earlier comments still display.
export const ROLES = {
  "pco": "PCO",
  "captain": "Precinct Captain",
  "member": "Party member",
  "other": "Guest",
  "pco-elected": "Elected PCO",
  "pco-appointed": "Appointed PCO",
  "county-officer": "County party officer",
  "district-officer": "District officer"
};
// "comment" is used when someone doesn't pick a side. Taking a side is optional.
export const POSITIONS = { support: "Support", oppose: "Oppose", changes: "Support with changes", question: "Question", comment: "Comment" };
// How the moderator's reply to a comment is labeled.
export const REPLIES = { answered: "Answered", changed: "Changed in the revision", kept: "Considered, kept as is", noted: "Noted" };
const MAX_REPLY = 1500;

/* ---------- settings ---------- */
// Every limit can be changed from the admin page at any time (saved in Blobs, no redeploy).
// Environment variables only change the starting values.
export const DEFAULTS = Object.freeze({
  open: true,               // accept new comments
  moderation: "publish",    // "publish": shows at once unless the automatic check holds it; "hold": nothing shows until approved
  ipPerHour: 6,             // accepted submissions per person (IP address) per rolling hour
  ipPerDay: 20,             // ... per rolling 24 hours
  allPerHour: 100,          // accepted submissions from everyone together per rolling hour
  allPerDay: 500,           // ... per rolling 24 hours
  maxCommentChars: 2000,
  replyAs: "the author",    // replies show as "Reply from the author"
  accessCode: ""            // the code that opens the plan; blank keeps it closed to everyone
});
const RANGES = {
  ipPerHour: [1, 1000], ipPerDay: [1, 10000], allPerHour: [1, 100000], allPerDay: [1, 1000000],
  maxCommentChars: [100, 20000]
};
const ENV_KEYS = {
  ipPerHour: "RL_IP_PER_HOUR", ipPerDay: "RL_IP_PER_DAY", allPerHour: "RL_ALL_PER_HOUR", allPerDay: "RL_ALL_PER_DAY",
  maxCommentChars: "MAX_COMMENT_CHARS"
};
const HOUR = 3600e3, DAY = 24 * HOUR;
const MAX_BODY = 64 * 1024;

export function cleanConfig(input, base = DEFAULTS) {
  const out = { ...base }, errors = {};
  if (!input || typeof input !== "object") return { config: out, errors };
  for (const k of ["open"]) {
    if (!(k in input)) continue;
    if (input[k] === true || input[k] === "true") out[k] = true;
    else if (input[k] === false || input[k] === "false") out[k] = false;
    else errors[k] = "Choose yes or no.";
  }
  if ("moderation" in input) {
    if (input.moderation === "hold" || input.moderation === "publish") out.moderation = input.moderation;
    else errors.moderation = "Choose hold or publish.";
  }
  if ("replyAs" in input) {
    const v = typeof input.replyAs === "string" ? input.replyAs.replace(/\s+/g, " ").trim() : "";
    if (v.length < 2 || v.length > 60) errors.replyAs = "Use 2 to 60 characters, like “the author” or your name.";
    else out.replyAs = v;
  }
  if ("accessCode" in input) {
    const v = typeof input.accessCode === "string" ? input.accessCode.replace(/\s+/g, " ").trim() : "";
    if (v && (v.length > 40 || normCode(v).length < 4)) errors.accessCode = "Use at least 4 letters or numbers (40 characters at most), or leave it blank to close the plan.";
    else out.accessCode = v;
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
  if (env && env.ACCESS_CODE) o.accessCode = env.ACCESS_CODE;
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

/* ---------- the access code ----------
   The plan and its comments open only with the code set on the admin page. Entering it sets a cookie
   holding a keyed hash of the code, never the code itself, so changing the code signs everyone out.
   Capitals, spaces and punctuation in the code don't matter. */
export const ACCESS_COOKIE = "bw_access";
const ACCESS_DAYS = 90;
const ACCESS_FAILS_PER_HOUR = 10;           // wrong codes from one connection before an hour's lockout
const REQUESTS_PER_IP_DAY = 5, REQUESTS_ALL_DAY = 200;
const MAX_NOTE = 500;
export function normCode(s) { return typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : ""; }
function accessKey(env) { return (env && (env.ACCESS_SECRET || env.ADMIN_KEY || env.IP_SALT)) || "pcrp-bylaws"; }
export function accessToken(cfg, env) {
  const code = normCode(cfg && cfg.accessCode);
  if (!code) return null;
  return crypto.createHmac("sha256", accessKey(env)).update("access-v1:" + code).digest("base64url");
}
function readCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
export function hasAccess(req, cfg, env) {
  const token = accessToken(cfg, env), got = readCookie(req, ACCESS_COOKIE);
  return !!(token && got && safeEqual(got, token));
}
function accessCookie(req, token) {
  let secure = "";
  try { if (new URL(req.url).protocol === "https:") secure = "; Secure"; } catch { secure = "; Secure"; }
  return ACCESS_COOKIE + "=" + token + "; Path=/; Max-Age=" + ACCESS_DAYS * 86400 + "; HttpOnly; SameSite=Lax" + secure;
}
function locked() {
  return json(401, { error: "locked", message: "Your access code has changed. Reload the page and enter the new code." });
}
// One rolling 24-hour window, used for access requests.
async function takeDaily(limits, key, max, now) {
  try {
    await cas(limits, key, d => {
      const t = ((d && Array.isArray(d.t)) ? d.t : []).filter(x => typeof x === "number" && x > now - DAY).sort((a, b) => a - b);
      if (t.length >= max) throw { limited: true, retryAfter: Math.max(1, Math.ceil((t[0] + DAY - now) / 1000)) };
      t.push(now);
      return { t };
    });
    return { ok: true };
  } catch (e) {
    if (e && e.limited) return { ok: false, retryAfter: e.retryAfter };
    throw e;
  }
}

/* ---------- validation ---------- */
// Only a name is required. Email and precinct are optional, so no one is turned away for skipping them.
function validatePerson(b, errors) {
  const name = oneLine(b.name, 80);
  if (name.length < 2 || name.length > 80) errors.name = "Enter your name.";
  const email = oneLine(typeof b.email === "string" ? b.email : "", 120).toLowerCase();
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) errors.email = "Check your email address, or leave it blank.";
  const precinct = oneLine(typeof b.precinct === "string" ? b.precinct : "", 16);
  if (precinct && !/^[0-9A-Za-z][0-9A-Za-z -]{0,15}$/.test(precinct)) errors.precinct = "Use your precinct number, like 27-488, or leave it blank.";
  // A role is only what the person chose. A precinct alone doesn't make someone a PCO: Precinct Captains have one too.
  let role = null;
  if (b.role != null && b.role !== "") {
    if (typeof b.role === "string" && Object.prototype.hasOwnProperty.call(ROLES, b.role)) role = b.role;
    else errors.role = "Choose your role, or leave it blank.";
  }
  return { name, email: email || null, role, precinct: precinct || null, ld: ldOf(precinct), showName: b.showName !== false };
}

function validateComment(b, cfg, errors) {
  const target = typeof b.target === "string" ? b.target : "";
  if (!/^r:[A-Za-z0-9]{1,8}$/.test(target) || !REPAIRS.has(target.slice(2))) errors.target = "That item isn't open for comments.";
  // Taking a side is optional.
  let position = b.position == null || b.position === "" ? "comment" : b.position;
  if (typeof position !== "string" || !Object.prototype.hasOwnProperty.call(POSITIONS, position)) {
    position = null;
    errors.position = "Choose support, oppose, support with changes, question, or none.";
  }
  const text = clean(b.text, cfg.maxCommentChars);
  if (!text) errors.text = "Write your comment.";
  else if (text.length > cfg.maxCommentChars) errors.text = "Keep your comment under " + cfg.maxCommentChars.toLocaleString("en-US") + " characters.";
  else if (tooManyLinks(text)) errors.text = "Please include no more than three links.";
  return { target, position, text };
}

/* ---------- automatic hold ----------
   With "Show right away" on, a comment that looks like spam or abuse still waits for the moderator.
   Each check returns a short code; the admin page shows it in words. A false alarm only means a
   comment waits for approval, so the checks lean toward holding. The word list is stored in ROT13
   so the repository doesn't spell it out. */
const rot13 = s => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97));
const WORDS = {
  anywhere: "shpx fuvg",
  prefix: "ovgpu onfgneq phag nffubyr wnpxnff qhzonff qvpxurnq pbpxfhpxre chffl juber fyhg gjng jnaxre qbhpur ergneq avttre avttn snttbg xvxr tbbx jrgonpx ornare gbjryurnq enturnq genaal",
  exact: "snt fcvp puvax qlxr pbba"
};
const stretch = w => w.split("").map(ch => ch + "+").join(""); // "fuuuck" still matches
const BAD_WORDS = [].concat(
  rot13(WORDS.anywhere).split(" ").map(w => new RegExp(stretch(w))),
  rot13(WORDS.prefix).split(" ").map(w => new RegExp("(?<![a-z])" + stretch(w))),
  rot13(WORDS.exact).split(" ").map(w => new RegExp("(?<![a-z])" + stretch(w) + "(?:e?s)?(?![a-z])"))
);
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
function plain(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[013457@$]/g, c => LEET[c]);
}
const LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|info|biz|us|io|co|app|site|online|xyz|top|ru|cn|shop|link|click|live)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
// A house number, one or two words, then a street type: "1234 S 56th St", "5512 Pacific Ave".
const ADDRESS_RE = /\b\d{2,6}\s+(?:[nsew]\.?\s+|north\s+|south\s+|east\s+|west\s+)?(?:[a-z0-9'-]+\s+){1,2}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|highway|hwy|parkway|pkwy)\b/i;
// Threats aimed at people. Figures of speech about proposals ("kill this amendment", "shot down") don't match.
const THREAT_RES = [
  /\b(?:kill|shoot|stab|hang|lynch|murder|strangle|choke)(?:s|ed|ing)?\s+(?:[a-z']+\s+){0,2}(?:you|him|her|them|y'?all|everyone|everybody)\b(?!\s+down)/,
  /\b(?:you|he|she|they|y'?all)\s+(?:[a-z']+\s+){0,2}(?:deserves?|ought|should|needs?)\s+to\s+(?:die|be\s+(?:shot|hanged|hung|killed|lynched|beaten|executed|strung\s+up))\b(?!\s+down)/,
  /\b(?:should|will|gonna|going\s+to|ought\s+to)\s+be\s+(?:shot|hanged|lynched|executed|strung\s+up)\b(?!\s+down)/,
  /\b(?:i|we)\s+know\s+where\s+(?:you|he|she|they)\s+lives?\b/,
  /\bwatch\s+(?:your|his|her|their)\s+back\b/,
  /\b(?:you'?ll|you\s+will|you're\s+going\s+to)\s+(?:regret\s+it|be\s+sorry)\b/,
  /\bdie\s+in\s+a\s+fire\b/,
  /\bput\s+a\s+bullet\b|\bbullet\s+(?:in|through)\s+(?:your|his|her|their)\b/,
  /\b(?:burn|torch)\s+(?:down\s+)?(?:your|his|her|their)\s+(?:house|home|car|office)\b/,
  /\bblow\s+up\s+the\s+(?:building|hall|meeting|office)\b|\bbomb\s+(?:the|your|his|her|their)\s+(?:building|hall|meeting|office|house|home)\b/,
  /\b(?:bring|bringing|brought)\s+(?:a|my|our)\s+(?:gun|rifle|pistol|weapon|knife)s?\s+to\b/
];
// Markup or script in a comment is almost always an attack or spam. It could never run here, because
// the page shows comments as plain text, but it shouldn't sit on the public page either.
const CODE_RE = /<\s*\/?\s*(?:script|iframe|img|svg|object|embed|style|form|input|link|meta|body|html|a)\b[^>]*>|javascript\s*:/i;

export function screen(name, text) {
  const both = (name || "") + "\n" + (text || ""), held = [];
  const lower = (text || "").toLowerCase().replace(/[‘’]/g, "'");
  if (THREAT_RES.some(re => re.test(lower))) held.push("threat");
  const p = plain(both);
  if (BAD_WORDS.some(re => re.test(p))) held.push("language");
  if (EMAIL_RE.test(text || "") || PHONE_RE.test(text || "") || ADDRESS_RE.test(text || "")) held.push("contact");
  if (LINK_RE.test(both.replace(new RegExp(EMAIL_RE.source, "gi"), " "))) held.push("link"); // an email address isn't a link
  if (CODE_RE.test(both)) held.push("code");
  const letters = (text || "").match(/[A-Za-z]/g) || [];
  if (letters.length >= 30 && letters.filter(c => c >= "A" && c <= "Z").length / letters.length >= 0.7) held.push("caps");
  if (/(\S)\1{9,}/.test(text || "")) held.push("repeat");
  const all = (text || "").match(/\p{L}/gu) || [], latin = (text || "").match(/\p{Script=Latin}/gu) || [];
  if (all.length >= 20 && (all.length - latin.length) / all.length > 0.3) held.push("script");
  return held;
}

/* ---------- the public feed ---------- */
export function publicView(r) {
  const show = r.showName !== false;
  const v = {
    id: r.id, kind: "comment", created: r.created, role: r.role, ld: r.ld || null,
    name: show ? r.name : null, precinct: show ? (r.precinct || null) : null,
    target: r.target, position: r.position, text: r.text, rev: r.rev || 1
  };
  if (r.response) v.response = { status: r.response.status || null, text: r.response.text || "", by: r.response.by || DEFAULTS.replyAs, at: r.response.at };
  return v;
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
async function allRequests(access) {
  const { blobs } = await access.list({ prefix: "req/" });
  const list = await mapLimit(blobs || [], 16, x => access.get(x.key, { type: "json" }));
  return list.filter(Boolean).sort((x, y) => byCreated(y, x));
}

/* ---------- POST /api/submit ---------- */
export async function handleSubmit(req, context, deps) {
  const { stores, env = {}, now = Date.now } = deps;
  if (req.method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json(415, { error: "type", message: "The request couldn't be read." });
  const cfg = await readConfig(stores, env);
  if (!hasAccess(req, cfg, env)) return locked();
  const r = await readJson(req);
  if (r.error) return r.error;
  const b = r.body;
  // Honeypot: a hidden field people never see. Bots fill it in; answer normally and save nothing.
  if (typeof b.website === "string" && b.website.trim()) return json(200, { ok: true, status: "pending", id: null, item: null });
  if (!cfg.open) return json(403, { error: "closed", message: "Comments are closed right now." });
  if (b.kind != null && b.kind !== "comment") return json(400, { error: "invalid", message: "This site only takes comments.", fields: { kind: "Only comments are accepted." } });
  const kind = "comment";
  const errors = {};
  const person = validatePerson(b, errors);
  const item = validateComment(b, cfg, errors);
  if (Object.keys(errors).length) return json(400, { error: "invalid", message: firstMessage(errors), fields: errors });
  const t = now();
  const ipHash = hashIp(clientIp(req, context), env);
  let slot;
  try { slot = await takeSlot(stores.limits, ipHash, cfg, t); }
  catch { slot = { ok: false, scope: "busy", retryAfter: 5 }; }
  if (!slot.ok) {
    return json(429, { error: "rate_limited", scope: slot.scope, retryAfter: slot.retryAfter, message: limitMessage(slot) }, { "retry-after": String(slot.retryAfter) });
  }
  const held = screen(person.name, item.text);
  const rec = {
    id: makeId(t), kind, status: cfg.moderation === "publish" && !held.length ? "live" : "pending",
    created: new Date(t).toISOString(), ...person, ...item, rev: repairRev(item.target.slice(2)), ipHash
  };
  if (held.length) rec.held = held;
  await stores.items.setJSON("item/" + rec.id, rec, { onlyIfNew: true });
  if (rec.status === "live") await upsertFeed(stores.items, publicView(rec));
  return json(200, { ok: true, status: rec.status, id: rec.id, item: rec.status === "live" ? publicView(rec) : null });
}

/* ---------- GET /api/feed ---------- */
// The page asks once when it opens, and again only when someone taps "Check for new comments."
export async function handleFeed(req, context, deps) {
  const { stores, env = {} } = deps;
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method" }, { allow: "GET" });
  const [feed, cfg] = await Promise.all([stores.items.get("feed", { type: "json" }), readConfig(stores, env)]);
  if (!hasAccess(req, cfg, env)) return locked();
  return json(200, {
    items: ((feed && Array.isArray(feed.items)) ? feed.items : []).filter(x => x && x.kind === "comment"),
    config: { open: cfg.open, moderation: cfg.moderation, maxCommentChars: cfg.maxCommentChars }
  }, {
    // Only for people with the code, so no shared copies: Netlify's CDN must not keep one.
    "cache-control": "private, no-store"
  });
}

/* ---------- /api/access: the front page ----------
   GET says whether this browser already has access. POST { action: "enter", code } checks the code and
   sets the cookie. POST { action: "request", name, email, ... } leaves a request on the admin page. */
export async function handleAccess(req, context, deps) {
  const { stores, env = {}, now = Date.now } = deps;
  const cfg = await readConfig(stores, env);
  if (req.method === "GET" || req.method === "HEAD") return json(200, { access: hasAccess(req, cfg, env), open: !!accessToken(cfg, env) });
  if (req.method !== "POST") return json(405, { error: "method" }, { allow: "GET, POST" });
  if (!(req.headers.get("content-type") || "").includes("application/json")) return json(415, { error: "type", message: "The request couldn't be read." });
  const r = await readJson(req);
  if (r.error) return r.error;
  const b = r.body, t = now(), ipHash = hashIp(clientIp(req, context), env);

  if (b.action === "enter") {
    const failKey = "accessfail/" + ipHash;
    const fails = ((await stores.limits.get(failKey, { type: "json" })) || {}).t || [];
    const recent = fails.filter(x => typeof x === "number" && x > t - HOUR).sort((x, y) => x - y);
    if (recent.length >= ACCESS_FAILS_PER_HOUR) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + HOUR - t) / 1000));
      return json(429, { error: "locked_out", retryAfter, message: "Too many wrong codes from this connection. Try again in about " + minutes(retryAfter) + ", or ask for access below." }, { "retry-after": String(retryAfter) });
    }
    const token = accessToken(cfg, env);
    if (!token) return json(403, { error: "closed", message: "The plan isn't open to anyone right now. You can still ask for access below." });
    const code = normCode(b.code);
    if (!code) return json(400, { error: "invalid", message: "Enter the access code.", fields: { code: "Enter the access code." } });
    if (!safeEqual(code, normCode(cfg.accessCode))) {
      await cas(stores.limits, failKey, d => ({ t: [...((d && d.t) || []).filter(x => x > t - HOUR), t] })).catch(() => {});
      return json(401, { error: "wrong", message: "That code isn't right. Check it and try again, or ask for access below.", fields: { code: "That code isn't right." } });
    }
    return json(200, { ok: true }, { "set-cookie": accessCookie(req, token) });
  }

  if (b.action === "request") {
    // Honeypot, as on comments: answer normally and save nothing.
    if (typeof b.website === "string" && b.website.trim()) return json(200, { ok: true });
    const errors = {};
    const p = validatePerson(b, errors);
    if (!p.email && !errors.email) errors.email = "Enter your email, so the code can be sent to you.";
    const note = clean(b.note, MAX_NOTE);
    if (note.length > MAX_NOTE) errors.note = "Keep the note under " + MAX_NOTE + " characters.";
    if (Object.keys(errors).length) return json(400, { error: "invalid", message: firstMessage(errors), fields: errors });
    const ipKey = "req/" + ipHash;
    let scope = null, retryAfter = 0;
    try {
      const mine = await takeDaily(stores.limits, ipKey, REQUESTS_PER_IP_DAY, t);
      if (!mine.ok) { scope = "ip"; retryAfter = mine.retryAfter; }
      else {
        const all = await takeDaily(stores.limits, "reqall", REQUESTS_ALL_DAY, t);
        if (!all.ok) {
          scope = "all"; retryAfter = all.retryAfter;
          // The site-wide limit was hit: give this person's slot back.
          await cas(stores.limits, ipKey, d => (d && Array.isArray(d.t) ? { t: d.t.filter(x => x !== t) } : undefined)).catch(() => {});
        }
      }
    } catch { scope = "busy"; retryAfter = 5; }
    if (scope) {
      const message = scope === "ip" ? "You've already sent several requests today. The site owner will answer by email."
        : scope === "all" ? "The site has had too many requests today. Please try again tomorrow."
        : "The site is busy. Please try again in a few seconds.";
      return json(429, { error: "rate_limited", scope, retryAfter, message }, { "retry-after": String(retryAfter) });
    }
    const rec = { id: makeId(t), created: new Date(t).toISOString(), status: "new", name: p.name, email: p.email, role: p.role, precinct: p.precinct, note, ipHash };
    await stores.access.setJSON("req/" + rec.id, rec, { onlyIfNew: true });
    return json(200, { ok: true });
  }

  return json(400, { error: "action", message: "Unknown action." });
}

/* ---------- GET /plan: the plan itself ----------
   Served by a function, not as a public file, so it reaches only people with the access code.
   Everyone else is sent to the front page. */
const PAGE_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
export async function handlePlan(req, context, deps, html) {
  const { stores, env = {} } = deps;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const cfg = await readConfig(stores, env);
  if (!hasAccess(req, cfg, env)) {
    return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store", ...PAGE_HEADERS } });
  }
  return new Response(req.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", ...PAGE_HEADERS }
  });
}

/* ---------- POST /api/admin ---------- */
function csvCell(v) {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running a cell as a formula
  return '"' + s.replace(/"/g, '""') + '"';
}
const CSV_COLS = ["id", "status", "created", "moderated", "target", "rev", "name", "email", "role", "precinct", "ld", "showName", "position", "text", "ipHash", "held", "response"];

export async function handleAdmin(req, context, deps) {
  const { stores, env = {}, now = Date.now } = deps;
  if (req.method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
  if (!env.ADMIN_KEY || String(env.ADMIN_KEY).length < 12) {
    return json(503, { error: "admin_disabled", message: "Set ADMIN_KEY (12 or more characters) in Netlify's environment variables, without “Contains secret values” ticked, then redeploy." });
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
        access: await allRequests(stores.access),
        labels: REPAIR_LABELS || {},
        config: await readConfig(stores, env),
        usage: { lastHour: times.filter(x => x > t - HOUR).length, lastDay: times.filter(x => x > t - DAY).length }
      });
    }
    case "access-status": {
      // Mark a request for the access code as handled, or not.
      if (!idOk || !["new", "done"].includes(b.status)) return json(400, { error: "invalid", message: "Unknown request or status." });
      const res = await cas(stores.access, "req/" + b.id, d => (d ? { ...d, status: b.status, handled: new Date(t).toISOString() } : undefined));
      if (!res.changed) return json(404, { error: "not_found", message: "That request no longer exists." });
      return json(200, { ok: true, request: res.data });
    }
    case "access-delete": {
      if (!idOk) return json(400, { error: "invalid", message: "Unknown request." });
      await stores.access.delete("req/" + b.id);
      return json(200, { ok: true });
    }
    case "set-status": {
      if (!idOk || !["live", "hidden", "pending"].includes(b.status)) return json(400, { error: "invalid", message: "Unknown item or status." });
      const res = await cas(stores.items, "item/" + b.id, d => (d ? { ...d, status: b.status, moderated: new Date(t).toISOString() } : undefined));
      if (!res.changed) return json(404, { error: "not_found", message: "That item no longer exists." });
      if (b.status === "live") await upsertFeed(stores.items, publicView(res.data));
      else await removeFromFeed(stores.items, b.id);
      return json(200, { ok: true, item: res.data });
    }
    case "respond": {
      // The moderator's public reply to a comment. Empty status and text remove it.
      if (!idOk) return json(400, { error: "invalid", message: "Unknown item." });
      const status = b.status == null || b.status === "" ? null : b.status;
      if (status !== null && !Object.prototype.hasOwnProperty.call(REPLIES, status)) return json(400, { error: "invalid", message: "Choose answered, changed, kept or noted.", fields: { status: "Choose a kind of reply." } });
      const text = clean(b.text, MAX_REPLY);
      if (text.length > MAX_REPLY) return json(400, { error: "invalid", message: "Keep the reply under " + MAX_REPLY.toLocaleString("en-US") + " characters.", fields: { text: "Too long." } });
      if (!status && !text && b.remove !== true) return json(400, { error: "invalid", message: "Choose a kind of reply or write one.", fields: { text: "Write a reply." } });
      const cfg = await readConfig(stores, env);
      const res = await cas(stores.items, "item/" + b.id, d => {
        if (!d) return undefined;
        const next = { ...d };
        if (b.remove === true) delete next.response;
        else next.response = { status, text, by: cfg.replyAs, at: new Date(t).toISOString() };
        return next;
      });
      if (!res.changed) return json(404, { error: "not_found", message: "That item no longer exists." });
      if (res.data.status === "live") await upsertFeed(stores.items, publicView(res.data));
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
      const live = (await allItems(stores.items)).filter(x => x.status === "live" && x.kind === "comment").map(publicView).sort(byCreated);
      await stores.items.setJSON("feed", { items: live, updated: new Date(t).toISOString() });
      return json(200, { ok: true, count: live.length });
    }
    case "cleanup": {
      let removed = 0;
      for (const prefix of ["ip/", "adminfail/", "accessfail/", "req/"]) {
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
  return { items: s("bylaws-items"), limits: s("bylaws-limits"), config: s("bylaws-config"), access: s("bylaws-access") };
}
