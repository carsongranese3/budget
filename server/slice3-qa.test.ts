// QA regressions for slice 3 (Recurring): RC-1 next_date, edge 27/34/35, §6.4 totals, IM-20 window, category delete.
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../test/helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

async function setup(today = "2026-10-25") {
  app = await startApp(today);
  const cats = (await app.call("GET", "/api/categories")).body as any[];
  app.db.prepare("INSERT INTO accounts (name, type, created_at) VALUES ('A','checking','x')").run();
  app.db.prepare("INSERT INTO imports (file_name, account_id, imported_at, row_count, new_count, skipped_count, unreadable_count) VALUES ('f',1,'x',0,0,0,0)").run();
  const income = cats.find((c) => c.system_key === "income");
  const spend = cats.find((c) => !c.system_key && !c.excluded_from_totals);
  const add = (date: string, desc: string, amt: number, cat = amt > 0 ? income.id : spend.id) =>
    app.db.prepare("INSERT INTO transactions (account_id,date,description,amount_cents,category_id,import_id,created_at) VALUES (1,?,?,?,?,1,'x')")
      .run(date, desc, amt, cat);
  const body = (o: any = {}) => ({ name: "Gym", amount_cents: -4500, category_id: spend.id, account_id: 1, frequency: "monthly",
    anchor_date: "2026-10-05", match_text: "GYM MEMBERSHIP", ...o });
  const post = async (o: any = {}) => (await app.call("POST", "/api/recurring", body(o))).body;
  return { cats, income, spend, add, post };
}

describe("slice 3 QA", () => {
  it("RC-1: next_date equals a far-future anchor (> 400 days out)", async () => {
    const { post } = await setup();
    expect((await post({ anchor_date: "2028-03-15" })).next_date).toBe("2028-03-15");
    expect((await post({ anchor_date: "2028-03-15", frequency: "yearly" })).next_date).toBe("2028-03-15");
  });

  it("edge 27: monthly anchor Jan 31 -> Feb 28, Mar 31 (via API next_date + upcoming)", async () => {
    let { post } = await setup("2026-02-10");
    expect((await post({ anchor_date: "2026-01-31" })).next_date).toBe("2026-02-28");
    const up = (await app.call("GET", "/api/recurring/upcoming?month=2026-02")).body.upcoming.map((o: any) => o.date);
    expect(up.slice(0, 4)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    app.close();
    ({ post } = await setup("2026-03-01"));
    expect((await post({ anchor_date: "2026-01-31" })).next_date).toBe("2026-03-31");
  });

  it("RC-8: future anchor -> Nothing due yet, no expected", async () => {
    const { post } = await setup();
    const r = await post({ anchor_date: "2026-11-03" });
    expect(r).toMatchObject({ next_date: "2026-11-03", status: { kind: "none", date: null } });
    expect((await app.call("GET", "/api/recurring/upcoming?month=2026-10")).body.expected).toEqual([]);
    expect((await app.call("GET", "/api/summary?month=2026-10")).body).toMatchObject({ expected_spent_cents: 0, expected_income_cents: 0 });
  });

  it("edge 34 + §6.4: past anchor expected immediately; expected never changes Income/Spent/Net", async () => {
    const { post, add } = await setup();
    add("2026-10-02", "COFFEE", -1000);
    add("2026-10-01", "PAYROLL", 200000);
    const before = (await app.call("GET", "/api/summary?month=2026-10")).body;
    expect((await post()).status).toEqual({ kind: "expected", date: "2026-10-05" });
    await post({ name: "Bonus", amount_cents: 50000, match_text: "BONUS", anchor_date: "2026-10-20" });
    const s = (await app.call("GET", "/api/summary?month=2026-10")).body;
    expect(s).toMatchObject({ expected_spent_cents: 4500, expected_income_cents: 50000 });
    expect([s.income_cents, s.spent_cents, s.net_cents]).toEqual([before.income_cents, before.spent_cents, before.net_cents]);
  });

  it("§6.2: ±4 days inclusive, 5 days is not received", async () => {
    const { post, add } = await setup();
    add("2026-10-10", "GYM MEMBERSHIP 123", -4500); // 5 days after Oct 5
    expect((await post()).status.kind).toBe("expected");
    add("2026-10-09", "gym membership 123", -4500); // 4 days, lowercase
    expect((await app.call("GET", "/api/recurring")).body[0].status).toEqual({ kind: "received", date: "2026-10-05" });
  });

  it("edge 35: moving the anchor later clears Expected -> Nothing due yet", async () => {
    const { post } = await setup();
    await post();
    const r = (await app.call("PATCH", "/api/recurring/1", { anchor_date: "2026-11-05" })).body;
    expect(r).toMatchObject({ status: { kind: "none" }, next_date: "2026-11-05" });
    expect((await app.call("GET", "/api/recurring/upcoming?month=2026-10")).body.expected).toEqual([]);
  });

  it("RC-2: inactive items drop out of expected and upcoming", async () => {
    const { post } = await setup();
    await post();
    await app.call("PATCH", "/api/recurring/1", { active: false });
    expect((await app.call("GET", "/api/recurring/upcoming?month=2026-10")).body).toEqual({ expected: [], upcoming: [] });
  });

  it("IM-20: commit lists GYM (Oct 5) when the import holds a match within 4 days", async () => {
    await setup();
    const { post } = { post: async (o: any) => (await app.call("POST", "/api/recurring", o)).body };
    const cats = (await app.call("GET", "/api/categories")).body as any[];
    await post({ name: "GYM", amount_cents: -4500, category_id: cats[0].id, account_id: 1, frequency: "monthly", anchor_date: "2026-10-05", match_text: "GYM MEMBERSHIP" });
    const r = await app.call("POST", "/api/imports", {
      file_name: "g.csv", content: "Date,Description,Amount\n10/08/2026,GYM MEMBERSHIP 77,-45.00\n", account_id: 1, new_account: null, save_format: false, category_overrides: [],
      format: { header_signature: "date|description|amount", column_roles: ["date", "description", "amount"], sign_mode: "purchases_negative", date_format: "MDY", has_header: true },
    });
    expect(r.body.matched_recurring).toEqual([{ recurring_id: 1, name: "GYM", date: "2026-10-05" }]);
    expect((await app.call("GET", "/api/recurring")).body[0].status.kind).toBe("received");
  });

  it("deleting a category moves its recurring items to Uncategorized", async () => {
    const { cats, post } = await setup();
    const c = (await app.call("POST", "/api/categories", { name: "Temp" })).body;
    await post({ category_id: c.id });
    expect((await app.call("DELETE", `/api/categories/${c.id}`)).status).toBeLessThan(300);
    const unc = cats.find((x) => x.system_key === "uncategorized");
    expect((await app.call("GET", "/api/recurring")).body[0].category_id).toBe(unc.id);
  });

  it("rejects non-JSON writes and junk ids on recurring routes", async () => {
    await setup();
    const res = await fetch(`${app.base}/api/recurring`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await app.call("PATCH", "/api/recurring/abc", { active: true })).status).toBe(404); // idParam convention
    expect((await app.call("DELETE", "/api/recurring/1e3")).status).toBeGreaterThanOrEqual(400);
    expect((await app.call("POST", "/api/recurring", [])).status).toBe(400);
  });
});
