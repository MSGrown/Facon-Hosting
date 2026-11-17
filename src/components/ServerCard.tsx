import React from 'react';
import { AlertTriangle, Clock, RotateCw, Play, Square, Terminal, Trash2 } from 'lucide-react';
import { BotServer } from '../types/hosting';
import { RunnerFleetSummary } from '../services/runnerService';
import { StatusIndicator } from './StatusIndicator';

interface ServerCardProps {
  server: BotServer;
  runnerSummary?: RunnerFleetSummary;
  onOpenConsole: (serverId: string) => void;
  onPowerAction: (server: BotServer, action: 'start' | 'stop' | 'restart') => Promise<unknown>;
  onDelete?: (server: BotServer) => Promise<void>;
  busy?: boolean;
}

function formatCompactUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

export function ServerCard({
  server,
  runnerSummary,
  onOpenConsole,
  onPowerAction,
  onDelete,
  busy = false,
}: ServerCardProps) {
  const cpuPct = Math.min(100, Math.round((server.cpuUsage / server.cpuLimitPct) * 100));
  const ramPct = Math.min(100, Math.round((server.ramUsageMb / server.ramLimitMb) * 100));
  const diskPct = Math.min(100, Math.round((server.diskUsageMb / server.diskLimitMb) * 100));

  const isRunning = server.status === 'running';
  const isRecovering = server.status === 'restarting' || server.status === 'starting';
  const isSuspended = server.status === 'suspended';

  const sessionUptime = isRunning ? server.uptimeSeconds : 0;
  const totalUptime = runnerSummary?.telemetry?.totalUptimeSeconds ?? sessionUptime;
  const offlineReason =
    !isRunning && !isSuspended
      ? runnerSummary?.health?.offlineReason || (runnerSummary?.state === 'crashed' ? 'Bot process crashed.' : null)
      : null;

  return (
    <article className="facon-glass facon-glass-hover rounded-xl p-5 flex flex-col gap-4">
      {/* Header Row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-white truncate">
            {server.name}
          </h3>
          <p className="text-xs text-zinc-400 mt-1 flex items-center gap-2 flex-wrap">
            <span>{server.appType}</span>
            <span aria-hidden="true">·</span>
            <span className="text-zinc-300">{server.runtime}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-zinc-500">{server.nodeRegion}</span>
          </p>
        </div>
        <StatusIndicator status={server.status} />
      </div>

      {/* Resource Telemetry Bars */}
      <div className="grid grid-cols-3 gap-4 pt-2 border-t border-white/[0.06]">
        <div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
            <span>CPU</span>
            <span className="font-mono text-zinc-200 tabular-nums">
              {server.cpuUsage}% / {server.cpuLimitPct}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.07] overflow-hidden">
            <div
              className="h-full rounded-full bg-[#00FFFF] transition-all duration-300"
              style={{ width: `${cpuPct}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
            <span>RAM</span>
            <span className="font-mono text-zinc-200 tabular-nums">
              {server.ramUsageMb >= 1024
                ? `${(server.ramUsageMb / 1024).toFixed(1)} GB`
                : `${server.ramUsageMb} MB`}{' '}
              / {Math.round(server.ramLimitMb / 1024)} GB
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.07] overflow-hidden">
            <div
              className="h-full rounded-full bg-[#00FFFF] transition-all duration-300"
              style={{ width: `${ramPct}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1.5">
            <span>Disk</span>
            <span className="font-mono text-zinc-200 tabular-nums">
              {server.diskUsageMb >= 1024
                ? `${(server.diskUsageMb / 1024).toFixed(2)} GB`
                : `${server.diskUsageMb} MB`}{' '}
              / {Math.round(server.diskLimitMb / 1024)} GB
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/[0.07] overflow-hidden">
            <div
              className="h-full rounded-full bg-zinc-400 transition-all duration-300"
              style={{ width: `${Math.max(2, diskPct)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Live Uptime & Offline/Recovery Status Strip */}
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-[#00FFFF]" />
            <span>
              {isRunning ? `Session: ${formatCompactUptime(sessionUptime)}` : 'Session: 0s'}
              {totalUptime > 0 ? ` · Lifetime: ${formatCompactUptime(totalUptime)}` : ''}
            </span>
          </span>
          {runnerSummary && runnerSummary.health.restartCount > 0 && (
            <span className="text-amber-300 tabular-nums">
              Recoveries: {runnerSummary.health.restartCount}
            </span>
          )}
        </div>

        {server.appType === 'Discord Bot' && (
          <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
            {isRunning && runnerSummary?.gateway?.connectionState === 'online' ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-300 truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {runnerSummary.gateway.botTag ? `${runnerSummary.gateway.botTag} · ` : 'Discord Online · '}
                  {runnerSummary.gateway.activityName
                    ? `${runnerSummary.gateway.activityType || 'Playing'} ${runnerSummary.gateway.activityName}`
                    : 'No Playing status set'}
                </span>
              </span>
            ) : isRunning && runnerSummary?.gateway?.connectionState === 'connecting' ? (
              <span className="inline-flex items-center gap-1.5 text-amber-300 truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />
                <span>Connecting to Discord Gateway...</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-zinc-500 truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-600 shrink-0" aria-hidden="true" />
                <span>Discord Offline · No Playing status</span>
              </span>
            )}
          </div>
        )}

        {offlineReason && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200 flex items-start gap-2 break-words [overflow-wrap:anywhere]">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0 mt-0.5" />
            <span>{offlineReason}</span>
          </div>
        )}
      </div>

      {/* Footer Controls */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            disabled={busy || isRunning || isSuspended}
            onClick={() => onPowerAction(server, 'start')}
            title="Start server"
            className="h-9 px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border border-white/10 bg-white/[0.03] text-zinc-200 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] disabled:opacity-35 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Start</span>
          </button>
          <button
            type="button"
            disabled={busy || isSuspended}
            onClick={() => onPowerAction(server, 'restart')}
            title="Restart server"
            className="h-9 px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border border-white/10 bg-white/[0.03] text-zinc-200 hover:border-amber-400/50 hover:text-amber-300 disabled:opacity-35 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Restart</span>
          </button>
          <button
            type="button"
            disabled={busy || (!isRunning && !isRecovering) || isSuspended}
            onClick={() => onPowerAction(server, 'stop')}
            title="Stop server"
            className="h-9 px-3 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border border-white/10 bg-white/[0.03] text-zinc-200 hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-35 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" />
            <span>Stop</span>
          </button>
          {onDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(server)}
              title="Delete server"
              className="h-9 w-9 rounded-lg inline-flex items-center justify-center border border-white/10 bg-white/[0.03] text-zinc-400 hover:border-rose-500/50 hover:text-rose-400 disabled:opacity-35 transition-colors shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onOpenConsole(server.id)}
          className="h-9 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-2 bg-[#00FFFF] text-black hover:bg-[#66FFFF] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Console</span>
        </button>
      </div>
    </article>
  );
}

