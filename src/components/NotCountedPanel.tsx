import React from 'react';
import { notCountedView } from '../reportView';
import type { AuditReport } from '../types';

/**
 * "N claims were not counted. See why." A claim the analysis reported that could not be tied to a captured
 * answer is in no figure; this lists each one in the model's own words with the reason, marked unverified.
 * Native <details> so it opens and closes without state, by keyboard too.
 */
export const NotCountedPanel: React.FC<{ audit: AuditReport }> = ({ audit }) => {
  const view = notCountedView(audit);
  if (!view) return null;
  return (
    <details data-testid="not-counted" className="mb-4 rounded-xl border border-slate-700 bg-slate-900/60 text-xs text-slate-300">
      <summary className="cursor-pointer select-none px-4 py-2.5 font-semibold text-slate-200">
        {view.summary} <span className="underline underline-offset-2 text-indigo-300">See why</span>
      </summary>
      <div className="border-t border-slate-800 px-4 py-3 space-y-3">
        <ul className="space-y-2">
          {view.rows.map((r, i) => (
            <li key={i} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="flex items-start gap-2">
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">unverified</span>
                <p className="min-w-0 break-words text-slate-200">&ldquo;{r.text}&rdquo;</p>
              </div>
              <p className="mt-1.5 text-slate-400">{r.reason}</p>
            </li>
          ))}
        </ul>
        {view.moreCount > 0 && <p className="text-slate-400">&hellip;and {view.moreCount} more not listed here.</p>}
        <p className="text-slate-400">{view.footer}</p>
      </div>
    </details>
  );
};
