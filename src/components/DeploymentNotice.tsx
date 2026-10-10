import React from 'react';
import { Info } from 'lucide-react';
import { useAuditStatus } from '../useQuotaStatus';
import { storageNotice } from '../statusView';

/**
 * A persistent line, on every page including sign-in, when this deployment's
 * storage does not survive a restart. A reload that loses an audit is a silent
 * failure unless it was said in advance. The condition is the server's own
 * answer, so a deployment with durable storage shows nothing.
 */
export const DeploymentNotice: React.FC = () => {
  const { storage } = useAuditStatus();
  const text = storageNotice(storage);
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="storage-notice"
      className="flex items-start gap-2 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 text-xs text-amber-200"
    >
      <Info className="h-4 w-4 text-amber-400 shrink-0 mt-px" />
      <p className="leading-relaxed">{text}</p>
    </div>
  );
};
