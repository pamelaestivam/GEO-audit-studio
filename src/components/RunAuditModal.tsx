import React, { useState } from 'react';
import { Sparkles, Globe, Building2, Users, Plus, Trash2, ArrowRight, RefreshCw, CheckCircle2, ShieldAlert } from 'lucide-react';
import { runAuditJob } from '../auditClient';
import { apiFetch } from '../apiClient';
import { newIdempotencyKey } from '../idempotency';
import { useQuotaStatus } from '../useQuotaStatus';
import { AuditReport, AuditQuery } from '../types';

interface RunAuditModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuditComplete: (newReport: AuditReport) => void;
}

export const RunAuditModal: React.FC<RunAuditModalProps> = ({
  isOpen,
  onClose,
  onAuditComplete,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const quota = useQuotaStatus();

  // Step 1 State
  const [businessName, setBusinessName] = useState('');
  const [domain, setDomain] = useState('');
  const [industry, setIndustry] = useState('');
  const [coreOfferings, setCoreOfferings] = useState('');
  const [competitors, setCompetitors] = useState<string[]>(['']);

  // Step 2 State (Generated Queries)
  const [queries, setQueries] = useState<Partial<AuditQuery>[]>([]);
  const [isGeneratingQueries, setIsGeneratingQueries] = useState(false);
  const [newQueryText, setNewQueryText] = useState('');

  // Step 3 State (Running Audit)
  const [auditProgressMessage, setAuditProgressMessage] = useState('Initializing AI search crawlers...');
  const [isSubmittingAudit, setIsSubmittingAudit] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAddCompetitor = () => {
    setCompetitors([...competitors, '']);
  };

  const handleUpdateCompetitor = (index: number, val: string) => {
    const updated = [...competitors];
    updated[index] = val;
    setCompetitors(updated);
  };

  const handleRemoveCompetitor = (index: number) => {
    setCompetitors(competitors.filter((_, i) => i !== index));
  };

  // Step 1 -> Step 2: Generate Query Matrix via Server API
  const handleProceedToQueries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName) return;

    setIsGeneratingQueries(true);
    setErrorMessage(null);

    const validCompetitors = competitors.map((c) => c.trim()).filter(Boolean);

    try {
      const res = await apiFetch('/api/audit/generate-queries', {
        method: 'POST',
        // One key per click, reused across apiFetch's retries - see auditClient.
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
        body: JSON.stringify({
          businessName,
          domain,
          industry,
          coreOfferings,
          competitors: validCompetitors,
        }),
        retries: 2,
        timeoutMs: 15000,
      });

      const data = await res.json();
      if (data.queries && Array.isArray(data.queries)) {
        setQueries(data.queries);
      } else {
        // Default fallback queries if API errors
        setQueries([
          {
            id: 'q-custom-1',
            intent: 'alternatives_search',
            queryText: `Best ${industry || 'software'} alternatives to ${validCompetitors[0] || 'competitors'} for modern teams`,
            targetPersona: 'Decision Maker',
          },
          {
            id: 'q-custom-2',
            intent: 'commercial_comparison',
            queryText: `${businessName} vs ${validCompetitors[0] || 'leading competitor'} in-depth feature breakdown`,
            targetPersona: 'Evaluator',
          },
          {
            id: 'q-custom-3',
            intent: 'pricing_roi',
            queryText: `${businessName} pricing free tier limits and enterprise ROI`,
            targetPersona: 'Procurement / CTO',
          },
        ]);
      }
      setStep(2);
    } catch (err: any) {
      console.error('Error generating queries:', err);
      // Fallback
      setQueries([
        {
          id: 'q-fallback-1',
          intent: 'alternatives_search',
          queryText: `Top recommended solutions for ${industry || 'business'} in 2026`,
          targetPersona: 'Buyer',
        },
        {
          id: 'q-fallback-2',
          intent: 'commercial_comparison',
          queryText: `${businessName} customer reviews, pros and cons, and pricing`,
          targetPersona: 'Evaluator',
        },
      ]);
      setStep(2);
    } finally {
      setIsGeneratingQueries(false);
    }
  };

  const handleAddCustomQuery = () => {
    if (!newQueryText.trim()) return;
    setQueries([
      ...queries,
      {
        id: `q-user-${Date.now()}`,
        intent: 'feature_specific',
        queryText: newQueryText.trim(),
        targetPersona: 'Target Customer',
      },
    ]);
    setNewQueryText('');
  };

  const handleRemoveQuery = (index: number) => {
    setQueries(queries.filter((_, i) => i !== index));
  };

  // Step 2 -> Step 3: Run Full Audit via Server API
  const handleExecuteAudit = async () => {
    setStep(3);
    setIsSubmittingAudit(true);
    setErrorMessage(null);

    const validCompetitors = competitors.map((c) => c.trim()).filter(Boolean);

    try {
      setAuditProgressMessage('Querying Gemini, ChatGPT, Perplexity & Claude...');
      
      // No invented inputs: a blank field stays blank rather than becoming a
      // guessed domain, industry or a fictional "Industry Leaders" competitor.
      const data = await runAuditJob(
        {
          businessName,
          domain: domain || undefined,
          industry: industry || undefined,
          competitors: validCompetitors,
          queries,
        },
        setAuditProgressMessage
      );

      if (data.report) {
        setAuditProgressMessage('Audit completed. Indexing results...');
        setTimeout(() => {
          onAuditComplete(data.report);
          onClose();
          setStep(1);
        }, 1200);
      } else {
        throw new Error('The audit returned no report. Please try again.');
      }
    } catch (err: any) {
      console.error('Audit execution error:', err);
      setErrorMessage(err.message || 'Audit execution experienced a delay.');
      setIsSubmittingAudit(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl p-6 shadow-2xl text-white relative space-y-6 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Run Live AI Search Audit</h3>
              <p className="text-xs text-slate-400">
                Step {step} of 3 — {step === 1 ? 'Business Profile' : step === 2 ? 'Target Queries' : 'Running AI Audit'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isSubmittingAudit}
            className="text-slate-400 hover:text-white p-2 rounded-lg bg-slate-800 transition disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {/* STEP 1: Company Profile Form */}
        {step === 1 && (
          <form onSubmit={handleProceedToQueries} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="font-semibold text-slate-300 block">
                  Business / Brand Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Acme SaaS, Notion, Stripe"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-300 block">
                  Website Domain
                </label>
                <div className="relative">
                  <Globe className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="e.g. acme.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg pl-9 pr-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="font-semibold text-slate-300 block">
                  Industry / Sector
                </label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="text"
                    placeholder="e.g. B2B Analytics, Healthcare Telemed"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg pl-9 pr-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-slate-300 block">
                  Core Offerings & Key Features
                </label>
                <input
                  type="text"
                  placeholder="e.g. Real-time dashboards, Postgres, SSO, Free Tier"
                  value={coreOfferings}
                  onChange={(e) => setCoreOfferings(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Competitors List */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label className="font-semibold text-slate-300 block">
                  Key Competitors (Used for Share of Voice Benchmarks)
                </label>
                <button
                  type="button"
                  onClick={handleAddCompetitor}
                  className="text-indigo-400 hover:text-indigo-300 text-[11px] font-semibold flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" />
                  Add Competitor
                </button>
              </div>

              <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                {competitors.map((comp, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder={`Competitor #${idx + 1}`}
                      value={comp}
                      onChange={(e) => handleUpdateCompetitor(idx, e.target.value)}
                      className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                    {competitors.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveCompetitor(idx)}
                        className="text-slate-500 hover:text-rose-400 p-1.5"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {quota && !quota.available && (
              <div className="flex items-start gap-2.5 bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
                <ShieldAlert className="h-4 w-4 text-orange-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-orange-200">Answer engine temporarily unavailable</p>
                  <p className="text-xs text-orange-200/85 leading-relaxed mt-0.5">{quota.reason}</p>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-4 border-t border-slate-800">
              <button
                type="submit"
                disabled={isGeneratingQueries || !businessName || (quota ? !quota.available : false)}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition flex items-center gap-2 shadow-md shadow-indigo-600/20 disabled:opacity-50"
              >
                {isGeneratingQueries ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Generating Query Matrix...</span>
                  </>
                ) : (
                  <>
                    <span>Generate Viewer-Intent Queries</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </form>
        )}

        {/* STEP 2: Review & Edit Queries */}
        {step === 2 && (
          <div className="space-y-4 text-xs">
            <p className="text-slate-300">
              Review AI-suggested viewer-intent queries generated for <strong>{businessName}</strong>. You can add custom search terms or remove queries before starting the audit.
            </p>

            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {queries.map((q, idx) => (
                <div
                  key={idx}
                  className="bg-slate-950 border border-slate-800 p-3 rounded-lg flex items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="text-slate-200 font-semibold text-xs">
                      "{q.queryText}"
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400">
                      <span className="text-indigo-400 font-semibold">{q.intent}</span>
                      <span>•</span>
                      <span>Persona: {q.targetPersona}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemoveQuery(idx)}
                    className="text-slate-500 hover:text-rose-400 p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add Custom Query */}
            <div className="flex items-center gap-2 pt-2">
              <input
                type="text"
                placeholder="Add custom search query (e.g. 'Is Acme HIPAA compliant?')"
                value={newQueryText}
                onChange={(e) => setNewQueryText(e.target.value)}
                className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomQuery}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg"
              >
                Add Query
              </button>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg"
              >
                Back
              </button>

              <button
                type="button"
                onClick={handleExecuteAudit}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition flex items-center gap-2 shadow-md shadow-indigo-600/20"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Execute AI Search Audit Now</span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Animated Execution Progress */}
        {step === 3 && (
          <div className="py-8 text-center space-y-6">
            <div className="relative inline-flex items-center justify-center">
              <div className="w-16 h-16 rounded-full border-4 border-indigo-500/30 border-t-indigo-500 animate-spin" />
              <Sparkles className="h-6 w-6 text-indigo-400 absolute animate-pulse" />
            </div>

            <div className="space-y-2">
              <h4 className="text-base font-bold text-white">Auditing AI Search Engine Recommendations</h4>
              <p className="text-xs text-indigo-300 animate-pulse font-medium max-w-md mx-auto">
                {auditProgressMessage}
              </p>
            </div>

            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 text-left max-w-md mx-auto space-y-2 text-[11px] text-slate-400">
              <div className="flex items-center gap-2 text-emerald-400 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Query Intent Matrix Configured ({queries.length} Queries)</span>
              </div>
              <div className="flex items-center gap-2 text-indigo-400 font-medium">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                <span>Querying Perplexity, ChatGPT, Gemini & Claude</span>
              </div>
              <div className="flex items-center gap-2 text-slate-500">
                <span className="w-3.5 h-3.5 rounded-full border border-slate-600 inline-block" />
                <span>Calculating GEO Visibility Score & Prioritizing Remediation Plan</span>
              </div>
            </div>

            {errorMessage && (
              <div className="bg-rose-500/10 border border-rose-500/30 p-3 rounded-lg text-xs text-rose-300 flex items-center gap-2 justify-center">
                <ShieldAlert className="h-4 w-4 text-rose-400" />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
