import { addDays, expectedFor, isValidDate, monthEnd, nextDate, statusOf, upcoming } from "../shared/recurring.js";
import type { RecurringItem, RecurringListItem, UpcomingResponse } from "../shared/types.js";
import type { DB } from "./db.js";
import { bad, int, label, obj, oneOf, str } from "./http.js";

const MAX_CENTS = 10_000_000_000; // same cap as budgets

export const recurringItems = (db: DB): RecurringItem[] =>
  (db.prepare("SELECT * FROM recurring_items ORDER BY id").all() as any[]).map((r) => ({ ...r, active: !!r.active }));

export const txsBetween = (db: DB, lo: string, hi: string) =>
  db.prepare("SELECT date, description, amount_cents FROM transactions WHERE date BETWEEN ? AND ?").all(lo, hi) as
    { date: string; description: string; amount_cents: number }[];

export function listRecurring(db: DB, today: string): RecurringListItem[] {
  const txs = txsBetween(db, addDays(today, -50), today); // 45-day lookback + 4-day match window
  return recurringItems(db).map((i) => ({ ...i, next_date: nextDate(i, today), status: statusOf(i, txs, today) }));
}

export function upcomingFor(db: DB, month: string, today: string): UpcomingResponse {
  const items = recurringItems(db);
  const to = monthEnd(month) < today ? monthEnd(month) : today;
  const txs = txsBetween(db, addDays(`${month}-01`, -4), addDays(to, 4));
  return { expected: expectedFor(items, txs, month, today), upcoming: upcoming(items, today) };
}

/** §6.4 totals for the summary: expected income / spending, never added to real totals. */
export function expectedTotals(db: DB, month: string, today: string) {
  const { expected } = upcomingFor(db, month, today);
  return {
    expected_income_cents: expected.filter((o) => o.amount_cents > 0).reduce((s, o) => s + o.amount_cents, 0),
    expected_spent_cents: expected.filter((o) => o.amount_cents < 0).reduce((s, o) => s - o.amount_cents, 0),
  };
}

/** Validates the POST fields (all required except active) or any subset when `partial`. */
export function parseRecurring(db: DB, body: unknown, partial: boolean, current?: RecurringItem) {
  const b = obj(body);
  const has = (k: string) => b[k] !== undefined;
  const need = (k: string) => { if (!partial && !has(k)) throw bad(`${label(k)} is required.`); return has(k); };
  const out: Partial<RecurringItem> = {};
  if (need("name")) out.name = str(b.name, "a name", 1, 60);
  if (need("amount_cents")) {
    const a = int(b.amount_cents, "amount_cents");
    if (a === 0) throw bad("Amount can't be zero.");
    if (Math.abs(a) > MAX_CENTS) throw bad("Amount is too large.");
    out.amount_cents = a;
  }
  if (need("category_id")) {
    out.category_id = int(b.category_id, "category_id");
    if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(out.category_id)) throw bad("Unknown category.");
  }
  if (need("account_id")) {
    if (b.account_id === null) out.account_id = null;
    else {
      out.account_id = int(b.account_id, "account_id");
      if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(out.account_id)) throw bad("Unknown account.");
    }
  }
  if (need("frequency")) out.frequency = oneOf(b.frequency, "frequency", ["monthly", "biweekly", "yearly"] as const);
  if (need("anchor_date")) {
    if (!isValidDate(b.anchor_date)) throw bad("Next date must be a valid date.");
    out.anchor_date = b.anchor_date;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") throw bad("Active must be true or false.");
    out.active = b.active;
  }
  if (has("match_text") && b.match_text !== null && typeof b.match_text !== "string") throw bad("Match text must be text.");
  if (!partial || has("match_text")) {
    const t = typeof b.match_text === "string" ? str(b.match_text, "match_text", 0, 100).toUpperCase() : "";
    out.match_text = t || (out.name ?? current?.name ?? "").toUpperCase();
  }
  return out;
}

const COLS = ["name", "amount_cents", "category_id", "account_id", "frequency", "anchor_date", "match_text", "active"] as const;

export function createRecurring(db: DB, body: unknown, today: string): RecurringListItem {
  const v = { active: true, ...parseRecurring(db, body, false) } as RecurringItem;
  const id = Number(db.prepare(`INSERT INTO recurring_items (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`)
    .run(...COLS.map((c) => (c === "active" ? (v.active ? 1 : 0) : v[c]))).lastInsertRowid);
  return listRecurring(db, today).find((i) => i.id === id)!;
}

export function updateRecurring(db: DB, id: number, body: unknown, today: string): RecurringListItem | null {
  const cur = recurringItems(db).find((i) => i.id === id);
  if (!cur) return null;
  const v = parseRecurring(db, body, true, cur) as Record<string, unknown>;
  const keys = COLS.filter((c) => v[c] !== undefined);
  if (!keys.length) throw bad("Nothing to update.");
  db.prepare(`UPDATE recurring_items SET ${keys.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((c) => (c === "active" ? (v.active ? 1 : 0) : v[c])), id);
  return listRecurring(db, today).find((i) => i.id === id)!;
}
