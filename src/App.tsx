import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Sidebar, TabType } from './components/Sidebar';
import { ExecutiveSummaryCard } from './components/ExecutiveSummaryCard';
import { QueryMatrixTab } from './components/QueryMatrixTab';
import { CitationSourceTab } from './components/CitationSourceTab';
import { InaccuraciesTab } from './components/InaccuraciesTab';
import { OmissionAnalysisTab } from './components/OmissionAnalysisTab';
import { RemediationPlanTab } from './components/RemediationPlanTab';
import { CompetitorIntelligenceTab } from './components/CompetitorIntelligenceTab';
import { MonitoringTab } from './components/MonitoringTab';
import { RunAuditModal } from './components/RunAuditModal';
import { ExportReportModal } from './components/ExportReportModal';
import { CleanStartDashboard } from './components/CleanStartDashboard';
import { AuthPage, type Session } from './components/AuthPage';
import { apiFetch, onSessionRejected, setAuthToken } from './apiClient';
import { useAuditStatus } from './useQuotaStatus';
import { DEFAULT_MONITORING_CONFIG } from './data/sampleAudits';
import { AuditReport, MonitoringConfig, User } from './types';
import { hasMeasurements, wasAssessed } from './reportView';

// A new key: sessions saved under the old placeholder-auth key were never real
// (any email and password was accepted), so they are not carried over.
const SESSION_STORAGE_KEY = 'geo_session_v2';
const LEGACY_AUTH_KEY = 'geo_radar_user_session';

function readStoredSession(): Session | null {
  try {
    localStorage.removeItem(LEGACY_AUTH_KEY);
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    if (!session?.token || !session?.user?.email || !(session.expiresAt > Date.now())) return null;
    return session;
  } catch {
    return null;
  }
}

/** A list entry from /api/audits, shaped like a report whose detail is not loaded yet. */
function fromSummary(summary: any): AuditReport {
  return {
    ...summary,
    competitors: [],
    coreOfferings: '',
    targetAudience: '',
    executiveSummary: '',
    queriesTested: [],
    inaccuracies: [],
    omissions: [],
    remediationPlan: [],
    competitorBenchmarks: [],
    saved: true,
    summaryOnly: true,
  } as AuditReport;
}

export default function App() {
  // The session is a signed token the server issued - not a user object the
  // browser made up. It is re-validated with the server on load below.
  const [session, setSession] = useState<Session | null>(() => {
    const stored = readStoredSession();
    if (stored) setAuthToken(stored.token);
    return stored;
  });
  const user: User | null = session?.user ?? null;
  const [signedOutNotice, setSignedOutNotice] = useState<string | null>(null);

  const { storage } = useAuditStatus();
  // Unknown (still loading) is treated as "not saved" only for the leave-page
  // guard, which errs towards protecting the audit.
  const durable = storage?.durable === true;

  const [audits, setAudits] = useState<AuditReport[]>([]);
  const [activeAuditId, setActiveAuditId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('queries');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [monitoringConfig, setMonitoringConfig] = useState<MonitoringConfig>(DEFAULT_MONITORING_CONFIG);

  // Modals
  const [isNewAuditModalOpen, setIsNewAuditModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  const endSession = (notice: string | null) => {
    setAuthToken(null);
    setSession(null);
    setAudits([]);
    setActiveAuditId(null);
    setSignedOutNotice(notice);
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (err) {
      console.warn('Failed to clear user session:', err);
    }
  };

  const handleLoginSuccess = (next: Session) => {
    setAuthToken(next.token);
    setSignedOutNotice(null);
    setSession(next);
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn('Failed to persist user session:', err);
    }
  };

  const handleSignOut = () => endSession(null);

  // The server ending the session (expired, or the access code was withdrawn)
  // returns the person to sign-in with the reason, from any screen.
  useEffect(() => {
    onSessionRejected((message) => endSession(message));
    return () => onSessionRejected(null);
  }, []);

  // On sign-in or reload: confirm the stored session with the server, then
  // bring back this person's saved audits. A network failure here must not
  // sign anyone out - only an explicit 401 does (handled above).
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/audits', { retries: 2 });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        setLoadError(null);
        setAudits((prev) => {
          const have = new Set(prev.map((a) => a.id));
          return [...prev, ...(data.audits || []).filter((a: any) => !have.has(a.id)).map(fromSummary)];
        });
      } catch {
        if (!cancelled) setLoadError('Your saved audits could not be loaded. Check your connection and reload.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  // "Fresh search" must actually leave the current audit. It used to clear the
  // selection and then fall straight back to the newest audit, so the button
  // did nothing once any audit existed.
  const [freshSearch, setFreshSearch] = useState(false);
  const activeAudit = freshSearch
    ? null
    : audits.find((a) => a.id === activeAuditId) || (audits.length > 0 ? audits[0] : null);

  // Opening a saved audit fetches its full report (the list carries headline
  // numbers only, so loading a long history stays cheap).
  useEffect(() => {
    if (!activeAudit?.summaryOnly) return;
    const id = activeAudit.id;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/audits/${encodeURIComponent(id)}`, { retries: 2 });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.audit) {
          setAudits((prev) => prev.map((a) => (a.id === id ? { ...data.audit, saved: true } : a)));
        } else if (res.status === 404) {
          setAudits((prev) => prev.filter((a) => a.id !== id));
        } else {
          setLoadError(data.error || 'That audit could not be loaded.');
        }
      } catch {
        if (!cancelled) setLoadError('That audit could not be loaded. Check your connection and try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAudit?.id, activeAudit?.summaryOnly]);

  const handleDeleteAudit = async (id: string) => {
    if (!window.confirm('Delete this saved audit? This cannot be undone.')) return;
    try {
      const res = await apiFetch(`/api/audits/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || 'That audit could not be deleted. Please try again.');
        return;
      }
      setAudits((prev) => prev.filter((a) => a.id !== id));
      setActiveAuditId(null);
    } catch {
      setLoadError('That audit could not be deleted. Check your connection and try again.');
    }
  };

  // When storage is not durable (a serverless host, or no DATA_DIR), a refresh
  // destroys a finished audit, so ask before the page goes away. With durable
  // storage the audit is on the server and the guard would only be noise.
  useEffect(() => {
    if (audits.length === 0 || durable) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [audits.length, durable]);

  /**
   * On phones the navigation sits above the dashboard, so changing module
   * swapped content the user could not see and read as a dead button. Bring the
   * new module into view; on wider screens both are visible already.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [activeTab]);

  // Reset to clean search bar
  const handleResetToFreshSearch = () => {
    setFreshSearch(true);
    setActiveAuditId(null);
  };

  // Mark a remediation task done. This only tracks the user's own progress.
  // It used to also raise `geoVisibilityScore` by a made-up share of the
  // remaining gap, so ticking a checkbox moved a number presented as a
  // measurement. Visibility only changes when answer engines are re-queried.
  const handleToggleTaskComplete = (taskId: string) => {
    if (!activeAuditId) return;

    setAudits((prevAudits) =>
      prevAudits.map((a) =>
        a.id !== activeAuditId
          ? a
          : {
              ...a,
              remediationPlan: (a.remediationPlan || []).map((task) =>
                task.id === taskId ? { ...task, completed: !task.completed } : task
              ),
            }
      )
    );
  };

  const handleAddNewAudit = (newReport: AuditReport) => {
    setAudits((prev) => [newReport, ...prev]);
    setFreshSearch(false);
    setActiveAuditId(newReport.id);
    setActiveTab('queries');
  };

  // A query added after the audit is shown in the Query Matrix with its own
  // measured result, but it does NOT move the headline metrics.
  //
  // This used to recompute visibility, share of voice and leader share in the
  // browser with different definitions from the server's: it counted a
  // "no data" (retrieval_failed) engine result as the brand appearing, divided
  // by a hardcoded engine list of just Gemini, and reported the appearance rate
  // as "share of voice". Share of voice needs every vendor named in every
  // answer, which only the server computes, so the honest options are a
  // server-side recompute or leaving the figures alone and saying so. This is
  // the latter; the card tells the reader how many queries are not included.
  const handleAppendQueryToAudit = (newQuery: import('./types').AuditQuery) => {
    if (!activeAuditId) return;

    setAudits((prevAudits) =>
      prevAudits.map((a) =>
        a.id !== activeAuditId
          ? a
          : {
              ...a,
              queriesTested: [...(a.queriesTested || []), newQuery],
              queriesAddedAfterAudit: (a.queriesAddedAfterAudit || 0) + 1,
            }
      )
    );
  };

  const handleJumpToRemediationTask = (taskId: string) => {
    setHighlightedTaskId(taskId);
    setActiveTab('remediation');
    setTimeout(() => {
      const elem = document.getElementById(`task-${taskId}`);
      if (elem) elem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  };

  // Auth Gatekeeper Check: Hide main dashboard behind authentication
  if (!user) {
    return <AuthPage onLoginSuccess={handleLoginSuccess} notice={signedOutNotice} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white flex flex-col pb-12">
      {/* Top Header */}
      <Header
        audits={audits}
        activeAuditId={activeAuditId}
        onSelectAudit={(id) => {
          setFreshSearch(false);
          setActiveAuditId(id);
        }}
        onOpenNewAuditModal={() => setIsNewAuditModalOpen(true)}
        onOpenMonitoringModal={() => setActiveTab('monitoring')}
        onExportReport={() => setIsExportModalOpen(true)}
        onResetToFreshSearch={handleResetToFreshSearch}
      />

      {/* Main Workspace Layout with Vertical Sidebar on Left */}
      <div className="flex-1 flex flex-col md:flex-row min-w-0">
        {/* Left Vertical Sidebar Menu */}
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          audit={activeAudit}
          onResetToFreshSearch={handleResetToFreshSearch}
          user={user}
          onSignOut={handleSignOut}
        />

        {/* Main Dashboard Area on Right */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 min-w-0 max-w-7xl mx-auto w-full">
          {loadError && (
            <div role="alert" className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-medium">
              {loadError}
            </div>
          )}
          {activeAudit?.summaryOnly ? (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-10 text-center text-sm text-slate-300">
              Loading {activeAudit.businessName}...
            </div>
          ) : activeAudit ? (
            <>
              {/* Executive Summary Card */}
              <ExecutiveSummaryCard audit={activeAudit} onNavigate={setActiveTab} onDelete={handleDeleteAudit} />

              {/* Active Module Content Pane */}
              <div className="mt-6 scroll-mt-4" ref={contentRef}>
                {activeTab === 'queries' && (
                  <QueryMatrixTab
                    queries={activeAudit.queriesTested}
                    businessName={activeAudit.businessName}
                    audit={activeAudit}
                    onAppendQueryToAudit={handleAppendQueryToAudit}
                  />
                )}

                {activeTab === 'sources' && <CitationSourceTab audit={activeAudit} />}

                {activeTab === 'inaccuracies' && (
                  <InaccuraciesTab
                    inaccuracies={activeAudit.inaccuracies}
                    onSelectRemediationTask={handleJumpToRemediationTask}
                    assessed={wasAssessed(activeAudit)}
                  />
                )}

                {activeTab === 'omissions' && (
                  <OmissionAnalysisTab omissions={activeAudit.omissions} assessed={wasAssessed(activeAudit)} />
                )}

                {activeTab === 'remediation' && (
                  <RemediationPlanTab
                    remediationPlan={activeAudit.remediationPlan}
                    onToggleTaskComplete={handleToggleTaskComplete}
                    highlightedTaskId={highlightedTaskId}
                    assessed={wasAssessed(activeAudit)}
                  />
                )}

                {activeTab === 'competitors' && (
                  <CompetitorIntelligenceTab
                    competitors={activeAudit.competitorBenchmarks}
                    businessName={activeAudit.businessName}
                    measured={hasMeasurements(activeAudit)}
                  />
                )}

                {activeTab === 'monitoring' && (
                  <MonitoringTab
                    config={monitoringConfig}
                    onUpdateConfig={setMonitoringConfig}
                    audit={activeAudit}
                  />
                )}
              </div>
            </>
          ) : (
            /* Clean Start Empty Search Dashboard State */
            <CleanStartDashboard onAuditComplete={handleAddNewAudit} />
          )}
        </main>
      </div>

      {/* Modals */}
      <RunAuditModal
        isOpen={isNewAuditModalOpen}
        onClose={() => setIsNewAuditModalOpen(false)}
        onAuditComplete={handleAddNewAudit}
      />

      {activeAudit && (
        <ExportReportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          audit={activeAudit}
        />
      )}
    </div>
  );
}

