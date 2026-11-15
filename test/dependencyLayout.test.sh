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
grep -q 'package-ecosystem: npm' "$y" && ok "dependabot watches npm" || bad "dependabot does not watch npm"
awk '/package-ecosystem: npm/{f=1} f&&/interval: weekly/{w=1} f&&/applies-to: security-updates/{s=1} f&&/patterns:/{g=1} END{exit !(w&&s&&g)}' "$y" && ok "...weekly, security updates, grouped" || bad "...weekly / security / grouped missing"
grep -q 'package-ecosystem: github-actions' "$y" && ok "...and still watches GitHub Actions" || bad "github-actions entry lost"
# every package the server bundle imports at run time is a production dependency
node -e '
const fs=require("fs"); const p=require(process.argv[1]+"/package.json"); const deps=new Set(Object.keys(p.dependencies));
const src=fs.readFileSync(process.argv[1]+"/server.ts","utf8")+fs.readdirSync(process.argv[1]+"/src").filter(f=>f.endsWith(".ts")).map(f=>fs.readFileSync(process.argv[1]+"/src/"+f,"utf8")).join("\n");
const bad=[...src.matchAll(/^import[^\n]*from\s+["\x27]([^./"\x27][^"\x27]*)["\x27]/gm)].map(m=>m[1]).filter(n=>!n.startsWith("node:")&&!["fs","path","crypto","http","https","os","url","child_process","net","util","events","stream","zlib"].includes(n)).map(n=>n.startsWith("@")?n.split("/").slice(0,2).join("/"):n.split("/")[0]).filter(n=>!deps.has(n)&&!["react","react-dom","lucide-react","motion"].includes(n));
if (bad.length) { console.log("imported but not a production dependency: "+[...new Set(bad)].join(", ")); process.exit(1); }
' "$repo" && ok "server and src/ import no package missing from dependencies (client libraries are bundled by vite)" || bad "a run-time import is not a production dependency"
[ "$failures" = "0" ] && { echo; echo "All dependency-layout checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
