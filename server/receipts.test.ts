import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../test/helpers.js";

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
