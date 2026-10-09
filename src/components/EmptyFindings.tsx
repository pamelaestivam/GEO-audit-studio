import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

interface EmptyFindingsProps {
  /** False when the qualitative analysis never ran for this audit. */
  assessed: boolean;
  /** What a clean result means for this section, e.g. "No inaccuracies were flagged". */
  noneFoundTitle: string;
  noneFoundDetail: string;
  /** What was not produced when the analysis failed, e.g. "inaccuracies". */
  subject: string;
}

/**
 * Empty state for the qualitative tabs. "Nothing found" and "nothing was
 * assessed" are different facts: a section that is empty because the analysis
 * step failed must never read as a clean bill of health.
 */
export const EmptyFindings: React.FC<EmptyFindingsProps> = ({
  assessed,
  noneFoundTitle,
  noneFoundDetail,
  subject,
}) =>
  assessed ? (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-12 text-center text-slate-400 space-y-2">
      <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto" />
      <h4 className="text-base font-semibold text-white">{noneFoundTitle}</h4>
      <p className="text-xs text-slate-500">{noneFoundDetail}</p>
    </div>
  ) : (
    <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-12 text-center text-amber-200/90 space-y-2">
      <AlertTriangle className="h-10 w-10 text-amber-400 mx-auto" />
      <h4 className="text-base font-semibold text-amber-100">Not assessed</h4>
      <p className="text-xs text-amber-200/70">
        The analysis that produces {subject} did not run for this audit, so an empty list here is not a
        finding. Re-run the audit to generate it.
      </p>
    </div>
  );
