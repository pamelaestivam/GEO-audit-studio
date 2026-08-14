import { useEffect, useState } from 'react';
import { apiFetch } from './apiClient';

export interface QuotaState {
  available: boolean;
  reason: string | null;
  resetAt: string | null;
  msRemaining: number;
}

/**
 * Checks whether the answer engine's quota is currently exhausted, before the
 * user fills out a whole form and submits into a wall the server already
 * knows is there. Re-polls only while quota is unavailable, so the warning
 * clears itself once it resets, and does not poll forever once healthy.
 */
export function useQuotaStatus(): QuotaState | null {
  const [quota, setQuota] = useState<QuotaState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        const res = await apiFetch('/api/audit/status', { retries: 1, timeoutMs: 10000 });
        const data = await res.json();
        if (cancelled) return;
        setQuota(data.quota || null);
        if (data.quota && !data.quota.available) {
          const recheckIn = Math.min(60000, Math.max(5000, data.quota.msRemaining / 10));
          timer = setTimeout(check, recheckIn);
        }
      } catch {
        // A failed status check should not block the form - a real problem
        // still surfaces when the audit itself is submitted.
      }
    };

    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return quota;
}
