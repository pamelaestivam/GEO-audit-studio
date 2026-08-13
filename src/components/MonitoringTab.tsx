import React, { useState } from 'react';
import { Bell, Calendar, Mail, ShieldCheck, Activity, CheckCircle2, RefreshCw } from 'lucide-react';
import { MonitoringConfig, AuditReport } from '../types';

interface MonitoringTabProps {
  config: MonitoringConfig;
  onUpdateConfig: (newConfig: MonitoringConfig) => void;
  audit: AuditReport;
}

export const MonitoringTab: React.FC<MonitoringTabProps> = ({
  config,
  onUpdateConfig,
  audit,
}) => {
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [frequency, setFrequency] = useState(config?.frequency || 'weekly');
  const [alertThreshold, setAlertThreshold] = useState(config?.alertThreshold || 70);
  const [emails, setEmails] = useState((config?.notificationEmails || []).join(', '));
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: MonitoringConfig = {
      ...config,
      enabled,
      frequency,
      alertThreshold,
      notificationEmails: emails.split(',').map((e) => e.trim()).filter(Boolean),
    };
    onUpdateConfig(updated);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const history = audit.historicalScores || [
    { date: 'June 2026', score: 65, sov: 70 },
    { date: 'July 2026', score: 71, sov: 76 },
    { date: 'August 2026', score: audit.geoVisibilityScore, sov: audit.shareOfVoice },
  ];

  return (
    <div className="space-y-6">
      {/* Historical Score Line / Bar Chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-emerald-400" />
              <h3 className="text-base font-bold text-white">GEO Visibility Score History</h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Historical GEO Index tracking over time across automated weekly AI search sweeps.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 text-xs font-semibold border border-emerald-500/20">
            +16% Index Growth
          </span>
        </div>

        <div className="grid grid-cols-3 gap-4 pt-4">
          {history.map((h, i) => (
            <div
              key={i}
              className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 text-center space-y-2"
            >
              <span className="text-xs font-semibold text-slate-400 block">{h.date}</span>
              <div className="text-3xl font-black text-indigo-400">{h.score}</div>
              <p className="text-[11px] text-slate-500">SOV: {h.sov}%</p>
            </div>
          ))}
        </div>
      </div>

      {/* Monitoring Settings Form */}
      <form onSubmit={handleSave} className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Bell className="h-5 w-5 text-amber-400" />
              Automated AI Search Audit & Alert Settings
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Schedule recurring sweeps across Perplexity, ChatGPT, Gemini, and Claude to detect query drift or competitive drop-offs.
            </p>
          </div>

          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
          <div className="space-y-2">
            <label className="font-semibold text-slate-300 block">Sweep Frequency</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as any)}
              className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            >
              <option value="daily">Daily Automated Sweeps</option>
              <option value="weekly">Weekly Sweeps (Recommended)</option>
              <option value="biweekly">Bi-weekly Sweeps</option>
            </select>
            <p className="text-[11px] text-slate-500">
              Next scheduled audit run: <strong className="text-slate-300">{config.nextRunDate}</strong>
            </p>
          </div>

          <div className="space-y-2">
            <label className="font-semibold text-slate-300 block">
              Alert Trigger Threshold (GEO Score &lt; {alertThreshold})
            </label>
            <input
              type="range"
              min="50"
              max="90"
              value={alertThreshold}
              onChange={(e) => setAlertThreshold(Number(e.target.value))}
              className="w-full accent-indigo-500 cursor-pointer"
            />
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>50 (Permissive)</span>
              <span className="font-bold text-amber-400">{alertThreshold}%</span>
              <span>90 (Strict)</span>
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="font-semibold text-slate-300 block">
              Alert Recipient Email Addresses (Comma Separated)
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="marketing@company.com, seo@company.com"
                className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg pl-9 pr-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </div>
            <p className="text-[11px] text-slate-500">
              Receive automated executive digests whenever new inaccuracies or recommendation rank drops occur.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-slate-800">
          {savedSuccess ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              Monitoring preferences saved!
            </span>
          ) : (
            <span />
          )}

          <button
            type="submit"
            className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition shadow-md shadow-indigo-600/20"
          >
            Save Monitoring Settings
          </button>
        </div>
      </form>
    </div>
  );
};
