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
import { newIdempotencyKey } from './idempotency';

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
  /** Whether the server kept this audit (durable storage, and the save succeeded). */
  saved?: boolean;
}

/** Mirrors the server's job progress: what the audit is genuinely doing now. */
export interface AuditProgress {
  phase: 'querying' | 'analysing';
  done: number;
  total: number;
}

/** A sentence for what the server is doing, built only from what it reported. */
export function describeProgress(progress: AuditProgress | null | undefined, elapsedSeconds: number): string {
  if (!progress) return `Starting the audit... (${elapsedSeconds}s)`;
  if (progress.phase === 'querying') {
    return `Asking the answer engines: query ${Math.min(progress.done + 1, progress.total)} of ${progress.total}... (${elapsedSeconds}s)`;
  }
  return `Answers captured. Writing the analysis... (${elapsedSeconds}s)`;
}

/** 0-100 for a progress bar, derived from reported progress only. */
export function progressPercent(progress: AuditProgress | null | undefined): number {
  if (!progress) return 3;
  if (progress.phase === 'analysing') return 90;
  return Math.max(3, Math.round((progress.done / Math.max(progress.total, 1)) * 85));
}

const POLL_INTERVAL_MS = 2500;
const MAX_CONSECUTIVE_POLL_FAILURES = 4;
/** The shortest wait between two requests when the last one did not advance anything (busy or idle). */
const MIN_WAIT_AFTER_NO_PROGRESS_MS = 1000;

/** How far an audit had got, as the server last reported it. */
export interface AuditSteps {
  done: number;
  total: number;
  plannedCalls: number;
  callsMade: number;
  repeatedCalls: number;
}

/**
 * The audit stopped because the server instance that held it is gone and this deployment keeps no saved state:
 * nothing can be resumed and nothing from the interrupted run is a measurement. It says how far it got.
 */
export class AuditInterrupted extends Error {
  readonly reason = 'state_lost' as const;
  constructor(readonly steps: AuditSteps | null) {
    super(interruptedMessage(steps));
    this.name = 'AuditInterrupted';
  }
}

/** The sentence a person reads. Counts are "at least" because a call can be retried inside one step. */
export function interruptedMessage(steps: AuditSteps | null): string {
  const how = steps && steps.total > 0
    ? ` It had finished ${steps.done} of ${steps.total} steps and made at least ${steps.callsMade} engine ${steps.callsMade === 1 ? 'call' : 'calls'}.`
    : ' It is not known whether any engine call had been made.';
  const again = steps && steps.plannedCalls > 0 ? ` Running it again can use up to ${steps.plannedCalls} engine ${steps.plannedCalls === 1 ? 'call' : 'calls'}.` : '';
  return `The server that answered no longer had your audit, and this deployment does not keep saved state, so the audit could not continue.${how} Nothing from the interrupted run is shown as a measurement.${again} Please run it again.`;
}

export async function runAuditJob(
  payload: AuditRequest,
  onProgress?: (message: string, progress?: AuditProgress | null) => void,
  timeoutMs = 8 * 60 * 1000
): Promise<StartAuditResult> {
  // Full retry budget: this is the request that hits a sleeping instance.
  //
  // Those retries used to start a *new* audit each time. The submit that
  // wakes a sleeping instance can stall past our timeout while the server
  // accepts it anyway, and aborting the client's request does not abort the
  // audit the server already began - so one click became up to four
  // concurrent audits, all spending Gemini quota. The key is generated once
  // per click and reused across every attempt, so the server can recognise
  // the retries as the same submit and hand back the job it already started.
  const idempotencyKey = newIdempotencyKey();

  const startRes = await apiFetch('/api/audit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload),
    timeoutMs: 30000,
  });

  const start = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !start.jobId) {
    throw new Error(start.error || 'Could not start the audit. Please try again.');
  }

  const startedAt = Date.now();
  let consecutivePollFailures = 0;
  // `client`: nothing runs on the server unless this page asks for the next step; `inline`: the server runs it.
  const driven = start.driver === 'client';
  let lastSteps: AuditSteps | null = null;
  let waitMs = driven ? 0 : POLL_INTERVAL_MS;

  while (Date.now() - startedAt < timeoutMs) {
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    waitMs = POLL_INTERVAL_MS;

    let res: Response;
    try {
      // A light retry budget here: the instance is already awake by now (we
      // got a job id), so a poll failure is more likely a blip than a cold
      // start, and the outer loop is itself a retry every 2.5s. Advancing is never retried inside the
      // request: asking again is safe (a step someone holds answers "busy"), and a long timeout lets a
      // slow step finish rather than be abandoned and repeated.
      res = driven
        ? await apiFetch(`/api/audit/job/${start.jobId}/advance`, { method: 'POST', retries: 0, timeoutMs: 120000 })
        : await apiFetch(`/api/audit/job/${start.jobId}`, { retries: 1, timeoutMs: 15000 });
    } catch {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw new Error(lostConnectionMessage(driven));
      continue;
    }

    // A gateway or platform error (502, 503, 504) says something about the server, not about the audit: ask
    // again, like any other blip, instead of ending the audit on it.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw new Error(lostConnectionMessage(driven));
      continue;
    }
    consecutivePollFailures = 0;

    const data = await res.json().catch(() => ({}));

    if (res.status === 404) {
      // A driven audit whose job is not here, on a deployment that keeps no state, was lost with its instance.
      if (driven && data.code === 'job_not_found' && data.storage?.durable === false) throw new AuditInterrupted(lastSteps);
      throw new Error(data.error || 'That audit expired before it finished. Please run it again.');
    }
    if (data.steps) lastSteps = data.steps as AuditSteps;
    if (data.status === 'running') {
      const seconds = Math.round((data.elapsedMs || 0) / 1000);
      onProgress?.(describeProgress(data.progress, seconds), data.progress ?? null);
      if (driven) waitMs = driveWaitMs(data.outcome, data.nextStepAfterMs);
      continue;
    }
    if (!res.ok || data.status === 'error') {
      throw new Error(data.error || 'The audit failed to complete.');
    }
    if (!data.report) {
      throw new Error('The audit finished but returned no report. Please try again.');
    }
    // Carry "was it kept" on the report itself, so every screen that shows it
    // can say the truth about whether a refresh will lose it.
    return { ...data, report: { ...data.report, saved: !!data.saved } } as StartAuditResult;
  }

  throw new Error(
    driven
      ? 'The audit did not finish in time. It only moves forward while this page is open and asking, so it has stopped. Please run it again.'
      : 'The audit is taking longer than expected. It may still finish - please try again in a few minutes.'
  );
}

/** What a person reads when the page cannot reach the server four times running. */
function lostConnectionMessage(driven: boolean): string {
  return driven
    ? 'Lost connection to the audit service. This audit only moves forward while this page is connected, so it is paused. Check your connection and run it again.'
    : 'Lost connection to the audit service. The audit may still be running on the server - check your connection and try refreshing shortly.';
}

/**
 * How long the page waits before asking a server-driven-by-page audit for its next step. After a step that
 * advanced, the server's own pause (0 when none is wanted). After anything else (busy, idle) never less than a
 * second, and an idle answer waits a full poll, so a server that keeps saying "nothing to do" cannot be hammered.
 */
export function driveWaitMs(outcome: string | undefined, serverWaitMs: unknown): number {
  const asked = Math.max(0, Number(serverWaitMs) || 0);
  if (outcome === 'advanced') return asked;
  if (outcome === 'idle' || outcome === 'gone') return POLL_INTERVAL_MS;
  return Math.max(asked, MIN_WAIT_AFTER_NO_PROGRESS_MS);
}
