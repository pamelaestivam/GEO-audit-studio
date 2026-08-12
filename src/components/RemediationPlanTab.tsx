import React, { useState } from 'react';
import { CheckSquare, Square, Code, Copy, Check, Sparkles, Filter, ChevronDown, ChevronUp, ExternalLink, Zap, AlertCircle } from 'lucide-react';
import { RemediationTask } from '../types';

interface RemediationPlanTabProps {
  remediationPlan: RemediationTask[];
  onToggleTaskComplete: (taskId: string) => void;
  highlightedTaskId?: string | null;
}

const PRIORITY_BADGES: Record<string, { bg: string; text: string }> = {
  'P0 Critical': { bg: 'bg-rose-500/20 border-rose-500/40', text: 'text-rose-300' },
  'P1 High': { bg: 'bg-amber-500/20 border-amber-500/40', text: 'text-amber-300' },
  'P2 Medium': { bg: 'bg-indigo-500/20 border-indigo-500/40', text: 'text-indigo-300' },
  'P3 Maintenance': { bg: 'bg-slate-800 border-slate-700', text: 'text-slate-300' },
};

export const RemediationPlanTab: React.FC<RemediationPlanTabProps> = ({
  remediationPlan = [],
  onToggleTaskComplete,
  highlightedTaskId,
}) => {
  const safeRemediationPlan = remediationPlan || [];
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(
    new Set(safeRemediationPlan.map((r) => r.id)) // Default all expanded for high visibility
  );

  const toggleExpand = (id: string) => {
    const next = new Set(expandedTaskIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedTaskIds(next);
  };

  const handleCopyCode = (id: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const filteredTasks = safeRemediationPlan.filter((task) => {
    if (selectedCategory === 'all') return true;
    return task.category === selectedCategory;
  });

  const completedCount = safeRemediationPlan.filter((r) => r.completed).length;

  return (
    <div className="space-y-6">
      {/* Header Banner & Remediation Stats */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-400" />
            <h3 className="text-base font-bold text-white">Prioritized Marketing Remediation Plan</h3>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Actionable fixes ranked by ROI impact to update LLM training corpora, fix schema entity data, and capture AI recommendations.
          </p>
        </div>

        {/* Progress Pill & Category Filter */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-200">
            <span>Progress: </span>
            <span className="text-indigo-400">
              {completedCount} / {safeRemediationPlan.length} Tasks Fixed
            </span>
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-300 text-xs rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          >
            <option value="all">All Categories</option>
            <option value="Schema Markup">Schema Markup</option>
            <option value="Digital PR & Aggregators">Digital PR & Aggregators</option>
            <option value="Content Entity Refactoring">Content Refactoring</option>
            <option value="Authority & Citations">Authority & Citations</option>
          </select>
        </div>
      </div>

      {/* Task List */}
      <div className="space-y-4">
        {filteredTasks.map((task) => {
          const isExpanded = expandedTaskIds.has(task.id);
          const isHighlighted = highlightedTaskId === task.id;
          const priorityBadge =
            (task.priority && PRIORITY_BADGES[task.priority]) ||
            (task.priority?.includes('P0') || task.priority?.includes('Critical')
              ? PRIORITY_BADGES['P0 Critical']
              : task.priority?.includes('P1') || task.priority?.includes('High')
              ? PRIORITY_BADGES['P1 High']
              : task.priority?.includes('P3') || task.priority?.includes('Maintenance')
              ? PRIORITY_BADGES['P3 Maintenance']
              : PRIORITY_BADGES['P2 Medium']);

          return (
            <div
              key={task.id}
              id={`task-${task.id}`}
              className={`bg-slate-900/90 border rounded-xl overflow-hidden shadow-lg transition duration-200 ${
                isHighlighted
                  ? 'border-indigo-500 ring-2 ring-indigo-500/50 bg-indigo-950/20'
                  : task.completed
                  ? 'border-emerald-500/30 bg-emerald-950/10 opacity-80'
                  : 'border-slate-800 hover:border-slate-700'
              }`}
            >
              {/* Task Title Header Row */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80">
                <div className="flex items-start gap-3 flex-1">
                  <button
                    onClick={() => onToggleTaskComplete(task.id)}
                    className="mt-0.5 text-slate-400 hover:text-indigo-400 transition"
                    title={task.completed ? 'Mark as Pending' : 'Mark as Fixed'}
                  >
                    {task.completed ? (
                      <CheckSquare className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <Square className="h-5 w-5" />
                    )}
                  </button>

                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2.5 py-0.5 rounded-md border text-[10px] font-bold ${priorityBadge.bg} ${priorityBadge.text}`}
                      >
                        {task.priority}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-medium border border-slate-700/60">
                        {task.category}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-800/60 text-slate-400 text-[10px]">
                        Effort: {task.effort}
                      </span>
                    </div>

                    <h4
                      onClick={() => toggleExpand(task.id)}
                      className={`text-sm font-bold cursor-pointer transition ${
                        task.completed
                          ? 'line-through text-slate-400'
                          : 'text-white hover:text-indigo-300'
                      }`}
                    >
                      {task.title}
                    </h4>
                  </div>
                </div>

                <div className="flex items-center gap-3 justify-between sm:justify-end">
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                    <Zap className="h-3 w-3" />
                    <span>{task.expectedGain}</span>
                  </span>

                  <button
                    onClick={() => toggleExpand(task.id)}
                    className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition"
                  >
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Task Details Collapsible Drawer */}
              {isExpanded && (
                <div className="p-5 bg-slate-950/60 space-y-4 text-xs text-slate-300">
                  <p className="text-slate-300 leading-relaxed text-sm">
                    {task.description}
                  </p>

                  {/* Step-by-Step Instructions */}
                  {task.stepByStepInstructions && task.stepByStepInstructions.length > 0 && (
                    <div className="space-y-2">
                      <span className="font-semibold text-slate-200 uppercase tracking-wider block text-[11px]">
                        Step-by-Step Execution Guide:
                      </span>
                      <ol className="list-decimal list-inside space-y-1.5 text-slate-300 bg-slate-900/90 p-3.5 rounded-lg border border-slate-800">
                        {task.stepByStepInstructions.map((step, idx) => (
                          <li key={idx} className="leading-relaxed">
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Copyable Schema Code Snippet */}
                  {task.codeSnippet && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-1.5 text-[11px]">
                          <Code className="h-3.5 w-3.5 text-indigo-400" />
                          <span>Structured JSON-LD Schema / HTML Code Snippet:</span>
                        </span>
                        <button
                          onClick={() => handleCopyCode(task.id, task.codeSnippet!)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 px-2.5 py-1 rounded border border-indigo-500/20 transition"
                        >
                          {copiedCodeId === task.id ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              <span className="text-emerald-400">Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>Copy Code Snippet</span>
                            </>
                          )}
                        </button>
                      </div>

                      <pre className="bg-slate-950 p-4 rounded-lg border border-slate-800 text-slate-300 font-mono text-[11px] overflow-x-auto">
                        <code>{task.codeSnippet}</code>
                      </pre>
                    </div>
                  )}

                  {/* Target URLs */}
                  {task.targetUrls && task.targetUrls.length > 0 && (
                    <div className="flex items-center gap-2 pt-1 text-[11px]">
                      <span className="font-semibold text-slate-400">Target Deployment URLs:</span>
                      <div className="flex flex-wrap gap-2">
                        {task.targetUrls.map((url, i) => (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-indigo-400 hover:underline inline-flex items-center gap-1"
                          >
                            <span>{url}</span>
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
