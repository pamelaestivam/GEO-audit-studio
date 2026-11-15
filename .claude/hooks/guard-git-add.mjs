#!/usr/bin/env node
// PreToolUse hook for Bash (CLAUDE.md hard rule 8): refuse `git add -A`, `git add --all`, `git add .`
// and `git commit -a` / `-am` / `--all`. They stage things nobody chose (a helper symlink was once committed
// to main that way). Stage explicit paths instead.
//
// It reads the hook JSON on stdin. Exit 2 with a sentence on stderr refuses the call; exit 0 allows it.
// Text inside quotes and heredoc bodies is ignored, so a commit message that MENTIONS "git add -A" is fine.
// This is a guard against forgetting, not a security boundary: `bash -c "git add -A"` is not caught.
import { readFileSync } from 'node:fs';

export function stripQuoted(cmd) {
  let s = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ');
  s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return s;
}

// Returns a sentence when the command stages or commits everything, else null.
export function refusal(command) {
  const cleaned = stripQuoted(String(command || ''));
  for (const seg of cleaned.split(/&&|\|\||;|\||\n/)) {
    const words = seg.trim().split(/\s+/);
    const gi = words.indexOf('git');
    if (gi === -1) continue;
    // skip git's own options such as -C dir and -c k=v to find the subcommand
    let i = gi + 1;
    while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
    const sub = words[i];
    const args = words.slice(i + 1);
    if (sub === 'add') {
      if (args.some((a) => a === '--all' || a === '.' || a === './' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a))) {
        return 'Refused: `git add -A`, `git add --all` and `git add .` stage files nobody chose (CLAUDE.md hard rule 8). Stage explicit paths: `git add path/one path/two`.';
      }
    }
    if (sub === 'commit') {
      if (args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) {
        return 'Refused: `git commit -a` (and `-am`) commits every tracked change nobody chose (CLAUDE.md hard rule 8). Stage explicit paths with `git add`, then `git commit -m`.';
      }
    }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const msg = refusal(input?.tool_input?.command);
  if (msg) { process.stderr.write(msg + '\n'); process.exit(2); }
  process.exit(0);
}
