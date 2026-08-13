/**
 * Client for running an audit.
 *
 * An audit runs as a background job on the server. Holding a single request
 * open for the whole run is what produced "Load failed" on mobile, so the
 * client starts a job and polls it, keeping every request short.
 */

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
const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;

export async function runAuditJob(
  payload: AuditRequest,
  onProgress?: (message: string) => void,
  timeoutMs = 8 * 60 * 1000
): Promise<StartAuditResult> {
  const startRes = await fetch('/api/audit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const start = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !start.jobId) {
    throw new Error(start.error || 'Could not start the audit. Please try again.');
  }

  const startedAt = Date.now();
  let consecutiveNetworkErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let res: Response;
    try {
      res = await fetch(`/api/audit/job/${start.jobId}`);
      consecutiveNetworkErrors = 0;
    } catch {
      // A sleeping free instance or a flaky mobile connection drops the odd
      // poll; only give up once several in a row fail.
      consecutiveNetworkErrors += 1;
      if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        throw new Error('Lost connection to the audit service. Please check your connection and try again.');
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
