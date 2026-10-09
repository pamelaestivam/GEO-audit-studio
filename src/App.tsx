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
import { AuthPage } from './components/AuthPage';
import { DEFAULT_MONITORING_CONFIG } from './data/sampleAudits';
import { AuditReport, MonitoringConfig, User } from './types';
import { hasMeasurements, wasAssessed } from './reportView';

const AUTH_STORAGE_KEY = 'geo_radar_user_session';

export default function App() {
  // Persistent user authentication state
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [audits, setAudits] = useState<AuditReport[]>([]);
  const [activeAuditId, setActiveAuditId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('queries');

  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [monitoringConfig, setMonitoringConfig] = useState<MonitoringConfig>(DEFAULT_MONITORING_CONFIG);

  // Modals
  const [isNewAuditModalOpen, setIsNewAuditModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  const handleLoginSuccess = (loggedInUser: User) => {
    setUser(loggedInUser);
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(loggedInUser));
    } catch (err) {
      console.warn('Failed to persist user session:', err);
    }
  };

  const handleSignOut = () => {
    setUser(null);
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (err) {
      console.warn('Failed to clear user session:', err);
    }
  };

  const activeAudit = audits.find((a) => a.id === activeAuditId) || (audits.length > 0 ? audits[0] : null);

  // Audits exist only in this tab's memory (TECH_DEBT.md 2.1). Until they are
  // persisted, a refresh silently destroys a finished - and paid-for - audit,
  // so ask before the page goes away.
  useEffect(() => {
    if (audits.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [audits.length]);

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
    return <AuthPage onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white flex flex-col pb-12">
      {/* Top Header */}
      <Header
        audits={audits}
        activeAuditId={activeAuditId}
        onSelectAudit={setActiveAuditId}
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
          {activeAudit ? (
            <>
              {/* Executive Summary Card */}
              <ExecutiveSummaryCard audit={activeAudit} onNavigate={setActiveTab} />

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

