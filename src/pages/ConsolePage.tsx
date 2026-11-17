import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Play,
  Radio,
  RefreshCw,
  RotateCw,
  Send,
  ShieldCheck,
  Sliders,
  Square,
  Terminal as TerminalIcon,
  Trash2,
} from 'lucide-react';
import { AppPage, BotServer, ServerLog, ServerStatus } from '../types/hosting';
import { StatusIndicator } from '../components/StatusIndicator';
import { TelemetryChart, TelemetryPoint } from '../components/TelemetryChart';
import { appendServerLog, subscribeToServerLogs, updateServerStartup } from '../services/hostingService';
import {
  CLOUD_RUN_24X7_DEPLOY_COMMAND,
  connectRunnerStream,
  DiscordGatewayStatus,
  getBackendRunnerStatus,
  getHostHealth,
  HostCapabilities,
  HostHealthReport,
  RunnerFleetSummary,
  RunnerHealthStatus,
  RunnerLogEntry,
  RunnerProcessState,
  RunnerSnapshot,
  RunnerTelemetry,
  sendBackendStdin,
  verifyServerDiscordGateway,
} from '../services/runnerService';

interface ConsolePageProps {
  server: BotServer | null;
  fleetSummary?: RunnerFleetSummary;
  cpuHistory: TelemetryPoint[];
  ramHistory: TelemetryPoint[];
  diskHistory: TelemetryPoint[];
  onPowerAction: (server: BotServer, action: 'start' | 'stop' | 'restart') => Promise<RunnerSnapshot | void>;
  onNavigate: (page: AppPage) => void;
}

function formatUptime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

function formatTimeLabel(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

export function ConsolePage({
  server,
  fleetSummary,
  cpuHistory,
  ramHistory,
  diskHistory,
  onPowerAction,
  onNavigate,
}: ConsolePageProps) {
  const [auditLogs, setAuditLogs] = useState<ServerLog[]>([]);
  const [runnerLogs, setRunnerLogs] = useState<RunnerLogEntry[]>([]);
  const [runnerState, setRunnerState] = useState<RunnerProcessState>(
    () => fleetSummary?.state || (server?.status === 'running' ? 'running' : server?.status === 'starting' ? 'starting' : 'stopped')
  );
  const [runnerEnabled, setRunnerEnabled] = useState<boolean>(
    () => Boolean(fleetSummary?.enabled ?? (server?.status === 'running' || server?.status === 'starting'))
  );
  const [runnerPid, setRunnerPid] = useState<number | null>(() => fleetSummary?.pid ?? null);
  const [exitCode, setExitCode] = useState<number | null>(() => fleetSummary?.exitCode ?? null);
  const [wsConnected, setWsConnected] = useState(false);
  const [streamTransport, setStreamTransport] = useState<'ws' | 'sse' | 'http' | 'reconnecting'>('reconnecting');
  const [runnerTelemetry, setRunnerTelemetry] = useState<RunnerTelemetry | null>(
    () => fleetSummary?.telemetry ?? null
  );
  const [gateway, setGateway] = useState<DiscordGatewayStatus | null>(
    () => fleetSummary?.gateway ?? null
  );
  const [health, setHealth] = useState<RunnerHealthStatus | null>(
    () => fleetSummary?.health ?? null
  );
  const [hostCaps, setHostCaps] = useState<HostCapabilities | null>(null);
  const [hostHealth, setHostHealth] = useState<HostHealthReport | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [liveCpuSeries, setLiveCpuSeries] = useState<TelemetryPoint[]>([]);
  const [liveRamSeries, setLiveRamSeries] = useState<TelemetryPoint[]>([]);
  const [liveDiskSeries, setLiveDiskSeries] = useState<TelemetryPoint[]>([]);

  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [togglingAlwaysOnline, setTogglingAlwaysOnline] = useState(false);
  const [verifyingDiscord, setVerifyingDiscord] = useState(false);
  const [copiedPingUrl, setCopiedPingUrl] = useState(false);
  const [copiedDeployCmd, setCopiedDeployCmd] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const terminalBoxRef = useRef<HTMLDivElement | null>(null);
  const clearedLogIdsRef = useRef<Set<string>>(new Set());

  const appendLocalLog = (level: RunnerLogEntry['level'], message: string) => {
    const entry: RunnerLogEntry = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    setRunnerLogs((prev) => [...prev.slice(-299), entry]);
  };

  const mergeRunnerLogs = (prev: RunnerLogEntry[], incoming: RunnerLogEntry[]): RunnerLogEntry[] => {
    const filteredIncoming = incoming.filter((e) => !clearedLogIdsRef.current.has(e.id));

    if (filteredIncoming.length === 0) {
      return prev;
    }

    const seen = new Set<string>();
    const combined: RunnerLogEntry[] = [];
    for (const item of filteredIncoming) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        combined.push(item);
      }
    }
    for (const item of prev) {
      if (item.id.startsWith('local_') && item.level === 'stderr' && !seen.has(item.id)) {
        seen.add(item.id);
        combined.push(item);
      }
    }
    return combined.slice(-300);
  };

  const applySnapshot = (snapshot: RunnerSnapshot) => {
    setRunnerState(snapshot.state);
    setRunnerEnabled(snapshot.enabled);
    setRunnerPid(snapshot.pid);
    setExitCode(snapshot.exitCode);
    setRunnerTelemetry(snapshot.telemetry);
    setGateway(snapshot.gateway);
    setHealth(snapshot.health);
    setHostCaps(snapshot.hostCapabilities);
    setRunnerLogs((prev) => mergeRunnerLogs(prev, snapshot.logs));
  };

  const keepalivePingUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/api/ping';
    return `${window.location.origin}/api/ping`;
  }, []);

  const handleCopyPingUrl = async () => {
    try {
      await navigator.clipboard.writeText(keepalivePingUrl);
      setCopiedPingUrl(true);
      window.setTimeout(() => setCopiedPingUrl(false), 2000);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const handleCopyDeployCmd = async () => {
    try {
      await navigator.clipboard.writeText(CLOUD_RUN_24X7_DEPLOY_COMMAND);
      setCopiedDeployCmd(true);
      window.setTimeout(() => setCopiedDeployCmd(false), 2000);
    } catch {
      // ignore clipboard restrictions
    }
  };

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshHostHealth = async () => {
      try {
        const report = await getHostHealth();
        if (!cancelled) setHostHealth(report);
      } catch {
        // ignore transient health check errors
      }
    };
    void refreshHostHealth();
    const id = window.setInterval(() => void refreshHostHealth(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Subscribe to Firestore audit logs
  useEffect(() => {
    if (!server) {
      setAuditLogs([]);
      return;
    }
    const unsub = subscribeToServerLogs(server.id, setAuditLogs);
    return () => unsub();
  }, [server?.id]);

  // Sync authoritative fleet summary into Console whenever fleet updates and no live stream snapshot has superseded it
  useEffect(() => {
    if (!fleetSummary || powerBusy) return;
    if (!wsConnected) {
      setRunnerState(fleetSummary.state);
      setRunnerEnabled(fleetSummary.enabled);
      setRunnerPid(fleetSummary.pid);
      setExitCode(fleetSummary.exitCode);
      setRunnerTelemetry(fleetSummary.telemetry);
      setGateway(fleetSummary.gateway);
      setHealth(fleetSummary.health);
    }
  }, [fleetSummary, wsConnected, powerBusy]);

  // Subscribe to real-time WebSocket / SSE stdout/stderr & Gateway status stream
  useEffect(() => {
    clearedLogIdsRef.current.clear();
    if (!server) {
      setRunnerLogs([]);
      setRunnerState('stopped');
      setRunnerEnabled(false);
      setRunnerPid(null);
      setExitCode(null);
      setRunnerTelemetry(null);
      setGateway(null);
      setHealth(null);
      setWsConnected(false);
      setStreamTransport('reconnecting');
      return;
    }

    setRunnerLogs([]);
    setLiveCpuSeries([]);
    setLiveRamSeries([]);
    setLiveDiskSeries([]);
    setActionError(null);
    if (fleetSummary) {
      setRunnerState(fleetSummary.state);
      setRunnerEnabled(fleetSummary.enabled);
      setRunnerPid(fleetSummary.pid);
      setExitCode(fleetSummary.exitCode);
      setRunnerTelemetry(fleetSummary.telemetry);
      setGateway(fleetSummary.gateway);
      setHealth(fleetSummary.health);
    }

    const disconnect = connectRunnerStream(server.id, {
      onConnectionChange: (connected, transport) => {
        setWsConnected(connected);
        if (transport) {
          setStreamTransport(transport);
        } else {
          setStreamTransport(connected ? 'ws' : 'reconnecting');
        }
      },
      onInit: (snapshot) => {
        applySnapshot(snapshot);
      },
      onLog: (entry) => {
        setRunnerLogs((prev) => {
          if (prev.some((e) => e.id === entry.id)) return prev;
          return [...prev.slice(-299), entry];
        });
      },
      onState: (payload) => {
        setRunnerState(payload.state);
        if (payload.state === 'running' || payload.state === 'starting') {
          setRunnerEnabled(true);
        } else if (payload.state === 'stopped') {
          setRunnerEnabled(false);
        }
        setRunnerPid(payload.pid);
        setExitCode(payload.exitCode);
        setRunnerTelemetry(payload.telemetry);
        setGateway(payload.gateway);
        if (payload.health) setHealth(payload.health);
      },
      onTelemetry: (tel) => {
        setRunnerTelemetry(tel);
        const lbl = formatTimeLabel();
        setLiveCpuSeries((prev) => [...prev.slice(-14), { label: lbl, value: tel.cpuPct }]);
        setLiveRamSeries((prev) => [...prev.slice(-14), { label: lbl, value: tel.ramMb }]);
        setLiveDiskSeries((prev) => [...prev.slice(-14), { label: lbl, value: tel.diskMb }]);
      },
      onGateway: (gw) => {
        setGateway(gw);
      },
      onHealth: (hlth) => {
        setHealth(hlth);
      },
    });

    return () => disconnect();
  }, [server?.id]);

  // Reliable HTTP log & status fallback: guarantees live logs stream even if WebSocket & SSE are interrupted
  useEffect(() => {
    if (!server) return;
    if (wsConnected && !powerBusy) return;

    let cancelled = false;
    const pollStatus = async () => {
      try {
        const snap = await getBackendRunnerStatus(server.id);
        if (!cancelled) {
          applySnapshot(snap);
          setStreamTransport((prev) => (prev === 'ws' || prev === 'sse' ? prev : 'http'));
        }
      } catch {
        // ignore transient poll hiccup while starting/reconnecting
      }
    };

    void pollStatus();
    const intervalMs = powerBusy ? 1200 : 2500;
    const id = window.setInterval(() => void pollStatus(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [server?.id, wsConnected, powerBusy]);

  const combinedLines = useMemo(() => {
    if (runnerLogs.length > 0) {
      return runnerLogs.map((l) => ({
        id: l.id,
        level: l.level,
        message: l.message,
        time: formatTimeLabel(l.timestamp),
      }));
    }
    return auditLogs.map((l) => ({
      id: l.id,
      level: l.level,
      message: l.message,
      time: '',
    }));
  }, [runnerLogs, auditLogs]);

  useEffect(() => {
    const box = terminalBoxRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [combinedLines.length]);

  if (!server) {
    return (
      <div className="facon-glass rounded-2xl p-10 text-center flex flex-col items-center gap-4">
        <TerminalIcon className="w-8 h-8 text-[#00FFFF]" />
        <h1 className="font-display text-xl font-semibold text-white">No server selected</h1>
        <p className="text-sm text-zinc-400 max-w-md">
          Deploy a free bot server first to execute workspace files and stream live console output.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('create-server')}
          className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] cursor-pointer"
        >
          Create Free Server
        </button>
      </div>
    );
  }

  const isSuspended = server.status === 'suspended';
  const isProcessRunning = runnerState === 'running' || runnerState === 'starting';
  const isRecovering = runnerState === 'crashed' && (runnerEnabled || Boolean(health?.nextRecoveryAt));

  // Strictly truthful telemetry: stopped/crashed processes ALWAYS read 0 CPU, 0 RAM, and 0s active session uptime
  const displayCpu = isProcessRunning && runnerTelemetry ? runnerTelemetry.cpuPct : 0;
  const displayRam = isProcessRunning && runnerTelemetry ? runnerTelemetry.ramMb : 0;
  const displayDisk = runnerTelemetry ? runnerTelemetry.diskMb : server.diskUsageMb;
  const displayUptime = isProcessRunning && runnerTelemetry ? runnerTelemetry.uptimeSeconds : 0;
  const displayTotalUptime = runnerTelemetry?.totalUptimeSeconds ?? displayUptime;

  const nextRecoverySec = health?.nextRecoveryAt
    ? Math.max(0, Math.ceil((new Date(health.nextRecoveryAt).getTime() - nowMs) / 1000))
    : null;

  const uiStatus: ServerStatus = isSuspended
    ? 'suspended'
    : runnerState === 'running'
    ? 'running'
    : runnerState === 'starting'
    ? 'starting'
    : isRecovering
    ? 'restarting'
    : 'stopped';

  const activeCpuChart = liveCpuSeries.length >= 2 ? liveCpuSeries : cpuHistory;
  const activeRamChart = liveRamSeries.length >= 2 ? liveRamSeries : ramHistory;
  const activeDiskChart = liveDiskSeries.length >= 2 ? liveDiskSeries : diskHistory;

  const handlePower = async (action: 'start' | 'stop' | 'restart') => {
    setPowerBusy(true);
    setActionError(null);
    if (action === 'stop') {
      appendLocalLog('system', 'Stopping backend runner process...');
    } else {
      appendLocalLog(
        'system',
        `Requesting container ${action} ("${server.startupCommand}") — syncing workspace & runtime...`
      );
      setRunnerState('starting');
    }
    try {
      const snap = await onPowerAction(server, action);
      if (snap) {
        applySnapshot(snap);
      } else {
        const latest = await getBackendRunnerStatus(server.id).catch(() => null);
        if (latest) applySnapshot(latest);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Runner command failed.';
      setActionError(msg);
      appendLocalLog('stderr', `[RUNNER ERROR] ${msg}`);
    } finally {
      setPowerBusy(false);
    }
  };

  const handleToggleAlwaysOnline = async () => {
    if (togglingAlwaysOnline || isSuspended) return;
    setTogglingAlwaysOnline(true);
    setActionError(null);
    try {
      await updateServerStartup(server.id, {
        name: server.name,
        startupCommand: server.startupCommand,
        autoRestart: !server.autoRestart,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to update Always-Online setting.');
    } finally {
      setTogglingAlwaysOnline(false);
    }
  };

  const handleVerifyDiscord = async () => {
    if (verifyingDiscord) return;
    setVerifyingDiscord(true);
    setActionError(null);
    try {
      const updated = await verifyServerDiscordGateway(server);
      setGateway(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to verify Discord Gateway.');
    } finally {
      setVerifyingDiscord(false);
    }
  };

  const handleSendCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = command.trim();
    if (!raw || sending || isSuspended) return;

    setSending(true);
    setCommand('');
    setActionError(null);

    try {
      const lower = raw.toLowerCase();
      if (lower === 'start' || lower === 'stop' || lower === 'restart') {
        await handlePower(lower);
      } else if (lower === 'verify' && server.appType === 'Discord Bot') {
        await handleVerifyDiscord();
      } else if (isProcessRunning) {
        await sendBackendStdin(server.id, raw);
      } else {
        await appendServerLog(server.id, 'cmd', `$ ${raw}`);
        if (lower === 'help') {
          await appendServerLog(
            server.id,
            'info',
            'Built-in commands: start · stop · restart · verify · status · uptime · runtime (when running, input is forwarded directly to process stdin)'
          );
        } else if (lower === 'status') {
          await appendServerLog(
            server.id,
            'info',
            `Runner=${runnerState.toUpperCase()} | CPU=${displayCpu}%/${server.cpuLimitPct}% | RAM=${displayRam}/${server.ramLimitMb}MB`
          );
        } else if (lower === 'uptime') {
          await appendServerLog(
            server.id,
            'info',
            `Uptime: ${formatUptime(displayUptime)} (${server.nodeRegion})`
          );
        } else if (lower === 'runtime') {
          await appendServerLog(
            server.id,
            'info',
            `Runtime: ${server.runtime} | Workload: ${server.appType} | Startup: ${server.startupCommand}`
          );
        } else {
          await appendServerLog(
            server.id,
            'warn',
            'Backend process is stopped. Click "Start Runner" above before sending runtime stdin.'
          );
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to deliver console input.');
    } finally {
      setSending(false);
    }
  };

  const rawGwConn = gateway?.connectionState || 'offline';
  const gwConnection: DiscordGatewayStatus['connectionState'] =
    !isProcessRunning && (rawGwConn === 'online' || rawGwConn === 'connecting')
      ? 'offline'
      : rawGwConn;
  const gwActivityText =
    gwConnection === 'online' && gateway?.activityName
      ? `${gateway.activityType || 'Playing'} ${gateway.activityName}`
      : null;
  const gwBadgeClass =
    gwConnection === 'online'
      ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300'
      : gwConnection === 'connecting'
      ? 'border-amber-400/40 bg-amber-400/15 text-amber-300'
      : gwConnection === 'error'
      ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
      : 'border-white/15 bg-white/[0.04] text-zinc-400';

  return (
    <div className="flex flex-col gap-5">
      {/* Header + Power Bar */}
      <div className="facon-glass rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="font-display text-2xl font-bold text-white truncate">{server.name}</h1>
            <StatusIndicator status={uiStatus} />
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md border font-mono text-[11px] ${
                isProcessRunning
                  ? 'border-[#00FFFF]/40 bg-[#00FFFF]/10 text-[#00FFFF]'
                  : runnerState === 'crashed'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : 'border-white/10 bg-white/[0.03] text-zinc-400'
              }`}
            >
              <Cpu className="w-3 h-3" />
              {isProcessRunning
                ? `LIVE PID ${runnerPid ?? '—'}`
                : isRecovering
                ? nextRecoverySec !== null
                  ? `RECOVERING IN ${nextRecoverySec}s`
                  : 'SUPERVISOR RECOVERING'
                : runnerState === 'crashed'
                ? `OFFLINE (EXIT ${exitCode ?? 1})`
                : 'RUNNER STOPPED'}
            </span>
          </div>
          <p className="text-xs text-zinc-400 flex items-center gap-2 flex-wrap">
            <span>{server.appType}</span>
            <span aria-hidden="true">·</span>
            <span>{server.runtime}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-zinc-300">{server.startupCommand}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Session {formatUptime(displayUptime)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-[#00FFFF]">
              Lifetime {formatUptime(displayTotalUptime)}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            disabled={powerBusy || isProcessRunning || isSuspended}
            onClick={() => handlePower('start')}
            className="h-10 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-2 bg-[#00FFFF] text-black hover:bg-[#66FFFF] disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isProcessRunning ? 'Running' : 'Start Runner'}</span>
          </button>
          <button
            type="button"
            disabled={powerBusy || isSuspended}
            onClick={() => handlePower('restart')}
            className="h-10 px-4 rounded-lg text-xs font-medium inline-flex items-center gap-2 border border-white/15 bg-white/[0.04] text-zinc-200 hover:border-amber-400/50 hover:text-amber-300 disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Restart</span>
          </button>
          <button
            type="button"
            disabled={powerBusy || (!isProcessRunning && !isRecovering && !runnerEnabled) || isSuspended}
            onClick={() => handlePower('stop')}
            className="h-10 px-4 rounded-lg text-xs font-medium inline-flex items-center gap-2 border border-white/15 bg-white/[0.04] text-zinc-200 hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-35 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" />
            <span>Stop</span>
          </button>
        </div>
      </div>

      {/* Supervisor Status & Offline Reason Strip */}
      <div className="facon-glass rounded-xl px-4 py-3 flex flex-col gap-2.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap text-zinc-300">
            <span className="inline-flex items-center gap-1.5 font-mono">
              <Clock className="w-3.5 h-3.5 text-[#00FFFF]" />
              <span>
                24/7 Supervisor:{' '}
                <strong className={runnerEnabled || isProcessRunning ? 'text-[#00FFFF]' : 'text-zinc-400'}>
                  {runnerEnabled || isProcessRunning ? 'FULL ONLINE MODE' : 'STOPPED (MANUAL)'}
                </strong>
              </span>
            </span>
            {health && (
              <>
                <span className="text-zinc-600" aria-hidden="true">|</span>
                <span className="font-mono text-zinc-400 tabular-nums">
                  Crashes: <span className="text-zinc-200">{health.crashCount}</span> · Recoveries:{' '}
                  <span className="text-zinc-200">{health.restartCount}</span> · OOMs:{' '}
                  <span className={health.oomCount > 0 ? 'text-rose-300' : 'text-zinc-200'}>
                    {health.oomCount}
                  </span>
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={togglingAlwaysOnline || isSuspended}
            onClick={() => void handleToggleAlwaysOnline()}
            className={`h-7 px-2.5 rounded border font-mono text-[11px] inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 ${
              server.autoRestart
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20'
                : 'border-white/15 bg-white/[0.04] text-zinc-400 hover:text-white'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${server.autoRestart ? 'bg-emerald-400' : 'bg-zinc-500'}`}
              aria-hidden="true"
            />
            <span>Auto-Revive: {server.autoRestart ? 'LOCKED ON' : 'OFF'}</span>
          </button>
        </div>

        <div className="pt-2 border-t border-white/[0.06] flex flex-col gap-2 text-[11px]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider font-semibold ${
                  hostHealth?.uptimeMode === 'dedicated-24x7'
                    ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300'
                    : hostHealth?.uptimeMode === 'ai-studio-auto-sleep'
                    ? 'border-amber-400/40 bg-amber-400/15 text-amber-300'
                    : 'border-white/15 bg-white/[0.04] text-zinc-400'
                }`}
              >
                {hostHealth?.uptimeMode === 'dedicated-24x7'
                  ? '24/7 Cloud Run Active (Chrome-Closed Safe)'
                  : hostHealth?.uptimeMode === 'ai-studio-auto-sleep'
                  ? 'AI Studio Sandbox (Sleeps ~15–20m After Chrome Closes)'
                  : 'Checking Host Uptime Mode...'}
              </span>
              <span className="text-zinc-400 font-mono">
                Domain: <span className="text-zinc-200">{hostHealth?.publicDomain || 'https://faconmodshosting.ai.studio'}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <code className="px-2 py-1 rounded bg-black/50 border border-white/10 font-mono text-[#00FFFF] truncate max-w-[260px] sm:max-w-[320px]">
                {keepalivePingUrl}
              </code>
              <button
                type="button"
                onClick={() => void handleCopyPingUrl()}
                className="h-7 px-2.5 rounded border border-white/15 bg-white/[0.04] text-zinc-200 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] inline-flex items-center gap-1 shrink-0 cursor-pointer"
              >
                {copiedPingUrl ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                <span>{copiedPingUrl ? 'Copied' : 'Copy Ping'}</span>
              </button>
            </div>
          </div>

          {hostHealth?.uptimeMode === 'ai-studio-auto-sleep' && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-amber-200/90">
              <p className="leading-relaxed">
                Google AI Studio preview sandboxes suspend 15–20m after Chrome closes and block external uptime pings with Google Sign-In. Deploy the included <span className="font-mono text-white">Dockerfile</span> to Cloud Run (<span className="font-mono text-white">--min-instances=1 --no-cpu-throttling</span>) for true 24/7 permanent uptime with Chrome closed (no 2-month visits needed):
              </p>
              <button
                type="button"
                onClick={() => void handleCopyDeployCmd()}
                className="h-7 px-2.5 rounded border border-amber-400/40 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25 inline-flex items-center gap-1.5 shrink-0 font-mono cursor-pointer"
              >
                {copiedDeployCmd ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                <span>{copiedDeployCmd ? 'Copied Deploy Cmd' : 'Copy 24/7 Deploy Cmd'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {!isProcessRunning && (health?.offlineReason || runnerState === 'crashed') && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs text-amber-100 flex items-start gap-2.5 break-words [overflow-wrap:anywhere]">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Offline Reason: {health?.offlineReason || `Process exited unexpectedly (code ${exitCode ?? 1}).`}
            </p>
            {isRecovering && (
              <p className="text-amber-200/90 mt-0.5 font-mono">
                Automatic supervisor recovery #{health?.restartCount ?? 1}{' '}
                {nextRecoverySec !== null ? `scheduled in ${nextRecoverySec}s` : 'pending'} · click Restart to retry immediately or Stop to disable.
              </p>
            )}
            {health?.diagnosticHint && (
              <p className="text-amber-200/80 mt-1">{health.diagnosticHint}</p>
            )}
          </div>
        </div>
      )}

      {actionError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200 flex items-start gap-2.5 break-words [overflow-wrap:anywhere]">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Discord Gateway Live Card (for Discord Bots) */}
      {server.appType === 'Discord Bot' && (
        <div className="facon-glass rounded-2xl p-4 sm:p-5 flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg border border-[#00FFFF]/30 bg-[#00FFFF]/10 flex items-center justify-center text-[#00FFFF] shrink-0">
                <Radio className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-display text-sm font-semibold text-white">
                    Discord Gateway Status
                  </h2>
                  <span
                    className={`px-2 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider font-semibold ${gwBadgeClass}`}
                  >
                    {gwConnection}
                  </span>
                  {gateway?.botTag && (
                    <span className="inline-flex items-center gap-1 font-mono text-xs text-[#00FFFF]">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {gateway.botTag}
                    </span>
                  )}
                  {gwConnection === 'online' ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                      <span>{gwActivityText || 'Online · No Playing status set'}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" aria-hidden="true" />
                      <span>No Playing status (Bot Offline)</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-0.5 break-words">
                  {gateway?.lastEvent ||
                    'Click "Start Runner" to execute your bot code and verify Discord Gateway connectivity.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                type="button"
                onClick={() => onNavigate('startup')}
                className="h-9 px-3 rounded-lg border border-white/15 bg-white/[0.04] text-xs text-zinc-300 hover:text-white inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>Configure Token</span>
              </button>
              <button
                type="button"
                disabled={verifyingDiscord}
                onClick={() => void handleVerifyDiscord()}
                className="h-9 px-3.5 rounded-lg border border-[#00FFFF]/40 bg-[#00FFFF]/10 text-[#00FFFF] text-xs font-medium hover:bg-[#00FFFF] hover:text-black disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${verifyingDiscord ? 'animate-spin' : ''}`} />
                <span>{verifyingDiscord ? 'Checking...' : 'Verify Token & Gateway'}</span>
              </button>
            </div>
          </div>

          {(gateway?.gatewayUrl || gateway?.sessionRemaining != null || gateway?.guildCount != null || hostCaps || health) && (
            <div className="pt-2.5 border-t border-white/[0.07] flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] font-mono text-zinc-400">
              {gateway?.gatewayUrl && (
                <span>
                  WSS: <span className="text-zinc-200">{gateway.gatewayUrl}</span>
                </span>
              )}
              {gwConnection === 'online' && gateway?.guildCount != null && (
                <span>
                  Servers: <span className="text-zinc-200">{gateway.guildCount}</span>
                </span>
              )}
              {gateway?.latencyMs != null && (
                <span>
                  API Ping: <span className="text-[#00FFFF]">{gateway.latencyMs}ms</span>
                </span>
              )}
              {gateway?.shards != null && (
                <span>
                  Shards: <span className="text-zinc-200">{gateway.shards}</span>
                </span>
              )}
              {gateway?.sessionRemaining != null && gateway?.sessionTotal != null && (
                <span>
                  Daily Sessions:{' '}
                  <span className="text-[#00FFFF]">
                    {gateway.sessionRemaining}/{gateway.sessionTotal}
                  </span>
                </span>
              )}
              {health && health.status !== 'stopped' && (
                <span>
                  Health:{' '}
                  <span
                    className={
                      health.status === 'healthy'
                        ? 'text-emerald-300'
                        : health.status === 'recovering' || health.status === 'degraded'
                        ? 'text-amber-300'
                        : 'text-rose-300'
                    }
                  >
                    {health.status.toUpperCase()}
                    {health.restartCount > 0 ? ` (${health.restartCount} recoveries)` : ''}
                  </span>
                </span>
              )}
              {hostCaps && (
                <span>
                  Node Runtimes:{' '}
                  <span className="text-zinc-200">{hostCaps.availableRuntimes.join(' · ')}</span>
                  {hostCaps.discordJsInstalled ? ' (discord.js ready)' : ''}
                </span>
              )}
            </div>
          )}

          {health?.diagnosticHint && (
            <div className="rounded-lg border border-amber-400/35 bg-amber-400/10 px-3.5 py-2.5 text-xs text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <div className="min-w-0">
                {health.lastError && <p className="font-semibold text-amber-100">{health.lastError}</p>}
                <p className="mt-0.5 text-amber-200/90 break-words">{health.diagnosticHint}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Interactive Live Terminal */}
      <div className="rounded-2xl border border-white/10 bg-[#05070A] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-white/[0.08] bg-[#080B10] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs font-mono text-zinc-300">
            <TerminalIcon className="w-4 h-4 text-[#00FFFF]" />
            <span>container@{server.id.slice(0, 12)}:~</span>
            <span
              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border ${
                wsConnected || streamTransport === 'http'
                  ? 'border-[#00FFFF]/30 bg-[#00FFFF]/10 text-[#00FFFF]'
                  : 'border-amber-400/30 bg-amber-400/10 text-amber-300'
              }`}
            >
              <Activity className="w-2.5 h-2.5" />
              {streamTransport === 'ws'
                ? 'WS STREAM LIVE'
                : streamTransport === 'sse'
                ? 'SSE STREAM LIVE'
                : streamTransport === 'http'
                ? 'HTTP SYNC LIVE'
                : 'RECONNECTING...'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {runnerLogs.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRunnerLogs((prev) => {
                    for (const e of prev) clearedLogIdsRef.current.add(e.id);
                    return [];
                  });
                }}
                className="text-[11px] font-mono text-zinc-400 hover:text-white inline-flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear view</span>
              </button>
            )}
            <span className="font-mono text-[11px] text-zinc-500">
              {isProcessRunning ? 'Input pipes to process stdin' : 'Click Start Runner to execute files'}
            </span>
          </div>
        </div>

        <div
          ref={terminalBoxRef}
          className="p-4 h-[380px] overflow-y-auto font-mono text-xs leading-6 space-y-1"
        >
          {combinedLines.length === 0 ? (
            <p className="text-zinc-500">
              Waiting for runner output. Click &quot;Start Runner&quot; to execute workspace files.
            </p>
          ) : (
            combinedLines.map((entry) => {
              const levelStyle =
                entry.level === 'cmd'
                  ? 'text-[#00FFFF] font-medium'
                  : entry.level === 'stderr' || entry.level === 'error'
                  ? 'text-rose-400'
                  : entry.level === 'gateway'
                  ? 'text-emerald-300'
                  : entry.level === 'warn'
                  ? 'text-amber-300'
                  : entry.level === 'system'
                  ? 'text-zinc-400'
                  : 'text-zinc-100';

              return (
                <div
                  key={entry.id}
                  className={`break-words [overflow-wrap:anywhere] ${levelStyle}`}
                >
                  {entry.time && (
                    <span className="text-zinc-600 mr-2 select-none tabular-nums">{entry.time}</span>
                  )}
                  <span className="text-zinc-500 mr-2 select-none uppercase">[{entry.level}]</span>
                  <span>{entry.message}</span>
                </div>
              );
            })
          )}
        </div>

        <form
          onSubmit={handleSendCommand}
          className="p-3 border-t border-white/[0.08] bg-[#080B10] flex items-center gap-2"
        >
          <span className="font-mono text-xs text-[#00FFFF] pl-2 select-none">
            {isProcessRunning ? '>' : '$'}
          </span>
          <input
            type="text"
            disabled={isSuspended}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={
              isSuspended
                ? 'Container is suspended by administrator'
                : isProcessRunning
                ? 'Send stdin to running bot (or type stop / restart / verify)...'
                : 'Type start, restart, verify, status, or help...'
            }
            className="flex-1 h-10 bg-transparent font-mono text-xs text-white placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!command.trim() || sending || isSuspended}
            className="h-9 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[#66FFFF] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isProcessRunning ? 'Send' : 'Run'}</span>
          </button>
        </form>
      </div>

      {/* Live Process / Node Telemetry Graphs */}
      <div className="grid lg:grid-cols-3 gap-4">
        <TelemetryChart
          title="CPU Usage"
          currentValue={`${displayCpu}%`}
          limitLabel={`${server.cpuLimitPct}%`}
          unit="%"
          max={server.cpuLimitPct}
          data={activeCpuChart}
        />
        <TelemetryChart
          title="Memory (RAM)"
          currentValue={`${displayRam} MB`}
          limitLabel={`${server.ramLimitMb} MB`}
          unit=" MB"
          max={server.ramLimitMb}
          data={activeRamChart}
        />
        <TelemetryChart
          title="Workspace Disk"
          currentValue={`${displayDisk} MB`}
          limitLabel={`${server.diskLimitMb} MB`}
          unit=" MB"
          max={server.diskLimitMb}
          data={activeDiskChart}
        />
      </div>

      {/* Quick Host Notice Footer */}
      {hostCaps && (
        <div className="rounded-xl border border-white/10 bg-[#05080B] px-4 py-3 flex items-center gap-2.5 text-xs text-zinc-400">
          <ShieldCheck className="w-4 h-4 text-[#00FFFF] shrink-0" />
          <span className="break-words">
            Host daemon active ({hostCaps.nodeVersion}
            {hostCaps.discordJsInstalled ? ' · discord.js v14 built-in' : ''}
            {hostCaps.pythonVersion ? ` · ${hostCaps.pythonVersion}` : ''}). Node.js, TypeScript,
            JavaScript, and Python 3.12 (with automatic <span className="font-mono text-zinc-200">requirements.txt</span>{' '}
            pip install) execute natively.
          </span>
        </div>
      )}
    </div>
  );
}
