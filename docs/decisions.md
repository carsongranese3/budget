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
