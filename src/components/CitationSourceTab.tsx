import React from 'react';
import { ExternalLink, Globe, ShieldCheck, Target, AlertTriangle } from 'lucide-react';
import { AuditReport } from '../types';

interface CitationSourceTabProps {
  audit: AuditReport;
}

/**
 * The most actionable view in the audit: which domains the answer engine
 * actually leaned on when composing its answers. It converts "we are invisible"
 * into "we are absent from these specific sources the engine trusts".
 */
export const CitationSourceTab: React.FC<CitationSourceTabProps> = ({ audit }) => {
  const sources = audit.citationSources || [];
  const owned = sources.filter((s) => s.isOwned);
  const thirdParty = sources.filter((s) => !s.isOwned);
  const maxCount = sources.length > 0 ? Math.max(...sources.map((s) => s.citationCount)) : 1;

  if (sources.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-400 mx-auto mb-3" />
        <h3 className="text-slate-200 font-bold mb-1.5">No citation sources captured</h3>
        <p className="text-sm text-slate-400 max-w-lg mx-auto">
          The answer engine returned no grounded web sources for this audit. Re-run the audit — if
          this persists, live search grounding is unavailable for these queries.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center shrink-0">
            <Globe className="h-4.5 w-4.5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-slate-100 font-bold">Citation Source Map</h2>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">
              These are the domains the answer engine actually cited while answering your buyer
              queries. Winning placement on these sources is the most direct lever on whether AI
              recommends you.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
          <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3.5">
            <div className="text-2xl font-bold text-slate-100">{sources.length}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">Distinct domains cited</div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3.5">
            <div className={`text-2xl font-bold ${owned.length > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {owned.length}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">Your own domain cited</div>
          </div>
          <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3.5">
            <div className="text-2xl font-bold text-amber-400">{thirdParty.length}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">Third-party sources to win</div>
          </div>
        </div>

        {owned.length === 0 && (
          <div className="mt-4 flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/25 rounded-lg p-3.5">
            <Target className="h-4 w-4 text-rose-400 mt-0.5 shrink-0" />
            <p className="text-xs text-rose-200/90 leading-relaxed">
              <span className="font-semibold">Your domain was never cited.</span> The engine built
              every answer from third-party sources below. Earning placement on them is higher
              leverage than changing your own site copy.
            </p>
          </div>
        )}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-200">Sources ranked by influence</h3>
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            {audit.queriesWithEvidence ?? '—'} queries with evidence
          </span>
        </div>

        <div className="divide-y divide-slate-800/70">
          {sources.map((source) => (
            <div key={source.domain} className="px-5 py-3.5 hover:bg-slate-800/25 transition">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-slate-100 truncate">
                      {source.domain}
                    </span>
                    {source.isOwned && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">
                        <ShieldCheck className="h-2.5 w-2.5" /> YOURS
                      </span>
                    )}
                  </div>
                  {source.sampleTitle && (
                    <div className="text-[11px] text-slate-500 truncate mt-0.5" title={source.sampleTitle}>
                      {source.sampleTitle}
                    </div>
                  )}
                  <div className="mt-2 h-1.5 bg-slate-800 rounded-full overflow-hidden max-w-md">
                    <div
                      className={`h-full rounded-full ${source.isOwned ? 'bg-emerald-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.max(6, (source.citationCount / maxCount) * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-slate-100">{source.citationCount}</div>
                  <div className="text-[10px] text-slate-500">
                    across {source.queryCount} {source.queryCount === 1 ? 'query' : 'queries'}
                  </div>
                  {source.sampleUrl && (
                    <a
                      href={source.sampleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 mt-1"
                    >
                      Open <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
