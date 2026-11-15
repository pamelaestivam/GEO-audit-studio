#!/usr/bin/env bash
# Guards two facts of the dependency layout (item G1.8 of docs/ENGINEERING_BACKLOG.md):
#  1. `dependencies` holds only what the built server needs at run time; build-time packages (the bundler and the client libraries it
#     bundles) are devDependencies, so the production audit surface and the production install stay small.
#  2. Dependabot watches npm weekly, for security updates, grouped.
#   bash test/dependencyLayout.test.sh
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"; failures=0
ok(){ echo "pass  $1"; }; bad(){ echo "FAIL  $1"; failures=$((failures+1)); }
node -e '
const p=require(process.argv[1]+"/package.json"); const d=Object.keys(p.dependencies).sort().join(",");
const want="@google/genai,dotenv,express,pg";
if (d!==want) { console.log("dependencies are: "+d+" (expected "+want+")"); process.exit(1); }
const dev=p.devDependencies; for (const m of ["vite","@vitejs/plugin-react","@tailwindcss/vite","react","react-dom"]) if(!dev[m]) { console.log(m+" is not a devDependency"); process.exit(1); }
' "$repo" && ok "dependencies are exactly the server's run-time packages; build tools are devDependencies" || bad "dependency layout"
y="$repo/.github/dependabot.yml"
grep -q '"installCommand": "npm ci --include=dev"' "$repo/vercel.json" && ok "Vercel installs devDependencies whatever NODE_ENV is (vercel.json installCommand)" || bad "vercel.json has no installCommand with --include=dev"
grep -q 'package-ecosystem: npm' "$y" && ok "dependabot watches npm" || bad "dependabot does not watch npm"
awk '/package-ecosystem: /{f=($0 ~ /npm/)} f&&/interval: weekly/{w=1} f&&/applies-to: security-updates/{s=1} f&&/patterns:/{g=1} END{exit !(w&&s&&g)}' "$y" && ok "...weekly, security updates, grouped" || bad "...weekly / security / grouped missing"
grep -q 'open-pull-requests-limit: 0' "$y" && ok "...routine version bumps are off" || bad "open-pull-requests-limit: 0 is missing"
grep -q 'package-ecosystem: github-actions' "$y" && ok "...and still watches GitHub Actions" || bad "github-actions entry lost"
# every package the BUILT server bundle loads is a production dependency (the vite dev branch and node:sqlite are the only exceptions).
# Reads dist/server.cjs (built by `npm run build`, which npm test runs first): static requires and dynamic imports, any import style.
if [ -f "$repo/dist/server.cjs" ]; then
  node -e '
const fs=require("fs"); const {builtinModules}=require("module"); const p=require(process.argv[1]+"/package.json"); const deps=new Set(Object.keys(p.dependencies));
const src=fs.readFileSync(process.argv[1]+"/dist/server.cjs","utf8");
const names=[...src.matchAll(/(?:require|import)\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/g)].map(m=>m[1]).filter(n=>!n.startsWith("node:")&&!n.startsWith(".")&&!builtinModules.includes(n)).map(n=>n.startsWith("@")?n.split("/").slice(0,2).join("/"):n.split("/")[0]);
const bad=[...new Set(names)].filter(n=>!deps.has(n)&&n!=="vite");
if (bad.length) { console.log("the built server loads a package that is not a production dependency: "+bad.join(", ")); process.exit(1); }
if (!names.includes("express")) { console.log("scan found no express: the scan itself is broken"); process.exit(1); }
' "$repo" && ok "the built server bundle loads only production dependencies (plus vite on the dev-only branch)" || bad "the built server loads a non-production package"
elif [ "${REQUIRE_BUILD:-0}" = "1" ]; then bad "dist/server.cjs is not built (REQUIRE_BUILD=1)"
else echo "SKIP ... NOT RUN  dist/server.cjs is not built: run npm run build first (npm test builds before this test)"; fi
[ "$failures" = "0" ] && { echo; echo "All dependency-layout checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
