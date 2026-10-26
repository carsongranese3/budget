// Generated sample data, dated around the real "today" (A14). Deterministic per day.
import type { CsvFormat } from "../shared/types.js";
import { type DB, eraseAll, recomputeLastImport, uncategorizedId } from "./db.js";
import { makeRuleMatcher } from "./imports.js";

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n: number) => String(n).padStart(2, "0");
const ds = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (s: string, n: number) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const GRO = ["TRADER JOE'S #552", "SAFEWAY #1204", "WHOLEFDS MKT 10432", "SAFEWAY #0877"];
const DIN = ["CHIPOTLE 2291", "BLUE BOTTLE COFFEE", "TST* NOODLE HOUSE", "DOORDASH*PIZZERIA", "STARBUCKS #4417"];
const TRN = ["SHELL OIL 5744123", "BART CLIPPER", "LYFT *RIDE", "CHEVRON 0098"];
const SHO = ["AMAZON MKTP US*MK1A2", "TARGET #2210", "USPS PO 0532"];
const ENT = ["AMC THEATRES 0214", "STEAM PURCHASE"];
const UNK = ["SQ *DOLORES PARK CAFE", "PAYPAL *VINTAGEFINDS", "ZELLE FROM M CHEN"];

const RULES: [string, string][] = [
  ["TRADER JOE'S", "Groceries"], ["SAFEWAY", "Groceries"], ["WHOLEFDS", "Groceries"], ["SHELL OIL", "Transportation"],
  ["PAYROLL", "Income"], ["PG&E", "Utilities"], ["NETFLIX", "Subscriptions"], ["EPAYMENT", "Transfer"],
  ["AUTOPAY PAYMENT", "Transfer"], ["GEICO", "Transportation"], ["OAKWOOD PROPERTY", "Rent"],
  ["CHIPOTLE", "Dining"], ["BLUE BOTTLE", "Dining"], ["BART", "Transportation"], ["AMAZON MKTP", "Shopping"],
];
const BUDGETS: Record<string, number> = {
  Groceries: 45000, Dining: 30000, Rent: 165000, Utilities: 22000, Transportation: 30000,
  Subscriptions: 3500, Shopping: 15000, Entertainment: 8000,
};

/** Chase-style export, ~3 weeks ending yesterday. Never overlaps loadSampleData's rows by design of the caller. */
export function sampleCsv(today: string): { file_name: string; content: string } {
  const r = rng(42);
  const R = (a: number, b: number) => Math.round((a + r() * (b - a)) * 100) / 100;
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const mdy = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
  const items: [string, string, number][] = [];
  const add = (off: number, desc: string, amt: number) => items.push([addDays(today, -off), desc, amt]);
  add(1, "ACME CORP PAYROLL PPD", 2400);
  add(3, "GEICO *AUTO", -142);
  add(4, "TRADER JOE'S #552", -64.18);
  add(5, "POS 1021 CORNER STORE", -12.6);
  add(6, "TST* HOLY GELATO", -9.75);
  add(7, "COMCAST XFINITY", -79.99);
  add(8, "ZELLE FROM M CHEN", 45);
  add(9, "PAYPAL *ETSY INC", -34.18);
  add(10, "PG&E WEB ONLINE", -96.31);
  add(11, "ONLINE TRANSFER TO SAV 4410", -250);
  add(12, "ONLINE TRANSFER TO SAV 4410", -250);
  for (const [pool, n, a, b] of [[GRO, 4, 22, 60], [DIN, 8, 5.5, 22], [TRN, 5, 3, 12], [SHO, 3, 12, 40]] as [string[], number, number, number][])
    for (let i = 0; i < n; i++) add(1 + Math.floor(r() * 20), pick(pool), -R(a, b));
  items.sort((x, y) => (x[0] < y[0] ? 1 : x[0] > y[0] ? -1 : 0));
  let bal = 4812.33;
  const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #"];
  for (const [d, desc, amt] of items) {
    lines.push([amt > 0 ? "CREDIT" : "DEBIT", mdy(d), q(desc), amt.toFixed(2), amt > 0 ? "ACH_CREDIT" : "DEBIT_CARD", bal.toFixed(2), ""].join(","));
    bal -= amt;
  }
  return { file_name: "chase-sample.csv", content: lines.join("\n") + "\n" };
}

export function loadSampleData(db: DB, today: string): void {
  db.transaction(() => {
    eraseAll(db);
    const now = new Date().toISOString();
    const cat = (n: string) => (db.prepare("SELECT id FROM categories WHERE name = ?").get(n) as { id: number }).id;
    const amexFmt: CsvFormat = {
      header_signature: "date|description|amount", column_roles: ["date", "description", "amount"],
      sign_mode: "purchases_positive", date_format: "MDY", has_header: true,
    };
    const acct = db.prepare("INSERT INTO accounts (name, type, csv_format, created_at) VALUES (?,?,?,?)");
    const chase = Number(acct.run("Chase Checking", "checking", null, now).lastInsertRowid);
    const amex = Number(acct.run("Amex Card", "credit_card", JSON.stringify(amexFmt), now).lastInsertRowid);
    const ruleIns = db.prepare("INSERT INTO rules (merchant, category_id, created_at) VALUES (?,?,?)");
    for (const [m, c] of RULES) ruleIns.run(m, cat(c), now);
    const match = makeRuleMatcher(db);
    const unc = uncategorizedId(db);

    const r = rng(11);
    const R = (a: number, b: number) => Math.round((a + r() * (b - a)) * 100) / 100;
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
    type Tx = { date: string; desc: string; acct: number; cents: number };
    const txs: Tx[] = [];
    const push = (date: string, desc: string, a: number, amt: number) => {
      if (date <= today) txs.push({ date, desc, acct: a, cents: Math.round(amt * 100) });
    };
    const [ty, tm] = today.split("-").map(Number);
    const monthOf = (k: number): [number, number] => {
      const t = tm - 1 - k;
      return [ty + Math.floor(t / 12), (((t % 12) + 12) % 12) + 1];
    };
    const start = ds(...monthOf(5), 1);
    for (let k = 5; k >= 0; k--) {
      const [y, m] = monthOf(k), n = dim(y, m);
      const D = (d: number) => ds(y, m, d);
      push(D(1), "ZELLE TO OAKWOOD PROPERTY MGMT", chase, -1650);
      push(D(3), "NETFLIX.COM", amex, -15.49);
      push(D(8), "APPLE.COM/BILL", amex, -2.99);
      push(D(12), "SPOTIFY USA", amex, -11.99);
      push(D(14), "PG&E WEB ONLINE", chase, -R(64, 118));
      push(D(18), "COMCAST XFINITY", chase, -79.99);
      push(D(22), "GEICO *AUTO", chase, -142);
      const p = R(780, 1350);
      push(D(6), "AMEX EPAYMENT ACH PMT", chase, -p);
      push(D(6), "AUTOPAY PAYMENT - THANK YOU", amex, p);
      const pool = (arr: string[], c: number, a: number, b: number) => {
        for (let i = 0; i < c; i++) push(D(1 + Math.floor(r() * n)), pick(arr), r() < 0.55 ? amex : chase, -R(a, b));
      };
      pool(GRO, 6, 24, 100); pool(DIN, 7, 5.5, 52); pool(TRN, 3, 6, 50);
      pool(SHO, 2 + Math.floor(r() * 2), 16, 120); pool(ENT, 1 + Math.floor(r() * 2), 12, 36);
    }
    let pay = addDays(today, -3);
    const firstPay: string[] = [];
    while (pay >= start) { push(pay, "ACME CORP PAYROLL PPD", chase, 2400); firstPay.push(pay); pay = addDays(pay, -14); }
    push(addDays(today, -12), UNK[0], amex, -14.25);
    push(addDays(today, -9), UNK[1], amex, -48);

    // One import per account per month, so they can be undone like real imports.
    const groups = new Map<string, Tx[]>();
    for (const t of txs) {
      const k = `${t.acct}|${t.date.slice(0, 7)}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const impIns = db.prepare(
      `INSERT INTO imports (file_name, account_id, imported_at, row_count, new_count, skipped_count, unreadable_count, first_date, last_date)
       VALUES (?,?,?,?,?,?,?,?,?)`);
    const txIns = db.prepare(
      "INSERT INTO transactions (account_id, date, description, amount_cents, category_id, import_id, created_at) VALUES (?,?,?,?,?,?,?)");
    for (const [key, list] of [...groups].sort()) {
      const [a, ym] = key.split("|");
      list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      const last = list[list.length - 1].date, first = list[0].date;
      const [ly, lm, ld] = last.split("-").map(Number);
      const name = `${Number(a) === chase ? "Chase" : "Amex"}_Activity_${ym.replace("-", "")}.csv`;
      const id = Number(impIns.run(name, a, new Date(ly, lm - 1, ld, 12).toISOString(), list.length, list.length, 0, 0, first, last).lastInsertRowid);
      for (const t of list) txIns.run(t.acct, t.date, t.desc, t.cents, match(t.desc)?.category_id ?? unc, id, now);
    }
    recomputeLastImport(db, chase);
    recomputeLastImport(db, amex);

    const rec = db.prepare(
      "INSERT INTO recurring_items (name, amount_cents, category_id, account_id, frequency, anchor_date, match_text, active) VALUES (?,?,?,?,?,?,?,1)");
    const m1 = (d: number) => ds(...monthOf(5), d);
    rec.run("Rent", -165000, cat("Rent"), chase, "monthly", m1(1), "OAKWOOD PROPERTY");
    rec.run("Paycheck", 240000, cat("Income"), chase, "biweekly", firstPay[firstPay.length - 1] ?? addDays(today, -3), "PAYROLL");
    rec.run("Netflix", -1549, cat("Subscriptions"), amex, "monthly", m1(3), "NETFLIX");
    rec.run("Spotify", -1199, cat("Subscriptions"), amex, "monthly", m1(12), "SPOTIFY");
    rec.run("Car insurance", -14200, cat("Transportation"), chase, "monthly", m1(22), "GEICO");

    const bud = db.prepare("INSERT INTO budgets (month, category_id, amount_cents) VALUES (?,?,?)");
    for (let k = 5; k >= 0; k--) {
      const month = `${monthOf(k)[0]}-${pad(monthOf(k)[1])}`;
      for (const [n, c] of Object.entries(BUDGETS)) bud.run(month, cat(n), c);
      db.prepare("INSERT INTO other_budgets (month, amount_cents) VALUES (?,?)").run(month, 15000);
    }
  })();
}
