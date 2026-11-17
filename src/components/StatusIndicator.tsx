import React from 'react';
import { ServerStatus } from '../types/hosting';

interface StatusIndicatorProps {
  status: ServerStatus;
  compact?: boolean;
}

const STATUS_CONFIG: Record<
  ServerStatus,
  { label: string; dotClass: string; textClass: string; live: boolean }
> = {
  running: {
    label: 'Running',
    dotClass: 'bg-[#00FFFF]',
    textClass: 'text-[#00FFFF]',
    live: true,
  },
  stopped: {
    label: 'Stopped',
    dotClass: 'bg-zinc-500',
    textClass: 'text-zinc-400',
    live: false,
  },
  starting: {
    label: 'Starting',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-300',
    live: true,
  },
  restarting: {
    label: 'Restarting',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-300',
    live: true,
  },
  suspended: {
    label: 'Suspended',
    dotClass: 'bg-rose-500',
    textClass: 'text-rose-400',
    live: false,
  },
};

export function StatusIndicator({ status, compact = false }: StatusIndicatorProps) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.stopped;

  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${compact ? 'text-xs' : 'text-xs font-medium'}`}>
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {cfg.live && (
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${cfg.dotClass}`}
          />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.dotClass}`} />
      </span>
      <span className={cfg.textClass}>{cfg.label}</span>
    </span>
  );
}
