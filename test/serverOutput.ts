/**
 * Keeps what a spawned server prints, so a failed end-to-end run can show it. The suites used to start the server with
 * `stdio: 'ignore'`, which meant a start-up or connection failure in CI left only "Could not reach Gemini" and no way to
 * tell a refused connection from a reset, a crash or a port already in use (TECH_DEBT 2.14).
 */
import type { ChildProcess } from 'child_process';

export interface CapturedOutput {
  text(): string;
  /** The exit code or signal once the process has ended, else null. */
  exited(): string | null;
}

/** A line of the server's per-request access log. A polling test writes hundreds, which would bury the lines that matter. */
const ACCESS_LOG_LINE = /^\{"t":"[^"]+","id":"[^"]+","method":"/;

/**
 * Collect the last `limit` characters of stdout and stderr, leaving out the per-request access log (counted instead).
 * The process must have been spawned with piped stdout and stderr. Each stream keeps its own unfinished line (so a
 * fragment on one cannot be glued to a line on the other), text is decoded as UTF-8 across chunk boundaries, and an
 * unfinished line is bounded too.
 */
export function captureOutput(proc: ChildProcess, limit = 20000): CapturedOutput {
  let buf = '';
  let skipped = 0;
  let ended: string | null = null;
  const partials = { stdout: '', stderr: '' };
  const watch = (stream: NodeJS.ReadableStream | null | undefined, name: 'stdout' | 'stderr') => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const lines = (partials[name] + chunk).split('\n');
      partials[name] = (lines.pop() ?? '').slice(-limit);
      for (const line of lines) {
        if (ACCESS_LOG_LINE.test(line)) skipped++;
        else buf += line + '\n';
      }
      if (buf.length > limit) buf = buf.slice(buf.length - limit);
    });
  };
  watch(proc.stdout, 'stdout');
  watch(proc.stderr, 'stderr');
  proc.on('exit', (code, signal) => {
    ended = signal ? `signal ${signal}` : `code ${code}`;
  });
  return {
    text: () => buf + partials.stdout + (partials.stdout ? '\n' : '') + partials.stderr + (partials.stderr ? '\n' : '') + (skipped ? `(${skipped} request-log line(s) left out)\n` : ''),
    exited: () => ended,
  };
}

/** Print what a server said, for a run that has failures. A server that printed nothing says so. */
export function printCaptured(label: string, out: CapturedOutput | null | undefined) {
  if (!out) return;
  const text = out.text().trim();
  const state = out.exited() ? `ended with ${out.exited()}` : 'still running';
  console.log(`--- ${label} (${state}); last output ---\n${text || '(nothing printed)'}\n--- end ${label} ---`);
}
