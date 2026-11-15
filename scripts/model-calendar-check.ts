// Checks the model calendar (src/modelCalendar.ts) against today's date. Exit 1 with one sentence per problem when something is due.
// Run weekly by .github/workflows/model-calendar.yml; by hand: npx tsx scripts/model-calendar-check.ts [YYYY-MM-DD]
import { MODEL_CALENDAR, checkCalendar } from '../src/modelCalendar.ts';

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const problems = checkCalendar(MODEL_CALENDAR, today);
console.log(`Model calendar checked for ${today}: ${MODEL_CALENDAR.length} default models.`);
for (const e of MODEL_CALENDAR) console.log(`  ${e.engine} ${e.modelId}: confirmed ${e.confirmedOn}, end ${e.endDate ?? 'none published'}, free search ${e.freeSearch}`);
if (problems.length === 0) { console.log('Nothing is due.'); process.exit(0); }
for (const p of problems) console.log(`DUE  ${p}`);
process.exit(1);
