# GEO Audit Studio

Measures how a business actually appears in AI answer engines. It asks the
engines real buyer questions, captures their verbatim answers and cited
sources, and computes visibility, share of voice and who is named first in
plain code. Only engines with a configured key are queried; a missing key
means "not measured", never a simulation.

**Status: early access.** Audits are not saved (refresh loses them), sign-in is
a placeholder, and server state is in memory. See `docs/MVP_AUDIT.md` for what
that means in practice and the roadmap to fix it.

## Run locally

Prerequisites: Node 22.

```
npm install
cp .env.example .env.local     # set GEMINI_API_KEY
npm run dev                    # http://localhost:3000
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Express on port 3000 (`PORT` respected) |
| `npm run build` | client bundle + `dist/server.cjs` |
| `npm start` | run the built server (one process serves API and frontend) |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | build, then every unit, end-to-end and contract check |

`npm test` is the merge gate and also runs in CI on every pull request.
End-to-end suites start the real built server against a local fake Gemini
endpoint and count real HTTP calls - see `CLAUDE.md` for how they are used.

## Deploying

The server is a single Express app that holds in-memory state (audit jobs,
quota breaker, idempotency keys). It therefore needs **one long-running
process** - `npm start` on an always-on host. Serverless hosts can answer the
API (`api/index.ts` exists for Vercel) but do not fit the background-job design;
see `TECH_DEBT.md` 1.4c before relying on it.

Check a deployment with `GET /api/health` (liveness) and `GET
/api/audit/status` (which engines are configured, and whether the quota is
known to be exhausted).

## Project notes

- `CLAUDE.md` - how work is done here and the rules the product must not break
- `TECH_DEBT.md` - known debt, open actions awaiting the owner
- `docs/MVP_AUDIT.md` - latest audit, 20-item roadmap, open decisions
- `docs/PRD.md`, `docs/DECISIONS.md`, `docs/TEAM_CHARTER.md`, `docs/EVAL_PM.md`
