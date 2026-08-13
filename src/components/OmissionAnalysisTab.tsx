import React from 'react';
import { HelpCircle, Code, Star, MessageSquare, DollarSign, Layers, ArrowUpRight } from 'lucide-react';
import { OmissionReason } from '../types';

interface OmissionAnalysisTabProps {
  omissions: OmissionReason[];
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  'Schema & Entity Data': <Code className="h-4 w-4 text-purple-400" />,
  'Review & Directory Signals': <Star className="h-4 w-4 text-amber-400" />,
  'Comparison & Top 10 Coverage': <Layers className="h-4 w-4 text-blue-400" />,
  'Reddit / Forum Sentiment': <MessageSquare className="h-4 w-4 text-emerald-400" />,
  'Pricing & Feature Clarity': <DollarSign className="h-4 w-4 text-pink-400" />,
};

export const OmissionAnalysisTab: React.FC<OmissionAnalysisTabProps> = ({ omissions = [] }) => {
  const safeOmissions = omissions || [];

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">AI Search Omission Analysis</h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Analyze structural and informational reasons why AI search models left your business out of key buyer recommendation queries.
          </p>
        </div>
      </div>

      {/* Omissions List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {safeOmissions.map((om) => (
          <div
            key={om.id}
            className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4 flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
                    {CATEGORY_ICONS[om.category] || <Layers className="h-4 w-4 text-indigo-400" />}
                  </div>
                  <span className="text-xs font-bold text-slate-200">{om.category}</span>
                </div>
                <span className="px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-semibold">
                  Affects {om.affectedQueriesCount} Queries
                </span>
              </div>

              <h4 className="text-sm font-semibold text-white leading-snug">
                {om.description}
              </h4>

              <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3 space-y-1">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                  Root Cause Diagnosis:
                </span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {om.rootCause}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800/80">
              <span className="text-[11px] font-semibold text-indigo-400 uppercase tracking-wider block mb-1">
                Recommended Fixing Action:
              </span>
              <p className="text-xs text-slate-200 leading-relaxed font-medium">
                {om.recommendation}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
