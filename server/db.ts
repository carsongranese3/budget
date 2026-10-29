import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Account, Category, CategoryWithCounts } from "../shared/types.js";

export type DB = Database.Database;

export const SWATCHES = [
  "oklch(0.6 0.09 190)", "oklch(0.67 0.12 55)", "oklch(0.55 0.07 255)", "oklch(0.66 0.09 225)",
  "oklch(0.6 0.1 290)", "oklch(0.63 0.11 335)", "oklch(0.72 0.11 88)", "oklch(0.63 0.13 15)",
  "oklch(0.58 0.12 150)", "oklch(0.68 0.01 250)", "oklch(0.76 0.04 80)",
];

// Migrations run in order; PRAGMA user_version records how many have been applied.
const MIGRATIONS = [
  `CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     type TEXT NOT NULL CHECK (type IN ('checking','credit_card','savings')),
     csv_format TEXT,
     last_import_date TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE categories (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     color TEXT NOT NULL,
     excluded_from_totals INTEGER NOT NULL DEFAULT 0,
     system_key TEXT CHECK (system_key IN ('income','transfer','uncategorized')),
     sort_order INTEGER NOT NULL
   );
   CREATE TABLE imports (
     id INTEGER PRIMARY KEY,
     file_name TEXT NOT NULL,
     account_id INTEGER NOT NULL REFERENCES accounts(id),
     imported_at TEXT NOT NULL,
     row_count INTEGER NOT NULL, new_count INTEGER NOT NULL,
     skipped_count INTEGER NOT NULL, unreadable_count INTEGER NOT NULL,
     first_date TEXT, last_date TEXT
   );
   CREATE TABLE transactions (
     id INTEGER PRIMARY KEY,
     account_id INTEGER NOT NULL REFERENCES accounts(id),
     date TEXT NOT NULL,
     description TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     category_id INTEGER NOT NULL REFERENCES categories(id),
     import_id INTEGER NOT NULL REFERENCES imports(id),
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_tx_dup ON transactions(account_id, date, amount_cents);
   CREATE INDEX idx_tx_date ON transactions(date);
   CREATE INDEX idx_tx_import ON transactions(import_id);
   CREATE TABLE rules (
     id INTEGER PRIMARY KEY,
     merchant TEXT NOT NULL UNIQUE,
     category_id INTEGER NOT NULL REFERENCES categories(id),
     created_at TEXT NOT NULL
   );
   CREATE TABLE recurring_items (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
     category_id INTEGER NOT NULL REFERENCES categories(id),
     account_id INTEGER REFERENCES accounts(id),
     frequency TEXT NOT NULL CHECK (frequency IN ('monthly','biweekly','yearly')),
     anchor_date TEXT NOT NULL,
     match_text TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE budgets (
     month TEXT NOT NULL,
     category_id INTEGER NOT NULL REFERENCES categories(id),
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
     PRIMARY KEY (month, category_id)
   );`,
  `CREATE TABLE other_budgets (
     month TEXT PRIMARY KEY,
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
   );`,
  `ALTER TABLE transactions ADD COLUMN note TEXT;
   ALTER TABLE transactions ADD COLUMN custom_description TEXT;
   CREATE TABLE receipts (
     id INTEGER PRIMARY KEY,
     transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
     file_name TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     data BLOB NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_receipts_tx ON receipts(transaction_id);`,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON"); // zero deleted receipt bytes
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  // JS uppercasing so SQL matching agrees with merchantKey/duplicate logic on non-ASCII text.
  db.function("ujs", { deterministic: true }, (s: unknown) => String(s).toUpperCase());
  let v = db.pragma("user_version", { simple: true }) as number;
  while (v < MIGRATIONS.length) {
    db.transaction(() => { db.exec(MIGRATIONS[v]); db.pragma(`user_version = ${v + 1}`); })();
    v++;
  }
  if (countRows(db, "categories") === 0) seedCategories(db);
  return db;
}

function countRows(db: DB, table: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

const BUILTINS: [string, number, number, string | null][] = [
  ["Groceries", 0, 0, null], ["Dining", 1, 0, null], ["Rent", 2, 0, null], ["Utilities", 3, 0, null],
  ["Transportation", 4, 0, null], ["Subscriptions", 5, 0, null], ["Shopping", 6, 0, null],
  ["Entertainment", 7, 0, null], ["Income", 8, 0, "income"], ["Transfer", 9, 1, "transfer"],
  ["Uncategorized", 10, 0, "uncategorized"],
];

export function seedCategories(db: DB): void {
  const ins = db.prepare(
    "INSERT INTO categories (name, color, excluded_from_totals, system_key, sort_order) VALUES (?,?,?,?,?)",
  );
  BUILTINS.forEach(([name, i, ex, key]) => ins.run(name, SWATCHES[i], ex, key, i));
}

/** Delete every row in every table, then re-seed the default categories. */
export function eraseAll(db: DB): void {
  for (const t of ["receipts", "transactions", "budgets", "other_budgets", "recurring_items", "rules", "imports", "accounts", "categories"])
    db.exec(`DELETE FROM ${t}`);
  seedCategories(db);
}

// ---- row mappers ----
export function toAccount(r: any): Account {
  return { ...r, csv_format: r.csv_format ? JSON.parse(r.csv_format) : null };
}
export function toCategory(r: any): Category {
  return { ...r, excluded_from_totals: !!r.excluded_from_totals };
}
export const CATEGORY_COUNTS_SQL = `
  SELECT c.*,
    (SELECT COUNT(*) FROM transactions WHERE category_id = c.id) AS transaction_count,
    (SELECT COUNT(*) FROM recurring_items WHERE category_id = c.id) AS recurring_count,
    (SELECT COUNT(*) FROM rules WHERE category_id = c.id) AS rule_count
  FROM categories c`;
export function toCategoryWithCounts(r: any): CategoryWithCounts {
  return toCategory(r) as CategoryWithCounts;
}

export function uncategorizedId(db: DB): number {
  return (db.prepare("SELECT id FROM categories WHERE system_key = 'uncategorized'").get() as { id: number }).id;
}

/** Local calendar date YYYY-MM-DD of an ISO instant (or now). */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** last_import_date = newest remaining import's local date, else null. */
export function recomputeLastImport(db: DB, accountId: number): void {
  const rows = db.prepare("SELECT imported_at FROM imports WHERE account_id = ?").all(accountId) as { imported_at: string }[];
  const last = rows.map((r) => localDate(new Date(r.imported_at))).sort().pop() ?? null;
  db.prepare("UPDATE accounts SET last_import_date = ? WHERE id = ?").run(last, accountId);
}
