#!/usr/bin/env node
// PreToolUse hook for Bash (CLAUDE.md hard rule 8): refuse `git add -A`, `git add .`, `git commit -a` and their kin.
// Reads the hook JSON on stdin. Exit 2 with a sentence on stderr refuses the call; exit 0 allows it.
// There is deliberately no "run only when executed directly" check here: it ran only when the path had no space or symlink
// and silently did nothing otherwise. The rules are in guard-lib.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const lib = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'guard-lib.mjs')).href);
const msg = lib.refusal(input?.tool_input?.command);
if (msg) { process.stderr.write(msg + '\n'); process.exit(2); }
process.exit(0);
