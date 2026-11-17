import React from 'react';
import { PlusSquare, Server as ServerIcon } from 'lucide-react';
import { AppPage, BotServer, FREE_PLAN_SPECS } from '../types/hosting';
import { RunnerFleetSummary } from '../services/runnerService';
import { TelemetryChart, TelemetryPoint } from '../components/TelemetryChart';
import { ServerCard } from '../components/ServerCard';

interface DashboardPageProps {
  servers: BotServer[];
  runnerFleetMap?: Record<string, RunnerFleetSummary>;
  cpuHistory: TelemetryPoint[];
  ramHistory: TelemetryPoint[];
  diskHistory: TelemetryPoint[];
  onNavigate: (page: AppPage) => void;
  onOpenConsole: (serverId: string) => void;
  onPowerAction: (server: BotServer, action: 'start' | 'stop' | 'restart') => Promise<unknown>;
  loading: boolean;
}

export function DashboardPage({
  servers,
  runnerFleetMap,
  cpuHistory,
  ramHistory,
  diskHistory,
  onNavigate,
  onOpenConsole,
  onPowerAction,
  loading,
}: DashboardPageProps) {
  const runningCount = servers.filter((s) => s.status === 'running').length;
  const totalCpu = servers.reduce((acc, s) => acc + s.cpuUsage, 0);
  const totalRamMb = servers.reduce((acc, s) => acc + s.ramUsageMb, 0);
  const totalDiskMb = servers.reduce((acc, s) => acc + s.diskUsageMb, 0);

  const maxCpuPool = Math.max(FREE_PLAN_SPECS.cpuPct, servers.length * FREE_PLAN_SPECS.cpuPct);
  const maxRamPool = Math.max(FREE_PLAN_SPECS.ramMb, servers.length * FREE_PLAN_SPECS.ramMb);
  const maxDiskPool = Math.max(FREE_PLAN_SPECS.diskMb, servers.length * FREE_PLAN_SPECS.diskMb);

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Cloud Overview
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Real-time resource consumption and active bot instances on your Free Plan.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('create-server')}
          className="h-10 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] transition-colors self-start sm:self-auto cursor-pointer"
        >
          <PlusSquare className="w-4 h-4" />
          <span>Create Free Server</span>
        </button>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Active Instances</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-1">
            {runningCount} / {servers.length}
          </p>
          <p className="text-xs text-zinc-500 mt-1">Up to {FREE_PLAN_SPECS.maxServersPerUser} free nodes</p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Aggregate CPU Load</p>
          <p className="font-mono text-2xl font-semibold text-[#00FFFF] tabular-nums mt-1">
            {totalCpu}%
          </p>
          <p className="text-xs text-zinc-500 mt-1">Pool limit {maxCpuPool}%</p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Memory Allocated</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-1">
            {totalRamMb} MB
          </p>
          <p className="text-xs text-zinc-500 mt-1">Pool limit {(maxRamPool / 1024).toFixed(0)} GB</p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">NVMe Storage Used</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-1">
            {(totalDiskMb / 1024).toFixed(2)} GB
          </p>
          <p className="text-xs text-zinc-500 mt-1">Pool limit {(maxDiskPool / 1024).toFixed(0)} GB</p>
        </div>
      </div>

      {/* Telemetry Graphs */}
      <section className="grid lg:grid-cols-3 gap-4">
        <TelemetryChart
          title="CPU Usage"
          currentValue={`${totalCpu}%`}
          limitLabel={`${maxCpuPool}%`}
          unit="%"
          max={maxCpuPool}
          data={cpuHistory}
        />
        <TelemetryChart
          title="RAM Usage"
          currentValue={`${totalRamMb} MB`}
          limitLabel={`${maxRamPool} MB`}
          unit=" MB"
          max={maxRamPool}
          data={ramHistory}
        />
        <TelemetryChart
          title="Disk Footprint"
          currentValue={`${totalDiskMb} MB`}
          limitLabel={`${maxDiskPool} MB`}
          unit=" MB"
          max={maxDiskPool}
          data={diskHistory}
        />
      </section>

      {/* Fleet Section */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-semibold text-white">Your Servers</h2>
          {servers.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('servers')}
              className="text-xs font-medium text-[#00FFFF] hover:underline cursor-pointer"
            >
              View all servers
            </button>
          )}
        </div>

        {loading ? (
          <div className="grid md:grid-cols-2 gap-4">
            {[1, 2].map((skeleton) => (
              <div key={skeleton} className="facon-glass rounded-xl p-5 h-44 animate-pulse" />
            ))}
          </div>
        ) : servers.length === 0 ? (
          <div className="facon-glass rounded-2xl p-10 flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-xl border border-[#00FFFF]/30 bg-[#00FFFF]/10 flex items-center justify-center text-[#00FFFF]">
              <ServerIcon className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-display text-xl font-semibold text-white">
                No bot servers deployed yet
              </h3>
              <p className="text-sm text-zinc-400 max-w-md mt-1.5">
                Spin up up to 10 Discord, Telegram, WhatsApp bots or custom services with 20 GB RAM,
                500% CPU, 20 GB NVMe storage, 500 Mbps bandwidth, and 5 backups—completely free.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('create-server')}
              className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] transition-colors cursor-pointer"
            >
              Deploy First Server
            </button>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {servers.slice(0, 4).map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                runnerSummary={runnerFleetMap?.[server.id]}
                onOpenConsole={onOpenConsole}
                onPowerAction={onPowerAction}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
