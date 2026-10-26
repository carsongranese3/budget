import type { ErrorCode } from "../shared/types.js";

export class HttpError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string) { super(message); }
}
export const bad = (m: string) => new HttpError(400, "validation", m);
export const notFound = (m = "Not found.") => new HttpError(404, "not_found", m);

export function obj(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw bad("Request body must be a JSON object.");
  return v as Record<string, unknown>;
}
export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw bad(`${field} must be text.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(min === 1 ? `Enter ${field.replace(/_/g, " ")} (up to ${max} characters).` : `${field} must be ${min}-${max} characters.`);
  if (t.includes("\0")) throw bad(`${field} contains invalid characters.`);
  return t;
}
export function int(v: unknown, field: string): number {
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw bad(`${field} must be an integer.`);
  return n;
}
export function month(v: unknown, field = "month"): string {
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw bad(`${field} must be YYYY-MM.`);
  return v;
}
export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${field} must be one of ${allowed.join(", ")}.`);
  return v as T;
}
