# Deploying the MVP

Written to be followed cold, and to be honest about what has and has not been
checked. Read section 8 before trusting any step marked **unverified**.

## 1. What you are deploying

> **Superseded in part, 2026-10-10 (`docs/DECISIONS.md`, decision F):** the owner
> directed that the product run on Vercel with Supabase as the durable store and
> step-wise audit jobs. That is **not built yet**; until it is, this document describes
> the only deployment shape that is correct today (an always-on process with a disk),
> and the Vercel deployment is a preview whose audits can be lost (`docs/PROGRAM.md`).

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
   hand out**, written as `label=code` pairs in `ACCESS_CODES`, e.g.
   `anna=7Kx9mQ2vLp,ben=4Tz8pL1wQa` (8+ characters, no `,` inside a code; the first `=` separates the label from the code, so a labelled code may itself contain `=`).
   **How privacy works - read this:** saved audits belong to the pair
   *(label, email)*. Two people on different codes cannot see each other's audits
   even if one types the other's email. But **anyone holding a code can sign in
   with any email *under that code*** and so see audits saved by others on the
   same code. Give each person who needs private audits their **own** code.
   Rotating a code (same label, new code) signs that person out but keeps their
   audits; deleting the pair ends their access.
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
   - `ACCESS_CODES` - e.g. `anna=7Kx9mQ2vLp,ben=4Tz8pL1wQa`
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
  -e ACCESS_CODES="anna=7Kx9mQ2vLp,ben=4Tz8pL1wQa" \
  -e GEMINI_API_KEY="..." \
  geo-audit-studio
```

Add `-e TRUST_PROXY=1` **only** if a reverse proxy (the thing that terminates TLS)
sits in front of the container; leave it out when the container is exposed
directly (see the variable table - getting this wrong either lets visitors dodge
the per-IP limits or throttles everyone together).

The image defaults `DATA_DIR=/data`; **the volume is what makes audits survive**
- without `-v`, they are lost when the container is replaced. Put TLS in front
(the host's proxy, Caddy, Cloudflare); the app itself speaks plain HTTP and
trusts NO proxy for client IPs unless you set `TRUST_PROXY` (the image does not).

The `docker` workflow (`.github/workflows/docker.yml`; it runs when the image files change, weekly and on demand, and is not a merge gate) builds this image, runs it with a volume, smoke-tests it, restarts it on the
same volume and smoke-tests again. The Dockerfile could not be built where it
was written (Docker CLI present, no daemon), so its only evidence is that workflow (it is informational, not a merge gate, so a change can merge before it has run):
it built and passed on GitHub's runner for this repository, including the
restart on the same volume. That is a build-and-smoke check against a fake
Gemini endpoint, not a test of your host - run `scripts/smoke.mjs` against your
own deployment (section 6).

## 5. Environment variables

| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | yes | Answers queries and writes the analysis |
| `SESSION_SECRET` | yes (production) | Signs sessions. 32+ characters. Rotating it signs everyone out |
| `ACCESS_CODES` | yes (production) | `label=code` pairs, comma-separated; 8+ chars per code. Removing one ends the sessions it created |
| `TRUST_PROXY` | no (0) | Reverse proxies in front of the server (1 on Render/Fly/nginx). **Leave at 0 when exposed directly**: otherwise anyone can send their own `X-Forwarded-For` and dodge every per-IP limit. Too low behind a proxy = all visitors throttled together (safe, but wrong) |
| `USER_LOOKUPS_PER_HOUR` | no (30) | Brand detection, query suggestions and added queries per person per hour (per process; resets on restart) |
| `ALLOW_DEV_AUTH` | no | Local development only: `npm run dev` passes `--dev`, which has the same effect. Never honoured in production, and only from the same machine. Do not set it on a server behind a local reverse proxy without `TRUST_PROXY` (every request would look local) |
| `JOB_MAX_RUN_MS` | no (900000) | An audit still running after this long is reported as stopped (it is recorded if it later finishes) |
| `DATA_DIR` | yes for durability | Directory for the SQLite file. Unset = nothing is saved |
| `PERPLEXITY_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | no | Adds an engine. Each multiplies per-audit spend |
| `GEMINI_MODEL` etc. | no | Override a model id without a code change |
| `USER_AUDITS_PER_DAY` | no (10) | Rolling 24h audits **per access code**. People sharing a code share this allowance; changing the email does not reset it. `0` disables |
| `GLOBAL_AUDITS_PER_DAY` | no (100) | Rolling 24h audits for everyone. `0` disables |
| `MAX_CONCURRENT_AUDITS` | no (2) | Audits running at once (they share one quota) |
| `MAX_AUDIT_QUERIES` | no (8) | Queries per audit |
| `RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` | no (30 / 10) | Per-IP request limits. `0` disables |
| `SESSION_TTL_HOURS` | no (168) | Session length |

**If `SESSION_SECRET` or `ACCESS_CODES` is missing the server still starts but
refuses everyone, and says which variable to set** (on the sign-in page and in
`GET /api/audit/status`). It never falls open - including on a plain
`npm start` with `NODE_ENV` unset (the built server defaults to production) and
with `ALLOW_DEV_AUTH=1` set (ignored in production).

## 6. Verify the deployment (do not skip)

From any machine with Node 22:

```
node scripts/smoke.mjs https://YOUR-URL
node scripts/smoke.mjs https://YOUR-URL --email you@example.com --code 7Kx9mQ2vLp
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

- **Invite someone:** add a `label=code` pair to `ACCESS_CODES`, redeploy, send
  them the URL, their email and the code. **Remove someone:** delete their pair
  and redeploy - their session ends on its next request (their saved audits stay
  in the database, inaccessible, until you remove them).
- **Logs:** one JSON line per API request (`id`, `path`, `status`, `ms`, `user`)
  to stdout. Every response carries `X-Request-Id`, so a reported failure can be
  found. Request bodies, queries and tokens are never logged.
- **Spend control:** per-person and global *daily audit* limits and a
  concurrency cap (all stored, so they survive restarts), plus a per-person
  *hourly lookup* limit and per-IP request limits (in memory, so they reset on
  restart). An audit that collected no evidence, or was cut off by a restart or
  deploy, is not counted against anyone. **There is no spend limit on your
  Gemini key itself** - set one in Google's console, and check real usage there
  (https://aistudio.google.com/apikey); the app cannot see your quota.
- **Security you should know about:** the session token is kept in the browser's
  `localStorage` (so a script injected into the page could read it) and the app
  sets no `Content-Security-Policy` yet. Sessions expire (7 days by default) and
  end when their code is removed.
- **Backups:** the database runs in WAL mode, so a running server's recent writes
  live in `geo-audit.sqlite-wal`, not in `geo-audit.sqlite`. **Copying only
  `geo-audit.sqlite` restores an empty or stale database** (measured: one audit,
  a 4 KB main file, 119 KB in the WAL, nothing visible after restoring the main
  file alone). Take a snapshot with `node scripts/backup.mjs` (inside the
  container: `docker exec <container> node scripts/backup.mjs`, which names the file
  `DATA_DIR/backups/geo-audit-<timestamp>.sqlite`; a fixed output name works once and
  then refuses to overwrite, so for cron leave the name off or add a date), which
  writes one self-contained, integrity-checked file, never overwrites or deletes an
  existing backup, and is safe while the server runs. Nothing prunes
  `DATA_DIR/backups`: delete old snapshots yourself, and copy them off the host; or use disk snapshots of the whole `DATA_DIR`. To restore: stop the
  server, put the snapshot at `DATA_DIR/geo-audit.sqlite`, delete any `-wal` and
  `-shm` beside it, start. Nothing in this repo schedules backups or copies them
  off the host: run the script from your host's cron and copy the file elsewhere.
- **Deploys:** a deploy replaces the instance. With a single disk-backed instance
  that is a short outage, and any audit running at that moment is marked failed
  with a sentence ("The server restarted while this audit was running...") rather
  than left hanging. Saved audits are unaffected.
- **Quota exhausted:** the app tells people and stops spending (circuit breaker,
  `TECH_DEBT.md` 2.3a). A restart clears its memory of the failure, not the
  provider's limit.

## 8. What has and has not been verified

**Verified by running it** (`npm test`, 850+ checks; CI runs it on every push):
sign-in and its refusals; every spending route needing a session; ownership
between users and between codes; audits and jobs surviving a restart, including
a SIGKILL mid-audit; daily and hourly budgets; per-IP limits not being
spoofable **when `TRUST_PROXY` matches the real number of proxies**; unconfigured production (and `NODE_ENV` unset) refusing everyone; the
compiled backend not being downloadable; the smoke script passing a good
deployment and failing a bad one; the full UI in a real browser (desktop and
phone, including a returning user with a long brand name); `npm run dev` reading
`.env.local` (checked by hand); and - by `scripts/prod-install-check.sh` - the
built server running from a clean directory with only production dependencies.
Each new test was shown to go red when its fix is reverted, in rounds of
mutation runs (round 1: 5 reverts, 12 red; round 2 and its review: 5 + 6 reverts,
24 red) - with two honest exceptions at the time of the first review, since
closed: the late-completion fix and the dev-sign-in loopback guard now have tests
of their own.

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
- **`render.yaml` on Render**, and the **Dockerfile on your own host** (CI built
  and smoke-tested it on GitHub's runner only).
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
