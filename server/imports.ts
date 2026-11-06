// Import preview / commit / undo (spec §4.3, §5). Server is authoritative: commit re-parses the text.
import { detectFormat, parseCsvText, parseDate, parseRows, type ParsedRow } from "../shared/csv.js";
import type {
  Account, ColumnRole, CommitImportResponse, CsvFormat, ImportListItem, ImportRecord,
  PreviewResponse, PreviewRow, SignMode, UndoImportResponse,
} from "../shared/types.js";
import { type DB, recomputeLastImport, toAccount, uncategorizedId } from "./db.js";
import { addDays, newlyReceived } from "../shared/recurring.js";
import { recurringItems, txsBetween } from "./recurring.js";
import { HttpError, bad, int, notFound, obj, oneOf, str } from "./http.js";

const MAX_BYTES = 10 * 1024 * 1024;
const ROLES: ColumnRole[] = ["date", "description", "amount", "debit", "credit", "ignore"];
const SIGNS: SignMode[] = ["purchases_negative", "purchases_positive", "debit_credit"];
const invalid = (m: string) => new HttpError(400, "invalid_file", m);

/** Validate + tokenize the uploaded text (IM-2, edge 14). */
export function readCsv(fileName: unknown, content: unknown): { file_name: string; records: string[][] } {
  const file_name = str(fileName, "file_name", 1, 255);
  if (typeof content !== "string") throw bad("File content must be text.");
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw invalid("This file is too large (max 10 MB).");
  if (content.includes("\0")) throw invalid("This doesn't look like a CSV export.");
  const records = parseCsvText(content);
  if (records.length === 0) throw invalid("This file has no transactions in it.");
  if (records.length === 1 && !records[0].some((c) => parseDate(c) !== null)) throw invalid("This file has no transactions in it.");
  if (records.some((r) => r.length > 200)) throw invalid("This doesn't look like a CSV export.");
  if (records.every((r) => r.length < 2)) throw invalid("This doesn't look like a CSV export.");
  return { file_name, records };
}

export function validateFormat(v: unknown): CsvFormat {
  const f = obj(v);
  if (!Array.isArray(f.column_roles) || f.column_roles.length > 200) throw bad("format.column_roles is invalid.");
  const column_roles = f.column_roles.map((r) => oneOf(r, "column role", ROLES));
  if (typeof f.header_signature !== "string" || f.header_signature.length > 5000) throw bad("format.header_signature is invalid.");
  if (typeof f.has_header !== "boolean") throw bad("Header setting must be true or false.");
  return {
    header_signature: f.header_signature, column_roles,
    sign_mode: oneOf(f.sign_mode, "sign_mode", SIGNS),
    date_format: oneOf(f.date_format, "date_format", ["MDY", "YMD"] as const),
    has_header: f.has_header,
  };
}

function formatComplete(f: CsvFormat): boolean {
  const has = (r: ColumnRole) => f.column_roles.includes(r);
  return has("date") && has("description") &&
    (f.sign_mode === "debit_credit" ? has("debit") && has("credit") : has("amount"));
}

const dupKey = (date: string, cents: number, desc: string) => `${date}|${cents}|${desc.toUpperCase()}`;

/** Count-based duplicate split (5.9). accountId null = new account, nothing to compare. */
export function splitDuplicates(db: DB, accountId: number | null, rows: ParsedRow[]) {
  const stored = new Map<string, number>();
  if (accountId !== null && rows.length) {
    const dates = rows.map((r) => r.date).sort();
    const q = db.prepare(
      "SELECT COALESCE(original_date, date) AS date, amount_cents, description FROM transactions WHERE account_id = ? AND COALESCE(original_date, date) BETWEEN ? AND ?",
    ).all(accountId, dates[0], dates[dates.length - 1]) as { date: string; amount_cents: number; description: string }[];
    for (const t of q) {
      const k = dupKey(t.date, t.amount_cents, t.description.replace(/\s+/g, " ").trim());
      stored.set(k, (stored.get(k) ?? 0) + 1);
    }
  }
  const fresh: ParsedRow[] = [], dupes: ParsedRow[] = [];
  for (const r of rows) {
    const k = dupKey(r.date, r.amount_cents, r.description);
    const left = stored.get(k) ?? 0;
    if (left > 0) { stored.set(k, left - 1); dupes.push(r); } else fresh.push(r);
  }
  return { fresh, dupes };
}

/** Longest matching merchant wins, then newest rule (4.2). */
export function makeRuleMatcher(db: DB) {
  const rules = db.prepare("SELECT id, merchant, category_id FROM rules").all() as { id: number; merchant: string; category_id: number }[];
  rules.sort((a, b) => b.merchant.length - a.merchant.length || b.id - a.id);
  return (description: string) => {
    const d = description.toUpperCase();
    return rules.find((r) => d.includes(r.merchant)) ?? null;
  };
}

export function preview(db: DB, body: unknown): PreviewResponse {
  const b = obj(body);
  const { file_name, records } = readCsv(b.file_name, b.content);
  const detected = detectFormat(records);
  const hi = headerIndex(records, detected); // index of the first data record
  const accounts = (db.prepare("SELECT * FROM accounts ORDER BY id").all() as any[]).map(toAccount);
  const matched = accounts.filter((a) => a.csv_format?.header_signature === detected.header_signature);
  const lname = file_name.toLowerCase();
  const suggested = accounts.find((a) => {
    const w = a.name.trim().split(/\s+/)[0]?.toLowerCase();
    return !!w && lname.includes(w);
  });

  let accountId: number | null = null;
  if (b.account_id !== undefined && b.account_id !== null) {
    accountId = int(b.account_id, "account_id");
    if (!accounts.some((a) => a.id === accountId)) throw bad("Unknown account_id.");
  }
  let format: CsvFormat | null = null;
  if (b.format !== undefined && b.format !== null) format = validateFormat(b.format);
  else if (matched.length === 1) { format = matched[0].csv_format; accountId = accountId ?? matched[0].id; }

  let review: PreviewResponse["review"] = null;
  let rowCount: number;
  if (format) {
    const { rows, unreadable } = parseRows(records, format);
    const { fresh, dupes } = splitDuplicates(db, accountId, rows);
    const match = makeRuleMatcher(db);
    const unc = uncategorizedId(db);
    const toRow = (r: ParsedRow): PreviewRow => {
      const m = match(r.description);
      return { ...r, category_id: m?.category_id ?? unc, rule_merchant: m?.merchant ?? null };
    };
    review = { account_id: accountId, format, new_rows: fresh.map(toRow), duplicate_rows: dupes.map(toRow), unreadable_rows: unreadable };
    rowCount = rows.length;
    if (rows.length === 0 && unreadable.length === 0) throw invalid("This file has no transactions in it.");
  } else {
    rowCount = records.length - hi;
  }
  const ncols = detected.column_roles.length;
  return {
    file_name, row_count: rowCount,
    columns: detected.has_header ? records[hi - 1] : Array.from({ length: ncols }, (_, i) => `Column ${i + 1}`),
    sample_rows: records.slice(hi, hi + 5),
    detected_format: detected,
    matched_accounts: matched.map((a) => ({ id: a.id, name: a.name })),
    suggested_account_id: suggested?.id ?? null,
    review,
  };
}

/** Number of leading records that are preamble + header (so data starts at this index). */
function headerIndex(records: string[][], f: CsvFormat): number {
  if (!f.has_header) return 0;
  const sig = (c: string[]) => {
    const x = c.map((s) => s.replace(/\s+/g, " ").trim().toLowerCase());
    while (x.length && x[x.length - 1] === "") x.pop();
    return x.join("|");
  };
  return records.findIndex((r, i) => i < 15 && sig(r) === f.header_signature) + 1;
}

export function commit(db: DB, body: unknown): CommitImportResponse {
  const b = obj(body);
  const { file_name, records } = readCsv(b.file_name, b.content);
  const format = validateFormat(b.format);
  if (!formatComplete(format)) throw bad("The column setup is incomplete.");
  if (typeof b.save_format !== "boolean") throw bad("Save format must be true or false.");
  const hasId = b.account_id !== undefined && b.account_id !== null;
  const hasNew = b.new_account !== undefined && b.new_account !== null;
  if (hasId === hasNew) throw bad("Provide exactly one of account_id or new_account.");
  const overrides = new Map<number, number>();
  if (b.category_overrides !== undefined) {
    if (!Array.isArray(b.category_overrides) || b.category_overrides.length > 200000) throw bad("Category overrides must be a list.");
    for (const o of b.category_overrides) {
      const x = obj(o);
      overrides.set(int(x.line, "line"), int(x.category_id, "category_id"));
    }
  }
  let newAcct: { name: string; type: Account["type"] } | null = null;
  if (hasNew) {
    const n = obj(b.new_account);
    newAcct = { name: str(n.name, "account name", 1, 60), type: oneOf(n.type, "type", ["checking", "credit_card", "savings"] as const) };
  }
  const accountId = hasId ? int(b.account_id, "account_id") : null;

  const { rows, unreadable } = parseRows(records, format);
  const catIds = new Set((db.prepare("SELECT id FROM categories").all() as { id: number }[]).map((c) => c.id));
  for (const c of overrides.values()) if (!catIds.has(c)) throw bad("Unknown category in category_overrides.");

  return db.transaction((): CommitImportResponse => {
    let acctId: number;
    const now = new Date().toISOString();
    if (newAcct) {
      try {
        acctId = Number(db.prepare("INSERT INTO accounts (name, type, csv_format, created_at) VALUES (?,?,NULL,?)")
          .run(newAcct.name, newAcct.type, now).lastInsertRowid);
      } catch (e: any) {
        if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new HttpError(409, "conflict", "An account with that name already exists.");
        throw e;
      }
    } else {
      acctId = accountId!;
      if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(acctId)) throw bad("Unknown account_id.");
    }
    const { fresh, dupes } = splitDuplicates(db, newAcct ? null : acctId, rows);
    if (fresh.length === 0) throw new HttpError(400, "nothing_to_import", "Nothing to import — every row is already imported.");

    const dates = fresh.map((r) => r.date).sort();
    const impId = Number(db.prepare(
      `INSERT INTO imports (file_name, account_id, imported_at, row_count, new_count, skipped_count, unreadable_count, first_date, last_date)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(file_name, acctId, now, rows.length, fresh.length, dupes.length, unreadable.length, dates[0], dates[dates.length - 1]).lastInsertRowid);

    const recItems = recurringItems(db).filter((i) => i.active);
    const before = txsBetween(db, addDays(dates[0], -8), addDays(dates[dates.length - 1], 8)); // pre-import, for IM-20
    const match = makeRuleMatcher(db);
    const unc = uncategorizedId(db);
    const ins = db.prepare(
      "INSERT INTO transactions (account_id, date, description, amount_cents, category_id, import_id, created_at) VALUES (?,?,?,?,?,?,?)",
    );
    let uncCount = 0;
    for (const r of fresh) {
      const cat = overrides.get(r.line) ?? match(r.description)?.category_id ?? unc;
      if (cat === unc) uncCount++;
      ins.run(acctId, r.date, r.description, r.amount_cents, cat, impId, now);
    }
    if (b.save_format) db.prepare("UPDATE accounts SET csv_format = ? WHERE id = ?").run(JSON.stringify(format), acctId);
    recomputeLastImport(db, acctId);
    return {
      import: db.prepare("SELECT * FROM imports WHERE id = ?").get(impId) as ImportRecord,
      account: toAccount(db.prepare("SELECT * FROM accounts WHERE id = ?").get(acctId)),
      uncategorized_count: uncCount,
      matched_recurring: newlyReceived(recItems, before, fresh),
    };
  })();
}

export function listImports(db: DB): ImportListItem[] {
  return db.prepare(
    `SELECT i.*, a.name AS account_name,
       (SELECT COUNT(*) FROM transactions WHERE import_id = i.id) AS transaction_count
     FROM imports i JOIN accounts a ON a.id = i.account_id
     ORDER BY i.imported_at DESC, i.id DESC`,
  ).all() as ImportListItem[];
}

export function undoImport(db: DB, id: number): UndoImportResponse {
  return db.transaction(() => {
    const imp = db.prepare("SELECT account_id FROM imports WHERE id = ?").get(id) as { account_id: number } | undefined;
    if (!imp) throw notFound("Import not found.");
    const removed = db.prepare("DELETE FROM transactions WHERE import_id = ?").run(id).changes;
    db.prepare("DELETE FROM imports WHERE id = ?").run(id);
    recomputeLastImport(db, imp.account_id);
    return { removed_count: removed };
  })();
}
