import { describe, expect, it } from "vitest";
import { axisLabel, axisStep, centsToInput, cleanDollars, dollarsToCents, txQuery } from "./lib";

describe("txQuery", () => {
  it("sends only month with no filters", () => expect(txQuery("2026-10", "", "", "", [1, 2])).toBe("/transactions?month=2026-10"));
  it("omits invalid category and account", () => {
    expect(txQuery("2026-10", "", "abc", "9999", [1, 2])).toBe("/transactions?month=2026-10");
    expect(txQuery("2026-10", "", "1x", "x", [1, 2])).toBe("/transactions?month=2026-10");
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
