/**
 * Regression test for the actual production bug this proves it would have
 * caught: Vercel's Node.js runtime transpiles api/[...path].ts and its
 * imports individually rather than bundling them into one file (the way
 * esbuild does for dist/server.cjs), so at runtime it's real Node ESM
 * resolution - which, unlike a bundler or `tsx` (what runs this very test
 * suite), refuses to infer a missing file extension. Confirmed from the
 * live Vercel function logs:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/server'
 *   imported from /var/task/api/[...path].js
 *
 * `npm test` was green the whole time this was broken in production,
 * because every other test imports server.ts/api/[...path].ts through
 * `tsx`, which resolves extensionless specifiers just fine. This test
 * instead statically walks the same module graph Vercel's runtime walks
 * and asserts every relative import carries an explicit extension - the
 * one property tsx's resolution doesn't require but Node's native ESM
 * loader does.
 *
 * Run with: npx tsx test/vercelEsmImports.test.ts
 */

import fs from 'fs';
import path from 'path';

let failures = 0;
function fail(message: string) {
  failures++;
  console.log(`FAIL  ${message}`);
}

const ROOT = process.cwd();
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;
const SOURCE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|json)$/;

function resolveOnDisk(fromDir: string, specifier: string): string {
  const hasExt = SOURCE_EXT_RE.test(specifier);
  const rawPath = path.join(fromDir, specifier);
  const withoutJsExt = rawPath.replace(/\.(js|jsx|mjs|cjs)$/, '');
  // This repo has no compiled .js next to its .ts sources - a '.js'
  // specifier is meant to resolve to the sibling .ts/.tsx file, exactly
  // the TypeScript "NodeNext" convention this fix adopts.
  for (const ext of ['.ts', '.tsx']) {
    if (fs.existsSync(withoutJsExt + ext)) return withoutJsExt + ext;
  }
  if (hasExt && fs.existsSync(rawPath)) return rawPath;
  if (!hasExt) {
    for (const ext of ['.ts', '.tsx', '.js']) {
      if (fs.existsSync(rawPath + ext)) return rawPath + ext;
    }
  }
  throw new Error(`cannot resolve '${specifier}' from ${path.relative(ROOT, fromDir)} on disk`);
}

function walk(entryAbsPath: string, visited: Set<string>) {
  if (visited.has(entryAbsPath)) return;
  visited.add(entryAbsPath);

  const relEntry = path.relative(ROOT, entryAbsPath);
  const src = fs.readFileSync(entryAbsPath, 'utf8');
  const dir = path.dirname(entryAbsPath);

  RELATIVE_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIVE_IMPORT_RE.exec(src))) {
    const specifier = match[1];
    if (!SOURCE_EXT_RE.test(specifier)) {
      fail(
        `${relEntry} imports '${specifier}' with no file extension - Node's ` +
          `native ESM resolver on Vercel cannot infer one (TECH_DEBT.md 1.4a). ` +
          `Use '${specifier}.js'.`
      );
    }
    let resolved: string;
    try {
      resolved = resolveOnDisk(dir, specifier);
    } catch (err) {
      fail(`${relEntry} imports '${specifier}', which ${(err as Error).message}`);
      continue;
    }
    walk(resolved, visited);
  }
}

function main() {
  const visited = new Set<string>();
  const entryPoints = [
    path.join(ROOT, 'server.ts'),
    path.join(ROOT, 'api', '[...path].ts'),
  ];

  for (const entry of entryPoints) {
    walk(entry, visited);
  }

  console.log(`Walked ${visited.size} file(s) reachable from the Vercel function's entry points.`);
  console.log(
    failures === 0
      ? '\nAll relative imports in the Vercel function graph carry explicit extensions.'
      : `\n${failures} check(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
