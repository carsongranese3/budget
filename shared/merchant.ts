/** Learned-rule key for a transaction description (spec §4.2). */
export function merchantKey(description: string): string {
  return description
    .toUpperCase()
    .replace(/^#\s*\d+$/, "")
    .replace(/\s+#\s*\d+.*$/, "")
    .replace(/\s+\d{3,}$/, "")
    .replace(/\*[A-Z0-9]{4,}$/, "")
    .trim();
}
