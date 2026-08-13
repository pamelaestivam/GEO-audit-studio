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

  // Handle task completion toggle with live score calculation adjustment
  const handleToggleTaskComplete = (taskId: string) => {
    if (!activeAuditId) return;

    setAudits((prevAudits) =>
      prevAudits.map((a) => {
        if (a.id !== activeAuditId) return a;

        const updatedTasks = (a.remediationPlan || []).map((task) =>
          task.id === taskId ? { ...task, completed: !task.completed } : task
        );

        // Calculate score gain based on completed tasks
        const completedCount = updatedTasks.filter((t) => t.completed).length;
        const totalCount = updatedTasks.length;
        const baseScore = a.geoVisibilityScore;
        const potentialGain = 100 - baseScore;
        const adjustedScore = Math.min(
          100,
          Math.round(baseScore + (completedCount / (totalCount || 1)) * (potentialGain * 0.6))
        );

        return {
          ...a,
          remediationPlan: updatedTasks,
          geoVisibilityScore: adjustedScore,
        };
      })
    );
  };

  const handleAddNewAudit = (newReport: AuditReport) => {
    setAudits((prev) => [newReport, ...prev]);
    setActiveAuditId(newReport.id);
    setActiveTab('queries');
  };

  const handleAppendQueryToAudit = (newQuery: import('./types').AuditQuery) => {
    if (!activeAuditId) return;

    setAudits((prevAudits) =>
      prevAudits.map((a) => {
        if (a.id !== activeAuditId) return a;

        const existingQueries = a.queriesTested || [];
        const updatedQueries = [...existingQueries, newQuery];

        // Recalculate GEO Visibility Index = (Number of queries where brand is cited / Total queries) * 100
        const citedQueriesCount = updatedQueries.filter((q) => {
          if (!q.engines) return false;
          return Object.values(q.engines).some((engRes) => {
            const res = engRes as import('./types').EngineResult;
            return (
              (res?.citations && res.citations.length > 0) ||
              (res?.status && res.status !== 'omitted')
            );
          });
        }).length;

        const totalQueries = updatedQueries.length;
        const newGeoScore = totalQueries > 0 ? Math.round((citedQueriesCount / totalQueries) * 100) : 0;

        // Only engines the backend actually queries count toward measured metrics.
        const ENGINES = ['Gemini'] as const;
        let appearedCount = 0;
        let leaderCount = 0;
        const totalPairs = updatedQueries.length * ENGINES.length;

        updatedQueries.forEach((q) => {
          ENGINES.forEach((eng) => {
            const res = q.engines ? q.engines[eng] : undefined;
            if (res && res.status !== 'omitted') {
              appearedCount++;
            }
            if (res && (res.status === 'recommended_leader' || res.position === 1)) {
              leaderCount++;
            }
          });
        });

        const newSov = totalPairs > 0 ? Math.round((appearedCount / totalPairs) * 100) : 0;
        const newLeader = totalPairs > 0 ? Math.round((leaderCount / totalPairs) * 100) : 0;

        return {
          ...a,
          queriesTested: updatedQueries,
          shareOfVoice: newSov,
          leaderShare: newLeader,
          geoVisibilityScore: newGeoScore,
        };
      })
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
                  />
                )}

                {activeTab === 'omissions' && (
                  <OmissionAnalysisTab omissions={activeAudit.omissions} />
                )}

                {activeTab === 'remediation' && (
                  <RemediationPlanTab
                    remediationPlan={activeAudit.remediationPlan}
                    onToggleTaskComplete={handleToggleTaskComplete}
                    highlightedTaskId={highlightedTaskId}
                  />
                )}

                {activeTab === 'competitors' && (
                  <CompetitorIntelligenceTab
                    competitors={activeAudit.competitorBenchmarks}
                    businessName={activeAudit.businessName}
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

