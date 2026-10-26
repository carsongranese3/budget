import express, { type NextFunction, type Request, type Response } from "express";
import { computeTotals, spendByCategory } from "../shared/totals.js";
import type {
  ApiError, BudgetsResponse, Category, SummaryResponse, CategoryWithCounts, MonthsResponse, Rule, Transaction, TransactionsResponse,
} from "../shared/types.js";
import {
  CATEGORY_COUNTS_SQL, SWATCHES, type DB, eraseAll, localDate, toAccount, toCategory,
  toCategoryWithCounts, uncategorizedId,
} from "./db.js";
import { HttpError, bad, int, month, notFound, obj, oneOf, str } from "./http.js";
import { commit, listImports, preview, undoImport } from "./imports.js";
import { createRecurring, expectedTotals, listRecurring, updateRecurring, upcomingFor } from "./recurring.js";
import { loadSampleData, sampleCsv } from "./sample.js";

const isConstraint = (e: any) => typeof e?.code === "string" && e.code.startsWith("SQLITE_CONSTRAINT");

export function createApp(db: DB, today: () => string = () => localDate()) {
  const app = express();
  app.disable("x-powered-by");
  // Local-only app: reject foreign Host headers (DNS rebinding).
  app.use((req, _res, next) => {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) return next(new HttpError(403, "forbidden", "Local access only."));
    next();
  });
  // CSRF: browsers can't send application/json cross-origin without a preflight; also reject foreign Origins.
  app.use((req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (origin !== undefined && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return next(new HttpError(403, "forbidden", "Local access only."));
    if (!req.is("application/json")) return next(new HttpError(415, "unsupported_media_type", "Content-Type must be application/json."));
    next();
  });
  app.use(express.json({ limit: "15mb" }));
  const api = express.Router();
  app.use("/api", api);

  const catById = (id: number) => db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as any;
  const mustCategory = (v: unknown, field = "category_id") => {
    const id = int(v, field);
    if (!catById(id)) throw bad("Unknown category.");
    return id;
  };
  const withCounts = (id: number): CategoryWithCounts =>
    toCategoryWithCounts(db.prepare(`${CATEGORY_COUNTS_SQL} WHERE c.id = ?`).get(id));
  const idParam = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) throw notFound();
    return id;
  };

  // ---- months ----
  api.get("/months", (_req, res) => {
    const t = today();
    const cur = t.slice(0, 7);
    const first = db.prepare("SELECT MIN(date) d FROM transactions").get() as { d: string | null };
    const [y, m] = cur.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const earliest = first.d ? first.d.slice(0, 7) : cur;
    const body: MonthsResponse = {
      today: t, current_month: cur, earliest_month: earliest < cur ? earliest : cur,
      latest_month: next, has_transactions: first.d !== null,
    };
    res.json(body);
  });

  // ---- accounts ----
  api.get("/accounts", (_req, res) => {
    res.json((db.prepare("SELECT * FROM accounts ORDER BY id").all() as any[]).map(toAccount));
  });
  api.patch("/accounts/:id", (req, res) => {
    const id = idParam(req);
    const b = obj(req.body);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(id)) throw notFound("Account not found.");
    if (b.name === undefined && b.type === undefined && b.csv_format === undefined) throw bad("Nothing to update.");
    if (b.csv_format !== undefined && b.csv_format !== null) throw bad("csv_format can only be set to null.");
    try {
      db.transaction(() => {
        if (b.name !== undefined) db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(str(b.name, "a name", 1, 60), id);
        if (b.type !== undefined) db.prepare("UPDATE accounts SET type = ? WHERE id = ?").run(oneOf(b.type, "type", ["checking", "credit_card", "savings"] as const), id);
        if (b.csv_format === null) db.prepare("UPDATE accounts SET csv_format = NULL WHERE id = ?").run(id);
      })();
    } catch (e) {
      if (isConstraint(e)) throw new HttpError(409, "conflict", "An account with that name already exists.");
      throw e;
    }
    res.json(toAccount(db.prepare("SELECT * FROM accounts WHERE id = ?").get(id)));
  });

  // ---- categories ----
  api.get("/categories", (_req, res) => {
    res.json((db.prepare(`${CATEGORY_COUNTS_SQL} ORDER BY c.sort_order, c.id`).all() as any[]).map(toCategoryWithCounts));
  });
  api.post("/categories", (req, res) => {
    const name = str(obj(req.body).name, "a name", 1, 40);
    const id = db.transaction(() => {
      if (db.prepare("SELECT 1 FROM categories WHERE name = ?").get(name))
        throw new HttpError(409, "conflict", `A category named ${name} already exists.`);
      const n = (db.prepare("SELECT COUNT(*) n FROM categories").get() as { n: number }).n;
      const income = db.prepare("SELECT sort_order FROM categories WHERE system_key = 'income'").get() as { sort_order: number };
      db.prepare("UPDATE categories SET sort_order = sort_order + 1 WHERE sort_order >= ?").run(income.sort_order);
      return Number(db.prepare("INSERT INTO categories (name, color, excluded_from_totals, system_key, sort_order) VALUES (?,?,0,NULL,?)")
        .run(name, SWATCHES[n % SWATCHES.length], income.sort_order).lastInsertRowid);
    })();
    res.status(201).json(withCounts(id));
  });
  api.patch("/categories/:id", (req, res) => {
    const id = idParam(req);
    const cur = catById(id);
    if (!cur) throw notFound("Category not found.");
    const b = obj(req.body);
    const locked = cur.system_key === "income" || cur.system_key === "uncategorized";
    const name = b.name === undefined ? undefined : str(b.name, "a name", 1, 40);
    if (name !== undefined && name !== cur.name && locked) throw new HttpError(403, "forbidden", `${cur.name} can't be renamed.`);
    if (b.color !== undefined) oneOf(b.color, "color", SWATCHES);
    if (b.excluded_from_totals !== undefined) {
      if (typeof b.excluded_from_totals !== "boolean") throw bad("Excluded from totals must be true or false.");
      if (locked && b.excluded_from_totals !== !!cur.excluded_from_totals)
        throw new HttpError(403, "forbidden", `${cur.name} can't be excluded from totals.`);
    }
    try {
      db.transaction(() => {
        if (name !== undefined) db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
        if (b.color !== undefined) db.prepare("UPDATE categories SET color = ? WHERE id = ?").run(b.color, id);
        if (b.excluded_from_totals !== undefined) db.prepare("UPDATE categories SET excluded_from_totals = ? WHERE id = ?").run(b.excluded_from_totals ? 1 : 0, id);
      })();
    } catch (e) {
      if (isConstraint(e)) throw new HttpError(409, "conflict", `A category named ${name} already exists.`);
      throw e;
    }
    res.json(withCounts(id));
  });
  api.delete("/categories/:id", (req, res) => {
    const id = idParam(req);
    const cur = catById(id);
    if (!cur) throw notFound("Category not found.");
    if (cur.system_key) throw new HttpError(403, "forbidden", `${cur.name} can't be deleted.`);
    db.transaction(() => {
      const unc = uncategorizedId(db);
      db.prepare("UPDATE transactions SET category_id = ? WHERE category_id = ?").run(unc, id);
      db.prepare("UPDATE recurring_items SET category_id = ? WHERE category_id = ?").run(unc, id);
      db.prepare("DELETE FROM rules WHERE category_id = ?").run(id);
      db.prepare("DELETE FROM budgets WHERE category_id = ?").run(id);
      db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    })();
    res.status(204).end();
  });

  // ---- rules ----
  const merchantOf = (v: unknown) => {
    const m = str(v, "a merchant", 1, 100).toUpperCase();
    if (m.length < 3) throw bad("Merchant must be at least 3 characters.");
    return m;
  };
  const ruleById = (id: number) => db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as Rule | undefined;
  api.get("/rules", (_req, res) => {
    res.json(db.prepare("SELECT * FROM rules ORDER BY merchant").all());
  });
  api.get("/rules/impact", (req, res) => {
    const m = merchantOf(req.query.merchant);
    const n = db.prepare("SELECT COUNT(*) n FROM transactions WHERE category_id = ? AND instr(ujs(description), ?) > 0")
      .get(uncategorizedId(db), m) as { n: number };
    res.json({ uncategorized_count: n.n });
  });
  api.post("/rules", (req, res) => {
    const b = obj(req.body);
    const merchant = merchantOf(b.merchant);
    const category_id = mustCategory(b.category_id);
    const out = db.transaction(() => {
      const ex = db.prepare("SELECT id FROM rules WHERE merchant = ?").get(merchant) as { id: number } | undefined;
      let id: number;
      if (ex) { db.prepare("UPDATE rules SET category_id = ? WHERE id = ?").run(category_id, ex.id); id = ex.id; }
      else id = Number(db.prepare("INSERT INTO rules (merchant, category_id, created_at) VALUES (?,?,?)").run(merchant, category_id, new Date().toISOString()).lastInsertRowid);
      const unc = uncategorizedId(db);
      const applied = category_id === unc ? 0 :
        db.prepare("UPDATE transactions SET category_id = ? WHERE category_id = ? AND instr(ujs(description), ?) > 0").run(category_id, unc, merchant).changes;
      return { rule: ruleById(id)!, applied_count: applied };
    })();
    res.status(201).json(out);
  });
  api.patch("/rules/:id", (req, res) => {
    const id = idParam(req);
    if (!ruleById(id)) throw notFound("Rule not found.");
    const b = obj(req.body);
    const merchant = b.merchant === undefined ? undefined : merchantOf(b.merchant);
    const cat = b.category_id === undefined ? undefined : mustCategory(b.category_id);
    try {
      db.transaction(() => {
        if (merchant !== undefined) db.prepare("UPDATE rules SET merchant = ? WHERE id = ?").run(merchant, id);
        if (cat !== undefined) db.prepare("UPDATE rules SET category_id = ? WHERE id = ?").run(cat, id);
      })();
    } catch (e) {
      if (isConstraint(e)) throw new HttpError(409, "conflict", "A rule for that merchant already exists.");
      throw e;
    }
    res.json(ruleById(id));
  });
  api.delete("/rules/:id", (req, res) => {
    const id = idParam(req);
    if (!ruleById(id)) throw notFound("Rule not found.");
    db.prepare("DELETE FROM rules WHERE id = ?").run(id);
    res.status(204).end();
  });

  // ---- transactions ----
  const bounds = (m: string) => [`${m}-01`, `${m}-31`]; // ISO strings compare lexically; day 31 is an upper bound
  api.get("/transactions/uncategorized-count", (req, res) => {
    const [lo, hi] = bounds(month(req.query.month));
    const n = db.prepare("SELECT COUNT(*) n FROM transactions WHERE category_id = ? AND date BETWEEN ? AND ?")
      .get(uncategorizedId(db), lo, hi) as { n: number };
    res.json({ count: n.n });
  });
  api.get("/transactions", (req, res) => {
    const [lo, hi] = bounds(month(req.query.month));
    const where = ["date BETWEEN ? AND ?"];
    const args: (string | number)[] = [lo, hi];
    if (req.query.q !== undefined) {
      if (typeof req.query.q !== "string" || req.query.q.length > 200) throw bad("Search must be text.");
      if (req.query.q !== "") { where.push("instr(ujs(description), ?) > 0"); args.push(req.query.q.toUpperCase()); }
    }
    if (req.query.account !== undefined) { where.push("account_id = ?"); args.push(int(req.query.account, "account")); }
    if (req.query.category !== undefined) { where.push("category_id = ?"); args.push(int(req.query.category, "category")); }
    const transactions = db.prepare(`SELECT * FROM transactions WHERE ${where.join(" AND ")} ORDER BY date DESC, id DESC`).all(...args) as Transaction[];
    const cats = (db.prepare("SELECT * FROM categories").all() as any[]).map(toCategory);
    const t = computeTotals(transactions, cats);
    const body: TransactionsResponse = { transactions, income_cents: t.income_cents, spent_cents: t.spent_cents };
    res.json(body);
  });
  api.patch("/transactions/:id", (req, res) => {
    const id = idParam(req);
    const category_id = mustCategory(obj(req.body).category_id);
    const r = db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(category_id, id);
    if (!r.changes) throw notFound("Transaction not found.");
    res.json(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
  });

  // ---- summary (slice 2) ----
  const allCats = () => (db.prepare("SELECT * FROM categories").all() as any[]).map(toCategory);
  const addMonths = (m: string, n: number) => {
    const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + n;
    return `${Math.floor(i / 12)}-${String((((i % 12) + 12) % 12) + 1).padStart(2, "0")}`;
  };
  api.get("/summary", (req, res) => {
    const m = month(req.query.month);
    const end = req.query.series_end === undefined ? m : month(req.query.series_end, "series_end");
    if (end < m || end > addMonths(m, 6)) throw bad("Chart range must include the selected month.");
    const cats = allCats();
    // One query for the 7-month window ending at series_end; bucket by month in JS and run the shared G6 function per bucket.
    const first = addMonths(end, -6);
    const rows = db.prepare("SELECT substr(date,1,7) m, amount_cents, category_id FROM transactions WHERE date BETWEEN ? AND ?")
      .all(`${first}-01`, `${end}-31`) as { m: string; amount_cents: number; category_id: number }[];
    const series = Array.from({ length: 7 }, (_, i) => {
      const mm = addMonths(first, i);
      const t = computeTotals(rows.filter((r) => r.m === mm), cats);
      return { month: mm, income_cents: t.income_cents, spent_cents: t.spent_cents };
    });
    const cur = rows.filter((r) => r.m === m);
    const t = computeTotals(cur, cats);
    const unc = uncategorizedId(db);
    const by_category = [...spendByCategory(cur, cats)]
      .filter(([, v]) => v > 0).map(([category_id, spent_cents]) => ({ category_id, spent_cents }))
      .sort((a, b) => b.spent_cents - a.spent_cents || a.category_id - b.category_id);
    const body: SummaryResponse = {
      month: m, income_cents: t.income_cents, spent_cents: t.spent_cents, net_cents: t.net_cents,
      income_count: t.income_count, spent_count: t.spent_count,
      uncategorized_count: cur.filter((r) => r.category_id === unc).length,
      ...expectedTotals(db, m, today()), // §6.4; never added to the totals above
      by_category, series,
    };
    res.json(body);
  });

  // ---- budgets (slice 2) ----
  const budgetsFor = (m: string): BudgetsResponse => {
    const cats = allCats();
    const spend = spendByCategory(db.prepare("SELECT amount_cents, category_id FROM transactions WHERE date BETWEEN ? AND ?")
      .all(`${m}-01`, `${m}-31`) as any[], cats);
    const set = new Map((db.prepare("SELECT category_id, amount_cents FROM budgets WHERE month = ?").all(m) as any[])
      .map((b) => [b.category_id as number, b.amount_cents as number]));
    const items = (db.prepare("SELECT id FROM categories ORDER BY sort_order, id").all() as { id: number }[])
      .map(({ id }) => cats.find((c) => c.id === id)!)
      .filter((c) => !c.excluded_from_totals && c.system_key !== "income" && c.system_key !== "uncategorized")
      .map((c) => ({ category_id: c.id, budget_cents: set.get(c.id) ?? null, spent_cents: Math.max(0, spend.get(c.id) ?? 0) }));
    const other = {
      budget_cents: ((db.prepare("SELECT amount_cents FROM other_budgets WHERE month = ?").get(m) as any)?.amount_cents ?? null) as number | null,
      spent_cents: items.reduce((s, i) => s + (i.budget_cents == null ? i.spent_cents : 0), 0),
    };
    return {
      month: m, items, other,
      total_budget_cents: items.reduce((s, i) => s + (i.budget_cents ?? 0), 0) + (other.budget_cents ?? 0),
      spent_cents: items.reduce((s, i) => s + i.spent_cents, 0),
    };
  };
  api.get("/budgets", (req, res) => { res.json(budgetsFor(month(req.query.month))); });
  api.put("/budgets", (req, res) => {
    const b = obj(req.body);
    const m = month(b.month);
    const isOther = b.category_id === null; // explicit null only; missing still 400s below
    const cid = isOther ? 0 : mustCategory(b.category_id);
    const amt = int(b.amount_cents, "amount_cents");
    if (amt < 0) throw bad("Budget can't be negative.");
    if (amt > 10_000_000_000) throw bad("Budget is too large.");
    if (isOther) {
      if (amt === 0) db.prepare("DELETE FROM other_budgets WHERE month = ?").run(m);
      else db.prepare("INSERT INTO other_budgets (month, amount_cents) VALUES (?,?) ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents").run(m, amt);
      res.json(budgetsFor(m));
      return;
    }
    const c = catById(cid);
    if (c.excluded_from_totals || c.system_key === "income" || c.system_key === "uncategorized")
      throw bad(`${c.name} can't be budgeted.`);
    if (amt === 0) db.prepare("DELETE FROM budgets WHERE month = ? AND category_id = ?").run(m, cid);
    else db.prepare("INSERT INTO budgets (month, category_id, amount_cents) VALUES (?,?,?) ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents").run(m, cid, amt);
    res.json(budgetsFor(m));
  });
  api.post("/budgets/copy", (req, res) => {
    const m = month(obj(req.body).month);
    const otherCopied = db.prepare(`INSERT INTO other_budgets (month, amount_cents)
      SELECT ?, amount_cents FROM other_budgets WHERE month = ?
      ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents`).run(m, addMonths(m, -1)).changes;
    const copied_count = otherCopied + db.prepare(`INSERT INTO budgets (month, category_id, amount_cents)
      SELECT ?, b.category_id, b.amount_cents FROM budgets b JOIN categories c ON c.id = b.category_id
      WHERE b.month = ? AND c.excluded_from_totals = 0 AND (c.system_key IS NULL OR c.system_key NOT IN ('income','uncategorized'))
      ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`).run(m, addMonths(m, -1)).changes;
    res.json({ copied_count, budgets: budgetsFor(m) });
  });

  // ---- recurring (slice 3) ----
  api.get("/recurring", (_req, res) => { res.json(listRecurring(db, today())); });
  api.get("/recurring/upcoming", (req, res) => { res.json(upcomingFor(db, month(req.query.month), today())); });
  api.post("/recurring", (req, res) => { res.status(201).json(createRecurring(db, req.body, today())); });
  api.patch("/recurring/:id", (req, res) => {
    const r = updateRecurring(db, idParam(req), req.body, today());
    if (!r) throw notFound("Recurring item not found.");
    res.json(r);
  });
  api.delete("/recurring/:id", (req, res) => {
    if (!db.prepare("DELETE FROM recurring_items WHERE id = ?").run(idParam(req)).changes) throw notFound("Recurring item not found.");
    res.status(204).end();
  });

  // ---- imports ----
  api.get("/imports/sample-csv", (_req, res) => { res.json(sampleCsv(today())); });
  api.post("/imports/preview", (req, res) => { res.json(preview(db, req.body)); });
  api.post("/imports", (req, res) => { res.status(201).json(commit(db, req.body)); });
  api.get("/imports", (_req, res) => { res.json(listImports(db)); });
  api.delete("/imports/:id", (req, res) => { res.json(undoImport(db, idParam(req))); });

  // ---- data management ----
  api.post("/sample-data", (_req, res) => { loadSampleData(db, today()); res.status(204).end(); });
  api.delete("/data", (_req, res) => { db.transaction(() => eraseAll(db))(); res.status(204).end(); });

  api.use((_req, _res) => { throw notFound("Unknown API route."); });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    let status = 500, code: ApiError["error"]["code"] = "internal", message = "Something went wrong.";
    if (err instanceof HttpError) ({ status, code, message } = err);
    else if (err?.type === "entity.too.large") [status, code, message] = [413, "payload_too_large", "Request is too large (max 15 MB)."];
    else if (err?.type === "entity.parse.failed" || err?.type === "encoding.unsupported" || err?.type === "charset.unsupported")
      [status, code, message] = [400, "validation", "Request body is not valid JSON."];
    else console.error(err);
    res.status(status).json({ error: { code, message } } satisfies ApiError);
  });
  return app;
}
