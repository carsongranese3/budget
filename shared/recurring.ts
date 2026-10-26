// Spec §6: recurring occurrences, received matching, status, expected, upcoming. Pure; "today" is always a parameter.
import type { Occurrence, RecurringItem, RecurringStatus } from "./types.js";

export type RecItem = Pick<RecurringItem, "frequency" | "anchor_date" | "match_text" | "amount_cents">;
export type RecTx = { date: string; description: string; amount_cents: number };
type Full = RecItem & Pick<RecurringItem, "id" | "name" | "category_id" | "account_id" | "active">;

const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
const dn = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
export const addDays = (s: string, n: number) => new Date((dn(s) + n) * DAY).toISOString().slice(0, 10);
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthEnd = (m: string) => ymd(+m.slice(0, 4), +m.slice(5), dim(+m.slice(0, 4), +m.slice(5)));

/** Occurrence dates >= max(from, anchor), ascending, unbounded. */
function* iter(it: RecItem, from: string): Generator<string> {
  const a = it.anchor_date;
  const start = from > a ? from : a;
  if (it.frequency === "biweekly") {
    for (let k = Math.max(0, Math.ceil((dn(start) - dn(a)) / 14)); ; k++) yield addDays(a, 14 * k);
  }
  const [ay, am, ad] = [+a.slice(0, 4), +a.slice(5, 7), +a.slice(8, 10)];
  const yearly = it.frequency === "yearly";
  let y = +start.slice(0, 4), m = yearly ? am : +start.slice(5, 7);
  for (;;) {
    const d = ymd(y, m, Math.min(ad, dim(y, m)));
    if (d >= start) yield d; // d < start only for the first month/year
    if (yearly) y++; else if (m === 12) { y++; m = 1; } else m++;
  }
}

/** Occurrences in [from, to] inclusive; none before the anchor (RC-8). */
export function occurrences(it: RecItem, from: string, to: string): string[] {
  const out: string[] = [];
  if (from > to) return out;
  for (const d of iter(it, from)) { if (d > to) break; out.push(d); }
  return out;
}

/** §6.2: any account; text, same sign, within 4 days. */
export function isReceived(it: RecItem, date: string, txs: RecTx[]): boolean {
  const n = dn(date), sign = Math.sign(it.amount_cents);
  return txs.some((t) => Math.sign(t.amount_cents) === sign && Math.abs(dn(t.date) - n) <= 4
    && t.description.toUpperCase().includes(it.match_text));
}

/** §6.3 */
export function statusOf(it: RecItem & { active: boolean }, txs: RecTx[], today: string): RecurringStatus {
  if (!it.active) return { kind: "paused", date: null };
  const last = occurrences(it, addDays(today, -45), today).pop();
  if (!last) return { kind: "none", date: null };
  return { kind: isReceived(it, last, txs) ? "received" : "expected", date: last };
}

/** First occurrence strictly after today; a future anchor is its own first occurrence. */
export function nextDate(it: RecItem, today: string): string {
  if (it.anchor_date > today) return it.anchor_date;
  return iter(it, addDays(today, 1)).next().value as string;
}

const occ = (it: Full, date: string): Occurrence => ({
  recurring_id: it.id, name: it.name, amount_cents: it.amount_cents,
  category_id: it.category_id, account_id: it.account_id, date,
});
const byDateName = (a: Occurrence, b: Occurrence) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name) || a.recurring_id - b.recurring_id);

/** §6.4: unreceived occurrences in [month start, min(month end, today)]. */
export function expectedFor(items: Full[], txs: RecTx[], month: string, today: string): Occurrence[] {
  const to = monthEnd(month) < today ? monthEnd(month) : today;
  return items.filter((i) => i.active)
    .flatMap((i) => occurrences(i, `${month}-01`, to).filter((d) => !isReceived(i, d, txs)).map((d) => occ(i, d)))
    .sort(byDateName);
}

/** §6.5: next `limit` occurrences strictly after today across active items. */
export function upcoming(items: Full[], today: string, limit = 10): Occurrence[] {
  const from = addDays(today, 1);
  return items.filter((i) => i.active).flatMap((i) => {
    const out: Occurrence[] = [];
    for (const d of iter(i, from)) { out.push(occ(i, d)); if (out.length === limit) break; }
    return out;
  }).sort(byDateName).slice(0, limit);
}

const lowerBound = (a: string[], x: string) => { let l = 0, h = a.length; while (l < h) { const m = (l + h) >> 1; if (a[m] < x) l = m + 1; else h = m; } return l; };

/** IM-20: occurrences received with `fresh` but not with `before` alone. */
export function newlyReceived(items: Full[], before: RecTx[], fresh: RecTx[]): { recurring_id: number; name: string; date: string }[] {
  if (!fresh.length) return [];
  const ds = fresh.map((t) => t.date).sort();
  const lo = addDays(ds[0], -4), hi = addDays(ds[ds.length - 1], 4);
  const idx = (a: RecTx[]) => { const t = [...a].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)); return { t, k: t.map((x) => x.date) }; };
  const win = ({ t, k }: ReturnType<typeof idx>, d: string) => { const i = lowerBound(k, addDays(d, -4)), h = addDays(d, 4); let j = i; while (j < t.length && k[j] <= h) j++; return t.slice(i, j); };
  const B = idx(before), A = idx([...before, ...fresh]);
  // Only occurrences within 4 days of a fresh row can newly match; skip the rest of a wide span.
  const near = (d: string) => { const k = lowerBound(ds, addDays(d, -4)); return k < ds.length && ds[k] <= addDays(d, 4); };
  return items.filter((i) => i.active).flatMap((i) =>
    occurrences(i, lo, hi).filter(near).filter((d) => isReceived(i, d, win(A, d)) && !isReceived(i, d, win(B, d)))
      .map((d) => ({ recurring_id: i.id, name: i.name, date: d })))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
}

/** Real calendar date YYYY-MM-DD, years 1900-2099. */
export function isValidDate(s: unknown): s is string {
  return typeof s === "string" && /^(19|20)\d{2}-\d{2}-\d{2}$/.test(s)
    && +s.slice(5, 7) >= 1 && +s.slice(5, 7) <= 12 && +s.slice(8) >= 1 && +s.slice(8) <= dim(+s.slice(0, 4), +s.slice(5, 7));
}
