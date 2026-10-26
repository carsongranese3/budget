import { describe, expect, it } from "vitest";
import { txQuery } from "./lib";

describe("txQuery", () => {
  it("sends only month with no filters", () => expect(txQuery("2026-10", "", "", "", [1, 2])).toBe("/transactions?month=2026-10"));
  it("omits invalid category and account", () => {
    expect(txQuery("2026-10", "", "abc", "9999", [1, 2])).toBe("/transactions?month=2026-10");
    expect(txQuery("2026-10", "", "1x", "x", [1, 2])).toBe("/transactions?month=2026-10");
  });
  it("includes valid filters", () => expect(txQuery("2026-10", "uber", "3", "2", [1, 2])).toBe("/transactions?month=2026-10&q=uber&account=3&category=2"));
});
