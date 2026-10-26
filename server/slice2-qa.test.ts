// QA regression tests for slice 2 (Dashboard summary + Budgets): G6 edge cases, BU-4, BU-6, category delete.
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
    Number(app.db.prepare("INSERT INTO transactions (account_id,date,description,amount_cents,category_id,import_id,created_at) VALUES (1,?,?,?,?,1,'x')")
      .run(date, "T", amount, cat).lastInsertRowid);
  const summary = async (m = "2026-10") => (await app.call("GET", `/api/summary?month=${m}`)).body;
  const budgets = async (m = "2026-10") => (await app.call("GET", `/api/budgets?month=${m}`)).body;
  const put = (m: string, c: number, a: unknown) => app.call("PUT", "/api/budgets", { month: m, category_id: c, amount_cents: a });
  return { key, name, add, summary, budgets, put };
}

describe("G6 edge cases (slice 2)", () => {
  it("uncategorized paycheck in a month with little spending: Spent never negative; categorizing it moves it to Income", async () => {
    const { key, name, add, summary } = await setup();
    add("2026-10-02", -1500, name("Dining"));
    const pay = add("2026-10-15", 240000, key("uncategorized"));
    let s = await summary();
    expect(s).toMatchObject({ income_cents: 0, spent_cents: 1500, net_cents: -1500, income_count: 0, spent_count: 1, uncategorized_count: 1 });
    expect(s.by_category.find((c: any) => c.category_id === key("uncategorized"))).toBeUndefined();
    expect(s.series.at(-1)).toEqual({ month: "2026-10", income_cents: 0, spent_cents: 1500 });
    await app.call("PATCH", `/api/transactions/${pay}`, { category_id: key("income") });
    s = await summary();
    expect(s).toMatchObject({ income_cents: 240000, spent_cents: 1500, net_cents: 238500, income_count: 1, uncategorized_count: 0 });
  });

  it("toggling Transfer's exclusion moves totals and Budgets eligibility; budgets survive (BU-6)", async () => {
    const { key, add, summary, budgets, put } = await setup();
    const tr = key("transfer");
    add("2026-10-03", -50000, tr);
    expect((await summary()).spent_cents).toBe(0);
    await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: false });
    expect((await summary()).spent_cents).toBe(50000);
    expect((await put("2026-10", tr, 60000)).status).toBe(200);
    let b = await budgets();
    expect(b.items.find((i: any) => i.category_id === tr)).toEqual({ category_id: tr, budget_cents: 60000, spent_cents: 50000 });
    expect(b.total_budget_cents).toBe(60000);
    await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: true });
    b = await budgets();
    expect(b.items.find((i: any) => i.category_id === tr)).toBeUndefined();
    expect([b.total_budget_cents, b.spent_cents]).toEqual([0, 0]);
    expect((await summary()).spent_cents).toBe(0);
    await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: false });
    expect((await budgets()).items.find((i: any) => i.category_id === tr).budget_cents).toBe(60000);
  });

  it("refunds larger than spending: budget spent clamps at 0, category omitted from by_category, top-level Spent still reduced", async () => {
    const { name, add, summary, budgets } = await setup();
    const shop = name("Shopping"), gro = name("Groceries");
    add("2026-10-01", -1000, shop); add("2026-10-02", 3000, shop); add("2026-10-03", -5000, gro);
    const s = await summary();
    expect(s.spent_cents).toBe(3000); // G6: 1000 - 3000 + 5000
    expect(s.by_category).toEqual([{ category_id: gro, spent_cents: 5000 }]);
    const b = await budgets();
    expect(b.items.find((i: any) => i.category_id === shop).spent_cents).toBe(0);
    expect(b.spent_cents).toBe(5000);
  });
});

describe("budgets API edge cases (slice 2)", () => {
  it("rejects bad month on GET and non-integer amounts on PUT", async () => {
    const { name, put } = await setup();
    for (const m of ["2026-1", "2026-00", "26-10", "", "2026-10-01"])
      expect((await app.call("GET", `/api/budgets?month=${m}`)).status).toBe(400);
    expect((await app.call("GET", "/api/budgets")).status).toBe(400);
    for (const a of [12.5, "abc", null, "1e3", true]) expect((await put("2026-10", name("Dining"), a)).status).toBe(400);
    expect((await app.call("PUT", "/api/budgets", { month: "2026-10", amount_cents: 100 })).status).toBe(400);
  });

  it("copy into a month with partial budgets overwrites same category, keeps others, skips excluded categories", async () => {
    const { key, name, put, budgets } = await setup();
    const [din, gro, rent, tr] = [name("Dining"), name("Groceries"), name("Rent"), key("transfer")];
    await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: false });
    await put("2026-09", din, 100); await put("2026-09", gro, 200); await put("2026-09", tr, 999);
    await app.call("PATCH", `/api/categories/${tr}`, { excluded_from_totals: true });
    await put("2026-10", din, 5); await put("2026-10", rent, 7000);
    const r = (await app.call("POST", "/api/budgets/copy", { month: "2026-10" })).body;
    expect(r.copied_count).toBe(2);
    const by = Object.fromEntries((await budgets()).items.map((i: any) => [i.category_id, i.budget_cents]));
    expect([by[din], by[gro], by[rent]]).toEqual([100, 200, 7000]);
    expect(app.db.prepare("SELECT amount_cents FROM budgets WHERE month='2026-10' AND category_id=?").get(tr)).toBeUndefined();
  });

  it("copy across the year boundary uses December as the source", async () => {
    const { name, put } = await setup();
    await put("2025-12", name("Dining"), 100);
    const r = (await app.call("POST", "/api/budgets/copy", { month: "2026-01" })).body;
    expect(r.copied_count).toBe(1);
  });

  it("deleting a category removes its budgets in every month", async () => {
    const { put, budgets } = await setup();
    const id = (await app.call("POST", "/api/categories", { name: "Pets" })).body.id as number;
    await put("2026-09", id, 1000); await put("2026-10", id, 2000);
    expect((await budgets()).total_budget_cents).toBe(2000);
    expect((await app.call("DELETE", `/api/categories/${id}`)).status).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) n FROM budgets WHERE category_id = ?").get(id)).toEqual({ n: 0 });
    expect((await budgets()).total_budget_cents).toBe(0);
  });
});
