/**
 * How one entry of the deep readiness answer reads in the smoke script's output (pure; no network).
 *
 *  - `pass`: it is ok and it was measured (or says nothing about being measured).
 *  - `warn`: it is ok only because it could NOT look (a key that is set but never called, a store that keeps
 *    nothing) or it is the storage entry on a deployment whose lack of durable storage is a known, flagged limit
 *    (--warn-non-durable). Printed on every run; never fails the run, never hidden.
 *  - `fail`: everything else, including a check that is not ok AND not verified (for example the quota breaker is
 *    tripped): not being able to look is never an excuse for a failing check.
 */
export function classifyReadinessCheck(check, { warnNonDurable = false, durable = true } = {}) {
  if (check.ok && check.verified === false) return 'warn';
  if (!check.ok && warnNonDurable && !durable && check.name === 'storage') return 'warn';

  return check.ok ? 'pass' : 'fail';
}
