/* Run with: npm test (or node --test) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobs } from "../dev/memory-blobs.mjs";
import { handleSubmit, handleFeed, handleAdmin, netlifyStores, cleanConfig, DEFAULTS } from "../netlify/lib/core.mjs";

const KEY = "test-admin-key-123456";
function setup(settings, clock) {
  const mem = createMemoryBlobs();
  const stores = netlifyStores(mem.getStore);
  const env = { ADMIN_KEY: KEY, IP_SALT: "salt" };
  const t = clock || { now: Date.parse("2026-10-11T12:00:00Z") };
  const deps = { stores, env, now: () => t.now };
  return { mem, stores, env, deps, t, settings };
}
function post(path, body, headers = {}) {
  return new Request("https://site.test" + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const person = { name: "Pat Example", email: "pat@example.com", role: "pco-elected", precinct: "27-488", showName: true };
const comment = (extra = {}) => ({ kind: "comment", target: "r:B2", position: "support", text: "This is fair.", ...person, ...extra });
const proposal = (extra = {}) => ({
  kind: "proposal", title: "Clearer guest rule", why: "Guests should know the rules.", mode: "change", section: "4.2",
  nodes: [{ k: "p", t: "In addition to the Biennial Organization Meeting, the CC shall meet at least four (4) times each calendar year." }],
  ...person, ...extra
});
async function submit(env, body, ip = "1.1.1.1") { const res = await handleSubmit(post("/api/submit", body), { ip }, env.deps); return { status: res.status, body: await res.json(), res }; }
async function admin(env, body, key = KEY, ip = "9.9.9.9") { const res = await handleAdmin(post("/api/admin", body, { "x-admin-key": key }), { ip }, env.deps); return { status: res.status, body: await res.json() }; }
async function feed(env) { const res = await handleFeed(new Request("https://site.test/api/feed"), {}, env.deps); return { status: res.status, body: await res.json(), res }; }
async function configure(env, cfg) { const r = await admin(env, { action: "set-config", config: cfg }); assert.equal(r.status, 200, JSON.stringify(r.body)); }

test("settings: defaults, changes and bad values", () => {
  assert.deepEqual(cleanConfig({}).config, DEFAULTS);
  const ok = cleanConfig({ ipPerHour: "3", moderation: "publish", open: false });
  assert.equal(ok.config.ipPerHour, 3); assert.equal(ok.config.moderation, "publish"); assert.equal(ok.config.open, false);
  assert.deepEqual(Object.keys(ok.errors), []);
  const bad = cleanConfig({ ipPerHour: 0, allPerDay: 1.5, moderation: "maybe" });
  assert.ok(bad.errors.ipPerHour && bad.errors.allPerDay && bad.errors.moderation);
  assert.ok(cleanConfig({ ipPerHour: 50, ipPerDay: 10 }).errors.ipPerDay);
});

test("hold mode: a comment waits for approval, then shows without private fields", async () => {
  const e = setup();
  const r = await submit(e, comment());
  assert.equal(r.status, 200); assert.equal(r.body.status, "pending"); assert.equal(r.body.item, null);
  assert.equal((await feed(e)).body.items.length, 0);
  const list = await admin(e, { action: "list" });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].email, "pat@example.com");
  assert.equal(list.body.usage.lastHour, 1);
  const ok = await admin(e, { action: "set-status", id: r.body.id, status: "live" });
  assert.equal(ok.status, 200);
  const f = await feed(e);
  assert.equal(f.body.items.length, 1);
  const pub = f.body.items[0];
  assert.equal(pub.name, "Pat Example"); assert.equal(pub.precinct, "27-488"); assert.equal(pub.ld, "27");
  assert.equal(pub.email, undefined); assert.equal(pub.ipHash, undefined);
  assert.match(f.res.headers.get("netlify-cdn-cache-control"), /s-maxage=15/);
  await admin(e, { action: "set-status", id: r.body.id, status: "hidden" });
  assert.equal((await feed(e)).body.items.length, 0);
});

test("publish mode and withheld names", async () => {
  const e = setup();
  await configure(e, { moderation: "publish" });
  const r = await submit(e, comment({ showName: false }));
  assert.equal(r.body.status, "live");
  assert.equal(r.body.item.name, null); assert.equal(r.body.item.precinct, null); assert.equal(r.body.item.ld, "27");
  assert.equal((await feed(e)).body.items.length, 1);
});

test("per-IP hourly and daily limits, with other IPs unaffected", async () => {
  const e = setup();
  await configure(e, { ipPerHour: 3, ipPerDay: 4 });
  for (let i = 0; i < 3; i++) assert.equal((await submit(e, comment(), "2.2.2.2")).status, 200);
  const blocked = await submit(e, comment(), "2.2.2.2");
  assert.equal(blocked.status, 429); assert.equal(blocked.body.scope, "ip");
  assert.ok(blocked.body.retryAfter > 0 && blocked.body.retryAfter <= 3600);
  assert.equal(blocked.res.headers.get("retry-after"), String(blocked.body.retryAfter));
  assert.equal((await submit(e, comment(), "3.3.3.3")).status, 200);
  e.t.now += 3601e3; // an hour later: the hourly window has passed
  assert.equal((await submit(e, comment(), "2.2.2.2")).status, 200); // 4th today
  const daily = await submit(e, comment(), "2.2.2.2");
  assert.equal(daily.status, 429); assert.equal(daily.body.scope, "ip");
  assert.ok(daily.body.retryAfter > 3600); // waits for the oldest of the day to age out
  e.t.now += 23 * 3600e3;
  assert.equal((await submit(e, comment(), "2.2.2.2")).status, 200);
});

test("overall limit blocks everyone and gives the person's slot back", async () => {
  const e = setup();
  await configure(e, { allPerHour: 5, allPerDay: 5, ipPerHour: 2 });
  for (let i = 0; i < 5; i++) assert.equal((await submit(e, comment(), "10.0.0." + i)).status, 200);
  const r = await submit(e, comment(), "10.0.1.1");
  assert.equal(r.status, 429); assert.equal(r.body.scope, "all");
  await configure(e, { allPerHour: 50, allPerDay: 50 });
  // The rejected attempt didn't use up 10.0.1.1's own allowance of 2.
  assert.equal((await submit(e, comment(), "10.0.1.1")).status, 200);
  assert.equal((await submit(e, comment(), "10.0.1.1")).status, 200);
  assert.equal((await submit(e, comment(), "10.0.1.1")).status, 429);
});

test("simultaneous submissions never exceed the overall limit", async () => {
  const e = setup();
  await configure(e, { allPerHour: 10, allPerDay: 10, ipPerHour: 5 });
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => submit(e, comment(), "20.0.0." + i)));
  const ok = results.filter(r => r.status === 200).length;
  assert.ok(ok >= 1 && ok <= 10, "accepted " + ok);
  assert.ok(results.every(r => r.status === 200 || r.status === 429));
  const counter = await e.stores.limits.get("all", { type: "json" });
  assert.equal(counter.t.length, ok); // no lost or phantom counts
  const stored = await admin(e, { action: "list" });
  assert.equal(stored.body.items.length, ok);
});

test("validation, honeypot, closed switch and request checks", async () => {
  const e = setup();
  let r = await submit(e, comment({ name: "", email: "nope", role: "boss" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.name && r.body.fields.email && r.body.fields.role);
  r = await submit(e, comment({ precinct: "" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.precinct);
  r = await submit(e, comment({ role: "member", precinct: "" }));
  assert.equal(r.status, 200);
  r = await submit(e, comment({ target: "r:NOPE" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.target);
  r = await submit(e, comment({ text: "a http://a b http://b c http://c d http://d" }));
  assert.equal(r.status, 400);
  r = await submit(e, comment({ website: "spam.example" }));
  assert.equal(r.status, 200); assert.equal(r.body.id, null);
  assert.equal((await admin(e, { action: "list" })).body.items.length, 1);
  await configure(e, { open: false });
  r = await submit(e, comment());
  assert.equal(r.status, 403);
  const wrongType = await handleSubmit(new Request("https://site.test/api/submit", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), { ip: "1.1.1.1" }, e.deps);
  assert.equal(wrongType.status, 415);
  const big = await handleSubmit(post("/api/submit", { kind: "comment", text: "x".repeat(70000) }), { ip: "1.1.1.1" }, e.deps);
  assert.equal(big.status, 413);
  const get = await handleSubmit(new Request("https://site.test/api/submit"), { ip: "1.1.1.1" }, e.deps);
  assert.equal(get.status, 405);
});

test("proposals: checks, add mode, closing, and comments on a proposal", async () => {
  const e = setup();
  let r = await submit(e, proposal({ section: "99.9" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.section);
  r = await submit(e, proposal({ mode: "add", newId: "4.2" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.newId);
  r = await submit(e, proposal({ nodes: [{ k: "i", l: "<b>", t: "x" }] }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.nodes);
  r = await submit(e, proposal({ mode: "add", newId: "4.8", newTitle: "Remote Attendance", section: "4.7.3" }));
  assert.equal(r.status, 200);
  const pid = r.body.id;
  let c = await submit(e, comment({ target: "p:" + pid }));
  assert.equal(c.status, 400); // not approved yet
  await admin(e, { action: "set-status", id: pid, status: "live" });
  c = await submit(e, comment({ target: "p:" + pid }));
  assert.equal(c.status, 200);
  const f = await feed(e);
  assert.equal(f.body.items[0].kind, "proposal"); assert.equal(f.body.items[0].newId, "4.8");
  await configure(e, { proposalsOpen: false });
  assert.equal((await submit(e, proposal())).status, 403);
  assert.equal((await submit(e, comment())).status, 200); // comments still open
});

test("admin: key required, lockout after ten wrong keys, export and cleanup", async () => {
  const e = setup();
  const noKey = await handleAdmin(post("/api/admin", { action: "list" }), { ip: "5.5.5.5" }, { ...e.deps, env: {} });
  assert.equal(noKey.status, 503);
  for (let i = 0; i < 10; i++) assert.equal((await admin(e, { action: "list" }, "wrong-key", "6.6.6.6")).status, 401);
  assert.equal((await admin(e, { action: "list" }, KEY, "6.6.6.6")).status, 429); // locked even with the right key
  assert.equal((await admin(e, { action: "list" }, KEY, "7.7.7.7")).status, 200); // other connections unaffected
  await submit(e, comment({ text: "=HYPERLINK(\"http://x\")" }));
  const ex = await admin(e, { action: "export" });
  assert.equal(ex.body.count, 1);
  assert.match(ex.body.csv, /^"id","kind"|^id,kind/);
  assert.ok(ex.body.csv.includes("\"'=HYPERLINK"), "formula cells are defused");
  e.t.now += 2 * 86400e3;
  const cl = await admin(e, { action: "cleanup" });
  assert.ok(cl.body.removed >= 1);
  const bad = await admin(e, { action: "set-config", config: { ipPerHour: -1 } });
  assert.equal(bad.status, 400);
  const rb = await admin(e, { action: "rebuild-feed" });
  assert.equal(rb.status, 200);
});
