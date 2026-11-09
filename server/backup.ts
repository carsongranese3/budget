import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";

const KEEP = 10;

/** Consistent snapshot into <db dir>/backups (VACUUM INTO, never a raw copy of a WAL db); keeps the newest KEEP. No-op for :memory:. */
export function snapshot(db: DB): void {
  if (db.name === ":memory:") return;
  const dir = path.join(path.dirname(db.name), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `budget-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  fs.rmSync(file, { force: true }); // same-millisecond collision; VACUUM INTO refuses an existing file
  db.prepare("VACUUM INTO ?").run(file);
  const old = fs.readdirSync(dir).filter((f) => /^budget-.*\.db$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
}
