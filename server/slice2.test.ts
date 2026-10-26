import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../test/helpers.js";

let app: Awaited<ReturnType<typeof startApp>>;
afterEach(() => app?.close());

async function setup() {
  app = await startApp();
  const cats = (await app.call("GET", "/api/categories")).body as any[];
  const key = (k: string) => cats.find((c) => c.system_key === k).id as number;
  const name = (n: string) => cats.find((c) => c.name === n).id as number;
  app.db.prepare("INSERT INTO accounts (name, type, created_at) VALUES ('A','checking','x')").run();
  app.db.prepare("INSERT INTO imports (file_name, account_id, imported_at, row_count, new_count, skipped_count, unreadable_count) VALUES ('f',1,'x',0,0,0,0)").run();
  const add = (date: string, amount: number, cat: number) =>
    app.db.prepare("INSERT INTO transactions (account_id,date,description,amount_cents,category_id,import_id,created_at) VALUES (1,?,?,?,?,1,'x')")
      .run(date, "T", amount, cat);
  return { cats, key, name, add };
}

describe("GET /api/summary", () => {
  it("applies G6, orders categories, counts uncategorized", async () => {
    const { key, name, add } = await setup();
    const [din, gro] = [name("Dining"), name("Groceries")];
    add("2026-10-01", 500000, key("income"));
    add("2026-10-02", -20000, gro);
    add("2026-10-03", -5000, din);
    add("2026-10-04", 1000, din); // refund
    add("2026-10-05", -90000, key("transfer"));
    add("2026-10-06", 99999, key("uncategorized")); // deposit: ignored
    add("2026-10-07", -700, key("uncategorized"));
    const r = (await app.call("GET", "/api/summary?month=2026-10")).body;
    expect(r).toMatchObject({
      month: "2026-10", income_cents: 500000, spent_cents: 24700, net_cents: 475300,
      income_count: 1, spent_count: 4, uncategorized_count: 2, expected_income_cents: 0, expected_spent_cents: 0,
    });
    expect(r.by_category).toEqual([
      { category_id: gro, spent_cents: 20000 }, { category_id: din, spent_cents: 4000 },
      { category_id: key("uncategorized"), spent_cents: 700 },
    ]);
  });
  it("series spans the year boundary", async () => {
    const { key, add } = await setup();
    add("2025-09-15", -100, key("uncategorized"));
    add("2025-12-31", 1000, key("income"));
    add("2026-01-01", -200, key("uncategorized"));
    add("2026-03-01", -999, key("uncategorized")); // outside window
    const r = (await app.call("GET", "/api/summary?month=2026-02")).body;
    expect(r.series.map((s: any) => s.month)).toEqual(["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(r.series.map((s: any) => [s.income_cents, s.spent_cents])).toEqual([[0, 100], [0, 0], [0, 0], [1000, 0], [0, 200], [0, 0]]);
  });
  it("validates month", async () => {
    await setup();
    expect((await app.call("GET", "/api/summary?month=2026-13")).status).toBe(400);
    expect((await app.call("GET", "/api/summary")).status).toBe(400);
  });
});

describe("budgets", () => {
  it("lists eligible categories only; set, overwrite, delete, validate", async () => {
    const { key, name, add } = await setup();
    const din = name("Dining");
    add("2026-10-02", -5000, din); add("2026-10-03", -9000, name("Groceries")); add("2026-10-04", 800, name("Groceries"));
    add("2026-10-05", -77, key("uncategorized"));
    let r = (await app.call("GET", "/api/budgets?month=2026-10")).body;
    const ids = r.items.map((i: any) => i.category_id);
    for (const k of ["income", "uncategorized", "transfer"]) expect(ids).not.toContain(key(k));
    expect(r.spent_cents).toBe(5000 + 8200);
    expect(r.items.every((i: any) => i.budget_cents === null)).toBe(true);
    r = (await app.call("PUT", "/api/budgets", { month: "2026-10", category_id: din, amount_cents: 45000 })).body;
    expect(r.items.find((i: any) => i.category_id === din)).toEqual({ category_id: din, budget_cents: 45000, spent_cents: 5000 });
    expect(r.total_budget_cents).toBe(45000);
    r = (await app.call("PUT", "/api/budgets", { month: "2026-10", category_id: din, amount_cents: 100 })).body;
    expect(r.total_budget_cents).toBe(100);
    r = (await app.call("PUT", "/api/budgets", { month: "2026-10", category_id: din, amount_cents: 0 })).body;
    expect(r.total_budget_cents).toBe(0);
    expect(r.items.find((i: any) => i.category_id === din).budget_cents).toBeNull();
    const put = (b: object) => app.call("PUT", "/api/budgets", { month: "2026-10", category_id: din, amount_cents: 1, ...b });
    expect((await put({ amount_cents: -1 })).status).toBe(400);
    expect((await put({ month: "bad" })).status).toBe(400);
    expect((await put({ month: "0000-01" })).status).toBe(400);
    expect((await put({ amount_cents: 10_000_000_001 })).status).toBe(400);
    expect((await put({ amount_cents: 10_000_000_000 })).status).toBe(200);
    for (const k of ["income", "uncategorized", "transfer"]) expect((await put({ category_id: key(k) })).status).toBe(400);
    expect((await put({ category_id: 9999 })).status).toBe(400);
  });
  it("copy: previous month into target, overwrite same category, 0 when empty", async () => {
    const { name } = await setup();
    const [din, gro] = [name("Dining"), name("Groceries")];
    const put = (m: string, c: number, a: number) => app.call("PUT", "/api/budgets", { month: m, category_id: c, amount_cents: a });
    expect((await app.call("POST", "/api/budgets/copy", { month: "2026-01" })).body.copied_count).toBe(0);
    await put("2025-12", din, 100); await put("2025-12", gro, 200); await put("2026-01", din, 5); 
    const r = (await app.call("POST", "/api/budgets/copy", { month: "2026-01" })).body;
    expect(r.copied_count).toBe(2);
    expect(r.budgets.total_budget_cents).toBe(300);
    expect((await app.call("POST", "/api/budgets/copy", { month: "x" })).status).toBe(400);
  });
});
