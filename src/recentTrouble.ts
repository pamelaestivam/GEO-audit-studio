/**
 * What went wrong recently, as one honest sentence and one yes/no for the readiness check. Pure: no store, no clock.
 *
 * Audits can end badly in several ways and each leaves a trace (a failure code on the job, an incident row), but
 * until something reads those traces together nobody finds out unless they open the database. The deep readiness
 * check calls this, so the daily live-site check opens its one tracking issue when the server has been quietly
 * failing audits (docs/RELIABILITY.md, step g).
 *
 * Serious means the server broke or gave up: a step threw, a step ran out of tries, an invariant failed, the
 * driver itself failed. Everything else is worth saying but is not a fault in the server: an audit the reaper
 * stopped for taking too long, one a restart interrupted, a call repeated after a takeover.
 */
import type { Incident } from './store.js';

export const SERIOUS_FAIL_CODES = ['driver_error', 'step_exception', 'step_attempts_exceeded'] as const;
export const SERIOUS_INCIDENT_KINDS = ['step_exception', 'step_attempts_exceeded', 'invariant'] as const;

export interface RecentTrouble {
  /** False when something serious happened in the window. */
  ok: boolean;
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
  failedByCode: Record<string, number>;
  incidents: Pick<Incident, 'kind'>[];
  windowHours: number;
  /** True when the store keeps nothing across restarts or instances, so this only covers what this process saw. */
  durable: boolean;
}): RecentTrouble {
  const failed = Object.entries(input.failedByCode).filter(([, n]) => n > 0);
  const failedTotal = failed.reduce((sum, [, n]) => sum + n, 0);
  const incidentsByKind: Record<string, number> = {};
  for (const i of input.incidents) incidentsByKind[i.kind] = (incidentsByKind[i.kind] ?? 0) + 1;

  const seriousFailed = failed.filter(([code]) => (SERIOUS_FAIL_CODES as readonly string[]).includes(code) || code === 'none').reduce((s, [, n]) => s + n, 0);
  const seriousIncidents = Object.entries(incidentsByKind)
    .filter(([kind]) => (SERIOUS_INCIDENT_KINDS as readonly string[]).includes(kind))
    .reduce((s, [, n]) => s + n, 0);
  // An audit that failed seriously usually also left a serious incident; count the larger so one fault is not two.
  const serious = Math.max(seriousFailed, seriousIncidents);

  const window = `the last ${plural(input.windowHours, 'hour', 'hours')}`;
  const scope = input.durable ? '' : ' This server keeps nothing across restarts, so this covers only what it has seen since it started.';
  if (failedTotal === 0 && input.incidents.length === 0) {
    return { ok: true, serious: 0, detail: `No audit failed and no incident was recorded in ${window}.${scope}` };
  }

  const parts: string[] = [];
  if (failedTotal > 0) {
    const reasons = failed.map(([code, n]) => describeFailCode(code, n)).join(', ');
    parts.push(`${plural(failedTotal, 'audit ended', 'audits ended')} in error (${reasons})`);
  }
  if (input.incidents.length > 0) {
    const kinds = Object.entries(incidentsByKind)
      .map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}`)
      .join(', ');
    parts.push(`${plural(input.incidents.length, 'incident was', 'incidents were')} recorded (${kinds})`);
  }
  const verdict =
    serious > 0
      ? ' The server itself broke or gave up on some of this: look at the incidents.'
      : ' None of this is a fault in the server: restarts, slow audits and repeated calls are expected now and then.';
  return { ok: serious === 0, serious, detail: `In ${window}: ${parts.join('; ')}.${verdict}${scope}` };
}
