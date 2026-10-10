/**
 * What went wrong recently, as one honest sentence and a verdict for the readiness check. Pure: no store, no clock
 * (the caller passes `now`).
 *
 * Audits can end badly in several ways and each leaves a trace: a failure code on the job, an incident row, or a
 * finished-but-empty report. Until something reads those together nobody finds out unless they open the database.
 * The deep readiness check calls this; when credentials for the signed-in checks are given to the daily live-site
 * check (docs/PROGRAM.md O-3), it also turns that check red and opens its one issue.
 *
 * Serious means the server broke or gave up (a step threw, a step ran out of tries, a report broke its own
 * consistency rules, the driver failed, an audit ended in error with no reason) or that EVERY audit in the window
 * came back empty (no answer engine worked, or the analysis never could): the product is not delivering. Noted but
 * not a fault: an audit stopped for taking too long, one a restart interrupted, a repeated call, and some empty
 * audits while others succeeded (a quota wall or a key that failed for a while).
 */
import type { Incident, JobOutcomes } from './store.js';

export const SERIOUS_FAIL_CODES = ['driver_error', 'step_exception', 'step_attempts_exceeded'] as const;
export const SERIOUS_INCIDENT_KINDS = ['step_exception', 'step_attempts_exceeded', 'invariant'] as const;

export interface RecentTrouble {
  /** False when something serious happened in the window. */
  ok: boolean;
  /** True when this answer is a measurement; false when it only says it could not tell. */
  verified: boolean;
  serious: number;
  detail: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How a failure code reads in a sentence, e.g. `2 took too long and were stopped`. */
function describeFailCode(code: string, n: number): string {
  switch (code) {
    case 'stuck':
      return `${n} took too long and ${n === 1 ? 'was' : 'were'} stopped`;
    case 'restarted':
      return `${n} ${n === 1 ? 'was' : 'were'} interrupted by a restart`;
    case 'driver_error':
      return `${n} failed inside the server`;
    case 'step_exception':
      return `${n} had a step that broke`;
    case 'step_attempts_exceeded':
      return `${n} had a step that did not finish after its tries`;
    case 'none':
      return `${n} ended in error without a recorded reason`;
    default:
      return `${n} ended with the code "${code}"`;
  }
}

export function summariseRecentTrouble(input: {
  outcomes: JobOutcomes;
  /** Any number of incidents, newest first; the ones outside the window are ignored here. */
  incidents: Pick<Incident, 'kind' | 'at' | 'detail'>[];
  now: number;
  windowHours: number;
  /** False when the store keeps nothing across restarts or instances, so this only covers what this process saw. */
  durable: boolean;
}): RecentTrouble {
  const since = input.now - input.windowHours * 60 * 60 * 1000;
  const incidents = input.incidents.filter((i) => i.at >= since);
  const { failed, degraded, succeeded } = input.outcomes;
  const failedEntries = Object.entries(failed).filter(([, n]) => n > 0);
  const failedTotal = failedEntries.reduce((sum, [, n]) => sum + n, 0);
  const incidentsByKind: Record<string, number> = {};
  for (const i of incidents) incidentsByKind[i.kind] = (incidentsByKind[i.kind] ?? 0) + 1;

  const seriousFailed = failedEntries
    .filter(([code]) => (SERIOUS_FAIL_CODES as readonly string[]).includes(code) || code === 'none')
    .reduce((s, [, n]) => s + n, 0);
  const seriousIncidentRows = incidents.filter((i) => (SERIOUS_INCIDENT_KINDS as readonly string[]).includes(i.kind));
  // An audit that failed seriously usually also left a serious incident; count the larger so one fault is not two.
  const serious = Math.max(seriousFailed, seriousIncidentRows.length);
  const allEmpty = degraded > 0 && succeeded === 0;

  const window = `the last ${plural(input.windowHours, 'hour', 'hours')}`;
  const scope = input.durable ? '' : ' This server keeps nothing across restarts, so this covers only what it has seen since it started.';
  const nothing = failedTotal === 0 && incidents.length === 0 && degraded === 0;

  if (nothing) {
    if (!input.durable) {
      // Not a measurement: a memory store on a host that runs many short-lived instances has no way to know.
      return {
        ok: true,
        verified: false,
        serious: 0,
        detail: `Not checked. This server keeps nothing across restarts or between its instances, so it cannot say whether audits failed in ${window}. Nothing was recorded here since it started.`,
      };
    }
    const fine = succeeded > 0 ? ` ${plural(succeeded, 'audit finished', 'audits finished')} normally.` : '';
    return { ok: true, verified: true, serious: 0, detail: `No audit failed and no incident was recorded in ${window}.${fine}` };
  }

  const parts: string[] = [];
  if (failedTotal > 0) {
    parts.push(`${plural(failedTotal, 'audit ended', 'audits ended')} in error (${failedEntries.map(([code, n]) => describeFailCode(code, n)).join(', ')})`);
  }
  if (degraded > 0) {
    parts.push(`${plural(degraded, 'audit finished', 'audits finished')} with no result (the answer engines or the analysis failed)`);
  }
  if (incidents.length > 0) {
    const kinds = Object.entries(incidentsByKind)
      .map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}`)
      .join(', ');
    parts.push(`${plural(incidents.length, 'incident was', 'incidents were')} recorded (${kinds})`);
  }
  if (succeeded > 0) parts.push(`${plural(succeeded, 'audit finished', 'audits finished')} normally`);

  const latest = seriousIncidentRows[0];
  let verdict: string;
  if (serious > 0) {
    verdict = ' The server itself broke or gave up on some of this.' + (latest ? ` Most recent: ${latest.detail.replace(/\s+/g, ' ').slice(0, 240)}` : '');
  } else if (allEmpty) {
    verdict = ' Every audit in this period came back without a result: check that the answer engine key is accepted and that its quota is not used up.';
  } else {
    verdict = ' None of this is a fault in the server: restarts, slow audits, repeated calls and an occasional empty audit are expected now and then.';
  }
  return { ok: serious === 0 && !allEmpty, verified: true, serious: serious + (allEmpty ? degraded : 0), detail: `In ${window}: ${parts.join('; ')}.${verdict}${scope}` };
}
