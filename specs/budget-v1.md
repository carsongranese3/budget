# Spec: Budget v1

Status: built (v1 feature-complete) · 2026-10-25.

Read with:
- `design/README.md` — visual source of truth (layout, tokens, copy, component specs). This spec references its sections ("README §Import") instead of repeating pixel values. Where this spec and the README disagree on **behavior**, this spec wins; on **visuals/copy**, the README wins.
- `docs/design.md` — route mapping and intended differences from the prototype.
- `docs/decisions.md` — settled decisions (local-only, CSV-only input, learned merchant rules, no LLM, integer cents).
- Reference algorithms in `design/Budget.dc.html` logic class: `merchantKey` (l.784), `occ` (l.780), `parsePreview` (l.785), `matchTx` (l.879), `totals` (l.860), `bstat` (l.875), `renameCat` (l.847), `createRule` (l.823).

## 1. Scope

In: CSV import (multi-file, per-account saved format, sign convention, duplicate skipping, undo a whole import), rule-based auto-categorization with learn-on-recategorize, Transactions, monthly category budgets, Dashboard with charts, recurring items with expected/received status (add, edit, delete), Settings (appearance, accounts, categories incl. delete, rules, sample data, erase all).

Out (v1): manual "add transaction" form, editing transaction amount/date/description, deleting individual transactions, splitting transactions, PDF import, bank sync, LLM categorization, multi-user/auth, export, account deletion, non-USD currencies, non-comma delimiters.

## 2. Global rules

- **G1 Money** is integer cents everywhere (DB, API, shared types). Fields holding money end in `_cents`. Display: `$1,234.56` en-US, 2 decimals (README §Global rules). Parse user-entered dollars from the string, never via float math.
- **G2 Dates** are `YYYY-MM-DD` strings; months are `YYYY-MM`. "Today" = local date of the machine running the server. Date math (±4 days, +14 days) is done on calendar dates, not timestamps (no DST bugs).
- **G3 Sign**: `amount_cents < 0` = money out, `> 0` = money in. `0` is allowed and has no effect on totals.
- **G4 JSON field names are snake_case and identical to the DB column names in §3** (no camelCase mapping layer). Shared TS types in `shared/` use these same names.
- **G5 Selected month** is the `?month=YYYY-MM` URL param and applies to every screen. Missing/invalid/out of range → current month (client-side; the API returns 400 for an invalid month). Allowed range: earliest month that has a transaction (or the current month if none) through current month + 1. Picker arrows disable at the ends.
- **G6 Totals** (one shared function, used by Dashboard, Transactions subtitle, Budgets, chart):
  - A transaction counts only if its category has `excluded_from_totals = 0`.
  - `income_cents` = sum of `amount_cents` of counted transactions in the Income category (refunds/chargebacks of income reduce it).
  - `spent_cents` = −(sum of `amount_cents` of counted transactions in every other category, including Uncategorized money-out). A refund (+) in Dining reduces Spent. **Uncategorized deposits (amount > 0) are left out of Spent, Income and Net** until the user categorizes them; they still count toward the Uncategorized count/tile. (Changed 2026-10-25 — an uncategorized paycheck made Spent negative.)
  - `net_cents` = `income_cents − spent_cents`.
  - Per-category spending = −(sum of that category's amounts); for budgets/bars it is clamped at ≥ 0.
- **G7 No third-party requests**: fonts self-hosted, no CDN, no telemetry. Theme in `localStorage` key `budget.theme` (`light`|`dark`); initial value follows `prefers-color-scheme`.
- **G8 Confirmations** for destructive actions (undo import, category delete, recurring delete, Load sample data over existing data, Erase) use one shared confirm dialog styled with README tokens (card, secondary "Cancel", primary-style button in `--neg` for the destructive action).

## 3. Data model

SQLite via better-sqlite3, `PRAGMA foreign_keys = ON`. All `id` are `INTEGER PRIMARY KEY`. Categories are referenced by `category_id` so renames never touch other tables.

### accounts
| field | type | notes |
|---|---|---|
| id | int | |
| name | text | unique (case-insensitive), 1–60 chars |
| type | text | `checking` \| `credit_card` \| `savings` (UI: Checking / Credit card / Savings) |
| csv_format | text (JSON) \| null | null = "Not saved — asks on next import". Shape below |
| last_import_date | text \| null | `YYYY-MM-DD` (local date) of the latest remaining `imports.imported_at` for this account; null if none. Recomputed on commit and on undo |
| created_at | text | ISO datetime |

`csv_format` JSON object:
| field | type | notes |
|---|---|---|
| header_signature | string | see §5.3 |
| column_roles | string[] | one per column: `date` \| `description` \| `amount` \| `debit` \| `credit` \| `ignore` |
| sign_mode | string | `purchases_negative` \| `purchases_positive` \| `debit_credit` |
| date_format | string | `MDY` \| `YMD` (detected, see §5.4) |
| has_header | boolean | |

Settings label for a saved format: `<first word of account name> · <N> columns` (e.g. "Chase · 7 columns").

### categories
| field | type | notes |
|---|---|---|
| id | int | |
| name | text | unique case-insensitive, 1–40 chars, trimmed |
| color | text | one of the 11 swatch values (README §Design tokens / prototype `SW`) |
| excluded_from_totals | int 0/1 | |
| system_key | text \| null | `income` \| `transfer` \| `uncategorized` for built-ins; null for user categories |
| sort_order | int | display order |

Seed (also the state after Erase): Groceries, Dining, Rent, Utilities, Transportation, Subscriptions, Shopping, Entertainment (system_key null), Income (`income`), Transfer (`transfer`, excluded = 1), Uncategorized (`uncategorized`), colors per README §Design tokens. New user categories are inserted before Income in order.
- Income and Uncategorized are **locked**: cannot be renamed, deleted or excluded.
- Transfer: can be renamed and toggled, cannot be deleted.
- Only categories with `system_key = null` can be deleted.
- Code identifies built-ins by `system_key`, never by name.

### transactions
| field | type | notes |
|---|---|---|
| id | int | |
| account_id | int FK → accounts | |
| date | text | `YYYY-MM-DD` |
| description | text | as in the CSV, trimmed, internal whitespace runs collapsed to one space (case preserved) |
| amount_cents | int | signed per G3 |
| category_id | int FK → categories | never null; Uncategorized when unknown |
| import_id | int FK → imports, not null | every transaction belongs to an import (sample data creates its own `imports` rows) |
| created_at | text | ISO datetime |

Indexes on `(account_id, date, amount_cents)`, `date`, `import_id`.

### rules
| field | type | notes |
|---|---|---|
| id | int | |
| merchant | text | uppercase, trimmed, unique, ≥ 3 chars; matched as a substring of `UPPER(description)` |
| category_id | int FK → categories | |
| created_at | text | |

### recurring_items
| field | type | notes |
|---|---|---|
| id | int | |
| name | text | 1–60 chars |
| amount_cents | int | signed: expense < 0, income > 0, never 0 |
| category_id | int FK | |
| account_id | int FK \| null | null shows "—" |
| frequency | text | `monthly` \| `biweekly` \| `yearly` (UI: Monthly / Every 2 weeks / Yearly) |
| anchor_date | text | the "Next date" entered = the **first** occurrence the app tracks (§6.1) |
| match_text | text | uppercase, trimmed, non-empty |
| active | int 0/1 | |

### budgets
| field | type | notes |
|---|---|---|
| month | text | `YYYY-MM` |
| category_id | int FK | |
| amount_cents | int | > 0 and ≤ 10_000_000_000 ($100M). Setting 0 or empty deletes the row |

Primary key `(month, category_id)`.

### other_budgets
| field | type | notes |
|---|---|---|
| month | text PK | `YYYY-MM`. Budget for "Other" = spending in categories without their own budget. Same amount rules as `budgets`; 0 deletes the row |

### imports (import log)
| field | type | notes |
|---|---|---|
| id | int | |
| file_name | text | original name |
| account_id | int FK | |
| imported_at | text | ISO datetime |
| row_count | int | data rows found (excludes header and blank rows) |
| new_count | int | inserted |
| skipped_count | int | duplicates skipped |
| unreadable_count | int | rows that couldn't be parsed |
| first_date / last_date | text \| null | range of inserted rows |

Cascading deletes exist only for: category delete (ST-6), undo import (IM-24), Erase (ST-9, API only). There is no account delete in v1.

## 4. Screens and flows

### 4.0 App shell — README §App shell
Routes: `/`, `/transactions`, `/import`, `/budgets`, `/recurring`, `/settings` (docs/design.md).

- SH-1 Header shows brand, the six nav items, month picker, theme toggle; the active route's nav item is highlighted.
- SH-2 Transactions nav shows an amber badge with the count of Uncategorized transactions in the selected month; hidden when 0.
- SH-3 Month picker ‹ › change `?month=` and every screen re-renders for that month; arrows are disabled at the G5 range ends.
- SH-4 "Back to <current month name>" link appears only when the selected month ≠ current month; clicking sets the current month.
- SH-5 Theme toggle switches light/dark immediately, persists in `localStorage`, and survives reload. Settings › Appearance controls the same value.
- SH-6 Under 1100px viewport the nav moves to a second, horizontally scrollable row.
- SH-7 Navigation between screens keeps the `?month=` param.
- SH-8 Any API failure shows a toast "Something went wrong — <short reason>" and leaves on-screen data unchanged (no partial optimistic state left behind).

### 4.1 Dashboard (`/`) — README §1
Data: totals for the selected month, 7-month income/spend series, spending by category, budget progress, expected + upcoming recurring.

- DB-1 Income tile = `income_cents` (green). Sub-line: "+$X expected, not imported yet" when expected income (§6.4) > 0, else "N deposits" (count of Income-category transactions).
- DB-2 Spent tile = `spent_cents`. Sub-line: "+$X expected, not imported yet" when expected spending > 0, else "N transactions" (count of counted, non-Income transactions).
- DB-3 Net tile shows "+$X" / "−$X". Sub-line "N% of income kept" = round(net / income × 100); when income is 0 the sub-line is "—".
- DB-4 Uncategorized tile shows the month's Uncategorized count; when > 0 it has the amber treatment. Clicking it opens `/transactions?month=…&category=<uncategorized id>`.
- DB-5 Income vs spending chart (hand-rolled HTML/CSS bars) shows 7 months centered on the selected month (window end = min(max(selected+3, earliest+6), max(current, selected)); see docs/decisions.md), paired bars, y-axis gridlines at quarters with step = max($500, ceil(max/4/$500)×$500) labelled "$0, $1.5k…". Selected month at full opacity, others 0.45. Hover updates the caption "<Month> — income $… · spending $…"; click opens Transactions for that month (if within G5 range); the top-bar arrows change the selected month.
- DB-6 Upcoming recurring card: first the "Expected this month, not imported yet" rows (dashed border, dimmed amount, "Expected Oct 22 · <account>"), then the next 10 occurrences strictly after today across all active items, sorted by date then name, each "Due Nov 1 · <account>". The list scrolls inside the card. "Manage" goes to Recurring. No active items → "No recurring items yet" with "Manage" link.
- DB-7 Spending by category: one bar per counted, non-Income category with spending > 0 in the month, largest first, bar width relative to the largest.
- DB-8 Budget progress: one row per category with a budget this month (eligible per §4.4), "$spent / $budget", bar accent / amber at ≥ 85% / red when spent > budget; notes "$X left" (amber, near) or "Over by $X" (red). "Edit budgets" link to Budgets. No budgets → "No budgets for <Month>" + "Set budgets" link.
- DB-9 First-run empty state (zero transactions in the DB) replaces tiles/charts per README: ghost tiles with "—", "Import your first statement", "Go to Import →", "Everything stays on this laptop."
- DB-10 A month with no transactions (DB not empty) shows tiles at $0.00, "0 deposits"/"0 transactions", chart still drawn, category card "No spending in <Month>".
- DB-11 "Import CSV" button navigates to `/import`.

### 4.2 Transactions (`/transactions`) — README §2
Data: transactions in the selected month, sorted date desc then id desc; accounts; categories; rules.

- TX-1 Subtitle "N transactions · $X spent · $Y income" computed with G6 over the currently filtered list.
- TX-2 Search filters by case-insensitive substring of `description`. Account and Category dropdowns filter exactly. Filters combine with AND. Filters live in URL params (`q`, `account`, `category`) so Dashboard can deep-link. "Clear filters" appears when any is active and resets all three.
- TX-3 Amount column: income (+) green with "+", spending ink without minus sign, excluded-category rows muted with their real sign.
- TX-4 Uncategorized rows have the highlight background and amber-bordered category button.
- TX-5 Choosing a category in the inline dropdown saves immediately (PATCH) and updates tiles/badge/subtitle.
- TX-6 Rule prompt appears under the row when: new category ≠ Uncategorized, new ≠ old, `merchantKey(description)` is non-empty and ≥ 3 chars, and no rule exists with that exact merchant **and** that category. Copy per README, except the suggested text is shown in an editable box ("Rule text", uppercased as typed, Tab-reachable from the category dropdown; Enter = Create rule, Esc = Just this once). Only one prompt is open at a time; it closes on navigation, on month change, or when another row is changed.
- TX-7 "Also fixes N other uncategorized transactions." shows when N > 0, where N = Uncategorized transactions (any month, excluding this one) whose `UPPER(description)` contains the (trimmed) rule text. It refreshes live (debounced ~250ms) as the text is edited; under 3 characters it is hidden, "At least 3 characters" is shown, and Create rule is disabled.
- TX-8 Create rule: inserts the rule (using the trimmed edited text) (if a rule with the same merchant exists, its category is replaced), sets every *Uncategorized* transaction (all months) containing the key to the category, closes the prompt, toast "Rule created: KEY → Category · applied to N more" ("· applied…" omitted when N = 0). Already-categorized transactions are never changed.
- TX-9 Just this once: closes the prompt, no rule written.
- TX-10 Empty states per README in this priority: no transactions in DB → "No transactions yet"; Category filter = Uncategorized only and none left → "All caught up"; any filter active → "Nothing matches"; else "No transactions in <Month YYYY>".
- TX-11 Table scrolls horizontally inside its card under its min-width.

**merchantKey** (unit-tested): the suggested rule text. Uppercase; drop a leading processor prefix (`SQ *`, `TST*`, `PL*`, `PYL*`, `PY *`, `PAYPAL *`, `UBR*`); drop a trailing `*REF` code; cut `WEB ID:` / `PPD ID:` / `TRANSACTION#:` trailers; cut at the first reference-like token (any token with a digit, e.g. date, phone, store number, `F38545`) other than the first token, except the number after `ENDING IN`; after such a cut also drop a trailing city + 2-letter state (a city the bank truncated from the prior word is kept; with no cut, city/state stays, e.g. `SQ *JOE'S AUSTIN TX` → `JOE'S AUSTIN TX`); drop a doubled trailing city word (`… AUSTIN AUSTIN`); trim trailing spaces/hyphens. Never rewrites inner text, so the result is always a substring of the uppercased description. If the result would be < 3 chars it falls back to the form before the reference-token cut. E.g. `Trader Joe's #552 San Francisco` → `TRADER JOE'S`; `AMZN Mktp US*MK1A2` → `AMZN MKTP US`; `CHIPOTLE 0092 AUSTIN TX 08/20` → `CHIPOTLE`. `&amp;` is not decoded.

**Rule matching** (import and "Create rule"): a rule matches when `UPPER(description)` contains `merchant`. If several match, the longest `merchant` wins; ties → newest rule.

### 4.3 Import (`/import`) — README §3
Flow: Upload → (Set up file, only if format not recognized) → Review → Done. Parsing rules in §5; duplicates in §5.9.

**Step 1 Upload**
- IM-1 Drop zone and file chooser accept one or more files; drag-over styling per README. Files are processed one at a time in selection order; the header card reads "file 1 of N"; after Done for file k, "Import next file" continues with file k+1.
- IM-2 Non-`.csv` extension, file > 10 MB, binary content (contains NUL bytes) or fewer than 2 columns in every row → stay on step 1 with an inline error: "This doesn't look like a CSV export." / "This file is too large (max 10 MB)." Other selected files continue.
- IM-3 "Use a sample Chase export" loads a bundled sample CSV (generated, dated around today) through the same pipeline.
- IM-4 Recent imports card lists the import log newest first: file name (mono), account name, date, "41 new / 18 skipped" (+ " / 2 unreadable" when > 0), and an "Undo" text link (red, right-aligned) on every row. Empty → card hidden.
- IM-5 If the file's header signature equals exactly one account's saved `csv_format.header_signature`, go straight to Review with that account and format and show "Recognized your saved format for this file — no setup needed." If it matches more than one account, show Step 2 pre-filled with the saved format and no account pre-selected. The recognized banner has a "Change setup" link back to Step 2 (prefilled), because a generic header can match the wrong account's format.
- IM-24 **Undo import.** "Undo" opens a confirmation (G8): "Undo import of <file_name>? N transactions will be removed, including any you've recategorized. Rules, accounts and saved formats are kept." (N = current count of transactions with that `import_id`.) On confirm, in one SQLite transaction: delete every transaction with that `import_id` — **recategorized ones included** — delete the `imports` row, and recompute that account's `last_import_date` (latest remaining import for the account, else null). Rules, accounts, `csv_format`, categories, budgets and recurring items are untouched. The row disappears from Recent imports; toast "Import undone · N transactions removed". Cancel changes nothing.
- IM-25 After an undo, everything derived re-computes: totals, badge, recurring status (an occurrence received only by an undone transaction goes back to Expected), the G5 month range (falls back to current month if the selected month is now out of range), and the first-run state if no transactions remain. Re-importing the same file afterwards imports all its rows as new.

**Step 2 Set up this file**
- IM-6 Header card shows file name and "N rows" (data rows) and the README copy.
- IM-7 Account section lists existing accounts plus "New account". An account whose name's first word appears (case-insensitive) in the file name is pre-selected with "Detected from file name". Otherwise "New account" is pre-selected if there are no accounts, else none. New account requires a unique non-empty name and a type; the account is created **only at commit** (abandoning creates nothing).
- IM-8 Column role dropdowns are pre-filled by auto-detection (§5.5). Roles other than Ignore are unique: picking one resets the column that had it to Ignore. Raw header + first 5 data rows shown in mono.
- IM-9 Sign options per README; the detected option (§5.6) is pre-selected and labelled "detected in this file".
- IM-10 Live preview shows the first 5 data rows parsed with the current roles/sign, with Income/Spending pills, and the status line:
  - Issue (amber, Continue disabled): no Date role; no Description role; sign mode is debit/credit and Debit or Credit unmapped; sign mode isn't debit/credit and Amount unmapped; more than half of data rows fail to parse a date ("The Date column doesn't contain dates. Try a different column.") or an amount ("The Amount column doesn't contain numbers. Try a different column." / "The Debit and Credit columns don't contain amounts.").
  - Warning (amber, Continue **enabled**): more preview rows come out as income than spending — README copy.
  - OK (green): "✓ Looks right — N purchases come out as spending, M deposit(s) as income."
- IM-11 "Remember this format for <account>" is checked by default. When checked, commit stores `csv_format` on the account (overwriting any previous one). When unchecked, the account's `csv_format` is left unchanged.
- IM-12 "Continue to review" is disabled while there is an Issue or the account choice is invalid.

**Step 3 Review**
- IM-13 Banner "N rows found · M new · K already imported (skipped) · J need a category" (live; "All categorized" in green when J = 0). N = data rows; unreadable rows are counted separately (IM-16).
- IM-14 New rows table: Date, Description, Category (inline dropdown; outlined "rule" badge with tooltip "Matched rule: KEY" when the category came from a rule and wasn't overridden), Amount. Initial category = matching rule's category, else Uncategorized. Changing a category here affects only this import (no rule prompt) and removes the badge.
- IM-15 Collapsed "▸ K already imported — skipped" section, subtitle "Matched on account, date, amount and description"; expanding shows the dimmed duplicate rows.
- IM-16 When unreadable rows exist: collapsed "▸ U rows couldn't be read — skipped" section listing each with its 1-based line number and raw text. They never block the import.
- IM-17 Primary button "Import M transactions"; when M = 0 it reads "Nothing to import" and is disabled. Footer note "J uncategorized rows will come in as Uncategorized — you can sort them out later." when J > 0.
- IM-18 Commit is server-authoritative and atomic: the server re-parses the file text with the chosen format, recomputes duplicates against the DB at commit time, applies the client's per-row category overrides (keyed by row line number), creates the account if new, saves the format if remembered, inserts transactions with the new `import_id`, writes the `imports` row and `last_import_date` — all in one SQLite transaction. Any failure → nothing is written, error toast, user stays on Review.

**Step 4 Done**
- IM-19 Shows "M transactions imported", "Added to <account> · <first date> – <last date>. K duplicates were skipped." (duplicate sentence omitted when K = 0; year shown on both ends if they differ).
- IM-20 "Matched expected recurring: Name (Mon D), …" lists each active recurring occurrence that is now received (§6.2) by a newly inserted transaction and was not received before the import. Hidden when empty.
- IM-21 Buttons: Go to Dashboard (sets month to the month of `last_date`), "Categorize J remaining" (→ Transactions filtered to Uncategorized, month of `last_date`; hidden when J = 0), "Import another file" (→ step 1, cleared).
- IM-22 Stepper: completed steps are clickable to go back; future steps are not clickable. Going back to Step 2 from Review keeps the choices. After Done, Steps 1–3 are not revisitable for that file.
- IM-23 Leaving `/import` mid-flow discards the in-progress file (nothing is persisted before commit).

### 4.4 Budgets (`/budgets`) — README §4
Eligible categories: `excluded_from_totals = 0` and `system_key` not `income`/`uncategorized`.

- BU-1 Table has one row per eligible category, plus a final "Other" row ("Categories without their own budget"; budget saved via `category_id: null`, spent = eligible spending in categories with no budget that month): Monthly budget input, Spent (G6, clamped ≥ 0), Remaining (budget − spent; red "−$X" when over; "—" when no budget), progress bar + % (accent / amber ≥ 85% / red over).
- BU-2 The budget input accepts digits, one ".", up to 2 decimals; other characters are stripped. It saves ~400 ms after the last keystroke and on blur; empty or 0 deletes the budget for that month; over $100,000,000 is rejected. Saved value persists after reload.
- BU-3 Summary: Total budget = sum of the month's budgets for eligible categories plus the Other budget; Spent so far = sum of spending across **all** eligible categories (budgeted or not); Remaining = total − spent, or "Over budget" in red with the overage; bar and "N% of budget used · D days left in <Month>". D = days from today to month end inclusive of today for the current month; past months show "<Month> is over"; future months show "<Month> hasn't started".
- BU-4 "Copy last month's budgets" copies all previous-month budget rows (including Other) into the selected month (overwriting same-category values, leaving others), toast "Copied N budgets from <Month>". If the previous month has none: toast "No budgets in <Month> to copy", nothing changes. The button is primary when the selected month has no budgets.
- BU-5 Footnote: "Income, Transfer and Uncategorized aren't budgeted." (Transfer's current name is used; other excluded categories also don't appear.)
- BU-6 Budgets of a category that becomes excluded are kept in the DB but not shown or counted; they reappear if it's un-excluded.

### 4.5 Recurring (`/recurring`) — README §5
- RC-1 Table per README with Name + "matches 'TEXT'", Amount (income green "+"), Category, Account ("—" when null), Frequency, Next date (first occurrence strictly after today; equals `anchor_date` while that is in the future), status chip (§6.3), Active toggle. Inactive rows at 0.55 opacity.
- RC-2 Active toggle saves immediately; inactive items produce no expected/upcoming entries and show "Paused".
- RC-3 "Add recurring" opens the right side panel per README. Defaults: Type Expense, Category Subscriptions (Income when Type = Income; switching Income→Expense resets Income to Subscriptions), first account, Monthly, Next date = tomorrow, match text auto-fills `UPPER(name)` until the user edits it. Under Next date a 12.5px `--ink-3` hint reads "The first payment to track. Earlier ones are ignored."
- RC-4 Validation, first failing message shown: "Give it a name." / "Enter an amount greater than $0." / "Pick the next date." Amount is parsed to cents (strip `$` and `,`, up to 2 decimals). Saving stores `amount_cents` negative for Expense, positive for Income; match text uppercased and trimmed (falls back to name). Toast "<Name> added · next on <Mon D, YYYY>".
- RC-5 **Edit / Delete.** Clicking a row (outside the Active toggle) opens the same side panel pre-filled with the item, titled "Edit recurring", primary "Save" and a red "Delete" text button. Match text does not auto-fill from the name in edit mode. Save runs RC-4 validation, updates the item, toast "<Name> saved". Delete opens a confirmation (G8) "Delete <Name>? Imported transactions aren't affected." and on confirm removes the item, closes the panel, toast "<Name> deleted". Editing Next date moves the tracking start (§6.1).
- RC-6 Explainer strip with sample dashed row per README. Empty list → "No recurring items yet" + "Add recurring".
- RC-7 Panel closes on scrim click or Esc without saving.
- RC-8 Occurrences before `anchor_date` are never expected or overdue. Example (today = Oct 25): a monthly item added with Next date Nov 3 shows nothing expected in October, no expected sub-line on the October Dashboard, status "Nothing due yet", Next date "Nov 3". To track a payment that already happened (e.g. Oct 3), the user enters that earlier date as Next date.

### 4.6 Settings (`/settings`) — README §6
- ST-1 Appearance segmented control = theme toggle (SH-5).
- ST-2 Accounts table: Name, Type, Saved CSV format (label per §3 or muted "Not saved — asks on next import"), Last import date ("—" if never). Account name and type are editable inline (unique name). "Forget format" text link clears `csv_format`.
- ST-3 Categories: color swatch opens the 11-swatch picker and saves on pick. Name is an inline input saved on blur/Enter; empty or duplicate (case-insensitive) name reverts with toast "A category named X already exists". Locked categories' name input is read-only. Because everything references `category_id`, the rename shows up immediately in transactions, rules, recurring items, budgets and filters.
- ST-4 Each row shows "N transactions" (prefixed "Built-in · " for system categories). "Exclude from totals" toggle on all except Income and Uncategorized; toggling immediately changes every total (G6).
- ST-5 Add category: trimmed non-empty unique name, next swatch color in rotation, inserted before Income, toast "Added X". User categories reorder by drag handle or ↑/↓ buttons (`PUT /api/categories/order`); built-ins stay pinned at the bottom.
- ST-6 **Delete category.** Only user categories (`system_key` null) show a red "Delete" text link; Income, Transfer and Uncategorized never do. Confirmation (G8): "Delete X? Its N transactions and M recurring items become Uncategorized, and its R rules and its budgets are removed." On confirm, in one SQLite transaction: transactions and recurring items with that category → Uncategorized; its rules and all its budget rows (every month) deleted; category deleted. Toast "Deleted X".
- ST-7 Rules live under their category: each category row has a "N rules" / "No rules" disclosure button that expands its rules (sorted by merchant; several can be open). Each rule: mono merchant chip → category dot + name, Edit inline (merchant input uppercased on save, ≥ 3 chars, unique; category dropdown; Save / Cancel; toast "Rule saved"). Delete removes it immediately with toast "Rule deleted". Editing or deleting a rule never changes existing transactions; it only affects future imports and future "Create rule" sweeps.
- ST-7a "Reapply rules" button in the Categories section header (hint "Fills in Uncategorized transactions only."; disabled with no rules): runs every rule over all Uncategorized transactions with import precedence; categorized rows and rules pointing at Uncategorized change nothing. Toast "Rules applied · N transactions categorized" or "No uncategorized transactions matched a rule"; nav badge refreshes.
- ST-8 (removed from the UI; API kept) Load sample data: confirmation (G8, "This replaces all your data with sample data.") when the DB has any transactions; then replaces all data with the seeded sample set (accounts, ~6 months of transactions ending today grouped into `imports` rows, rules, recurring items with anchors in the past, budgets), navigates to Dashboard, toast "Sample data loaded".
- ST-9 (removed from the UI; API kept) Erase all data: confirmation (G8, "Erase all data? This deletes every transaction, account, rule, budget and recurring item on this laptop. This can't be undone.") then deletes all rows in all tables and re-seeds the default categories; navigates to Dashboard showing the first-run state (DB-9), toast "All data erased". Theme is kept.

## 5. CSV parsing (shared pure module in `shared/`, used for preview and re-run by the server at commit)

- **5.1 Decoding**: read as UTF-8; strip a leading BOM (`﻿`). Accept `\r\n`, `\n`, `\r` line endings.
- **5.2 Tokenizing**: RFC 4180, comma delimiter. Fields may be double-quoted; inside quotes, `""` is a literal quote and commas/newlines are literal. Unquoted fields are trimmed. A row whose cells are all empty/whitespace is a **blank row** and is ignored silently (not counted anywhere).
- **5.3 Header detection & signature**: the header row is the first non-blank row (within the first 15 non-blank rows) where no cell parses as a date or an amount and the next non-blank row has the same cell count (ignoring trailing empty cells — trailing commas) and a cell that parses as a date. Rows above the header (bank preambles) are ignored. If none qualifies, the file has no header (`has_header = false`) and columns are labelled "Column 1…N". `header_signature` = header cells lowercased, trimmed, inner whitespace collapsed, trailing empty cells dropped, joined with `|` (e.g. `details|posting date|description|amount|type|balance|check or slip #`); headerless files use `#columns=N`.
- **5.4 Dates**: accept `M/D/YYYY`, `MM/DD/YYYY`, `M/D/YY` (→ 20YY), `YYYY-MM-DD`, `YYYY/MM/DD`. Values must be real calendar dates (e.g. `02/30/2026` fails) with years 1900–2099; anything else makes the row unreadable. `date_format` = `YMD` if the date column's values start with 4 digits, else `MDY`. Day-first (`DD/MM`) is not supported.
- **5.5 Column auto-detection** (header names, case-insensitive; first match wins): Date ← `transaction date`, `trans date`, then any containing `date`; Description ← `description`, `payee`, `merchant`, `name`, `memo`, `details`; Amount ← containing `amount`; Debit ← `debit`, `withdrawal`; Credit ← `credit`, `deposit`. If Debit and Credit are both found and Amount isn't, both are mapped. Without a header (or no match): Date = first column whose values parse as dates, Amount = first other column whose values parse as amounts, Description = the remaining column with the longest average text. Everything else = Ignore.
- **5.6 Sign mode detection**: Debit and Credit mapped → `debit_credit`; else if more than half of parsed amounts are negative → `purchases_negative`; else `purchases_positive`.
- **5.7 Amounts → cents** (string parsing, no floats): strip `$`, `,`, spaces; `(x)` → negative; leading `-` or `+`, and `-$12.00` / `$-12.00`; 0–2 decimal places (`12`, `12.5`, `12.50`); more than 2 decimals or any other character → unparseable. Then:
  - `purchases_negative`: amount as-is.
  - `purchases_positive`: amount negated.
  - `debit_credit`: `abs(credit) − abs(debit)`; an empty cell counts as 0; both empty or either unparseable → unparseable row.
- **5.8 Row validity**: a data row is **unreadable** if its date doesn't parse, its amount doesn't parse, or its description is empty. Unreadable rows (including bank trailer/summary lines like "Total" or "Ending balance") are skipped and reported with line number and raw text (IM-16). Rows with fewer/more cells than the header are parsed by position; missing cells are empty.
- **5.9 Duplicates** — key = `(account_id, date, amount_cents, UPPER(description))`, with description whitespace-normalized per §3 and compared **case-insensitively** (JS `toUpperCase()` on both sides; candidates fetched via the `(account_id, date, amount_cents)` index). The stored description keeps the casing of the first import. **Count-based**: for each key, let `s` = number of stored transactions with that key and `f` = number of rows in the file with that key (in file order); the first `min(s, f)` file rows are duplicates and the remaining `f − s` are new. So two identical $5 coffees on the same day in one file both import the first time and both skip on re-import; a later statement that adds a third identical coffee imports just that one. `Trader Joe's #552` and `TRADER JOE'S #552` on the same day/amount/account are the same transaction.
- **5.10 Limits**: files up to 10 MB; preview + review must stay responsive for 10,000 data rows (review table may virtualize or render progressively, but all new rows are importable and recategorizable).

## 6. Recurring logic (shared module)

- **6.1 Occurrences** of an item between `from` and `to` inclusive (adapted from prototype `occ`, unit-tested). **Generation starts at `anchor_date`; there are no occurrences before it** (unlike the prototype). "Next date" in the UI therefore means "first payment to track".
  - `monthly`: one per month from the anchor month onward on the anchor's day-of-month, clamped to the month's last day (anchor Jan 31 → Feb 28/29, Mar 31; the clamp never drifts the day).
  - `yearly`: anchor's month/day each year from the anchor year; Feb 29 → Feb 28 in non-leap years.
  - `biweekly`: `anchor_date + 14k` days for k ≥ 0.
- **6.2 Received**: an occurrence on date `d` is received if some transaction (any account) has `UPPER(description)` containing `match_text`, `sign(amount_cents) = sign(item.amount_cents)`, and `|date − d| ≤ 4` days.
- **6.3 Status chip** (relative to today, independent of the selected month): inactive → "Paused"; let `last` = latest occurrence in `[today − 45 days, today]`: none (including anchor still in the future) → "Nothing due yet"; received → "✓ Received <Mon D>" (solid); else "Expected <Mon D> · not imported" (dashed).
- **6.4 Expected (Dashboard)**: for the selected month, every active item's occurrences in `[month start, min(month end, today)]` that are not received. Future months have none. Expected income = sum of positive amounts; expected spending = sum of |negative amounts|. These only drive sub-lines and the dashed rows; they are **never** added to Income/Spent/Net, budgets or charts.
- **6.5 Upcoming**: next 10 occurrences strictly after today across active items (DB-6), independent of the selected month.

## 7. Edge cases and failure states

1. **Empty DB / first run**: Dashboard DB-9; Transactions "No transactions yet"; Budgets lists eligible categories with $0 spent and the copy button primary; Recurring empty state; Settings shows seeded categories, no accounts, no rules; month picker limited to current month and next.
2. **Month with no data**: DB-10, TX-10 "No transactions in <Month YYYY>", budgets show $0 spent.
3. **Over budget**: red bar, "Over by $X", Remaining "−$X", summary "Over budget"; a category budget with only refunds shows $0 spent (clamped).
4. **Spent negative overall** (more refunds than purchases): Spent tile shows the negative value as "−$X"; chart clamps the spending bar at 0.
5. **Category rename**: id-based, so every screen reflects the new name after refetch; open filters stay on the same category id; duplicate names rejected (ST-3).
6. **Delete category**: ST-6; an open Transactions filter on that category resets to "All"; rules for it are gone, so future imports land those merchants in Uncategorized.
7. **Delete/edit rule**: ST-7; never rewrites existing transactions.
8. **Rule on a key that already has a rule with another category**: Create rule replaces the category (TX-8).
9. **Recategorize to Uncategorized**: allowed, no prompt.
10. **merchantKey empty or < 3 chars** (e.g. description "#123"): no prompt. The user may edit the suggested text; Create rule requires >= 3 chars.
11. **Erase all data** (API only; no UI since 2026-10-26): ST-9; any in-progress import is discarded; returns first-run state.
12. **Load sample data over real data** (API only; no UI since 2026-10-26): ST-8.
13. **Very large CSV**: > 10 MB rejected (IM-2); up to 10,000 rows works (5.10); commit is one transaction so a crash mid-insert leaves nothing half-imported.
14. **Wrong file type** (PDF, XLSX, image renamed .csv, empty file): IM-2 error; empty or header-only file → "This file has no transactions in it."
15. **Re-import of the same file**: all rows duplicates → "0 new / N skipped", "Nothing to import" disabled; no import log entry is written.
16. **Overlapping statements**: only the non-overlapping rows import (5.9).
17. **Identical rows within one file**: count-based rule (5.9).
18. **Same transaction in two accounts** (card payment): not a duplicate, different `account_id`.
19. **Unparseable rows / trailers / preambles**: 5.3, 5.8, IM-16.
20. **Header-only signature collision** across two accounts: IM-5 asks for the account.
21. **Bank changes its column layout**: signature no longer matches → Step 2 again; saving overwrites the old format.
22. **Format remembered but wrong** (e.g. wrong sign convention): fix = Undo the bad import in Recent imports (IM-24) → "Forget format" for that account in Settings (ST-2) → re-import the file, which goes through Step 2 again. Any recategorizations made on the undone rows are lost (the confirmation says so); rules created from them remain and re-apply on re-import.
23. **Multiple files at once**: processed sequentially; duplicates between file 1 and file 2 are caught because file 2 is previewed after file 1 commits.
24. **Zero-amount rows**: imported; they don't affect totals.
25. **Dates far in the past/future in a CSV**: imported as-is (years outside 1900–2099 are unreadable); the month range (G5) extends back to them; future-dated rows beyond next month are imported but not reachable via the picker in v1.
26. **Recurring with no account** or account later renamed: shows "—"/new name.
27. **Monthly item on the 31st, yearly on Feb 29**: 6.1 clamping.
28. **Two recurring items with overlapping match text** (e.g. "AMAZON" and "AMAZON PRIME"): each is matched independently; one transaction can satisfy both — accepted for v1.
29. **Server not running / API error**: SH-8 toast; Import commit and undo leave state untouched (IM-18, IM-24).
30. **Budget input junk** ("abc", "1.2.3", "12.345"): stripped/limited to a valid amount (BU-2).
31. **Month param invalid or out of range** (`?month=2026-13`): falls back to current month.
32. **Undo an older import when a later import overlaps it**: only the undone import's own rows are removed; the later import's rows stay (they were inserted as new, not as duplicates, so nothing is "missing"). Re-importing the undone file restores only the rows not already present.
33. **Undo the only import of an account**: account stays with `last_import_date` null and its saved format intact.
34. **Recurring Next date in the past** (e.g. user enters Oct 3 on Oct 25): occurrences from Oct 3 are tracked; if no match, Oct 3 shows as expected immediately.
35. **Recurring Next date moved later via Edit**: earlier occurrences stop being tracked, so an existing "Expected" chip can become "Nothing due yet".
36. **Description casing changes between exports**: treated as duplicates (5.9).

## 8. Tests (Vitest, minimum)
Unit tests for: CSV tokenizer (quotes, embedded commas/newlines, BOM, CRLF), header detection, date parsing, amount → cents (every format in 5.7), sign modes, count-based and case-insensitive duplicates, `merchantKey`, rule precedence, occurrence math (starts at anchor, month-end clamp, leap year, biweekly), received matching, G6 totals with excluded categories and refunds. API tests for import commit atomicity, undo import (removes recategorized rows too, recomputes `last_import_date`, leaves rules/accounts/formats), category delete cascade, recurring edit/delete.

## 9. Assumptions and resolved questions

Assumptions (made to unblock the build; confirm or overturn):
- A1 JSON uses the same snake_case names as the DB (G4); categories are referenced by id.
- A2 Duplicate detection is count-based within a file and compares descriptions case-insensitively after whitespace normalization (5.9).
- A3 Rule precedence: longest merchant wins, ties → newest. Rule merchants need ≥ 3 chars.
- A4 Rules created on Transactions sweep only *Uncategorized* transactions in all months; review-step recategorization does not offer a rule.
- A5 Received matching ignores account and amount (prototype behavior); only text, sign, ±4 days.
- A6 Upcoming shows the next 10 *occurrences* (README) rather than one per item (prototype).
- A7 Month range = earliest data month through current month + 1 (confirmed, Q5).
- A8 Unreadable rows are skipped and listed, never block import; there's a new collapsed section for them (not in design).
- A9 Only US date formats (month-first) and comma delimiters are supported.
- A10 Accounts are created at commit, not at Step 2.
- A11 One shared confirm dialog (G8) for destructive actions; the design has none.
- A12 Account rename/type edit and "Forget format" in Settings (not in design).
- A13 Zero-amount rows are imported.
- A14 Sample data is generated relative to today, grouped into `imports` rows (so it can be undone like any import), with recurring anchors in the past.
- A15 New copy not in the design: the Next date hint (RC-3), "Edit recurring" panel title, undo/delete confirmation texts and toasts.

Resolved (user, 2026-10-25):
- Q1 Undo a whole import — **yes**: "Undo" per Recent imports row with confirmation; deletes all its transactions (recategorized ones included) and the `imports` row; rules/accounts/formats untouched; `last_import_date` recomputed (IM-24, IM-25).
- Q2 Fixing a wrong-sign format — Undo import → Forget format → re-import (edge case 22).
- Q3 Category delete and recurring edit/delete — **yes**, both with confirmation; system categories can't be deleted (ST-6, RC-5).
- Q4 Occurrences before `anchor_date` — **never** expected/overdue; generation starts at the anchor (6.1, RC-8).
- Q5 Month range — keep A7.
- Q6 Case-insensitive duplicate descriptions — **yes** (5.9, A2).

No open questions remain.
