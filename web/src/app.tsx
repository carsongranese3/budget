import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Link, Outlet, useSearchParams } from "react-router-dom";
import type { Account, CategoryWithCounts, MonthsResponse, UncategorizedCountResponse } from "../../shared/types";
import { useGet } from "./api";
import { addMonth, applyTheme, initialTheme, monthLabel, monthName, type Theme } from "./lib";
import { btnSecondary, Chevron, ConfirmDialog, LoadErr, Loading, Toast, type ConfirmOpts } from "./ui";

interface Ctx {
  month: string;
  months: MonthsResponse;
  categories: CategoryWithCounts[];
  accounts: Account[];
  badge: number;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Refetch months, categories, accounts and the nav badge. */
  reload: () => void;
  refreshBadge: () => void;
  toast: (msg: string) => void;
  fail: (e: unknown) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  /** Link target that keeps the selected month. */
  to: (path: string, extra?: Record<string, string>) => string;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

const navItems: [string, string][] = [
  ["/", "Dashboard"], ["/transactions", "Transactions"], ["/import", "Import"],
  ["/budgets", "Budgets"], ["/recurring", "Recurring"], ["/settings", "Settings"],
];

export function Shell() {
  const [params, setParams] = useSearchParams();
  const monthsQ = useGet<MonthsResponse>("/months");
  const catsQ = useGet<CategoryWithCounts[]>("/categories");
  const acctQ = useGet<Account[]>("/accounts");
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const [confirmOpts, setConfirmOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => {});

  useEffect(() => applyTheme(theme), [theme]);

  const months = monthsQ.data;
  const p = params.get("month");
  const month =
    months && p && /^\d{4}-(0[1-9]|1[0-2])$/.test(p) && p >= months.earliest_month && p <= months.latest_month
      ? p
      : (months?.current_month ?? "");

  const badgeQ = useGet<UncategorizedCountResponse>(month ? `/transactions/uncategorized-count?month=${month}` : null);

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastMsg(null), 3400);
  }, []);
  const fail = useCallback((e: unknown) => toast(`Something went wrong — ${e instanceof Error ? e.message : "try again"}`), [toast]);
  const confirm = useCallback(
    (o: ConfirmOpts) =>
      new Promise<boolean>((res) => {
        resolver.current = res;
        setConfirmOpts(o);
      }),
    [],
  );

  const reloadMonths = monthsQ.reload, reloadCats = catsQ.reload, reloadAccts = acctQ.reload, reloadBadge = badgeQ.reload;
  const reload = useCallback(() => {
    reloadMonths(); reloadCats(); reloadAccts(); reloadBadge();
  }, [reloadMonths, reloadCats, reloadAccts, reloadBadge]);

  const setMonth = (m: string) => {
    const n = new URLSearchParams(params);
    if (m === months!.current_month) n.delete("month");
    else n.set("month", m);
    setParams(n);
  };

  const to = useCallback(
    (path: string, extra: Record<string, string> = {}) => {
      const q = new URLSearchParams(extra);
      if (month && month !== months?.current_month) q.set("month", month);
      const s = q.toString();
      return s ? `${path}?${s}` : path;
    },
    [month, months?.current_month],
  );

  const ctx = useMemo<Ctx | null>(
    () =>
      months && catsQ.data && acctQ.data
        ? {
            month, months, categories: catsQ.data, accounts: acctQ.data, badge: badgeQ.data?.count ?? 0,
            theme, setTheme: setThemeState, reload, refreshBadge: reloadBadge, toast, fail, confirm, to,
          }
        : null,
    [month, months, catsQ.data, acctQ.data, badgeQ.data, theme, reload, reloadBadge, toast, fail, confirm, to],
  );

  const bootErr = monthsQ.error ?? catsQ.error ?? acctQ.error;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-3 gap-y-1 px-[clamp(16px,3vw,36px)] py-[10px]">
          <Link to="/" className="flex items-center gap-2 text-ink no-underline">
            <span aria-hidden className="flex size-[22px] items-end justify-center gap-[2px] rounded-md bg-accent pb-[5px]">
              <i className="block h-[6px] w-[3px] rounded-[1px] bg-accent-ink" />
              <i className="block h-[10px] w-[3px] rounded-[1px] bg-accent-ink" />
              <i className="block h-[8px] w-[3px] rounded-[1px] bg-accent-ink" />
            </span>
            <span className="text-[15.5px] font-semibold">Budget</span>
          </Link>
          <nav
            aria-label="Main"
            className="order-last flex w-full gap-1 overflow-x-auto min-[1100px]:order-none min-[1100px]:ml-3 min-[1100px]:w-auto"
          >
            {navItems.map(([path, label]) => (
              <NavLink
                key={path}
                to={ctx ? ctx.to(path) : path}
                end={path === "/"}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-[6px] rounded-[7px] px-[11px] py-[7px] text-sm no-underline ${isActive ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink"}`
                }
              >
                {label}
                {path === "/transactions" && ctx && ctx.badge > 0 && (
                  <span
                    aria-label={`${ctx.badge} uncategorized`}
                    className="rounded-full bg-warn-soft px-[6px] text-[11px] font-semibold text-warn-ink"
                    style={{ border: "1px solid var(--warn)" }}
                  >
                    {ctx.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="flex-1" />
          {ctx && month !== months!.current_month && (
            <Link to={(() => { const n = new URLSearchParams(params); n.delete("month"); const s = n.toString(); return s ? `?${s}` : "?"; })()} className="text-[13.5px] text-accent hover:underline">
              Back to {monthName(months!.current_month)}
            </Link>
          )}
          {ctx && (
            <div className="flex items-center rounded-[9px] border border-line-strong">
              <button
                type="button"
                aria-label="Previous month"
                disabled={month <= months!.earliest_month}
                onClick={() => setMonth(addMonth(month, -1))}
                className="flex h-[26px] w-7 items-center justify-center border-0 bg-transparent text-ink-2 disabled:opacity-30"
              >
                <span className="rotate-90"><Chevron /></span>
              </button>
              <span aria-live="polite" className="min-w-[120px] text-center text-[13.5px] font-medium">{monthLabel(month)}</span>
              <button
                type="button"
                aria-label="Next month"
                disabled={month >= months!.latest_month}
                onClick={() => setMonth(addMonth(month, 1))}
                className="flex h-[26px] w-7 items-center justify-center border-0 bg-transparent text-ink-2 disabled:opacity-30"
              >
                <span className="-rotate-90"><Chevron /></span>
              </button>
            </div>
          )}
          <button type="button" className={`${btnSecondary} !px-3 !py-[6px]`} onClick={() => setThemeState(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1240px] flex-col gap-5 px-[clamp(16px,3vw,36px)] pt-7 pb-[72px]">
        {ctx ? (
          <AppCtx.Provider value={ctx}>
            <Outlet />
          </AppCtx.Provider>
        ) : bootErr ? (
          <LoadErr msg={bootErr} retry={reload} />
        ) : (
          <Loading />
        )}
      </main>
      <ConfirmDialog
        opts={confirmOpts}
        onResolve={(ok) => {
          setConfirmOpts(null);
          resolver.current(ok);
        }}
      />
      <Toast msg={toastMsg} />
    </div>
  );
}
