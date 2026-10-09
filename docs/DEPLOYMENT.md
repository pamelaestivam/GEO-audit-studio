# Deploying the MVP

Written to be followed cold, and to be honest about what has and has not been
checked. Read section 8 before trusting any step marked **unverified**.

## 1. What you are deploying

**One always-on Node process** that serves both the API and the built frontend,
with state in a single **SQLite file on a persistent disk** (`DATA_DIR`).

Why this shape, in one paragraph: audits run in the background for 30-90
seconds and are polled. That needs a process that keeps running after it has
answered the request, and storage that survives a restart. A serverless host
(Vercel) cannot promise either (`TECH_DEBT.md` 1.4c); a free web host that
sleeps (Render free) is what made the first request of the day fail. An
always-on container with a disk is the smallest thing that is correct.

**Consequence you must accept:** exactly **one instance**. SQLite is a file on
one machine, so you cannot run two copies behind a load balancer. That is fine
for an MVP and is the first thing to change when you need more (a shared
database - `docs/MVP_AUDIT.md` item 2).

## 2. Before you start

You need:

1. **A Gemini API key** - https://aistudio.google.com/apikey. Required: it also
   writes the qualitative analysis. The free tier has per-minute and per-day
   limits; enabling billing on the key is the one lever that raises them.
2. **A decision about who gets in.** Access is by email + an **access code you
   hand out**. Invent one code per person or per group (8+ characters,
   unguessable). Anyone holding a code can sign in with any email, so treat a
   code like a password and give each person their own.
3. **A host account** - Render (steps below) or any container host.

Optional: a Perplexity API key (cheapest second engine: search is built into
its `sonar` models). Without extra keys only Gemini is measured and the product
says so everywhere.

## 3. Deploy on Render (recommended)

*(Unverified end to end - see section 8. The Blueprint uses Render's documented
fields, but nobody has run this exact file on Render yet; the first sync will
say if a field needs adjusting.)*

1. Render dashboard -> **New** -> **Blueprint** -> connect this GitHub
   repository -> branch `main`. Render reads `render.yaml`.
2. When prompted for the secrets (`sync: false` values), enter:
   - `ACCESS_CODES` - e.g. `anna-7Kx9mQ2v,ben-4Tz8pL1w` (comma-separated)
   - `GEMINI_API_KEY`
   - optionally `PERPLEXITY_API_KEY`
   `SESSION_SECRET` is generated for you.
3. Check the plan on the blueprint screen. It asks for a **paid** instance with
   a **1 GB disk**, because a persistent disk is not available on the free plan
   and a free instance sleeps. Prices are not stated here because they change -
   read Render's pricing page.
4. Create. The first build takes a few minutes. Render waits for
   `/api/health` before sending traffic.
5. **Turn off the old deployment's role**: if the owner's existing Vercel URL is
   what clients use, point them at the Render URL instead (section 6).

## 4. Deploy on any container host

```
docker build -t geo-audit-studio .
docker run -d --name geo -p 3000:3000 \
  -v geo-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ACCESS_CODES="anna-7Kx9mQ2v,ben-4Tz8pL1w" \
  -e GEMINI_API_KEY="..." \
  geo-audit-studio
```

The image defaults `DATA_DIR=/data`; **the volume is what makes audits survive**
- without `-v`, they are lost when the container is replaced. Put TLS in front
(the host's proxy, Caddy, Cloudflare); the app itself speaks plain HTTP and
trusts one proxy hop for client IPs.

CI builds this image and smoke-tests the running container on every push, so it
is checked in GitHub's environment even though it could not be built where it
was written.

## 5. Environment variables

| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | yes | Answers queries and writes the analysis |
| `SESSION_SECRET` | yes (production) | Signs sessions. 32+ characters. Rotating it signs everyone out |
| `ACCESS_CODES` | yes (production) | Comma-separated invite codes, 8+ chars each. Removing one ends the sessions it created |
| `DATA_DIR` | yes for durability | Directory for the SQLite file. Unset = nothing is saved |
| `PERPLEXITY_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | no | Adds an engine. Each multiplies per-audit spend |
| `GEMINI_MODEL` etc. | no | Override a model id without a code change |
| `USER_AUDITS_PER_DAY` | no (10) | Rolling 24h audits per person. `0` disables |
| `GLOBAL_AUDITS_PER_DAY` | no (100) | Rolling 24h audits for everyone. `0` disables |
| `MAX_CONCURRENT_AUDITS` | no (2) | Audits running at once (they share one quota) |
| `MAX_AUDIT_QUERIES` | no (8) | Queries per audit |
| `RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` | no (30 / 10) | Per-IP request limits. `0` disables |
| `SESSION_TTL_HOURS` | no (168) | Session length |

**If `SESSION_SECRET` or `ACCESS_CODES` is missing in production the server still
starts but refuses everyone, and says which variable to set** (on the sign-in
page and in `GET /api/audit/status`). It never falls open.

## 6. Verify the deployment (do not skip)

From any machine with Node 22:

```
node scripts/smoke.mjs https://YOUR-URL
node scripts/smoke.mjs https://YOUR-URL --email you@example.com --code anna-7Kx9mQ2v
```

The first form checks what a stranger sees and that protected routes refuse a
stranger. The second signs in and runs **deep readiness**, which makes **one real
Gemini call** (cached for 5 minutes) - this is what tells you the key and the
model id are actually good. Every line must say `pass`.

Then, by hand:

1. Open the URL, sign in with a code.
2. Run one default audit on a brand you know. It should take under two minutes.
   Read the numbers against what you know to be true.
3. **Reload the page.** The audit should come back, and say "Saved to your
   account". If it does not, storage is not durable - check `DATA_DIR`.
4. Redeploy or restart the service, reload, confirm the audit is still there.

If you see **"That audit is no longer available"** on a healthy audit, you are
on a host that cannot keep the process alive (see `TECH_DEBT.md` 1.4c).

## 7. Running it

- **Invite someone:** add a code to `ACCESS_CODES`, redeploy, send them the URL,
  their email and the code. **Remove someone:** delete their code and redeploy -
  their session ends on its next request.
- **Logs:** one JSON line per API request (`id`, `path`, `status`, `ms`, `user`)
  to stdout. Every response carries `X-Request-Id`, so a reported failure can be
  found. Request bodies, queries and tokens are never logged.
- **Spend control:** per-person and global daily audit limits (section 5) plus
  the concurrency cap. An audit that collected no evidence is not counted
  against anyone. Check real usage in the Gemini dashboard
  (https://aistudio.google.com/apikey) - the app cannot see your quota.
- **Backups:** everything is in `DATA_DIR/geo-audit.sqlite` (plus `-wal`/`-shm`
  while running). Copy it with `sqlite3 geo-audit.sqlite ".backup backup.sqlite"`
  or use your host's disk snapshots. Nothing in this repo schedules backups.
- **Deploys:** a deploy replaces the instance. With a single disk-backed instance
  that is a short outage, and any audit running at that moment is marked failed
  with a sentence ("The server restarted while this audit was running...") rather
  than left hanging. Saved audits are unaffected.
- **Quota exhausted:** the app tells people and stops spending (circuit breaker,
  `TECH_DEBT.md` 2.3a). A restart clears its memory of the failure, not the
  provider's limit.

## 8. What has and has not been verified

**Verified by running it** (`npm test`, 600+ checks, run in CI on every push):
sign-in and its refusals; every spending route needing a session; ownership
between users; audits and jobs surviving a restart, including a SIGKILL mid-
audit; daily budgets; unconfigured production refusing everyone; the compiled
backend not being downloadable; the smoke script passing a good deployment and
failing a bad one; the full UI in a real browser (desktop and phone); the
server running from a clean directory with only production dependencies.

**Not verified - do these yourself, they cannot be checked from the authoring
environment:**

- **Anything against a real answer engine.** No provider API key was available
  where this was built, so every end-to-end run used a fake Gemini that speaks
  the real response format. The **only** contact with Google's real API was one
  request with a deliberately invalid key, which returned the expected
  "rejected the API key" answer. Real answer quality, real quota behaviour, and
  whether `gemini-3.6-flash` exists for your key are unverified until you run
  readiness with a real key (section 6).
- **The ChatGPT, Perplexity and Claude adapters** have never seen a live
  response (`TECH_DEBT.md` 2.8). Enable one, run an audit, and read the evidence
  before relying on it.
- **`render.yaml` on Render**, and the **Dockerfile** until CI has run it once
  (CI builds it on GitHub's runners).
- **Prices, free-tier limits and Render plan names** - they change; check the
  providers' pages.

## 9. What this deployment does not do yet

Tracked in `docs/MVP_AUDIT.md`: more than one instance; a real user database,
Google sign-in or password reset; scheduled re-audits and alerts (the Monitoring
tab is an honest preview); a forwardable PDF; a legal/terms page; automated
backups.

## 10. Why not Chrome's "AI Mode" for unlimited free answers?

Considered, not built. It has no API, so it would mean automating a browser
against google.com; Google's terms restrict automated querying of Search (read
them before relying on it), the page is personalised and location-dependent so
results would not be reproducible, and bot defences make it fragile. This
product's promise is evidence a client can defend, which a scraped, unrepeatable
answer is not. It also could not be tried here: this sandbox's network policy
blocks `www.google.com` and `gemini.google.com`. If Gemini's limits are the
problem, the real levers are: enable billing on the key (the paid per-request
cost is small), add Perplexity as a second engine, and keep audits to three
queries (the default).
