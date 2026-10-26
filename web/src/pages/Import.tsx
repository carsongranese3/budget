import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AccountType, ColumnRole, CommitImportResponse, CsvFormat, ImportListItem, PreviewResponse, PreviewReview,
  SampleCsvResponse, SignMode, UndoImportResponse,
} from "../../../shared/types";
import { detectFormat, parseCsvText, parseDate, parseRows } from "../../../shared/csv";
import { api, ApiFail, useGet } from "../api";
import { useApp } from "../app";
import { fmtDate, localDate, money, plural } from "../lib";
import { btnLink, btnPrimary, btnSecondary, Card, inputCls, LoadErr, Loading, PageHead, Segmented, Select } from "../ui";

interface Job { file_name: string; content: string; records: string[][]; preview: PreviewResponse; base: CsvFormat; recognized: boolean; changed?: boolean }
type Step = 1 | 2 | 3 | 4;
const MAX_BYTES = 10 * 1024 * 1024;
const ROLES: { value: ColumnRole; label: string }[] = [
  { value: "date", label: "Date" }, { value: "description", label: "Description" }, { value: "amount", label: "Amount" },
  { value: "debit", label: "Debit" }, { value: "credit", label: "Credit" }, { value: "ignore", label: "Ignore" },
];
const ACCT_TYPES: [AccountType, string][] = [["checking", "Checking"], ["credit_card", "Credit card"], ["savings", "Savings"]];
const PAGE = 200; // shortcut: review table renders 200 rows at a time (all rows still import); virtualize if this feels slow

export default function Import() {
  const { accounts, categories, month, months, toast, fail, reload } = useApp();
  const navigate = useNavigate();
  const imports = useGet<ImportListItem[]>("/imports");
  const [step, setStep] = useState<Step>(1);
  const [queue, setQueue] = useState<{ file_name: string; content: string }[]>([]);
  const [idx, setIdx] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  // step 2 choices
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [signMode, setSignMode] = useState<SignMode>("purchases_negative");
  const [acct, setAcct] = useState<number | "new" | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AccountType>("checking");
  const [remember, setRemember] = useState(true);
  // step 3/4
  const [review, setReview] = useState<PreviewReview | null>(null);
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [shown, setShown] = useState(PAGE);
  const [result, setResult] = useState<CommitImportResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const uncat = categories.find((c) => c.system_key === "uncategorized")!;
  const catOpts = categories.map((c) => ({ value: c.id, label: c.name, color: c.color }));

  const format: CsvFormat | null = job
    ? { header_signature: job.base.header_signature, column_roles: roles, sign_mode: signMode, date_format: job.base.date_format, has_header: job.base.has_header }
    : null;

  /** Reopen Step 2 for a recognized file, prefilled with its account + format (already in state). */
  function changeSetup() {
    if (job) setJob({ ...job, recognized: false, changed: true });
    setStep(2);
  }

  function reset() {
    setStep(1); setJob(null); setReview(null); setResult(null); setQueue([]); setIdx(0); setOverrides({});
  }

  /** Preview one queued file and route to Step 2 or (recognized format) straight to Step 3. */
  async function loadJob(f: { file_name: string; content: string }, rest: { file_name: string; content: string }[], at: number) {
    setBusy(true);
    try {
      const preview = await api<PreviewResponse>("/imports/preview", "POST", { file_name: f.file_name, content: f.content });
      const records = parseCsvText(f.content);
      const recognized = preview.matched_accounts.length === 1 && preview.review !== null;
      const saved = preview.matched_accounts.length > 0 ? accounts.find((a) => a.id === preview.matched_accounts[0].id)?.csv_format : null;
      const base = recognized ? preview.review!.format : (saved ?? preview.detected_format ?? detectFormat(records));
      setJob({ ...f, records, preview, base, recognized });
      setRoles(base.column_roles);
      setSignMode(base.sign_mode);
      setRemember(true);
      setNewName("");
      setNewType("checking");
      setOverrides({});
      setShown(PAGE);
      setResult(null);
      setQueue(rest);
      setIdx(at);
      if (recognized) {
        setAcct(preview.matched_accounts[0].id);
        setReview(preview.review);
        setStep(3);
      } else {
        setReview(null);
        setAcct(
          preview.matched_accounts.length > 1 ? null
            : preview.suggested_account_id ?? (accounts.length === 0 ? "new" : null),
        );
        setStep(2);
      }
    } catch (e) {
      const msg = e instanceof ApiFail && e.code === "invalid_file" ? `Skipped ${f.file_name} — ${e.message}` : null;
      if (!msg) fail(e);
      else setErrors((x) => [...x, msg]);
      const left = rest.filter((_, i) => i !== at); // drop the rejected file so "file N of M" stays accurate
      if (msg && left.length > at) await loadJob(left[at], left, at);
      else if (msg) reset();
    } finally {
      setBusy(false);
    }
  }

  async function takeFiles(files: File[]) {
    if (!files.length || busy) return;
    const errs: string[] = [];
    const ok: { file_name: string; content: string }[] = [];
    for (const f of files) {
      if (!/\.csv$/i.test(f.name)) errs.push(`Skipped ${f.name} — This doesn't look like a CSV export.`);
      else if (f.size > MAX_BYTES) errs.push(`Skipped ${f.name} — This file is too large (max 10 MB).`);
      else ok.push({ file_name: f.name, content: await f.text() });
    }
    setErrors(errs);
    if (ok.length) await loadJob(ok[0], ok, 0);
  }

  async function useSample() {
    setErrors([]);
    try {
      const s = await api<SampleCsvResponse>("/imports/sample-csv");
      await loadJob(s, [s], 0);
    } catch (e) {
      fail(e);
    }
  }

  // ---- Step 2 helpers
  const setRole = (i: number, role: ColumnRole) =>
    setRoles((rs) => rs.map((r, k) => (k === i ? role : role !== "ignore" && r === role ? "ignore" : r)));

  const newNameTaken = accounts.some((a) => a.name.toLowerCase() === newName.trim().toLowerCase());
  const acctOk = acct !== null && (acct !== "new" || (newName.trim() !== "" && !newNameTaken));
  const acctName = acct === "new" ? newName.trim() || "new account" : accounts.find((a) => a.id === acct)?.name ?? "";

  const parsed = useMemo(() => (job && format ? parseRows(job.records, format) : null), [job, roles, signMode]); // eslint-disable-line
  const check = useMemo(() => {
    if (!job || !parsed) return null;
    const dc = signMode === "debit_credit";
    if (!roles.includes("date")) return { kind: "issue", msg: "No column is set as Date. Choose one above." };
    if (!roles.includes("description")) return { kind: "issue", msg: "No column is set as Description. Choose one above." };
    if (dc && (!roles.includes("debit") || !roles.includes("credit")))
      return { kind: "issue", msg: "Separate debit and credit columns needs a Debit column and a Credit column. Choose them above." };
    if (!dc && !roles.includes("amount")) return { kind: "issue", msg: "No column is set as Amount. Choose one above." };
    const total = parsed.rows.length + parsed.unreadable.length;
    if (total > 0 && parsed.unreadable.length * 2 > total) {
      const data = job.records.slice(-job.preview.row_count);
      const di = roles.indexOf("date");
      const badDates = data.filter((r) => parseDate(r[di] ?? "") === null).length;
      if (badDates * 2 > data.length) return { kind: "issue", msg: "The Date column doesn't contain dates. Try a different column." };
      return { kind: "issue", msg: dc ? "The Debit and Credit columns don't contain amounts." : "The Amount column doesn't contain numbers. Try a different column." };
    }
    const five = parsed.rows.slice(0, 5);
    const inc = five.filter((r) => r.amount_cents > 0).length;
    const out = five.length - inc;
    if (inc > out)
      return { kind: "warn", msg: `${inc} of ${five.length} ${five.length === 1 ? "row comes" : "rows come"} out as income. If those are purchases, ${dc ? "check which column is Debit and which is Credit" : `choose '${signMode === "purchases_negative" ? "Purchases are positive" : "Purchases are negative"}'`}.` };
    return { kind: "ok", msg: `✓ Looks right — ${plural(out, "purchase")} ${out === 1 ? "comes" : "come"} out as spending, ${plural(inc, "deposit")} as income.` };
  }, [job, parsed, roles, signMode]);

  async function toReview() {
    if (!job || !format) return;
    setBusy(true);
    try {
      const p = await api<PreviewResponse>("/imports/preview", "POST", {
        file_name: job.file_name, content: job.content, account_id: typeof acct === "number" ? acct : null, format,
      });
      setReview(p.review);
      setOverrides({});
      setShown(PAGE);
      setStep(3);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // ---- Step 3
  const catOf = (line: number, base: number) => overrides[line] ?? base;
  const newRows = review?.new_rows ?? [];
  const needCat = newRows.filter((r) => catOf(r.line, r.category_id) === uncat.id).length;

  async function commit() {
    if (!job || !review) return;
    setBusy(true);
    try {
      const fmt = job.recognized ? review.format : format!;
      const res = await api<CommitImportResponse>("/imports", "POST", {
        file_name: job.file_name,
        content: job.content,
        account_id: typeof acct === "number" ? acct : null,
        new_account: acct === "new" ? { name: newName.trim(), type: newType } : null,
        format: fmt,
        save_format: job.recognized ? false : remember,
        category_overrides: Object.entries(overrides).map(([line, category_id]) => ({ line: Number(line), category_id })),
      });
      setResult(res);
      setStep(4);
      reload();
      imports.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function undo(i: ImportListItem) {
    const ok = await confirmUndo(i);
    if (!ok) return;
    try {
      const r = await api<UndoImportResponse>(`/imports/${i.id}`, "DELETE");
      toast(`Import undone · ${plural(r.removed_count, "transaction")} removed`);
      imports.reload();
      reload();
    } catch (e) {
      fail(e);
    }
  }
  const { confirm } = useApp();
  const confirmUndo = (i: ImportListItem) =>
    confirm({
      title: `Undo import of ${i.file_name}?`,
      body: `${plural(i.transaction_count, "transaction")} will be removed, including any you've recategorized. Rules, accounts and saved formats are kept.`,
      confirmLabel: "Undo import",
    });

  const more = queue.length > idx + 1;
  const resMonth = result?.import.last_date?.slice(0, 7);
  const goMonth = (path: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams(extra);
    const m = resMonth ?? month;
    if (m !== months.current_month) q.set("month", m);
    navigate(`${path}${q.toString() ? "?" + q : ""}`);
  };

  const fileHead = job && (
    <span>
      <b className="font-mono text-[13.5px] font-medium">{job.file_name}</b>
      {queue.length > 1 && <span className="text-ink-3"> · file {idx + 1} of {queue.length}</span>}
    </span>
  );

  return (
    <>
      <PageHead title="Import" sub="Bring in a bank or card statement as a CSV." />
      <Stepper
        step={step}
        recognized={!!job?.recognized}
        go={(n) => (n === 1 ? reset() : n === 2 && job?.recognized ? changeSetup() : setStep(n as Step))}
      />

      {errors.length > 0 && (
        <ul role="alert" className="m-0 list-none rounded-[9px] border border-warn bg-warn-soft p-3 text-warn-ink">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {step === 1 && (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop your bank's CSV export here, or choose files"
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInput.current?.click())}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); takeFiles([...e.dataTransfer.files]); }}
            className={`flex flex-col items-center gap-2 rounded-[14px] border-[1.5px] border-dashed px-6 py-[clamp(36px,7vw,64px)] text-center ${drag ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`}
          >
            <span aria-hidden className="mb-1 flex h-[46px] w-[38px] items-center justify-center rounded-md border-[1.5px] border-ink-3 text-[11px] font-semibold text-ink-2">CSV</span>
            <div className="text-[19px] font-semibold">Drop your bank's CSV export here</div>
            <div className="text-ink-2">or <span className="text-accent underline">choose files</span> · several files at once is fine</div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              multiple
              hidden
              aria-label="Choose CSV files"
              onChange={(e) => { takeFiles([...(e.target.files ?? [])]); e.target.value = ""; }}
            />
          </div>
          {busy && <Loading what="Reading file…" />}
          <p className="m-0 text-ink-2">
            No file handy? <button type="button" className={btnLink} disabled={busy} onClick={useSample}>Use a sample Chase export</button>
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {[
              ["Chase", "Open your account, choose Download account activity, then pick CSV."],
              ["American Express", "Go to Statements & Activity, choose Download, then pick CSV."],
              ["Other banks", "Look for Download, Export or CSV in your account's transaction list."],
            ].map(([t, b]) => (
              <Card key={t} className="p-4">
                <div className="font-medium">{t}</div>
                <p className="m-0 mt-1 text-[13px] text-ink-2">{b}</p>
              </Card>
            ))}
          </div>
          {imports.error && !imports.data ? (
            <LoadErr msg={imports.error} retry={imports.reload} />
          ) : imports.data && imports.data.length > 0 ? (
            <Card>
              <h2 className="m-0 px-[18px] pt-4 pb-2 text-[14.5px] font-semibold">Recent imports</h2>
              <ul className="m-0 list-none p-0">
                {imports.data.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-[18px] py-[10px] text-[13.5px]">
                    <span className="min-w-0 flex-1 basis-[200px] truncate font-mono">{i.file_name}</span>
                    <span className="text-ink-2">{i.account_name}</span>
                    <span className="text-ink-3">{fmtDate(localDate(i.imported_at), true)}</span>
                    <span className="text-ink-2">
                      {i.new_count.toLocaleString("en-US")} new / {i.skipped_count.toLocaleString("en-US")} skipped{i.unreadable_count > 0 ? ` / ${i.unreadable_count.toLocaleString("en-US")} unreadable` : ""}
                    </span>
                    <button type="button" className={`${btnLink} !text-neg`} aria-label={`Undo import of ${i.file_name}`} onClick={() => undo(i)}>Undo</button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}

      {step === 2 && job && format && (
        <>
          <Card className="p-[18px]">
            <div className="flex flex-wrap items-baseline gap-x-3">{fileHead}<span className="text-ink-2">{plural(job.preview.row_count, "row")}</span></div>
            <p className="m-0 mt-1 text-ink-2">{job.changed ? "Change how this file is read — your saved format will be updated if Remember is checked." : "We haven't seen this column layout before — set it up once and we'll remember it."}</p>
          </Card>

          <section aria-labelledby="s2a" className="flex flex-col gap-2">
            <h2 id="s2a" className="m-0 text-[17px] font-semibold">1 · Which account is this?</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
              {accounts.map((a) => (
                <RadioCard key={a.id} name="acct" checked={acct === a.id} onChange={() => setAcct(a.id)} title={a.name}
                  sub={job.preview.suggested_account_id === a.id ? "Detected from file name" : ACCT_TYPES.find(([t]) => t === a.type)![1]} />
              ))}
              <RadioCard name="acct" checked={acct === "new"} onChange={() => setAcct("new")} title="New account" sub="Created when you import" />
            </div>
            {acct === "new" && (
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-[13px] text-ink-2">
                  Account name
                  <input className={`${inputCls} w-[240px] max-w-full`} value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} aria-invalid={newNameTaken} aria-describedby="nn" />
                </label>
                <Segmented label="Account type" value={newType} onChange={setNewType} options={ACCT_TYPES} />
                {newNameTaken && <span id="nn" className="text-[13px] text-warn-ink">You already have an account with that name.</span>}
              </div>
            )}
          </section>

          <section aria-labelledby="s2b" className="flex flex-col gap-2">
            <h2 id="s2b" className="m-0 text-[17px] font-semibold">2 · What's in each column?</h2>
            <Card className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[12.5px]">
                <thead>
                  <tr>
                    {roles.map((r, i) => (
                      <th key={i} className={`border-b border-line p-2 text-left align-bottom font-sans ${r === "ignore" ? "" : "bg-accent-soft"}`}>
                        <Select
                          label={`Column ${i + 1} role`}
                          value={r}
                          options={ROLES}
                          onChange={(v) => setRole(i, v as ColumnRole)}
                          className={`${inputCls} w-full min-w-[110px] justify-between ${r === "ignore" ? "!text-ink-3" : "!border-accent"}`}
                        />
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {job.preview.columns.map((c, i) => (
                      <th key={i} className={`border-b border-line px-3 py-[6px] text-left font-medium ${roles[i] === "ignore" ? "text-ink-3" : "bg-accent-soft"}`}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {job.preview.sample_rows.slice(0, 5).map((row, ri) => (
                    <tr key={ri}>
                      {roles.map((r, i) => (
                        <td key={i} className={`max-w-[260px] truncate border-t border-line px-3 py-[6px] ${r === "ignore" ? "text-ink-3" : "bg-accent-soft"}`}>{row[i] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          <section aria-labelledby="s2c" className="flex flex-col gap-2">
            <h2 id="s2c" className="m-0 text-[17px] font-semibold">3 · How are amounts signed?</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
              {([
                ["purchases_negative", "Purchases are negative"],
                ["purchases_positive", "Purchases are positive"],
                ["debit_credit", "Separate debit and credit columns"],
              ] as [SignMode, string][]).map(([m, l]) => (
                <RadioCard key={m} name="sign" checked={signMode === m} onChange={() => setSignMode(m)} title={l}
                  sub={job.preview.detected_format.sign_mode === m ? "detected in this file" : undefined} />
              ))}
            </div>
            {check && parsed && (
              <Card className="overflow-x-auto">
                {check.kind !== "issue" && parsed.rows.length > 0 && (
                  <table className="w-full border-collapse text-[13.5px]">
                    <tbody>
                      {parsed.rows.slice(0, 5).map((r) => (
                        <tr key={r.line} className="border-b border-line last:border-b-0">
                          <td className="px-[18px] py-[6px] whitespace-nowrap text-ink-2">{fmtDate(r.date)}</td>
                          <td className="max-w-[280px] truncate px-2 py-[6px]">{r.description}</td>
                          <td className="px-2 py-[6px]">
                            <span className={`rounded-full px-2 py-[1px] text-[11.5px] ${r.amount_cents > 0 ? "bg-pos-soft text-pos" : "bg-surface-2 text-ink-2"}`}>
                              {r.amount_cents > 0 ? "Income" : "Spending"}
                            </span>
                          </td>
                          <td className={`px-[18px] py-[6px] text-right ${r.amount_cents > 0 ? "text-pos" : ""}`}>{r.amount_cents > 0 ? money(r.amount_cents, { sign: true }) : money(-r.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p role="status" className={`m-0 px-[18px] py-3 text-[13.5px] ${check.kind === "ok" ? "text-pos" : "text-warn-ink"}`}>{check.msg}</p>
              </Card>
            )}
          </section>

          <Footer>
            <label className="flex flex-1 items-center gap-2 text-[13.5px]">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember this format for {acctName || "this account"}
            </label>
            <button type="button" className={btnSecondary} onClick={reset}>Back</button>
            <button type="button" className={btnPrimary} disabled={busy || check?.kind === "issue" || !acctOk} onClick={toReview}>
              {busy ? "Checking…" : "Continue to review"}
            </button>
          </Footer>
        </>
      )}

      {step === 3 && job && (review ? (
        <>
          <Card className="p-[18px]">
            <div className="flex flex-wrap items-baseline gap-x-3">{fileHead}<span className="text-ink-2">→ {acctName}</span></div>
            {job.recognized && <p className="m-0 mt-1 text-ink-2">Recognized your saved format for this file — no setup needed. <button type="button" className={btnLink} onClick={changeSetup}>Change setup</button></p>}
            <p className="m-0 mt-2 text-[14.5px] text-ink-2" role="status">
              <b className="text-ink">{plural(review.new_rows.length + review.duplicate_rows.length + review.unreadable_rows.length, "row")} found</b> ·{" "}
              <b className="text-ink">{review.new_rows.length.toLocaleString("en-US")} new</b> · {review.duplicate_rows.length.toLocaleString("en-US")} already imported (skipped)
              {review.unreadable_rows.length > 0 && ` · ${review.unreadable_rows.length.toLocaleString("en-US")} couldn't be read`}
              {" · "}
              {needCat === 0 ? <b className="text-pos">All categorized</b> : <b className="text-warn-ink">{needCat.toLocaleString("en-US")} need a category</b>}
            </p>
          </Card>

          {newRows.length > 0 && (
            <Card className="max-h-[540px] overflow-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-[12.5px] text-ink-3">
                    <th className="sticky top-0 bg-surface-2 px-[18px] py-2 font-medium">Date</th>
                    <th className="sticky top-0 bg-surface-2 px-2 py-2 font-medium">Description</th>
                    <th className="sticky top-0 bg-surface-2 px-2 py-2 font-medium">Category</th>
                    <th className="sticky top-0 bg-surface-2 px-[18px] py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {newRows.slice(0, shown).map((r) => {
                    const c = catOf(r.line, r.category_id);
                    const un = c === uncat.id;
                    const viaRule = r.rule_merchant && overrides[r.line] === undefined;
                    return (
                      <tr key={r.line} className={`border-t border-line ${un ? "bg-hl" : ""}`}>
                        <td className="px-[18px] py-[5px] whitespace-nowrap text-ink-2">{fmtDate(r.date)}</td>
                        <td className="max-w-[320px] truncate px-2 py-[5px] font-medium" title={r.description}>{r.description}</td>
                        <td className="px-2 py-[3px]">
                          <span className="flex items-center gap-2">
                            <Select
                              label={`Category for ${r.description}`}
                              value={c}
                              options={catOpts}
                              onChange={(v) => setOverrides((o) => ({ ...o, [r.line]: v as number }))}
                              className={`w-[180px] rounded-[7px] border bg-transparent px-2 py-[4px] text-[13.5px] hover:border-line-strong ${un ? "border-warn" : "border-transparent"}`}
                            />
                            {viaRule && (
                              <span title={`Matched rule: ${r.rule_merchant}`} className="rounded-[5px] border border-line-strong px-[5px] text-[11px] text-ink-2">rule</span>
                            )}
                          </span>
                        </td>
                        <td className={`px-[18px] py-[5px] text-right whitespace-nowrap ${r.amount_cents > 0 ? "text-pos" : ""}`}>
                          {r.amount_cents > 0 ? money(r.amount_cents, { sign: true }) : money(-r.amount_cents)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown < newRows.length && (
                <div className="border-t border-line p-3 text-center">
                  <button type="button" className={btnSecondary} onClick={() => setShown((s) => s + PAGE)}>
                    Show {Math.min(PAGE, newRows.length - shown).toLocaleString("en-US")} more ({(newRows.length - shown).toLocaleString("en-US")} not shown)
                  </button>
                </div>
              )}
            </Card>
          )}

          {review.duplicate_rows.length > 0 && (
            <Disclosure summary={`${review.duplicate_rows.length.toLocaleString("en-US")} already imported — skipped`} hint="Matched on account, date, amount and description">
              <MiniRows rows={review.duplicate_rows.map((r) => [String(r.line), fmtDate(r.date), r.description, money(Math.abs(r.amount_cents))])} />
            </Disclosure>
          )}
          {review.unreadable_rows.length > 0 && (
            <Disclosure summary={`${plural(review.unreadable_rows.length, "row")} couldn't be read — skipped`} hint="These never block the import.">
              <MiniRows rows={review.unreadable_rows.map((r) => [`line ${r.line}`, r.raw])} mono />
            </Disclosure>
          )}

          <Footer>
            <span className="min-w-[200px] flex-1 text-[13.5px] text-ink-2">
              {needCat > 0 && `${plural(needCat, "uncategorized row")} will come in as Uncategorized — you can sort them out later.`}
            </span>
            <button type="button" className={btnSecondary} onClick={() => (job.recognized ? reset() : setStep(2))}>Back</button>
            <button type="button" className={btnPrimary} disabled={busy || newRows.length === 0} onClick={commit}>
              {newRows.length === 0 ? "Nothing to import" : busy ? "Importing…" : `Import ${plural(newRows.length, "transaction")}`}
            </button>
          </Footer>
        </>
      ) : (
        <Loading />
      ))}

      {step === 4 && result && (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span aria-hidden className="mb-1 flex size-[52px] items-center justify-center rounded-full bg-pos-soft text-[24px] text-pos">✓</span>
          <h2 className="m-0 text-[21px] font-semibold">{plural(result.import.new_count, "transaction")} imported</h2>
          <p className="m-0 text-ink-2">
            Added to {result.account.name}
            {result.import.first_date && result.import.last_date && (
              <> · {result.import.first_date === result.import.last_date ? fmtDate(result.import.last_date, true) : <>{fmtDate(result.import.first_date, result.import.first_date.slice(0, 4) !== result.import.last_date.slice(0, 4))} – {fmtDate(result.import.last_date, true)}</>}</>
            )}
            .{result.import.skipped_count > 0 && ` ${plural(result.import.skipped_count, "duplicate")} ${result.import.skipped_count === 1 ? "was" : "were"} skipped.`}
          </p>
          {result.matched_recurring.length > 0 && (
            <p className="m-0 text-ink-2">
              Matched expected recurring: {result.matched_recurring.map((m) => `${m.name} (${fmtDate(m.date)})`).join(", ")}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" className={btnPrimary} onClick={() => goMonth("/")}>Go to Dashboard</button>
            {result.uncategorized_count > 0 && (
              <button type="button" className={btnSecondary} onClick={() => goMonth("/transactions", { category: String(uncat.id) })}>
                Categorize {result.uncategorized_count.toLocaleString("en-US")} remaining
              </button>
            )}
            <button
              type="button"
              className={btnSecondary}
              onClick={() => (more ? loadJob(queue[idx + 1], queue, idx + 1) : (setErrors([]), reset()))}
            >
              {more ? "Import next file" : "Import another file"}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

function Stepper({ step, recognized, go }: { step: Step; recognized: boolean; go: (n: number) => void }) {
  const names = ["Upload", "Set up file", "Review", "Done"];
  return (
    <ol aria-label="Import steps" className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0">
      {names.map((nm, i) => {
        const n = i + 1;
        const done = n < step || (n === 2 && recognized && step > 2);
        const cur = n === step;
        const clickable = n < step && step < 4;
        const circle = (
          <span aria-hidden className={`flex size-6 items-center justify-center rounded-full border text-[12.5px] ${cur ? "border-accent bg-accent text-accent-ink" : done ? "border-accent-soft bg-accent-soft text-accent" : "border-line-strong text-ink-3"}`}>
            {done && !cur ? "✓" : n}
          </span>
        );
        const label = <span className={cur ? "font-medium text-ink" : "text-ink-2"}>{nm}</span>;
        return (
          <li key={n} aria-current={cur ? "step" : undefined} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="h-px w-6 bg-line-strong" />}
            {clickable ? (
              <button type="button" className="flex items-center gap-2 border-0 bg-transparent p-0" onClick={() => go(n)}>{circle}{label}</button>
            ) : (
              <span className="flex items-center gap-2">{circle}{label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RadioCard({ name, checked, onChange, title, sub }: { name: string; checked: boolean; onChange: () => void; title: string; sub?: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${checked ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:bg-surface-2"}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-[3px] accent-[var(--accent)] focus-visible:outline-none" />
      <span>
        <span className="block font-medium">{title}</span>
        {sub && <span className="block text-[12.5px] text-ink-3">{sub}</span>}
      </span>
    </label>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">{children}</div>
  );
}

function Disclosure({ summary, hint, children }: { summary: string; hint: string; children: React.ReactNode }) {
  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer px-[18px] py-3 text-[14px]">
        <span className="font-medium">{summary}</span> <span className="text-[12.5px] text-ink-3">· {hint}</span>
      </summary>
      <div className="max-h-[320px] overflow-auto border-t border-line">{children}</div>
    </details>
  );
}

function MiniRows({ rows, mono }: { rows: string[][]; mono?: boolean }) {
  return (
    <table className={`w-full border-collapse text-[13px] text-ink-3 ${mono ? "font-mono" : ""}`}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line first:border-t-0">
            {r.map((c, k) => <td key={k} className="max-w-[420px] truncate px-[18px] py-[5px]">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
