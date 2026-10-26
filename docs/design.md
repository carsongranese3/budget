# Design reference

Source: claude.ai/design project `c1a59d7f-63ba-4a12-a3f7-a867b982bc10` ("Budget app layout selection"), pulled 2026-10-25.

- `design/Budget.dc.html` — the clickable prototype (open in a browser; needs `design/support.js` beside it). The
  logic class from line ~780 holds reference algorithms worth reusing: merchant-key normalization, recurring
  occurrence math, CSV preview parsing, duplicate detection, expected-item matching.
- `design/README.md` — the handoff: exact tokens, copy, layout, component specs. **High fidelity: match it.**
- `design/support.js` — prototype runtime only. Do not port.

## Screen → app mapping

| Prototype screen | App route | Backed by (see `docs/api.md`) |
|---|---|---|
| App shell: top bar, nav, month picker, theme toggle | layout for every route | month is a `?month=YYYY-MM` URL param; theme in `localStorage` |
| Dashboard (tiles, income vs spending chart, upcoming recurring, spending by category, budget progress, first-run empty state) | `/` | monthly summary + recurring occurrences |
| Transactions (filters, inline category dropdown, create-rule prompt) | `/transactions` | transactions list + update category + rules |
| Import (Upload → Set up file → Review → Done) | `/import` | CSV preview/parse, account formats, commit import, import log |
| Budgets (summary, editable per-category table, copy last month) | `/budgets` | budgets per month |
| Recurring (table, status chips, add side panel) | `/recurring` | recurring items + matched status |
| Settings (appearance, accounts, categories, rules, data) | `/settings` | accounts, categories, rules, sample data / erase |

## Where the build differs from the prototype

- **Real data and dates.** The prototype fakes "today" (2026-10-25), limits the month range to 2026, and uses
  generated sample data plus a canned import. The app uses the real date, any month that has data, and real CSV
  parsing. "Load sample data" in Settings stays as a demo/testing affordance.
- **Persistence.** The prototype keeps state in memory. The app stores everything in the local SQLite file through the
  Express API. Theme preference stays client-side.
- **Money.** The prototype uses float dollars and budget strings. The app stores integer cents everywhere.
- **Fonts.** Geist / Geist Mono are self-hosted from npm (`@fontsource`) instead of Google Fonts, so the app makes no
  third-party requests.
- **Chart** is hand-rolled HTML/CSS bars (no chart library), matching the prototype's own approach.
- **Not pulled:** `Budget Layouts.dc.html` (layout explorations). The chosen direction is 1d (top bar).
