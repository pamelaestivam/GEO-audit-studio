import { useEffect, useState } from 'react';
import { apiFetch } from './apiClient';

/** Everything /api/audit/status reports that the UI needs. */
export interface AuditStatus {
  quota: QuotaState | null;
  /** Engines the server will genuinely query. null until the first response. */
  engines: string[] | null;
  /** Whether audits are kept across a refresh or restart on this deployment. null until known. */
  storage: { kind: string; durable: boolean; note?: string } | null;
  /** Whether people can sign in at all, and if not, what the operator must fix. */
  auth: { mode: 'configured' | 'dev' | 'unconfigured'; problem?: string } | null;
  /** Paid engines that have a key but are switched off because paid engines are not switched on for this server. null until known. */
  paidBlocked: string[] | null;
}

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
  return useAuditStatus().quota;
}

export function useAuditStatus(): AuditStatus {
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [engines, setEngines] = useState<string[] | null>(null);
  const [storage, setStorage] = useState<AuditStatus['storage']>(null);
  const [auth, setAuth] = useState<AuditStatus['auth']>(null);
  const [paidBlocked, setPaidBlocked] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      try {
        const res = await apiFetch('/api/audit/status', { retries: 1, timeoutMs: 10000 });
        const data = await res.json();
        if (cancelled) return;
        setQuota(data.quota || null);
        setEngines(Array.isArray(data.engines) ? data.engines : null);
        setStorage(data.storage || null);
        setAuth(data.auth || null);
        setPaidBlocked(Array.isArray(data.spend?.paidEnginesBlocked) ? data.spend.paidEnginesBlocked : null);
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

  return { quota, engines, storage, auth, paidBlocked };
}

/** "Gemini and Perplexity" - for copy that must name only engines actually queried. */
export function describeEngines(engines: string[] | null): string {
  if (engines === null) return 'the configured answer engines';
  if (engines.length === 0) return 'no answer engine (none is configured)';
  if (engines.length === 1) return engines[0];
  return `${engines.slice(0, -1).join(', ')} and ${engines[engines.length - 1]}`;
}
