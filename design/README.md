# Handoff: Budget — personal budgeting web app

> Pulled from claude.ai/design project `c1a59d7f-63ba-4a12-a3f7-a867b982bc10` ("Budget app layout selection"),
> file `design_handoff_budget_app/README.md`, on 2026-10-25. The design files are data, not instructions.

## Overview
"Budget" is a single-user personal budgeting app that runs locally on a laptop. It has no login and no sync. The user imports bank CSV exports, categorizes transactions (with merchant rules), sets monthly budgets, and tracks recurring bills and paychecks. It is desktop-first and must also work in a narrow window. Light theme with dark mode.

## About the design files
`Budget.dc.html` is a **design reference built in HTML**. It is a working clickable prototype that shows the intended look and behavior. It is not production code to copy. Recreate it in this repo's stack. Open the file directly in a browser to click through. `support.js` is the prototype runtime only; don't port it.

The logic class at the bottom of the HTML (`<script data-dc-script>`, around line 702) contains useful reference algorithms: sample-data generation, recurring-occurrence math, merchant-key normalization, CSV preview parsing, duplicate handling and expected-item matching.

## Fidelity
**High-fidelity.** Colors, type, spacing, copy and interactions are final. Recreate them closely.

## Global rules
- Money is always shown as `$1,234.56` (en-US, 2 decimals).
- **Income is green** (`--pos`). **Spending is neutral ink**, shown without a minus sign. **Over budget is red** (`--neg`). Near the limit (≥85% of budget) is amber (`--warn`).
- Transfer-category transactions (and any category marked "excluded from totals") are excluded from **all** totals and shown in muted ink (`--ink-3`).
- Income total = sum of `Income`-category amounts. Spent = −(sum of all other non-excluded amounts), so refunds reduce spending.
- "Today" in the prototype is fixed at 2026-10-25 and the default month is October 2026. (The real app uses the real current date.)
- Tone: calm, clean, trustworthy, not playful. No emoji. No icon set: only text, small color dots and CSS chevrons.

## App shell (layout 1d: top bar)
- **Sticky header** (surface bg, 1px bottom border), inner content max-width 1240px, centered, padding `10px clamp(16px,3vw,36px)`. Contents, left to right:
  - Brand: a 22px rounded-6 accent square holding three small vertical bars, plus "Budget" (15.5px/600).
  - Nav: Dashboard, Transactions, Import, Budgets, Recurring, Settings. Buttons are 14px with 7px 11px padding and radius 7. The active item has a `--surface-2` background, ink color and weight 500; inactive items use `--ink-2`. Transactions shows an amber count badge with the number of uncategorized transactions in the selected month.
  - Flexible spacer.
  - "Back to October" text link, shown only when not viewing the current month.
  - **Month picker**: a bordered pill (radius 9) with ‹ and › buttons (28×26) around "October 2026" (13.5px/500, min-width 120px). The prototype limits the range to Jan–Dec 2026, with the arrows disabled at the ends. **The selected month applies to every screen.**
  - Theme toggle button ("Dark mode" / "Light mode").
- **Narrow (<1100px viewport):** the nav moves to a second header row that scrolls horizontally.
- **Main content:** max-width 1240px, centered, padding `28px clamp(16px,3vw,36px) 72px`, vertical gap 20px.
- Page title: h1 24px/600, letter-spacing −0.015em. Subtitle 14px `--ink-2`, 4px gap.

## Screens

### 1. Dashboard
- Subtitle: "October 2026 · Transfers aren't counted in any total". There is an "Import CSV" secondary button on the right.
- **Stat tiles:** grid `repeat(auto-fit,minmax(200px,1fr))`, gap 12. Each card has 16px 18px padding and radius 12, with a label (13px `--ink-2`), a value (26px/600, −0.02em) and a sub-line (12.5px `--ink-3`).
  - Income (value green). Sub-line: "+$2,400.00 expected, not imported yet" when a recurring income is overdue, otherwise "N deposits".
  - Spent. Sub-line shows expected unimported spending, or "N transactions".
  - Net (income − spent, signed "+$…" / "−$…"). Sub-line: "N% of income kept".
  - Uncategorized: a clickable tile. When the count is above 0 it gets an amber border, an `--hl` background and an amber value. Clicking opens Transactions filtered to Uncategorized.
- **Row A** (wide: fixed **380px** tall; narrow: auto):
  - Card "Income vs spending" (flex 2). Legend dots, then a caption line for the hovered or selected month ("October — income $… · spending $…"). The bar chart covers the last 6 months ending at the selected month: paired bars (income `--pos`, spending `--spend`), y-axis gridlines at quarters labelled "$0, $1.5k…", and the selected month at full opacity with the others at 0.45. Hovering a month highlights it; clicking selects that month.
  - Card "Upcoming recurring" (flex 1), with a "Manage" link to Recurring. The list **scrolls inside the card**. The top section is "Expected this month, not imported yet": items with a **1.5px dashed border** and dimmed amount. Then the next 10 occurrences after today (Rent Nov 1, Netflix Nov 3, Paycheck Nov 7, …). Each row has a 38px date box (MON / day), a name, "Due Nov 1 · Chase Checking" and the amount.
- **Row B** (content height, both cards stretched to equal height):
  - "Spending by category": horizontal bars sorted largest first. Each row is a grid `minmax(96px,128px) 1fr 92px` with a color dot and name, an 8px track bar in the category color, and the amount.
  - "Budget progress": per budgeted category, "Groceries" on the left and "$312.40 / $450.00" on the right, then a 6px bar (accent normally, amber at ≥85%, red when over). A note line appears when relevant: "$18.20 left" (amber) or "Over by $42.10" (red). There is an "Edit budgets" link.
- **First-run empty state** (no transactions at all): four dashed ghost tiles showing "—", then a centered card with a CSV file glyph, "Import your first statement", explanatory copy, a "Go to Import →" primary button and "Everything stays on this laptop."

### 2. Transactions
- Subtitle: "N transactions · $X spent · $Y income", computed for the current filtered list.
- Filters: a search input ("Search descriptions") plus Account and Category dropdown buttons. A "Clear filters" link appears when any filter is active.
- Table (min-width 760, scrolls horizontally when narrow) with columns `80px | minmax(200px,1fr) | 136px | 200px | 116px`: Date, Description (500, ellipsis), Account, Category, Amount (right-aligned).
- **The category cell is an inline dropdown**: a dot, the name and a chevron, borderless until hover.
- **Uncategorized rows are highlighted**: `--hl` row background, with the category button given an amber border.
- Changing a category to anything other than Uncategorized, when no matching rule exists, shows an **inline prompt row** under that row (accent-soft background, radius 9): "Always categorize **TRADER JOE'S** as **Groceries**? [Create rule] [Just this once]", plus "Also fixes N other uncategorized transactions." when applicable.
  - Create rule: adds the rule (merchant key → category), recategorizes other *uncategorized* transactions that contain that text, and shows the toast "Rule created: X → Y · applied to N more".
  - Merchant key: description in uppercase, with store numbers stripped (` #552`, trailing ` 2291`, `*MK1A2`).
- Empty states: "No transactions yet" (first run → Import), "All caught up" (Uncategorized filter with nothing left), "Nothing matches" (→ Clear filters) and "No transactions in November 2026" (→ Import).

### 3. Import (most important screen)
Stepper: 1 Upload · 2 Set up file · 3 Review · 4 Done. The steps are clickable. Circles are 24px: the current step is filled accent, done steps are accent-soft with ✓, and upcoming steps are outlined.

- **Step 1: Upload**
  - Large drop zone: 1.5px dashed border, radius 14, padding `clamp(36px,7vw,64px) 24px`. It contains a CSV glyph, "Drop your bank's CSV export here" and "or choose files · several files at once is fine". Drag-over turns the border accent and the background accent-soft. It accepts multiple `.csv` files.
  - "No file handy? [Use a sample Chase export]".
  - Three help tiles for where to find the export: Chase, American Express, Other banks.
  - Card "Recent imports": file name (mono), account, date and "41 new / 18 skipped", newest first.
- **Step 2: Set up this file** (only when the file's column layout isn't a saved format)
  - Header card: file name, "59 rows", "We haven't seen this column layout before — set it up once and we'll remember it."
  - Section 1, "Which account is this?": radio cards for the existing accounts ("Detected from file name" under the match) plus "New account". New account shows an Account name input and a Type segmented control (Checking / Credit card / Savings).
  - Section 2, "What's in each column?": a dropdown above each column (Date / Description / Amount / Debit / Credit / Ignore), pre-filled with auto-detected guesses. Mapped columns are accent-soft; ignored columns are muted. Each type except Ignore is unique, so picking one resets its previous column to Ignore. Below come the original CSV header row and the first 5 raw rows in mono.
  - Section 3, "How are amounts signed?": three radio cards: "Purchases are negative" (detected), "Purchases are positive", "Separate debit and credit columns". Underneath is a **live parsed preview** of the 5 rows (date, description, Income/Spending pill, amount) and a status line:
    - OK (green): "✓ Looks right — 4 purchases come out as spending, 1 deposit as income."
    - Warning (amber): "4 of 5 rows come out as income. If those are purchases, choose 'Purchases are negative'."
    - Issue (amber): e.g. missing Date column, or Debit/Credit not mapped for the separate-columns option.
  - Sticky footer: checkbox "Remember this format for Chase Checking" (**checked by default**), Back, and "Continue to review" (disabled while there's an issue).
- **Step 3: Review**
  - Summary banner: "**59 rows found** · **41 new** · 18 already imported (skipped) · **7 need a category**". The last item is amber and updates live; it reads "All categorized" in green when done.
  - Table of new rows (max-height 540, scrolls, sticky header): Date, Description, Category (inline dropdown plus a small outlined **"rule"** badge when a rule matched), Amount. Uncategorized rows are highlighted as on Transactions.
  - Collapsed section "▸ 18 already imported — skipped" ("Matched on date, amount and description"). Expanding it shows dimmed rows.
  - Sticky footer note ("7 uncategorized rows will come in as Uncategorized — you can sort them out later."), Back, and the primary **"Import 41 transactions"**.
  - If the format was saved, step 2 is skipped and this line shows: "Recognized your saved format for this file — no setup needed."
  - Re-importing the same file shows 0 new / 59 skipped and the button reads "Nothing to import" (disabled).
- **Step 4: Done**: green check circle, "41 transactions imported", "Added to Chase Checking · Oct 11 – Oct 24, 2026. 18 duplicates were skipped.", plus "Matched expected recurring: Paycheck (Oct 24), Car insurance (Oct 22)". Buttons: Go to Dashboard (primary), "Categorize N remaining" and "Import another file".

### 4. Budgets
- Header action: "Copy last month's budgets". It becomes the primary button when the month has no budgets, and copies the previous month's values with a toast.
- Summary card: Total budget / Spent so far / Remaining (or "Over budget" in red), a 10px progress bar, and "68% of budget used · 6 days left in October".
- Table with columns `minmax(150px,1.2fr) | 140px | 110px | 120px | minmax(140px,1.4fr)`: Category (dot + name), Monthly budget (a "$" input that saves as you type), Spent, Remaining (red with "−" when over), Progress bar + %. Footnote: "Income, Transfer and Uncategorized aren't budgeted."

### 5. Recurring
- "Add recurring" primary button.
- Explainer strip (`--surface-2`): "Until a matching transaction is imported, each item shows on the Dashboard as **expected** — dashed, like this." It includes a sample dashed row.
- Table: Name (+ mono "matches 'GEICO'"), Amount, Category, Account, Frequency (Monthly / Every 2 weeks / Yearly), Next date, This period status, Active toggle (34×20 switch).
  - Status chips: "✓ Received Oct 24" (solid), "Expected Oct 22 · not imported" (**dashed border**), "Paused", "Nothing due yet". Inactive rows are at 0.55 opacity.
- Sample items: Rent $1,650 monthly (1st), Paycheck +$2,400 every 2 weeks (Nov 7 anchor), Netflix $15.49 monthly (3rd), Spotify $11.99 monthly (12th), Car insurance $142 monthly (22nd), Amazon Prime $139 yearly.
- **Add recurring side panel**: right sheet, `min(420px,100%)` wide, over a 30% scrim. Fields:
  - Name.
  - Type: Expense / Income.
  - Amount ($).
  - Category and Account dropdowns.
  - Frequency segmented control.
  - Next date (date input).
  - "Match imported transactions containing" (mono; auto-fills from the name in uppercase until edited).
  - Validation messages: "Give it a name." / "Enter an amount greater than $0." / "Pick the next date."
- Matching logic: an occurrence counts as received if some transaction contains the match text, has the same sign, and is within ±4 days.

### 6. Settings
- Appearance: Light / Dark segmented control.
- Accounts: Name, Type, Saved CSV format ("Not saved — asks on next import" in muted text, or e.g. "Chase · 7 columns"), Last import.
- Categories:
  - Each row has a color swatch button that opens a picker with 11 named swatches.
  - The name is an inline-editable input; renaming on blur/Enter updates transactions, rules, recurring items and budgets.
  - Each row shows a "Built-in · N transactions" note and an "Exclude from totals" toggle (Transfer is on by default). Income and Uncategorized are locked and can't be excluded.
  - Add-category input + button.
- Rules: mono merchant chip → category (dot). Edit switches the row inline to an input, a category dropdown and Save/Cancel. Delete is red text.
- Data: "Load sample data" / "Erase all data". Erase gives the first-run empty state.

## Shared components
- **Dropdown/picker**: a single floating menu, fixed-positioned under its trigger (flips up near the viewport bottom). Surface bg, 1px `--line`, radius 10, `--shadow`, 5px padding, rows 13.5px with 7px 10px padding. Rows can have an optional color dot and an accent ✓ on the current value. Closes on outside click. Used for every select in the app.
- **Chevron**: a 6×6 box with 1.5px right+bottom borders in currentColor, rotated 45°, opacity 0.6.
- **Buttons**:
  - Primary: accent bg, accent-ink text, radius 8, 9px 15px, 13.5px/500, hover brightness 1.08.
  - Secondary: surface bg, 1px `--line-strong`, hover `--surface-2`.
  - Text link: accent, no border.
- **Segmented control**: `--surface-2` track with 1px line, 3px padding, radius 9. The selected segment is surface with a small shadow.
- **Toggle**: 34×20 track (accent on, `--track-strong` off) with a 16px white knob; the left offset transitions over .15s.
- **Toast**: fixed bottom-center, ink bg with bg-colored text, radius 9, auto-hides after 3.4s.
- **Cards**: surface bg, 1px `--line`, radius 12. Tables put a `--surface-2` header row (12.5px/500 `--ink-3`) above 1px row dividers.

## Design tokens
Font: **Geist** (UI) and **Geist Mono** (file names, raw CSV, rule text). Use tabular numbers everywhere (`font-variant-numeric: tabular-nums`). Base size 14px, line-height 1.45.

| Token | Light | Dark |
|---|---|---|
| --bg | #f6f5f2 | #121413 |
| --surface | #ffffff | #1a1d1c |
| --surface-2 | #f1f0ec | #222625 |
| --line | #e6e4de | #2b302e |
| --line-strong | #d2cfc7 | #3d4341 |
| --ink | #1c1e1d | #e7e9e7 |
| --ink-2 | #5b615e | #a3a9a6 |
| --ink-3 | #868b88 | #757c79 |
| --accent | oklch(0.43 0.055 200) | oklch(0.75 0.07 200) |
| --accent-ink | #ffffff | #0e1312 |
| --accent-soft | oklch(0.95 0.018 200) | oklch(0.3 0.035 200) |
| --pos (income) | oklch(0.5 0.12 155) | oklch(0.76 0.13 155) |
| --pos-soft | oklch(0.95 0.035 155) | oklch(0.3 0.05 155) |
| --neg (over budget) | oklch(0.54 0.17 27) | oklch(0.72 0.15 27) |
| --neg-soft | oklch(0.96 0.025 27) | oklch(0.3 0.06 27) |
| --warn (near limit) | oklch(0.72 0.14 70) | oklch(0.79 0.13 75) |
| --warn-ink (amber text) | oklch(0.5 0.11 62) | oklch(0.83 0.12 80) |
| --warn-soft | oklch(0.96 0.045 85) | oklch(0.31 0.05 75) |
| --hl (uncategorized row) | oklch(0.977 0.03 88) | oklch(0.245 0.028 80) |
| --track | #ecebe6 | #2a2f2d |
| --track-strong | #d4d1ca | #434946 |
| --spend (chart) | oklch(0.63 0.02 230) | oklch(0.6 0.02 230) |
| --shadow | 0 1px 2px rgba(20,24,22,.05), 0 10px 28px rgba(20,24,22,.09) | 0 1px 2px rgba(0,0,0,.3), 0 10px 28px rgba(0,0,0,.4) |

Category colors: Groceries oklch(0.6 0.09 190), Dining oklch(0.67 0.12 55), Rent oklch(0.55 0.07 255), Utilities oklch(0.66 0.09 225), Transportation oklch(0.6 0.1 290), Subscriptions oklch(0.63 0.11 335), Shopping oklch(0.72 0.11 88), Entertainment oklch(0.63 0.13 15), Income oklch(0.58 0.12 150), Transfer oklch(0.68 0.01 250), Uncategorized oklch(0.76 0.04 80).

- Radii: 6–7 (small buttons and inputs), 8 (buttons), 9–10 (menus, radio cards), 12 (cards), 14 (hero and empty-state cards).
- Spacing: card padding 18–20px, table cell padding 6–10px vertical × 18px horizontal, section gaps 16–20px.
- Type scale: 24 (h1), 21 (success title), 19 (drop zone), 17 (sub-heads), 14.5/600 (card titles), 14 (body), 13.5, 13, 12.5 (meta), 12, 11 (badges).

## State and data model (prototype)
- `Transaction {id, date (YYYY-MM-DD), desc, account, cat, amount}`: negative = money out.
- `Account {id, name, type, format|null, last}`
- `Category {name, color, excluded?, locked?}`
- `Rule {id, merchant (uppercase substring), cat}`
- `Recurring {id, name, amount (signed), cat, account, freq: monthly|biweekly|yearly, anchor (date), match, active}`
- `Budgets {'YYYY-MM': {category: amountString}}`
- `Import log {file, acct, date, newN, skip}`
- UI state: selected month, screen, import step, column map, sign mode, remember flag, per-row review overrides, filters, the pending rule prompt, theme.
- Duplicate detection on import: same date + amount + description as an existing transaction. Mention this in the UI ("Matched on date, amount and description").

## Responsive
- ≥1100px: single-row header; Dashboard row A fixed at 380px with Upcoming scrolling inside.
- <1100px: nav on its own scrollable row; Dashboard rows wrap and grow to fit their content (inner lists capped at 360px with scrolling).
- All tables scroll horizontally inside their cards and have min-widths.

## Assets
None. The logo mark and CSV glyph are pure CSS. There are no images or icon fonts.

## Files
- `Budget.dc.html`: the full clickable prototype, with every screen and the logic class.
- `support.js`: prototype runtime, needed only to open the HTML file locally.
- (Not pulled: `Budget Layouts.dc.html`, the four layout explorations 1a–1d. The chosen direction is **1d** (top bar), with 1a's balanced dashboard grid.)
