import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { detectFormat, parseCsvText } from "../shared/csv.js";
import { startApp } from "../test/helpers.js";
import { snapshot } from "./backup.js";
import { openDb } from "./db.js";

let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

const CSV = [
  "Date,Description,Amount",
  "10/03/2026,NETFLIX.COM 1111,-15.99", "09/03/2026,NETFLIX.COM 2222,-15.99", "08/03/2026,NETFLIX.COM 3333,-15.99",
  "10/05/2026,COSTCO WHSE #12,-100.00", "10/06/2026,Payroll Acme,2000.00",
].join("\n") + "\n";
const body = (content = CSV) => ({
  file_name: "a.csv", content, account_id: null, new_account: { name: "Chase", type: "checking" },
  format: detectFormat(parseCsvText(content)), save_format: true, category_overrides: [],
});
const cat = async (name: string) => (await app.call("GET", "/api/categories")).body.find((c: any) => c.name === name).id;
const list = async (q: string) => (await app.call("GET", `/api/transactions?${q}`)).body;
const costco = async () => (await list("month=2026-10")).transactions.find((t: any) => t.description.startsWith("COSTCO"));
/** Everything the split must leave unchanged once unsplit. */
const snap = async () => ({
  tx: await list("month=2026-10"), sum: (await app.call("GET", "/api/summary?month=2026-10")).body,
  bud: (await app.call("GET", "/api/budgets?month=2026-10")).body, unc: (await app.call("GET", "/api/transactions/uncategorized-count?month=2026-10")).body,
  cats: (await app.call("GET", "/api/categories")).body,
});

describe("splits", () => {
  it("hides the parent everywhere; totals match once parts are the same sum; unsplit restores everything", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const groc = await cat("Groceries"), shop = await cat("Shopping");
    const t = await costco();
    await app.call("PATCH", `/api/transactions/${t.id}`, { category_id: groc });
    const before = await snap();

    const r = await app.call("POST", `/api/transactions/${t.id}/split`, { parts: [{ amount_cents: -6000, category_id: groc }, { amount_cents: -4000, category_id: shop, note: " tv " }] });
    expect(r.status).toBe(200);
    expect(r.body.map((p: any) => [p.amount_cents, p.parent_id, p.split_total_cents, p.note])).toEqual([[-6000, t.id, -10000, null], [-4000, t.id, -10000, "tv"]]);
    const mid = await snap();
    expect(mid.tx.transactions.some((x: any) => x.id === t.id)).toBe(false);
    expect(mid.tx.transactions).toHaveLength(before.tx.transactions.length + 1);
    expect(mid.tx.spent_cents).toBe(before.tx.spent_cents);
    expect(mid.sum.spent_cents).toBe(before.sum.spent_cents);
    expect(mid.bud.items.find((i: any) => i.category_id === shop).spent_cents).toBe(4000);
    expect(mid.cats.reduce((s: number, c: any) => s + c.transaction_count, 0)).toBe(before.cats.reduce((s: number, c: any) => s + c.transaction_count, 0) + 1);

    const g = await app.call("GET", `/api/transactions/${r.body[1].id}/split`); // via a part
    expect(g.body.parent.id).toBe(t.id);
    expect(g.body.parts.map((p: any) => p.id)).toEqual(r.body.map((p: any) => p.id));

    const del = await app.call("DELETE", `/api/transactions/${r.body[0].id}/split`);
    expect(del.status).toBe(200);
    expect(del.body.id).toBe(t.id);
    expect(await snap()).toEqual(before);
    expect((await app.call("DELETE", `/api/transactions/${t.id}/split`)).status).toBe(400);
    expect((await app.call("GET", `/api/transactions/${t.id}/split`)).status).toBe(400);
  });

  it("uncategorized badge and category counts ignore the parent", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const t = await costco(); // Uncategorized
    const unc0 = (await app.call("GET", "/api/transactions/uncategorized-count?month=2026-10")).body.count;
    await app.call("POST", `/api/transactions/${t.id}/split`, { parts: [{ amount_cents: -5000, category_id: shop }, { amount_cents: -5000, category_id: shop }] });
    expect((await app.call("GET", "/api/transactions/uncategorized-count?month=2026-10")).body.count).toBe(unc0 - 1);
    expect((await app.call("GET", "/api/rules/impact?merchant=COSTCO")).body.uncategorized_count).toBe(0);
  });

  it("validates parts and 404s", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const t = await costco();
    const post = (parts: unknown, id = t.id) => app.call("POST", `/api/transactions/${id}/split`, { parts });
    const p = (amount_cents: number, category_id = shop) => ({ amount_cents, category_id });
    expect((await post([p(-10000)])).status).toBe(400);
    expect((await post(Array.from({ length: 101 }, () => p(-1)))).status).toBe(400);
    expect((await post([p(-5000), p(-4000)])).body.error.message).toBe("Parts must add up to -$100.00");
    expect((await post([p(-15000), p(5000)])).status).toBe(400); // wrong sign
    expect((await post([p(-10000), p(0)])).status).toBe(400);
    expect((await post([p(-5000), p(-5000, 9999)])).status).toBe(400);
    expect((await post([p(-5000.5), p(-4999.5)])).status).toBe(400);
    expect((await post([p(-5000), p(-5000)], 99999)).status).toBe(404);
    expect((await list("month=2026-10")).transactions.find((x: any) => x.id === t.id).parent_id).toBeNull();
  });

  it("re-split replaces parts and keeps receipts on the first part; parents reject PATCH; date moves the group", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const t = await costco();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
    await app.call("POST", `/api/transactions/${t.id}/receipts`, { file_name: "r.png", content_base64: png });
    const a = (await app.call("POST", `/api/transactions/${t.id}/split`, { parts: [{ amount_cents: -5000, category_id: shop }, { amount_cents: -5000, category_id: shop }] })).body;
    expect((await app.call("GET", `/api/transactions/${a[0].id}/receipts`)).body).toHaveLength(1);
    const b = (await app.call("POST", `/api/transactions/${a[1].id}/split`, { parts: [{ amount_cents: -2500, category_id: shop }, { amount_cents: -2500, category_id: shop }, { amount_cents: -5000, category_id: shop }] })).body;
    expect(b).toHaveLength(3);
    expect((await app.call("GET", `/api/transactions/${b[0].id}/receipts`)).body).toHaveLength(1);
    expect((await app.call("GET", `/api/transactions/${a[0].id}`)).status).toBe(404); // not a route; old part gone
    expect((await app.call("PATCH", `/api/transactions/${t.id}`, { note: "x" })).status).toBe(400);

    await app.call("PATCH", `/api/transactions/${b[2].id}`, { date: "2026-10-09" });
    expect((await list("month=2026-10&day=2026-10-09")).transactions.map((x: any) => x.id).sort()).toEqual(b.map((x: any) => x.id).sort());
    expect((await list("month=2026-10&day=2026-10-09")).transactions[0].original_date).toBe("2026-10-05");
    await app.call("PATCH", `/api/transactions/${b[1].id}`, { date: "2026-10-05" });
    expect((await list("month=2026-10&day=2026-10-05")).transactions).toHaveLength(3);
    const un = await app.call("DELETE", `/api/transactions/${b[0].id}/split`);
    expect((await app.call("GET", `/api/transactions/${t.id}/receipts`)).body).toHaveLength(1);
    expect(un.body.original_date).toBeNull();
  });

  it("re-importing the same statement after a split adds nothing; undo removes parent and parts; recurring still matches", async () => {
    app = await startApp();
    const first = await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const subs = await cat("Subscriptions");
    const nf = (await list("month=2026-10")).transactions.find((t: any) => t.description.startsWith("NETFLIX"));
    await app.call("POST", `/api/transactions/${nf.id}/split`, { parts: [{ amount_cents: -1000, category_id: subs }, { amount_cents: -599, category_id: shop }] });
    const again = { ...body(), new_account: null, account_id: first.body.account.id };
    const re = await app.call("POST", "/api/imports", again);
    expect(re.status).toBe(400);
    expect(re.body.error.code).toBe("nothing_to_import");
    const prev = await app.call("POST", "/api/imports/preview", { ...body(), account_id: first.body.account.id });
    expect(prev.body.review.new_rows).toHaveLength(0);
    expect((await app.call("GET", "/api/imports")).body[0].transaction_count).toBe(5);

    await app.call("POST", "/api/recurring", { name: "Netflix", amount_cents: -1599, category_id: subs, account_id: null, frequency: "monthly", anchor_date: "2026-09-03", match_text: "NETFLIX" });
    const rec = (await app.call("GET", "/api/recurring")).body[0];
    expect(rec.status.kind).toBe("received");

    const undo = await app.call("DELETE", `/api/imports/${first.body.import.id}`);
    expect(undo.body.removed_count).toBe(5);
    expect((app.db.prepare("SELECT COUNT(*) n FROM transactions").get() as any).n).toBe(0);
  });
});

describe("bulk category PATCH", () => {
  it("updates in order, 404 and 400 change nothing", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const txs = (await list("all=1")).transactions;
    const ids = [txs[2].id, txs[0].id];
    const r = await app.call("PATCH", "/api/transactions", { ids, category_id: shop });
    expect(r.status).toBe(200);
    expect(r.body.updated_count).toBe(2);
    expect(r.body.transactions.map((t: any) => [t.id, t.category_id])).toEqual(ids.map((i) => [i, shop]));

    const unc = await cat("Uncategorized");
    const before = (await list("all=1")).transactions;
    expect((await app.call("PATCH", "/api/transactions", { ids: [txs[1].id, 99999], category_id: unc })).status).toBe(404);
    expect((await app.call("PATCH", "/api/transactions", { ids: [txs[1].id], category_id: 99999 })).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions", { ids: [] , category_id: unc })).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions", { ids: [txs[1].id, txs[1].id], category_id: unc })).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions", { ids: Array.from({ length: 501 }, (_, i) => i + 1), category_id: unc })).status).toBe(400);
    const sp = (await app.call("POST", `/api/transactions/${txs[1].id}/split`, { parts: [{ amount_cents: txs[1].amount_cents - 1, category_id: unc }, { amount_cents: 1, category_id: unc }] }));
    expect(sp.status).toBe(400); // wrong sign part (amount 1 positive on a debit) -> no split
    const part = (await app.call("POST", `/api/transactions/${txs[1].id}/split`, { parts: [{ amount_cents: -1, category_id: unc }, { amount_cents: txs[1].amount_cents + 1, category_id: unc }] })).body;
    expect((await app.call("PATCH", "/api/transactions", { ids: [txs[3].id, txs[1].id], category_id: shop })).status).toBe(400); // parent
    expect((await list("all=1")).transactions.find((t: any) => t.id === txs[3].id).category_id).toBe(before.find((t: any) => t.id === txs[3].id).category_id);
    expect((await app.call("PATCH", "/api/transactions", { ids: [part[0].id], category_id: shop })).status).toBe(200);
  });
});

describe("GET /api/transactions all/day/q", () => {
  it("all=1 drops month, q matches custom_description, day validated", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    expect((await app.call("GET", "/api/transactions")).status).toBe(400);
    expect((await app.call("GET", "/api/transactions?all=1&month=2026-13")).status).toBe(400);
    expect((await list("all=1")).transactions).toHaveLength(5);
    expect((await list("all=1&q=netflix")).transactions).toHaveLength(3);
    const t = (await list("all=1&q=costco")).transactions[0];
    await app.call("PATCH", `/api/transactions/${t.id}`, { custom_description: "Bulk Pantry run" });
    expect((await list("all=1&q=pantry")).transactions.map((x: any) => x.id)).toEqual([t.id]);
    expect((await list("month=2026-10&q=pantry")).transactions).toHaveLength(1);
    expect((await list("month=2026-10&day=2026-10-03")).transactions).toHaveLength(1);
    expect((await list("all=1&day=2026-09-03")).transactions).toHaveLength(1);
    expect((await app.call("GET", "/api/transactions?month=2026-10&day=2026-09-03")).status).toBe(400);
    expect((await app.call("GET", "/api/transactions?month=2026-10&day=2026-02-30")).status).toBe(400);
    expect((await list("month=2026-10&all=2&day=2026-10-03")).transactions).toHaveLength(1);
  });
});

describe("suggestions and trends", () => {
  it("suggests Netflix until a recurring item covers it", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const r = await app.call("GET", "/api/recurring/suggestions");
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ merchant: "NETFLIX.COM", amount_cents: -1599, frequency: "monthly", last_date: "2026-10-03", next_date: "2026-11-03", occurrences: 3 });
    await app.call("POST", "/api/recurring", { name: "Netflix", amount_cents: -1599, category_id: r.body[0].category_id, account_id: null, frequency: "monthly", anchor_date: "2026-11-03", match_text: r.body[0].merchant });
    expect((await app.call("GET", "/api/recurring/suggestions")).body).toEqual([]);
  });

  it("trends: 12 aligned months, clamped categories, ytd, split-neutral", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const shop = await cat("Shopping");
    const t = await costco();
    await app.call("PATCH", "/api/transactions", { ids: [(await list("all=1&q=payroll")).transactions[0].id], category_id: await cat("Income") });
    const call = async () => (await app.call("GET", "/api/trends?end=2026-10")).body;
    const a = await call();
    expect(a.months[0]).toBe("2025-11");
    expect(a.months[11]).toBe("2026-10");
    expect(a.spent_cents[11]).toBe(10000 + 1599);
    expect(a.income_cents[11]).toBe(200000);
    expect(a.ytd).toMatchObject({ year: 2026, income_cents: 200000, spent_cents: 10000 + 3 * 1599 });
    expect(a.categories.every((c: any) => c.spent_cents.length === 12)).toBe(true);
    await app.call("POST", `/api/transactions/${t.id}/split`, { parts: [{ amount_cents: -6000, category_id: shop }, { amount_cents: -4000, category_id: shop }] });
    const b = await call();
    expect([b.spent_cents, b.income_cents, b.ytd.spent_cents]).toEqual([a.spent_cents, a.income_cents, a.ytd.spent_cents]);
    expect(b.categories.find((c: any) => c.category_id === shop).spent_cents[11]).toBe(10000);
    expect((await app.call("GET", "/api/trends?end=2026-13")).status).toBe(400);
    expect((await app.call("GET", "/api/trends")).body.months[11]).toBe("2026-10"); // default = today's month
  });
});

describe("backup", () => {
  it("GET /api/backup serves a SQLite file (even :memory:)", async () => {
    app = await startApp();
    await app.call("POST", "/api/imports", body());
    const res = await fetch(`${app.base}/api/backup`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="budget-backup-\d{4}-\d{2}-\d{2}\.db"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    const copy = new Database(buf);
    expect((copy.prepare("SELECT COUNT(*) n FROM transactions").get() as any).n).toBe(5);
  });

  it("snapshots a WAL file DB consistently and keeps the newest 10", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-bk-"));
    const db = openDb(path.join(dir, "budget.db"));
    db.prepare("INSERT INTO accounts (name,type,created_at) VALUES ('A','checking','x')").run(); // sits in the WAL
    for (let i = 0; i < 12; i++) snapshot(db);
    const files = fs.readdirSync(path.join(dir, "backups"));
    expect(files).toHaveLength(10);
    const copy = new Database(path.join(dir, "backups", files.sort().pop()!), { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) n FROM accounts").get() as any).n).toBe(1);
    fs.writeFileSync(path.join(dir, "ser.db"), db.serialize()); // what GET /api/backup serves
    expect((new Database(path.join(dir, "ser.db")).prepare("SELECT COUNT(*) n FROM accounts").get() as any).n).toBe(1);
    db.close();
    fs.rmSync(dir, { recursive: true });
  });

  it("import commit and undo each take a snapshot; :memory: writes none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-bk-"));
    const { createApp } = await import("./app.js");
    const db = openDb(path.join(dir, "budget.db"));
    const server = createApp(db, () => "2026-10-25").listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = async (m: string, p: string, b?: unknown) => (await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
    const r = await call("POST", "/api/imports", body());
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(1);
    await call("DELETE", `/api/imports/${r.import.id}`);
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(2);
    const re = await fetch(base + "/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), new_account: null, account_id: r.account.id }) });
    expect(re.status).toBe(201); // undo removed the rows, so this one writes (3rd snapshot)
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(3);
    const dup = await fetch(base + "/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body(), new_account: null, account_id: r.account.id }) });
    expect(dup.status).toBe(400); // all duplicates: no snapshot
    const dupName = await fetch(base + "/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    expect(dupName.status).toBe(409);
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(3);
    await call("DELETE", "/api/imports/9999");
    expect(fs.readdirSync(path.join(dir, "backups"))).toHaveLength(3);
    server.close(); db.close();
    fs.rmSync(dir, { recursive: true });
  });
});
