import React, { useState } from 'react';
import {
  Sparkles,
  Search,
  Globe,
  Building2,
  Users,
  ArrowRight,
  ShieldAlert,
  Layers,
  HelpCircle,
  BarChart3,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { AuditReport } from '../types';

interface CleanStartDashboardProps {
  onAuditComplete: (newReport: AuditReport) => void;
}

export const CleanStartDashboard: React.FC<CleanStartDashboardProps> = ({
  onAuditComplete,
}) => {
  const [businessName, setBusinessName] = useState('');
  const [domain, setDomain] = useState('');
  const [industry, setIndustry] = useState('');
  const [coreOfferings, setCoreOfferings] = useState('');
  const [competitorsText, setCompetitorsText] = useState('');
  const [manualQueriesInput, setManualQueriesInput] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [loadingStep, setLoadingStep] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sampleBrands = [
    {
      name: 'Stripe',
      domain: 'stripe.com',
      industry: 'Financial Tech & Payment Processing',
      offerings: 'Payment APIs, billing, invoicing, fraud prevention',
      competitors: 'Adyen, PayPal, Square, Braintree',
    },
    {
      name: 'Linear',
      domain: 'linear.app',
      industry: 'Software Development & Issue Tracking',
      offerings: 'Issue tracking, sprint planning, project management',
      competitors: 'Jira, Asana, GitHub Projects',
    },
    {
      name: 'Vercel',
      domain: 'vercel.com',
      industry: 'Cloud Hosting & Web Deployment',
      offerings: 'Next.js hosting, serverless functions, edge network',
      competitors: 'Netlify, AWS Amplify, Cloudflare Pages',
    },
    {
      name: 'Datadog',
      domain: 'datadoghq.com',
      industry: 'Cloud Observability & Monitoring',
      offerings: 'APM, log management, infrastructure monitoring',
      competitors: 'Dynatrace, New Relic, Grafana',
    },
  ];

  // Auto-detect brand details from URL or query string via server API
  const handleAutoDetectUrl = async (inputStr: string) => {
    if (!inputStr.trim()) return null;
    setIsDetecting(true);
    try {
      const res = await fetch('/api/audit/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputStr }),
      });
      const data = await res.json();
      if (data.details) {
        const d = data.details;
        setBusinessName(d.businessName || inputStr);
        if (d.domain) setDomain(d.domain);
        if (d.industry) setIndustry(d.industry);
        if (d.coreOfferings) setCoreOfferings(d.coreOfferings);
        if (d.competitors && Array.isArray(d.competitors)) {
          setCompetitorsText(d.competitors.join(', '));
        }
        return d;
      }
    } catch (err) {
      console.warn('Auto-detect URL error:', err);
    } finally {
      setIsDetecting(false);
    }
    return null;
  };

  const executeAudit = async (
    bName: string,
    bDomain: string,
    bIndustry: string,
    bOfferings: string,
    bCompetitors: string[]
  ) => {
    setIsLoading(true);
    setErrorMessage(null);
    setLoadingStep(1);
    setStatusMessage('Querying Gemini & live AI Search crawlers...');

    // Progress simulation
    const timer1 = setTimeout(() => {
      setLoadingStep(2);
      setStatusMessage('Testing commercial comparison & alternatives search queries...');
    }, 1200);

    const timer2 = setTimeout(() => {
      setLoadingStep(3);
      setStatusMessage('Analyzing AI hallucinations, inaccuracies, and citation sources...');
    }, 2500);

    const timer3 = setTimeout(() => {
      setLoadingStep(4);
      setStatusMessage('Calculating GEO Visibility Index and generating remediation plan...');
    }, 3800);

    try {
      // First generate targeted query matrix via real API
      const queryRes = await fetch('/api/audit/generate-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: bName,
          domain: bDomain,
          industry: bIndustry,
          coreOfferings: bOfferings,
          competitors: bCompetitors,
        }),
      });

      const queryData = await queryRes.json();
      const generatedQueries = queryData.queries || [];

      // Combine 3 auto-generated queries with any user manually typed queries
      const extraManualQueries = manualQueriesInput
        .split(',')
        .map((q) => q.trim())
        .filter(Boolean)
        .map((qText, idx) => ({
          id: `q-init-manual-${idx + 1}`,
          intent: 'feature_specific',
          queryText: qText,
          targetPersona: 'Target Customer',
          monthlySearchVolumeEstimate: '8,500/mo',
        }));

      const combinedQueries = [...generatedQueries, ...extraManualQueries];

      // Run live audit endpoint
      const auditRes = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: bName,
          domain: bDomain,
          industry: bIndustry,
          coreOfferings: bOfferings,
          targetAudience: 'Enterprise decision makers & procurement managers',
          competitors: bCompetitors,
          queries: combinedQueries,
        }),
      });

      const auditData = await auditRes.json();

      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);

      const reportObj = auditData.report || auditData;

      if (reportObj && reportObj.geoVisibilityScore !== undefined) {
        onAuditComplete(reportObj as AuditReport);
        return;
      } else {
        throw new Error('Audit API response missing expected report object.');
      }
    } catch (err: any) {
      console.error('Audit execution error:', err);
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
      setErrorMessage(err.message || 'Failed to complete live audit via API.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) return;

    let bName = businessName.trim();
    let bDomain = domain.trim();
    let bIndustry = industry.trim();
    let bOfferings = coreOfferings.trim();
    let comps = competitorsText
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    // Auto-detect if secondary fields are blank or URL was entered
    if (!bDomain || !bIndustry || !bOfferings || comps.length === 0) {
      const detected = await handleAutoDetectUrl(bName);
      if (detected) {
        bName = detected.businessName || bName;
        bDomain = detected.domain || bDomain;
        bIndustry = detected.industry || bIndustry;
        bOfferings = detected.coreOfferings || bOfferings;
        if (detected.competitors && Array.isArray(detected.competitors)) {
          comps = detected.competitors;
        }
      }
    }

    executeAudit(bName, bDomain, bIndustry, bOfferings, comps);
  };

  const handleSelectSample = (sample: typeof sampleBrands[0]) => {
    setBusinessName(sample.name);
    setDomain(sample.domain);
    setIndustry(sample.industry);
    setCoreOfferings(sample.offerings);
    setCompetitorsText(sample.competitors);

    const comps = sample.competitors.split(',').map((c) => c.trim()).filter(Boolean);
    executeAudit(sample.name, sample.domain, sample.industry, sample.offerings, comps);
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-10">
      {/* Hero Welcome Banner */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-xs font-semibold shadow-sm">
          <Sparkles className="h-4 w-4 text-indigo-400 animate-pulse" />
          <span>Generative Engine Optimization (GEO) & AI Search Studio</span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
          Audit Your Brand's AI Search Posture
        </h1>

        <p className="text-slate-300 text-sm max-w-2xl mx-auto leading-relaxed">
          Test real buyer intent queries across top AI search models (Gemini, ChatGPT, Perplexity, Claude, SearchGPT). Identify hallucinations, resolve omissions, and get an actionable remediation plan.
        </p>
      </div>

      {/* Main Clean Search Bar & Input Form Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-md space-y-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Main Primary Search Input */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="business-name-input" className="block text-xs font-bold uppercase tracking-wider text-slate-300">
                Business, Brand Name, or Website URL <span className="text-rose-400">*</span>
              </label>
              {businessName.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => handleAutoDetectUrl(businessName)}
                  disabled={isDetecting || isLoading}
                  className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 transition disabled:opacity-50"
                >
                  {isDetecting ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin text-indigo-400" />
                      <span>Fetching Live Brand Details...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3 text-indigo-400" />
                      <span>Auto-Detect from URL</span>
                    </>
                  )}
                </button>
              )}
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-indigo-400" />
              </div>
              <input
                id="business-name-input"
                type="text"
                required
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Paste website URL (e.g. https://stripe.com) or enter brand name (e.g. Linear, Vercel)..."
                className="w-full pl-12 pr-4 py-3.5 bg-slate-950 text-white text-base rounded-xl border border-slate-700/80 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition placeholder-slate-500 font-medium shadow-inner"
              />
            </div>
          </div>

          {/* Secondary Details (Expanded Form Grid) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            <div>
              <label htmlFor="domain-input" className="block text-xs font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-indigo-400" /> Website Domain
              </label>
              <input
                id="domain-input"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
                className="w-full px-3.5 py-2.5 bg-slate-950 text-slate-200 text-xs rounded-lg border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-600"
              />
            </div>

            <div>
              <label htmlFor="industry-input" className="block text-xs font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-indigo-400" /> Industry / Category
              </label>
              <input
                id="industry-input"
                type="text"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Fintech & Payment APIs"
                className="w-full px-3.5 py-2.5 bg-slate-950 text-slate-200 text-xs rounded-lg border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-600"
              />
            </div>

            <div>
              <label htmlFor="core-offerings-input" className="block text-xs font-semibold text-slate-400 mb-1.5">
                Core Offerings
              </label>
              <input
                id="core-offerings-input"
                type="text"
                value={coreOfferings}
                onChange={(e) => setCoreOfferings(e.target.value)}
                placeholder="Online payments, invoicing, fraud prevention"
                className="w-full px-3.5 py-2.5 bg-slate-950 text-slate-200 text-xs rounded-lg border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-600"
              />
            </div>

            <div>
              <label htmlFor="competitors-input" className="block text-xs font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-indigo-400" /> Key Competitors (Comma-separated)
              </label>
              <input
                id="competitors-input"
                type="text"
                value={competitorsText}
                onChange={(e) => setCompetitorsText(e.target.value)}
                placeholder="Adyen, PayPal, Square"
                className="w-full px-3.5 py-2.5 bg-slate-950 text-slate-200 text-xs rounded-lg border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-600"
              />
            </div>
          </div>

          {/* Optional Custom Target Search Queries */}
          <div className="pt-1">
            <label htmlFor="extra-queries-input" className="block text-xs font-semibold text-slate-400 mb-1.5 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" /> Custom Target Search Queries (Optional)
            </label>
            <input
              id="extra-queries-input"
              type="text"
              value={manualQueriesInput}
              onChange={(e) => setManualQueriesInput(e.target.value)}
              placeholder="e.g. Is Stripe SOC2 compliant?, Stripe vs Adyen enterprise pricing (comma-separated)"
              className="w-full px-3.5 py-2.5 bg-slate-950 text-slate-200 text-xs rounded-lg border border-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition placeholder-slate-600"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Appended alongside the 3 LLM auto-generated queries grounded in live web search data.
            </p>
          </div>

          {/* Submit Action Button */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoading || !businessName.trim()}
              className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-sm shadow-xl shadow-indigo-600/25 flex items-center justify-center gap-2.5 transition active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin text-white" />
                  <span>Running GEO Audit...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 text-indigo-200" />
                  <span>Run Live GEO Search Audit</span>
                  <ArrowRight className="h-4 w-4 text-indigo-200" />
                </>
              )}
            </button>
          </div>
        </form>

        {/* Live Loading Progress State */}
        {isLoading && (
          <div className="bg-slate-950 border border-indigo-500/30 p-5 rounded-xl space-y-3 animate-fade-in">
            <div className="flex items-center justify-between text-xs font-semibold text-indigo-300">
              <span className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                {statusMessage}
              </span>
              <span>Step {loadingStep} / 4</span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-800">
              <div
                className="bg-indigo-500 h-full rounded-full transition-all duration-500"
                style={{ width: `${(loadingStep / 4) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Quick Start One-Click Sample Chips */}
        {!isLoading && (
          <div className="pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Or test a 1-click sample brand
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {sampleBrands.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => handleSelectSample(sample)}
                  className="px-3 py-1.5 bg-slate-950 hover:bg-slate-800 text-slate-300 hover:text-white rounded-lg text-xs font-medium border border-slate-800 hover:border-indigo-500/50 flex items-center gap-1.5 transition active:scale-95"
                >
                  <Building2 className="h-3 w-3 text-indigo-400" />
                  <span>{sample.name}</span>
                  <span className="text-[10px] text-slate-500">({sample.domain})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Feature Highlights Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-2">
          <div className="h-9 w-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <Layers className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Query Intent Matrix</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Evaluates how Gemini, ChatGPT, Perplexity, Claude, and SearchGPT respond across 6 key buyer intent query types.
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-2">
          <div className="h-9 w-9 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Inaccuracy & Omission Defense</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Detects false claims, hallucinated pricing, and missing brand recommendations in commercial comparison queries.
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 space-y-2">
          <div className="h-9 w-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Prioritized Remediation</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Generates ready-to-deploy JSON-LD schema markup, FAQ matrices, and content fixes to boost AI search rankings.
          </p>
        </div>
      </div>
    </div>
  );
};
