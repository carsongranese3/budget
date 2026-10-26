import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectFormat, parseAmount, parseCsvText, parseDate, parseRows } from "./csv.js";
import { merchantKey } from "./merchant.js";
import { computeTotals } from "./totals.js";
import type { CsvFormat } from "./types.js";

const fx = (n: string) => readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url), "utf8");
const fmt = (over: Partial<CsvFormat> = {}): CsvFormat => ({
  header_signature: "date|description|amount", column_roles: ["date", "description", "amount"],
  sign_mode: "purchases_negative", date_format: "MDY", has_header: true, ...over,
});

describe("parseCsvText", () => {
  it("handles BOM, CRLF/LF/CR, quotes, embedded commas/newlines, blank rows", () => {
    const t = '﻿a,b\r\n"x, y","say ""hi"""\n\n"multi\nline",z\r  ,  \r1,2';
    expect(parseCsvText(t)).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["multi\nline", "z"], ["1", "2"]]);
  });
  it("trims unquoted fields only", () => {
    expect(parseCsvText(' a ," b " ')).toEqual([["a", " b "]]);
  });
});

describe("parseAmount", () => {
  it.each([
    ["$1,234.56", 123456], ["(12.00)", -1200], ["-$12.00", -1200], ["$-12.00", -1200], ["+12", 1200],
    ["12.5", 1250], ["12", 1200], ["-0.07", -7], [".5", 50],
  ])("%s", (s, c) => expect(parseAmount(s)).toBe(c));
  it.each(["", "abc", "12.345", "1.2.3", "10/11/2026", "(-5)", "$"])("rejects %j", (s) => expect(parseAmount(s)).toBeNull());
});

describe("parseDate", () => {
  it.each([["10/5/2026", "2026-10-05"], ["10/05/26", "2026-10-05"], ["2026-10-05", "2026-10-05"], ["2026/10/5", "2026-10-05"]])(
    "%s", (s, d) => expect(parseDate(s)).toBe(d));
  it.each(["02/30/2026", "13/01/2026", "2026-02-29", "yesterday", "10/5"])("rejects %s", (s) => expect(parseDate(s)).toBeNull());
});

describe("detectFormat / parseRows", () => {
  it("Chase fixture: header, roles, sign, unreadable none", () => {
    const rec = parseCsvText(fx("chase-checking.csv"));
    const f = detectFormat(rec);
    expect(f.header_signature).toBe("details|posting date|description|amount|type|balance|check or slip #");
    expect(f.column_roles).toEqual(["ignore", "date", "description", "amount", "ignore", "ignore", "ignore", "ignore"]);
    expect(f.sign_mode).toBe("purchases_negative");
    expect(f.date_format).toBe("MDY");
    const { rows, unreadable } = parseRows(rec, f);
    expect(unreadable).toEqual([]);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ line: 2, date: "2026-10-21", description: "TRADER JOE'S #552 SAN FRANCISCO", amount_cents: -6418 });
    expect(rows[3].description).toBe("TST* HOLY GELATO, INC");
    expect(rows[4].description).toBe("COMCAST XFINITY");
  });
  it("Amex fixture: purchases positive become spending", () => {
    const rec = parseCsvText(fx("amex-card.csv"));
    const f = detectFormat(rec);
    expect(f.sign_mode).toBe("purchases_positive");
    const { rows } = parseRows(rec, f);
    expect(rows[0].amount_cents).toBe(-1549);
    expect(rows.find((r) => r.description.startsWith("AUTOPAY"))!.amount_cents).toBe(90000);
  });
  it("skips preamble, reports trailer 'Total' row as unreadable with file line", () => {
    const rec = parseCsvText("Account Summary\nPrepared for,Me\n\nDate,Description,Amount\n10/1/2026,A,-5.00\n10/2/2026,B,-6.00\nTotal,,-11.00\n");
    const f = detectFormat(rec);
    expect(f.has_header).toBe(true);
    const { rows, unreadable } = parseRows(rec, f);
    expect(rows.map((r) => r.line)).toEqual([5, 6]);
    expect(unreadable).toEqual([{ line: 7, raw: "Total,,-11.00" }]);
  });
  it("headerless file", () => {
    const rec = parseCsvText("10/1/2026,COFFEE,-4.50\n10/2/2026,LUNCH,-9.00\n");
    const f = detectFormat(rec);
    expect(f.has_header).toBe(false);
    expect(f.header_signature).toBe("#columns=3");
    expect(f.column_roles).toEqual(["date", "description", "amount"]);
    expect(parseRows(rec, f).rows).toHaveLength(2);
  });
  it("debit/credit mode", () => {
    const rec = parseCsvText("Date,Memo,Debit,Credit\n10/1/2026,RENT,1650.00,\n10/2/2026,PAY,,2400.00\n10/3/2026,BAD,,\n");
    const f = detectFormat(rec);
    expect(f.sign_mode).toBe("debit_credit");
    expect(f.column_roles).toEqual(["date", "description", "debit", "credit"]);
    const { rows, unreadable } = parseRows(rec, f);
    expect(rows.map((r) => r.amount_cents)).toEqual([-165000, 240000]);
    expect(unreadable).toHaveLength(1);
  });
  it("empty description and bad date are unreadable; YMD detected", () => {
    const rec = parseCsvText("Date,Description,Amount\n2026-10-01,,-5\n2026-13-01,X,-5\n2026-10-03,OK,-5");
    const f = detectFormat(rec);
    expect(f.date_format).toBe("YMD");
    const { rows, unreadable } = parseRows(rec, f);
    expect(rows).toHaveLength(1);
    expect(unreadable).toHaveLength(2);
  });
  it("explicit format overrides sign", () => {
    const rec = parseCsvText("Date,Description,Amount\n10/1/2026,A,5.00\n");
    expect(parseRows(rec, fmt({ sign_mode: "purchases_positive" })).rows[0].amount_cents).toBe(-500);
  });
});

describe("merchantKey", () => {
  it.each([
    ["Trader Joe's #552 San Francisco", "TRADER JOE'S"],
    ["AMZN Mktp US*MK1A2", "AMZN MKTP US"],
    ["CHIPOTLE 2291", "CHIPOTLE"],
    ["SHELL OIL 5744123", "SHELL OIL"],
    ["#123", ""],
    ["netflix.com", "NETFLIX.COM"],
  ])("%s", (d, k) => expect(merchantKey(d)).toBe(k));
});

describe("computeTotals (G6)", () => {
  const cats = [
    { id: 1, excluded_from_totals: false, system_key: "income" as const },
    { id: 2, excluded_from_totals: false, system_key: null },
    { id: 3, excluded_from_totals: true, system_key: "transfer" as const },
  ];
  it("excludes Transfer, refunds reduce Spent", () => {
    const t = computeTotals([
      { amount_cents: 240000, category_id: 1 }, { amount_cents: -5000, category_id: 2 },
      { amount_cents: 1000, category_id: 2 }, { amount_cents: -90000, category_id: 3 },
    ], cats);
    expect(t).toEqual({ income_cents: 240000, spent_cents: 4000, net_cents: 236000, income_count: 1, spent_count: 2 });
  });
});
