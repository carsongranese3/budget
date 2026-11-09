import { useState } from "react";
import { Link } from "react-router-dom";
import type { TrendsResponse } from "../../../shared/types";
import { useGet } from "../api";
import { useApp } from "../app";
import { axisLabel, axisStep, monthLabel, monthName, money } from "../lib";
import { btnPrimary, Card, Dot, EmptyState, LoadErr, Loading, PageHead, Select } from "../ui";

const cardTitle = "text-[14.5px] font-semibold";

export default function Trends() {
  const { month, categories, to } = useApp();
  const q = useGet<TrendsResponse>(`/trends?end=${month}`);
  const [catId, setCatId] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const head = <PageHead title="Trends" sub={`12 months ending ${monthLabel(month)}`} />;
  if (q.error && !q.data) return <>{head}<LoadErr msg={q.error} retry={q.reload} /></>;
  const d = q.data;
  if (!d) return <>{head}<Loading /></>;

  const empty = d.income_cents.every((n) => n === 0) && d.spent_cents.every((n) => n <= 0) && d.categories.length === 0;
  if (empty)
    return (
      <>
        {head}
        <Card><EmptyState title="No trends yet" body={`Nothing was imported in the 12 months ending ${monthLabel(month)}.`} action={<Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link>} /></Card>
      </>
    );

  const catById = new Map(categories.map((c) => [c.id, c]));
  const picked = d.categories.find((c) => c.category_id === catId); // a stale pick falls back to all spending
  const values = (picked ? picked.spent_cents : d.spent_cents).map((n) => Math.max(0, n));
  const pickedCat = picked ? catById.get(picked.category_id) : undefined;
  const label = pickedCat?.name ?? "All spending";
  const color = pickedCat?.color ?? "var(--spend)";
  const step = axisStep(Math.max(0, ...values));
  const top = step * 4;
  const shown = hover ?? month;
  const shownIdx = Math.max(0, d.months.indexOf(shown));
  const opts = [{ value: null, label: "All spending" }, ...d.categories.map((c) => ({ value: c.category_id as number | null, label: catById.get(c.category_id)?.name ?? "Category", color: catById.get(c.category_id)?.color }))];
  const maxYtd = Math.max(1, ...d.ytd.categories.map((c) => c.spent_cents));

  return (
    <>
      {head}
      <Card className="flex flex-col px-5 pt-[18px] pb-[14px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className={cardTitle}>Monthly spending</div>
          <Select label="Category" value={picked ? picked.category_id : null} options={opts} onChange={(v) => setCatId(v as number | null)} className="min-w-[170px] justify-between rounded-[9px] border border-line-strong bg-surface px-3 py-[6px] text-[13.5px]" />
        </div>
        <div className="mt-1 min-h-[19px] text-[12.5px] text-ink-2" aria-live="polite">
          {monthLabel(d.months[shownIdx])} — {label.toLowerCase()} {money(values[shownIdx])}
        </div>
        <div className="relative mt-3 flex h-[240px] flex-col pl-11">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-[25px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${i * 25}%` }}>
                <span className="absolute top-[-9px] left-0 bg-surface pr-[6px] text-[11px] text-ink-3">{axisLabel(i * step)}</span>
              </div>
            ))}
          </div>
          <div role="group" aria-label={`${label} by month, 12 months ending ${monthLabel(month)}`} className="relative flex min-h-0 flex-1 gap-[6px]" onMouseLeave={() => setHover(null)}>
            {d.months.map((m, i) => {
              const on = m === month;
              return (
                <button
                  key={m}
                  type="button"
                  aria-current={on ? "date" : undefined}
                  aria-label={`${monthLabel(m)}: ${label.toLowerCase()} ${money(values[i])}`}
                  onMouseEnter={() => setHover(m)}
                  onFocus={() => setHover(m)}
                  onBlur={() => setHover(null)}
                  className="flex h-full min-w-0 flex-1 cursor-default flex-col items-center gap-2 rounded border-0 bg-transparent p-0"
                >
                  <div className={`flex min-h-0 w-full flex-1 items-end justify-center ${on || hover === m ? "opacity-100" : "opacity-45"}`}>
                    <div className="w-[clamp(8px,60%,28px)] rounded-t-[3px]" style={{ height: `${(values[i] / top) * 100}%`, background: color }} />
                  </div>
                  <div className={`text-xs ${on ? "font-semibold text-ink" : "text-ink-3"}`}>{monthName(m).slice(0, 3)}</div>
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <Card className="flex flex-col gap-[14px] px-5 py-[18px]">
        <div className={cardTitle}>{d.ytd.year} so far</div>
        <div className="flex flex-wrap gap-x-8 gap-y-1">
          <div><div className="text-[13px] text-ink-2">Income</div><div className="text-[22px] font-semibold text-pos">{money(d.ytd.income_cents)}</div></div>
          <div><div className="text-[13px] text-ink-2">Spent</div><div className="text-[22px] font-semibold">{money(d.ytd.spent_cents)}</div></div>
        </div>
        {d.ytd.categories.length === 0 && <div className="text-[13px] text-ink-3">No spending in {d.ytd.year} yet.</div>}
        <div className="flex flex-col gap-3">
          {d.ytd.categories.map((c) => {
            const cat = catById.get(c.category_id);
            return (
              <div key={c.category_id} className="grid grid-cols-[minmax(96px,128px)_minmax(0,1fr)_92px] items-center gap-3">
                <div className="flex min-w-0 items-center gap-2 text-[13.5px]">
                  <Dot color={cat?.color ?? "var(--ink-3)"} size={8} />
                  <span className="truncate">{cat?.name ?? "Category"}</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-track">
                  <div className="h-full rounded" style={{ width: `${(c.spent_cents / maxYtd) * 100}%`, background: cat?.color }} />
                </div>
                <div className="text-right text-[13.5px] font-medium">{money(c.spent_cents)}</div>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
