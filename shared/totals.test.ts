import { describe, expect, it } from "vitest";
import { computeTotals, dailyRunningNet, isCounted } from "./totals";

const cats = [
  { id: 1, excluded_from_totals: false, system_key: "income" },
  { id: 2, excluded_from_totals: false, system_key: null },
  { id: 3, excluded_from_totals: true, system_key: "transfer" },
  { id: 4, excluded_from_totals: false, system_key: "uncategorized" },
] as Parameters<typeof dailyRunningNet>[1];
const tx = (day: number, amount_cents: number, category_id: number) => ({ date: `2026-10-${String(day).padStart(2, "0")}`, amount_cents, category_id });

describe("dailyRunningNet", () => {
  const txs = [tx(2, 100000, 1), tx(2, -2550, 2), tx(4, -50000, 3), tx(4, 9900, 4), tx(4, -1000, 4), tx(6, 5, 99)];
  const r = dailyRunningNet(txs, cats, 31);
  it("excludes transfers, positive uncategorized and unknown categories", () => {
    expect(r[3]).toBe(100000 - 2550 - 1000); // day 4: only the uncategorized spend counts
  });
  it("carries the previous value through empty days", () => {
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(r[1]);
    expect(r[30]).toBe(r[3]);
  });
  it("last value equals computeTotals net", () => {
    expect(r[30]).toBe(computeTotals(txs, cats).net_cents);
  });
});

describe("dailyRunningNet edges", () => {
  const feb = (day: number, amt: number, cat: number) => ({ date: `2028-02-${String(day).padStart(2, "0")}`, amount_cents: amt, category_id: cat });
  it("empty month is all zeros of the right length (28/29/30/31)", () => {
    for (const n of [28, 29, 30, 31]) expect(dailyRunningNet([], cats, n)).toEqual(new Array(n).fill(0));
  });
  it("leap-day Feb 29 lands on the last index; out-of-range days are ignored", () => {
    const r = dailyRunningNet([feb(29, -700, 2), feb(30, -999, 2)], cats, 29);
    expect(r).toHaveLength(29);
    expect(r[27]).toBe(0);
    expect(r[28]).toBe(-700);
  });
  it("non-leap 28 days ignores day 29", () => {
    expect(dailyRunningNet([feb(29, -700, 2)], cats, 28).every((v) => v === 0)).toBe(true);
  });
  it("single transaction on day 1 carries to the end; all-zero stays 0 (no NaN)", () => {
    expect(dailyRunningNet([tx(1, -123, 2)], cats, 30).every((v) => v === -123)).toBe(true);
    const z = dailyRunningNet([tx(3, 0, 2), tx(3, 500, 3)], cats, 31);
    expect(z.every((v) => v === 0 && Number.isInteger(v))).toBe(true);
  });
  it("uncounted-only day keeps the previous running value; order of input does not matter", () => {
    const r = dailyRunningNet([tx(9, -4000, 3), tx(5, -100, 2), tx(2, 300, 1)], cats, 31);
    expect(r[8]).toBe(200);
    expect(r[30]).toBe(200);
  });
});

describe("isCounted", () => {
  it("matches G6", () => {
    expect(isCounted({ amount_cents: -5, category_id: 2 }, cats)).toBe(true);
    expect(isCounted({ amount_cents: -5, category_id: 3 }, cats)).toBe(false);
    expect(isCounted({ amount_cents: 5, category_id: 4 }, cats)).toBe(false);
    expect(isCounted({ amount_cents: -5, category_id: 4 }, cats)).toBe(true);
    expect(isCounted({ amount_cents: 5, category_id: 99 }, cats)).toBe(false);
  });
});
