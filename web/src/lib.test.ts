import { describe, expect, it } from "vitest";
import { addMonth, axisLabel, axisStep, centsToInput, cleanDollars, dollarsToCents, seriesEnd, stackShares, txQuery } from "./lib";

describe("stackShares", () => {
  const cats = [{ category_id: 1, spent_cents: [300, 0] }, { category_id: 2, spent_cents: [100, -50] }, { category_id: 3, spent_cents: [0, 0] }];
  it("splits a month by share, keeping order and dropping zeros", () =>
    expect(stackShares(cats, 0)).toEqual([{ category_id: 1, pct: 75 }, { category_id: 2, pct: 25 }]));
  it("ignores negative (refund) months and returns [] when nothing is positive", () => expect(stackShares(cats, 1)).toEqual([]));
});

describe("txQuery", () => {
  it("sends only month with no filters", () => expect(txQuery("2026-10", "", "", "", [1, 2])).toBe("/transactions?month=2026-10"));
  it("omits invalid category and account", () => {
    expect(txQuery("2026-10", "", "abc", "9999", [1, 2])).toBe("/transactions?month=2026-10");
    expect(txQuery("2026-10", "", "1x", "x", [1, 2])).toBe("/transactions?month=2026-10");
  });
  it("all-time drops month; day only when well-formed", () => {
    expect(txQuery("2026-10", "x", "", "", [], true)).toBe("/transactions?all=1&q=x");
    expect(txQuery("2026-10", "", "", "", [], false, "2026-10-14")).toBe("/transactions?month=2026-10&day=2026-10-14");
    expect(txQuery("2026-10", "", "", "", [], false, "bad")).toBe("/transactions?month=2026-10");
  });
  it("includes valid filters", () => expect(txQuery("2026-10", "uber", "3", "2", [1, 2])).toBe("/transactions?month=2026-10&q=uber&account=3&category=2"));
});

describe("budget money", () => {
  it("cleans input", () => {
    expect(cleanDollars("abc")).toBe("");
    expect(cleanDollars("1.2.3")).toBe("1.23");
    expect(cleanDollars("12.345")).toBe("12.34");
  });
  it("parses cents with string math", () => {
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("450")).toBe(45000);
    expect(dollarsToCents("19.9")).toBe(1990);
    expect(dollarsToCents("0.07")).toBe(7);
    expect(dollarsToCents(".5")).toBe(50);
  });
  it("formats", () => {
    expect(centsToInput(45050)).toBe("450.50");
    expect(centsToInput(45000)).toBe("450");
    expect(axisLabel(150000)).toBe("$1.5k");
    expect(axisLabel(50000)).toBe("$500");
    expect(axisStep(0)).toBe(50000);
    expect(axisStep(600000)).toBe(150000);
  });
});

describe("seriesEnd", () => {
  it("centers in the middle of the data", () => expect(seriesEnd("2026-07", "2026-01", "2026-10")).toBe("2026-10"));
  it("stops at the current month near the right edge", () => expect(seriesEnd("2026-09", "2026-01", "2026-10")).toBe("2026-10"));
  it("follows next month when selected", () => expect(seriesEnd("2026-11", "2026-01", "2026-10")).toBe("2026-11"));
  it("slides right near the first month", () => expect(seriesEnd("2026-02", "2026-01", "2026-10")).toBe("2026-07"));
  it("caps at current when data spans < 7 months", () => expect(seriesEnd("2026-06", "2026-05", "2026-10")).toBe("2026-10"));
  it("crosses a year boundary", () => expect(seriesEnd("2026-11", "2025-01", "2027-03")).toBe("2027-02"));
});

describe("seriesEnd invariants (every selectable month)", () => {
  it("always yields a window the API accepts, never past max(current, selected), matching the decisions-log formula", () => {
    const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
    for (const current of ["2026-10", "2027-01", "2026-12"])
      for (let back = 0; back <= 30; back++) {
        const earliest = addMonth(current, -back);
        for (let sel = earliest; sel <= addMonth(current, 1); sel = addMonth(sel, 1)) {
          const e = idx(seriesEnd(sel, earliest, current));
          const s = idx(sel), c = idx(current), first = idx(earliest);
          expect(e).toBe(Math.min(Math.max(s + 3, first + 6), Math.max(c, s)));
          expect(e >= s && e <= s + 6).toBe(true); // server: month <= series_end <= month+6
          expect(e).toBeLessThanOrEqual(Math.max(c, s));
          if (back >= 6 && sel <= current) expect(e - 6).toBeGreaterThanOrEqual(first); // >= 7 months of range: no inert leading bars
        }
      }
  });
});
