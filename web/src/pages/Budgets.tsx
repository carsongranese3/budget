import { useEffect, useRef, useState } from "react";
import type { BudgetsResponse, CopyBudgetsResponse } from "../../../shared/types";
import { api, useGet } from "../api";
import { useApp } from "../app";
import { addMonth, centsToInput, cleanDollars, dollarsToCents, money, monthLabel, monthName, plural } from "../lib";
import { btnPrimary, btnSecondary, Card, Dot, EmptyState, LoadErr, Loading, PageHead } from "../ui";

const bar = (spent: number, bud: number) => (spent > bud ? "bg-neg" : spent * 100 >= bud * 85 ? "bg-warn" : "bg-accent");
const grid = "grid grid-cols-[minmax(150px,1.2fr)_140px_110px_120px_minmax(140px,1.4fr)] gap-4";

function Row({ month, catId, name, color, sub, label, budget, spent, onSaved }: {
  month: string; catId: number | null; name: string; color?: string; sub?: string; label?: string; budget: number | null; spent: number;
  onSaved: (b: BudgetsResponse) => void;
}) {
  const { fail } = useApp();
  const [text, setText] = useState(centsToInput(budget ?? 0));
  const [err, setErr] = useState<string | null>(null);
  const saved = useRef(budget ?? 0); // last value the server has
  const timer = useRef(0);

  async function save(t: string) {
    const cents = dollarsToCents(t);
    if (cents === saved.current) return;
    try {
      const r = await api<BudgetsResponse>("/budgets", "PUT", { month, category_id: catId, amount_cents: cents });
      saved.current = cents;
      onSaved(r);
    } catch (e) {
      fail(e);
    }
  }
  // Flush a pending edit if the row unmounts (month change / navigating away).
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void save(latest.current);
    }
  }, []); // eslint-disable-line

  function change(raw: string) {
    clearTimeout(timer.current);
    timer.current = 0;
    if (raw.includes("-")) {
      setText(raw);
      return setErr("Enter an amount of $0 or more.");
    }
    const t = cleanDollars(raw);
    setText(t);
    setErr(null);
    timer.current = window.setTimeout(() => { timer.current = 0; void save(t); }, 400);
  }
  function blur() {
    if (err) { setText(centsToInput(saved.current)); setErr(null); return; }
    if (timer.current) { clearTimeout(timer.current); timer.current = 0; }
    void save(text);
  }

  const bud = budget ?? 0;
  const pct = bud > 0 ? Math.round((spent / bud) * 100) : null;
  return (
    <div className={`${grid} items-center border-b border-line px-[18px] py-2 ${color ? "" : "border-t border-t-line-strong"}`}>
      <div className="flex items-center gap-2 font-medium">
        {color ? <Dot color={color} size={8} /> : <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full border border-ink-3" />}
        <span>{name}{sub && <span className="block text-xs font-normal text-ink-3">{sub}</span>}</span>
      </div>
      <div>
        <label className={`flex w-[124px] items-center rounded-[7px] border bg-surface px-[10px] focus-within:outline-2 focus-within:outline-accent ${err ? "border-neg" : "border-line-strong"}`}>
          <span aria-hidden className="text-ink-3">$</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            aria-label={label ?? `${name} monthly budget in dollars`}
            aria-invalid={!!err}
            aria-describedby={err ? `err-${catId ?? "other"}` : undefined}
            placeholder="0"
            value={text}
            onChange={(e) => change(e.target.value)}
            onBlur={blur}
            className="w-full border-0 bg-transparent py-[7px] pl-[6px] text-right text-ink outline-none"
          />
        </label>
        {err && <div id={`err-${catId ?? "other"}`} className="mt-1 text-xs text-neg">{err}</div>}
      </div>
      <div className="text-right">{money(spent)}</div>
      <div className={`text-right font-medium ${spent > bud ? "text-neg" : ""}`}>{bud > 0 || spent > 0 ? money(bud - spent) : "—"}</div>
      <div className="flex items-center gap-[10px]">
        <div className="h-[6px] flex-1 overflow-hidden rounded-[3px] bg-track">
          {pct != null && <div className={`h-full rounded-[3px] ${bar(spent, bud)}`} style={{ width: `${Math.min(100, pct)}%` }} />}
        </div>
        <span className="w-11 text-right text-xs tabular-nums text-ink-3">{pct == null ? "" : `${pct}%`}</span>
      </div>
    </div>
  );
}

export default function Budgets() {
  const { month, months, categories, toast, fail } = useApp();
  const q = useGet<BudgetsResponse>(`/budgets?month=${month}`);
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState(0); // bump to remount rows after a copy
  const cur_ = useRef(month);
  cur_.current = month;
  // A save from a row that unmounted on month change must not overwrite the new month's data.
  const onSaved = (r: BudgetsResponse) => { if (r.month === cur_.current) q.set(r); };

  const head = (action?: React.ReactNode) => (
    <PageHead title="Budgets" sub={`Monthly limits for ${monthLabel(month)}. Edit any amount — it saves as you type.`} action={action} />
  );
  const b = q.data;
  if (!b || b.month !== month) {
    return <>{head()}{q.error ? <LoadErr msg={q.error} retry={q.reload} /> : <Loading />}</>;
  }

  const hasAny = b.items.some((i) => i.budget_cents != null) || b.other.budget_cents != null;
  const prev = monthName(addMonth(month, -1));
  async function copy() {
    setBusy(true);
    try {
      const r = await api<CopyBudgetsResponse>("/budgets/copy", "POST", { month });
      if (r.copied_count === 0) toast(`No budgets in ${prev} to copy`);
      else {
        toast(`Copied ${plural(r.copied_count, "budget")} from ${prev}`);
        q.set(r.budgets);
        setVer((v) => v + 1);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const total = b.total_budget_cents, over = b.spent_cents > total;
  const pct = total > 0 ? Math.round((b.spent_cents / total) * 100) : 0;
  const [y, m] = month.split("-").map(Number);
  const cur = months.current_month;
  const lastDay = new Date(y, m, 0).getDate();
  const tail =
    month === cur ? ` · ${plural(lastDay - Number(months.today.slice(8, 10)) + 1, "day")} left in ${monthName(month)}`
    : month < cur ? ` · ${monthName(month)} is over` : ` · ${monthName(month)} hasn't started`;

  const names = categories.filter((c) => c.system_key === "income" || c.system_key === "uncategorized" || c.excluded_from_totals).map((c) => c.name);
  const unbudgeted = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");

  return (
    <>
      {head(
        <button type="button" disabled={busy} onClick={copy} className={hasAny ? btnSecondary : btnPrimary}>
          Copy last month's budgets
        </button>,
      )}
      <Card className="flex flex-col gap-[14px] p-5">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          {[
            ["Total budget", money(total), ""],
            ["Spent so far", money(b.spent_cents), ""],
            [over ? "Over budget" : "Remaining", money(Math.abs(total - b.spent_cents)), over ? "text-neg" : ""],
          ].map(([l, v, c]) => (
            <div key={l}>
              <div className="text-[13px] text-ink-2">{l}</div>
              <div className={`text-2xl font-semibold tracking-[-0.02em] ${c}`}>{v}</div>
            </div>
          ))}
        </div>
        <div role="progressbar" aria-label="Share of total budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} className="h-[10px] overflow-hidden rounded-[5px] bg-track">
          <div className={`h-full rounded-[5px] ${bar(b.spent_cents, total)}`} style={{ width: `${total > 0 ? Math.min(100, pct) : 0}%` }} />
        </div>
        <div className="text-[12.5px] text-ink-3">
          {total > 0 ? `${pct}% of budget used${tail}` : `No budgets set for ${monthName(month)} yet. Copy last month's, or type amounts below.`}
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            <div className={`${grid} border-b border-line bg-surface-2 px-[18px] py-[10px] text-[12.5px] font-medium text-ink-3`}>
              <div>Category</div><div>Monthly budget</div><div className="text-right">Spent</div><div className="text-right">Remaining</div><div>Progress</div>
            </div>
            {b.items.length === 0 && <EmptyState title="No categories to budget" body="Add a category in Settings to set a monthly limit." />}
            {b.items.map((i) => {
              const c = categories.find((x) => x.id === i.category_id);
              return c ? (
                <Row key={`${month}-${i.category_id}-${ver}`} month={month} catId={i.category_id} name={c.name} color={c.color}
                  budget={i.budget_cents} spent={i.spent_cents} onSaved={onSaved} />
              ) : null;
            })}
            <Row key={`${month}-other-${ver}`} month={month} catId={null} name="Other" sub="Categories without their own budget" label="Monthly budget for Other"
              budget={b.other.budget_cents} spent={b.other.spent_cents} onSaved={onSaved} />
          </div>
        </div>
        <div className="px-[18px] py-3 text-[12.5px] text-ink-3">{unbudgeted} aren't budgeted.</div>
      </Card>
    </>
  );
}
