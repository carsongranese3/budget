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
    if (c.system_key === "income") { income += t.amount_cents; incomeCount++; }
    else { other += t.amount_cents; spentCount++; }
  }
  return {
    income_cents: income, spent_cents: -other, net_cents: income + other,
    income_count: incomeCount, spent_count: spentCount,
  };
}
