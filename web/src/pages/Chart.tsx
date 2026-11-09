import { useState } from "react";
import { Link } from "react-router-dom";
import { computeTotals, dailyRunningNet, isCounted } from "../../../shared/totals";
import type { Transaction, TransactionsResponse } from "../../../shared/types";
import { useGet } from "../api";
import { useApp } from "../app";
import { axisLabel, axisStep, fmtDate, money, monthLabel, plural } from "../lib";
import { btnLink, btnPrimary, Card, Dot, EmptyState, LoadErr, Loading, PageHead } from "../ui";

const cardTitle = "text-[14.5px] font-semibold";

export default function Chart() {
  const { month, months } = useApp();
  return <Loaded key={month} month={month} hasAny={months.has_transactions} />;
}

function Loaded({ month, hasAny }: { month: string; hasAny: boolean }) {
  const { months, categories, to } = useApp();
  const tx = useGet<TransactionsResponse>(`/transactions?month=${month}`);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const head = (sub?: string) => <PageHead title="Chart" sub={sub ?? `${monthLabel(month)} · running net, Transfers aren't counted`} />;
  if (tx.error && !tx.data) return <>{head()}<LoadErr msg={tx.error} retry={tx.reload} /></>;
  if (!tx.data) return <>{head()}<Loading /></>;
  const txs = tx.data.transactions;
  if (txs.length === 0) {
    return (
      <>
        {head()}
        <Card>
          <EmptyState
            title={hasAny ? `No transactions in ${monthLabel(month)}` : "No transactions yet"}
            body="Import a statement that covers this month to see its running net."
            action={<Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link>}
          />
        </Card>
      </>
    );
  }

  const n = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const last = month === months.current_month ? Math.min(n, Number(months.today.slice(8, 10))) : n;
  const run = dailyRunningNet(txs, categories, n);
  const totals = computeTotals(txs, categories);
  const byDay = new Map<number, Transaction[]>();
  for (const t of txs) {
    const d = Number(t.date.slice(8, 10));
    byDay.set(d, [...(byDay.get(d) ?? []), t]);
  }
  const days = [...byDay.keys()].filter((d) => d <= last).sort((a, b) => a - b);

  // Symmetric scale: $0 is vertically centered; two gridlines each side.
  const maxAbs = Math.max(0, ...run.slice(0, last).map(Math.abs));
  const step = axisStep(maxAbs * 2);
  const top = step * 2;
  const xPct = (d: number) => ((d - 0.5) / n) * 100;
  const yPct = (v: number) => 50 - (v / top) * 50;
  const pts = [[0, 0], ...run.slice(0, last).map((v, i) => [xPct(i + 1), v])].map(([x, v], i) => `${i ? "L" : "M"}${x} ${i ? yPct(v) : 50}`).join(" ");

  const label = (d: number) => {
    const c = byDay.get(d)!.length;
    return `${fmtDate(`${month}-${String(d).padStart(2, "0")}`)}: ${plural(c, "transaction")}, running net ${money(run[d - 1])}`;
  };
  const shown = hover ?? sel;
  const dayTxs = sel != null ? byDay.get(sel) ?? [] : [];
  const dayNet = dayTxs.filter((t) => isCounted(t, categories)).reduce((s, t) => s + t.amount_cents, 0);
  const xTicks = Array.from({ length: n }, (_, i) => i + 1).filter((d) => d === 1 || d % 5 === 0);

  return (
    <>
      {head(`${monthLabel(month)} · income ${money(totals.income_cents)} · spent ${money(totals.spent_cents)} · net ${money(totals.net_cents, { sign: true })}`)}
      <Card className="flex flex-col px-5 pt-[18px] pb-[14px]">
        <div className={cardTitle}>Running net</div>
        <div className="mt-1 min-h-[19px] text-[12.5px] text-ink-2" aria-live="polite">
          {shown != null ? label(shown) : "Click a day to see its transactions"}
        </div>
        <div className="relative mt-3 ml-11 h-[260px] mb-[25px]">
          {[-2, -1, 0, 1, 2].map((i) => (
            <div key={i} aria-hidden className={`pointer-events-none absolute inset-x-0 border-t ${i === 0 ? "border-line-strong" : "border-line"}`} style={{ top: `${50 - i * 25}%` }}>
              <span className="absolute top-[-9px] right-full pr-[6px] text-[11px] text-ink-3">{i < 0 ? "−" : ""}{axisLabel(Math.abs(i) * step)}</span>
            </div>
          ))}
          {xTicks.map((d) => (
            <span key={d} aria-hidden className="absolute top-full mt-[6px] -translate-x-1/2 text-[11px] text-ink-3" style={{ left: `${xPct(d)}%` }}>{d}</span>
          ))}
          <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            <path d={pts} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <div role="group" aria-label={`Days with transactions in ${monthLabel(month)}`} onMouseLeave={() => setHover(null)}>
            {days.map((d) => {
              const on = sel === d;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={label(d)}
                  onMouseEnter={() => setHover(d)}
                  onFocus={() => setHover(d)}
                  onBlur={() => setHover(null)}
                  onClick={() => setSel(on ? null : d)}
                  className="group absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-transparent p-0"
                  style={{ left: `${xPct(d)}%`, top: `${yPct(run[d - 1])}%` }}
                >
                  <span className={`block rounded-full border-2 border-accent transition-all group-hover:size-[13px] group-focus-visible:size-[13px] group-focus-visible:ring-2 group-focus-visible:ring-accent ${on ? "size-[13px] bg-accent" : "size-[9px] bg-surface"}`} />
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {sel == null ? (
        <p className="m-0 text-[13px] text-ink-3">Click a day to see its transactions.</p>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3">
            <div className={cardTitle}>
              {fmtDate(`${month}-${String(sel).padStart(2, "0")}`)} · {plural(dayTxs.length, "transaction")} ·{" "}
              <span className={dayNet > 0 ? "text-pos" : ""}>{money(dayNet, { sign: true })}</span>
            </div>
            <div className="flex gap-3">
              <Link to={to("/transactions", { day: `${month}-${String(sel).padStart(2, "0")}` })} className={`${btnLink} no-underline`}>Open in Transactions</Link>
              <button type="button" className={btnLink} onClick={() => setSel(null)}>Close</button>
            </div>
          </div>
          <ul className="m-0 list-none p-0">
            {dayTxs.map((t) => {
              const c = categories.find((x) => x.id === t.category_id);
              const counted = isCounted(t, categories);
              return (
                <li key={t.id} className={`flex items-center gap-3 border-t border-line px-5 py-[9px] text-sm ${counted ? "" : "text-ink-3"}`}>
                  <span className="min-w-0 flex-1 truncate font-medium" title={t.description}>
                    {t.custom_description ?? t.description}
                    {!counted && <span className="ml-2 text-xs font-normal">not counted</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-ink-2">
                    <Dot color={c?.color ?? "var(--ink-3)"} size={8} />
                    <span className="hidden min-[520px]:inline">{c?.name ?? "Category"}</span>
                  </span>
                  <span className={`w-24 shrink-0 text-right whitespace-nowrap ${counted && t.amount_cents > 0 ? "text-pos" : ""}`}>
                    {t.amount_cents > 0 ? money(t.amount_cents, { sign: true }) : money(counted ? -t.amount_cents : t.amount_cents)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
