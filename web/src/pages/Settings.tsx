import { useEffect, useState } from "react";
import type { Account, AccountType, ApplyRulesResponse, CategoryWithCounts, Rule } from "../../../shared/types";
import { api, ApiFail, useGet } from "../api";
import { useApp } from "../app";
import { colorBarsPref, fmtDate, plural, setColorBarsPref, SWATCHES } from "../lib";
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
  const [colorBars, setColorBars] = useState(colorBarsPref);
  const rules = useGet<Rule[]>("/rules");

  return (
    <>
      <PageHead title="Settings" />
      <Section title="Appearance">
        <div className="flex items-center justify-between gap-3 px-[18px] py-4">
          <span>Theme</span>
          <Segmented label="Theme" value={theme} onChange={setTheme} options={[["light", "Light"], ["dark", "Dark"]]} />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line px-[18px] py-4">
          <span>
            Color spending bars by category
            <span className="block text-[12.5px] text-ink-3">Dashboard and Trends bars show each category's share of the month.</span>
          </span>
          <Toggle label="Color spending bars by category" on={colorBars} onChange={(v) => { setColorBars(v); setColorBarsPref(v); }} />
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

      <Section title="Backup" sub="A snapshot is also saved automatically before each import and undo (newest 10 kept in data/backups/).">
        <div className="flex items-center justify-between gap-3 px-[18px] py-4">
          <span>Download a copy of your whole database.</span>
          {/* plain link: the response is a file, not JSON */}
          <a href="/api/backup" download className={`${btnSecondary} no-underline`}>Download backup</a>
        </div>
      </Section>

      <Section title="Categories" action={<ReapplyRules disabled={!rules.data?.length} />} sub="Open a category to see its rules. Rules assign a category to imported transactions whose description contains the text.">
        {rules.error && !rules.data && <div className="p-4"><LoadErr msg={rules.error} retry={rules.reload} /></div>}
        <CategoryList rules={rules.data ?? []} loading={!rules.data && !rules.error} reloadRules={rules.reload} />
        <AddCategory />
      </Section>
    </>
  );
}

function CategoryList({ rules, loading, reloadRules }: { rules: Rule[]; loading: boolean; reloadRules: () => void }) {
  const { categories, reload, fail } = useApp();
  const [pending, setPending] = useState<number[] | null>(null); // optimistic order while the PUT is in flight
  const [drag, setDrag] = useState<{ id: number; over: number; after: boolean } | null>(null);
  const built = categories.filter((c) => c.system_key !== null);
  const users = categories.filter((c) => c.system_key === null);
  const serverIds = users.map((c) => c.id);
  // Drop the optimistic order once the server list matches it, or holds a different set of ids (category added/removed elsewhere); a stale same-set refresh must not undo a later move.
  useEffect(() => setPending((p) => (p && (p.join() === serverIds.join() || [...p].sort().join() !== [...serverIds].sort().join()) ? null : p)), [categories]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = pending ?? serverIds;
  // While dragging, show the order a drop would produce right now.
  const preview = (() => {
    if (!drag || drag.over === drag.id) return ids;
    const next = ids.filter((x) => x !== drag.id);
    next.splice(next.indexOf(drag.over) + (drag.after ? 1 : 0), 0, drag.id);
    return next;
  })();
  const ordered = preview.map((id) => users.find((c) => c.id === id)).filter((c): c is CategoryWithCounts => !!c);

  async function commit(next: number[]) {
    if (next.join() === ids.join()) return;
    setPending(next);
    try {
      await api("/categories/order", "PUT", { ids: next });
      reload();
    } catch (e) {
      setPending(null);
      reload(); // self-heal a stale list (e.g. a category added elsewhere)
      fail(e);
    }
  }
  const move = (id: number, d: -1 | 1) => {
    const i = ids.indexOf(id), next = [...ids];
    next.splice(i, 1);
    next.splice(i + d, 0, id);
    commit(next);
  };
  function drop() {
    if (!drag) return;
    setDrag(null);
    commit(preview);
  }
  const rulesOf = (id: number) => rules.filter((r) => r.category_id === id).sort((a, b) => a.merchant.localeCompare(b.merchant));

  return (
    <ul className="m-0 list-none p-0">
      {ordered.map((c, i) => (
        <CategoryRow
          key={c.id}
          c={c}
          rules={rulesOf(c.id)}
          loading={loading}
          reloadRules={reloadRules}
          order={{
            idx: i,
            count: ordered.length,
            canUp: i > 0,
            canDown: i < ordered.length - 1,
            move: (d) => move(c.id, d),
            drag,
            start: () => setDrag({ id: c.id, over: c.id, after: false }),
            over: (after) => drag && (drag.over !== c.id || drag.after !== after) && setDrag({ ...drag, over: c.id, after }),
            end: () => setDrag(null),
            drop,
          }}
        />
      ))}
      {built.map((c) => <CategoryRow key={c.id} c={c} rules={rulesOf(c.id)} loading={loading} reloadRules={reloadRules} />)}
    </ul>
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

// The target arrow may still be disabled until the re-render lands, so focus next frame.
const focusLater = (el: Element | null) => requestAnimationFrame(() => (el as HTMLElement | null)?.focus());

interface Order {
  idx: number; count: number;
  canUp: boolean; canDown: boolean; move: (d: -1 | 1) => void;
  drag: { id: number; over: number; after: boolean } | null;
  start: () => void; over: (after: boolean) => void; end: () => void; drop: () => void;
}

function CategoryRow({ c, rules, loading, reloadRules, order }: { c: CategoryWithCounts; rules: Rule[]; loading: boolean; reloadRules: () => void; order?: Order }) {
  const { reload, toast, fail, confirm } = useApp();
  const [name, setName] = useState(c.name);
  const [open, setOpen] = useState(false);
  const panelId = `rules-${c.id}`;
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
      reloadRules();
      toast(`Deleted ${c.name}`);
    } catch (e) {
      fail(e);
    }
  }
  return (
    <li
      className={`relative border-t border-line first:border-t-0 ${order?.drag?.id === c.id ? "opacity-40" : ""}`}
      onDragOver={order && ((e) => {
        if (!order.drag) return;
        e.preventDefault();
        if (order.drag.id === c.id) return; // the placeholder row: rows shift under the cursor, don't re-target
        const r = e.currentTarget.firstElementChild!.getBoundingClientRect(); // header only, not the rules panel
        order.over(e.clientY > r.top + r.height / 2);
      })}
      onDrop={order && ((e) => { e.preventDefault(); order.drop(); })}
    >
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-[18px] py-2"
    >
      {order ? (
        <span
          draggable
          aria-hidden
          title="Drag to reorder"
          className="cursor-grab select-none text-ink-3 active:cursor-grabbing"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setDragImage(e.currentTarget.closest("li")!, 0, 0);
            order.start();
          }}
          onDragEnd={order.end}
        >⋮⋮</span>
      ) : <span aria-hidden className="w-[14px]" />}
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
      <span className="min-w-[140px] flex-1 text-[12.5px] text-ink-3 sm:w-[200px] sm:flex-none">
        {c.system_key ? "Built-in · " : ""}{plural(c.transaction_count, "transaction")}
      </span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`${btnLink} flex items-center gap-1 sm:min-w-[110px] ${rules.length ? "" : "!text-ink-3"}`}
        onClick={() => setOpen(!open)}
      >
        {loading ? "Loading rules…" : rules.length ? plural(rules.length, "rule") : "No rules"}<Chevron up={open} />
      </button>
      {order ? (
        <span className="flex gap-1">
          <button type="button" aria-label={`Move ${c.name} up`} disabled={!order.canUp} className={`${btnSecondary} !px-2 !py-[3px]`} onClick={(e) => { order.move(-1); if (order.idx === 1) focusLater(e.currentTarget.nextElementSibling); }}>↑</button>
          <button type="button" aria-label={`Move ${c.name} down`} disabled={!order.canDown} className={`${btnSecondary} !px-2 !py-[3px]`} onClick={(e) => { order.move(1); if (order.idx === order.count - 2) focusLater(e.currentTarget.previousElementSibling); }}>↓</button>
        </span>
      ) : <span aria-hidden className="w-[62px]" />}
      {!locked && (
        <label className="flex items-center gap-2 text-[13.5px] text-ink-2">
          Exclude from totals
          <Toggle label={`Exclude ${c.name} from totals`} on={c.excluded_from_totals} onChange={(v) => patch({ excluded_from_totals: v })} />
        </label>
      )}
      {!locked && (
        <label className="flex items-center gap-2 text-[13.5px] text-ink-2" title="Bills like rent; kept out of % used">
          Fixed
          <Toggle label={`Mark ${c.name} as fixed`} on={c.fixed} onChange={(v) => patch({ fixed: v })} />
        </label>
      )}
      {c.system_key === null && (
        <button type="button" className={`${btnLink} !text-neg`} onClick={del}>Delete</button>
      )}
    </div>
    {open && (
      <ul id={panelId} className="m-0 list-none bg-surface-2 p-0 pl-6">
        {rules.length === 0 ? <li className="px-[18px] py-3 text-[13px] text-ink-3">No rules. Recategorize a transaction and choose “Create rule”.</li> : rules.map((r) => <RuleRow key={r.id} r={r} done={() => { reloadRules(); reload(); }} />)}
      </ul>
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
          <span className="flex gap-3 whitespace-nowrap">
            <button type="button" className={btnLink} onClick={() => setEdit(true)}>Edit</button>
            <button type="button" className={`${btnLink} !text-neg`} onClick={del}>Delete</button>
          </span>
        </>
      )}
    </li>
  );
}
