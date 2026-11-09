import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  BulkCategoryResponse, CreateRuleResponse, Receipt, Rule, RuleImpactResponse, SplitGroup, SplitPartInput, Transaction, TransactionsResponse,
} from "../../../shared/types";
import { merchantKey } from "../../../shared/merchant";
import { computeTotals } from "../../../shared/totals";
import { api, useGet } from "../api";
import { useApp } from "../app";
import { centsToInput, cleanDollars, dollarsToCents, fmtDate, fmtDateY, money, monthLabel, plural, shortcutBlocked, txQuery } from "../lib";
import { btnDangerText, btnLink, btnPrimary, btnSecondary, Card, EmptyState, inputCls, Loading, LoadErr, PageHead, Select, Toggle } from "../ui";

interface Prompt { id: number; key: string; text: string; catId: number; impact: number }

export default function Transactions() {
  const { month, months, categories, accounts, to, toast, fail, refreshBadge, reload } = useApp();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const account = params.get("account") ?? "";
  const category = params.get("category") ?? "";
  const all = params.get("all") === "1";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get("day") ?? "") ? params.get("day")! : "";
  const [q, setQ] = useState(urlQ);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [focusId, setFocusId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});

  // Invalid URL filter values are treated as "All" and never sent to the API.
  const catFilterValid = !category || (/^\d+$/.test(category) && categories.some((c) => c.id === Number(category)));
  const accountValid = !account || /^\d+$/.test(account);
  const path = useMemo(() => {
    return txQuery(month, urlQ, account, category, categories.map((c) => c.id), all, day);
  }, [month, urlQ, account, category, categories, all, day]);
  const tx = useGet<TransactionsResponse>(path);
  const rulesQ = useGet<Rule[]>("/rules");

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };
  useEffect(() => setQ(urlQ), [urlQ]);
  useEffect(() => {
    if (q === urlQ) return;
    const t = setTimeout(() => setParam("q", q), 250);
    return () => clearTimeout(t);
  }); // eslint-disable-line
  useEffect(() => { setPrompt(null); setOpenId(null); setSel(new Set()); setFocusId(null); }, [path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    if (focusId !== null) document.querySelector(`[data-tx="${focusId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);
  // Live "also fixes N" for the edited rule text; the functional update drops responses for text/prompt that is no longer current.
  const pId = prompt?.id, pText = prompt?.text.trim() ?? "";
  useEffect(() => {
    if (pId === undefined || pText.length < 3) return;
    const t = setTimeout(async () => {
      try {
        const imp = await api<RuleImpactResponse>(`/rules/impact?merchant=${encodeURIComponent(pText)}`);
        setPrompt((p) => (p && p.id === pId && p.text.trim() === pText ? { ...p, impact: imp.uncategorized_count } : p));
      } catch { /* count is informational; Create rule still works */ }
    }, 250);
    return () => clearTimeout(t);
  }, [pId, pText]);

  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const acctById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const uncat = categories.find((c) => c.system_key === "uncategorized")!;
  const catOpts = categories.map((c) => ({ value: c.id, label: c.name, color: c.color }));
  const filtered = !!(urlQ || day || (account && accountValid) || (category && catFilterValid));

  const setRow = (updated: Transaction) => {
    const old = tx.data!.transactions.find((r) => r.id === updated.id);
    // a date edit left the shown month/day (never in all-time mode without a day filter)
    const moved = (!all && updated.date.slice(0, 7) !== month) || (!!day && updated.date !== day);
    if (updated.parent_id !== null && old && old.date !== updated.date) tx.reload(); // the whole split group moved
    const rows = moved ? tx.data!.transactions.filter((r) => r.id !== updated.id) : tx.data!.transactions.map((r) => (r.id === updated.id ? updated : r));
    if (moved) toast(`Moved to ${fmtDateY(updated.date)}`);
    tx.set({ transactions: rows, ...computeTotals(rows, categories) });
  };

  async function changeCat(t: Transaction, catId: number) {
    try {
      setRow(await api<Transaction>(`/transactions/${t.id}`, "PATCH", { category_id: catId }));
      refreshBadge();
      setPrompt(null);
      const key = merchantKey(t.description);
      const hasRule = rulesQ.data?.some((r) => r.merchant === key && r.category_id === catId);
      if (catId !== uncat.id && catId !== t.category_id && key.length >= 3 && !hasRule) {
        setPrompt({ id: t.id, key, text: key, catId, impact: 0 }); // count arrives via the debounced effect
      }
    } catch (e) {
      fail(e);
    }
  }

  async function bulkCat(ids: number[], catId: number) {
    const before = d!.transactions.filter((r) => ids.includes(r.id));
    try {
      const r = await api<BulkCategoryResponse>("/transactions", "PATCH", { ids, category_id: catId });
      const upd = new Map(r.transactions.map((x) => [x.id, x]));
      const rows = d!.transactions.map((x) => upd.get(x.id) ?? x);
      tx.set({ transactions: rows, ...computeTotals(rows, categories) });
      refreshBadge();
      setSel(new Set());
      setPrompt(null);
      toast(`${plural(r.updated_count, "transaction")} moved to ${catById.get(catId)?.name}`);
      // one rule prompt, only when every changed row is the same merchant
      const keys = new Set(before.map((x) => merchantKey(x.description)));
      const key = [...keys][0];
      if (keys.size === 1 && key.length >= 3 && catId !== uncat.id && before.some((x) => x.category_id !== catId) && !rulesQ.data?.some((x) => x.merchant === key && x.category_id === catId))
        setPrompt({ id: before[0].id, key, text: key, catId, impact: 0 });
    } catch (e) {
      fail(e);
    }
  }

  // Close the prompt and return focus to that row's category trigger.
  const dismiss = (el: HTMLElement) => {
    el.closest("tr")?.previousElementSibling?.querySelector<HTMLElement>("button")?.focus();
    setPrompt(null);
  };

  async function createRule(p: Prompt, el: HTMLElement) {
    const text = p.text.trim();
    if (text.length < 3) return;
    dismiss(el);
    setBusy(true);
    try {
      const r = await api<CreateRuleResponse>("/rules", "POST", { merchant: text, category_id: p.catId });
      toast(`Rule created: ${text} → ${catById.get(p.catId)?.name}${r.applied_count > 0 ? ` · applied to ${r.applied_count} more` : ""}`);
      tx.reload();
      rulesQ.reload();
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const clear = () => {
    setQ("");
    setParams(month === months.current_month ? {} : { month }, { replace: true });
  };

  const d = tx.data;
  const rowsNow = d?.transactions ?? [];
  const selIds = rowsNow.filter((r) => sel.has(r.id)).map((r) => r.id);
  const allSel = rowsNow.length > 0 && selIds.length === rowsNow.length;
  const toggleSel = (id: number) => setSel((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const openRow = (id: number) => { setTrigger(document.querySelector<HTMLElement>(`[data-tx="${id}"] button[data-open]`)); setOpenId(id); };
  keyRef.current = (e) => {
    if (shortcutBlocked(e)) return;
    if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); return; }
    const i = rowsNow.findIndex((r) => r.id === focusId);
    if (e.key === "j" || e.key === "k") {
      if (!rowsNow.length) return;
      e.preventDefault();
      setFocusId(rowsNow[i < 0 ? 0 : Math.min(rowsNow.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))].id);
    } else if (e.key === "x" && i >= 0) {
      e.preventDefault();
      toggleSel(focusId!);
    } else if (/^[1-9]$/.test(e.key) && categories[Number(e.key) - 1]) {
      const cat = categories[Number(e.key) - 1];
      if (selIds.length) { e.preventDefault(); void bulkCat(selIds, cat.id); }
      else if (i >= 0) { e.preventDefault(); void changeCat(rowsNow[i], cat.id); }
    } else if (e.key === "Enter" && i >= 0 && !(e.target as HTMLElement).closest?.("button, a, summary")) {
      e.preventDefault();
      openRow(focusId!);
    }
  };
  const open = d?.transactions.find((r) => r.id === openId) ?? null;
  const scope = all ? "all time" : monthLabel(month);
  const sub = d ? `${plural(d.transactions.length, "transaction")} · ${money(d.spent_cents)} spent · ${money(d.income_cents)} income${all ? " · all time" : ""}` : scope;

  let empty: { title: string; body: string; action: React.ReactNode } | null = null;
  if (d && d.transactions.length === 0) {
    if (!months.has_transactions)
      empty = { title: "No transactions yet", body: "Import a bank or card statement to see your transactions here.", action: <Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link> };
    else if (category === String(uncat.id) && !urlQ && !(account && accountValid))
      empty = { title: "All caught up", body: all ? "Every transaction has a category." : `Every transaction in ${monthLabel(month)} has a category.`, action: <button className={btnSecondary} onClick={clear}>Clear filters</button> };
    else if (filtered)
      empty = { title: "Nothing matches", body: "No transactions match these filters.", action: <button className={btnSecondary} onClick={clear}>Clear filters</button> };
    else
      empty = { title: `No transactions in ${scope}`, body: all ? "Import a statement to see transactions here." : "Import a statement that covers this month.", action: <Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link> };
  }

  return (
    <>
      <PageHead title="Transactions" sub={sub} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={searchRef}
          type="search"
          aria-label="Search descriptions"
          placeholder="Search descriptions"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={`${inputCls} w-[240px] max-w-full`}
        />
        <Select
          label="Account"
          value={account && accountValid ? Number(account) : null}
          options={[{ value: null, label: "All accounts" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
          onChange={(v) => setParam("account", v === null ? "" : String(v))}
          className={`${inputCls} min-w-[150px] justify-between`}
        />
        <Select
          label="Category"
          value={category && catFilterValid ? Number(category) : null}
          options={[{ value: null, label: "All categories" }, ...catOpts]}
          onChange={(v) => setParam("category", v === null ? "" : String(v))}
          className={`${inputCls} min-w-[170px] justify-between`}
        />
        <span className="flex items-center gap-2 text-[13.5px] text-ink-2">
          All time
          <Toggle on={all} label="Search all time" onChange={(v) => setParam("all", v ? "1" : "")} />
        </span>
        {day && (
          <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 py-[2px] pr-1 pl-3 text-[13px]">
            {fmtDate(day)}
            <button type="button" aria-label={`Remove day filter ${fmtDate(day)}`} onClick={() => setParam("day", "")} className="grid size-5 place-items-center rounded-full border-0 bg-transparent p-0 text-ink-2 hover:bg-line">×</button>
          </span>
        )}
        {filtered && <button type="button" className={btnLink} onClick={clear}>Clear filters</button>}
      </div>
      <p className="m-0 text-xs text-ink-3">Keys: j / k move · x select · 1–9 set category · Enter open · / search · ← → change month</p>
      {selIds.length > 0 && (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft px-4 py-2 text-[13.5px]">
          <b>{selIds.length} selected</b>
          <Select label="Set category for selected" value={null} options={catOpts} onChange={(v) => void bulkCat(selIds, v as number)} className={`${inputCls} min-w-[170px] justify-between`} />
          <button type="button" className={btnLink} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {tx.error && !d ? (
        <LoadErr msg={tx.error} retry={tx.reload} />
      ) : !d ? (
        <Loading />
      ) : (
        <Card className="overflow-x-auto">
          {empty ? (
            <EmptyState {...empty} />
          ) : (
            <table className="w-full min-w-[800px] table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-10" /><col className={all ? "w-[116px]" : "w-20"} /><col /><col className="w-[136px]" /><col className="w-[200px]" /><col className="w-[116px]" />
              </colgroup>
              <thead>
                <tr className="bg-surface-2 text-left text-[12.5px] font-medium text-ink-3">
                  <th className="py-2 pl-[18px] font-medium">
                    <input
                      type="checkbox"
                      aria-label="Select all visible transactions"
                      checked={allSel}
                      ref={(el) => { if (el) el.indeterminate = selIds.length > 0 && !allSel; }}
                      onChange={() => setSel(allSel ? new Set() : new Set(rowsNow.map((r) => r.id)))}
                      className="size-4 align-middle accent-accent"
                    />
                  </th>
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 font-medium">Account</th>
                  <th className="px-2 py-2 font-medium">Category</th>
                  <th className="px-[18px] py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.transactions.map((t) => {
                  const c = catById.get(t.category_id);
                  const isUn = c?.system_key === "uncategorized";
                  const muted = c?.excluded_from_totals;
                  const isIn = t.amount_cents > 0;
                  return (
                    <RowGroup key={t.id}>
                      <tr data-tx={t.id} onClick={(e) => { setFocusId(t.id); setTrigger(e.currentTarget.querySelector("button[data-open]")); setOpenId(t.id); }} className={`scroll-mt-16 cursor-pointer border-t border-line ${isUn ? "bg-hl" : ""} ${muted ? "text-ink-3" : ""} ${focusId === t.id ? "outline-2 -outline-offset-2 outline-accent" : ""}`}>
                        <td className="py-[7px] pl-[18px]" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${t.custom_description ?? t.description}`} checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} className="size-4 align-middle accent-accent" />
                        </td>
                        <td className="px-2 py-[7px] whitespace-nowrap text-ink-2">{all ? fmtDateY(t.date) : fmtDate(t.date)}</td>
                        <td className="px-2 py-[7px] font-medium">
                          <div className="flex items-center gap-1">
                            <button type="button" data-open className="min-w-0 truncate border-0 bg-transparent p-0 text-left font-medium text-inherit" title={t.description} aria-label={`Details for ${t.custom_description ?? t.description}`}>
                              {t.custom_description ?? t.description}
                            </button>
                            {t.parent_id !== null && <span title="Part of a split" className="shrink-0 rounded-full border border-line px-[6px] text-[11px] text-ink-3">split</span>}
                            {t.receipt_count > 0 && <span aria-label="has receipt" title="Has receipt">📎</span>}
                            {t.note && <span aria-label="has note" title={t.note} className="text-ink-3">✎</span>}
                          </div>
                        </td>
                        <td className="truncate px-2 py-[7px] text-ink-2">{acctById.get(t.account_id)?.name ?? "—"}</td>
                        <td className="px-2 py-[3px]" onClick={(e) => e.stopPropagation()}>
                          <Select
                            label={`Category for ${t.description}`}
                            value={t.category_id}
                            options={catOpts}
                            onChange={(v) => changeCat(t, v as number)}
                            className={`w-full rounded-[7px] border bg-transparent px-2 py-[4px] text-[13.5px] hover:border-line-strong ${isUn ? "border-warn" : "border-transparent"}`}
                          />
                        </td>
                        <td className={`px-[18px] py-[7px] text-right whitespace-nowrap ${muted ? "" : isIn ? "text-pos" : ""}`}>
                          {muted ? money(t.amount_cents, { sign: true }) : isIn ? money(t.amount_cents, { sign: true }) : money(-t.amount_cents)}
                        </td>
                      </tr>
                      {prompt?.id === t.id && (
                        <tr className="border-t border-line">
                          <td colSpan={6} className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[9px] bg-accent-soft px-3 py-2 text-[13.5px]">
                              <span>
                                Always categorize{" "}
                                <input
                                  aria-label="Rule text"
                                  value={prompt.text}
                                  maxLength={100}
                                  spellCheck={false}
                                  autoComplete="off"
                                  style={{ width: `${Math.max(10, prompt.text.length + 3)}ch` }}
                                  className={`${inputCls} max-w-full !px-2 !py-[3px] align-middle font-mono text-[13px] uppercase`}
                                  onChange={(e) => setPrompt({ ...prompt, text: e.target.value.toUpperCase(), impact: 0 })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && !busy) { e.preventDefault(); createRule(prompt, e.currentTarget); }
                                    else if (e.key === "Escape") dismiss(e.currentTarget);
                                  }}
                                />{" "}
                                as <b>{catById.get(prompt.catId)?.name}</b>?
                                {prompt.text.trim().length < 3 && <span className="text-ink-2"> At least 3 characters</span>}
                                {prompt.text.trim().length >= 3 && prompt.impact > 0 && <span className="text-ink-2"> Also fixes {plural(prompt.impact, "other uncategorized transaction")}.</span>}
                              </span>
                              <span className="flex gap-2">
                                <button type="button" disabled={busy || prompt.text.trim().length < 3} className={`${btnPrimary} !px-3 !py-[5px]`} onClick={(e) => createRule(prompt, e.currentTarget)}>Create rule</button>
                                <button type="button" className={`${btnSecondary} !px-3 !py-[5px]`} onClick={(e) => dismiss(e.currentTarget)}>Just this once</button>
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}
      <Drawer t={open} trigger={trigger} onClose={() => setOpenId(null)} onCat={changeCat} onRow={setRow} onSplit={() => { setOpenId(null); tx.reload(); reload(); }} />
    </>
  );
}

const RowGroup = ({ children }: { children: React.ReactNode }) => <>{children}</>;

const MAX_BYTES = 10 * 1024 * 1024;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px] text-[13px] text-ink-2">
      {label}
      {children}
    </label>
  );
}

const readBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => rej(new Error("couldn't read file"));
    r.readAsDataURL(f);
  });

/** Right-hand sheet on a native modal <dialog> (same pattern as Recurring). */
function Drawer({ t, trigger, onClose, onCat, onRow, onSplit }: {
  t: Transaction | null; trigger: HTMLElement | null; onClose: () => void;
  onCat: (t: Transaction, catId: number) => void; onRow: (t: Transaction) => void; onSplit: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (t && !d.open) d.showModal();
    else if (!t && d.open) d.close();
  }, [t]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="tx-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => e.target === ref.current && onClose()}
      onClose={() => trigger?.focus()}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(420px,100%)] max-w-none overflow-y-auto border-l border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/30"
    >
      {t && <Detail key={t.id} t={t} onClose={onClose} onCat={onCat} onRow={onRow} onSplit={onSplit} />}
    </dialog>
  );
}

function Detail({ t, onClose, onCat, onRow, onSplit }: {
  t: Transaction; onClose: () => void; onCat: (t: Transaction, catId: number) => void; onRow: (t: Transaction) => void; onSplit: () => void;
}) {
  const { categories, accounts, toast, fail, confirm } = useApp();
  const [desc, setDesc] = useState(t.custom_description ?? "");
  const [note, setNote] = useState(t.note ?? "");
  const [uploading, setUploading] = useState(false);
  const rc = useGet<Receipt[]>(`/transactions/${t.id}/receipts`);
  const isPart = t.parent_id !== null;
  const group = useGet<SplitGroup>(isPart ? `/transactions/${t.id}/split` : null);
  const [splitting, setSplitting] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const total = t.split_total_cents ?? t.amount_cents;
  const catOpts = categories.map((c) => ({ value: c.id, label: c.name, color: c.color }));

  // Save text fields on blur, only when changed (empty clears).
  async function saveText(field: "custom_description" | "note", v: string) {
    if (v.trim() === (t[field] ?? "")) return;
    try {
      onRow(await api<Transaction>(`/transactions/${t.id}`, "PATCH", { [field]: v.trim() || null }));
    } catch (e) {
      fail(e);
    }
  }

  async function saveDate(date: string) {
    if (!date || date === t.date) return;
    try {
      onRow(await api<Transaction>(`/transactions/${t.id}`, "PATCH", { date }));
    } catch (e) {
      fail(e);
    }
  }

  async function upload(files: FileList | null, input: HTMLInputElement) {
    if (!files?.length) return;
    setUploading(true);
    let list = rc.data ?? [];
    try {
      for (const f of Array.from(files)) {
        if (f.size > MAX_BYTES) { toast(`${f.name} is over 10 MB`); continue; }
        const r = await api<Receipt>(`/transactions/${t.id}/receipts`, "POST", { file_name: f.name, content_base64: await readBase64(f) });
        list = [...list, r];
        rc.set(list);
      }
    } catch (e) {
      fail(e);
    } finally {
      setUploading(false);
      input.value = "";
      onRow({ ...t, receipt_count: list.length });
    }
  }

  async function remove(r: Receipt) {
    if (!(await confirm({ title: "Remove receipt?", body: r.file_name, confirmLabel: "Remove", danger: true }))) return;
    try {
      await api(`/receipts/${r.id}`, "DELETE");
      const list = (rc.data ?? []).filter((x) => x.id !== r.id);
      rc.set(list);
      onRow({ ...t, receipt_count: list.length });
    } catch (e) {
      fail(e);
    }
  }

  async function saveSplit(parts: SplitPartInput[]) {
    setSplitBusy(true);
    try {
      await api<Transaction[]>(`/transactions/${t.id}/split`, "POST", { parts });
      toast("Split saved");
      onSplit();
    } catch (e) {
      fail(e);
    } finally {
      setSplitBusy(false);
    }
  }

  async function unsplit() {
    if (!(await confirm({ title: "Unsplit transaction?", body: `Parts are removed and the ${money(total)} transaction is restored. Part categories and notes are discarded.`, confirmLabel: "Unsplit", danger: true }))) return;
    try {
      await api<Transaction>(`/transactions/${t.id}/split`, "DELETE");
      toast("Split removed");
      onSplit();
    } catch (e) {
      fail(e);
    }
  }

  const draftOf = (p: Transaction): PartDraft => ({ amount: centsToInput(Math.abs(p.amount_cents)), cat: p.category_id, note: p.note ?? "" });

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id="tx-title" className="m-0 text-lg font-semibold">Transaction</h2>
        <button type="button" className={btnSecondary} onClick={onClose}>Close</button>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-3"><label htmlFor="tx-date">Date</label></dt>
        <dd className="m-0">
          <input id="tx-date" type="date" className={inputCls} defaultValue={t.date} onBlur={(e) => saveDate(e.target.value)} />
          {t.original_date && <div className="mt-1 text-xs text-ink-3">Bank date: {fmtDate(t.original_date, true)}</div>}
        </dd>
        <dt className="text-ink-3">Account</dt><dd className="m-0">{accounts.find((a) => a.id === t.account_id)?.name ?? "—"}</dd>
        <dt className="text-ink-3">Amount</dt><dd className="m-0">{money(t.amount_cents, { sign: true })}</dd>
        <dt className="text-ink-3">Bank description</dt><dd className="m-0 break-words">{t.description}</dd>
      </dl>
      <Field label="Description">
        <input className={inputCls} value={desc} placeholder={t.description} maxLength={200} onChange={(e) => setDesc(e.target.value)} onBlur={() => saveText("custom_description", desc)} />
      </Field>
      <div className="flex flex-col gap-[6px] text-[13px] text-ink-2">
        Category
        <Select label="Category" value={t.category_id} options={catOpts} onChange={(v) => onCat(t, v as number)} className={`${inputCls} w-full justify-between`} />
      </div>
      <Field label="Note">
        <textarea className={inputCls} rows={4} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} onBlur={() => saveText("note", note)} />
      </Field>
      <section aria-label="Split" className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-medium text-ink-2">Split</h3>
        {splitting ? (
          <SplitEditor
            total={total}
            busy={splitBusy}
            initial={isPart ? (group.data?.parts ?? []).map(draftOf) : [{ amount: "", cat: t.category_id, note: "" }, { amount: "", cat: t.category_id, note: "" }]}
            defaultCat={t.category_id}
            onCancel={() => setSplitting(false)}
            onSave={saveSplit}
          />
        ) : isPart ? (
          <>
            <p className="m-0 text-[13px]">Part of a {money(total)} split</p>
            {group.error && !group.data ? (
              <LoadErr msg={group.error} retry={group.reload} />
            ) : !group.data ? (
              <Loading />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                {group.data.parts.map((p) => (
                  <li key={p.id} className={`flex justify-between gap-3 ${p.id === t.id ? "font-medium" : "text-ink-2"}`}>
                    <span className="min-w-0 truncate">{categories.find((c) => c.id === p.category_id)?.name ?? "Category"}{p.note ? ` · ${p.note}` : ""}{p.id === t.id ? " (this)" : ""}</span>
                    <span>{money(p.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <button type="button" className={btnSecondary} disabled={!group.data} onClick={() => setSplitting(true)}>Edit split</button>
              <button type="button" className={btnDangerText} onClick={unsplit}>Unsplit</button>
            </div>
          </>
        ) : (
          <div><button type="button" className={btnSecondary} onClick={() => setSplitting(true)}>Split</button></div>
        )}
      </section>
      <section aria-label="Receipts" className="flex flex-col gap-2">
        <h3 className="m-0 text-[13px] font-medium text-ink-2">Receipts</h3>
        {rc.error && !rc.data ? (
          <LoadErr msg={rc.error} retry={rc.reload} />
        ) : !rc.data ? (
          <Loading />
        ) : rc.data.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-3">No receipts yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rc.data.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-[9px] border border-line p-2">
                <a href={`/api/receipts/${r.id}`} target="_blank" rel="noreferrer" className="shrink-0" aria-label={`Open ${r.file_name}`}>
                  {r.mime_type.startsWith("image/")
                    ? <img src={`/api/receipts/${r.id}`} alt="" className="h-14 w-14 rounded-[6px] object-cover" />
                    : <span className="grid h-14 w-14 place-items-center rounded-[6px] bg-surface-2 text-xs text-ink-2">PDF</span>}
                </a>
                <span className="min-w-0 flex-1 text-[13px]">
                  <span className="block truncate">{r.file_name}</span>
                  <span className="text-ink-3">{kb(r.size_bytes)}</span>
                </span>
                <button type="button" className={btnDangerText} onClick={() => remove(r)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <Field label="Add receipt">
          <input type="file" multiple disabled={uploading} accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => upload(e.target.files, e.target)} className="text-[13px]" />
        </Field>
        {uploading && <Loading what="Uploading…" />}
      </section>
    </div>
  );
}

interface PartDraft { amount: string; cat: number; note: string }

/** Parts are entered as positive dollars; the total's sign is applied on save. Saves only when nothing remains. */
function SplitEditor({ total, initial, defaultCat, busy, onCancel, onSave }: {
  total: number; initial: PartDraft[]; defaultCat: number; busy: boolean; onCancel: () => void; onSave: (p: SplitPartInput[]) => void;
}) {
  const { categories } = useApp();
  const [parts, setParts] = useState(initial);
  const sign = total < 0 ? -1 : 1;
  const cents = parts.map((p) => dollarsToCents(p.amount));
  const remaining = Math.abs(total) - cents.reduce((a, b) => a + b, 0);
  const ok = remaining === 0 && parts.length >= 2 && cents.every((c) => c > 0);
  const upd = (i: number, patch: Partial<PartDraft>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const catOpts = categories.map((c) => ({ value: c.id, label: c.name, color: c.color }));
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSave(parts.map((p, i) => ({ amount_cents: sign * cents[i], category_id: p.cat, note: p.note.trim() || null })));
      }}
      className="flex flex-col gap-3"
    >
      {parts.map((p, i) => (
        <fieldset key={i} className="m-0 flex flex-col gap-2 rounded-[9px] border border-line p-3">
          <legend className="px-1 text-xs text-ink-3">Part {i + 1}</legend>
          <div className="flex gap-2">
            <input aria-label={`Part ${i + 1} amount ($)`} inputMode="decimal" placeholder="0.00" value={p.amount} onChange={(e) => upd(i, { amount: cleanDollars(e.target.value) })} className={`${inputCls} w-24`} />
            <Select label={`Part ${i + 1} category`} value={p.cat} options={catOpts} onChange={(v) => upd(i, { cat: v as number })} className={`${inputCls} min-w-0 flex-1 justify-between`} />
          </div>
          <div className="flex gap-2">
            <input aria-label={`Part ${i + 1} note`} placeholder="Note (optional)" maxLength={2000} value={p.note} onChange={(e) => upd(i, { note: e.target.value })} className={`${inputCls} min-w-0 flex-1`} />
            {parts.length > 2 && <button type="button" aria-label={`Remove part ${i + 1}`} className={btnDangerText} onClick={() => setParts(parts.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        </fieldset>
      ))}
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <button type="button" className={btnLink} onClick={() => setParts([...parts, { amount: remaining > 0 ? centsToInput(remaining) : "", cat: defaultCat, note: "" }])}>Add part</button>
        <span aria-live="polite" className={remaining === 0 ? "text-pos" : remaining < 0 ? "text-neg" : "text-ink-2"}>
          Remaining {money(sign * remaining)} of {money(total)}
        </span>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={!ok || busy} className={btnPrimary}>Save split</button>
        <button type="button" className={btnSecondary} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
