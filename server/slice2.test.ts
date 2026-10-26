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
    expect(r.series.map((s: any) => s.month)).toEqual(["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(r.series.map((s: any) => [s.income_cents, s.spent_cents])).toEqual([[0, 0], [0, 100], [0, 0], [0, 0], [1000, 0], [0, 200], [0, 0]]);
  });
  it("series_end shifts the 7-month window; month totals stay put", async () => {
    const { key, add } = await setup();
    add("2026-11-10", -300, key("uncategorized"));
    add("2027-01-05", -400, key("uncategorized"));
    const r = (await app.call("GET", "/api/summary?month=2026-11&series_end=2027-01")).body;
    expect(r.series.map((s: any) => s.month)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(r.series[4]).toEqual({ month: "2026-11", income_cents: 0, spent_cents: 300 });
    expect(r.series[6].spent_cents).toBe(400);
    expect(r).toMatchObject({ month: "2026-11", spent_cents: 300, spent_count: 1 });
    const d = (await app.call("GET", "/api/summary?month=2026-11")).body;
    expect(d.series).toHaveLength(7);
    expect(d.series.at(-1).month).toBe("2026-11");
    const max = (await app.call("GET", "/api/summary?month=2026-11&series_end=2027-05")).body;
    expect(max.series.at(-1).month).toBe("2027-05");
    expect(max.series[0].month).toBe("2026-11");
  });
  it("rejects bad series_end", async () => {
    await setup();
    for (const q of ["series_end=2026-10", "series_end=2027-06", "series_end=nope"])
      expect((await app.call("GET", `/api/summary?month=2026-11&${q}`)).status).toBe(400);
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
  it("Other budget: spent = unbudgeted spend, upsert/delete, validation, total", async () => {
    const { name, add } = await setup();
    const [din, gro] = [name("Dining"), name("Groceries")];
    add("2026-10-02", -5000, din); add("2026-10-03", -9000, gro);
    const put = (b: object) => app.call("PUT", "/api/budgets", { month: "2026-10", category_id: null, amount_cents: 1, ...b });
    let r = (await app.call("GET", "/api/budgets?month=2026-10")).body;
    expect(r.other).toEqual({ budget_cents: null, spent_cents: 14000 });
    r = (await put({ amount_cents: 2000 })).body;
    expect(r.other.budget_cents).toBe(2000); expect(r.total_budget_cents).toBe(2000);
    r = (await app.call("PUT", "/api/budgets", { month: "2026-10", category_id: din, amount_cents: 100 })).body;
    expect(r.other).toEqual({ budget_cents: 2000, spent_cents: 9000 });
    expect(r.total_budget_cents).toBe(2100);
    r = (await put({ amount_cents: 3000 })).body; expect(r.other.budget_cents).toBe(3000);
    r = (await put({ amount_cents: 0 })).body; expect(r.other.budget_cents).toBeNull();
    expect((await put({ amount_cents: -1 })).status).toBe(400);
    expect((await put({ amount_cents: 10_000_000_001 })).status).toBe(400);
    expect((await put({ month: "bad" })).status).toBe(400);
    expect((await app.call("PUT", "/api/budgets", { month: "2026-10", amount_cents: 1 })).status).toBe(400);
  });
  it("copy includes Other and counts it", async () => {
    const { name } = await setup();
    const put = (m: string, c: number | null, a: number) => app.call("PUT", "/api/budgets", { month: m, category_id: c, amount_cents: a });
    await put("2025-12", null, 700);
    let r = (await app.call("POST", "/api/budgets/copy", { month: "2026-01" })).body;
    expect(r.copied_count).toBe(1); expect(r.budgets.other.budget_cents).toBe(700);
    await put("2026-01", null, 5); await put("2025-12", name("Dining"), 100);
    r = (await app.call("POST", "/api/budgets/copy", { month: "2026-01" })).body;
    expect(r.copied_count).toBe(2); expect(r.budgets.total_budget_cents).toBe(800);
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
