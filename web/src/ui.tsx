import { useEffect, useRef, useState, type ReactNode } from "react";

export const btnBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-[15px] py-[9px] text-[13.5px] font-medium disabled:opacity-45 disabled:cursor-not-allowed";
export const btnPrimary = `${btnBase} bg-accent text-accent-ink hover:brightness-[1.08] disabled:hover:brightness-100`;
export const btnSecondary = `${btnBase} bg-surface text-ink border border-line-strong hover:bg-surface-2`;
export const btnDanger = `${btnBase} bg-neg text-white hover:brightness-[1.08]`;
export const btnDangerText = "text-neg text-[13.5px] font-medium hover:underline bg-transparent border-0 px-2 py-[9px]";
export const btnLink = "text-accent text-[13.5px] hover:underline bg-transparent border-0 p-0";
export const inputCls =
  "rounded-[7px] border border-line-strong bg-surface text-ink px-[10px] py-[7px] text-[13.5px] placeholder:text-ink-3";

export function Chevron({ up }: { up?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block size-[6px] shrink-0 border-r-[1.5px] border-b-[1.5px] border-current opacity-60"
      style={{ transform: up ? "rotate(-135deg) translate(-1px,-1px)" : "rotate(45deg) translate(-1px,-1px)" }}
    />
  );
}

export function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ background: color, width: size, height: size }} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface ${className}`}>{children}</div>;
}

export function PageHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.015em]">{title}</h1>
        {sub && <p className="m-0 mt-1 text-sm text-ink-2">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, label,
}: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[9px] border border-line bg-surface-2 p-[3px]">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          onClick={() => onChange(v)}
          className={`rounded-[7px] border-0 px-3 py-[5px] text-[13.5px] ${v === value ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.12)]" : "bg-transparent text-ink-2"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-[34px] shrink-0 rounded-full border-0 p-0 transition-colors ${on ? "bg-accent" : "bg-track-strong"}`}
    >
      <span
        className="absolute top-[2px] size-4 rounded-full bg-white transition-[left] duration-150"
        style={{ left: on ? 16 : 2 }}
      />
    </button>
  );
}

export interface Opt {
  value: string | number | null;
  label: string;
  color?: string;
}

interface MenuPos { left: number; minWidth: number; top?: number; bottom?: number; maxH: number }

/** The one floating picker used for every select. Fixed-positioned under the trigger, flips up near the viewport bottom. */
export function Select({
  value, options, onChange, label, trigger, className = "", disabled,
}: {
  value: string | number | null;
  options: Opt[];
  onChange: (v: string | number | null) => void;
  label: string;
  trigger?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const scroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    const items = menu.current?.querySelectorAll<HTMLElement>("button");
    (menu.current?.querySelector<HTMLElement>("[aria-checked=true]") ?? items?.[0])?.focus();
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [pos]);

  function toggle() {
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const need = Math.min(options.length * 33 + 10, 320);
    const up = below < need && above > below;
    const minWidth = Math.max(r.width, 180);
    setPos({
      left: Math.max(8, Math.min(r.left, innerWidth - minWidth - 8)),
      minWidth,
      ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxH: Math.min(320, up ? above : below),
    });
  }

  function key(e: React.KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
    else if (e.key === "Escape" || e.key === "Tab") {
      setPos(null);
      if (e.key === "Escape") {
        btn.current?.focus();
        e.preventDefault(); // else the surrounding <dialog> closes too
        e.stopPropagation();
      }
      return;
    } else return;
    e.preventDefault();
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={`${label}: ${cur?.label ?? ""}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        disabled={disabled}
        onClick={toggle}
        className={`inline-flex items-center gap-2 text-left ${className}`}
      >
        {trigger ?? (
          <>
            {cur?.color && <Dot color={cur.color} />}
            <span className="min-w-0 flex-1 truncate">{cur?.label ?? "Select…"}</span>
            <Chevron up={!!pos} />
          </>
        )}
      </button>
      {pos && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={key}
          className="fixed z-50 overflow-y-auto rounded-[10px] border border-line bg-surface p-[5px] shadow-card"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.minWidth, maxHeight: pos.maxH }}
        >
          {options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              onClick={() => {
                setPos(null);
                btn.current?.focus();
                if (o.value !== value) onChange(o.value);
              }}
              className="flex w-full items-center gap-2 rounded-[7px] border-0 bg-transparent px-[10px] py-[7px] text-left text-[13.5px] text-ink hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              {o.color && <Dot color={o.color} />}
              <span className="flex-1 whitespace-nowrap">{o.label}</span>
              {o.value === value && <span aria-hidden className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export interface ConfirmOpts {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/** The single confirmation dialog (spec G8). Native <dialog>: focus trap, Esc, inert background come for free. */
export function ConfirmDialog({ opts, onResolve }: { opts: ConfirmOpts | null; onResolve: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (opts && !d.open) {
      d.showModal();
      cancel.current?.focus();
    } else if (!opts && d.open) d.close();
  }, [opts]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onResolve(false);
      }}
      onClick={(e) => e.target === ref.current && onResolve(false)}
      className="m-auto w-[min(440px,calc(100%-32px))] rounded-xl border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/30"
    >
      {opts && (
        <div className="p-5">
          <h2 id="confirm-title" className="m-0 text-[17px] font-semibold">{opts.title}</h2>
          <p className="mt-2 mb-5 text-sm text-ink-2">{opts.body}</p>
          <div className="flex justify-end gap-2">
            <button ref={cancel} type="button" className={btnSecondary} onClick={() => onResolve(false)}>Cancel</button>
            <button type="button" className={opts.danger === false ? btnPrimary : btnDanger} onClick={() => onResolve(true)}>
              {opts.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** popover="manual" puts the toast in the top layer so it shows above an open modal <dialog>. */
export function Toast({ msg }: { msg: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const open = el.matches(":popover-open");
    if (msg && !open) el.showPopover();
    else if (!msg && open) el.hidePopover();
  }, [msg]);
  return (
    <div
      ref={ref}
      popover="manual"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-auto bottom-6 left-1/2 m-0 max-w-[calc(100%-32px)] -translate-x-1/2 overflow-visible rounded-[9px] border-0 bg-ink px-4 py-[10px] text-[13.5px] text-bg shadow-card"
    >
      {msg}
    </div>
  );
}

export function LoadErr({ msg, retry }: { msg: string; retry: () => void }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-5">
      <span className="text-neg">Couldn't load this — {msg}{msg.endsWith(".") ? "" : "."}</span>
      <button type="button" className={btnSecondary} onClick={retry}>Try again</button>
    </Card>
  );
}

export function Loading({ what = "Loading…" }: { what?: string }) {
  return <p role="status" className="py-10 text-center text-ink-3">{what}</p>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="text-[17px] font-semibold">{title}</div>
      <p className="m-0 max-w-sm text-ink-2">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
