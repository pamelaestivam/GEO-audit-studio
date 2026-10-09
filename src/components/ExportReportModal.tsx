import React from 'react';
import { Download, Printer, Copy, Check, Sparkles, ShieldCheck, Globe, Building2 } from 'lucide-react';
import { AuditReport } from '../types';
import {
  describeAccuracy,
  formatPercent,
  formatScore,
  hasMeasurements,
  isLowSample,
  visibilityBasis,
  wasAssessed,
} from '../reportView';

interface ExportReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  audit: AuditReport;
}

export const ExportReportModal: React.FC<ExportReportModalProps> = ({
  isOpen,
  onClose,
  audit,
}) => {
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  const measured = hasMeasurements(audit);
  const accuracy = describeAccuracy(audit);
  const basis = visibilityBasis(audit);
  const assessed = wasAssessed(audit);
  const enginesLine = (audit.measuredEngines || []).length
    ? (audit.measuredEngines || []).join(', ')
    : 'none';

  // Everything a reader needs to judge the numbers travels with them: whether
  // the audit completed, which engines answered, and how many answers the
  // percentages rest on. A pasted summary has no UI around it to carry that.
  const caveats: string[] = [];
  if (!measured) caveats.push(`AUDIT INCOMPLETE - the figures below are NOT measurements. ${audit.degradedReason || ''}`.trim());
  if (measured && audit.narrativeAvailable === false) {
    caveats.push('Accuracy, omissions and remediation were NOT assessed (the analysis step failed).');
  }
  if (isLowSample(audit)) {
    caveats.push(`Small sample: only ${audit.observationsWithEvidence} captured answer(s). Indicative, not a stable rate.`);
  }
  if ((audit.queriesAddedAfterAudit || 0) > 0) {
    caveats.push(`${audit.queriesAddedAfterAudit} query(ies) added after the audit are not included in these figures.`);
  }

  const handleCopyText = async () => {
    const summaryText = `GEO AI SEARCH AUDIT REPORT - ${audit.businessName}${audit.domain ? ` (${audit.domain})` : ''}
Date: ${new Date(audit.createdAt).toLocaleDateString()}
Engines measured: ${enginesLine}${basis ? `\n${basis}` : ''}
${caveats.length ? `\nCAVEATS:\n${caveats.map((c) => `- ${c}`).join('\n')}\n` : ''}
Visibility (answers naming the brand): ${formatScore(audit)}${measured ? '/100' : ''}
Share of Voice (of all brand mentions): ${formatPercent(audit, audit.shareOfVoice)}
#1 Recommendation Rate: ${formatPercent(audit, audit.leaderShare)}
Fact Accuracy Rate: ${accuracy.value} (${accuracy.caption})

EXECUTIVE SUMMARY:
${audit.executiveSummary}
${assessed ? `\nKEY REMEDIATION TASKS:\n${(audit.remediationPlan || []).map((r, i) => `${i + 1}. [${r.priority}] ${r.title} (${r.expectedGain})`).join('\n') || '(none proposed)'}` : '\nREMEDIATION: not generated for this audit.'}`;

    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied outside secure contexts and by some
      // browsers; saying "Copied" regardless would be a lie.
      setCopyFailed(true);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 shadow-2xl text-white space-y-6 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5 text-emerald-400" />
            <h3 className="text-lg font-bold text-white">Executive Audit Report Export</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyText}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold transition text-slate-200"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'Copied' : copyFailed ? 'Copy blocked - select text manually' : 'Copy Summary'}</span>
            </button>

            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold transition text-white"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>Print / Save PDF</span>
            </button>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-2 rounded-lg bg-slate-800 transition"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Printable Executive Document Sheet */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-8 space-y-6 text-xs text-slate-300 shadow-inner">
          <div className="flex items-start justify-between border-b border-slate-800 pb-6">
            <div>
              <div className="text-indigo-400 font-bold uppercase tracking-wider text-[11px] flex items-center gap-1">
                <Sparkles className="h-3.5 w-3.5" />
                <span>GEO Audit Studio — Executive Intelligence Report</span>
              </div>
              <h2 className="text-2xl font-black text-white tracking-tight mt-1">
                {audit.businessName}
              </h2>
              <div className="flex items-center gap-3 text-slate-400 mt-1">
                <span>{audit.domain}</span>
                <span>•</span>
                {audit.industry && <span>{audit.industry}</span>}
                {audit.industry && <span>•</span>}
                <span>Audit Date: {new Date(audit.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div className="text-right bg-slate-900 border border-slate-800 p-3 rounded-xl">
              <span className={`text-3xl font-black block ${measured ? 'text-emerald-400' : 'text-slate-500'}`}>{formatScore(audit)}</span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase">GEO Visibility Score</span>
              {basis && <span className="block text-[10px] text-slate-400 mt-1">{basis}</span>}
            </div>
          </div>

          {caveats.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-1">
              {caveats.map((c, i) => (
                <p key={i} className="text-[11px] text-amber-200 leading-relaxed">{c}</p>
              ))}
            </div>
          )}

          {/* Key Audit KPI Grid */}
          <div className="grid grid-cols-3 gap-4 text-center bg-slate-900/60 p-4 rounded-xl border border-slate-800">
            <div>
              <span className="text-slate-400 block text-[11px]">Share of Voice</span>
              <span className="text-xl font-bold text-white">{formatPercent(audit, audit.shareOfVoice)}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Top Recommendation Rate</span>
              <span className="text-xl font-bold text-emerald-400">{formatPercent(audit, audit.leaderShare)}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Fact Accuracy Rate</span>
              <span className="text-xl font-bold text-sky-400">{accuracy.value}</span>
            </div>
          </div>

          {/* Executive Narrative */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-200 text-sm uppercase tracking-wider">
              Executive Summary & Posture
            </h4>
            <p className="leading-relaxed bg-slate-900/80 p-4 rounded-lg border border-slate-800 text-slate-200">
              {audit.executiveSummary}
            </p>
          </div>

          {/* Top Remediation Action Plan */}
          <div className="space-y-3">
            <h4 className="font-bold text-slate-200 text-sm uppercase tracking-wider">
              Prioritized Remediation Roadmap
            </h4>
            <div className="space-y-2">
              {(audit.remediationPlan || []).length === 0 && (
                <p className="text-slate-500 text-[11px]">
                  {assessed ? 'No remediation tasks were proposed.' : 'Not generated for this audit.'}
                </p>
              )}
              {(audit.remediationPlan || []).map((task, idx) => (
                <div
                  key={task.id}
                  className="bg-slate-900/80 p-3 rounded-lg border border-slate-800 flex items-center justify-between gap-3"
                >
                  <div>
                    <span className="font-bold text-white text-xs block">
                      {idx + 1}. {task.title}
                    </span>
                    <span className="text-slate-400 text-[11px]">{task.category} • Priority: {task.priority}</span>
                  </div>
                  <span className="text-emerald-400 font-semibold text-[11px] bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20 shrink-0">
                    {task.expectedGain}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
