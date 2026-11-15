/**
 * The model calendar: for every default model id the product queries, when it was last confirmed on the vendor's own page,
 * what was confirmed, and any published end date. Pure data and pure rules: no network, no clock (the date is passed in).
 *
 * Why: model ids end (a retired Claude default turns every observation into a failed lookup on the day) and a model's terms change
 * (the default Gemini model lost free web search with no signal, docs/INSIGHTS.md I-36). Comments in `src/providers.ts` were the only
 * record. `checkCalendar` turns "someone should re-read the page" into a failing check with the sentence naming the page.
 *
 * A confirmation is a READ of the vendor's page by a session or the owner, written here with the date and what the page said.
 * Nothing in this file is fetched by the product. The weekly workflow `.github/workflows/model-calendar.yml` runs
 * `scripts/model-calendar-check.ts` against today's date and goes red when something is due.
 */
export interface ModelCalendarEntry {
  /** The product's name for the engine (`EngineName` in src/types.ts). */
  engine: 'Gemini' | 'ChatGPT' | 'Perplexity' | 'Claude';
  /** The default model id, exactly as `src/providers.ts` sends it. */
  modelId: string;
  /** The vendor's page that was read. */
  page: string;
  /** The date (YYYY-MM-DD) the page was last read. */
  confirmedOn: string;
  /** What the page said, in one sentence, quoting where it matters. */
  confirmed: string;
  /** A published shutdown or retirement date (YYYY-MM-DD) or null when the page publishes none. */
  endDate: string | null;
  /** Free web search on the free tier: 'yes' | 'no' | 'not applicable' (paid-only engine) | 'unverified'. */
  freeSearch: 'yes' | 'no' | 'not applicable' | 'unverified';
  /** Anything the reader could not confirm. Never left out to look cleaner. */
  unverified: string;
}

export const MODEL_CALENDAR: readonly ModelCalendarEntry[] = [
  {
    engine: 'Gemini',
    modelId: 'gemini-3.6-flash',
    page: 'https://aistudio.google.com/docs/pricing',
    confirmedOn: '2026-11-15',
    confirmed: 'Listed (deprecations page: "July 21, 2026 | No shutdown date announced"). Pricing page, free tier, "Grounding with Google Search": "Not available" (footnote: can be tested in Google AI Studio); paid: 5,000 free search requests a month shared across Gemini 3 and newer models, then $14 per 1,000.',
    endDate: null,
    freeSearch: 'no',
    unverified: 'A tools-section figure of "500 RPD free" was seen in a summary of the page and not verified against the page itself; the account-level quota is visible only in the owner\'s Google console.',
  },
  {
    engine: 'Claude',
    modelId: 'claude-sonnet-5-5',
    page: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
    confirmedOn: '2026-11-15',
    confirmed: 'Status table: "claude-sonnet-5-5 | Active | N/A | Not sooner than September 28, 2027". No deprecation date. (The previous default, claude-sonnet-4-5-20250929, is Deprecated and retires 2026-11-30.)',
    endDate: null,
    freeSearch: 'not applicable',
    unverified: 'The "not sooner than" date is a tentative earliest retirement, not a published end date; it is not used as one.',
  },
  {
    engine: 'ChatGPT',
    modelId: 'gpt-5',
    page: 'https://developers.openai.com/api/docs/deprecations',
    confirmedOn: '2026-11-15',
    confirmed: '"Upcoming deprecations" table row: "Dec 11, 2026 | gpt-5, gpt-5-2025-08-07 | Deprecated | gpt-6.1-sol | Jun 11, 2026". The models page lists flagships gpt-6-astra, gpt-6.1-sol, gpt-6.1-terra and gpt-6-luna; gpt-5 was not among the cards read.',
    endDate: '2026-12-11',
    freeSearch: 'not applicable',
    unverified: 'Whether `gpt-6.1-sol` is the right replacement id for the Responses API with the web_search tool, and what it costs, was not checked. The engine is paid and switched off unless ALLOW_PAID_ENGINES=1 (docs/OWNER_DIRECTIVES.md, $0 spend), so no audit is affected until it is switched on.',
  },
  {
    engine: 'Perplexity',
    modelId: 'sonar',
    page: 'https://docs.perplexity.ai/guides/model-cards',
    confirmedOn: '2026-11-15',
    confirmed: 'Listed as "perplexity/sonar" ($0.25 input, $2.50 output per million tokens). No deprecation section on the page.',
    endDate: null,
    freeSearch: 'not applicable',
    unverified: 'The page is titled "Agent API Models" and prefixes the id; the product calls chat/completions with the bare id `sonar`. That the bare id is current for that endpoint was not confirmed on this page.',
  },
];

export const MAX_CONFIRMATION_AGE_DAYS = 90;
export const END_DATE_WARNING_DAYS = 30;

const DAY = 86_400_000;
const parse = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/** One sentence per problem; an empty list means nothing is due. `today` is YYYY-MM-DD (the caller supplies it, never the clock). */
export function checkCalendar(calendar: readonly ModelCalendarEntry[], today: string): string[] {
  const problems: string[] = [];
  const now = parse(today);
  if (!Number.isFinite(now)) return [`The date "${today}" is not YYYY-MM-DD, so the calendar could not be checked.`];
  for (const e of calendar) {
    const who = `${e.engine} default model ${e.modelId}`;
    const conf = parse(e.confirmedOn);
    if (!Number.isFinite(conf)) { problems.push(`${who}: the confirmation date "${e.confirmedOn}" is not YYYY-MM-DD.`); continue; }
    const age = Math.floor((now - conf) / DAY);
    if (age < 0) problems.push(`${who}: confirmed on ${e.confirmedOn}, which is in the future.`);
    else if (age > MAX_CONFIRMATION_AGE_DAYS) problems.push(`${who} was last confirmed ${age} days ago (${e.confirmedOn}; the limit is ${MAX_CONFIRMATION_AGE_DAYS}). Re-read ${e.page}, then update the entry in src/modelCalendar.ts with the date and what the page says.`);
    if (e.endDate !== null) {
      const end = parse(e.endDate);
      if (!Number.isFinite(end)) { problems.push(`${who}: the end date "${e.endDate}" is not YYYY-MM-DD.`); continue; }
      const left = Math.floor((end - now) / DAY);
      if (left < 0) problems.push(`${who} reached its published end date ${e.endDate} ${-left} days ago. Choose a replacement (${e.page}) and change the default in src/providers.ts.`);
      else if (left < END_DATE_WARNING_DAYS) problems.push(`${who} ends on ${e.endDate}, ${left} days from now (the warning is ${END_DATE_WARNING_DAYS} days). Read ${e.page}, choose a replacement, and change the default in src/providers.ts before then.`);
    }
  }
  return problems;
}
