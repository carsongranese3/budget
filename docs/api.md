# API contract (v1)

Source of truth for the frontend and backend. Behavior: `specs/budget-v1.md`. TypeScript types for every shape below live in `shared/types.ts` (same names). If this file and `shared/types.ts` disagree, fix both.

## Conventions

- Base path `/api`. JSON in, JSON out (`Content-Type: application/json`). Server: Express on port **5174** (`PORT` env overrides); Vite dev server on **5173** proxies `/api` to it.
- Field names are snake_case and match spec §3. Money is integer cents (`*_cents`), dates `YYYY-MM-DD`, months `YYYY-MM`, datetimes ISO 8601.
- Booleans in JSON are real booleans (`excluded_from_totals`, `active`, `has_header`) even though SQLite stores 0/1.
- `month` query/body params must match `YYYY-MM`; otherwise `400 validation`. The client picks the month (spec G5 fallback) using `GET /api/months`; the server never substitutes a month.
- "Today" = local date of the machine running the server (spec G2).
- Request body limit is **15 MB** (`express.json({ limit: "15mb" })`): a 10 MB CSV plus JSON escaping. A CSV `content` larger than 10 MB (UTF-8 bytes) is rejected by the server with `400 invalid_file` even if it fits the body limit.
- Database file: `data/budget.db` (git-ignored; `BUDGET_DB` env overrides the path, tests use `:memory:`).

### Errors

Every non-2xx response has this body:

```json
{ "error": { "code": "validation", "message": "Enter a name." } }
```

`message` is short, human-readable and safe to show in the "Something went wrong — <reason>" toast. Codes:

| HTTP | code | when |
|---|---|---|
| 400 | `validation` | bad/missing body field, bad query param, rule merchant < 3 chars, amount 0 on a recurring item, etc. |
| 400 | `invalid_file` | CSV rejected (spec IM-2 / edge 14). `message` is the user-facing copy: "This doesn't look like a CSV export.", "This file is too large (max 10 MB).", "This file has no transactions in it." |
| 400 | `nothing_to_import` | commit would insert 0 rows (all duplicates). Nothing is written. |
| 403 | `forbidden` | `Origin` header present and not localhost/127.0.0.1/[::1] (CSRF guard); a `Host` header that isn't localhost/127.0.0.1/[::1] on any request (DNS-rebinding guard); deleting/renaming/excluding a locked or system category; `POST /api/sample-data` and `DELETE /api/data` when the DB is the real `data/budget.db` (real-DB guard; `:memory:` and other `BUDGET_DB` paths work) |
| 404 | `not_found` | unknown id, or unknown `/api/*` route |
| 409 | `conflict` | duplicate name (account, category), duplicate rule merchant on PATCH |
| 413 | `payload_too_large` | body > 15 MB |
| 415 | `unsupported_media_type` | non-GET/HEAD request without `Content-Type: application/json` (send `{}` for body-less calls) |
| 500 | `internal` | anything else; the DB is unchanged (all writes are single transactions) |

### Shared shapes

```ts
type AccountType = "checking" | "credit_card" | "savings";
type ColumnRole = "date" | "description" | "amount" | "debit" | "credit" | "ignore";
type SignMode = "purchases_negative" | "purchases_positive" | "debit_credit";

CsvFormat = {
  header_signature: string;
  column_roles: ColumnRole[];      // one per column
  sign_mode: SignMode;
  date_format: "MDY" | "YMD";
  has_header: boolean;
}

Account = {
  id: number; name: string; type: AccountType;
  csv_format: CsvFormat | null;
  last_import_date: string | null;  // YYYY-MM-DD
  created_at: string;
}

Category = {
  id: number; name: string; color: string;       // one of the 11 swatch oklch strings
  excluded_from_totals: boolean;
  fixed: boolean;                      // rent etc.; Budgets page reports it separately from flexible spending
  system_key: "income" | "transfer" | "uncategorized" | null;
  sort_order: number;
}
CategoryWithCounts = Category & {
  transaction_count: number;       // all months
  recurring_count: number;
  rule_count: number;
}

Rule = { id: number; merchant: string; category_id: number; created_at: string }

Transaction = {
  id: number; account_id: number; date: string; description: string;
  amount_cents: number; category_id: number; import_id: number; created_at: string;
  note: string | null; custom_description: string | null; receipt_count: number;
  original_date: string | null;     // bank date, only when `date` was edited
  parent_id: number | null;         // set on split parts = the (hidden) split parent's id
  split_total_cents: number | null; // parts only: the parent's full amount (signed); null otherwise
}

ImportRecord = {
  id: number; file_name: string; account_id: number; imported_at: string;
  row_count: number; new_count: number; skipped_count: number; unreadable_count: number;
  first_date: string | null; last_date: string | null;
}

RecurringItem = {
  id: number; name: string; amount_cents: number;   // signed, never 0
  category_id: number; account_id: number | null;
  frequency: "monthly" | "biweekly" | "yearly";
  anchor_date: string; match_text: string; active: boolean;
}

Occurrence = {                       // one expected/upcoming payment
  recurring_id: number; name: string; amount_cents: number;
  category_id: number; account_id: number | null;
  date: string;                      // occurrence date
}
```

---

## Slice 1

### Month range

**GET `/api/months`**  -> 200
```json
{ "today": "2026-10-25", "current_month": "2026-10", "earliest_month": "2026-05",
  "latest_month": "2026-11", "has_transactions": true }
```
`earliest_month` = earliest month with a transaction, else `current_month`. `latest_month` = `current_month` + 1. `has_transactions` drives the first-run states (DB-9, TX-10).

### Accounts

**GET `/api/accounts`** -> 200 `Account[]` (ordered by id).

**PATCH `/api/accounts/:id`** — body (all optional, at least one): `{ "name"?: string, "type"?: AccountType, "csv_format"?: null }`. `csv_format` accepts only `null` (= "Forget format"). -> 200 `Account`. 409 `conflict` on duplicate name (case-insensitive); 400 on empty/>60 chars. Accounts are created only by import commit; there is no account delete.

### Categories

**GET `/api/categories`** -> 200 `CategoryWithCounts[]` ordered by `sort_order`.

**POST `/api/categories`** — body `{ "name": string }` -> 201 `CategoryWithCounts`. Server trims, enforces 1–40 chars and case-insensitive uniqueness (409), picks the next swatch color in rotation, inserts before Income.

**PATCH `/api/categories/:id`** — body (all optional): `{ "name"?: string, "color"?: string, "excluded_from_totals"?: boolean, "fixed"?: boolean }` -> 200 `CategoryWithCounts`. 400 if `fixed` isn't a boolean. 403 `forbidden` when renaming Income/Uncategorized, or changing `excluded_from_totals` or `fixed` on Income/Uncategorized. 409 on duplicate name. 400 if `color` isn't one of the 11 swatches.

**PUT `/api/categories/order`** — body `{ "ids": number[] }` (`ReorderCategoriesRequest`) = every non-system category id exactly once, in the new order -> 200 `CategoryWithCounts[]` (same as GET). One transaction: `sort_order` 0..n-1 for `ids`, then the built-ins (Income, Transfer, Uncategorized) after them in their existing relative order. 400 `validation` for non-array/non-integer ids, missing, extra, duplicate, unknown, or built-in ids. Create still inserts above the built-ins.

**DELETE `/api/categories/:id`** -> 204. Only `system_key = null`; otherwise 403. In one transaction: its transactions and recurring items move to Uncategorized, its rules and all its budget rows are deleted, then the category is deleted.

### Rules

**GET `/api/rules`** -> 200 `Rule[]` sorted by `merchant`.

**GET `/api/rules/impact?merchant=KEY`** -> 200 `{ "uncategorized_count": number }` — Uncategorized transactions, all months, whose `UPPER(description)` contains `KEY`. Backs the prompt line "Also fixes N other uncategorized transactions" (TX-7). Call it after the row's PATCH, so the edited row is already excluded. `merchant` must be ≥ 3 chars (else 400).

**POST `/api/rules`** — "create rule (and apply)". Body `{ "merchant": string, "category_id": number }` -> 201 `{ "rule": Rule, "applied_count": number }`. `merchant` is uppercased/trimmed server-side, ≥ 3 chars. If a rule with that merchant exists its category is replaced (still 201, same `id`). Always sweeps: every *Uncategorized* transaction (all months) whose `UPPER(description)` contains the merchant is set to `category_id`; `applied_count` is how many changed.

**POST `/api/rules/apply`** — "Reapply rules" (Settings). Body `{}` -> 200 `{ "applied_count": number }`. One transaction: every *Uncategorized* transaction (all months) is set to the category of its matching rule, using import precedence (longest merchant first, then newest; substring of `UPPER(description)`). Categorized transactions are never touched. No rules or no matches -> `applied_count: 0`. Idempotent; a matching rule whose category is Uncategorized leaves the row alone and is not counted.

**PATCH `/api/rules/:id`** — body (optional) `{ "merchant"?: string, "category_id"?: number }` -> 200 `Rule`. 409 on duplicate merchant. Never touches existing transactions.

**DELETE `/api/rules/:id`** -> 204. Never touches existing transactions.

### Transactions

**GET `/api/transactions?month=YYYY-MM[&all=1][&q=text][&account=ID][&category=ID][&day=YYYY-MM-DD]`** -> 200
```json
{ "transactions": [Transaction], "income_cents": 240000, "spent_cents": 81234 }
```
Sorted `date` desc, `id` desc. Filters AND together. `month` is required unless `all=1`. `all=1` (exactly the string `1`) drops the month filter (a `month` sent with it is ignored but still must be valid if present); `q`, `account`, `category`, `day` still apply. `q` is a case-insensitive substring of `description` OR `custom_description`, max 200 chars (else 400 `validation`). `day` must be a real calendar date `YYYY-MM-DD` (else 400 `validation`); when `month` is also given (and `all` isn't 1) a `day` outside that month -> 400 `validation`. Without `all=1` and without `month` -> 400. **Split parents are never returned; split parts are returned as normal rows** (with `parent_id` and `split_total_cents` set). `income_cents`/`spent_cents` use spec G6 over the **filtered** list (TX-1); count = `transactions.length`.

**PATCH `/api/transactions`** — bulk category change. Body `BulkCategoryRequest = { "ids": number[], "category_id": number }` -> 200 `BulkCategoryResponse = { "updated_count": number, "transactions": Transaction[] }`. `ids`: 1-500 unique positive integers (else 400 `validation`); `category_id` must be an existing category (else 400 `validation`). Any id that doesn't exist -> 404 `not_found` (nothing changed); any id that is a split parent -> 400 `validation` (parts are fine). One SQLite transaction, all-or-nothing. `transactions` = the updated rows in the order of `ids`; `updated_count` = `ids.length` (rows already in that category still count). No rule side effects; the client decides about a rule prompt.

**PATCH `/api/transactions/:id`** — body `{ "category_id"?: number, "note"?: string | null, "custom_description"?: string | null, "date"?: string }` (at least one key, else 400) -> 200 `Transaction`. Text is trimmed; empty string or `null` clears to `null`. `note` max 2000 chars, `custom_description` max 200. No rule side effects (rules are created only through `POST /api/rules`). `date` must be a real calendar date `YYYY-MM-DD` (else 400 `validation`). The first date change stores the bank date in `original_date`; setting `date` back to `original_date` clears it to `null`. Re-import duplicate detection compares against `COALESCE(original_date, date)`. Split parts: `category_id`, `note`, `custom_description` edit just that part; `date` moves the whole group (parent and every part; `original_date` handled on each row). A split parent's id -> 400 `validation` ("Edit the parts"), since parents are hidden.

**Splits** (parent stays in the DB, hidden from lists/totals; parts are `Transaction` rows with `parent_id`, copying the parent's account, date, original_date, description, custom_description, import).
`SplitPartInput = { amount_cents: number, category_id: number, note?: string | null }`.
- **POST `/api/transactions/:id/split`** — body `SplitRequest = { "parts": SplitPartInput[] }` -> 200 `Transaction[]` (the parts, in the order sent; ascending `id`). `:id` may be an unsplit transaction, a split parent's id, or **any part's id** — when the target is already split the existing parts are replaced (re-split, one SQL transaction); the group is always resolved to its parent. Rules: 2-100 parts; each `amount_cents` a non-zero integer with the same sign as the parent; sum exactly equals the parent's `amount_cents`; every `category_id` exists; `note` trimmed, max 2000, empty -> null. Violations -> 400 `validation` (message says what is wrong, e.g. "Parts must add up to -$42.10"). 404 if `:id` is missing. Receipts: attached to the parent on first split -> move to the first part; on re-split they stay with the (new) first part.
- **GET `/api/transactions/:id/split`** — `:id` = parent or any part -> 200 `SplitGroup = { "parent": Transaction, "parts": Transaction[] }` (`parent.parent_id` null; `parent.category_id` is its old/unused category). 404 if missing; 400 `validation` if the transaction isn't split. The drawer's "part of a split" view uses the part's own `split_total_cents` and this endpoint for siblings.
- **DELETE `/api/transactions/:id/split`** — `:id` = parent or any part -> 200 `Transaction` (the restored parent, now visible again). Deletes the parts; receipts move back to the parent; part notes/categories are discarded. 404 if missing; 400 `validation` if not split.

**Receipts** (stored as blobs in SQLite; cascade-deleted with their transaction, e.g. import undo and erase-all).
`Receipt = { id, transaction_id, file_name, mime_type, size_bytes, created_at }`.
- **GET `/api/transactions/:id/receipts`** -> 200 `Receipt[]` (oldest first); 404 if the transaction is missing.
- **POST `/api/transactions/:id/receipts`** — body `{ "file_name": string (1-200), "content_base64": string }` -> 201 `Receipt`. 404 if the transaction is missing; 413 `payload_too_large` if the decoded file is over 10 MB; 400 `validation` if the base64 is invalid or the bytes aren't PNG/JPEG/WebP/PDF ("Receipt must be a PNG, JPEG, WebP or PDF"). Type is decided by magic bytes only; `file_name` is display-only.
- **GET `/api/receipts/:id`** -> 200 raw bytes with the stored `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline; filename="<ascii-sanitized>"; filename*=UTF-8''<percent-encoded>`. PDFs also get `X-Frame-Options: SAMEORIGIN`. Images also get `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`; PDFs get no CSP/sandbox (only the frame option above) (not verified in a browser, but those break Chrome's PDF viewer). 404 if missing.
- **DELETE `/api/receipts/:id`** -> 204; 404 if missing.

**GET `/api/transactions/uncategorized-count?month=YYYY-MM`** -> 200 `{ "count": number }` (nav badge, SH-2).

### Import

CSV transport: the client reads the file as UTF-8 text and sends it inside a JSON body as `content` (no multipart). `file_name` is the original name. Preview and commit use the **same** `{ file_name, content }` pair; commit re-parses the text server-side and ignores any client-computed rows.

**GET `/api/imports/sample-csv`** -> 200 `{ "file_name": "chase-sample.csv", "content": "<csv text>" }` — generated, dated around today; feed it to preview like a real file (IM-3).

**POST `/api/imports/preview`** — read-only, writes nothing.
```json
{
  "file_name": "Chase_Activity.csv",
  "content": "<csv text>",
  "account_id": 1,          // optional; null/omitted = no account chosen or a new account
  "format": { /* CsvFormat */ }  // optional; the user's current Step 2 choices
}
```
-> 200
```json
{
  "file_name": "Chase_Activity.csv",
  "row_count": 59,
  "columns": ["Details", "Posting Date", "Description", "Amount", "Type"],
  "sample_rows": [["DEBIT", "10/11/2026", "TRADER JOE'S #552", "-42.10", "DEBIT"]],
  "detected_format": { /* CsvFormat: header_signature, guessed column_roles, sign_mode, date_format, has_header */ },
  "matched_accounts": [{ "id": 1, "name": "Chase Checking" }],
  "suggested_account_id": 1,
  "review": null
}
```
- `columns`: header cells, or "Column 1…N" when `has_header` is false. `sample_rows`: first 5 data rows, raw cells.
- `matched_accounts`: accounts whose saved `csv_format.header_signature` equals this file's signature. Exactly one -> "recognized" (IM-5, skip Step 2); more than one -> Step 2 pre-filled with the saved format, no account pre-selected; none -> Step 2 with `detected_format`.
- `suggested_account_id`: account whose name's first word appears in `file_name` (IM-7), else null.
- `review` is `null` unless the server can resolve a format: the request's `format`, else the saved format when `matched_accounts.length === 1`. When non-null:
```json
{
  "account_id": 1,                 // account used for duplicate check (null = new account, no dupes)
  "format": { /* CsvFormat actually used */ },
  "new_rows": [PreviewRow],
  "duplicate_rows": [PreviewRow],  // count-based, case-insensitive (spec 5.9)
  "unreadable_rows": [{ "line": 12, "raw": "Total,,,,1234.56" }]
}
```
`PreviewRow = { line: number, date: string, description: string, amount_cents: number, category_id: number, rule_merchant: string | null }` — `line` is the 1-based file line (the key for overrides at commit), `category_id` is the matching rule's category or Uncategorized, `rule_merchant` is that rule's merchant (drives the "rule" badge) else null. `description` is whitespace-normalized.
- Errors: `400 invalid_file` (non-CSV content, NUL bytes, < 2 columns in every row, any row > 200 columns, > 10 MB, no data rows). The `.csv` extension / size pre-checks are also done client-side.

**POST `/api/imports`** — commit. Atomic: one SQLite transaction creates the account if new, saves the format if asked, inserts transactions, writes the `imports` row and `last_import_date`. Any failure writes nothing.
```json
{
  "file_name": "Chase_Activity.csv",
  "content": "<csv text>",
  "account_id": 1,                       // existing account, or null when new_account is given
  "new_account": null,                   // or { "name": "Chase Checking", "type": "checking" }
  "format": { /* CsvFormat */ },
  "save_format": true,                   // true = overwrite the account's csv_format; false = leave it unchanged
  "category_overrides": [{ "line": 14, "category_id": 3 }]
}
```
Exactly one of `account_id` / `new_account` is set (400 otherwise). Overrides only apply to lines that end up as new rows. Duplicates are recomputed at commit time. -> 201
```json
{
  "import": ImportRecord,
  "account": Account,
  "uncategorized_count": 7,
  "matched_recurring": [{ "recurring_id": 2, "name": "Paycheck", "date": "2026-10-24" }]
}
```
`uncategorized_count` = how many of the newly inserted rows are Uncategorized (the "Categorize J remaining" button). `matched_recurring` = active recurring occurrences that are received now and were not received before this import (IM-20; sorted by date then name). `import.new_count` is `M`, `skipped_count` is `K`. 400 `nothing_to_import` when 0 new rows; no import row is written.

**GET `/api/imports`** -> 200 `ImportListItem[]`, newest first:
`ImportRecord & { "account_name": string, "transaction_count": number }` (`transaction_count` = transactions currently carrying that `import_id`, for the undo confirmation).

**DELETE `/api/imports/:id`** — undo (IM-24). One transaction: delete all transactions with that `import_id` (recategorized included), delete the import row, recompute the account's `last_import_date`. -> 200 `{ "removed_count": number }`. Rules, accounts, formats, budgets, recurring untouched.

### Data management

**GET `/api/backup`** -> 200 raw bytes: a consistent copy of the SQLite DB (via better-sqlite3 `db.serialize()`, includes WAL contents, never a raw file copy; automatic snapshots use `VACUUM INTO`). `Content-Type: application/vnd.sqlite3`, `Content-Disposition: attachment; filename="budget-backup-YYYY-MM-DD.db"` (local date), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Works for `:memory:` too. Restore is a manual file swap.

**Automatic snapshots (server behavior, no endpoint):** before `POST /api/imports` writes (after validation succeeds) and before `DELETE /api/imports/:id`, the server writes a consistent snapshot into `<dirname(db.name)>/backups/` (`data/backups/`, git-ignored; file name `budget-<timestamp>.db`), then deletes all but the newest 10. No-op for `:memory:`. If the snapshot fails the request fails with 500 `internal` and nothing is written.

**POST `/api/sample-data`** -> 204. Replaces all data with the seeded sample set (accounts, ~6 months of transactions grouped into `imports`, rules, recurring items with past anchors, budgets). The confirmation is client-side. -> 403 `forbidden` if the DB is the real default `data/budget.db` (test-only; use `BUDGET_DB`).

**DELETE `/api/data`** -> 204. Erases every row in every table and re-seeds the default categories. -> 403 `forbidden` if the DB is the real default `data/budget.db` (test-only; use `BUDGET_DB`).

---

## Slice 2

### Dashboard summary

**GET `/api/summary?month=YYYY-MM[&series_end=YYYY-MM]`** -> 200
```json
{
  "month": "2026-10",
  "income_cents": 480000,
  "spent_cents": 312450,
  "net_cents": 167550,
  "income_count": 2,
  "spent_count": 41,
  "uncategorized_count": 7,
  "expected_income_cents": 0,
  "expected_spent_cents": 14200,
  "by_category": [{ "category_id": 4, "spent_cents": 120000 }],
  "series": [{ "month": "2026-05", "income_cents": 480000, "spent_cents": 300000 }]
}
```
All totals per spec G6. `income_count` = Income-category transactions in the month ("N deposits"); `spent_count` = counted non-Income transactions ("N transactions"); `uncategorized_count` = Uncategorized in the month (DB-4). `by_category`: counted non-Income, non-`fixed` categories (Uncategorized included) with spending > 0, largest first (DB-7). `series`: 7 entries ascending, ending at `series_end` (default `month`). `series_end` must be a valid month with `month` inside the window (`month` ≤ `series_end` ≤ `month`+6), else 400 `validation` (`spent_cents` may be negative; the chart clamps at 0). `expected_*_cents` are the §6.4 values and are never added to the totals. The dashboard's empty state uses `has_transactions` from `/api/months`.

### Budgets

`BudgetsResponse` (eligible categories only: not excluded, not Income/Uncategorized):
```json
{
  "month": "2026-10",
  "items": [{ "category_id": 4, "budget_cents": 45000, "spent_cents": 31240 }],
  "other": { "budget_cents": 20000, "spent_cents": 8000 },
  "total_budget_cents": 65000,
  "spent_cents": 31240,
  "fixed_budget_cents": 45000,
  "fixed_spent_cents": 31240
}
```
`other` = the "Other" budget for unbudgeted spending: `other.spent_cents` = sum of `items[].spent_cents` where `budget_cents` is `null` and the category isn't `fixed` (shrinks when a category gets its own budget); `other.budget_cents` is `null` when unset. `budget_cents` is `null` when no budget is set. `items[].spent_cents` is clamped at ≥ 0. `total_budget_cents` = sum of the month's budgets over eligible categories plus `other.budget_cents`; top-level `spent_cents` = spending across all eligible categories (BU-3). `fixed_budget_cents` = sum of non-null budgets of eligible `fixed` categories; `fixed_spent_cents` = sum of `items[].spent_cents` of eligible `fixed` categories (budgeted or not). Both are already included in `total_budget_cents` / `spent_cents` (which stay all-inclusive); the page derives flexible = total − fixed. Items are in category `sort_order`. The Dashboard's budget progress uses the items with non-null `budget_cents` (shown even at $0 spent), then an "Other" row when `other.budget_cents` is non-null.

**GET `/api/budgets?month=YYYY-MM`** -> 200 `BudgetsResponse`.

**PUT `/api/budgets`** — body `{ "month": "2026-10", "category_id": 4, "amount_cents": 45000 }` -> 200 `BudgetsResponse`. `amount_cents` 0 deletes the row; negative, over 10_000_000_000 ($100M), or an ineligible category -> 400. Months must be years 1900–2099 everywhere. `category_id: null` sets the Other budget (same amount rules: 0 deletes, negative / over cap -> 400); a missing `category_id` is still 400.

**POST `/api/budgets/copy`** — body `{ "month": "2026-10" }` (the target; source = previous month) -> 200 `{ "copied_count": number, "budgets": BudgetsResponse }`. `copied_count` 0 when the previous month has none (nothing changes). Same-category values are overwritten, others left. The previous month's Other budget is copied too and counts 1 toward `copied_count`. Erase-all clears Other budgets.

---

## Slice 3

### Recurring items

`RecurringListItem = RecurringItem & { "next_date": string, "status": RecurringStatus }` where
`RecurringStatus = { "kind": "paused" | "none" | "received" | "expected", "date": string | null }` (`date` set for `received`/`expected`; spec §6.3). `next_date` = first occurrence strictly after today (equals `anchor_date` while that is in the future).

**GET `/api/recurring`** -> 200 `RecurringListItem[]` ordered by `id`.

**POST `/api/recurring`** — body `{ name, amount_cents, category_id, account_id, frequency, anchor_date, match_text, active? }` (`RecurringItem` minus `id`; `active` defaults true) -> 201 `RecurringListItem`. Validation: name 1–60, `amount_cents` ≠ 0 (negative = expense), `match_text` uppercased/trimmed (empty falls back to `UPPER(name)`), valid `anchor_date`.

**PATCH `/api/recurring/:id`** — any subset of the POST fields (Active toggle sends `{ "active": false }`) -> 200 `RecurringListItem`.

**DELETE `/api/recurring/:id`** -> 204. Imported transactions are unaffected.

**GET `/api/recurring/upcoming?month=YYYY-MM`** -> 200
```json
{ "expected": [Occurrence], "upcoming": [Occurrence] }
```
`expected`: active items' unreceived occurrences in `[month start, min(month end, today)]` (§6.4; empty for future months). `upcoming`: next 10 occurrences strictly after today across active items, by date then name (§6.5; independent of `month`).

**GET `/api/recurring/suggestions`** -> 200 `RecurringSuggestion[]`
```json
[{ "merchant": "NETFLIX", "name": "Netflix", "amount_cents": -1599, "frequency": "monthly",
   "category_id": 6, "account_id": 1, "last_date": "2026-10-03", "next_date": "2026-11-03", "occurrences": 5 }]
```
Detected from history (parts and split parents ignored) by `shared/recurring.ts`. `merchant` = suggested `match_text` (uppercase); `name` = display name; `amount_cents` = typical signed amount; `category_id` = most common category of the matches; `account_id` = their account; `next_date` = suggested `anchor_date` (first expected date after `last_date`, may be in the past). Excludes any merchant already covered by an existing recurring item (active or not, by `match_text`). Sorted by `occurrences` desc, then `merchant`. `[]` when none. Dismiss is client-side only. To accept, the client POSTs `/api/recurring` with `{ name, amount_cents, category_id, account_id, frequency, anchor_date: next_date, match_text: merchant }`.

Recurring matches also surface in `POST /api/imports` (`matched_recurring`) and `GET /api/summary` (`expected_income_cents`, `expected_spent_cents`).

---

## Slice 5

### Trends

**GET `/api/trends[?end=YYYY-MM]`** -> 200 `TrendsResponse`. `end` defaults to the current month; must be a valid month (years 1900-2099), else 400 `validation`.
```json
{
  "months": ["2025-12", "...", "2026-11"],
  "income_cents": [0, 0],
  "spent_cents": [0, 0],
  "categories": [{ "category_id": 4, "spent_cents": [0, 0] }],
  "ytd": { "year": 2026, "income_cents": 0, "spent_cents": 0, "categories": [{ "category_id": 4, "spent_cents": 0 }] }
}
```
`months` = 12 ascending months ending at `end`; each array has 12 entries aligned to it. `income_cents`/`spent_cents` per month use spec G6 exactly like `series` in `/api/summary` (`spent_cents` may be negative; the chart clamps). `categories` = counted (not excluded), non-Income categories that have any spending in the window (Uncategorized included), per-month `spent_cents` clamped at ≥ 0 (same rules as `by_category`/Budgets spend, but **including** `fixed` categories); ordered by `sort_order`. `ytd` = January 1 of `end`'s year through the end of `end` (so `year` = year of `end`); `ytd.categories` = same rule over that range, categories with spend > 0, largest first. Split parents are never counted; parts are.

---

## Endpoint index

| Slice | Method | Path |
|---|---|---|
| 1 | GET | `/api/months` |
| 1 | GET, PATCH | `/api/accounts`, `/api/accounts/:id` |
| 1 | GET, POST | `/api/categories` |
| 1 | PUT | `/api/categories/order` |
| 1 | PATCH, DELETE | `/api/categories/:id` |
| 1 | GET, POST | `/api/rules` |
| 1 | GET | `/api/rules/impact` |
| 1 | POST | `/api/rules/apply` |
| 1 | PATCH, DELETE | `/api/rules/:id` |
| 1 | GET | `/api/transactions`, `/api/transactions/uncategorized-count` |
| 1 | PATCH | `/api/transactions/:id` |
| 5 | PATCH | `/api/transactions` (bulk category) |
| 5 | GET, POST, DELETE | `/api/transactions/:id/split` |
| 5 | GET | `/api/backup` |
| 5 | GET | `/api/recurring/suggestions` |
| 5 | GET | `/api/trends` |
| 4 | GET, POST | `/api/transactions/:id/receipts` |
| 4 | GET, DELETE | `/api/receipts/:id` |
| 1 | GET | `/api/imports`, `/api/imports/sample-csv` |
| 1 | POST | `/api/imports/preview`, `/api/imports` |
| 1 | DELETE | `/api/imports/:id` |
| 1 | POST, DELETE | `/api/sample-data`, `/api/data` |
| 2 | GET | `/api/summary` |
| 2 | GET, PUT | `/api/budgets` |
| 2 | POST | `/api/budgets/copy` |
| 3 | GET, POST | `/api/recurring` |
| 3 | PATCH, DELETE | `/api/recurring/:id` |
| 3 | GET | `/api/recurring/upcoming` |
