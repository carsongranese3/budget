const STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

/**
 * Suggested learned-rule text for a description (spec §4.2). Rules match by
 * substring of UPPER(description), so the result is always a contiguous
 * substring of the uppercased input: we only trim the ends, never rewrite.
 */
export function merchantKey(description: string): string {
  let s = description.toUpperCase().trim();
  if (/^#\s*\d+$/.test(s)) return "";
  s = s
    .replace(/^(?:SQ|TST|PL|PYL|PY|UBR|PAYPAL)\s*\*\s*/, "") // processor prefix
    .replace(/\*[A-Z0-9]{4,}$/, "") // AMAZON MKTPL*AB12CD3
    .replace(/\s+(?:(?:WEB|PPD|CCD) ID:|TRANSACTION\s*#:).*$/, ""); // ACH trailers
  const base = s.trim();

  // Cut at the first reference/date/phone/store-number token (never the first token).
  const t = base.split(" ");
  const ref = (w: string, i: number) =>
    /\d/.test(w) && !/^\d+(?:ST|ND|RD|TH)$/.test(w) && !(i >= 2 && t[i - 2] === "ENDING" && t[i - 1] === "IN");
  const at = t.findIndex((w, i) => i > 0 && ref(w, i));
  let out = at < 0 ? t : t.slice(0, at);
  // After a cut, drop a trailing "<CITY> <ST>" (keep a city the bank truncated from the prior word).
  if (at > 0 && out.length >= 3 && STATES.has(out[out.length - 1])) {
    out = out.slice(0, -1);
    const city = out[out.length - 1];
    if (out.length >= 2 && !out[out.length - 2].startsWith(city)) out = out.slice(0, -1);
  }
  const n = out.length; // doubled trailing city, e.g. "... AUSTIN AUSTIN"
  if (n >= 3 && out[n - 1] === out[n - 2]) out = out.slice(0, -2);
  const key = out.join(" ").replace(/[\s-]+$/, "");
  return key.length >= 3 ? key : base;
}
