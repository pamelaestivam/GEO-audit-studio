/**
 * The pure parts of the step-wise audit (docs/PLAN_STEP_E.md, slice S3): what the steps of an audit are, which
 * answers they produced, and what each one tells the person. No network, no store, no clock.
 *
 * An audit is planned once, when it is submitted, as an ordered list of steps: one answer-engine call per
 * question and engine, then the written analysis, then the finish. The engine in server.ts runs one step at
 * a time (`advanceJob`); this file is everything about steps that does not need a server.
 */
import type { QueryEvidence } from './analysis.js';
import type { AuditPlan } from './auditPipeline.js';
import type { JobStep, PlannedStep } from './store.js';

/** An unfinished step is claimed at most this many times before the audit ends with a sentence. */
export const MAX_STEP_ATTEMPTS = 3;

/** What is stored on the job at submit time: the cleaned request, and what could be measured then. */
export interface StoredAuditPlan extends AuditPlan {
  /** Who drives the steps: this server process (`inline`) or the page, one request per step (`client`). */
  driver: 'inline' | 'client';
  /** Engines with a key configured (and allowed) when the audit was submitted, in query order. */
  engines: string[];
  /** Set when nothing can be measured at all; the audit then has a single finishing step. */
  unconfigured?: { reason: string };
  /** The request as it was received, kept only for the failed-audit report if something unexpected breaks the run. */
  request: { businessName?: string; domain?: string; industry?: string; coreOfferings?: string; competitors?: any; queries?: any[] };
}

/** The ordered steps for a plan. `measurable` is false when no engine (or no analysis key) is configured. */
export function planSteps(plan: Pick<StoredAuditPlan, 'queryList' | 'engines'>, measurable: boolean): PlannedStep[] {
  if (!measurable) return [{ key: 'finalize', kind: 'finalize' }];
  const steps: PlannedStep[] = [];
  plan.queryList.forEach((_q, queryIndex) => {
    for (const engine of plan.engines) {
      steps.push({ key: `collect:${queryIndex}:${engine}`, kind: 'collect', queryIndex, engine });
    }
  });
  steps.push({ key: 'narrative', kind: 'narrative' });
  steps.push({ key: 'finalize', kind: 'finalize' });
  return steps;
}

/**
 * The evidence the finished collect steps produced, grouped by question in plan order. A skipped or failed
 * step contributes nothing; a question nobody reached has an empty group. Pure.
 */
export function evidenceByQueryFromSteps(steps: JobStep[], queryCount: number): QueryEvidence[][] {
  const groups: QueryEvidence[][] = Array.from({ length: queryCount }, () => []);
  for (const st of steps) {
    if (st.kind === 'collect' && st.state === 'done' && st.queryIndex !== undefined && st.result && groups[st.queryIndex]) {
      groups[st.queryIndex].push(st.result as QueryEvidence);
    }
  }
  return groups;
}

/** True when `step` is the first of its question's collect steps (where the pause between questions belongs). */
export function startsQuestion(steps: JobStep[], step: JobStep): boolean {
  if (step.kind !== 'collect') return false;
  const first = steps.find((s) => s.kind === 'collect' && s.queryIndex === step.queryIndex);
  return first?.seq === step.seq;
}

/**
 * Whether a collect step should be skipped because the quota breaker is tripped: once quota is known to be
 * exhausted, a question that has not started is not started (each of its calls would fail the same way a
 * moment later), but a question already under way finishes its other engines. Pure.
 */
export function skipForBreaker(steps: JobStep[], step: JobStep, breakerTripped: boolean, geminiPlanned: boolean): boolean {
  if (!breakerTripped || !geminiPlanned || step.kind !== 'collect') return false;
  const started = steps.some((s) => s.kind === 'collect' && s.queryIndex === step.queryIndex && s.seq !== step.seq && s.state === 'done');
  return !started;
}

/** What an in-flight audit is doing, for the client to display truthfully. */
export interface AuditProgress {
  phase: 'querying' | 'analysing';
  /** Questions fully collected so far. */
  done: number;
  total: number;
}

/** Progress while collecting question `queryIndex` (the questions before it are done). */
export function queryingProgress(queryIndex: number, total: number): AuditProgress {
  return { phase: 'querying', done: queryIndex, total };
}

/** Progress once collection is over. */
export function analysingProgress(total: number): AuditProgress {
  return { phase: 'analysing', done: total, total };
}

/** The pause that belongs before `step` runs: between questions, and before the written analysis. */
export function pauseBefore(step: Pick<JobStep, 'kind' | 'queryIndex'> | undefined, startsItsQuestion: boolean): number {
  if (!step) return 0;
  if (step.kind === 'collect') return startsItsQuestion && (step.queryIndex ?? 0) > 0 ? PAUSE_BETWEEN_QUESTIONS_MS : 0;
  if (step.kind === 'narrative') return PAUSE_BEFORE_ANALYSIS_MS;
  return 0;
}

/** The pause between one question and the next (spreads the calls out). */
export const PAUSE_BETWEEN_QUESTIONS_MS = 1200;
/** The pause before the written analysis call. */
export const PAUSE_BEFORE_ANALYSIS_MS = 600;

/** How long a client driver waits before asking for the next step, from the steps as they stand now. */
export function nextStepAfterMs(steps: JobStep[]): number {
  const next = steps.find((s) => s.state === 'pending' || s.state === 'leased');
  return pauseBefore(next, next ? startsQuestion(steps, next) : false);
}

/** What a person can be told about how far an audit has got, from its steps alone. */
export interface StepsSummary {
  /** Steps in a final state, and all steps. */
  done: number;
  total: number;
  /** Outside calls the audit will make if nothing is repeated: one per question and engine, plus the analysis. */
  plannedCalls: number;
  /** Outside calls that have started or finished: AT LEAST this many were made (a collector can retry inside one step). */
  callsMade: number;
  /** Steps re-claimed after a started call; a lower bound on repeated calls. */
  repeatedCalls: number;
}

export function summariseSteps(steps: JobStep[]): StepsSummary {
  const calls = (s: JobStep) => s.kind === 'collect' || s.kind === 'narrative';
  return {
    done: steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length,
    total: steps.length,
    plannedCalls: steps.filter(calls).length,
    callsMade: steps.filter((s) => calls(s) && (s.callStartedAt !== undefined || s.state === 'done')).length,
    repeatedCalls: steps.reduce((n, s) => n + s.repeatedCalls, 0),
  };
}
