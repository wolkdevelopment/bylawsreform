/* Run with: npm test (or node --test) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobs } from "../dev/memory-blobs.mjs";
import { handleSubmit, handleFeed, handleAdmin, netlifyStores, cleanConfig, DEFAULTS, screen, repairRev } from "../netlify/lib/core.mjs";

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
  await configure(e, { moderation: "hold" });
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

test("comments show right away by default, except ones the automatic check holds", async () => {
  const e = setup();
  assert.equal(DEFAULTS.moderation, "publish");
  const rot13 = s => s.replace(/[a-z]/g, c => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97));
  const cases = [
    ["Notice and a hearing first. Good.", []],
    ["Dick Muri would have liked the raccoon-proof assessment of this class of spice in Scunthorpe.", []],
    ["The 27-488 precinct met on 10/11/2026 to discuss RCW 29A.80.061 and U.S. law, e.g. 15 U.S.C. § 1681b.", []],
    ["See https://example.com for more.", ["link"]],
    ["Cheap pills at www.example.ru", ["link"]],
    ["visit spam-site.xyz today", ["link"]],
    ["This is bullsh1t.", ["language"]],
    ["fuuuuck this amendment", ["language"]],
    ["They're all " + rot13("fcvpf") + ".", ["language"]],
    ["Call me at (253) 555-0100 about it.", ["contact"]],
    ["Email me: someone@example.org", ["contact"]],
    ["THIS AMENDMENT IS A TERRIBLE IDEA AND EVERYONE KNOWS IT", ["caps"]],
    ["No!!!!!!!!!!!! Never.", ["repeat"]],
    ["Это предложение очень плохое и его нужно отклонить", ["script"]],
    ["I know where you live.", ["threat"]],
    ["Someone should put a bullet in his head.", ["threat"]],
    ["You deserve to be shot for this.", ["threat"]],
    ["I\u2019ll kill you if this passes", ["threat"]],
    ["He lives at 1234 S 56th St, go see him.", ["contact"]],
    ["<script>alert(1)</script>", ["code"]],
    ["<img src=x onerror=alert(1)>", ["code"]],
    ["Let's kill this amendment and shoot down the rest. It should be shot down, and we'll beat the deadline.", []],
    ["We will hang the banner. Article 10 all the way. In 2017 the Washington Supreme Court held for the party.", []],
    ["If a < b and c > d, the vote fails. Shoot them down.", []]
  ];
  for (const [text, want] of cases) assert.deepEqual(screen("Pat Example", text), want, text);
  assert.deepEqual(screen("Visit www.example.com", "Fine."), ["link"]);
  const ok = await submit(e, comment());
  assert.equal(ok.body.status, "live");
  const held = await submit(e, comment({ text: "Details at https://example.com" }), "1.1.1.2");
  assert.equal(held.status, 200); assert.equal(held.body.status, "pending"); assert.equal(held.body.item, null);
  const f = await feed(e);
  assert.equal(f.body.items.length, 1);
  const list = await admin(e, { action: "list" });
  assert.deepEqual(list.body.items.find(x => x.id === held.body.id).held, ["link"]);
  assert.equal(list.body.items.find(x => x.id === ok.body.id).held, undefined);
  const ex = await admin(e, { action: "export" });
  assert.match(ex.body.csv, /,ipHash,held,response\r\n/);
  // Hold mode still records why a comment would have been held.
  await configure(e, { moderation: "hold" });
  const h2 = await submit(e, comment({ text: "Call 253-555-0100" }), "1.1.1.3");
  assert.equal(h2.body.status, "pending");
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
  assert.equal(r.status, 200); // a precinct is optional
  r = await submit(e, comment({ email: "", role: undefined, precinct: "27-488" }));
  assert.equal(r.status, 200); // so is an email, and a role
  const saved = (await admin(e, { action: "list" })).body.items.find(x => x.id === r.body.id);
  // A precinct alone doesn't make someone a PCO: Precinct Captains have one too.
  assert.equal(saved.role, null); assert.equal(saved.email, null); assert.equal(saved.precinct, "27-488");
  r = await submit(e, comment({ email: "not-an-email" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.email);
  r = await submit(e, comment({ role: "member", precinct: "" }));
  assert.equal(r.status, 200);
  r = await submit(e, comment({ target: "r:NOPE" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.target);
  r = await submit(e, comment({ text: "a http://a b http://b c http://c d http://d" }));
  assert.equal(r.status, 400);
  r = await submit(e, comment({ website: "spam.example" }));
  assert.equal(r.status, 200); assert.equal(r.body.id, null);
  assert.equal((await admin(e, { action: "list" })).body.items.length, 3);
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

test("only comments are accepted, and taking a side is optional", async () => {
  const e = setup();
  await configure(e, { moderation: "publish" });
  let r = await submit(e, { ...comment(), kind: "proposal", title: "Anything" });
  assert.equal(r.status, 400); assert.ok(r.body.fields.kind);
  r = await submit(e, comment({ target: "p:mabcdefg-0123456789" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.target);
  r = await submit(e, comment({ position: undefined }));
  assert.equal(r.status, 200); assert.equal(r.body.item.position, "comment");
  r = await submit(e, comment({ position: "" }));
  assert.equal(r.status, 200); assert.equal(r.body.item.position, "comment");
  r = await submit(e, comment({ position: "maybe" }));
  assert.equal(r.status, 400); assert.ok(r.body.fields.position);
  // Old saved settings that still mention proposals are ignored, not an error.
  await e.stores.config.setJSON("settings", { ...DEFAULTS, proposalsOpen: false, maxProposalChars: 9000, moderation: "publish" });
  const f = await feed(e);
  assert.equal(f.status, 200);
  assert.deepEqual(Object.keys(f.body.config).sort(), ["maxCommentChars", "moderation", "open"]);
  assert.ok(f.body.items.every(x => x.kind === "comment"));
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
  assert.match(ex.body.csv, /^id,status,created,/);
  assert.ok(ex.body.csv.includes("\"'=HYPERLINK"), "formula cells are defused");
  e.t.now += 2 * 86400e3;
  const cl = await admin(e, { action: "cleanup" });
  assert.ok(cl.body.removed >= 1);
  const bad = await admin(e, { action: "set-config", config: { ipPerHour: -1 } });
  assert.equal(bad.status, 400);
  const rb = await admin(e, { action: "rebuild-feed" });
  assert.equal(rb.status, 200);
});

test("each comment is stamped with the version of the repair it was written on", async () => {
  const e = setup();
  await configure(e, { moderation: "publish" });
  assert.equal(repairRev("T1"), 2); assert.equal(repairRev("B2"), 1);
  const a = await submit(e, comment({ target: "r:T1", role: "captain", precinct: "27-486" }));
  const b = await submit(e, comment({ target: "r:B2" }));
  assert.equal(a.body.item.rev, 2); assert.equal(a.body.item.role, "captain");
  assert.equal(b.body.item.rev, 1);
  // Comments saved before versions existed show as version 1.
  await e.stores.items.setJSON("item/old-0000000001", { id: "old-0000000001", kind: "comment", status: "live", created: "2026-10-10T12:00:00Z", target: "r:T1", position: "question", text: "Old", name: "Jo", role: "captain" });
  await admin(e, { action: "rebuild-feed" });
  const old = (await feed(e)).body.items.find(x => x.id === "old-0000000001");
  assert.equal(old.rev, 1); assert.equal(old.role, "captain");
  const ex = await admin(e, { action: "export" });
  assert.match(ex.body.csv, /,target,rev,name,/);
});

test("replies: the moderator answers a comment, edits the answer, and removes it", async () => {
  const e = setup();
  await configure(e, { moderation: "publish", replyAs: "  Brian,   the author " });
  const c = await submit(e, comment({ target: "r:M1", position: "question", text: "Who can serve?" }));
  let r = await admin(e, { action: "respond", id: c.body.id, status: "changed", text: "The revision lists who can't serve." });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.item.response).sort(), ["at", "by", "status", "text"]);
  let pub = (await feed(e)).body.items.find(x => x.id === c.body.id);
  assert.equal(pub.response.status, "changed"); assert.equal(pub.response.by, "Brian, the author");
  assert.equal(pub.response.text, "The revision lists who can't serve.");
  assert.equal(pub.email, undefined);
  r = await admin(e, { action: "respond", id: c.body.id, status: "answered", text: "" });
  assert.equal(r.status, 200);
  pub = (await feed(e)).body.items.find(x => x.id === c.body.id);
  assert.equal(pub.response.status, "answered"); assert.equal(pub.response.text, "");
  // Bad input
  assert.equal((await admin(e, { action: "respond", id: c.body.id, status: "maybe", text: "x" })).status, 400);
  assert.equal((await admin(e, { action: "respond", id: c.body.id, status: "", text: "" })).status, 400);
  assert.equal((await admin(e, { action: "respond", id: c.body.id, status: "noted", text: "x".repeat(1501) })).status, 400);
  assert.equal((await admin(e, { action: "respond", id: "nope-00000000", status: "noted" })).status, 404);
  // A reply on a hidden comment stays private until the comment is live again.
  await admin(e, { action: "set-status", id: c.body.id, status: "hidden" });
  await admin(e, { action: "respond", id: c.body.id, status: "noted", text: "Hidden for now." });
  assert.equal((await feed(e)).body.items.find(x => x.id === c.body.id), undefined);
  await admin(e, { action: "set-status", id: c.body.id, status: "live" });
  assert.equal((await feed(e)).body.items.find(x => x.id === c.body.id).response.text, "Hidden for now.");
  r = await admin(e, { action: "respond", id: c.body.id, remove: true });
  assert.equal(r.status, 200); assert.equal(r.body.item.response, undefined);
  assert.equal((await feed(e)).body.items.find(x => x.id === c.body.id).response, undefined);
  // The signature setting is checked.
  assert.equal((await admin(e, { action: "set-config", config: { replyAs: "x" } })).status, 400);
  assert.equal(cleanConfig({}).config.replyAs, "the author");
});
