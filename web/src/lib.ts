/** Cents -> "$1,234.56" (integer math only). Negative gets a real minus sign. */
export function money(cents: number, opts: { sign?: boolean } = {}): string {
  const a = Math.abs(cents);
  const s = `$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
  if (cents < 0) return "−" + s;
  return opts.sign && cents > 0 ? "+" + s : s;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1];
export const monthLabel = (m: string) => `${monthName(m)} ${m.slice(0, 4)}`;
export function addMonth(m: string, d: number): string {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + d;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** Last month of the 7-month dashboard chart window (see docs/decisions.md). */
export const seriesEnd = (selected: string, earliest: string, current: string) => {
  const a = addMonth(selected, 3) > addMonth(earliest, 6) ? addMonth(selected, 3) : addMonth(earliest, 6);
  const b = current > selected ? current : selected;
  return a < b ? a : b;
};
/** "2026-10-11" -> "Oct 11" (or "Oct 11, 2026" with year) */
export function fmtDate(d: string | null | undefined, year = false): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return "—";
  const s = `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  return year ? `${s}, ${d.slice(0, 4)}` : s;
}

/** fmtDate that adds the year when it isn't the current year. */
export const fmtDateY = (d: string | null | undefined) => fmtDate(d, !!d && d.slice(0, 4) !== String(new Date().getFullYear()));

export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// Theme: localStorage may be unavailable (private mode / blocked) -> fall back silently.
export type Theme = "light" | "dark";
export function initialTheme(): Theme {
  try {
    const t = localStorage.getItem("budget.theme");
    if (t === "light" || t === "dark") return t;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
// Per-browser preference: stack the spending bars (Dashboard + Trends) in category colors.
export function colorBarsPref(): boolean {
  try {
    return localStorage.getItem("budget.colorBars") === "1";
  } catch {
    return false;
  }
}
export function setColorBarsPref(on: boolean) {
  try {
    localStorage.setItem("budget.colorBars", on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Each category's share (%) of month `i`'s positive spending, in the given order; [] when there's nothing to stack. */
export function stackShares(cats: { category_id: number; spent_cents: number[] }[], i: number): { category_id: number; pct: number }[] {
  const vals = cats.map((c) => ({ category_id: c.category_id, v: Math.max(0, c.spent_cents[i] ?? 0) })).filter((c) => c.v > 0);
  const sum = vals.reduce((a, c) => a + c.v, 0);
  return sum ? vals.map((c) => ({ category_id: c.category_id, pct: (c.v / sum) * 100 })) : [];
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("budget.theme", t);
  } catch {
    /* ignore */
  }
}

export const SWATCHES: [string, string][] = [
  ["Teal", "oklch(0.6 0.09 190)"], ["Amber", "oklch(0.67 0.12 55)"], ["Slate", "oklch(0.55 0.07 255)"],
  ["Sky", "oklch(0.66 0.09 225)"], ["Iris", "oklch(0.6 0.1 290)"], ["Orchid", "oklch(0.63 0.11 335)"],
  ["Ochre", "oklch(0.72 0.11 88)"], ["Rose", "oklch(0.63 0.13 15)"], ["Green", "oklch(0.58 0.12 150)"],
  ["Stone", "oklch(0.68 0.01 250)"], ["Sand", "oklch(0.76 0.04 80)"],
];

/** ISO datetime -> local YYYY-MM-DD */
export function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Query string for GET /transactions; empty or invalid filters are omitted (treated as All). */
export function txQuery(month: string, q: string, account: string, category: string, validCategoryIds: number[], all = false, day = ""): string {
  const u = new URLSearchParams(all ? { all: "1" } : { month });
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) u.set("day", day);
  if (q) u.set("q", q);
  if (/^\d+$/.test(account)) u.set("account", account);
  if (/^\d+$/.test(category) && validCategoryIds.includes(Number(category))) u.set("category", category);
  return `/transactions?${u}`;
}

/** Budget input text -> sanitized text: digits and one ".", max 2 decimals. */
export function cleanDollars(s: string): string {
  const t = s.replace(/[^\d.]/g, "");
  const i = t.indexOf(".");
  return i < 0 ? t : t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, "").slice(0, 2);
}
/** Sanitized dollars text -> integer cents via string math (no floats). Empty -> 0. */
export function dollarsToCents(s: string): number {
  const [w = "", f = ""] = s.split(".");
  return Number(w || "0") * 100 + Number(f.padEnd(2, "0") || "0");
}
/** Cents -> input text: 45000 -> "450", 45050 -> "450.50", 0 -> "". */
export function centsToInput(c: number): string {
  if (!c) return "";
  const w = Math.floor(c / 100), f = c % 100;
  return f ? `${w}.${String(f).padStart(2, "0")}` : String(w);
}
/** Chart axis label: 150000 -> "$1.5k", 50000 -> "$500", 0 -> "$0". */
export function axisLabel(cents: number): string {
  const d = cents / 100;
  return d >= 1000 ? `$${+(d / 1000).toFixed(1)}k` : `$${d}`;
}
/** y-axis step in cents (DB-5): max($500, ceil(max/4/$500) x $500). */
export function axisStep(maxCents: number): number {
  return Math.max(50000, Math.ceil(maxCents / 4 / 50000) * 50000);
}

/** True when a global shortcut key should be ignored: modifiers, typing in a field, an open dialog or menu. */
export function shortcutBlocked(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("input:not([type=checkbox]), textarea, select, [contenteditable]:not([contenteditable=false])")) return true;
  return !!document.querySelector("dialog[open], [role=menu]");
}
