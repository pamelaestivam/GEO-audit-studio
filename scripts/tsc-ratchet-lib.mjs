// Pure parts of scripts/tsc-ratchet.mjs (kept apart so a test can import them without running the compiler).

/** Number of compiler errors in `tsc` output: lines of the form `path(line,col): error TSnnnn: ...`. */
export function countErrors(output) {
  return (String(output).match(/^.*\berror TS\d+:/gm) || []).length;
}

/**
 * Compare measured counts with the stored baseline. A count ABOVE the baseline fails; BELOW it is good news that must be written down (the
 * ratchet only moves one way); a flag set missing from the baseline fails (a new flag needs a stored starting point).
 */
export function verdict(measured, baseline) {
  const problems = []; const improved = [];
  for (const [flag, n] of Object.entries(measured)) {
    const base = baseline[flag];
    if (typeof base !== 'number') problems.push(`${flag}: no baseline stored (measured ${n}); add it to test/tsc-baseline.json`);
    else if (n > base) problems.push(`${flag}: ${n} compiler errors, up from the baseline of ${base}. A change added ${n - base}. Fix them (the baseline never goes up).`);
    else if (n < base) improved.push(`${flag}: ${n} errors, down from ${base}: run \`node scripts/tsc-ratchet.mjs --update\` and commit test/tsc-baseline.json so the gain cannot be lost`);
  }
  for (const flag of Object.keys(baseline)) if (!(flag in measured)) problems.push(`${flag}: stored in the baseline but not measured`);
  return { ok: problems.length === 0 && improved.length === 0, problems, improved };
}

/** The new baseline for --update: never higher than the old one. */
export function lowered(measured, baseline) {
  const out = { ...baseline };
  for (const [flag, n] of Object.entries(measured)) {
    if (typeof baseline[flag] !== 'number' || n <= baseline[flag]) out[flag] = n;
  }
  return out;
}
