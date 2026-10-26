import { useState } from "react";
import type { Account, AccountType, ApplyRulesResponse, CategoryWithCounts, Rule } from "../../../shared/types";
import { api, ApiFail, useGet } from "../api";
import { useApp } from "../app";
import { fmtDate, plural, SWATCHES } from "../lib";
import { btnLink, btnPrimary, btnSecondary, Card, Chevron, Dot, inputCls, LoadErr, Loading, PageHead, Segmented, Select, Toggle } from "../ui";

const TYPES: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" }, { value: "credit_card", label: "Credit card" }, { value: "savings", label: "Savings" },
];

function Section({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="m-0 mb-1 text-[17px] font-semibold">{title}</h2>
        {action}
      </div>
      {sub && <p className="m-0 mb-3 text-[13.5px] text-ink-2">{sub}</p>}
      {!sub && <div className="h-2" />}
      <Card className="overflow-x-auto">{children}</Card>
    </section>
  );
}

export default function Settings() {
  const { theme, setTheme, categories, accounts } = useApp();
  const rules = useGet<Rule[]>("/rules");

  return (
    <>
      <PageHead title="Settings" />
      <Section title="Appearance">
        <div className="flex items-center justify-between gap-3 px-[18px] py-4">
          <span>Theme</span>
          <Segmented label="Theme" value={theme} onChange={setTheme} options={[["light", "Light"], ["dark", "Dark"]]} />
        </div>
      </Section>

      <Section title="Accounts" sub="Accounts are created when you import a statement.">
        {accounts.length === 0 ? (
          <p className="m-0 px-[18px] py-6 text-ink-3">No accounts yet.</p>
        ) : (
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="bg-surface-2 text-left text-[12.5px] text-ink-3">
                {["Name", "Type", "Saved CSV format", "Last import", ""].map((h, i) => (
                  <th key={i} className="px-[18px] py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{accounts.map((a) => <AccountRow key={a.id} a={a} />)}</tbody>
          </table>
        )}
      </Section>

      <Section title="Categories">
        <ul className="m-0 list-none p-0">
          {categories.map((c) => <CategoryRow key={c.id} c={c} onDeleted={rules.reload} />)}
        </ul>
        <AddCategory />
      </Section>

      <Section title="Rules" action={<ReapplyRules disabled={!rules.data?.length} />} sub="Rules assign a category to imported transactions whose description contains the text.">
        {rules.error && !rules.data ? (
          <div className="p-4"><LoadErr msg={rules.error} retry={rules.reload} /></div>
        ) : !rules.data ? (
          <Loading />
        ) : rules.data.length === 0 ? (
          <p className="m-0 px-[18px] py-6 text-ink-3">No rules yet. Recategorize a transaction and choose “Create rule”.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {rules.data.map((r) => <RuleRow key={r.id} r={r} done={rules.reload} />)}
          </ul>
        )}
      </Section>
    </>
  );
}

function ReapplyRules({ disabled }: { disabled: boolean }) {
  const { reload, toast, fail } = useApp();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const { applied_count: n } = await api<ApplyRulesResponse>("/rules/apply", "POST", {});
      toast(n === 0 ? "No uncategorized transactions matched a rule" : `Rules applied · ${plural(n, "transaction")} categorized`);
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3">
      <span className="text-[12.5px] text-ink-3">Fills in Uncategorized transactions only.</span>
      <button type="button" className={`${btnSecondary} whitespace-nowrap`} disabled={disabled || busy} onClick={run}>{busy ? "Applying…" : "Reapply rules"}</button>
    </div>
  );
}

function AccountRow({ a }: { a: Account }) {
  const { reload, toast, fail } = useApp();
  const [name, setName] = useState(a.name);
  const patch = async (body: object) => {
    try {
      await api(`/accounts/${a.id}`, "PATCH", body);
      reload();
      return true;
    } catch (e) {
      if (e instanceof ApiFail && (e.code === "conflict" || e.code === "validation")) toast(e.message);
      else fail(e);
      return false;
    }
  };
  const saveName = async () => {
    const n = name.trim();
    if (n === a.name) return setName(a.name);
    if (!n || !(await patch({ name: n }))) setName(a.name);
  };
  return (
    <tr className="border-t border-line">
      <td className="px-[18px] py-2">
        <input
          aria-label={`Name of ${a.name}`}
          className={`${inputCls} w-full min-w-[140px]`}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </td>
      <td className="px-[18px] py-2">
        <Select
          label={`Type of ${a.name}`}
          value={a.type}
          options={TYPES}
          onChange={(v) => patch({ type: v })}
          className={`${inputCls} min-w-[130px] justify-between`}
        />
      </td>
      <td className="px-[18px] py-2">
        {a.csv_format ? `${a.name.split(/\s+/)[0]} · ${plural(a.csv_format.column_roles.length, "column")}` : <span className="text-ink-3">Not saved — asks on next import</span>}
      </td>
      <td className="px-[18px] py-2 text-ink-2">{a.last_import_date ? fmtDate(a.last_import_date, true) : "—"}</td>
      <td className="px-[18px] py-2 text-right">
        {a.csv_format && (
          <button
            type="button"
            className={btnLink}
            onClick={async () => {
              if (await patch({ csv_format: null })) toast(`Forgot the saved format for ${a.name}`);
            }}
          >
            Forget format
          </button>
        )}
      </td>
    </tr>
  );
}

function CategoryRow({ c, onDeleted }: { c: CategoryWithCounts; onDeleted: () => void }) {
  const { reload, toast, fail, confirm } = useApp();
  const [name, setName] = useState(c.name);
  const locked = c.system_key === "income" || c.system_key === "uncategorized";
  const patch = async (body: object) => {
    try {
      await api(`/categories/${c.id}`, "PATCH", body);
      reload();
      return true;
    } catch (e) {
      if (e instanceof ApiFail && e.code === "conflict") toast(`A category named ${(body as { name?: string }).name} already exists`);
      else fail(e);
      return false;
    }
  };
  const saveName = async () => {
    const n = name.trim();
    if (n === c.name) return setName(c.name);
    if (!n || !(await patch({ name: n }))) setName(c.name);
  };
  async function del() {
    const ok = await confirm({
      title: `Delete ${c.name}?`,
      body: `Its ${plural(c.transaction_count, "transaction")} and ${plural(c.recurring_count, "recurring item")} become Uncategorized, and its ${plural(c.rule_count, "rule")} and its budgets are removed.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/categories/${c.id}`, "DELETE");
      reload();
      onDeleted();
      toast(`Deleted ${c.name}`);
    } catch (e) {
      fail(e);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-[18px] py-2 first:border-t-0">
      <Select
        label={`Color of ${c.name}`}
        value={c.color}
        options={SWATCHES.map(([n, v]) => ({ value: v, label: n, color: v }))}
        onChange={(v) => patch({ color: v })}
        className="rounded-[7px] border border-line-strong bg-surface p-[5px]"
        trigger={<><Dot color={c.color} size={16} /><Chevron /></>}
      />
      <input
        aria-label={`Name of category ${c.name}`}
        className={`${inputCls} w-[200px] max-w-full ${locked ? "bg-surface-2 text-ink-2" : ""}`}
        value={name}
        readOnly={locked}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span className="min-w-[140px] flex-1 text-[12.5px] text-ink-3">
        {c.system_key ? "Built-in · " : ""}{plural(c.transaction_count, "transaction")}
      </span>
      {!locked && (
        <label className="flex items-center gap-2 text-[13.5px] text-ink-2">
          Exclude from totals
          <Toggle label={`Exclude ${c.name} from totals`} on={c.excluded_from_totals} onChange={(v) => patch({ excluded_from_totals: v })} />
        </label>
      )}
      {c.system_key === null && (
        <button type="button" className={`${btnLink} !text-neg`} onClick={del}>Delete</button>
      )}
    </li>
  );
}

function AddCategory() {
  const { reload, toast, fail } = useApp();
  const [name, setName] = useState("");
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      await api("/categories", "POST", { name: n });
      setName("");
      reload();
      toast(`Added ${n}`);
    } catch (err) {
      if (err instanceof ApiFail && err.code === "conflict") toast(`A category named ${n} already exists`);
      else fail(err);
    }
  }
  return (
    <form onSubmit={add} className="flex gap-2 border-t border-line p-[14px_18px]">
      <input aria-label="New category name" placeholder="New category" maxLength={40} className={`${inputCls} w-[240px] max-w-full`} value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className={btnSecondary} disabled={!name.trim()}>Add category</button>
    </form>
  );
}

function RuleRow({ r, done }: { r: Rule; done: () => void }) {
  const { categories, toast, fail } = useApp();
  const [edit, setEdit] = useState(false);
  const [merchant, setMerchant] = useState(r.merchant);
  const [cat, setCat] = useState(r.category_id);
  const c = categories.find((x) => x.id === r.category_id);
  const opts = categories.map((x) => ({ value: x.id, label: x.name, color: x.color }));

  async function save() {
    try {
      await api(`/rules/${r.id}`, "PATCH", { merchant: merchant.trim().toUpperCase(), category_id: cat });
      setEdit(false);
      done();
      toast("Rule saved");
    } catch (e) {
      if (e instanceof ApiFail && (e.code === "conflict" || e.code === "validation")) toast(e.message);
      else fail(e);
    }
  }
  async function del() {
    // Deleting is immediate per ST-7 (no existing data changes), so no confirmation.
    try {
      await api(`/rules/${r.id}`, "DELETE");
      done();
      toast("Rule deleted");
    } catch (e) {
      fail(e);
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-[18px] py-2 first:border-t-0">
      {edit ? (
        <>
          <input aria-label="Merchant text" className={`${inputCls} w-[220px] max-w-full font-mono`} value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          <span aria-hidden className="text-ink-3">→</span>
          <Select label="Category" value={cat} options={opts} onChange={(v) => setCat(v as number)} className={`${inputCls} min-w-[170px] justify-between`} />
          <span className="flex-1" />
          <button type="button" className={`${btnPrimary} !px-3 !py-[5px]`} onClick={save}>Save</button>
          <button type="button" className={`${btnSecondary} !px-3 !py-[5px]`} onClick={() => { setEdit(false); setMerchant(r.merchant); setCat(r.category_id); }}>Cancel</button>
        </>
      ) : (
        <>
          <code className="rounded-md bg-surface-2 px-2 py-[2px] font-mono text-[13px]">{r.merchant}</code>
          <span aria-hidden className="text-ink-3">→</span>
          <span className="flex items-center gap-2">{c && <Dot color={c.color} />}{c?.name ?? "—"}</span>
          <span className="flex-1" />
          <button type="button" className={btnLink} onClick={() => setEdit(true)}>Edit</button>
          <button type="button" className={`${btnLink} !text-neg`} onClick={del}>Delete</button>
        </>
      )}
    </li>
  );
}
