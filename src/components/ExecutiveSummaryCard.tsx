import React from 'react';
import { ShieldCheck, AlertTriangle, HelpCircle, TrendingUp, CheckCircle2, Globe, Building2, ExternalLink, Award } from 'lucide-react';
import { AuditReport } from '../types';
import { TabType } from './Sidebar';

interface ExecutiveSummaryCardProps {
  audit: AuditReport;
  /** Jump to the module a metric belongs to. */
  onNavigate?: (tab: TabType) => void;
}

export const ExecutiveSummaryCard: React.FC<ExecutiveSummaryCardProps> = ({ audit, onNavigate }) => {
  // Every headline metric is backed by a module. The tiles used to be inert
  // divs, so tapping the number a user cared about did nothing at all.
  const tileClass =
    'text-left w-full bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 transition hover:border-indigo-500/50 hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 active:scale-[0.99] cursor-pointer';
  const scoreColor =
    audit.geoVisibilityScore >= 80
      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : audit.geoVisibilityScore >= 60
      ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
      : 'text-rose-400 border-rose-500/30 bg-rose-500/10';

  const pendingRemediationsCount = (audit.remediationPlan || []).filter((r) => !r.completed).length;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl mb-8 backdrop-blur-sm">
      {/*
        A failed audit must never read as a finding of zero. When no evidence was
        collected, say so before any number is shown.
      */}
      {audit.degraded && (
        <div className="mb-6 flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-amber-200">
              Audit incomplete — the figures below are not measurements
            </div>
            <p className="text-xs text-amber-200/80 mt-1 leading-relaxed">
              {audit.degradedReason ||
                'No evidence could be collected from the answer engines, so this report contains placeholder values rather than findings about this brand.'}
            </p>
          </div>
        </div>
      )}

      {/* Top Banner: Company Metadata + GEO Score Radial Badge */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-slate-800">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-2xl font-bold text-white tracking-tight">{audit.businessName}</h2>
            <a
              href={`https://${audit.domain}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium bg-indigo-500/10 px-2.5 py-1 rounded-md border border-indigo-500/20 transition"
            >
              <Globe className="h-3 w-3" />
              <span>{audit.domain}</span>
              <ExternalLink className="h-2.5 w-2.5 opacity-70" />
            </a>
            <span className="inline-flex items-center gap-1 text-xs text-slate-300 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700/60">
              <Building2 className="h-3 w-3 text-slate-400" />
              <span>{audit.industry}</span>
            </span>
          </div>

          <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
            <strong className="text-slate-200">Core Offerings:</strong> {audit.coreOfferings}
          </p>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 pt-1">
            <span className="font-semibold text-slate-300">Audited Competitors:</span>
            {(audit.competitors || []).map((comp) => (
              <span
                key={comp}
                className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300"
              >
                {comp}
              </span>
            ))}
          </div>
        </div>

        {/* GEO Score Radial Counter */}
        <div className="flex items-center gap-4 bg-slate-950/80 p-4 rounded-xl border border-slate-800 shadow-inner self-start lg:self-auto">
          <div className="relative flex items-center justify-center">
            <div className={`w-20 h-20 rounded-full border-4 flex items-center justify-center ${scoreColor}`}>
              <div className="text-center">
                <span className="text-2xl font-black tracking-tight">{audit.geoVisibilityScore}</span>
                <span className="text-[10px] block font-semibold text-slate-400 uppercase -mt-1">/ 100</span>
              </div>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 uppercase tracking-wider">
              <Award className="h-3.5 w-3.5 text-indigo-400" />
              <span>GEO Visibility Index</span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-[160px] leading-tight">
              Generative Engine Optimization index based on recommendation frequency & accuracy.
            </p>
          </div>
        </div>
      </div>

      {/* Key Metric Indicators */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-6 pb-6 border-b border-slate-800">
        <button type="button" onClick={() => onNavigate?.('competitors')} className={tileClass}>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Share of Voice (SOV)</span>
            <TrendingUp className="h-3.5 w-3.5 text-indigo-400" />
          </div>
          <div className="text-2xl font-bold text-white">{audit.shareOfVoice}%</div>
          <p className="text-[11px] text-slate-400 mt-1">Appeared in {audit.shareOfVoice}% of tested search prompts</p>
        </button>

        <button type="button" onClick={() => onNavigate?.('queries')} className={tileClass}>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>#1 Recommendation Rate</span>
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-emerald-400">{audit.leaderShare}%</div>
          <p className="text-[11px] text-slate-400 mt-1">Ranked as top recommended solution</p>
        </button>

        <button type="button" onClick={() => onNavigate?.('inaccuracies')} className={tileClass}>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Fact Accuracy Rate</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />
          </div>
          <div className="text-2xl font-bold text-sky-400">{audit.accuracyRate === null || audit.accuracyRate === undefined ? 'N/A' : `${audit.accuracyRate}%`}</div>
          <p className="text-[11px] text-slate-400 mt-1">Mentions free of false claims or hallucinations</p>
        </button>

        <button type="button" onClick={() => onNavigate?.('inaccuracies')} className={tileClass}>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
            <span>Inaccuracies & Omissions</span>
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-amber-400">
            {(audit.inaccuracies || []).length + (audit.omissions || []).length}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {(audit.inaccuracies || []).length} inaccuracies & {(audit.omissions || []).length} intent omissions
          </p>
        </button>
      </div>

      {/* Executive Narrative */}
      <div className="pt-6 flex flex-col md:flex-row md:items-start justify-between gap-6">
        <div className="flex-1">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Executive Summary & AI Posture Narrative
          </h3>
          <p className="text-sm text-slate-200 leading-relaxed bg-slate-950/40 p-4 rounded-xl border border-slate-800/60">
            {audit.executiveSummary}
          </p>
        </div>

        <div className="md:w-72 bg-gradient-to-br from-indigo-950/40 to-slate-950/80 border border-indigo-500/20 p-4 rounded-xl">
          <h4 className="text-xs font-semibold text-indigo-300 uppercase tracking-wider mb-2">
            Marketing Remediation Target
          </h4>
          <p className="text-xs text-slate-300 mb-3">
            {pendingRemediationsCount} actionable tasks identified to improve AI search recommendation rates.
          </p>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div
              className="bg-indigo-500 h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.round(
                  (((audit.remediationPlan || []).length - pendingRemediationsCount) /
                    ((audit.remediationPlan || []).length || 1)) *
                    100
                )}%`,
              }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-slate-400 mt-1.5 font-medium">
            <span>
              {(audit.remediationPlan || []).length - pendingRemediationsCount} resolved
            </span>
            <span>{(audit.remediationPlan || []).length} total</span>
          </div>
        </div>
      </div>
    </div>
  );
};
