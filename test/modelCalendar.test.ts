/**
 * The model calendar (item G1.9 of docs/ENGINEERING_BACKLOG.md): the RULE is tested here with fixed dates, and the DATA is tested for
 * agreeing with src/providers.ts. Whether today's date finds something due is NOT a merge-blocking test (it would turn every pull
 * request red the day a vendor publishes a date): scripts/model-calendar-check.ts does that, weekly, in .github/workflows/model-calendar.yml.
 */
import { MODEL_CALENDAR, calendarNotes, checkCalendar, isCalendarDate, type ModelCalendarEntry } from '../src/modelCalendar.ts';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PERPLEXITY_MODEL } from '../src/providers.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
const e = (over: Partial<ModelCalendarEntry> = {}): ModelCalendarEntry => ({ engine: 'Gemini', modelId: 'm-1', page: 'https://example.test/p', confirmedOn: '2026-11-01', confirmed: 'x', endDate: null, freeSearch: 'no', unverified: 'none', inUse: true, ...over });

// the rule, on fixed dates
check('a recent confirmation and no end date: nothing is due', checkCalendar([e()], '2026-11-15').length === 0);
check('a confirmation exactly 90 days old is still fine', checkCalendar([e({ confirmedOn: '2026-08-17' })], '2026-11-15').length === 0);
const stale = checkCalendar([e({ confirmedOn: '2026-08-16' })], '2026-11-15');
check('91 days old is due, and the sentence names the page to re-read and the file to update', stale.length === 1 && /91 days ago/.test(stale[0]) && /https:\/\/example\.test\/p/.test(stale[0]) && /src\/modelCalendar\.ts/.test(stale[0]), stale.join('|'));
check('an end date 30 days away is not yet due', checkCalendar([e({ endDate: '2026-12-15' })], '2026-11-15').length === 0);
const soon = checkCalendar([e({ endDate: '2026-12-14' })], '2026-11-15');
check('an end date 29 days away is due, with the days and the page', soon.length === 1 && /29 days from now/.test(soon[0]) && /example\.test/.test(soon[0]), soon.join('|'));
const past = checkCalendar([e({ endDate: '2026-11-10' })], '2026-11-15');
check('an end date in the past is due ("reached ... 5 days ago")', past.length === 1 && /5 days ago/.test(past[0]));
check('the end date of today is due (0 days left)', checkCalendar([e({ endDate: '2026-11-15' })], '2026-11-15').length === 1);
check('both problems on one model are both reported', checkCalendar([e({ confirmedOn: '2026-01-01', endDate: '2026-11-20' })], '2026-11-15').length === 2);
check('two models are judged independently', checkCalendar([e(), e({ modelId: 'm-2', endDate: '2026-11-16' })], '2026-11-15').length === 1);
check('a confirmation in the future is reported, not trusted', checkCalendar([e({ confirmedOn: '2027-01-01' })], '2026-11-15').length === 1);
check('a date that does not exist (Feb 30, a non-leap Feb 29) is refused, not shifted', checkCalendar([e({ endDate: '2026-02-30' })], '2026-11-15').length === 1 && checkCalendar([e({ endDate: '2027-02-29' })], '2026-11-15').length === 1 && checkCalendar([e({ endDate: '2028-02-29' })], '2026-11-15').length === 0);
check('a malformed confirmation date does not hide an imminent end date', checkCalendar([e({ confirmedOn: 'bad', endDate: '2026-11-16' })], '2026-11-15').length === 2);
check('a malformed date is a sentence, not an exception', checkCalendar([e({ confirmedOn: 'last week' })], '2026-11-15').length === 1 && checkCalendar([e()], 'today').length === 1);

// an engine the owner switched off: its end date is a note, never an alarm; a stale confirmation still counts
const off = e({ inUse: false, endDate: '2026-11-10' });
check('an end date on a switched-off engine is not a problem', checkCalendar([off], '2026-11-15').length === 0);
check('...it is a note that says nothing is affected', calendarNotes([off], '2026-11-15').length === 1 && /switched off/.test(calendarNotes([off], '2026-11-15')[0]));
check('...and a note for an engine that IS in use is not given (it is a problem instead)', calendarNotes([e({ endDate: '2026-11-10' })], '2026-11-15').length === 0);
check('an old confirmation on a switched-off engine is not an alarm either (nobody is affected), and gives no note', checkCalendar([e({ inUse: false, confirmedOn: '2026-01-01' })], '2026-11-15').length === 0 && calendarNotes([e({ inUse: false, confirmedOn: '2026-01-01' })], '2026-11-15').length === 0);
check('...but a malformed end date on a switched-off engine IS a problem (a typo must never hide)', checkCalendar([e({ inUse: false, endDate: '2026-02-30' })], '2026-11-15').length === 1);
check('an engine in use with an old confirmation is still a problem', checkCalendar([e({ confirmedOn: '2026-01-01' })], '2026-11-15').length === 1);
check('only Gemini is in use (no paid engines: the owner, 2026-11-15)', MODEL_CALENDAR.filter((m) => m.inUse).map((m) => m.engine).join() === 'Gemini');

// the data agrees with the code that sends the ids
const byEngine = Object.fromEntries(MODEL_CALENDAR.map((m) => [m.engine, m.modelId]));
check('the calendar has one entry for each of the four engines', MODEL_CALENDAR.length === 4 && new Set(MODEL_CALENDAR.map((m) => m.engine)).size === 4);
check('...with exactly the default ids src/providers.ts sends', byEngine.Gemini === DEFAULT_GEMINI_MODEL && byEngine.ChatGPT === DEFAULT_OPENAI_MODEL && byEngine.Perplexity === DEFAULT_PERPLEXITY_MODEL && byEngine.Claude === DEFAULT_ANTHROPIC_MODEL, JSON.stringify(byEngine));
check('every entry names its pages and what was NOT confirmed; every page is an https address', MODEL_CALENDAR.every((m) => m.page.split(' and ').every((u) => /^https:\/\//.test(u))));
check('every entry says what was confirmed and what was NOT', MODEL_CALENDAR.every((m) => m.confirmed.length > 20 && m.unverified.length > 10));
check('the two ends known on 2026-11-15 are recorded (ChatGPT gpt-5 shutdown 2026-12-11; Perplexity chat-completions support ended 2026-09-27)', MODEL_CALENDAR.find((m) => m.engine === 'ChatGPT')?.endDate === '2026-12-11' && MODEL_CALENDAR.find((m) => m.engine === 'Perplexity')?.endDate === '2026-09-27');
check('every date is a real calendar date', MODEL_CALENDAR.every((m) => isCalendarDate(m.confirmedOn) && (m.endDate === null || isCalendarDate(m.endDate))));
check('Gemini free web search is recorded as "no" (docs/TECH_DEBT.md 2.19, the vendor pricing page)', MODEL_CALENDAR.find((m) => m.engine === 'Gemini')?.freeSearch === 'no');

// the weekly workflow's wiring (it has not run yet: these pin what was read)
import { readFileSync } from 'node:fs';
const wf = readFileSync('.github/workflows/model-calendar.yml', 'utf8');
check('the workflow runs weekly and by hand', /cron: '\d+ \d+ \* \* 1'/.test(wf) && /workflow_dispatch:/.test(wf));
check('...may write issues and nothing else', /issues: write/.test(wf) && /contents: read/.test(wf) && !/contents: write/.test(wf));
check('...runs the issue step even when an earlier step failed, and counts a missing result as due', /if: always\(\)/.test(wf) && /outputs\.code \|\| 1/.test(wf));
check('...lists the script\'s DUE lines in the issue (the script prints "DUE  " and the workflow greps "^DUE")', /grep '\^DUE' calendar\.log/.test(wf) && /console\.log\(`DUE  /.test(readFileSync('scripts/model-calendar-check.ts', 'utf8')));
check('...opens one issue, comments on it while due, closes it when nothing is due', /gh issue create/.test(wf) && /gh issue comment/.test(wf) && /gh issue close/.test(wf));

console.log(failures === 0 ? '\nAll model-calendar checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
