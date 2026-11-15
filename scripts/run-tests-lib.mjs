// Pure helpers of scripts/run-tests.mjs (kept apart so a test can import them without running the runner).
import { readFileSync } from 'node:fs';

/** Tests mapped to a list of changed paths. Anything that can affect every test (the server, config, the runner, a shared helper) selects all. */
export function selectChanged(tests, changed, root = new URL('..', import.meta.url).pathname) {
  const everything = /^(server\.ts|package(-lock)?\.json|tsconfig\.json|vite\.config\.\w+|scripts\/run-tests\.mjs|test\/manifest\.json|test\/(ports|fakeGemini|authHelper|serverOutput|googleTestKit)\.ts|api\/)/;
  if (changed.some((c) => everything.test(c))) return tests;
  const picked = new Set();
  for (const c of changed) {
    const direct = tests.find((t) => t.file === c);
    if (direct) { picked.add(direct.file); continue; }
    const stem = c.replace(/^.*\//, '').replace(/\.[a-z]+$/, '');
    if (!stem || !/^(src|scripts|test|\.claude|\.github)\//.test(c)) continue;
    for (const t of tests) {
      let text = ''; try { text = readFileSync(`${root}${t.file}`, 'utf8'); } catch { /* a deleted file */ }
      if (new RegExp(`['"/]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\w+)?['"]`).test(text) || text.includes(c)) picked.add(t.file);
    }
  }
  return tests.filter((t) => picked.has(t.file));
}

