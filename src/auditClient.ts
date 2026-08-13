/**
 * Client for running an audit.
 *
 * An audit runs as a background job on the server. Holding a single request
 * open for the whole run is what produced "Load failed" on mobile, so the
 * client starts a job and polls it, keeping every request short.
 *
 * Every request goes through `apiFetch`, which retries network-level
 * failures with backoff. That matters specifically for the very first
 * request: a Render free instance asleep for 15+ minutes can refuse or
 * reset the connection while it boots, which throws before the server ever
 * gets to answer - a raw browser error ("Load failed") with no server-side
 * translation possible, since the server was never reached.
 */

import { apiFetch } from './apiClient';

export interface AuditRequest {
  businessName: string;
  domain?: string;
  industry?: string;
  competitors?: string[];
  queries?: { id: string; intent: string; queryText: string; targetPersona: string }[];
}

export interface StartAuditResult {
  report: any;
  degraded?: boolean;
}

const POLL_INTERVAL_MS = 2500;
const MAX_CONSECUTIVE_POLL_FAILURES = 4;

export async function runAuditJob(
  payload: AuditRequest,
  onProgress?: (message: string) => void,
  timeoutMs = 8 * 60 * 1000
): Promise<StartAuditResult> {
  // Full retry budget: this is the request that hits a sleeping instance.
  const startRes = await apiFetch('/api/audit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 30000,
  });

  const start = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !start.jobId) {
    throw new Error(start.error || 'Could not start the audit. Please try again.');
  }

  const startedAt = Date.now();
  let consecutivePollFailures = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let res: Response;
    try {
      // A light retry budget here: the instance is already awake by now (we
      // got a job id), so a poll failure is more likely a blip than a cold
      // start, and the outer loop is itself a retry every 2.5s.
      res = await apiFetch(`/api/audit/job/${start.jobId}`, { retries: 1, timeoutMs: 15000 });
      consecutivePollFailures = 0;
    } catch {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(
          'Lost connection to the audit service. The audit may still be running on the server - check your connection and try refreshing shortly.'
        );
      }
      continue;
    }

    const data = await res.json().catch(() => ({}));

    if (res.status === 404) {
      throw new Error(data.error || 'That audit expired before it finished. Please run it again.');
    }
    if (data.status === 'running') {
      const seconds = Math.round((data.elapsedMs || 0) / 1000);
      onProgress?.(`Querying answer engines and capturing citations... (${seconds}s)`);
      continue;
    }
    if (!res.ok || data.status === 'error') {
      throw new Error(data.error || 'The audit failed to complete.');
    }
    if (!data.report) {
      throw new Error('The audit finished but returned no report. Please try again.');
    }
    return data as StartAuditResult;
  }

  throw new Error('The audit is taking longer than expected. It may still finish - please try again in a few minutes.');
}
