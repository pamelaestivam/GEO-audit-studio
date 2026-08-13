import React from 'react';
import {
  Layers,
  ShieldAlert,
  HelpCircle,
  Sparkles,
  BarChart3,
  Bell,
  Building2,
  TrendingUp,
  LogOut,
  User as UserIcon,
} from 'lucide-react';
import { AuditReport, User } from '../types';

export type TabType =
  | 'queries'
  | 'inaccuracies'
  | 'omissions'
  | 'remediation'
  | 'competitors'
  | 'monitoring';

interface SidebarProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
  audit: AuditReport | null;
  onResetToFreshSearch?: () => void;
  user?: User | null;
  onSignOut?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  audit,
  onResetToFreshSearch,
  user,
  onSignOut,
}) => {
  const pendingRemediationCount = audit
    ? (audit.remediationPlan || []).filter((r) => !r.completed).length
    : 0;
  const totalInaccuracies = audit ? (audit.inaccuracies || []).length : 0;
  const totalOmissions = audit ? (audit.omissions || []).length : 0;
  const totalQueries = audit ? (audit.queriesTested || []).length : 0;

  const navItems = [
    {
      id: 'queries' as TabType,
      label: 'Query Intent Matrix',
      icon: Layers,
      badge: totalQueries,
      badgeStyle: 'bg-slate-800 text-slate-300',
      activeColor: 'border-l-4 border-indigo-500 bg-indigo-500/10 text-indigo-400',
    },
    {
      id: 'inaccuracies' as TabType,
      label: 'Inaccuracies & Hallucinations',
      icon: ShieldAlert,
      badge: totalInaccuracies > 0 ? totalInaccuracies : null,
      badgeStyle: 'bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30',
      activeColor: 'border-l-4 border-rose-500 bg-rose-500/10 text-rose-400',
    },
    {
      id: 'omissions' as TabType,
      label: 'Omission Analysis',
      icon: HelpCircle,
      badge: totalOmissions,
      badgeStyle: 'bg-slate-800 text-slate-300',
      activeColor: 'border-l-4 border-amber-500 bg-amber-500/10 text-amber-400',
    },
    {
      id: 'remediation' as TabType,
      label: 'Prioritized Remediation Plan',
      icon: Sparkles,
      badge: pendingRemediationCount > 0 ? pendingRemediationCount : null,
      badgeStyle: 'bg-indigo-500/20 text-indigo-300 font-bold border border-indigo-500/30',
      activeColor: 'border-l-4 border-indigo-500 bg-indigo-500/10 text-indigo-400',
      iconPulse: true,
    },
    {
      id: 'competitors' as TabType,
      label: 'Competitor Intelligence',
      icon: BarChart3,
      badge: audit ? (audit.competitorBenchmarks || []).length : 0,
      badgeStyle: 'bg-slate-800 text-slate-300',
      activeColor: 'border-l-4 border-blue-500 bg-blue-500/10 text-blue-400',
    },
    {
      id: 'monitoring' as TabType,
      label: 'Continuous Sweeps',
      icon: Bell,
      badge: audit ? 'Active' : null,
      badgeStyle: 'bg-emerald-500/20 text-emerald-400 text-[10px] font-semibold border border-emerald-500/30',
      activeColor: 'border-l-4 border-emerald-500 bg-emerald-500/10 text-emerald-400',
    },
  ];

  return (
    <aside className="w-full md:w-64 lg:w-72 bg-slate-900/90 border-r border-slate-800 flex-shrink-0 flex flex-col justify-between p-4 md:min-h-[calc(100vh-65px)]">
      <div className="space-y-6">
        {/* Active Entity Quick Snapshot */}
        {audit ? (
          <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3.5 shadow-inner">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400 flex items-center gap-1">
                <Building2 className="h-3 w-3" /> Active Entity
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center gap-1">
                <TrendingUp className="h-2.5 w-2.5" /> GEO {audit.geoVisibilityScore}%
              </span>
            </div>
            <div className="font-bold text-sm text-slate-100 truncate" title={audit.businessName}>
              {audit.businessName}
            </div>
            <div className="text-xs text-slate-400 truncate">{audit.domain}</div>
          </div>
        ) : (
          <div className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3.5 shadow-inner text-center space-y-2">
            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400 flex items-center justify-center gap-1">
              <Building2 className="h-3 w-3" /> Fresh Workspace
            </span>
            <p className="text-xs text-slate-400">
              No brand audit active yet. Use the search bar to run a fresh audit.
            </p>
            {onResetToFreshSearch && (
              <button
                onClick={onResetToFreshSearch}
                className="w-full py-1.5 px-3 rounded bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs font-semibold border border-indigo-500/30 transition"
              >
                + Start Fresh Audit
              </button>
            )}
          </div>
        )}

        {/* Vertical Navigation Options */}
        <div>
          <div className="px-3 mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Dashboard Modules
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => onSelectTab(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-3 rounded-lg text-xs font-semibold transition-all duration-150 ${
                    isActive
                      ? `${item.activeColor} shadow-sm`
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border-l-4 border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon
                      className={`h-4 w-4 flex-shrink-0 ${
                        isActive ? 'text-current' : 'text-slate-400'
                      } ${item.iconPulse ? 'animate-pulse' : ''}`}
                    />
                    <span className="truncate text-left">{item.label}</span>
                  </div>

                  {item.badge !== null && item.badge !== undefined && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] ml-2 flex-shrink-0 ${item.badgeStyle}`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Sidebar Footer & User Profile UI Badge */}
      <div className="pt-4 mt-6 border-t border-slate-800/80 space-y-3">
        {user && (
          <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-3 shadow-inner space-y-2.5">
            <div className="flex items-center gap-2.5">
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name}
                  className="h-8 w-8 rounded-full border border-indigo-500/40 object-cover shrink-0"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 font-bold text-xs flex items-center justify-center shrink-0">
                  {user.name ? user.name.slice(0, 2).toUpperCase() : 'AU'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-slate-100 truncate" title={user.name}>
                  {user.name}
                </div>
                <div className="text-[10px] text-slate-400 truncate" title={user.email}>
                  {user.email}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
              <span className="text-[10px] font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20 truncate max-w-[100px]">
                {user.role || 'GEO Auditor'}
              </span>

              {onSignOut && (
                <button
                  type="button"
                  onClick={onSignOut}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 text-[11px] font-semibold border border-rose-500/30 transition shrink-0"
                  title="Sign Out of Session"
                >
                  <LogOut className="h-3 w-3" />
                  <span>Sign Out</span>
                </button>
              )}
            </div>
          </div>
        )}

        <div className="text-[11px] text-slate-500 flex items-center justify-between px-1">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Live Engine Sweeps
          </span>
          <span className="text-[10px] text-slate-500 font-mono">v2.4</span>
        </div>
      </div>
    </aside>
  );
};
