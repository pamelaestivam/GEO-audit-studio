/**
 * The $0 guard (owner directive D-1, docs/OWNER_DIRECTIVES.md). Pure: no network, no clock of its own.
 *
 * What it can and cannot do, said plainly:
 *  - It CAN refuse to query a paid engine (ChatGPT, Perplexity, Claude) unless the operator opted in
 *    with ALLOW_PAID_ENGINES=1. A key left in the environment by accident then costs nothing.
 *  - It CAN count the Gemini calls this server instance makes per UTC day and stop at an operator
 *    cap (GEMINI_DAILY_CALL_CAP), which bounds what a bug or a retry loop can spend.
 *  - It CANNOT see whether the Google project has billing enabled. The real $0 control is a project
 *    with no billing account, which answers 429 at the free limit instead of charging
 *    (docs/PROGRAM.md O-2). The counter is a safeguard, not the money control, and it counts only
 *    what this one process did: another instance, or another client of the same key, is invisible.
 */

import type { EngineName } from './providers.js';

/** Engines that cost money per call. Gemini is the only one with a free tier. */
export const PAID_ENGINES: readonly EngineName[] = ['ChatGPT', 'Perplexity', 'Claude'];

const KEY_VAR: Record<EngineName, string> = {
  Gemini: 'GEMINI_API_KEY',
  ChatGPT: 'OPENAI_API_KEY',
  Perplexity: 'PERPLEXITY_API_KEY',
  Claude: 'ANTHROPIC_API_KEY',
};

type Env = Record<string, string | undefined>;

/** True only when the operator explicitly accepted that paid engines cost money. */
export function paidEnginesAllowed(env: Env): boolean {
  return env.ALLOW_PAID_ENGINES === '1';
}

/** Paid engines that have a key configured but are switched off because spending was not allowed. */
export function paidEnginesBlocked(env: Env): EngineName[] {
  if (paidEnginesAllowed(env)) return [];
  return PAID_ENGINES.filter((e) => !!env[KEY_VAR[e]]);
}

/**
 * The cap on Gemini calls per UTC day: null when none is set, the number when it is a positive whole
 * number, and 0 (no calls at all) when something is set but cannot be read ("0", "abc", "-1", "50/day").
 * An operator who typed a cap wants a limit; silently running with none would be the wrong way to fail
 * for a $0 directive. `capProblem` says which case it is.
 */
export function dailyCallCap(env: Env): number | null {
  const raw = env.GEMINI_DAILY_CALL_CAP;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** A sentence when GEMINI_DAILY_CALL_CAP is set but unreadable (calls are then blocked), else null. */
export function capProblem(env: Env): string | null {
  const raw = env.GEMINI_DAILY_CALL_CAP;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return null;
  return `GEMINI_DAILY_CALL_CAP is set to ${JSON.stringify(raw)}, which is not a positive whole number, so this server makes no answer-engine calls until the operator fixes it.`;
}

/** Counts calls per UTC calendar day. Holds the last few days only. */
export class CallCounter {
  private byDay = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  private key(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  record(): void {
    const k = this.key();
    this.byDay.set(k, (this.byDay.get(k) ?? 0) + 1);
    if (this.byDay.size > 7) {
      for (const old of [...this.byDay.keys()].sort().slice(0, this.byDay.size - 7)) this.byDay.delete(old);
    }
  }

  today(): number {
    return this.byDay.get(this.key()) ?? 0;
  }

  /** True when one more call would pass the cap. */
  wouldExceed(cap: number | null): boolean {
    return cap !== null && this.today() >= cap;
  }
}

/** The sentence a person reads when the cap stops a call. */
export function capReachedMessage(cap: number): string {
  return `This server is set to make at most ${cap} answer-engine ${cap === 1 ? 'call' : 'calls'} a day (UTC), and that limit has been reached. Results already measured are kept; try again after 00:00 UTC, or ask the operator to raise GEMINI_DAILY_CALL_CAP.`;
}

/** What /api/audit/status says about spending. */
export interface SpendStatus {
  paidEnginesBlocked: EngineName[];
  geminiCallsToday: number;
  geminiDailyCap: number | null;
  /** Set when GEMINI_DAILY_CALL_CAP is unreadable (calls are blocked). */
  capProblem: string | null;
  /** The counter lives in this process only. */
  scope: 'this server instance only';
}
