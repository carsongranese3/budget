import { describe, expect, it } from "vitest";
import { detectRecurring, expectedFor, isReceived, newlyReceived, nextDate, occurrences, statusOf, upcoming } from "./recurring.js";

const mk = (o: any = {}) => ({ id: 1, name: "Rent", amount_cents: -100000, category_id: 1, account_id: null, frequency: "monthly" as const,
  anchor_date: "2026-01-31", match_text: "RENT", active: true, ...o });
const tx = (date: string, description = "rent co", amount_cents = -100000) => ({ date, description, amount_cents });

describe("occurrences", () => {
  it("monthly starts at the anchor, clamps month end without drifting", () => {
    expect(occurrences(mk(), "2025-01-01", "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(occurrences(mk({ anchor_date: "2028-01-31" }), "2028-02-01", "2028-03-01")).toEqual(["2028-02-29"]);
  });
  it("respects from/to inclusive", () => {
    expect(occurrences(mk({ anchor_date: "2026-03-03" }), "2026-04-03", "2026-05-03")).toEqual(["2026-04-03", "2026-05-03"]);
    expect(occurrences(mk(), "2026-03-01", "2026-02-01")).toEqual([]);
  });
  it("biweekly every 14 days from anchor, none before", () => {
    const item = mk({ frequency: "biweekly", anchor_date: "2026-10-02" });
    expect(occurrences(item, "2026-09-01", "2026-11-01")).toEqual(["2026-10-02", "2026-10-16", "2026-10-30"]);
    expect(occurrences(item, "2026-10-03", "2026-10-30")).toEqual(["2026-10-16", "2026-10-30"]);
  });
  it("yearly, Feb 29 clamps in non-leap years", () => {
    const item = mk({ frequency: "yearly", anchor_date: "2024-02-29" });
    expect(occurrences(item, "2024-01-01", "2029-12-31")).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29", "2029-02-28"]);
  });
});

describe("received", () => {
  const rent = mk();
  it("matches +-4 days inclusive", () => {
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-14")])).toBe(true);
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-06")])).toBe(true);
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-15")])).toBe(false);
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-05")])).toBe(false);
  });
  it("needs same sign and text (case-insensitive)", () => {
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-10", "RENT", 100000)])).toBe(false);
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-10", "Monthly Rent Payment")])).toBe(true);
    expect(isReceived(rent, "2026-10-10", [tx("2026-10-10", "mortgage")])).toBe(false);
  });
});

describe("status / next date", () => {
  const today = "2026-10-25";
  it("paused, none (anchor future or >45 days ago), expected, received", () => {
    expect(statusOf(mk({ active: false }), [], today)).toEqual({ kind: "paused", date: null });
    expect(statusOf(mk({ anchor_date: "2026-11-03" }), [], today)).toEqual({ kind: "none", date: null });
    expect(statusOf(mk({ anchor_date: "2026-01-01", frequency: "yearly" }), [], today)).toEqual({ kind: "none", date: null });
    expect(statusOf(mk({ anchor_date: "2026-01-22" }), [], today)).toEqual({ kind: "expected", date: "2026-10-22" });
    expect(statusOf(mk({ anchor_date: "2026-01-22" }), [tx("2026-10-23")], today)).toEqual({ kind: "received", date: "2026-10-22" });
  });
  it("today counts as last; next is strictly after today", () => {
    const m = mk({ anchor_date: "2026-01-25" });
    expect(statusOf(m, [], today).date).toBe("2026-10-25");
    expect(nextDate(m, today)).toBe("2026-11-25");
    expect(nextDate(mk({ anchor_date: "2026-11-03" }), today)).toBe("2026-11-03");
    expect(nextDate(mk({ anchor_date: "2020-02-29", frequency: "yearly" }), today)).toBe("2027-02-28");
  });
});

describe("expected / upcoming / newlyReceived", () => {
  const today = "2026-10-25";
  const a = mk({ id: 1, name: "Rent", anchor_date: "2026-08-01" });
  const b = mk({ id: 2, name: "Pay", amount_cents: 50000, match_text: "PAY", frequency: "biweekly", anchor_date: "2026-10-02" });
  it("expected only up to today, unreceived, empty in future months", () => {
    const e = expectedFor([a, b], [tx("2026-10-01")], "2026-10", today);
    expect(e.map((o) => [o.name, o.date])).toEqual([["Pay", "2026-10-02"], ["Pay", "2026-10-16"]]);
    expect(expectedFor([a, b], [], "2026-11", today)).toEqual([]);
    expect(expectedFor([a, mk({ id: 3, active: false })], [], "2026-10", today).map((o) => o.date)).toEqual(["2026-10-01"]);
    expect(expectedFor([mk({ anchor_date: "2026-11-03" })], [], "2026-10", today)).toEqual([]);
  });
  it("upcoming: date then name, limit 10, skips inactive", () => {
    const c = mk({ id: 3, name: "Abc", anchor_date: "2026-11-01" });
    const u = upcoming([a, b, c, mk({ id: 4, active: false, anchor_date: "2026-10-26" })], today);
    expect(u).toHaveLength(10);
    expect(u.slice(0, 3).map((o) => [o.date, o.name])).toEqual([["2026-10-30", "Pay"], ["2026-11-01", "Abc"], ["2026-11-01", "Rent"]]);
    expect(u.map((o) => o.date)).toEqual([...u.map((o) => o.date)].sort());
  });
  it("newlyReceived reports only occurrences newly matched", () => {
    const before = [tx("2026-10-01")];
    expect(newlyReceived([a], before, [tx("2026-10-02")])).toEqual([]);
    expect(newlyReceived([a], [], [tx("2026-10-02")])).toEqual([{ recurring_id: 1, name: "Rent", date: "2026-10-01" }]);
    expect(newlyReceived([a], [], [tx("2026-10-15")])).toEqual([]);
  });
});

import { newlyReceived as nr } from "./recurring.js";
import { parseDate as pd } from "./csv.js";
describe("slice3 gate fixes", () => {
  const item = { id: 1, name: "Rent", category_id: 1, account_id: null, active: true, frequency: "monthly" as const, anchor_date: "1900-01-01", match_text: "RENT", amount_cents: -100 };
  it("newlyReceived stays fast and correct over 1900..2099", () => {
    const t0 = Date.now();
    const r = nr([item], [], [{ date: "1900-01-01", description: "RENT", amount_cents: -100 }, { date: "2099-12-31", description: "RENT", amount_cents: -100 }]);
    expect(r.map((x) => x.date)).toEqual(["1900-01-01", "2100-01-01"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("parseDate bounds years to 1900-2099", () => {
    expect(pd("1899-12-31")).toBeNull();
    expect(pd("2100-01-01")).toBeNull();
    expect(pd("1900-01-01")).toBe("1900-01-01");
  });
});

describe("detectRecurring", () => {
  const t = (date: string, description: string, amount_cents: number, category_id = 6, account_id = 1) => ({ date, description, amount_cents, category_id, account_id });
  const netflix = ["2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03"].map((d) => t(d, `NETFLIX.COM ${d.slice(5, 7)}`, -1599));

  it("finds a monthly series with next date after the last hit", () => {
    expect(detectRecurring(netflix, [])).toEqual([{
      merchant: "NETFLIX.COM", name: "Netflix.Com", amount_cents: -1599, frequency: "monthly", category_id: 6, account_id: 1,
      last_date: "2026-10-03", next_date: "2026-11-03", occurrences: 5,
    }]);
  });
  it("finds biweekly pay and ignores amount outliers", () => {
    const pay = ["2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16"].map((d) => t(d, "ACME PAYROLL", 200000, 9));
    const r = detectRecurring([...pay, t("2026-10-09", "ACME PAYROLL", 50000, 9)], []);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ frequency: "biweekly", occurrences: 4, next_date: "2026-10-30" });
  });
  it("needs 3 hits, a cadence, and one sign", () => {
    expect(detectRecurring(netflix.slice(0, 2), [])).toEqual([]);
    expect(detectRecurring(["2026-01-01", "2026-01-09", "2026-02-20", "2026-05-02"].map((d) => t(d, "RANDOM CAFE", -500)), [])).toEqual([]);
    expect(detectRecurring(netflix.map((x, i) => (i % 2 ? { ...x, amount_cents: 1599 } : x)), [])).toEqual([]);
  });
  it("skips merchants already covered by a recurring item", () => {
    expect(detectRecurring(netflix, ["NETFLIX.COM"])).toEqual([]);
  });
});
