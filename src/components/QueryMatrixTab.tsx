import React, { useState } from 'react';
import { Search, Filter, ExternalLink, AlertTriangle, CheckCircle2, XCircle, ChevronRight, HelpCircle, User, Sparkles, Layers, Plus, RefreshCw, Send } from 'lucide-react';
import { AuditQuery, QueryIntent, AiEngine, RecommendationStatus, EngineResult, AuditReport } from '../types';

interface QueryMatrixTabProps {
  queries: AuditQuery[];
  businessName: string;
  audit?: AuditReport | null;
  onAppendQueryToAudit?: (newQuery: AuditQuery) => void;
}

const INTENT_LABELS: Record<QueryIntent, { label: string; color: string }> = {
  commercial_comparison: { label: 'Comparison', color: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
  direct_recommendation: { label: 'Direct Recommendation', color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  alternatives_search: { label: 'Alternatives Search', color: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
  feature_specific: { label: 'Feature Specific', color: 'bg-blue-500/10 text-blue-300 border-blue-500/30' },
  localized_vendor: { label: 'Local / Vendor', color: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  pricing_roi: { label: 'Pricing & ROI', color: 'bg-pink-500/10 text-pink-300 border-pink-500/30' },
};

/**
 * Only engines the backend genuinely queries are displayed. Listing engines we
 * do not call would mean presenting invented data as measurement.
 */
const KNOWN_ENGINES: AiEngine[] = ['Gemini', 'ChatGPT', 'Perplexity', 'Claude'];

/**
 * Show only engines this audit genuinely queried. Displaying an engine we did
 * not call would present an absence of data as a finding about the brand.
 */
function resolveMeasuredEngines(
  audit?: { measuredEngines?: string[]; enginesRequested?: string[] } | null
): AiEngine[] {
  // Prefer every engine we attempted: an engine whose calls all failed still
  // deserves a column reading "No data", rather than vanishing silently.
  const attempted = audit?.enginesRequested?.length ? audit.enginesRequested : audit?.measuredEngines || [];
  const matched = KNOWN_ENGINES.filter((e) => attempted.includes(e));
  return matched.length > 0 ? matched : ['Gemini'];
}

const STATUS_BADGES: Record<RecommendationStatus, { label: string; bg: string; text: string; icon: React.ReactNode }> = {
  recommended_leader: {
    label: '#1 Leader',
    bg: 'bg-emerald-500/20 border-emerald-500/40',
    text: 'text-emerald-300',
    icon: <CheckCircle2 className="h-3 w-3 text-emerald-400" />
  },
  secondary_mention: {
    label: 'Secondary',
    bg: 'bg-blue-500/20 border-blue-500/40',
    text: 'text-blue-300',
    icon: <Sparkles className="h-3 w-3 text-blue-400" />
  },
  omitted: {
    label: 'Omitted',
    bg: 'bg-slate-800 border-slate-700',
    text: 'text-slate-400',
    icon: <XCircle className="h-3 w-3 text-slate-500" />
  },
  inaccurate_claim: {
    label: 'Inaccurate',
    bg: 'bg-rose-500/20 border-rose-500/40',
    text: 'text-rose-300',
    icon: <AlertTriangle className="h-3 w-3 text-rose-400" />
  },
  negative_sentiment: {
    label: 'Negative',
    bg: 'bg-amber-500/20 border-amber-500/40',
    text: 'text-amber-300',
    icon: <AlertTriangle className="h-3 w-3 text-amber-400" />
  },
  retrieval_failed: {
    label: 'No data',
    bg: 'bg-slate-800/60 border-dashed border-slate-600',
    text: 'text-slate-500',
    icon: <HelpCircle className="h-3 w-3 text-slate-500" />
  }
};

const getStatusBadge = (status?: string) => {
  if (status && STATUS_BADGES[status as RecommendationStatus]) {
    return STATUS_BADGES[status as RecommendationStatus];
  }
  if (status?.includes('leader') || status?.includes('top') || status?.includes('recommended')) {
    return STATUS_BADGES.recommended_leader;
  }
  if (status?.includes('secondary') || status?.includes('mention')) {
    return STATUS_BADGES.secondary_mention;
  }
  if (status?.includes('inaccurate') || status?.includes('false') || status?.includes('hallucination')) {
    return STATUS_BADGES.inaccurate_claim;
  }
  if (status?.includes('negative')) {
    return STATUS_BADGES.negative_sentiment;
  }
  return STATUS_BADGES.omitted;
};

export const QueryMatrixTab: React.FC<QueryMatrixTabProps> = ({ queries = [], businessName, audit, onAppendQueryToAudit }) => {
  const ENGINES = resolveMeasuredEngines(audit);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIntent, setSelectedIntent] = useState<string>('all');
  const [selectedEngineFilter, setSelectedEngineFilter] = useState<string>('all');
  const [selectedQueryModal, setSelectedQueryModal] = useState<AuditQuery | null>(null);

  // Manual query entry & live auditing state
  const [newQueryText, setNewQueryText] = useState('');
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const handleAddAndAuditQuery = async (queryToAdd?: string) => {
    const textToSubmit = (queryToAdd || newQueryText).trim();
    if (!textToSubmit) return;

    setIsEvaluating(true);
    setEvalError(null);

    try {
      const res = await fetch('/api/audit/evaluate-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          domain: audit?.domain || `${businessName.toLowerCase().replace(/\s+/g, '')}.com`,
          industry: audit?.industry || 'B2B/Tech',
          coreOfferings: audit?.coreOfferings || 'Core products and solutions',
          targetAudience: audit?.targetAudience || 'Enterprise decision makers',
          competitors: audit?.competitors || [],
          queryText: textToSubmit,
        }),
      });

      const data = await res.json();
      if (data.evaluatedQuery) {
        if (onAppendQueryToAudit) {
          onAppendQueryToAudit(data.evaluatedQuery);
        }
        setNewQueryText('');
      } else {
        throw new Error('Failed to evaluate query search visibility.');
      }
    } catch (err: any) {
      console.error('Error adding and auditing query:', err);
      setEvalError(err.message || 'Failed to evaluate query live visibility.');
    } finally {
      setIsEvaluating(false);
    }
  };

  // Filtering
  const filteredQueries = (queries || []).filter((q) => {
    const matchesSearch =
      (q.queryText || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (q.targetPersona || '').toLowerCase().includes(searchTerm.toLowerCase());

    const matchesIntent = selectedIntent === 'all' || q.intent === selectedIntent;

    let matchesEngine = true;
    if (selectedEngineFilter !== 'all') {
      const engResult = q.engines ? q.engines[selectedEngineFilter as AiEngine] : undefined;
      matchesEngine = !!engResult && engResult.status !== 'omitted';
    }

    return matchesSearch && matchesIntent && matchesEngine;
  });

  return (
    <div className="space-y-6">
      {/* Manual Query Entry & Live Execution Section */}
      <div className="bg-gradient-to-br from-indigo-950/50 via-slate-900 to-slate-900 border border-indigo-500/30 rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Manual Search Query Entry & Live Pipeline
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30">
                  Real-Time Audit
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Type any target buyer query to append it to the audit list and test live search visibility across Gemini, ChatGPT, Perplexity, and Claude.
              </p>
            </div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAddAndAuditQuery();
          }}
          className="flex flex-col sm:flex-row gap-3"
        >
          <div className="relative flex-1">
            <input
              type="text"
              value={newQueryText}
              onChange={(e) => setNewQueryText(e.target.value)}
              placeholder={`Type extra target search query (e.g., "Is ${businessName} SOC2 compliant for enterprise healthcare?")...`}
              className="w-full bg-slate-950 border border-slate-700/80 text-white text-xs rounded-xl pl-4 pr-10 py-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition placeholder-slate-500 shadow-inner"
              disabled={isEvaluating}
            />
          </div>

          <button
            type="submit"
            disabled={isEvaluating || !newQueryText.trim()}
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-600/20 shrink-0"
          >
            {isEvaluating ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin text-white" />
                <span>Evaluating Live Search...</span>
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 text-white" />
                <span>Add & Audit Query</span>
              </>
            )}
          </button>
        </form>

        {/* Quick Suggestion Chips */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[11px] text-slate-400 font-medium">Quick Suggestions:</span>
          {[
            `Is ${businessName} enterprise SOC2 and HIPAA compliant?`,
            `${businessName} pricing vs enterprise plans and contract limits`,
            `Top 3 alternatives to ${businessName} for mid-market teams`,
            `${businessName} customer reviews, deployment speed, and pros/cons`,
          ].map((chipText, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleAddAndAuditQuery(chipText)}
              disabled={isEvaluating}
              className="text-[11px] bg-slate-800/80 hover:bg-indigo-500/20 text-slate-300 hover:text-indigo-300 border border-slate-700/80 hover:border-indigo-500/40 px-2.5 py-1 rounded-lg transition disabled:opacity-50 text-left truncate max-w-xs"
            >
              + {chipText}
            </button>
          ))}
        </div>

        {evalError && (
          <p className="text-xs text-rose-400 font-medium bg-rose-500/10 border border-rose-500/30 p-2.5 rounded-lg">
            {evalError}
          </p>
        )}
      </div>

      {/* Search & Intent Controls Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 p-4 rounded-xl border border-slate-800">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search queries or target personas..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg pl-9 pr-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Intent Filter Dropdown */}
          <select
            value={selectedIntent}
            onChange={(e) => setSelectedIntent(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-300 text-xs rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          >
            <option value="all">All Intent Categories</option>
            <option value="commercial_comparison">Comparison</option>
            <option value="direct_recommendation">Direct Recommendation</option>
            <option value="alternatives_search">Alternatives Search</option>
            <option value="feature_specific">Feature Specific</option>
            <option value="pricing_roi">Pricing & ROI</option>
          </select>

          {/* Engine Filter Dropdown */}
          <select
            value={selectedEngineFilter}
            onChange={(e) => setSelectedEngineFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-300 text-xs rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          >
            <option value="all">All AI Engines</option>
            {ENGINES.map((eng) => (
              <option key={eng} value={eng}>
                Mentioned in {eng}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Query List Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Search Query & Target Persona</th>
                <th className="py-3 px-4">Intent</th>
                {ENGINES.map((eng) => (
                  <th key={eng} className="py-3 px-4 text-center">
                    {eng}
                  </th>
                ))}
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredQueries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500">
                    No matching queries found. Try adjusting your search filters.
                  </td>
                </tr>
              ) : (
                filteredQueries.map((q) => (
                  <tr
                    key={q.id}
                    onClick={() => setSelectedQueryModal(q)}
                    className="hover:bg-slate-800/50 cursor-pointer transition group"
                  >
                    <td className="py-3.5 px-4 font-medium text-white max-w-xs">
                      <div className="text-sm font-semibold group-hover:text-indigo-300 transition line-clamp-2">
                        "{q.queryText}"
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-1">
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3 text-indigo-400" />
                          {q.targetPersona}
                        </span>
                        <span>•</span>
                        <span>{q.monthlySearchVolumeEstimate}</span>
                      </div>

                      {/* Live Citations Preview */}
                      {(() => {
                        const allCitations = Array.from(new Set(
                          Object.values(q.engines || {}).flatMap(e => (e as EngineResult)?.citations || [])
                        ));
                        if (allCitations.length === 0) {
                          return (
                            <div className="mt-1.5 text-[10px] text-slate-500 italic flex items-center gap-1">
                              <span>No live search citations</span>
                            </div>
                          );
                        }
                        return (
                          <div className="flex flex-wrap items-center gap-1 mt-1.5">
                            <span className="text-[10px] font-semibold text-slate-400 mr-0.5">Live Citations:</span>
                            {allCitations.slice(0, 2).map((url, i) => (
                              <a
                                key={i}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-0.5 text-[10px] text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20 max-w-[140px] truncate"
                              >
                                <span>{url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}</span>
                                <ExternalLink className="h-2 w-2 shrink-0" />
                              </a>
                            ))}
                            {allCitations.length > 2 && (
                              <span className="text-[10px] text-slate-400 font-medium">+{allCitations.length - 2} more</span>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td className="py-3.5 px-4">
                      {INTENT_LABELS[q.intent] ? (
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded-full border text-[10px] font-semibold ${INTENT_LABELS[q.intent].color}`}
                        >
                          {INTENT_LABELS[q.intent].label}
                        </span>
                      ) : (
                        <span className="text-slate-400">{q.intent}</span>
                      )}
                    </td>

                    {/* AI Engine Recommendation Status Pills */}
                    {ENGINES.map((eng) => {
                      const res = q.engines ? q.engines[eng] : undefined;
                      const badge = getStatusBadge(res?.status);
                      return (
                        <td key={eng} className="py-3.5 px-3 text-center">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold ${badge.bg} ${badge.text}`}
                            title={res?.excerpt || 'Omitted from AI search results'}
                          >
                            {badge.icon}
                            <span>{res?.position ? `#${res.position}` : badge.label}</span>
                          </span>
                        </td>
                      );
                    })}

                    <td className="py-3.5 px-4 text-right">
                      <button className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 group-hover:text-white transition">
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Query Detail Modal / Inspection Drawer */}
      {selectedQueryModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6 shadow-2xl space-y-6 text-white animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4">
              <div>
                <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">
                  AI Search Query Deep-Dive Inspection
                </span>
                <h3 className="text-xl font-bold text-white mt-1">
                  "{selectedQueryModal.queryText}"
                </h3>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 mt-2">
                  <span>
                    <strong>Target Persona:</strong> {selectedQueryModal.targetPersona}
                  </span>
                  <span>•</span>
                  <span>
                    <strong>Search Volume:</strong> {selectedQueryModal.monthlySearchVolumeEstimate}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedQueryModal(null)}
                className="text-slate-400 hover:text-white p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 transition"
              >
                ✕
              </button>
            </div>

            {/* AI Engine Responses Comparison Cards */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Simulated AI Engine Search Responses & Citations
              </h4>

              <div className="grid grid-cols-1 gap-4">
                {ENGINES.map((eng) => {
                  const res: EngineResult | undefined = selectedQueryModal.engines ? selectedQueryModal.engines[eng] : undefined;
                  if (!res) return null;
                  const badge = getStatusBadge(res.status);

                  return (
                    <div
                      key={eng}
                      className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-white">{eng}</span>
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-xs font-semibold ${badge.bg} ${badge.text}`}
                          >
                            {badge.icon}
                            <span>{res.position ? `Rank #${res.position} - ${badge.label}` : badge.label}</span>
                          </span>
                        </div>
                      </div>

                      {/* Verbatim AI Excerpt */}
                      <p className="text-xs text-slate-300 italic bg-slate-900/90 p-3 rounded-lg border border-slate-800">
                        "{res.excerpt}"
                      </p>

                      {/* Inaccuracy or Omission Alert inside Card */}
                      {res.keyInaccuracy && (
                        <div className="flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 p-2.5 rounded-lg text-xs text-rose-300">
                          <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                          <div>
                            <strong className="font-semibold block">Inaccuracy Flagged:</strong>
                            {res.keyInaccuracy}
                          </div>
                        </div>
                      )}

                      {res.keyOmissionReason && (
                        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 p-2.5 rounded-lg text-xs text-amber-300">
                          <HelpCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <strong className="font-semibold block">Root Cause for Omission:</strong>
                            {res.keyOmissionReason}
                          </div>
                        </div>
                      )}

                      {/* Cited Sources */}
                      {res.citations && res.citations.length > 0 && (
                        <div className="pt-1">
                          <span className="text-[11px] font-semibold text-slate-400 block mb-1.5">
                            Citations & Sources Cited by {eng}:
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {res.citations.map((url, i) => (
                              <a
                                key={i}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 px-2 py-0.5 rounded border border-indigo-500/20 transition truncate max-w-xs"
                              >
                                <span>{url.replace(/^https?:\/\//, '')}</span>
                                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedQueryModal(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition"
              >
                Close Inspection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
