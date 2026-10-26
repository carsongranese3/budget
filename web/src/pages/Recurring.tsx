import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CreateRecurringRequest, Frequency, RecurringListItem } from "../../../shared/types";
import { api, useGet } from "../api";
import { useApp } from "../app";
import { cleanDollars, centsToInput, dollarsToCents, fmtDate, fmtDateY, money } from "../lib";
import { btnDangerText, btnPrimary, btnSecondary, Card, Dot, EmptyState, inputCls, LoadErr, Loading, PageHead, Segmented, Select, Toggle } from "../ui";

const FREQ: [Frequency, string][] = [["monthly", "Monthly"], ["biweekly", "Every 2 weeks"], ["yearly", "Yearly"]];
const freqLabel = (f: Frequency) => FREQ.find(([v]) => v === f)![1];
const grid = "grid grid-cols-[minmax(150px,1.4fr)_96px_minmax(110px,1fr)_minmax(90px,0.9fr)_110px_80px_minmax(150px,1.3fr)_44px] items-center gap-4";
const chipBase = "inline-block rounded-full border px-[10px] py-[3px] text-xs whitespace-nowrap";

function Chip({ it }: { it: RecurringListItem }) {
  const { kind, date } = it.status;
  if (kind === "received") return <span className={`${chipBase} border-pos bg-pos/10 text-pos`}>✓ Received {fmtDate(date!)}</span>;
  if (kind === "expected") return <span className={`${chipBase} border-dashed border-[1.5px] border-line-strong text-ink-2`}>Expected {fmtDate(date!)} · not imported</span>;
  return <span className={`${chipBase} border-line text-ink-3`}>{kind === "paused" ? "Paused" : "Nothing due yet"}</span>;
}

function tomorrow(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-[6px] text-[13px] text-ink-2">
      {label}
      {children}
      {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** Right-hand sheet on a native modal <dialog>: focus trap, Esc, inert page and focus return come for free. */
function Panel({ item, trigger, onClose, onChanged }: {
  item: RecurringListItem | "new" | null; trigger: HTMLElement | null; onClose: () => void; onChanged: (deleted?: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (item && !d.open) d.showModal();
    else if (!item && d.open) d.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="rc-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => e.target === ref.current && onClose()}
      onClose={() => trigger?.focus()}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(420px,100%)] max-w-none overflow-y-auto border-l border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/30"
    >
      {item && <Form item={item} onClose={onClose} onChanged={onChanged} />}
    </dialog>
  );
}

function Form({ item, onClose, onChanged }: { item: RecurringListItem | "new"; onClose: () => void; onChanged: (deleted?: boolean) => void }) {
  const { categories, accounts, months, toast, fail, confirm } = useApp();
  const edit = item === "new" ? null : item;
  const subs = categories.find((c) => c.name === "Subscriptions") ?? categories[0];
  const incomeCat = categories.find((c) => c.system_key === "income") ?? categories[0];
  const [name, setName] = useState(edit?.name ?? "");
  const [type, setType] = useState<"expense" | "income">(edit && edit.amount_cents > 0 ? "income" : "expense");
  const [amount, setAmount] = useState(edit ? centsToInput(Math.abs(edit.amount_cents)) : "");
  const [cat, setCat] = useState<number>(edit?.category_id ?? subs.id);
  const [acct, setAcct] = useState<number | null>(edit ? edit.account_id : (accounts[0]?.id ?? null));
  const [freq, setFreq] = useState<Frequency>(edit?.frequency ?? "monthly");
  const [date, setDate] = useState(edit?.anchor_date ?? tomorrow(months.today));
  const [match, setMatch] = useState(edit?.match_text ?? "");
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setTypeAndCat = (t: "expense" | "income") => {
    setType(t);
    setCat(t === "income" ? incomeCat.id : subs.id);
  };

  async function save() {
    const cents = dollarsToCents(amount);
    const msg = !name.trim() ? "Give it a name." : cents <= 0 ? "Enter an amount greater than $0." : !date ? "Pick the next date." : null;
    setErr(msg);
    if (msg) return;
    const body: CreateRecurringRequest = {
      name: name.trim(), amount_cents: type === "income" ? cents : -cents, category_id: cat, account_id: acct,
      frequency: freq, anchor_date: date, match_text: match.trim().toUpperCase() || name.trim().toUpperCase(),
    };
    setBusy(true);
    try {
      const r = edit ? await api<RecurringListItem>(`/recurring/${edit.id}`, "PATCH", body) : await api<RecurringListItem>("/recurring", "POST", body);
      onChanged();
      onClose();
      toast(edit ? `${body.name} saved` : `${body.name} added · next on ${fmtDate(r.next_date, true)}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!edit) return;
    if (!(await confirm({ title: "Delete recurring item", body: `Delete ${edit.name}? Imported transactions aren't affected.`, confirmLabel: "Delete" }))) return;
    try {
      await api(`/recurring/${edit.id}`, "DELETE");
      onChanged(true);
      onClose();
      toast(`${edit.name} deleted`);
    } catch (e) {
      fail(e);
    }
  }

  const catOpts = categories.map((c) => ({ value: c.id, label: c.name, color: c.color }));
  const acctOpts = [...accounts.map((a) => ({ value: a.id as number | null, label: a.name })), { value: null, label: "No account" }];
  const sel = `${inputCls} w-full`;

  return (
    <form
      noValidate
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      className="flex min-h-full flex-col gap-4 p-5"
    >
      <h2 id="rc-title" className="m-0 text-[17px] font-semibold">{edit ? "Edit recurring" : "Add recurring"}</h2>
      <Field label="Name">
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => { setName(e.target.value); if (!edit && !touched) setMatch(e.target.value.toUpperCase()); }}
          placeholder="e.g. Car insurance"
          className={inputCls}
        />
      </Field>
      <div className="flex flex-col gap-[6px] text-[13px] text-ink-2">
        Type
        <Segmented label="Type" value={type} options={[["expense", "Expense"], ["income", "Income"]]} onChange={setTypeAndCat} />
      </div>
      <Field label="Amount ($)">
        <input value={amount} inputMode="decimal" onChange={(e) => setAmount(cleanDollars(e.target.value))} placeholder="0.00" className={inputCls} />
      </Field>
      <div className="flex flex-col gap-[6px] text-[13px] text-ink-2">
        Category
        <Select label="Category" value={cat} options={catOpts} onChange={(v) => setCat(v as number)} className={sel} />
      </div>
      <div className="flex flex-col gap-[6px] text-[13px] text-ink-2">
        Account
        <Select label="Account" value={acct} options={acctOpts} onChange={(v) => setAcct(v as number | null)} className={sel} />
      </div>
      <div className="flex flex-col gap-[6px] text-[13px] text-ink-2">
        Frequency
        <Segmented label="Frequency" value={freq} options={FREQ} onChange={setFreq} />
      </div>
      <Field label="Next date" hint="The first payment to track. Earlier ones are ignored.">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Match imported transactions containing">
        <input value={match} onChange={(e) => { setMatch(e.target.value); setTouched(true); }} className={`${inputCls} font-mono`} />
      </Field>
      {err && <div role="alert" className="text-[13px] text-neg">{err}</div>}
      <div className="mt-auto flex items-center gap-2 pt-2">
        <button type="submit" disabled={busy} className={btnPrimary}>{edit ? "Save" : "Add recurring"}</button>
        <button type="button" className={btnSecondary} onClick={onClose}>Cancel</button>
        {edit && <button type="button" className={`${btnDangerText} ml-auto`} onClick={del}>Delete</button>}
      </div>
    </form>
  );
}

export function Recurring() {
  const { categories, accounts, fail } = useApp();
  const q = useGet<RecurringListItem[]>("/recurring");
  const [panel, setPanel] = useState<RecurringListItem | "new" | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const addBtn = useRef<HTMLButtonElement>(null);

  const open = (p: RecurringListItem | "new", t: HTMLElement | null) => { trigger.current = t; setPanel(p); };
  async function toggle(it: RecurringListItem, active: boolean) {
    try {
      const r = await api<RecurringListItem>(`/recurring/${it.id}`, "PATCH", { active });
      q.set((q.data ?? []).map((x) => (x.id === it.id ? r : x)));
    } catch (e) {
      fail(e);
    }
  }

  const add = <button ref={addBtn} type="button" className={btnPrimary} onClick={(e) => open("new", e.currentTarget)}>Add recurring</button>;
  const head = <PageHead title="Recurring" sub="Rent, paycheck, subscriptions — tracked against your imports" action={add} />;
  const items = q.data;

  return (
    <>
      {head}
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
        <span>Until a matching transaction is imported, each item shows on the Dashboard as <b>expected</b> — dashed, like this.</span>
        <span aria-hidden className="rounded-full border-[1.5px] border-dashed border-line-strong px-[10px] py-[3px] text-xs">Expected Oct 22 · not imported</span>
      </div>
      {q.error && !items ? (
        <LoadErr msg={q.error} retry={q.reload} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card><EmptyState title="No recurring items yet" body="Add rent, a paycheck or a subscription and the Dashboard will show what's still expected." action={add} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <div className="min-w-[960px]">
            <div className={`${grid} border-b border-line px-5 py-3 text-xs text-ink-3`}>
              <div>Name</div><div className="text-right">Amount</div><div>Category</div><div>Account</div><div>Frequency</div><div>Next date</div><div>This period</div><div>Active</div>
            </div>
            {items.map((it) => {
              const cat = categories.find((c) => c.id === it.category_id);
              const acct = accounts.find((a) => a.id === it.account_id);
              return (
                <div
                  key={it.id}
                  onClick={(e) => open(it, e.currentTarget.querySelector("button"))}
                  className={`${grid} cursor-pointer border-b border-line px-5 py-3 text-[13.5px] last:border-b-0 hover:bg-surface-2`}
                >
                  <div className={`min-w-0 ${it.active ? "" : "opacity-55"}`}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); open(it, e.currentTarget); }} className="block max-w-full truncate border-0 bg-transparent p-0 text-left font-medium text-ink">{it.name}</button>
                    <div className="truncate font-mono text-xs text-ink-3">matches '{it.match_text}'</div>
                  </div>
                  <div className={`text-right font-medium ${it.amount_cents > 0 ? "text-pos" : ""} ${it.active ? "" : "opacity-55"}`}>{money(it.amount_cents, { sign: true })}</div>
                  <div className={`flex min-w-0 items-center gap-2 ${it.active ? "" : "opacity-55"}`}><Dot color={cat?.color ?? "var(--ink-3)"} size={8} /><span className="truncate">{cat?.name ?? "Category"}</span></div>
                  <div className={`truncate ${it.active ? "" : "opacity-55"}`}>{acct?.name ?? "—"}</div>
                  <div className={it.active ? "" : "opacity-55"}>{freqLabel(it.frequency)}</div>
                  <div className={it.active ? "" : "opacity-55"}>{fmtDateY(it.next_date)}</div>
                  <div className={it.active ? "" : "opacity-55"}><Chip it={it} /></div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Toggle on={it.active} label={`${it.name} active`} onChange={(v) => void toggle(it, v)} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      <Panel item={panel} trigger={trigger.current} onClose={() => setPanel(null)} onChanged={(deleted) => { q.reload(); if (deleted) trigger.current = addBtn.current; }} />
    </>
  );
}
