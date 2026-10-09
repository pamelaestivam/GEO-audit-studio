# Using GEO Audit Studio

For the person running audits. (Setting the service up: `docs/DEPLOYMENT.md`.)

## What it tells you, and what it does not

It asks AI answer engines real buyer questions - "What are the best alternatives
to X?" - captures the **verbatim answers and the sources they cite**, and counts
how often your brand is named, where, and who is named instead. The counting is
plain code, not a model's opinion, so the same answers always give the same
numbers.

It does **not** tell you why an engine said what it said, predict traffic, or
measure whether a fix works. The inaccuracy, omission and remediation sections
are a model's reading of the evidence: useful leads, not measurements.

Only engines with a key configured are queried. If you only see Gemini, that is
the only engine that was asked - the product never fills in the others.

## 1. Sign in

Enter the email you were invited with and the **access code** you were given.
Sessions last seven days. If your code is withdrawn you are signed out with a
message saying so.

**Privacy:** your saved audits are private to you and your code. Anyone who
holds *the same code* can sign in under any email and see audits saved under that
code - so if your audits must stay private from a colleague, ask for your own
code. The person running the service can read everything stored.

## 2. Run an audit

On the first screen:

- **Business, brand name, or website** - required. Type the name people use.
- **Website domain** - recommended. It lets the audit tell when *your own site*
  is cited as a source, and helps match shorthand references to your brand.
- **Industry** - optional. With it, the first standard question becomes a
  **brand-neutral discovery question** ("What are the best *poke restaurants*?")
  - the question that actually tests whether buyers who don't know you are
  pointed to you. Leave it blank rather than guess; without it (and without a
  competitor) every standard question has to name your brand.
- **Known competitors** - optional, comma-separated. Anyone you list is always
  scored. Rivals the engines name that you did not list are discovered
  separately and shown on their own.
- **Your own search queries** - optional, **one question per line**. This is the
  most important field: *write the questions your customers actually type.*
  - Blank: three standard questions are built from the details above. They are
    generic - fine for a first look, weak for a real client.
  - Filled: **only your questions are run** (up to eight).

Click **Run Live GEO Search Audit**. It takes roughly 30-90 seconds; the screen
shows which query it is on. Keep the tab open: the audit keeps running on the server if you
close it, but only a deployment with storage will have kept the result for you to
find later in your saved audits.

Optional helpers (each is a deliberate click, never automatic, because each
spends a request of a shared quota):

- **Auto-Detect from URL** looks up the business's industry and competitors. It
  only fills fields you left blank - it never overwrites what you typed.
- **Run New Audit** (top bar) is a three-step version that can ask the model to
  suggest queries. It tells you whether the model wrote them or they are the
  standard set.
- The example-brand buttons only fill the form.

## 3. Read the result

**The top card**

| What you see | What it means |
|---|---|
| **GEO Visibility Index** `100 / 100` and *"Named in 3 of 3 answers (Gemini)"* | The share of captured answers that name your brand. The sentence under it is the arithmetic. |
| *"Only 3 answers: indicative, not a stable rate"* | Under five answers, a percentage is a handful of data points. Add queries before quoting it. |
| *"All 3 questions name your brand..."* | **Read this before quoting a 100.** If you ask an engine "How much does *X* cost?", it answers about X whatever it thinks of X - so a high score is near-guaranteed. That measures reputation, not discovery. Add a question that does not name you ("best poke in Austin"). |
| **Share of Voice** | Of every brand mention across all the answers, the part that is yours. Needs rivals to mean anything. |
| **#1 Recommendation Rate** | The share of answers that name you *first*. |
| **Fact Accuracy Rate** | Mentions where the model found nothing wrong. **A model's judgement without a fact sheet** - indicative only. |
| **Rivals the engines named that you did not list** | Vendors found in the answers (bold, list or table entries, or named twice). A vendor named once in plain prose may be missed - add it as a competitor. |

**Banners you may see - and what to do**

- **"Audit incomplete - the figures below are not measurements."** The engines
  could not be queried (key rejected, quota used up, network). Every number is
  shown as **—**, not zero. Read the reason and re-run; it was not counted
  against your daily allowance.
- **"Qualitative analysis unavailable."** The answers were captured and the
  visibility numbers are real, but the inaccuracy / omission / remediation
  analysis failed. Those sections say **Not assessed** - they are not "none
  found". Re-run.
- **"Not saved."** This deployment does not keep audits (no storage configured).
  Export before you leave.
- **"N attempted answers failed and are not counted."** Some queries failed; the
  rest are what the numbers are based on.

**The modules (left side; on a phone, the list above the report)**

- **Query Intent Matrix** - each question, and where you ranked per engine.
  **Click a row** to see each engine's result and **"Show the full answer as
  captured"**: the engine's exact words, when they were captured, and the
  searches it ran. This is the evidence behind every number - if a figure looks
  wrong, check it here first.
- **Citation Source Map** - the websites the engines leaned on. If your own domain
  is never cited, the high-count third-party sites are where to earn a mention.
- **Competitor Intelligence** - share of voice per brand, and the sources cited
  in the answers that named *that* brand.
- **Inaccuracies, Omissions, Remediation** - the model's reading. Tick remediation
  tasks to track your own progress; ticking does **not** change any score.
- **Continuous Sweeps** - a preview of scheduled re-audits. **Nothing is
  scheduled yet.**

## 4. Add a query to an existing audit

In the Query Intent Matrix, type a question and **Add & Audit Query**. It is run
against the same engines and appears in the table with its own result. It does
**not** change the headline figures (the card says how many queries are outside
them) - run a new audit to include it.

## 5. Keep, share, delete

- **Saved audits** reappear after a reload or a new sign-in (when the deployment
  has storage; each audit says whether it was saved). Switch between them with
  the dropdown in the top bar.
- **Export Audit** opens a printable report: **Print / Save PDF**, or **Copy
  Summary** as text. Caveats (incomplete audit, small sample) travel with the
  numbers.
- **Delete this audit** on the card removes it from storage permanently.

## 6. Limits you may hit

| Message | Meaning |
|---|---|
| "Answer engine temporarily unavailable" | The shared quota is known to be used up. The message says when it resets; wait, or the operator can enable billing on the key. |
| "You have used your N audits for the last 24 hours" | Your daily allowance. It says when the next one frees up. |
| "This service is already running N audits" | Audits share one quota; try again in a minute or two. |
| "You are sending audit requests faster than this service allows" | Slow down for the stated seconds. |
| "Your session has expired" / "Your access has been withdrawn" | Sign in again / ask whoever invited you. |

## 7. Getting numbers you can trust

1. **Use at least five queries, and write them yourself.** One answer is an
   anecdote. AI answers also vary run to run; if a result matters, run it twice.
2. **List your two or three real competitors.** Share of voice against nobody is
   not informative.
3. **Read the evidence for anything you will quote.** Open the full answer.
4. **Treat "not measured", "—" and "Not assessed" as exactly that** - they are
   never silent zeros.
5. **Re-run after you change something**, then compare - but the product does not
   chart history yet; keep exports.
