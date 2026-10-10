/**
 * What the server's own status says about the deployment, turned into the
 * sentences a visitor should read. Pure so the wording and the conditions are
 * tested. The conditions come from the server's /api/audit/status response and
 * are never hardcoded to a host: a deployment that really keeps audits shows
 * nothing, one that does not says so (docs/RELIABILITY.md section 5).
 */

export const TEMPORARY_STORAGE_NOTICE =
  'Temporary storage: audits are kept only while this server stays awake and can be lost on a reload or restart. Export your report to keep it.';

export const NO_ENGINE_NOTICE =
  'No answer engine is configured on this server, so no audit can be measured yet. Nothing is simulated.';

/** The persistent notice for a deployment whose storage does not survive a restart; null when it does or is not yet known. */
export function storageNotice(storage: { durable: boolean } | null | undefined): string | null {
  if (!storage) return null;
  return storage.durable ? null : TEMPORARY_STORAGE_NOTICE;
}

/** True only when the server has told us it queries no engine (unknown is not "none"). */
export function hasNoEngine(engines: string[] | null | undefined): boolean {
  return Array.isArray(engines) && engines.length === 0;
}

/** The notice shown beside the run button when nothing can be measured; null when an engine exists or is not yet known. */
export function noEngineNotice(engines: string[] | null | undefined): string | null {
  return hasNoEngine(engines) ? NO_ENGINE_NOTICE : null;
}
