import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { BudgetsResponse, Occurrence, RecurringListItem, SummaryResponse, TrendsResponse, UpcomingResponse } from "../../../shared/types";
import { useGet } from "../api";
import { useApp } from "../app";
import { axisLabel, axisStep, colorBarsPref, seriesEnd, fmtDate, fmtDateY, money, monthLabel, monthName, plural, stackShares } from "../lib";
import { btnLink, btnPrimary, btnSecondary, Card, Dot, LoadErr, Loading, PageHead } from "../ui";

const cardTitle = "text-[14.5px] font-semibold";

function Tile({ label, value, sub, valueCls = "", children }: { label: string; value: string; sub: string; valueCls?: string; children?: ReactNode }) {
  return (
    <>
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className={`text-[26px] font-semibold tracking-[-0.02em] ${valueCls}`}>{value}</div>
      <div className="min-h-[18px] text-[12.5px] text-ink-3">{sub}</div>
      {children}
    </>
  );
}

function FirstRun() {
  const { to } = useApp();
  return (
    <>
      <PageHead title="Dashboard" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {["Income", "Spent", "Net", "Uncategorized"].map((l) => (
          <div key={l} className="rounded-xl border border-dashed border-line-strong px-[18px] py-4">
            <div className="text-[13px] text-ink-3">{l}</div>
            <div className="text-[26px] font-semibold text-ink-3">—</div>
          </div>
        ))}
      </div>
      <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
        <span aria-hidden className="mb-2 flex h-12 w-10 items-center justify-center rounded-md border border-line-strong text-[11px] font-semibold text-ink-3">CSV</span>
        <div className="text-[19px] font-semibold">Import your first statement</div>
        <p className="m-0 max-w-md text-ink-2">Export a CSV from your bank or card, drop it in, and your spending shows up here.</p>
        <Link to={to("/import")} className={`${btnPrimary} mt-2 no-underline`}>Go to Import →</Link>
        <div className="text-[12.5px] text-ink-3">Everything stays on this laptop.</div>
      </Card>
    </>
  );
}

/** Paired bars as plain HTML buttons (matches the design markup; native keyboard + focus). */
function SeriesChart({ series, selected, onOpen, canSelect, segs }: {
  series: SummaryResponse["series"]; selected: string; onOpen: (m: string) => void; canSelect: (m: string) => boolean;
  segs?: (m: string) => { color: string; pct: number }[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(0, n);
  const step = axisStep(Math.max(0, ...series.flatMap((s) => [s.income_cents, clamp(s.spent_cents)])));
  const top = step * 4;
  const cur = series.find((s) => s.month === (hover ?? selected)) ?? series[series.length - 1];
  return (
    <>
      <div className="mt-1 min-h-[19px] text-[12.5px] text-ink-2" aria-live="polite">
        {monthName(cur.month)} — income {money(cur.income_cents)} · spending {money(clamp(cur.spent_cents))}
      </div>
      <div className="relative mt-3 flex min-h-[220px] flex-1 flex-col pl-11">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-[25px]">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${i * 25}%` }}>
              <span className="absolute top-[-9px] left-0 bg-surface pr-[6px] text-[11px] text-ink-3">{axisLabel(i * step)}</span>
            </div>
          ))}
        </div>
        <div role="group" aria-label={`Income and spending, 7 months around ${monthLabel(selected)}`} className="relative flex min-h-0 flex-1 gap-[6px]" onMouseLeave={() => setHover(null)}>
          {series.map((s) => {
            const on = s.month === selected;
            const ok = canSelect(s.month);
            return (
              <button
                key={s.month}
                type="button"
                aria-current={on ? "date" : undefined}
                aria-disabled={!ok || undefined}
                aria-label={`${monthLabel(s.month)}: income ${money(s.income_cents)}, spending ${money(clamp(s.spent_cents))} — ${on ? "view transactions" : "select month"}`}
                onMouseEnter={() => setHover(s.month)}
                onFocus={() => setHover(s.month)}
                onBlur={() => setHover(null)}
                onClick={() => ok && onOpen(s.month)}
                className={`flex h-full min-w-0 flex-1 flex-col items-center gap-2 rounded border-0 bg-transparent p-0 ${ok ? "" : "!cursor-default"}`}
              >
                <div className={`flex min-h-0 w-full flex-1 items-end justify-center gap-1 ${on || hover === s.month ? "opacity-100" : "opacity-45"}`}>
                  <div className="w-[clamp(8px,26%,24px)] rounded-t-[3px] bg-pos" style={{ height: `${(s.income_cents / top) * 100}%` }} />
                  <div className="flex w-[clamp(8px,26%,24px)] flex-col-reverse overflow-hidden rounded-t-[3px] bg-spend" style={{ height: `${(clamp(s.spent_cents) / top) * 100}%` }}>
                    {segs?.(s.month).map((g, k) => <div key={k} className="shrink-0" style={{ height: `${g.pct}%`, background: g.color }} />)}
                  </div>
                </div>
                <div className={`text-xs ${on ? "font-semibold text-ink" : "text-ink-3"}`}>{monthName(s.month).slice(0, 3)}</div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function BudgetProgress({ b, month }: { b: BudgetsResponse; month: string }) {
  const { categories, to } = useApp();
  const rows = b.items.filter((i) => i.budget_cents != null)
    .map((i) => ({ key: String(i.category_id), name: categories.find((c) => c.id === i.category_id)?.name ?? "Category", spent: i.spent_cents, bud: i.budget_cents! }));
  if (b.other.budget_cents != null) rows.push({ key: "other", name: "Other", spent: b.other.spent_cents, bud: b.other.budget_cents });
  return (
    <>
      <div className="flex items-baseline justify-between">
        <div className={cardTitle}>Budget progress</div>
        <Link to={to("/budgets")} className={`${btnLink} no-underline`}>Edit budgets</Link>
      </div>
      <div className="-mr-[10px] flex max-h-[360px] flex-col gap-[14px] overflow-y-auto pr-[10px] min-[1100px]:max-h-none">
        {rows.length === 0 && (
          <div className="text-[13px] text-ink-3">
            No budgets for {monthName(month)}. <Link to={to("/budgets")} className={`${btnLink} text-[13px] no-underline`}>Set budgets</Link>
          </div>
        )}
        {rows.map(({ key, name, spent, bud }) => {
          const over = spent > bud, near = !over && spent * 100 >= bud * 85;
          const bar = over ? "bg-neg" : near ? "bg-warn" : "bg-accent";
          return (
            <div key={key} className="flex flex-col gap-[6px]">
              <div className="flex justify-between gap-3 text-[13.5px]">
                <span>{name}</span>
                <span>
                  <span className={`font-medium ${over ? "text-neg" : ""}`}>{money(spent)}</span>
                  <span className="text-ink-3"> / {money(bud)}</span>
                </span>
              </div>
              <div role="progressbar" aria-label={`${name} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((spent / bud) * 100))} className="h-[6px] overflow-hidden rounded-[3px] bg-track">
                <div className={`h-full rounded-[3px] ${bar}`} style={{ width: `${Math.min(100, (spent / bud) * 100)}%` }} />
              </div>
              {(over || near) && (
                <div className={`text-xs ${over ? "text-neg" : "text-warn-ink"}`}>
                  {over ? `Over by ${money(spent - bud)}` : `${money(bud - spent)} left`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function UpcomingCard({ month }: { month: string }) {
  const { accounts, to } = useApp();
  const up = useGet<UpcomingResponse>(`/recurring/upcoming?month=${month}`);
  const all = useGet<RecurringListItem[]>("/recurring");
  const d = up.data;
  const none = d && d.expected.length === 0 && d.upcoming.length === 0;
  const noItems = none && all.data && !all.data.some((r) => r.active);
  const row = (o: Occurrence, expected: boolean) => {
    const [mon, day] = [fmtDate(o.date).split(" ")[0].toUpperCase(), Number(o.date.slice(8, 10))];
    const acct = accounts.find((a) => a.id === o.account_id)?.name ?? "No account";
    return (
      <li key={`${o.recurring_id}-${o.date}`} className={`flex items-center gap-3 rounded-[9px] px-[10px] py-2 ${expected ? "border-[1.5px] border-dashed border-line-strong" : ""}`}>
        <div aria-hidden className="flex size-[38px] shrink-0 flex-col items-center justify-center rounded-lg bg-surface-2 leading-none">
          <span className="text-[9.5px] font-semibold text-ink-3">{mon}</span>
          <span className="text-[14px] font-semibold">{day}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{o.name}</div>
          <div className="truncate text-xs text-ink-3">{expected ? "Expected" : "Due"} {fmtDateY(o.date)} · {acct}</div>
        </div>
        <div className={`text-[13.5px] font-medium ${o.amount_cents > 0 ? "text-pos" : ""} ${expected ? "opacity-60" : ""}`}>{money(o.amount_cents, { sign: o.amount_cents > 0 })}</div>
      </li>
    );
  };
  return (
    <>
      <div className="flex items-baseline justify-between">
        <div className={cardTitle}>Upcoming recurring</div>
        <Link to={to("/recurring")} className={`${btnLink} no-underline`}>Manage</Link>
      </div>
      {up.error && !d ? (
        <LoadErr msg={up.error} retry={up.reload} />
      ) : !d ? (
        <Loading />
      ) : none ? (
        <div className="text-[13px] text-ink-3">{noItems ? "No recurring items yet." : "Nothing coming up."} {noItems && <Link to={to("/recurring")} className={`${btnLink} text-[13px] no-underline`}>Add one</Link>}</div>
      ) : (
        <div className="-mr-[10px] flex min-h-0 max-h-[360px] flex-col gap-2 overflow-y-auto pr-[10px] min-[1100px]:max-h-none min-[1100px]:flex-1">
          {d.expected.length > 0 && (
            <section aria-label="Expected this month, not imported yet" className="flex flex-col gap-2">
              <h3 className="m-0 text-xs font-medium text-ink-3">Expected this month, not imported yet</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{d.expected.map((o) => row(o, true))}</ul>
            </section>
          )}
          {d.upcoming.length > 0 && (
            <section aria-label="Coming up" className="flex flex-col gap-2">
              {d.expected.length > 0 && <h3 className="m-0 mt-1 text-xs font-medium text-ink-3">Coming up</h3>}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{d.upcoming.map((o) => row(o, false))}</ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}

export function Dashboard() {
  const { month, months, categories, to } = useApp();
  if (!months.has_transactions) return <FirstRun />;
  return <Loaded key={month} month={month} months={months} categories={categories} to={to} />;
}

function Loaded({ month, months, categories, to }: Pick<ReturnType<typeof useApp>, "month" | "months" | "categories" | "to">) {
  const nav = useNavigate();
  const end = seriesEnd(month, months.earliest_month, months.current_month);
  const sum = useGet<SummaryResponse>(`/summary?month=${month}&series_end=${end}`);
  // category stacks for the spending bars come from /trends (12 months ending at the same `end` cover the 7-month window)
  const tr = useGet<TrendsResponse>(colorBarsPref() ? `/trends?end=${end}` : null);
  const color = new Map(categories.map((c) => [c.id, c.color]));
  const segs = tr.data
    ? (m: string) => {
        const i = tr.data!.months.indexOf(m);
        return i < 0 ? [] : stackShares(tr.data!.categories, i).map((s) => ({ pct: s.pct, color: color.get(s.category_id) ?? "var(--spend)" }));
      }
    : undefined;
  const bud = useGet<BudgetsResponse>(`/budgets?month=${month}`);
  const uncat = categories.find((c) => c.system_key === "uncategorized");

  // first click selects the month on the Dashboard; clicking the already-selected month opens Transactions
  const openMonth = (m: string) => nav(`${m === month ? "/transactions" : "/"}${m === months.current_month ? "" : `?month=${m}`}`);
  const canSelect = (m: string) => m >= months.earliest_month && m <= months.latest_month;

  const head = (
    <PageHead
      title="Dashboard"
      sub={`${monthLabel(month)} · Transfers aren't counted in any total`}
      action={<Link to={to("/import")} className={`${btnSecondary} no-underline`}>Import CSV</Link>}
    />
  );
  if (sum.error && !sum.data) return <>{head}<LoadErr msg={sum.error} retry={sum.reload} /></>;
  const s = sum.data;
  if (!s) return <>{head}<Loading /></>;

  const kept = s.income_cents > 0 ? `${Math.round((s.net_cents / s.income_cents) * 100)}% of income kept`.replace("-", "−") : "—";
  const expected = (c: number) => `+${money(c)} expected, not imported yet`;
  const uncatN = s.uncategorized_count;
  const maxCat = Math.max(1, ...s.by_category.map((c) => c.spent_cents));
  const tileCls = "flex flex-col gap-1 rounded-xl border border-line bg-surface px-[18px] py-4";

  return (
    <>
      {head}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <div className={tileCls}>
          <Tile label="Income" value={money(s.income_cents)} valueCls="text-pos" sub={s.expected_income_cents > 0 ? expected(s.expected_income_cents) : plural(s.income_count, "deposit")} />
        </div>
        <div className={tileCls}>
          <Tile label="Spent this month" value={money(s.spent_cents)} sub={s.expected_spent_cents > 0 ? expected(s.expected_spent_cents) : plural(s.spent_count, "transaction")} />
        </div>
        <div className={tileCls}>
          <Tile label="Net" value={money(s.net_cents, { sign: true })} sub={kept} />
        </div>
        <button
          type="button"
          disabled={!uncat}
          onClick={() => nav(to("/transactions", { category: String(uncat!.id) }))}
          className={`${tileCls} text-left hover:border-warn ${uncatN > 0 ? "border-warn bg-hl" : ""}`}
        >
          <Tile label="Uncategorized" value={String(uncatN)} valueCls={uncatN > 0 ? "text-warn-ink" : ""} sub={uncatN > 0 ? "Review in Transactions →" : "All categorized"} />
        </button>
      </div>

      <div className="flex flex-wrap items-stretch gap-4 min-[1100px]:h-[380px] min-[1100px]:flex-nowrap">
        <Card className="flex min-h-0 min-w-0 flex-[2_1_460px] flex-col overflow-hidden px-5 pt-[18px] pb-[14px]">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className={cardTitle}>Income vs spending</div>
            <div className="flex gap-[14px] text-[12.5px] text-ink-2">
              <span className="flex items-center gap-[6px]"><span aria-hidden className="size-[9px] rounded-[2px] bg-pos" />Income</span>
              <span className="flex items-center gap-[6px]"><span aria-hidden className="size-[9px] rounded-[2px] bg-spend" />Spending</span>
            </div>
          </div>
          <SeriesChart series={s.series} selected={month} onOpen={openMonth} canSelect={canSelect} segs={segs} />
        </Card>
        <Card className="flex min-h-0 min-w-0 flex-[1_1_300px] flex-col gap-3 overflow-hidden px-5 py-[18px]">
          <UpcomingCard month={month} />
        </Card>
      </div>

      <div className="flex flex-wrap items-stretch gap-4">
        <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-[14px] overflow-hidden px-5 py-[18px]">
          <div className="flex items-baseline justify-between">
            <div className={cardTitle}>Spending by category</div>
            <div className="text-[12.5px] text-ink-3">{monthName(month).slice(0, 3)}</div>
          </div>
          <div className="-mr-[10px] flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-[10px]">
            {s.by_category.length === 0 && <div className="text-[13px] text-ink-3">No spending in {monthName(month)}.</div>}
            {s.by_category.map((c) => {
              const cat = categories.find((x) => x.id === c.category_id);
              return (
                <div key={c.category_id} className="grid grid-cols-[minmax(96px,128px)_minmax(0,1fr)_92px] items-center gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-[13.5px]">
                    <Dot color={cat?.color ?? "var(--ink-3)"} size={8} />
                    <span className="truncate">{cat?.name ?? "Category"}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-track">
                    <div className="h-full rounded" style={{ width: `${(c.spent_cents / maxCat) * 100}%`, background: cat?.color }} />
                  </div>
                  <div className="text-right text-[13.5px] font-medium">{money(c.spent_cents)}</div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-[14px] overflow-hidden px-5 py-[18px]">
          {bud.data ? (
            <BudgetProgress b={bud.data} month={month} />
          ) : (
            <>
              <div className={cardTitle}>Budget progress</div>
              {bud.error ? <LoadErr msg={bud.error} retry={bud.reload} /> : <Loading />}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
