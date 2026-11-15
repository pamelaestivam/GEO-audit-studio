// The rules of the git-add guard (CLAUDE.md hard rule 8), as a pure function so a test can attack it.
// refusal(command) returns a sentence when the command stages or commits everything, else null.
//
// It scans the command once, left to right, tracking quotes, so an apostrophe inside a double-quoted
// message cannot hide a later command, and text inside quotes, heredoc bodies and comments is never read as a command.
// Limits (said plainly): it is a guard against forgetting, not a security boundary. `bash -c "git add -A"`, aliases,
// `$(...)` inside a double-quoted string, and a command named by variable are not seen.

// Split a command into simple commands, each a list of words. Quoted text stays inside its word.
export function simpleCommands(cmd) {
  const cmds = [];
  let words = [];
  let cur = null; // the word being built, or null
  const endWord = () => { if (cur !== null) { words.push(cur); cur = null; } };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { const j = s.indexOf("'", i + 1); const end = j === -1 ? s.length : j; cur = (cur ?? '') + s.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      let j = i + 1; let body = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { body += s[j + 1]; j += 2; } else { body += s[j]; j++; } }
      cur = (cur ?? '') + body; i = j; continue;
    }
    if (c === '\\') { cur = (cur ?? '') + (s[i + 1] ?? ''); i++; continue; }
    if (c === '#' && cur === null) { while (i < s.length && s[i] !== '\n') i++; i--; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
      if (m) {
        const nl = s.indexOf('\n', i + m[0].length);
        if (nl === -1) { i = s.length; continue; }
        const endRe = new RegExp(`^\\s*${m[2]}\\s*$`, 'm');
        const rest = s.slice(nl + 1); const e = endRe.exec(rest);
        i = nl;
        if (e) i = nl + 1 + e.index + e[0].length - 1; else i = s.length;
        endCmd();
        continue;
      }
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '(' || c === ')' || c === '`' || c === '>' || c === '<') {
      if (c === '&' && s[i + 1] === '>') { endCmd(); continue; }
      endCmd(); continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    cur = (cur ?? '') + c;
  }
  endCmd();
  return cmds;
}

const ARG_TAKING = 'mFCctSu'; // git commit short options that take a value (rest of the group, or the next word)

function shortGroupHas(arg, letter) {
  if (!/^-[A-Za-z]/.test(arg)) return false;
  for (const ch of arg.slice(1)) { if (ch === letter) return true; if (ARG_TAKING.includes(ch)) return false; }
  return false;
}

export function refusal(command) {
  for (const raw of simpleCommands(command)) {
    let words = raw.slice();
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // VAR=x git ...
    if (!words.length) continue;
    const first = words[0].split('/').pop();
    if (first !== 'git') continue;
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
    const sub = words[i]; const args = words.slice(i + 1);
    if (sub === 'add') {
      const everything = args.some((a) => a === '.' || a === './' || a === ':/' || a === '*' || a === '--no-ignore-removal'
        || (a.startsWith('--') && a.length >= 3 && '--all'.startsWith(a)) || shortGroupHas(a, 'A'));
      if (everything) return 'Refused: `git add -A`, `--all`, `git add .`, `git add :/` and `git add *` stage files nobody chose (CLAUDE.md hard rule 8). Stage explicit paths: `git add path/one path/two`.';
    }
    if (sub === 'commit') {
      if (args.some((a) => a === '--all' || shortGroupHas(a, 'a'))) {
        return 'Refused: `git commit -a` (and `-am`) commits every tracked change nobody chose (CLAUDE.md hard rule 8). Stage explicit paths with `git add`, then `git commit -m`.';
      }
    }
  }
  return null;
}
