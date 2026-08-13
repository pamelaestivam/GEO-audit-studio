import React from 'react';
import { Download, Printer, Copy, Check, Sparkles, ShieldCheck, Globe, Building2 } from 'lucide-react';
import { AuditReport } from '../types';

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

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  const handleCopyText = () => {
    const summaryText = `GEO AI SEARCH AUDIT REPORT - ${audit.businessName} (${audit.domain})
Date: ${new Date(audit.createdAt).toLocaleDateString()}
GEO Visibility Index: ${audit.geoVisibilityScore}/100
Share of Voice: ${audit.shareOfVoice}%
Leader Recommendation Share: ${audit.leaderShare}%
Fact Accuracy Rate: ${audit.accuracyRate === null || audit.accuracyRate === undefined ? 'N/A (brand not mentioned)' : `${audit.accuracyRate}%`}

EXECUTIVE SUMMARY:
${audit.executiveSummary}

KEY REMEDIATION TASKS:
${(audit.remediationPlan || []).map((r, i) => `${i + 1}. [${r.priority}] ${r.title} (${r.expectedGain})`).join('\n')}`;

    navigator.clipboard.writeText(summaryText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              <span>{copied ? 'Copied' : 'Copy Summary'}</span>
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
                <span>{audit.industry}</span>
                <span>•</span>
                <span>Audit Date: {new Date(audit.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div className="text-right bg-slate-900 border border-slate-800 p-3 rounded-xl">
              <span className="text-3xl font-black text-emerald-400 block">{audit.geoVisibilityScore}</span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase">GEO Visibility Score</span>
            </div>
          </div>

          {/* Key Audit KPI Grid */}
          <div className="grid grid-cols-3 gap-4 text-center bg-slate-900/60 p-4 rounded-xl border border-slate-800">
            <div>
              <span className="text-slate-400 block text-[11px]">Share of Voice</span>
              <span className="text-xl font-bold text-white">{audit.shareOfVoice}%</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Top Recommendation Rate</span>
              <span className="text-xl font-bold text-emerald-400">{audit.leaderShare}%</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Fact Accuracy Rate</span>
              <span className="text-xl font-bold text-sky-400">{audit.accuracyRate === null || audit.accuracyRate === undefined ? 'N/A' : `${audit.accuracyRate}%`}</span>
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
