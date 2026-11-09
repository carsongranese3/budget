// Spec G6. One function for every total in the app.
import type { Category } from "./types.js";

export type TotalsCategory = Pick<Category, "id" | "excluded_from_totals" | "system_key">;
export interface TotalsResult {
  income_cents: number; spent_cents: number; net_cents: number;
  income_count: number; spent_count: number;
}

export function computeTotals(
  txs: { amount_cents: number; category_id: number }[],
  categories: TotalsCategory[],
): TotalsResult {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let income = 0, other = 0, incomeCount = 0, spentCount = 0;
  for (const t of txs) {
    const c = byId.get(t.category_id);
    if (!c || c.excluded_from_totals) continue;
    if (c.system_key === "uncategorized" && t.amount_cents > 0) continue; // G6: uncategorized deposits wait for a category
    if (c.system_key === "income") { income += t.amount_cents; incomeCount++; }
    else { other += t.amount_cents; spentCount++; }
  }
  return {
    income_cents: income, spent_cents: -other, net_cents: income + other,
    income_count: incomeCount, spent_count: spentCount,
  };
}

/** Per-category spending (G6): counted, non-Income categories only; may be negative (refunds) — callers clamp. */
export function spendByCategory(
  txs: { amount_cents: number; category_id: number }[],
  categories: TotalsCategory[],
): Map<number, number> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map<number, number>();
  for (const t of txs) {
    const c = byId.get(t.category_id);
    if (!c || c.excluded_from_totals || c.system_key === "income") continue;
    if (c.system_key === "uncategorized" && t.amount_cents > 0) continue;
    out.set(c.id, (out.get(c.id) ?? 0) - t.amount_cents);
  }
  return out;
}

/** Same G6 counting rule as computeTotals, for a single transaction. */
export function isCounted(t: { amount_cents: number; category_id: number }, categories: TotalsCategory[]): boolean {
  const c = categories.find((x) => x.id === t.category_id);
  return !!c && !c.excluded_from_totals && !(c.system_key === "uncategorized" && t.amount_cents > 0);
}

/** Running cumulative net at the end of each day: result[0] = day 1 … result[n-1] = last day. Integer cents. */
export function dailyRunningNet(
  txs: { date: string; amount_cents: number; category_id: number }[],
  categories: TotalsCategory[],
  daysInMonth: number,
): number[] {
  const delta = new Array<number>(daysInMonth).fill(0);
  for (const t of txs) {
    const d = Number(t.date.slice(8, 10));
    if (d >= 1 && d <= daysInMonth && isCounted(t, categories)) delta[d - 1] += t.amount_cents;
  }
  let run = 0;
  return delta.map((x) => (run += x));
}
