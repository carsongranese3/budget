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
/** "2026-10-11" -> "Oct 11" (or "Oct 11, 2026" with year) */
export function fmtDate(d: string, year = false): string {
  const s = `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  return year ? `${s}, ${d.slice(0, 4)}` : s;
}

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
export function txQuery(month: string, q: string, account: string, category: string, validCategoryIds: number[]): string {
  const u = new URLSearchParams({ month });
  if (q) u.set("q", q);
  if (/^\d+$/.test(account)) u.set("account", account);
  if (/^\d+$/.test(category) && validCategoryIds.includes(Number(category))) u.set("category", category);
  return `/transactions?${u}`;
}
