// QA regression tests for slice 1 (import / transactions / settings edge cases from specs/budget-v1.md).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { detectFormat, parseAmount, parseCsvText, parseRows } from "../shared/csv.js";
import { startApp } from "../test/helpers.js";

const fx = (n: string) => readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url), "utf8");
let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

const fmtOf = (c: string) => detectFormat(parseCsvText(c));
const body = (file_name: string, content: string, extra: object = {}) => ({
  file_name, content, account_id: null, new_account: { name: "Chase Checking", type: "checking" },
  format: fmtOf(content), save_format: true, category_overrides: [], ...extra,
});
const cats = async () => (await app.call("GET", "/api/categories")).body as any[];
const catId = async (name: string) => (await cats()).find((c) => c.name === name).id;
const txs = async (m = "2026-10") => (await app.call("GET", `/api/transactions?month=${m}`)).body;

describe("money correctness (G1, 5.7)", () => {
  it("imports every amount format to the exact cent", async () => {
    app = await startApp();
    const csv = [
      "Date,Description,Amount",
      '10/01/2026,BIG PAYCHECK,"$1,234.56"',
      "10/02/2026,PAREN REFUND,(12.34)",
      '10/03/2026,NEG DOLLAR,"-$1,000.07"',
      "10/04/2026,DOLLAR NEG,$-0.99",
      "10/05/2026,PLUS,+3",
      "10/06/2026,HALF,12.5",
      "10/07/2026,ZERO,0.00",
      "10/08/2026,BAD AMT,12.345",
    ].join("\n");
    const r = await app.call("POST", "/api/imports", body("m.csv", csv, { format: { ...fmtOf(csv), sign_mode: "purchases_negative" } }));
    expect(r.status).toBe(201);
    expect(r.body.import).toMatchObject({ new_count: 7, unreadable_count: 1 });
    const by = Object.fromEntries((await txs()).transactions.map((t: any) => [t.description, t.amount_cents]));
    expect(by).toEqual({
      "BIG PAYCHECK": 123456, "PAREN REFUND": -1234, "NEG DOLLAR": -100007, "DOLLAR NEG": -99,
      PLUS: 300, HALF: 1250, ZERO: 0,
    });
  });

  it("debit/credit: abs(credit) - abs(debit); one empty = 0; both empty = unreadable", async () => {
    app = await startApp();
    const csv = "Date,Description,Debit,Credit\n10/01/2026,COFFEE,4.50,\n10/02/2026,PAY,,\"2,000.00\"\n10/03/2026,NEG DEBIT,-7.25,\n10/04/2026,EMPTY,,\n";
    const f = fmtOf(csv);
    expect(f.sign_mode).toBe("debit_credit");
    const r = await app.call("POST", "/api/imports", body("dc.csv", csv));
    expect(r.body.import).toMatchObject({ new_count: 3, unreadable_count: 1 });
    const by = Object.fromEntries((await txs()).transactions.map((t: any) => [t.description, t.amount_cents]));
    expect(by).toEqual({ COFFEE: -450, PAY: 200000, "NEG DEBIT": -725 });
  });

  it("Amex positive-purchases file comes out as spending; payment as income-signed", async () => {
    app = await startApp();
    const csv = fx("amex-card.csv");
    expect(fmtOf(csv).sign_mode).toBe("purchases_positive");
    const r = await app.call("POST", "/api/imports", body("amex.csv", csv, { new_account: { name: "Amex", type: "credit_card" } }));
    expect(r.status).toBe(201);
    const by = (await txs()).transactions.map((t: any) => [t.description, t.amount_cents]);
    expect(by).toContainEqual(["NETFLIX.COM", -1549]);
    expect(by).toContainEqual(["AMZN Mktp US*MK1A2", -4210]);
    expect(by).toContainEqual(["UBER *TRIP", 850]); // -8.50 in a purchases-positive file = credit
    expect(by).toContainEqual(["AUTOPAY PAYMENT - THANK YOU", 90000]);
    expect(by.filter(([d]: any) => d === "SQ *COFFEE, BAKERY")).toEqual([["SQ *COFFEE, BAKERY", -500], ["SQ *COFFEE, BAKERY", -500]]);
  });

  it("parseAmount never returns a non-safe integer (huge values are unparseable)", () => {
    const v = parseAmount("99999999999999999.99");
    expect(v === null || Number.isSafeInteger(v)).toBe(true);
  });
});

describe("duplicates and overrides (5.9, IM-18)", () => {
  it("case/whitespace-only description change is a duplicate; overrides on duplicate lines are ignored", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,Trader Joe's #552,-12.00\n10/16/2026,Shell,-30.00\n";
    const r1 = await app.call("POST", "/api/imports", body("a.csv", csv));
    const acct = r1.body.account.id;
    const csv2 = "Date,Description,Amount\n10/15/2026,TRADER  JOE'S #552,-12.00\n10/17/2026,NEW ONE,-1.00\n";
    const groc = await catId("Groceries");
    const r2 = await app.call("POST", "/api/imports", body("b.csv", csv2, {
      account_id: acct, new_account: null, category_overrides: [{ line: 2, category_id: groc }, { line: 3, category_id: groc }],
    }));
    expect(r2.body.import).toMatchObject({ new_count: 1, skipped_count: 1 });
    const all = (await txs()).transactions;
    expect(all).toHaveLength(3);
    expect(all.find((t: any) => t.description.toUpperCase().startsWith("TRADER")).description).toBe("Trader Joe's #552");
    expect(all.find((t: any) => t.description === "NEW ONE").category_id).toBe(groc);
  });

  it("new account name colliding case-insensitively -> 409 and nothing written", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,A,-5.00\n";
    await app.call("POST", "/api/imports", body("a.csv", csv));
    const r = await app.call("POST", "/api/imports", body("b.csv", "Date,Description,Amount\n10/16/2026,B,-5.00\n", { new_account: { name: "chase checking", type: "savings" } }));
    expect(r.status).toBe(409);
    expect((await app.call("GET", "/api/accounts")).body).toHaveLength(1);
    expect((await app.call("GET", "/api/imports")).body).toHaveLength(1);
  });

  it("header signature on two accounts -> matched_accounts 2, no review (IM-5 / edge 20)", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,A,-5.00\n";
    await app.call("POST", "/api/imports", body("a.csv", csv));
    await app.call("POST", "/api/imports", body("b.csv", csv, { new_account: { name: "Other", type: "savings" } }));
    const p = await app.call("POST", "/api/imports/preview", { file_name: "x.csv", content: csv });
    expect(p.body.matched_accounts).toHaveLength(2);
    expect(p.body.review).toBeNull();
  });
});

describe("undo import (IM-24, IM-25, edge 32/33)", () => {
  it("undoing the newest import recomputes last_import_date to the older one and keeps overlapping later rows", async () => {
    app = await startApp();
    const a = "Date,Description,Amount\n10/01/2026,A,-1.00\n10/02/2026,B,-2.00\n";
    const r1 = await app.call("POST", "/api/imports", body("a.csv", a));
    const acct = r1.body.account.id;
    app.db.prepare("UPDATE imports SET imported_at = ? WHERE id = ?").run("2026-09-03T12:00:00.000Z", r1.body.import.id);
    const b = "Date,Description,Amount\n10/02/2026,B,-2.00\n10/03/2026,C,-3.00\n";
    const r2 = await app.call("POST", "/api/imports", body("b.csv", b, { account_id: acct, new_account: null }));
    expect(r2.body.import).toMatchObject({ new_count: 1, skipped_count: 1 });
    // undo the OLDER import: only its own rows go; C stays
    const u = await app.call("DELETE", `/api/imports/${r1.body.import.id}`);
    expect(u.body.removed_count).toBe(2);
    expect((await txs()).transactions.map((t: any) => t.description)).toEqual(["C"]);
    // re-import a: restores both rows (B no longer present)
    const r3 = await app.call("POST", "/api/imports", body("a.csv", a, { account_id: acct, new_account: null }));
    expect(r3.body.import.new_count).toBe(2);
    // backdate r3, then undo r2 -> last_import_date = r3's date
    app.db.prepare("UPDATE imports SET imported_at = ? WHERE id = ?").run("2026-09-10T12:00:00.000Z", r3.body.import.id);
    await app.call("DELETE", `/api/imports/${r2.body.import.id}`);
    const acc = (await app.call("GET", "/api/accounts")).body[0];
    expect(acc.last_import_date).toBe("2026-09-10");
  });

  it("month range shrinks back after undoing the only old data", async () => {
    app = await startApp("2026-10-25");
    const r = await app.call("POST", "/api/imports", body("old.csv", "Date,Description,Amount\n03/15/2026,OLD,-1.00\n"));
    expect((await app.call("GET", "/api/months")).body).toMatchObject({ earliest_month: "2026-03", has_transactions: true });
    await app.call("DELETE", `/api/imports/${r.body.import.id}`);
    expect((await app.call("GET", "/api/months")).body).toMatchObject({ earliest_month: "2026-10", latest_month: "2026-11", has_transactions: false });
  });
});

describe("settings validation (ST-2, ST-3, ST-5)", () => {
  it("account rename duplicate (case-insensitive) is 409; forget format clears csv_format", async () => {
    app = await startApp();
    const csv = "Date,Description,Amount\n10/15/2026,A,-5.00\n";
    await app.call("POST", "/api/imports", body("a.csv", csv));
    const r2 = await app.call("POST", "/api/imports", body("b.csv", csv, { new_account: { name: "Amex", type: "credit_card" } }));
    const id = r2.body.account.id;
    expect((await app.call("PATCH", `/api/accounts/${id}`, { name: "CHASE checking" })).status).toBe(409);
    expect((await app.call("PATCH", `/api/accounts/${id}`, { type: "bogus" })).status).toBe(400);
    expect((await app.call("PATCH", `/api/accounts/${id}`, { name: "x".repeat(61) })).status).toBe(400);
    const f = await app.call("PATCH", `/api/accounts/${id}`, { csv_format: null });
    expect(f.body.csv_format).toBeNull();
    const p = await app.call("POST", "/api/imports/preview", { file_name: "c.csv", content: csv });
    expect(p.body.matched_accounts.map((a: any) => a.name)).toEqual(["Chase Checking"]);
  });

  it("add category inserts before Income; rename duplicate is 409; Transfer renamable but not deletable", async () => {
    app = await startApp();
    const r = await app.call("POST", "/api/categories", { name: "  Pets  " });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("Pets");
    const names = (await cats()).map((c) => c.name);
    expect(names.indexOf("Pets")).toBe(names.indexOf("Income") - 1);
    expect((await app.call("PATCH", `/api/categories/${r.body.id}`, { name: "DINING" })).status).toBe(409);
    const tr = await catId("Transfer");
    expect((await app.call("PATCH", `/api/categories/${tr}`, { name: "Transfers" })).status).toBe(200);
    expect((await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: false })).body.excluded_from_totals).toBe(false);
    expect((await app.call("DELETE", `/api/categories/${tr}`)).status).toBe(403);
  });
});
