# GEO Audit Studio

Measures how a business actually appears in AI answer engines. It asks the
engines real buyer questions, captures their verbatim answers and cited
sources, and computes visibility, share of voice and who is named first in
plain code. Only engines with a configured key are queried; a missing key
means "not measured", never a simulation.

**Status: early access (MVP).** Sign-in is by invitation (email + an access
code you hand out), audits are saved to SQLite on a persistent disk, and
everything is built for **one always-on instance**. See `docs/DEPLOYMENT.md` to
deploy it, `docs/USER_GUIDE.md` to use it, and `docs/MVP_AUDIT.md` for what is
still missing.

## Run locally

Prerequisites: Node 22.13 or newer (the built-in `node:sqlite` is used for storage).

```
npm install
cp .env.example .env.local     # set GEMINI_API_KEY
npm run dev                    # http://localhost:3000 - sign in with any email and the code "dev-access"
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Express on port 3000 (`PORT` respected) |
| `npm run build` | client bundle + `dist/server.cjs` |
| `npm start` | run the built server (one process serves API and frontend) |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | build, then every unit, end-to-end, browser and contract check |
| `npm run verify` | lint + test + dependency audit (what CI runs) |
| `npm run smoke -- <url>` | post-deploy check of a running instance |

`npm test` is the merge gate and also runs in CI on every pull request.
End-to-end suites start the real built server against a local fake Gemini
endpoint and count real HTTP calls - see `CLAUDE.md` for how they are used.

## Deploying

One long-running process serving the API and the built frontend, with its
SQLite database on a persistent disk (`DATA_DIR`). A `Dockerfile` and a Render
`render.yaml` are included. **Exactly one instance** - SQLite is a file on one
machine. Serverless hosts (Vercel) cannot keep the background audit job alive
and are not supported for real use (`TECH_DEBT.md` 1.4c).

Production refuses everyone until `SESSION_SECRET` and `ACCESS_CODES` are set
(and says which). After deploying, check it:

```
node scripts/smoke.mjs https://YOUR-URL --email you@example.com --code YOUR_CODE
```

Full steps, environment variables, operations and an honest list of what has not
been verified: `docs/DEPLOYMENT.md`.

## Project notes

- `CLAUDE.md` - how work is done here and the rules the product must not break
- `TECH_DEBT.md` - known debt, open actions awaiting the owner
- `docs/MVP_AUDIT.md` - latest audit, 20-item roadmap, open decisions
- `docs/PRD.md`, `docs/DECISIONS.md`, `docs/TEAM_CHARTER.md`, `docs/EVAL_PM.md`
