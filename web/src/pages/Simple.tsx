import { Link } from "react-router-dom";
import { useApp } from "../app";
import { btnPrimary, Card, PageHead } from "../ui";
import { monthLabel } from "../lib";

// shortcut: slices 2-3 build these screens; placeholders only, replace when those slices land.
function Placeholder({ title }: { title: string }) {
  const { month } = useApp();
  return (
    <>
      <PageHead title={title} sub={monthLabel(month)} />
      <Card className="p-6 text-ink-2">This screen is coming in a later slice.</Card>
    </>
  );
}

export function Dashboard() {
  const { months, to } = useApp();
  if (!months.has_transactions) {
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
  return <Placeholder title="Dashboard" />;
}
export const Budgets = () => <Placeholder title="Budgets" />;
export const Recurring = () => <Placeholder title="Recurring" />;
