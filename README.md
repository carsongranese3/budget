# Budget

A personal, local-only budgeting app. Import your bank/card CSV exports, let learned merchant rules categorize them, and track monthly budgets, a dashboard, and recurring bills and paychecks. Your data stays on your machine in `data/budget.db`.

```sh
npm install
npm run dev   # open http://localhost:5173
```

Settings → **Load sample data** gives you something to explore. `npm test` runs the test suite. Project brief, stack and conventions: [`CLAUDE.md`](CLAUDE.md); spec: [`specs/budget-v1.md`](specs/budget-v1.md); API: [`docs/api.md`](docs/api.md).
