/**
 * Guards the ports the end-to-end suites use (see test/ports.ts for why): Node's `fetch` refuses a fixed list of "bad
 * ports" at once, so a suite that happened to draw one saw a healthy server as dead, or a listening fake Gemini as
 * unreachable (a 1-in-100 to 1-in-300 chance per run for each suite whose range held one). This test fails if
 *   - the list no longer covers every port the running Node's fetch refuses (the list is a copy of a spec, and Node
 *     versions differ), checked by asking fetch itself about every port from 1 to 12000;
 *   - the helpers can hand out a refused port;
 *   - any suite goes back to drawing ports with the raw random arithmetic this repo used (`1234 + Math.floor(Math.random() * N)`)
 *     instead of the helpers; a tripwire for that shape, not a proof (a reversed expression or another construction is not seen).
 * Run: npx tsx test/ports.test.ts
 */
import fs from 'fs';
import path from 'path';
import { FETCH_BAD_PORTS, PortRange, randomPort } from './ports';

let failures = 0;
function assert(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  // ---- the list against the real fetch
  const refused: number[] = [];
  const LAST = 12000;
  let next = 1;
  const worker = async () => {
    while (next <= LAST) {
      const port = next++;
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      } catch (err: any) {
        if (/bad port/i.test(String(err?.cause?.message ?? err?.message ?? ''))) refused.push(port);
      }
    }
  };
  await Promise.all(Array.from({ length: 200 }, worker));
  refused.sort((a, b) => a - b);
  const missing = refused.filter((p) => !FETCH_BAD_PORTS.has(p));
  assert(`this Node's fetch refuses ${refused.length} ports between 1 and ${LAST}: the list covers every one`, refused.length > 20 && missing.length === 0, `not in test/ports.ts: ${missing.join(', ')}`);
  // These six are the ports that actually bit this repo. An older Node may not refuse all of them, so a miss is a note,
  // not a failure: the real check is the coverage assertion above.
  const notRefusedHere = [3659, 4045, 4190, 5060, 6000, 6566].filter((p) => !refused.includes(p));
  if (notRefusedHere.length) console.log(`note  this Node does not refuse ${notRefusedHere.join(', ')} (older undici?); they stay in the list because other Node versions and browsers do`);

  // ---- the helpers never hand one out
  let handedOut = 0;
  for (let i = 0; i < 20000; i++) if (FETCH_BAD_PORTS.has(randomPort(3600, 200)) || FETCH_BAD_PORTS.has(randomPort(4000, 100)) || FETCH_BAD_PORTS.has(randomPort(4100, 100))) handedOut++;
  assert('randomPort never returns a refused port from the ranges that contained one (3659, 4045, 4190)', handedOut === 0, `${handedOut} draws`);
  const walked = new PortRange(3650, 1);
  const seq = Array.from({ length: 12 }, () => walked.take());
  assert('a PortRange walking across 3659 skips it and stays in order', !seq.includes(3659) && seq.every((p, i) => i === 0 || p > seq[i - 1]), seq.join(','));
  const walked2 = new PortRange(6660, 1);
  const seq2 = Array.from({ length: 10 }, () => walked2.take());
  assert('and skips a run of refused ports (6665-6669)', seq2.every((p) => !FETCH_BAD_PORTS.has(p)), seq2.join(','));

  // ---- no suite draws ports by hand
  const dir = path.join(process.cwd(), 'test');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'ports.ts' && f !== 'ports.test.ts');
  const offenders: string[] = [];
  const handRolled = /\d{4}\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*\d+\s*\)/;
  for (const f of files) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (handRolled.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert('no test draws a port with the raw random arithmetic this repo used (use randomPort / PortRange from test/ports.ts)', offenders.length === 0, offenders.join('\n        '));
  assert('the scan found the test sources to read', files.length > 20, `${files.length} files`);

  console.log(failures === 0 ? '\nPort checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
