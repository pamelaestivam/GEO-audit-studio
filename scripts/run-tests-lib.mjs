// Pure helpers of scripts/run-tests.mjs (kept apart so a test can import them without running the runner).
import { readFileSync } from 'node:fs';

/** Tests mapped to a list of changed paths. Anything that can affect every test (the server, config, the runner, a shared helper) selects all. */
export function selectChanged(tests, changed, root = new URL('..', import.meta.url).pathname) {
  const everything = /^(server\.ts|package(-lock)?\.json|tsconfig\.json|vite\.config\.\w+|scripts\/run-tests(-lib)?\.mjs|test\/manifest\.json|test\/(ports|fakeGemini|authHelper|serverOutput|googleTestKit)\.ts|api\/)/;
  if (changed.some((c) => everything.test(c))) return tests;
  // Changes that feed the built app and are exercised only through it: every test that needs dist/ (E2E and browser files never import src).
  const feedsBuild = /^(src\/|index\.html$|Dockerfile$|render\.yaml$|vercel\.json$|test\/golden\/|test\/fixtures\/|public\/)/;
  // Changes that cannot affect a test: documentation and records.
  const harmless = /^(docs\/|.*\.md$|\.github\/(ISSUE_TEMPLATE|pull_request_template)|LICENSE|\.gitignore$)/;
  const picked = new Set();
  let unmapped = false;
  for (const c of changed) {
    if (harmless.test(c)) continue;
    const direct = tests.find((t) => t.file === c);
    if (direct) { picked.add(direct.file); continue; }
    let hit = false;
    if (feedsBuild.test(c)) { for (const t of tests) if (t.needsBuild) picked.add(t.file); hit = true; }
    const stem = c.replace(/^.*\//, '').replace(/\.[a-z]+$/, '');
    if (stem && /^(src|scripts|test|\.claude|\.github)\//.test(c) && !/^test\/(golden|fixtures)\//.test(c)) {
      const re = new RegExp(`['"/]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\w+)?['"]`);
      for (const t of tests) {
        let text = ''; try { text = readFileSync(`${root}${t.file}`, 'utf8'); } catch { /* a deleted file */ }
        if (re.test(text) || text.includes(c)) { picked.add(t.file); hit = true; }
      }
    }
    if (!hit) unmapped = true;
  }
  // A change that maps to nothing and is not documentation cannot be judged: run everything rather than call it safe.
  if (unmapped) return tests;
  return tests.filter((t) => picked.has(t.file));
}
