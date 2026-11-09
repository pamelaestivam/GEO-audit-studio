/** One reading of "is this an email address, and which one", shared by every way of signing in. */

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}
