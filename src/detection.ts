/**
 * Merging user-entered brand details with looked-up ones.
 *
 * This is deliberately a pure function with its own tests, because getting it
 * wrong is not a cosmetic bug: an audit that silently replaces the industry a
 * user typed describes a different business than the one they asked about, and
 * every downstream metric inherits the error.
 */

export interface BrandFields {
  businessName: string;
  domain: string;
  industry: string;
  coreOfferings: string;
  competitors: string[];
}

export type DetectedDetails = Partial<{
  businessName: string;
  domain: string;
  industry: string;
  coreOfferings: string;
  competitors: string[];
}> | null;

const isBlank = (value?: string) => !value || value.trim().length === 0;

/**
 * The user's input always wins. Detection may only fill fields left blank;
 * it may never overwrite, and it may never fabricate a value for a field the
 * lookup did not actually return.
 */
export function mergeDetectedDetails(user: BrandFields, detected: DetectedDetails): BrandFields {
  const merged: BrandFields = {
    businessName: user.businessName?.trim() || '',
    domain: user.domain?.trim() || '',
    industry: user.industry?.trim() || '',
    coreOfferings: user.coreOfferings?.trim() || '',
    competitors: (user.competitors || []).map((c) => c.trim()).filter(Boolean),
  };

  if (!detected) return merged;

  if (isBlank(merged.businessName) && !isBlank(detected.businessName)) {
    merged.businessName = detected.businessName!.trim();
  }
  if (isBlank(merged.domain) && !isBlank(detected.domain)) {
    merged.domain = detected.domain!.trim();
  }
  if (isBlank(merged.industry) && !isBlank(detected.industry)) {
    merged.industry = detected.industry!.trim();
  }
  if (isBlank(merged.coreOfferings) && !isBlank(detected.coreOfferings)) {
    merged.coreOfferings = detected.coreOfferings!.trim();
  }
  if (merged.competitors.length === 0 && Array.isArray(detected.competitors)) {
    merged.competitors = detected.competitors.map((c) => String(c).trim()).filter(Boolean);
  }

  return merged;
}

/**
 * Placeholder text that must never reach a user as if it described their
 * business. These strings were previously returned when brand lookup failed.
 */
export const FABRICATED_PLACEHOLDERS = [
  'Industry Competitor A',
  'Industry Competitor B',
  'Software & Technology Services',
  'Digital cloud services, automation & SaaS platform',
  'Enterprise decision makers & procurement',
  'Competitor A',
  'Competitor B',
];

/** True when a payload contains invented business facts. */
export function containsFabricatedPlaceholder(payload: unknown): string | null {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  for (const placeholder of FABRICATED_PLACEHOLDERS) {
    if (text.includes(placeholder)) return placeholder;
  }
  return null;
}
