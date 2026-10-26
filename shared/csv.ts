// CSV tokenizer, format detection and row parsing (spec §5). Pure; used by the server and the web preview.
import type { ColumnRole, CsvFormat, SignMode, UnreadableRow } from "./types.js";

// File line (1-based) where each record starts, keyed by the array parseCsvText returned.
const lineMap = new WeakMap<string[][], number[]>();

export function parseCsvText(content: string): string[][] {
  const s = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const records: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false, inQ = false;
  let line = 1, rowLine = 1;
  const endField = () => { row.push(quoted ? field : field.trim()); field = ""; quoted = false; };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== "")) { records.push(row); lines.push(rowLine); }
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const isNl = c === "\n" || (c === "\r" && s[i + 1] !== "\n");
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else { field += c; if (isNl) line++; }
    } else if (c === '"' && field.trim() === "" && !quoted) { inQ = true; quoted = true; field = ""; }
    else if (quoted && (c === " " || c === "\t")) continue; // padding after a closing quote
    else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") continue; // CRLF: handle on the \n
      endRow(); line++; rowLine = line;
    } else field += c;
  }
  if (field !== "" || row.length > 0 || quoted) endRow();
  lineMap.set(records, lines);
  return records;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number, mt: RegExpMatchArray | null;
  if ((mt = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/))) {
    m = +mt[1]; d = +mt[2]; y = mt[3].length === 2 ? 2000 + +mt[3] : +mt[3];
  } else return null;
  if (y < 1900 || y > 2099) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** String -> integer cents, no float math. null = unparseable. */
export function parseAmount(raw: string): number | null {
  let t = raw.trim();
  let neg = false;
  const paren = /^\(.*\)$/.test(t);
  if (paren) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[\s$,]/g, "");
  if (t[0] === "-" || t[0] === "+") {
    if (paren) return null;
    neg = t[0] === "-"; t = t.slice(1);
  }
  const m = t.match(/^(\d{0,12})(?:\.(\d{1,2}))?$/);
  if (!m || (m[1] === "" && m[2] === undefined)) return null;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return neg ? -cents : cents;
}

const signature = (cells: string[]) => {
  const c = cells.map(collapse).map((x) => x.toLowerCase());
  while (c.length && c[c.length - 1] === "") c.pop();
  return c.join("|");
};

// Trailing empty cells (trailing commas) don't count toward a row's width.
const trimmedLen = (r: string[]) => { let n = r.length; while (n > 0 && r[n - 1] === "") n--; return n; };

/** Index of the header row (5.3), or -1. */
function findHeader(records: string[][]): number {
  for (let i = 0; i < Math.min(15, records.length - 1); i++) {
    const r = records[i], next = records[i + 1];
    if (r.some((c) => parseDate(c) !== null || parseAmount(c) !== null)) continue;
    if (trimmedLen(r) <= next.length && trimmedLen(next) <= r.length && next.some((c) => parseDate(c) !== null)) return i;
  }
  return -1;
}

function pickCol(names: string[], terms: string[], used: Set<number>): number {
  for (const t of terms) {
    const i = names.findIndex((n, k) => !used.has(k) && n.includes(t));
    if (i >= 0) return i;
  }
  return -1;
}

export function detectFormat(records: string[][]): CsvFormat {
  const h = findHeader(records);
  const hasHeader = h >= 0;
  const data = records.slice(h + 1);
  const sample = data.slice(0, 500);
  const ncols = Math.max(0, ...(hasHeader ? [records[h], ...sample] : records.slice(0, 5)).map((r) => r.length));
  const roles: ColumnRole[] = Array(ncols).fill("ignore");
  const used = new Set<number>();
  const set = (i: number, r: ColumnRole) => { if (i >= 0) { roles[i] = r; used.add(i); } };
  const vals = (i: number) => sample.map((r) => r[i] ?? "").filter((v) => v !== "");
  const majority = (i: number, f: (v: string) => unknown) => {
    const v = vals(i); return v.length > 0 && v.filter((x) => f(x) !== null).length * 2 > v.length;
  };

  if (hasHeader) {
    const names = records[h].map((c) => collapse(c).toLowerCase());
    set(pickCol(names, ["transaction date", "trans date", "date"], used), "date");
    set(pickCol(names, ["description", "payee", "merchant", "name", "memo", "details"], used), "description");
    const amt = pickCol(names, ["amount"], used);
    if (amt >= 0) set(amt, "amount");
    else {
      const d = pickCol(names, ["debit", "withdrawal"], used);
      const c = pickCol(names, ["credit", "deposit"], new Set([...used, d]));
      if (d >= 0 && c >= 0) { set(d, "debit"); set(c, "credit"); }
    }
  }
  const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
  if (!roles.includes("date")) set(idx(ncols).find((i) => !used.has(i) && majority(i, parseDate)) ?? -1, "date");
  if (!roles.includes("amount") && !roles.includes("debit"))
    set(idx(ncols).find((i) => !used.has(i) && majority(i, parseAmount)) ?? -1, "amount");
  if (!roles.includes("description")) {
    const avg = (i: number) => { const v = vals(i); return v.length ? v.reduce((a, x) => a + x.length, 0) / v.length : 0; };
    const best = idx(ncols).filter((i) => !used.has(i)).sort((a, b) => avg(b) - avg(a))[0];
    set(best ?? -1, "description");
  }

  let sign: SignMode;
  if (roles.includes("debit") && roles.includes("credit")) sign = "debit_credit";
  else {
    const a = roles.indexOf("amount");
    const nums = a < 0 ? [] : vals(a).map(parseAmount).filter((x): x is number => x !== null);
    sign = nums.filter((x) => x < 0).length * 2 > nums.length ? "purchases_negative" : "purchases_positive";
  }
  const di = roles.indexOf("date");
  const firstDate = di < 0 ? "" : (vals(di)[0] ?? "");
  return {
    header_signature: hasHeader ? signature(records[h]) : `#columns=${ncols}`,
    column_roles: roles,
    sign_mode: sign,
    date_format: /^\d{4}/.test(firstDate) ? "YMD" : "MDY",
    has_header: hasHeader,
  };
}

export interface ParsedRow { line: number; date: string; description: string; amount_cents: number }

export function parseRows(
  records: string[][], format: CsvFormat,
): { rows: ParsedRow[]; unreadable: UnreadableRow[] } {
  const lines = lineMap.get(records);
  let start = 0;
  if (format.has_header) {
    let h = -1;
    for (let i = 0; i < Math.min(15, records.length); i++) {
      if (signature(records[i]) === format.header_signature) { h = i; break; }
    }
    start = (h >= 0 ? h : findHeader(records)) + 1;
  }
  const r = format.column_roles;
  const di = r.indexOf("date"), ci = r.indexOf("description"), ai = r.indexOf("amount");
  const dbi = r.indexOf("debit"), cri = r.indexOf("credit");
  const rows: ParsedRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (let k = start; k < records.length; k++) {
    const rec = records[k];
    const cell = (i: number) => (i >= 0 ? rec[i] ?? "" : "");
    const line = lines?.[k] ?? k + 1;
    const date = di >= 0 ? parseDate(cell(di)) : null;
    const description = ci >= 0 ? collapse(cell(ci)) : "";
    let amount: number | null = null;
    if (format.sign_mode === "debit_credit") {
      if (dbi >= 0 && cri >= 0 && (cell(dbi) !== "" || cell(cri) !== "")) {
        const d = cell(dbi) === "" ? 0 : parseAmount(cell(dbi));
        const c = cell(cri) === "" ? 0 : parseAmount(cell(cri));
        if (d !== null && c !== null) amount = Math.abs(c) - Math.abs(d);
      }
    } else if (ai >= 0) {
      const a = parseAmount(cell(ai));
      if (a !== null) amount = format.sign_mode === "purchases_positive" ? -a : a;
    }
    if (date === null || amount === null || description === "") unreadable.push({ line, raw: rec.join(",") });
    else rows.push({ line, date, description, amount_cents: amount === 0 ? 0 : amount });
  }
  return { rows, unreadable };
}
