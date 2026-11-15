// Does the live site run the commit we expect (the head of main)? Pure: given what /api/health reported and the expected
// commit, say whether it matches, in a sentence a person can act on. Used by scripts/smoke.mjs (--expect-commit).
//
// Three outcomes, never a silent pass:
//   ok      the site reports a commit and it is the expected one (either may be abbreviated: one starts with the other)
//   fail    the site is behind (or ahead of, or elsewhere from) the expected commit
//   fail    the site does not say which commit it runs, so the check could not be made (reported as such, not as "matches")
export function commitVerdict(reported, expected) {
  const r = String(reported || '').trim().toLowerCase();
  const e = String(expected || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(e)) {
    return { ok: false, sentence: `The expected commit "${expected}" is not a commit id (7 to 40 hex characters), so the live site could not be compared with it.` };
  }
  if (!r) {
    return { ok: false, sentence: `The live site does not say which commit it runs (/api/health has no "commit"), so it could not be compared with ${e.slice(0, 7)}. On Vercel this is VERCEL_GIT_COMMIT_SHA; if it is missing the platform did not provide it.` };
  }
  if (r.startsWith(e) || e.startsWith(r)) {
    return { ok: true, sentence: `The live site runs ${r.slice(0, 7)}, the expected commit.` };
  }
  return {
    ok: false,
    sentence: `The live site runs ${r.slice(0, 7)} but the expected commit is ${e.slice(0, 7)}: the site is not running the latest merged code. Open the Vercel project's Deployments page and look for a deployment of ${e.slice(0, 7)} that failed or is still building; do not re-run the live check until it is Ready.`,
  };
}
