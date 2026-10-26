import type { ErrorCode } from "../shared/types.js";

export class HttpError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string) { super(message); }
}
export const bad = (m: string) => new HttpError(400, "validation", m);
export const notFound = (m = "Not found.") => new HttpError(404, "not_found", m);

const LABELS: Record<string, string> = {
  anchor_date: "next date", amount_cents: "amount", category_id: "category", account_id: "account", match_text: "match text",
  file_name: "file name", sign_mode: "sign mode", date_format: "date format", save_format: "save format",
  category_overrides: "category overrides", excluded_from_totals: "excluded from totals", "format.has_header": "has header",
};
/** Human label for a field name, capitalized for the start of a sentence. */
export const label = (f: string) => { const t = LABELS[f] ?? f.replace(/_/g, " "); return t[0].toUpperCase() + t.slice(1); };

export function obj(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad("Request body must be a JSON object.");
  return v as Record<string, unknown>;
}
export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw bad(`${label(field)} must be text.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(min === 1 ? `Enter ${label(field).toLowerCase()} (up to ${max} characters).` : `${label(field)} must be ${min}-${max} characters.`);
  if (t.includes("\0")) throw bad(`${label(field)} contains invalid characters.`);
  return t;
}
export function int(v: unknown, field: string): number {
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw bad(`${label(field)} must be a whole number.`);
  return n;
}
export function month(v: unknown, field = "month"): string {
  if (typeof v !== "string" || !/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(v)) throw bad(`${label(field)} must be a valid month.`);
  return v;
}
export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${label(field)} must be one of ${allowed.join(", ")}.`);
  return v as T;
}
