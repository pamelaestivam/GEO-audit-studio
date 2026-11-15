import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { apiFetch } from '../apiClient';
import { AuditReport } from '../types';
import { compareReports, EARLIER_DELETED_SENTENCE, NOTHING_IN_COMMON_SENTENCE, NOT_MEASURED_LABEL, type Comparison } from '../reportCompare';

type Loaded =
  | { state: 'loading' }
  | { state: 'deleted' }
  | { state: 'failed' }
  | { state: 'ready'; previous: AuditReport; comparison: Comparison };

const MAX_LISTED = 8;

function listWithMore(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

/** One audit's own headline, as counts: never a percentage difference. */
function ownLine(a: AuditReport): string {
  if (typeof a.observationsMentioned === 'number' && typeof a.observationsWithEvidence === 'number') {
    return `${a.observationsMentioned} of ${a.observationsWithEvidence} answers named the brand`;
  }
  return 'no answer count recorded';
}

/**
 * "Since the previous run": built only from `compareReports` (src/reportCompare.ts). It never works out a difference itself, and it
 * shows the two audits side by side, not as a change, when they were not measured the same way.
 */
export const SincePreviousRun: React.FC<{ audit: AuditReport }> = ({ audit }) => {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const previousId = audit.previousAuditId;

  useEffect(() => {
    if (!previousId) return;
    let cancelled = false;
    setLoaded({ state: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`/api/audits/${encodeURIComponent(previousId)}`, { retries: 2 });
        if (cancelled) return;
        if (res.status === 404) return setLoaded({ state: 'deleted' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.audit) return setLoaded({ state: 'failed' });
        setLoaded({ state: 'ready', previous: data.audit as AuditReport, comparison: compareReports(data.audit as AuditReport, audit) });
      } catch {
        if (!cancelled) setLoaded({ state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previousId, audit.id]);

  if (!previousId) return null;

  const shell = (children: React.ReactNode) => (
    <section aria-label="Since the previous run" data-testid="since-previous" className="mb-6 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 text-xs text-slate-300 leading-relaxed">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100 mb-2">
        <History className="h-4 w-4 text-indigo-400 shrink-0" /> Since the previous run
      </h3>
      {children}
    </section>
  );

  if (loaded.state === 'loading') return shell(<p>Loading the earlier audit to compare...</p>);
  if (loaded.state === 'deleted') return shell(<p>{EARLIER_DELETED_SENTENCE}</p>);
  if (loaded.state === 'failed') return shell(<p>The earlier audit could not be loaded to compare. Check your connection and reload.</p>);

  const { previous, comparison: c } = loaded;
  if (!c.comparable) {
    return shell(
      <>
        <p>{c.sentence}</p>
        <ul className="mt-2 space-y-1">
          <li><span className="text-slate-400">Earlier ({new Date(previous.createdAt).toLocaleDateString()}):</span> {ownLine(previous)}.</li>
          <li><span className="text-slate-400">This one ({new Date(audit.createdAt).toLocaleDateString()}):</span> {ownLine(audit)}.</li>
        </ul>
      </>
    );
  }

  const changed = c.pairs.filter((p) => p.namedBefore !== p.namedNow);
  return shell(
    <>
      {c.pairsCompared === 0 ? (
        <p>{NOTHING_IN_COMMON_SENTENCE}</p>
      ) : (
        <>
          <p>
            Compared over the {c.pairsCompared} {c.pairsCompared === 1 ? 'answer' : 'answers'} measured in both runs: your brand was named in{' '}
            <strong className="text-slate-100">{c.namedBefore} of {c.pairsCompared}</strong> before and in{' '}
            <strong className="text-slate-100">{c.namedNow} of {c.pairsCompared}</strong> now.
          </p>
          {changed.length > 0 && (
            <ul className="mt-2 space-y-1 list-disc pl-5">
              {changed.map((p, i) => (
                <li key={i}>
                  {p.question} ({p.engine}): {p.namedNow ? 'now names the brand, did not before' : 'named the brand before, does not now'}.
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2">Sources that appeared: {c.sourcesAppeared.length ? listWithMore(c.sourcesAppeared) : 'none'}. Sources that went: {c.sourcesGone.length ? listWithMore(c.sourcesGone) : 'none'}.</p>
          <p className="mt-1">Rivals newly named: {c.rivalsNew.length ? listWithMore(c.rivalsNew) : 'none'}.</p>
        </>
      )}
      {c.notMeasured.length > 0 && (
        <ul className="mt-2 space-y-1 list-disc pl-5 text-slate-400">
          {c.notMeasured.map((n, i) => (
            <li key={i}>{n.question} ({n.engine}): {NOT_MEASURED_LABEL}.</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-slate-400">{c.caveat}</p>
    </>
  );
};
