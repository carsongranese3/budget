import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../test/helpers.js";
import { detectFormat, parseCsvText } from "../shared/csv.js";
import { splitDuplicates } from "./imports.js";

let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const PDF = Buffer.from("%PDF-1.4 hello");
const up = (id: number, name: string, buf: Buffer) => app.call("POST", `/api/transactions/${id}/receipts`, { file_name: name, content_base64: buf.toString("base64") });

async function seed() {
  app = await startApp();
  app.db.prepare("INSERT INTO accounts (name,type,created_at) VALUES ('A','checking','x')").run();
  app.db.prepare("INSERT INTO imports (file_name,account_id,imported_at,row_count,new_count,skipped_count,unreadable_count) VALUES ('f',1,'x',1,1,0,0)").run();
  app.db.prepare("INSERT INTO transactions (account_id,date,description,amount_cents,category_id,import_id,created_at) VALUES (1,'2026-10-01','COFFEE',-500,11,1,'x')").run();
}

describe("transaction note / custom_description", () => {
  it("sets, trims, clears, validates", async () => {
    await seed();
    let r = await app.call("PATCH", "/api/transactions/1", { note: "  hi ", custom_description: "Latte" });
    expect(r.body).toMatchObject({ note: "hi", custom_description: "Latte", receipt_count: 0, category_id: 11 });
    r = await app.call("PATCH", "/api/transactions/1", { note: "" });
    expect(r.body.note).toBeNull();
    expect(r.body.custom_description).toBe("Latte");
    expect((await app.call("PATCH", "/api/transactions/1", { custom_description: null })).body.custom_description).toBeNull();
    expect((await app.call("PATCH", "/api/transactions/1", {})).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions/1", { note: "x".repeat(2001) })).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions/1", { custom_description: "x".repeat(201) })).status).toBe(400);
    expect((await app.call("PATCH", "/api/transactions/99", { note: "x" })).status).toBe(404);
  });
});

describe("receipts", () => {
  it("uploads, lists, serves, deletes", async () => {
    await seed();
    const a = await up(1, "r.png", PNG);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ transaction_id: 1, mime_type: "image/png", size_bytes: PNG.length });
    expect(a.body.data).toBeUndefined();
    const p = await up(1, "r.pdf", PDF);
    expect(p.body.mime_type).toBe("application/pdf");
    expect((await app.call("GET", "/api/transactions/1/receipts")).body.map((r: any) => r.id)).toEqual([a.body.id, p.body.id]);
    expect((await app.call("GET", "/api/transactions?month=2026-10")).body.transactions[0].receipt_count).toBe(2);
    const raw = await fetch(`${app.base}/api/receipts/${a.body.id}`);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("content-disposition")).toBe('inline; filename="r.png"');
    expect(raw.headers.get("cache-control")).toBe("no-store");
    expect(raw.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(raw.headers.get("content-disposition")).toContain("filename*=UTF-8''r.png");
    expect(raw.headers.get("x-frame-options")).toBeNull();
    expect(Buffer.from(await raw.arrayBuffer()).equals(PNG)).toBe(true);
    const pdf = await fetch(`${app.base}/api/receipts/${p.body.id}`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(pdf.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await app.call("DELETE", `/api/receipts/${a.body.id}`)).status).toBe(204);
    expect((await app.call("DELETE", `/api/receipts/${a.body.id}`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/receipts/${a.body.id}`)).status).toBe(404);
  });
  it("rejects bad uploads", async () => {
    await seed();
    expect((await up(1, "x.png", Buffer.from("not an image"))).status).toBe(400);
    expect((await app.call("POST", "/api/transactions/1/receipts", { file_name: "a.png", content_base64: "!!!!" })).status).toBe(400);
    expect((await app.call("POST", "/api/transactions/1/receipts", { file_name: "", content_base64: PNG.toString("base64") })).status).toBe(400);
    const big = await up(1, "big.pdf", Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("payload_too_large");
    expect((await up(99, "r.png", PNG)).status).toBe(404);
    expect((await app.call("GET", "/api/transactions/99/receipts")).status).toBe(404);
  });
  it("cascades on undo import and erase", async () => {
    await seed();
    await up(1, "r.png", PNG);
    expect((await app.call("DELETE", "/api/imports/1")).status).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) n FROM receipts").get()).toEqual({ n: 0 });
    await seed();
    await up(1, "r.png", PNG);
    expect((await app.call("DELETE", "/api/data")).status).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) n FROM receipts").get()).toEqual({ n: 0 });
  });
});

describe("editable transaction date", () => {
  it("tracks original_date, validates, and keeps re-import dedupe", async () => {
    await seed();
    let r = await app.call("PATCH", "/api/transactions/1", { date: "2026-10-05" });
    expect(r.body).toMatchObject({ date: "2026-10-05", original_date: "2026-10-01" });
    r = await app.call("PATCH", "/api/transactions/1", { date: "2026-10-09" });
    expect(r.body).toMatchObject({ date: "2026-10-09", original_date: "2026-10-01" });
    const row = { date: "2026-10-01", amount_cents: -500, description: "COFFEE" } as any;
    expect(splitDuplicates(app.db, 1, [row])).toMatchObject({ fresh: [], dupes: [row] });
    r = await app.call("PATCH", "/api/transactions/1", { date: "2026-10-01" });
    expect(r.body).toMatchObject({ date: "2026-10-01", original_date: null });
    for (const date of ["2026-02-30", "abc", 5]) expect((await app.call("PATCH", "/api/transactions/1", { date })).status).toBe(400);
  });
});

describe("editable date + real import commit", () => {
  const csvOf = (rows: string[]) => "Date,Description,Amount\n" + rows.join("\n") + "\n";
  const body = (content: string, account_id: number | null) => ({
    file_name: "a.csv", content, account_id, new_account: account_id ? null : { name: "A", type: "checking" },
    format: detectFormat(parseCsvText(content)), save_format: true, category_overrides: [],
  });
  it("re-import after moving a date (same month, other month) does not duplicate", async () => {
    app = await startApp();
    const csv = csvOf(["10/15/2026,Coffee Shop,-5.00", "10/20/2026,Rent,-100.00"]);
    const c = await app.call("POST", "/api/imports", body(csv, null));
    const acct = c.body.account.id;
    const id = (await app.call("GET", "/api/transactions?month=2026-10")).body.transactions.find((t: any) => t.description === "Coffee Shop").id;
    for (const d of ["2026-10-17", "2026-11-03"]) {
      await app.call("PATCH", `/api/transactions/${id}`, { date: d });
      const r = await app.call("POST", "/api/imports", body(csv, acct));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("nothing_to_import");
    }
    expect(app.db.prepare("SELECT COUNT(*) n FROM transactions").get()).toEqual({ n: 2 });
  });
  it("moved transaction outside the new CSV's range: not duplicated, other rows still import", async () => {
    app = await startApp();
    const c = await app.call("POST", "/api/imports", body(csvOf(["10/15/2026,Coffee Shop,-5.00"]), null));
    const acct = c.body.account.id;
    await app.call("PATCH", "/api/transactions/1", { date: "2026-12-25" });
    // CSV covers only Oct 15..16; the moved row's current date (Dec 25) is outside it
    const csv2 = csvOf(["10/15/2026,Coffee Shop,-5.00", "10/16/2026,Bagel,-3.00"]);
    const r = await app.call("POST", "/api/imports", body(csv2, acct));
    expect(r.status).toBe(201);
    expect(r.body.import).toMatchObject({ new_count: 1, skipped_count: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM transactions").get()).toEqual({ n: 2 });
  });
});
