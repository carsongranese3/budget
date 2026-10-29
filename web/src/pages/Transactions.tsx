import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  CreateRuleResponse, Receipt, Rule, RuleImpactResponse, Transaction, TransactionsResponse,
} from "../../../shared/types";
import { merchantKey } from "../../../shared/merchant";
import { computeTotals } from "../../../shared/totals";
import { api, useGet } from "../api";
import { useApp } from "../app";
import { fmtDate, money, monthLabel, plural, txQuery } from "../lib";
import { btnDangerText, btnLink, btnPrimary, btnSecondary, Card, EmptyState, inputCls, Loading, LoadErr, PageHead, Select } from "../ui";

interface Prompt { id: number; key: string; text: string; catId: number; impact: number }

export default function Transactions() {
  const { month, months, categories, accounts, to, toast, fail, refreshBadge, reload } = useApp();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const account = params.get("account") ?? "";
  const category = params.get("category") ?? "";
  const [q, setQ] = useState(urlQ);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  // Invalid URL filter values are treated as "All" and never sent to the API.
  const catFilterValid = !category || (/^\d+$/.test(category) && categories.some((c) => c.id === Number(category)));
  const accountValid = !account || /^\d+$/.test(account);
  const path = useMemo(() => {
    return txQuery(month, urlQ, account, category, categories.map((c) => c.id));
  }, [month, urlQ, account, category, categories]);
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
  useEffect(() => { setPrompt(null); setOpenId(null); }, [path]);
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
  const filtered = !!(urlQ || (account && accountValid) || (category && catFilterValid));

  const setRow = (updated: Transaction) => {
    const rows = tx.data!.transactions.map((r) => (r.id === updated.id ? updated : r));
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
  const open = d?.transactions.find((r) => r.id === openId) ?? null;
  const sub = d ? `${plural(d.transactions.length, "transaction")} · ${money(d.spent_cents)} spent · ${money(d.income_cents)} income` : monthLabel(month);

  let empty: { title: string; body: string; action: React.ReactNode } | null = null;
  if (d && d.transactions.length === 0) {
    if (!months.has_transactions)
      empty = { title: "No transactions yet", body: "Import a bank or card statement to see your transactions here.", action: <Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link> };
    else if (category === String(uncat.id) && !urlQ && !(account && accountValid))
      empty = { title: "All caught up", body: `Every transaction in ${monthLabel(month)} has a category.`, action: <button className={btnSecondary} onClick={clear}>Clear filters</button> };
    else if (filtered)
      empty = { title: "Nothing matches", body: "No transactions match these filters.", action: <button className={btnSecondary} onClick={clear}>Clear filters</button> };
    else
      empty = { title: `No transactions in ${monthLabel(month)}`, body: "Import a statement that covers this month.", action: <Link to={to("/import")} className={`${btnPrimary} no-underline`}>Go to Import →</Link> };
  }

  return (
    <>
      <PageHead title="Transactions" sub={sub} />
      <div className="flex flex-wrap items-center gap-2">
        <input
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
        {filtered && <button type="button" className={btnLink} onClick={clear}>Clear filters</button>}
      </div>

      {tx.error && !d ? (
        <LoadErr msg={tx.error} retry={tx.reload} />
      ) : !d ? (
        <Loading />
      ) : (
        <Card className="overflow-x-auto">
          {empty ? (
            <EmptyState {...empty} />
          ) : (
            <table className="w-full min-w-[760px] table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-20" /><col /><col className="w-[136px]" /><col className="w-[200px]" /><col className="w-[116px]" />
              </colgroup>
              <thead>
                <tr className="bg-surface-2 text-left text-[12.5px] font-medium text-ink-3">
                  <th className="px-[18px] py-2 font-medium">Date</th>
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
                      <tr onClick={(e) => { setTrigger(e.currentTarget.querySelector("button[data-open]")); setOpenId(t.id); }} className={`cursor-pointer border-t border-line ${isUn ? "bg-hl" : ""} ${muted ? "text-ink-3" : ""}`}>
                        <td className="px-[18px] py-[7px] whitespace-nowrap text-ink-2">{fmtDate(t.date)}</td>
                        <td className="px-2 py-[7px] font-medium">
                          <div className="flex items-center gap-1">
                            <button type="button" data-open className="min-w-0 truncate border-0 bg-transparent p-0 text-left font-medium text-inherit" title={t.description} aria-label={`Details for ${t.custom_description ?? t.description}`}>
                              {t.custom_description ?? t.description}
                            </button>
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
                          <td colSpan={5} className="px-3 py-2">
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
      <Drawer t={open} trigger={trigger} onClose={() => setOpenId(null)} onCat={changeCat} onRow={setRow} />
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
function Drawer({ t, trigger, onClose, onCat, onRow }: {
  t: Transaction | null; trigger: HTMLElement | null; onClose: () => void;
  onCat: (t: Transaction, catId: number) => void; onRow: (t: Transaction) => void;
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
      {t && <Detail key={t.id} t={t} onClose={onClose} onCat={onCat} onRow={onRow} />}
    </dialog>
  );
}

function Detail({ t, onClose, onCat, onRow }: {
  t: Transaction; onClose: () => void; onCat: (t: Transaction, catId: number) => void; onRow: (t: Transaction) => void;
}) {
  const { categories, accounts, toast, fail, confirm } = useApp();
  const [desc, setDesc] = useState(t.custom_description ?? "");
  const [note, setNote] = useState(t.note ?? "");
  const [uploading, setUploading] = useState(false);
  const rc = useGet<Receipt[]>(`/transactions/${t.id}/receipts`);
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

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id="tx-title" className="m-0 text-lg font-semibold">Transaction</h2>
        <button type="button" className={btnSecondary} onClick={onClose}>Close</button>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-3">Date</dt><dd className="m-0">{fmtDate(t.date, true)}</dd>
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
