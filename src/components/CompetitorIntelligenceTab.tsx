import React from 'react';
import { Award, ExternalLink, BarChart3, ShieldCheck } from 'lucide-react';
import { CompetitorBenchmark } from '../types';

interface CompetitorIntelligenceTabProps {
  competitors: CompetitorBenchmark[];
  businessName: string;
}

export const CompetitorIntelligenceTab: React.FC<CompetitorIntelligenceTabProps> = ({
  competitors = [],
  businessName,
}) => {
  const safeCompetitors = competitors || [];

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">Competitor AI Share of Voice (SOV) Benchmarks</h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Compare recommendation frequencies, top spot rankings, and primary citation sources across your competitors in AI Search.
          </p>
        </div>
      </div>

      {/* Share of Voice Progress Bar Chart */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          AI Search Engine Share of Voice Comparison (%)
        </h4>

        <div className="space-y-4">
          {safeCompetitors.map((comp) => {
            const isYourBusiness = (comp.name || '').toLowerCase().includes((businessName || '').toLowerCase());

            return (
              <div key={comp.name} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <div className="flex items-center gap-2">
                    <span className={isYourBusiness ? 'text-indigo-300 font-bold' : 'text-white'}>
                      {comp.name}
                    </span>
                    {isYourBusiness && (
                      <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-bold border border-indigo-500/30">
                        Your Business
                      </span>
                    )}
                  </div>

                  <span className="text-slate-300 font-bold">{comp.shareOfVoice}% SOV</span>
                </div>

                <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      isYourBusiness
                        ? 'bg-gradient-to-r from-indigo-500 to-purple-500 shadow-lg shadow-indigo-500/20'
                        : 'bg-slate-700'
                    }`}
                    style={{ width: `${comp.shareOfVoice}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Competitor Cards Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {safeCompetitors.map((comp) => {
          const isYourBusiness = (comp.name || '').toLowerCase().includes((businessName || '').toLowerCase());

          return (
            <div
              key={comp.name}
              className={`bg-slate-900/90 border rounded-xl p-5 shadow-lg space-y-4 ${
                isYourBusiness ? 'border-indigo-500/40 bg-indigo-950/10' : 'border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    {comp.name}
                    {isYourBusiness && (
                      <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                        Audited Profile
                      </span>
                    )}
                  </h4>
                  {comp.domain ? (
                    <a
                      href={`https://${comp.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-slate-400 hover:text-indigo-300 transition"
                    >
                      {comp.domain}
                    </a>
                  ) : (
                    // Rivals discovered in the answers have no domain supplied.
                    <span className="text-xs text-slate-500">Found in AI answers</span>
                  )}
                </div>

                <div className="text-right">
                  <span className="text-lg font-black text-indigo-400 block">{comp.shareOfVoice}%</span>
                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Share of Voice</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs bg-slate-950/80 p-3 rounded-lg border border-slate-800">
                <span className="text-slate-400">#1 Top Recommendation Wins:</span>
                <span className="font-bold text-emerald-400 flex items-center gap-1">
                  <ShieldCheck className="h-4 w-4" />
                  {comp.topRecommendedCount} Queries
                </span>
              </div>

              <div>
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                  Primary Citation Sources Trusted by AI:
                </span>
                <div className="flex flex-wrap gap-2">
                  {(comp.mainCitationSources || []).map((source, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-md bg-slate-800/80 text-slate-300 text-xs border border-slate-700/60"
                    >
                      {source}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
