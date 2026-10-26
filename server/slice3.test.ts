import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../test/helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

async function setup() {
  app = await startApp(); // today = 2026-10-25
  const cats = (await app.call("GET", "/api/categories")).body as any[];
  app.db.prepare("INSERT INTO accounts (name, type, created_at) VALUES ('A','checking','x')").run();
  app.db.prepare("INSERT INTO imports (file_name, account_id, imported_at, row_count, new_count, skipped_count, unreadable_count) VALUES ('f',1,'x',0,0,0,0)").run();
  const add = (date: string, desc: string, amt: number) =>
    app.db.prepare("INSERT INTO transactions (account_id,date,description,amount_cents,category_id,import_id,created_at) VALUES (1,?,?,?,?,1,'x')")
      .run(date, desc, amt, cats[0].id);
  const body = (o: any = {}) => ({ name: "Rent", amount_cents: -100000, category_id: cats[0].id, account_id: 1, frequency: "monthly",
    anchor_date: "2026-08-01", match_text: " rent ", ...o });
  return { cats, add, body };
}

describe("recurring CRUD + validation", () => {
  it("creates, lists, patches, deletes", async () => {
    const { body } = await setup();
    const c = await app.call("POST", "/api/recurring", body());
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ id: 1, match_text: "RENT", active: true, next_date: "2026-11-01", status: { kind: "expected", date: "2026-10-01" } });
    const p = await app.call("PATCH", "/api/recurring/1", { active: false });
    expect(p.body).toMatchObject({ active: false, status: { kind: "paused", date: null } });
    expect((await app.call("PATCH", "/api/recurring/1", { anchor_date: "2026-12-01" })).body)
      .toMatchObject({ next_date: "2026-12-01", status: { kind: "paused" }, match_text: "RENT" });
    expect((await app.call("PATCH", "/api/recurring/1", { match_text: "", name: "Home" })).body.match_text).toBe("HOME");
    expect((await app.call("GET", "/api/recurring")).body).toHaveLength(1);
    expect((await app.call("DELETE", "/api/recurring/1")).status).toBe(204);
    expect((await app.call("DELETE", "/api/recurring/1")).status).toBe(404);
    expect((await app.call("PATCH", "/api/recurring/9", { active: true })).status).toBe(404);
  });
  it("defaults match_text to UPPER(name), allows null account", async () => {
    const { body } = await setup();
    const r = await app.call("POST", "/api/recurring", body({ match_text: "  ", name: "Netflix", account_id: null }));
    expect(r.body).toMatchObject({ match_text: "NETFLIX", account_id: null });
  });
  it("rejects bad input", async () => {
    const { body } = await setup();
    for (const bad of [{ name: "" }, { name: "x".repeat(61) }, { amount_cents: 0 }, { amount_cents: 10_000_000_001 }, { amount_cents: 1.5 },
      { category_id: 999 }, { account_id: 999 }, { frequency: "weekly" }, { anchor_date: "2026-02-30" }, { anchor_date: "x" }, { active: "yes" }]) {
      const r = await app.call("POST", "/api/recurring", body(bad));
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await app.call("POST", "/api/recurring", { name: "n" })).status).toBe(400);
    expect((await app.call("PATCH", "/api/recurring/1", {})).status).toBe(404);
    await app.call("POST", "/api/recurring", body());
    expect((await app.call("PATCH", "/api/recurring/1", {})).status).toBe(400);
    expect((await app.call("PATCH", "/api/recurring/1", { amount_cents: 0 })).status).toBe(400);
    expect((await app.call("GET", "/api/recurring/upcoming?month=bad")).status).toBe(400);
  });
});

describe("expected, upcoming, summary, import", () => {
  it("upcoming + summary expected_* (never added to totals)", async () => {
    const { body, add } = await setup();
    await app.call("POST", "/api/recurring", body()); // Rent: Aug 1.. monthly -> Oct 1 expected
    await app.call("POST", "/api/recurring", body({ name: "Pay", amount_cents: 250000, match_text: "PAYROLL", frequency: "biweekly", anchor_date: "2026-10-09" }));
    await app.call("POST", "/api/recurring", body({ name: "Off", match_text: "OFF", active: false }));
    add("2026-10-12", "PAYROLL ACME", 250000); // receives Oct 9
    const u = (await app.call("GET", "/api/recurring/upcoming?month=2026-10")).body;
    expect(u.expected.map((o: any) => [o.name, o.date])).toEqual([["Rent", "2026-10-01"], ["Pay", "2026-10-23"]]);
    expect(u.upcoming).toHaveLength(10);
    expect(u.upcoming[0]).toMatchObject({ name: "Rent", date: "2026-11-01", recurring_id: 1 });
    expect((await app.call("GET", "/api/recurring/upcoming?month=2026-11")).body.expected).toEqual([]);
    const s = (await app.call("GET", "/api/summary?month=2026-10")).body;
    expect(s).toMatchObject({ expected_income_cents: 250000, expected_spent_cents: 100000, income_cents: 0, spent_cents: -250000 }); // the received paycheck is a refund in Groceries here; expected is not added
    expect((await app.call("GET", "/api/summary?month=2026-11")).body).toMatchObject({ expected_income_cents: 0, expected_spent_cents: 0 });
  });
  it("import commit reports only newly received occurrences", async () => {
    const { body, add } = await setup();
    await app.call("POST", "/api/recurring", body({ anchor_date: "2026-10-03", match_text: "OAKWOOD" }));
    await app.call("POST", "/api/recurring", body({ name: "Gym", amount_cents: -3000, match_text: "GYM", anchor_date: "2026-10-05" }));
    add("2026-10-05", "GYM CLUB", -3000); // Gym already received
    const csv = "Date,Description,Amount\n10/04/2026,OAKWOOD PROPERTY,-1000.00\n10/06/2026,GYM CLUB 2,-30.00\n";
    const r = await app.call("POST", "/api/imports", {
      file_name: "a.csv", content: csv, account_id: 1, new_account: null, save_format: false, category_overrides: [],
      format: { header_signature: "date|description|amount", column_roles: ["date", "description", "amount"], sign_mode: "purchases_negative", date_format: "MDY", has_header: true },
    });
    expect(r.status).toBe(201);
    expect(r.body.matched_recurring).toEqual([{ recurring_id: 1, name: "Rent", date: "2026-10-03" }]);
  });
});
