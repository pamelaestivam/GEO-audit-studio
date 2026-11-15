// Does the live site run the commit we expect (the head of main)? Pure: given what /api/health reported and the expected
// commit, say whether it matches, in a sentence a person can act on. Used by scripts/smoke.mjs (--expect-commit).
//
// Three outcomes, never a silent pass:
//   ok      the site reports a commit and it is the expected one (either may be abbreviated: one starts with the other; both must look like a commit id)
//   fail    the site is behind (or ahead of, or elsewhere from) the expected commit
//   fail    the site does not say which commit it runs, so the check could not be made (reported as such, not as "matches")
export function commitVerdict(reported, expected) {
  const r = typeof reported === 'string' ? reported.trim().toLowerCase() : reported == null || reported === 0 || reported === false ? '' : '\u0000not-a-string';
  const e = String(expected || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(e)) {
    return { ok: false, sentence: e === '' || expected === undefined
      ? 'No expected commit was given (the head of main could not be read, or --expect-commit has no value), so the live site could not be compared. Give a commit id of 7 to 40 hex characters.'
      : `The expected commit "${expected}" is not a commit id (7 to 40 hex characters), so the live site could not be compared with it.` };
  }
  if (!r) {
    return { ok: false, sentence: `The live site does not say which commit it runs (/api/health has no "commit"), so it could not be compared with ${e.slice(0, 7)}. On Vercel this is VERCEL_GIT_COMMIT_SHA; if it is missing the platform did not provide it.` };
  }
  if (!/^[0-9a-f]{7,40}$/.test(r)) {
    return { ok: false, sentence: `The live site reports "${String(reported).slice(0, 60)}" as its commit, which is not a commit id (7 to 40 hex characters), so it could not be compared with ${e.slice(0, 7)}.` };
  }
  if (r.startsWith(e) || e.startsWith(r)) {
    return { ok: true, sentence: `The live site runs ${r.slice(0, 7)}, the expected commit.` };
  }
  return {
    ok: false,
    sentence: `The live site runs ${r.slice(0, 7)}, not the expected ${e.slice(0, 7)}. If the site is behind, open the Vercel project's Deployments page and look for a deployment of ${e.slice(0, 7)} that failed or is still building, and wait until it is Ready before re-running this check. If a newer deployment went live since, the site is ahead and nothing is wrong. This check cannot tell which: it does not know the order of the two commits.`,
  };
}
