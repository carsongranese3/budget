import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { detectFormat, parseCsvText } from "../shared/csv.js";
import { openDb } from "./db.js";
import { startApp } from "../test/helpers.js";

const fx = (n: string) => readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url), "utf8");
let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

const fmtOf = (c: string) => detectFormat(parseCsvText(c));
const importBody = (file_name: string, content: string, extra: object = {}) => ({
  file_name, content, account_id: null, new_account: { name: "Chase Checking", type: "checking" },
  format: fmtOf(content), save_format: true, category_overrides: [], ...extra,
});
const catId = async (name: string) => (await app.call("GET", "/api/categories")).body.find((c: any) => c.name === name).id;

describe("import: duplicates", () => {
  it("two identical coffees both import first time, both skip on re-import, third imports alone", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,Coffee   Shop,-5.00\n10/15/2026,Coffee Shop,-5.00\n";
    const r1 = await app.call("POST", "/api/imports", importBody("a.csv", csv));
    expect(r1.status).toBe(201);
    expect(r1.body.import.new_count).toBe(2);
    const acct = r1.body.account.id;
    const again = await app.call("POST", "/api/imports", importBody("a.csv", csv, { account_id: acct, new_account: null }));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("nothing_to_import");
    expect((await app.call("GET", "/api/imports")).body).toHaveLength(1);
    // case-insensitive + third coffee
    const csv3 = csv.replace(/Coffee/g, "COFFEE") + "10/15/2026,COFFEE SHOP,-5.00\n";
    const prev = await app.call("POST", "/api/imports/preview", { file_name: "a.csv", content: csv3, account_id: acct, format: fmtOf(csv3) });
    expect(prev.body.review.duplicate_rows).toHaveLength(2);
    expect(prev.body.review.new_rows).toHaveLength(1);
    const r3 = await app.call("POST", "/api/imports", importBody("b.csv", csv3, { account_id: acct, new_account: null }));
    expect(r3.body.import).toMatchObject({ new_count: 1, skipped_count: 2 });
  });
  it("same rows in a different account are not duplicates", async () => {
    app = await startApp();
    const csv = fx("amex-card.csv");
    await app.call("POST", "/api/imports", importBody("amex.csv", csv, { new_account: { name: "Amex", type: "credit_card" } }));
    const r = await app.call("POST", "/api/imports", importBody("amex.csv", csv, { new_account: { name: "Amex 2", type: "credit_card" } }));
    expect(r.status).toBe(201);
    expect(r.body.import.skipped_count).toBe(0);
  });
});

describe("import: preview, commit, undo", () => {
  it("full flow with Chase fixture, rules, overrides, saved format recognition", async () => {
    app = await startApp();
    const groc = await catId("Groceries");
    await app.call("POST", "/api/rules", { merchant: "trader joe's", category_id: groc });
    const csv = fx("chase-checking.csv");
    const p1 = await app.call("POST", "/api/imports/preview", { file_name: "Chase_Activity.csv", content: csv });
    expect(p1.status).toBe(200);
    expect(p1.body.review).toBeNull();
    expect(p1.body.columns[1]).toBe("Posting Date");
    expect(p1.body.sample_rows).toHaveLength(5);
    const c = await app.call("POST", "/api/imports", importBody("Chase_Activity.csv", csv, {
      category_overrides: [{ line: 3, category_id: await catId("Income") }],
    }));
    expect(c.status).toBe(201);
    expect(c.body.import).toMatchObject({ row_count: 10, new_count: 10, skipped_count: 0, first_date: "2026-10-12", last_date: "2026-10-24" });
    expect(c.body.matched_recurring).toEqual([]);
    expect(c.body.uncategorized_count).toBe(8);
    expect(c.body.account.last_import_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const tx = (await app.call("GET", "/api/transactions?month=2026-10")).body;
    expect(tx.transactions).toHaveLength(10);
    expect(tx.transactions.find((t: any) => t.description.startsWith("TRADER")).category_id).toBe(groc);
    // recognized next time
    const p2 = await app.call("POST", "/api/imports/preview", { file_name: "Chase_Activity.csv", content: csv });
    expect(p2.body.matched_accounts).toHaveLength(1);
    expect(p2.body.suggested_account_id).toBe(c.body.account.id);
    expect(p2.body.review.account_id).toBe(c.body.account.id);
    expect(p2.body.review.new_rows).toHaveLength(0);
    expect(p2.body.review.duplicate_rows).toHaveLength(10);
    expect(p2.body.review.duplicate_rows[0].rule_merchant).toBe("TRADER JOE'S");
    // undo (recategorized rows included)
    const t0 = tx.transactions[0];
    await app.call("PATCH", `/api/transactions/${t0.id}`, { category_id: groc });
    const undo = await app.call("DELETE", `/api/imports/${c.body.import.id}`);
    expect(undo.body).toEqual({ removed_count: 10 });
    expect((await app.call("GET", "/api/transactions?month=2026-10")).body.transactions).toHaveLength(0);
    expect((await app.call("GET", "/api/imports")).body).toEqual([]);
    const acct = (await app.call("GET", "/api/accounts")).body[0];
    expect(acct.last_import_date).toBeNull();
    expect(acct.csv_format).not.toBeNull();
    expect((await app.call("GET", "/api/rules")).body).toHaveLength(1);
    expect((await app.call("DELETE", `/api/imports/${c.body.import.id}`)).status).toBe(404);
  });

  it("commit is atomic: a failing insert leaves nothing behind (account, import, rows)", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,A,-5.00\n";
    // unknown override category is rejected up front; force a mid-transaction failure with a trigger
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const r = await app.call("POST", "/api/imports", importBody("a.csv", csv));
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("internal");
    for (const t of ["accounts", "imports", "transactions"])
      expect((app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n).toBe(0);
  });

  it("validation: bad inputs", async () => {
    app = await startApp();
    const ok = "Date,Description,Amount\n10/15/2026,A,-5.00\n";
    expect((await app.call("POST", "/api/imports/preview", { file_name: "a.csv", content: "a\0b,c\n1,2" })).body.error.code).toBe("invalid_file");
    expect((await app.call("POST", "/api/imports/preview", { file_name: "a.csv", content: "just one column\nx" })).body.error.code).toBe("invalid_file");
    expect((await app.call("POST", "/api/imports/preview", { file_name: "a.csv", content: "Date,Description,Amount\n" })).body.error.message).toBe("This file has no transactions in it.");
    expect((await app.call("POST", "/api/imports/preview", { file_name: "a.csv", content: "x".repeat(10 * 1024 * 1024 + 1) })).body.error.message).toMatch(/too large/);
    expect((await app.call("POST", "/api/imports/preview", { content: ok })).body.error.code).toBe("validation");
    const both = importBody("a.csv", ok, { account_id: 1 });
    expect((await app.call("POST", "/api/imports", both)).body.error.code).toBe("validation");
    expect((await app.call("GET", "/api/transactions?month=2026-13")).status).toBe(400);
    expect((await app.call("GET", "/api/nope")).status).toBe(404);
  });
});

describe("rules", () => {
  async function seed() {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/1/2026,TRADER JOE'S #1,-5\n10/2/2026,TRADER JOE'S ORGANIC #2,-6\n10/3/2026,SHELL OIL 123,-7\n";
    await app.call("POST", "/api/imports", importBody("a.csv", csv));
  }
  it("POST applies only to uncategorized, returns applied_count; impact matches; replace keeps id", async () => {
    await seed();
    const groc = await catId("Groceries"), dining = await catId("Dining");
    const tx = (await app.call("GET", "/api/transactions?month=2026-10")).body.transactions;
    const joes = tx.find((t: any) => t.description === "TRADER JOE'S ORGANIC #2");
    await app.call("PATCH", `/api/transactions/${joes.id}`, { category_id: dining }); // already categorized: untouched
    expect((await app.call("GET", "/api/rules/impact?merchant=trader%20joe")).body).toEqual({ uncategorized_count: 1 });
    const r = await app.call("POST", "/api/rules", { merchant: " trader joe's ", category_id: groc });
    expect(r.status).toBe(201);
    expect(r.body.applied_count).toBe(1);
    expect(r.body.rule.merchant).toBe("TRADER JOE'S");
    const again = await app.call("POST", "/api/rules", { merchant: "TRADER JOE'S", category_id: dining });
    expect(again.body.rule.id).toBe(r.body.rule.id);
    expect(again.body.rule.category_id).toBe(dining);
    expect(again.body.applied_count).toBe(0);
    expect((await app.call("POST", "/api/rules", { merchant: "ab", category_id: groc })).status).toBe(400);
  });
  it("longest merchant wins, then newest", async () => {
    await seed();
    const groc = await catId("Groceries"), dining = await catId("Dining"), shop = await catId("Shopping");
    await app.call("POST", "/api/rules", { merchant: "TRADER", category_id: groc });
    await app.call("POST", "/api/rules", { merchant: "TRADER JOE'S ORGANIC", category_id: dining });
    await app.call("POST", "/api/rules", { merchant: "SHELL", category_id: groc });
    await app.call("POST", "/api/rules", { merchant: "OIL", category_id: shop }); // same length? no: SHELL longer
    const csv = "Date,Description,Amount\n11/1/2026,TRADER JOE'S ORGANIC #9,-1\n11/2/2026,SHELL OIL 99,-1\n11/3/2026,TRADER X,-1\n";
    const p = await app.call("POST", "/api/imports/preview", { file_name: "b.csv", content: csv, account_id: 1, format: fmtOf(csv) });
    const by = Object.fromEntries(p.body.review.new_rows.map((r: any) => [r.description, r]));
    expect(by["TRADER JOE'S ORGANIC #9"].category_id).toBe(dining);
    expect(by["SHELL OIL 99"].rule_merchant).toBe("SHELL");
    expect(by["TRADER X"].category_id).toBe(groc);
    // tie on length -> newest
    await app.call("POST", "/api/rules", { merchant: "AAA", category_id: groc });
    await app.call("POST", "/api/rules", { merchant: "BBB", category_id: shop });
    const csv2 = "Date,Description,Amount\n11/1/2026,AAA BBB,-1\n";
    const p2 = await app.call("POST", "/api/imports/preview", { file_name: "b.csv", content: csv2, account_id: 1, format: fmtOf(csv2) });
    expect(p2.body.review.new_rows[0].rule_merchant).toBe("BBB");
  });
  it("PATCH conflict and DELETE don't touch transactions", async () => {
    await seed();
    const groc = await catId("Groceries");
    const a = (await app.call("POST", "/api/rules", { merchant: "TRADER", category_id: groc })).body.rule;
    const b = (await app.call("POST", "/api/rules", { merchant: "SHELL", category_id: groc })).body.rule;
    expect((await app.call("PATCH", `/api/rules/${b.id}`, { merchant: "trader" })).status).toBe(409);
    await app.call("DELETE", `/api/rules/${a.id}`);
    const tx = (await app.call("GET", "/api/transactions?month=2026-10")).body.transactions;
    expect(tx.filter((t: any) => t.category_id === groc)).toHaveLength(3);
  });
});

describe("categories", () => {
  it("delete cascades and protects system categories", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/1/2026,SHELL OIL,-5\n";
    await app.call("POST", "/api/imports", importBody("a.csv", csv));
    const t = (await app.call("POST", "/api/categories", { name: "Pets" })).body;
    expect(t).toMatchObject({ name: "Pets", system_key: null, excluded_from_totals: false });
    const all = (await app.call("GET", "/api/categories")).body;
    expect(all.findIndex((c: any) => c.name === "Pets")).toBe(all.findIndex((c: any) => c.name === "Income") - 1);
    expect((await app.call("POST", "/api/categories", { name: "pets" })).status).toBe(409);
    const tx = (await app.call("GET", "/api/transactions?month=2026-10")).body.transactions[0];
    await app.call("PATCH", `/api/transactions/${tx.id}`, { category_id: t.id });
    await app.call("POST", "/api/rules", { merchant: "SHELL", category_id: t.id });
    app.db.prepare("INSERT INTO budgets VALUES ('2026-10', ?, 5000)").run(t.id);
    app.db.prepare("INSERT INTO recurring_items (name, amount_cents, category_id, account_id, frequency, anchor_date, match_text) VALUES ('x', -100, ?, NULL, 'monthly', '2026-01-01', 'X')").run(t.id);
    expect((await app.call("GET", "/api/categories")).body.find((c: any) => c.id === t.id)).toMatchObject({ transaction_count: 1, recurring_count: 1, rule_count: 1 });
    expect((await app.call("DELETE", `/api/categories/${t.id}`)).status).toBe(204);
    const unc = all.find((c: any) => c.system_key === "uncategorized").id;
    expect((await app.call("GET", "/api/transactions?month=2026-10")).body.transactions[0].category_id).toBe(unc);
    expect((app.db.prepare("SELECT category_id FROM recurring_items").get() as any).category_id).toBe(unc);
    expect((await app.call("GET", "/api/rules")).body).toEqual([]);
    expect((app.db.prepare("SELECT COUNT(*) n FROM budgets").get() as any).n).toBe(0);
    for (const k of ["income", "transfer", "uncategorized"]) {
      const id = all.find((c: any) => c.system_key === k).id;
      expect((await app.call("DELETE", `/api/categories/${id}`)).status).toBe(403);
    }
    const income = all.find((c: any) => c.system_key === "income");
    expect((await app.call("PATCH", `/api/categories/${income.id}`, { name: "Pay" })).status).toBe(403);
    expect((await app.call("PATCH", `/api/categories/${income.id}`, { excluded_from_totals: true })).status).toBe(403);
    expect((await app.call("PATCH", `/api/categories/${income.id}`, { color: "red" })).status).toBe(400);
  });
  it("totals exclude Transfer; toggling Transfer changes them", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/1/2026,PAYROLL,2400\n10/2/2026,GROCER,-100\n10/3/2026,XFER,-500\n";
    await app.call("POST", "/api/imports", importBody("a.csv", csv));
    const cats = (await app.call("GET", "/api/categories")).body;
    const id = (k: string) => cats.find((c: any) => c.system_key === k).id;
    const tx = (await app.call("GET", "/api/transactions?month=2026-10")).body.transactions;
    const set = (d: string, c: number) => app.call("PATCH", `/api/transactions/${tx.find((t: any) => t.description === d).id}`, { category_id: c });
    await set("PAYROLL", id("income")); await set("XFER", id("transfer"));
    let r = (await app.call("GET", "/api/transactions?month=2026-10")).body;
    expect([r.income_cents, r.spent_cents]).toEqual([240000, 10000]);
    await app.call("PATCH", `/api/categories/${id("transfer")}`, { excluded_from_totals: false });
    r = (await app.call("GET", "/api/transactions?month=2026-10")).body;
    expect(r.spent_cents).toBe(60000);
    expect((await app.call("GET", `/api/transactions?month=2026-10&q=grocer`)).body.transactions).toHaveLength(1);
    expect((await app.call("GET", "/api/transactions/uncategorized-count?month=2026-10")).body).toEqual({ count: 1 });
  });
});

describe("data management", () => {
  it("sample data seeds everything; sample-csv previews; erase returns to first run", async () => {
    app = await startApp();
    expect((await app.call("GET", "/api/months")).body).toMatchObject({ today: "2026-10-25", has_transactions: false, earliest_month: "2026-10", latest_month: "2026-11" });
    expect((await app.call("POST", "/api/sample-data")).status).toBe(204);
    const m = (await app.call("GET", "/api/months")).body;
    expect(m).toMatchObject({ has_transactions: true, earliest_month: "2026-05" });
    for (const t of ["accounts", "rules", "recurring_items", "budgets", "other_budgets", "imports", "transactions"])
      expect((app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n).toBeGreaterThan(0);
    expect((app.db.prepare("SELECT COUNT(*) n FROM transactions WHERE date > '2026-10-25'").get() as any).n).toBe(0);
    expect((await app.call("POST", "/api/sample-data")).status).toBe(204); // replaces, no unique errors
    const sc = (await app.call("GET", "/api/imports/sample-csv")).body;
    const p = await app.call("POST", "/api/imports/preview", { file_name: sc.file_name, content: sc.content });
    expect(p.status).toBe(200);
    expect(p.body.detected_format.sign_mode).toBe("purchases_negative");
    expect((await app.call("DELETE", "/api/data")).status).toBe(204);
    expect((await app.call("GET", "/api/months")).body.has_transactions).toBe(false);
    const cats = (await app.call("GET", "/api/categories")).body;
    expect(cats).toHaveLength(11);
    expect((await app.call("GET", "/api/accounts")).body).toEqual([]);
    expect((app.db.prepare("SELECT COUNT(*) n FROM other_budgets").get() as any).n).toBe(0);
  });
  it("migration 2 applies on an existing v1 DB", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mig-")), "b.db");
    openDb(f).close();
    const raw = new Database(f);
    raw.exec("DROP TABLE other_budgets"); raw.pragma("user_version = 1"); raw.close();
    const db = openDb(f);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM other_budgets").get()).toEqual({ n: 0 });
    db.close();
  });
  it("rejects non-local Host headers", async () => {
    app = await startApp();
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: app.port, path: "/api/months", headers: { host: "evil.example" } },
        (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject);
    });
    expect(status).toBe(403);
  });
});

describe("CSRF guard, wide CSV", () => {
  it("text/plain POST -> 415 and data unchanged; foreign Origin -> 403; JSON {} works on POST and DELETE", async () => {
    app = await startApp();
    const raw = (method: string, headers: Record<string, string>) => fetch(app.base + "/api/sample-data", { method, headers });
    const r = await raw("POST", { "content-type": "text/plain" });
    expect(r.status).toBe(415);
    expect((await r.json()).error.code).toBe("unsupported_media_type");
    expect((await app.call("GET", "/api/months")).body.has_transactions).toBe(false);
    expect((await raw("POST", { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await raw("POST", { origin: "http://localhost:5173", "content-type": "application/json" })).status).toBe(204);
    expect((await app.call("DELETE", "/api/data")).status).toBe(204);
  });
  it("rejects a CSV with >200 columns as invalid_file", async () => {
    app = await startApp();
    const content = "Date,Description,Amount\n10/15/2026,X," + ",".repeat(250) + "\n";
    const r = await app.call("POST", "/api/imports/preview", { file_name: "w.csv", content, account_id: null, format: null });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_file");
  });
});

describe("header detection with trailing commas", () => {
  it("header without trailing comma + data rows with one", () => {
    const f = fmtOf("Date,Description,Amount\n10/15/2026,Coffee,-5.00,\n10/16/2026,Tea,-3.00,\n");
    expect(f.has_header).toBe(true);
    expect(f.column_roles.slice(0, 3)).toEqual(["date", "description", "amount"]);
    expect(f.column_roles).toHaveLength(4);
  });
});
