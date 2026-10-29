# Decisions

## 2026-10-25 — Project setup
- **Local-only web app.** Runs on the user's machine; no hosting, no auth. Financial data never leaves the machine.
- **Input is CSV statement import only.** The user doesn't want manual entry as the main path. PDF parsing (via Claude API) and bank sync (Plaid) were considered and declined for v1.
- **Categorization by learned merchant rules.** Recategorizing a transaction offers to create or update a rule for that merchant. No LLM.
- **v1 scope:** CSV import (1–2 accounts), auto-categorize, monthly category budgets, dashboard + charts, recurring transactions.
- **Stack:** TypeScript / Node 20, Express + better-sqlite3, React + Vite, Tailwind, Recharts, Vitest. Money stored as integer cents.
- **Prototype:** built as a Claude Design artifact before the spec; screens pulled into `design/`.

## 2026-10-25 — Design pulled
- **Prototype:** claude.ai/design project `c1a59d7f-…` pulled into `design/` (`Budget.dc.html`, `support.js`, handoff `README.md`); mapping in `docs/design.md`. High fidelity — the build matches its tokens, copy and layout (top-bar layout "1d").
- **Fonts are self-hosted** (`@fontsource/geist`, `@fontsource/geist-mono`), not loaded from Google Fonts, to keep the no-third-party-requests rule.
- **Theme** preference lives in the browser (`localStorage`); all financial data lives in SQLite through the API.
- **Duplicate detection** = same account + date + amount + description (the design says date + amount + description; scoped per account so a card payment showing on both accounts isn't dropped).
- **Recurring match** = transaction description contains the match text, same sign, within ±4 days of the occurrence (from the design).

## 2026-10-25 — Spec questions resolved (`specs/budget-v1.md`)
- **Undo import:** a whole import can be undone from Recent imports. It deletes every transaction with that `import_id`, including recategorized ones; rules, accounts and formats are kept. `transactions.import_id` is NOT NULL (sample data creates its own imports). The wrong-sign fix is Undo → Forget format → re-import.
- **Deletes:** user categories can be deleted (transactions and recurring items move to Uncategorized; its rules and budgets are removed). System categories can't be deleted. Recurring items get Edit (the side panel) and Delete. One shared confirmation dialog for destructive actions.
- **Duplicates** compare `UPPER(description)` after collapsing whitespace, per account + date + amount_cents, count-based.
- **Recurring** occurrences start at `anchor_date`; nothing before it is ever "expected".
- **Month picker** range: earliest month with data through next month.

## 2026-10-25 — API contract (`docs/api.md`)
- CSV goes to the server as JSON `{ file_name, content }` (UTF-8 text, ≤10 MB; body limit 15 MB). Commit re-parses and re-checks duplicates server-side; client-computed rows are ignored.
- Error shape `{ error: { code, message } }`. JSON uses real booleans. Bad `month` → 400, never silently falls back.
- Pure logic (CSV parser, merchant key, totals, recurring math) lives in `shared/` so the server and the web app use the same code; Step 2's live preview runs client-side.
- API on 5174, Vite on 5173 proxying `/api`. DB at `data/budget.db` (`BUDGET_DB` overrides; `:memory:` in tests).
- `.npmrc` sets `legacy-peer-deps=true` to work around an npm install error with Vite 8.

## 2026-10-25 — Slice 1 gate
- **Security (High, fixed in slice 1):** CSRF — a body-less cross-origin POST to `/api/sample-data` could wipe data. Every non-GET API request must be `Content-Type: application/json` with a localhost `Origin` (if present); the client always sends JSON.
- **Parser hardening:** records over 200 columns are rejected as invalid files; amounts are capped at 12 integer digits (else unreadable) so cents stay safe integers.
- **Header detection ignores trailing empty cells** when comparing header vs data row width (real Chase exports have trailing commas). Supersedes spec §5.3's strict equal-count rule.
- **A recognized saved format can be overridden:** Review shows a "Change setup" link back to Step 2 (prefilled), because a generic `Date,Description,Amount` header can match the wrong account's format.

## 2026-10-25 — Slice 1 shipped (Import, Transactions, Settings)
- Gate: QA GO (third pass) + security GO. 70 Vitest tests.
- Transactions query string is built by the pure `txQuery` in `web/src/lib.ts`; invalid or empty filters are omitted (treated as All).
- When two accounts save the same header signature, a matching file is not auto-recognized; Step 2 asks for the account.
- Open for slice 2: per G6, Uncategorized deposits net against "spent", so an uncategorized paycheck makes Spent negative. Revisit before the Dashboard tiles ship.

## 2026-10-25 — Slice 2 start
- **G6 change (user approved):** Uncategorized deposits (amount > 0) are excluded from Spent, Income and Net until categorized; Uncategorized money-out still counts as spending. Refunds in real categories still reduce Spent. Spec G6 updated; `shared/totals.ts` must follow. No contract change.
- Work is committed on branch `build/v1` (slice 1 = 6a9d2cc); merge to `main` after v1.

## 2026-10-25 — Slice 2 shipped (Dashboard, Budgets)
- Gate: QA GO (G6 totals hand-verified to the cent across 8 months) + security GO. 86 Vitest tests.
- Dashboard chart is hand-rolled HTML/CSS (native `<button>` per month for keyboard + aria), not Recharts — exact match to the design with less code.
- Budgets: cap $100M per category; months limited to 1900–2099; "can't be budgeted" message and the footnote use current category names; copy skips ineligible categories; summary shows overage as a positive amount under "Over budget".
- Follow-up fixes after the gate (footnote, save race, over-budget styling) were verified by build/tests only; slice 3 QA re-checks them in the browser.

## 2026-10-25 — Slice 3 shipped (Recurring) — v1 feature-complete
- Gate: QA GO (third pass; Row A heights measured at 1440/1100/800) + security GO. 114 Vitest tests.
- Occurrence math lives in `shared/recurring.ts` (pure, `today` injected). `next_date` is always a string (anchor while in the future). Import matching (`newlyReceived`) only checks occurrences within ±4 days of an imported row, so decade-spanning CSVs stay fast.
- CSV dates outside 1900–2099 are unreadable rows; server validation messages use human field labels.
- Side panel and confirm are native `<dialog showModal>`; toasts are `popover="manual"` so they render above an open dialog. Esc inside a `Select` closes only the menu.
- Dates outside the current year render with the year (`fmtDateY`).
- When every recurring item is paused, the Dashboard card shows "No recurring items yet" (spec DB-6), not "Nothing coming up."
- Removed the unused `recharts` dependency (the chart is hand-rolled).

## Shortcut ledger (from /ponytail-debt and builder reports)
- `web/src/pages/Import.tsx:21` — review table renders 200 rows at a time (all rows still import). Upgrade: virtualize if it feels slow.
- Account/category name uniqueness uses SQLite `NOCASE` (ASCII-only). Upgrade: if non-ASCII names collide unexpectedly.
- Description matching for duplicates/rules runs a JS `ujs()` function in SQL (no index). Upgrade: if imports or rule application get slow (tens of thousands of rows).
- Summary/budgets aggregate the window's rows in JS (reuses the shared G6 function) rather than in SQL. Upgrade: same trigger.
- Origin allowlist accepts any loopback port; other local processes can call the API (they could already read the DB file). Upgrade: pin to 5173/5174 if the app ever runs alongside untrusted local web apps.
- Recurring table scrolls horizontally below ~960px (per design: tables scroll inside cards).

## 2026-10-25 — Dashboard chart: click opens Transactions, centered 7-month window
- Clicking a month's bars opens `/transactions` for that month (`?month=` omitted when it's the current month); it no longer selects the month. The top-bar ‹ › arrows are the way to change the selected month.
- The chart shows **7 months** (was 6) with the selected month centered: ideal window = selected −3 … +3. Window end = min(max(selected+3, earliest_month+6), max(current_month, selected)); start = end − 6. So it never runs past the current month unless next month is selected, slides right near the first data month, and with < 7 months of data it ends at the current month and earlier months stay inert.
- Contract: `/api/summary` takes optional `series_end` (default `month`); `series` is 7 entries ending at it. Supersedes spec DB-5's "6 months ending at the selected month … click selects".

## 2026-10-26 — Budgets "Other" row; Settings Data section removed
- **Other (Budgets page only):** a final row whose Spent = sum of eligible categories with no budget that month (per-item clamped), with its own monthly budget stored in a new `other_budgets(month PK, amount_cents > 0)` table (migration 2). Not a category: can't be assigned to transactions; Dashboard budget progress ignores it.
- Contract: `BudgetsResponse.other = { budget_cents|null, spent_cents }`; `total_budget_cents` includes Other's budget; top-level `spent_cents` unchanged (already includes unbudgeted spend). `PUT /api/budgets` with `category_id: null` sets Other (missing `category_id` is still 400). Copy last month includes Other and counts it in `copied_count`. Erase-all clears `other_budgets`.
- **Settings "Data" section removed** at the user's request (no Load sample data / Erase all data buttons). `POST /api/sample-data` and `DELETE /api/data` stay in the API — tests and QA use them to set up throwaway DBs. Supersedes spec ST-8/ST-9 as UI.

## 2026-10-26 — Smarter rule suggestions + editable rule text
- Rules still match by plain substring of `UPPER(description)`; `merchantKey` only produces the *suggested* text. So the suggestion must always be a contiguous substring of the uppercased description (strip from the ends only; never rewrite inner text).
- `merchantKey` now strips: leading processor prefixes (`SQ *`, `TST*`, `PL*`, `PYL*`, `PAYPAL *`, `PY *`…), and from the right: dates (`MM/DD`), phone numbers, reference codes and everything after them (`WEB ID:`, `PPD ID:`, `TRANSACTION#:`, Zelle codes), trailing store numbers in forms like `#425`, `0092`, `F38545`, `Q26`, `T-3250`, and a trailing city + 2-letter state.
- `&amp;` is NOT decoded (stored descriptions keep it; decoding would break substring matching and duplicate detection on re-import). The user can edit the rule text instead.
- The Transactions rule prompt shows the suggested text in an editable box; the "Also fixes N" count refreshes as they type (debounced); Create rule disabled under 3 characters; Enter creates, Esc dismisses.
- Existing rules are not rewritten automatically; cleanup is offered to the user separately.
- Also strips a `UBR*` prefix and a doubled trailing city (`… AUSTIN AUSTIN`). Known limit: city/state is only stripped after a digit/date cut, so `SQ *JOE'S AUSTIN TX` suggests `JOE'S AUSTIN TX` (user edits the box).
- On real data (local check, not committed): 235 distinct descriptions → 130 suggestions, all substrings of their description.
- Prompt closes before the POST (focus returns to the row's category button); a failed save shows the error toast and the edited text is lost — re-pick the category to get the prompt back.

## 2026-10-26 — Settings "Reapply rules" button
- Settings → Rules gets a "Reapply rules" button. It runs every rule over all **Uncategorized** transactions (all months) using the same precedence as import (longest merchant first, then newest); already-categorized transactions are never changed. No confirmation needed (only fills in Uncategorized).
- Contract: `POST /api/rules/apply` (body `{}`) → 200 `{ "applied_count": number }`. Toast "Rules applied · N transactions categorized" (or "No uncategorized transactions matched a rule").
- A rule whose category is Uncategorized never counts as applied (QA fix).

## 2026-10-26 — Settings: rules grouped under categories; reorderable categories
- The separate Rules section is removed. Each category row in Settings → Categories can be expanded (click the row's chevron / rule count) to show its rules in alphabetical order, with the existing inline edit/delete. Editing a rule's category moves it to that group. "Reapply rules" moves to the Categories section header.
- User categories are reorderable by drag handle (native HTML drag-and-drop, no new dependency) and ↑/↓ buttons (keyboard/touch). The order is the existing `sort_order`, so it applies everywhere (Settings, Budgets rows, all category dropdowns, spending lists).
- Built-ins (Income, Transfer, Uncategorized) are pinned at the bottom in their current relative order and can't be moved; new categories keep being inserted above them.
- Contract: `PUT /api/categories/order` body `{ "ids": number[] }` = every non-system category id exactly once in the new order → 200 `CategoryWithCounts[]` (same as GET /api/categories). Any missing/extra/duplicate/system id → 400.

## 2026-10-28 — Transaction detail drawer: note, custom description, receipts
- Only the Transactions page lists saved transactions (Dashboard/Budgets/Recurring show aggregates; Import rows aren't saved yet), so the detail view hooks there only. Clicking a row (not the category Select) opens a right-side `<dialog>` drawer, copying the Recurring `Panel` pattern.
- New nullable columns on `transactions`: `note`, `custom_description`. The original bank `description` is never edited — import dedupe matches on it. The list shows `custom_description ?? description`.
- `PATCH /api/transactions/:id` now accepts any subset of `category_id`, `note`, `custom_description` (empty string / null clears the text fields). Category changes from the drawer keep the "make this a rule?" prompt.
- Receipts: many per transaction, stored as BLOBs in a new `receipts` table (`ON DELETE CASCADE`), so all data stays in the one git-ignored DB file — no receipts folder, nothing new to ignore, `:memory:` tests work, erase/undo-import clean up.
- Upload is base64 in JSON (`{file_name, content_base64}`), not multipart — keeps the JSON-only CSRF guard intact. Max 10 MB decoded; PNG/JPEG/WebP/PDF only, checked by magic bytes server-side (client MIME and file name are not trusted). HEIC not supported (browsers can't render it).
- Files served by `GET /api/receipts/:id` with the sniffed Content-Type, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` with a sanitized filename, and a restrictive CSP.
- `Transaction` gains `receipt_count` for the 📎 row indicator.
- **Real-DB guard (2026-10-28):** an agent run seeded sample data into the user's real `data/budget.db` (which erases first). `POST /api/sample-data` and `DELETE /api/data` now return 403 `forbidden` when the DB resolves to `data/budget.db` from the server's cwd; `:memory:` and any other `BUDGET_DB` path still work. Agent-file rules alone didn't prevent it, so it's enforced in code.
- **Category drag preview (2026-10-28):** while dragging, the category list reorders live, with the dragged row faded as the placeholder. This replaces the insertion line. Drop saves exactly the previewed order; Escape or dropping outside reverts.
