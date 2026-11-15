/**
 * Property-based tests for src/analysis.ts (item G2.7 of docs/ENGINEERING_BACKLOG.md; design note in docs/DESIGN_NOTES_ENGINEERING_2026-11.md).
 * The analysis is pure and carries every headline number, so its LAWS are stated here and attacked with generated inputs: unicode,
 * punctuation, empty text, brand names that are substrings of each other, answers that cite a brand's site without naming it.
 *
 * The generator is seeded and plain TypeScript (no library). Every failure prints the seed and the failing case; pass the seed back to
 * replay it:  PROP_SEED=12345 npx tsx test/properties.test.ts   (PROP_RUNS=n sets the cases per law; default 400).
 */
import { analyseAnswer, buildBrandMatcher, buildScorecards, type BrandMatcher, type BrandQueryResult, type QueryEvidence } from '../src/analysis.ts';

const SEED = Number(process.env.PROP_SEED) || (Math.floor(Math.random() * 2 ** 31) >>> 0);
const RUNS = Number(process.env.PROP_RUNS) || 400;
let failures = 0;

// ---- a seeded generator (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: R, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)];
const NAME_WORDS = ['Poke', 'Bowl', 'Café', 'Zoë', 'Nørd', 'Ōkami', "O'Brien", 'Fish', 'Fresh', 'Green', 'Blue', 'Sweet', 'Tree', 'Noodle', 'Bar', 'Co', '42', 'X', 'Ünal', 'Müller', 'Crème'];
const FILLER = ['The best options are', 'Many people prefer', 'According to reviews,', 'You could also try', 'However,', 'Prices vary.', 'Open late.', '**Key takeaways:**', '- ', '| Vendor | Rating |', '😀', 'é', '...', '(see below)', '—'];
const DOMAINS = ['example.com', 'poke.example', 'bowl.example.org', 'cafe.example'];

function genName(r: R): string {
  const n = int(r, 1, 3); const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(pick(r, NAME_WORDS));
  return parts.join(' ');
}
function genMatchers(r: R): BrandMatcher[] {
  const n = int(r, 1, 5); const out: BrandMatcher[] = []; const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    let name = genName(r); if (r() < 0.25 && out.length) name = `${out[0].label} ${pick(r, NAME_WORDS)}`; // a name that contains another
    if (seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
    out.push(buildBrandMatcher(name, r() < 0.5 ? pick(r, DOMAINS) : undefined));
  }
  return out;
}
function genText(r: R, names: string[]): string {
  const n = int(r, 0, 12); const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(r() < 0.35 && names.length ? pick(r, names) : pick(r, FILLER));
  return parts.join(r() < 0.5 ? ' ' : '\n');
}
function genEvidence(r: R, matchers: BrandMatcher[], i: number): QueryEvidence {
  const names = matchers.map((m) => m.label);
  const cites = Array.from({ length: int(r, 0, 3) }, () => { const d = pick(r, DOMAINS); return { url: `https://www.${d}/page`, title: 't', domain: d }; });
  return { queryId: `q${i}`, queryText: `question ${i}`, answerText: genText(r, names), citations: cites, searchQueries: [], capturedAt: '2026-11-15T00:00:00Z', engine: 'Gemini' };
}
function scenario(r: R) {
  const matchers = genMatchers(r); const n = int(r, 0, 8);
  const evidence = Array.from({ length: n }, (_, i) => genEvidence(r, matchers, i));
  const perQuery = evidence.map((e) => analyseAnswer(e, matchers));
  return { matchers, evidence, perQuery };
}

// ---- the property runner
function property(name: string, law: (s: ReturnType<typeof scenario>, r: R) => string | null) {
  let bad: { seed: number; why: string; sc: unknown } | null = null;
  for (let i = 0; i < RUNS && !bad; i++) {
    const caseSeed = (SEED + i * 7919) >>> 0; const r = rng(caseSeed); const sc = scenario(r);
    let why: string | null = null;
    try { why = law(sc, r); } catch (e) { why = `threw: ${(e as Error).message}`; }
    if (why) bad = { seed: caseSeed, why, sc };
  }
  if (!bad) { console.log(`pass  ${name}`); return; }
  failures++;
  console.log(`FAIL  ${name}\n        ${bad.why}\n        replay: PROP_SEED=${bad.seed} PROP_RUNS=1 npx tsx test/properties.test.ts   (run seed ${SEED})\n        case: ${JSON.stringify({ matchers: (bad.sc as any).matchers.map((m: BrandMatcher) => m.label), texts: (bad.sc as any).evidence.map((e: QueryEvidence) => e.answerText) }).slice(0, 1200)}`);
}
const sameCards = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- the laws
property('LAW visibility, share, leader share and prominence stay inside their ranges, and counts never exceed the queries', ({ matchers, perQuery }) => {
  for (const c of buildScorecards(perQuery, matchers)) {
    if (c.visibility < 0 || c.visibility > 100 || c.shareOfVoice < 0 || c.shareOfVoice > 100 || c.leaderShare < 0 || c.leaderShare > 100 || c.avgProminence < 0 || c.avgProminence > 100) return `out of range: ${JSON.stringify(c)}`;
    if (c.timesMentioned > perQuery.length || c.timesFirst > c.timesMentioned || c.citedOnlyCount > c.citedAsSourceCount) return `counts inconsistent: ${JSON.stringify(c)}`;
    if (c.leaderShare > c.visibility) return `leaderShare above visibility: ${JSON.stringify(c)}`;
  }
  return null;
});
property('LAW share of voice across brands never exceeds 100 plus rounding, and is 0 for everyone when nobody is mentioned', ({ matchers, perQuery }) => {
  const cards = buildScorecards(perQuery, matchers);
  const sum = cards.reduce((n, c) => n + c.shareOfVoice, 0);
  if (sum > 100 + cards.length) return `shares add to ${sum}`;
  if (cards.every((c) => c.timesMentioned === 0) && sum !== 0) return `nobody mentioned but shares add to ${sum}`;
  return null;
});
property('LAW a brand named in no answer is never mentioned, ranked or visible (a name that appears nowhere cannot be found)', ({ matchers, evidence }) => {
  const ghost = buildBrandMatcher('Zzyzx Qwertyuiop Xylophone', 'zzyzx-nowhere.example');
  for (const e of evidence) { const [g] = analyseAnswer(e, [ghost]); if (g.mentioned || g.rank !== null || g.firstMentionIndex !== -1 || g.prominence !== 0) return `ghost found in "${e.answerText}": ${JSON.stringify(g)}`; }
  void matchers; return null;
});
property('LAW within one answer, ranks of the mentioned brands are 1..k in order of first appearance; the others have none', ({ matchers, evidence }) => {
  for (const e of evidence) {
    const res = analyseAnswer(e, matchers); const mentioned = res.filter((x) => x.mentioned).sort((a, b) => a.firstMentionIndex - b.firstMentionIndex);
    if (mentioned.some((x, i) => x.rank !== i + 1)) return `ranks ${mentioned.map((x) => x.rank)} for "${e.answerText}"`;
    if (res.some((x) => !x.mentioned && x.rank !== null)) return 'an unmentioned brand has a rank';
  }
  return null;
});
property('LAW exactly one brand is first in every answer that names any brand, so the "times first" add up to the answers that name one', ({ matchers, perQuery }) => {
  const cards = buildScorecards(perQuery, matchers);
  const answersNamingOne = perQuery.filter((rs) => rs.some((r) => r.mentioned)).length;
  const firsts = cards.reduce((n, c) => n + c.timesFirst, 0);
  return firsts === answersNamingOne ? null : `${firsts} firsts for ${answersNamingOne} answers that name a brand`;
});
property('LAW cited-only means the site was cited and the name was not (never both), and prominence is 0 exactly when not mentioned', ({ perQuery }) => {
  for (const results of perQuery) for (const r of results) {
    if (r.citedOnly && (r.mentioned || !r.citedAsSource)) return `citedOnly inconsistent: ${JSON.stringify(r)}`;
    if (r.mentioned && r.citedOnly) return 'mentioned and cited-only at once';
    if ((r.prominence === 0) === r.mentioned) return `prominence ${r.prominence} with mentioned=${r.mentioned}`;
    if (r.prominence > 100) return `prominence ${r.prominence}`;
  }
  return null;
});
property('LAW the order of the queries changes no scorecard', ({ matchers, perQuery }, r) => {
  const shuffled = [...perQuery].sort(() => r() - 0.5);
  return sameCards(buildScorecards(perQuery, matchers), buildScorecards(shuffled, matchers)) ? null : 'a reordering changed a scorecard';
});
property('LAW the order of the brands changes no brand\'s own result within an answer, except the rank of brands whose first mention starts at the SAME place (a tie)', ({ matchers, evidence }) => {
  const reversed = [...matchers].reverse();
  for (const e of evidence) {
    const a = analyseAnswer(e, matchers), b = analyseAnswer(e, reversed);
    for (const x of a) {
      const y = b.find((z) => z.brand === x.brand);
      if (!y || y.mentioned !== x.mentioned || y.citedOnly !== x.citedOnly || y.prominence !== x.prominence || y.firstMentionIndex !== x.firstMentionIndex) return `brand order changed the result for ${x.brand}`;
      const tied = x.mentioned && a.some((o) => o !== x && o.mentioned && o.firstMentionIndex === x.firstMentionIndex);
      if (!tied && y.rank !== x.rank) return `brand order changed the rank of ${x.brand} although no other brand starts at the same place`;
    }
  }
  return null;
});
// What a tie does today (documented, not endorsed): brands whose first mention starts at the same place get consecutive ranks in the order the
// brands were listed, so which of two overlapping names (for example "Cafe" and "Cafe Cafe") ranks first depends on the list order. TECH_DEBT.md 2.25.
property('LAW (current behaviour) brands tied at the same first-mention place still get distinct consecutive ranks', ({ matchers, evidence }) => {
  for (const e of evidence) {
    const res = analyseAnswer(e, matchers).filter((x) => x.mentioned);
    const ranks = res.map((x) => x.rank as number).sort((p, q) => p - q);
    if (ranks.some((rk, i) => rk !== i + 1)) return `ranks ${ranks} are not 1..${ranks.length}`;
  }
  return null;
});
property('LAW appending an answer that is empty (a failed look-up carries no text and no citations) never changes a numerator', ({ matchers, evidence, perQuery }) => {
  const failed: QueryEvidence = { queryId: 'failed', queryText: 'failed', answerText: '', citations: [], searchQueries: [], capturedAt: '2026-11-15T00:00:00Z', engine: 'Gemini', error: 'The engine did not answer.' };
  const before = buildScorecards(perQuery, matchers), after = buildScorecards([...perQuery, analyseAnswer(failed, matchers)], matchers);
  for (let i = 0; i < before.length; i++) if (before[i].timesMentioned !== after[i].timesMentioned || before[i].timesFirst !== after[i].timesFirst || before[i].citedAsSourceCount !== after[i].citedAsSourceCount || before[i].citedOnlyCount !== after[i].citedOnlyCount) return `a numerator moved for ${before[i].brand}`;
  void evidence; return null;
});
property('LAW the same answer written with composed or decomposed accents gives the same result (NFC and NFD)', ({ matchers, evidence }) => {
  for (const e of evidence) {
    const nfd = { ...e, answerText: e.answerText.normalize('NFD') };
    const a = analyseAnswer(e, matchers).map((x) => [x.brand, x.mentioned, x.rank, x.citedOnly]), b = analyseAnswer(nfd, matchers).map((x) => [x.brand, x.mentioned, x.rank, x.citedOnly]);
    if (!sameCards(a, b)) return `NFD differs from NFC for "${e.answerText}"`;
  }
  return null;
});
property('LAW the analysis is deterministic: the same evidence twice gives the same scorecards', ({ matchers, evidence }) => {
  const a = buildScorecards(evidence.map((e) => analyseAnswer(e, matchers)), matchers), b = buildScorecards(evidence.map((e) => analyseAnswer(e, matchers)), matchers);
  return sameCards(a, b) ? null : 'two runs differ';
});
property('LAW no query at all gives zeros, never NaN or a thrown error', ({ matchers }) => {
  for (const c of buildScorecards([], matchers)) if ([c.visibility, c.shareOfVoice, c.leaderShare, c.avgProminence].some((v) => v !== 0 || Number.isNaN(v))) return `non-zero or NaN on no queries: ${JSON.stringify(c)}`;
  return null;
});

// ---- the checker itself must be able to fail: a deliberately false law is caught, with its seed in the report
{
  const before = failures; const log = console.log; const lines: string[] = []; console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  property('(self-check) a false law: every brand is always mentioned', ({ perQuery }) => (perQuery.some((rs) => rs.some((r: BrandQueryResult) => !r.mentioned)) ? 'found one that is not' : null));
  console.log = log;
  const caught = failures === before + 1 && /replay: PROP_SEED=\d+/.test(lines.join('\n'));
  failures = before; // the self-check's failure is expected and does not count
  console.log(`${caught ? 'pass' : 'FAIL'}  the property runner catches a false law and prints a seed that replays it`); if (!caught) failures++;
}
{
  const r = rng(12345), r2 = rng(12345);
  const same = Array.from({ length: 5 }, () => r()).join() === Array.from({ length: 5 }, () => r2()).join();
  console.log(`${same ? 'pass' : 'FAIL'}  the same seed gives the same cases (replay works)`); if (!same) failures++;
}

console.log(failures === 0 ? `\nAll property checks passed (${RUNS} cases per law, seed ${SEED}).` : `\n${failures} property check(s) failed (run seed ${SEED}).`);
process.exit(failures === 0 ? 0 : 1);
