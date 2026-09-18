/**
 * Parse an operator-typed expiry: a Unix timestamp in milliseconds or an ISO
 * date. Returns null when the input is neither.
 *
 * `new Date("1790000000000")` is `NaN` — the Date constructor only parses
 * date strings — so a pasted millisecond timestamp has to go through
 * `Number()` first, or the saved account carries an invalid expiry.
 */
export function parseExpiryInput(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  // Any integer-looking input is a timestamp, negative ones included: V8's
  // Date.parse would otherwise read "-5" as a year.
  if (/^-?\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
