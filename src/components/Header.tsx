import React from 'react';
import { Search, Sparkles, Plus, Download, Bell, Activity, RefreshCw, Award } from 'lucide-react';
import { AuditReport } from '../types';

interface HeaderProps {
  audits: AuditReport[];
  activeAuditId: string | null;
  onSelectAudit: (id: string) => void;
  onOpenNewAuditModal: () => void;
  onOpenMonitoringModal: () => void;
  onExportReport: () => void;
  onResetToFreshSearch?: () => void;
  isLoading?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  audits,
  activeAuditId,
  onSelectAudit,
  onOpenNewAuditModal,
  onOpenMonitoringModal,
  onExportReport,
  onResetToFreshSearch,
  isLoading = false,
}) => {
  const activeAudit = audits.find((a) => a.id === activeAuditId) || audits[0] || null;

  return (
    <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-30 text-white shadow-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        {/* Brand & Home Reset Action */}
        <div className="flex items-center gap-3.5 cursor-pointer" onClick={onResetToFreshSearch}>
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 p-0.5 shadow-lg shadow-indigo-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-indigo-400 animate-pulse" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white hover:text-indigo-300 transition">GEO Audit Studio</h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                AI Search Monitor
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Generative Engine Optimization & Recommendation Remediation
            </p>
          </div>
        </div>

        {/* Audit Switcher Dropdown & Main Action Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Active Audit Dropdown Selector & Header GEO Badge */}
          {audits.length > 0 ? (
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={activeAuditId || ''}
                  onChange={(e) => onSelectAudit(e.target.value)}
                  className="bg-slate-800/90 text-slate-200 text-xs font-medium rounded-lg px-3 py-2 border border-slate-700/80 focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer pr-8 hover:border-slate-600 transition"
                  id="audit-selector"
                >
                  <optgroup label="Active Audit Benchmarks">
                    {audits.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.businessName} ({a.domain}) — GEO Score: {a.geoVisibilityScore}%
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              {activeAudit && (
                <div
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-950/90 border border-indigo-500/40 text-xs font-bold text-indigo-300 shadow-sm"
                  id="header-geo-score-badge"
                >
                  <Award className="h-3.5 w-3.5 text-indigo-400" />
                  <span>GEO Score: {activeAudit.geoVisibilityScore}%</span>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={onResetToFreshSearch}
              className="bg-slate-800/80 text-slate-400 text-xs font-medium rounded-lg px-3 py-2 border border-slate-700/60"
            >
              Fresh Search Dashboard
            </button>
          )}

          {/* Quick Refresh / New Audit */}
          <button
            onClick={onOpenNewAuditModal}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition active:scale-95 disabled:opacity-50"
            id="run-new-audit-btn"
          >
            {isLoading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            <span>Run New Audit</span>
          </button>

          {/* Monitoring Schedule */}
          <button
            onClick={onOpenMonitoringModal}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium border border-slate-700/70 transition"
            id="monitoring-modal-btn"
            title="Configure Weekly AI Search Sweeps & Alerts"
          >
            <Bell className="h-3.5 w-3.5 text-amber-400" />
            <span className="hidden sm:inline">Monitoring</span>
          </button>

          {/* Export Report */}
          <button
            onClick={onExportReport}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium border border-slate-700/70 transition"
            id="export-report-btn"
            title="Download Executive PDF Audit Report"
          >
            <Download className="h-3.5 w-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Export Audit</span>
          </button>
        </div>
      </div>
    </header>
  );
};
