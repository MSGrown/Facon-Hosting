import React, { useState } from 'react';
import { ArrowRight, Check, Cpu, HardDrive, ShieldCheck, Wifi, Archive } from 'lucide-react';
import { AppPage, BotServer, FREE_PLAN_SPECS, NODE_REGIONS, NodeRegion, SUPPORTED_APPLICATIONS, SUPPORTED_RUNTIMES, SupportedAppType, SupportedRuntime } from '../types/hosting';
import { useAuth } from '../context/AuthContext';
import { createBotServer } from '../services/hostingService';
import { startBackendRunner } from '../services/runnerService';

interface CreateServerPageProps {
  existingServerCount: number;
  onCreated: (serverId: string) => void;
  onNavigate: (page: AppPage) => void;
}

export function CreateServerPage({
  existingServerCount,
  onCreated,
  onNavigate,
}: CreateServerPageProps) {
  const { user, profile } = useAuth();
  const [name, setName] = useState('');
  const [appType, setAppType] = useState<SupportedAppType>('Discord Bot');
  const [runtime, setRuntime] = useState<SupportedRuntime>('Python');
  const [nodeRegion, setNodeRegion] = useState<NodeRegion>('us-east-1');
  const [startupCommand, setStartupCommand] = useState(SUPPORTED_RUNTIMES[0].defaultCmd);
  const [autoRestart, setAutoRestart] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serverLimit = Math.max(
    FREE_PLAN_SPECS.maxServersPerUser,
    profile?.serverLimit || FREE_PLAN_SPECS.maxServersPerUser
  );
  const limitReached = existingServerCount >= serverLimit;
  const accountSuspended = Boolean(profile?.suspended);

  const handleRuntimeSelect = (rtId: SupportedRuntime) => {
    setRuntime(rtId);
    const rt = SUPPORTED_RUNTIMES.find((r) => r.id === rtId);
    if (rt) {
      setStartupCommand(rt.defaultCmd);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      onNavigate('login');
      return;
    }
    if (limitReached) {
      setError(`Free account limit reached (${serverLimit} active nodes). Delete an unused node to deploy another.`);
      return;
    }
    if (accountSuspended) {
      setError('Your account is currently suspended. Contact an administrator.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const appInfo = SUPPORTED_APPLICATIONS.find((a) => a.id === appType);
      const serverId = await createBotServer({
        ownerId: user.uid,
        ownerEmail: user.email || 'user@facon.host',
        name,
        runtime,
        appType,
        nodeRegion,
        startupCommand,
        autoRestart,
        defaultEnvKey: appInfo?.defaultEnvKey || 'BOT_TOKEN',
      });
      // Immediately boot real backend container process
      void startBackendRunner({
        id: serverId,
        ownerId: user.uid,
        ownerEmail: user.email || 'user@facon.host',
        name: name.trim(),
        runtime,
        appType,
        nodeRegion,
        status: 'starting',
        startupCommand: startupCommand.trim(),
        autoRestart,
        plan: 'FREE',
        ramLimitMb: FREE_PLAN_SPECS.ramMb,
        cpuLimitPct: FREE_PLAN_SPECS.cpuPct,
        diskLimitMb: FREE_PLAN_SPECS.diskMb,
        bandwidthMbps: FREE_PLAN_SPECS.bandwidthMbps,
        backupLimit: FREE_PLAN_SPECS.backupsLimit,
        cpuUsage: 0,
        ramUsageMb: 0,
        diskUsageMb: 1,
        networkMbps: 0,
        uptimeSeconds: 0,
      } as BotServer).catch(() => {
        // Console view will surface startup errors honestly
      });
      onCreated(serverId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
          Deploy Free Server
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Configure your application container, select one of 9 runtimes, and boot instantly.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-xs sm:text-sm text-rose-200 break-words [overflow-wrap:anywhere]">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid lg:grid-cols-12 gap-6 items-start">
        {/* Left Config Column */}
        <div className="lg:col-span-8 facon-glass rounded-2xl p-6 flex flex-col gap-6">
          {/* Server Name */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Server Name
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={48}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. sentinel-discord-bot"
              className="w-full h-11 px-4 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#00FFFF]/60"
            />
          </div>

          {/* Application Type */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Supported Application
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              {SUPPORTED_APPLICATIONS.map((app) => {
                const active = app.id === appType;
                return (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => setAppType(app.id)}
                    className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#00FFFF]/10 border-[#00FFFF]/60 text-white'
                        : 'bg-[#05080B] border-white/10 text-zinc-300 hover:border-white/25'
                    }`}
                  >
                    <p className="font-display text-sm font-semibold">{app.id}</p>
                    <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{app.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Supported Runtimes */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Execution Runtime
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {SUPPORTED_RUNTIMES.map((rt) => {
                const active = rt.id === runtime;
                return (
                  <button
                    key={rt.id}
                    type="button"
                    onClick={() => handleRuntimeSelect(rt.id)}
                    className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#00FFFF]/10 border-[#00FFFF]/60 text-white'
                        : 'bg-[#05080B] border-white/10 text-zinc-300 hover:border-white/25'
                    }`}
                  >
                    <p className="text-sm font-semibold">{rt.id}</p>
                    <p className="font-mono text-[11px] text-zinc-500 mt-0.5">{rt.version}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Region + Startup */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-2">
                Cluster Region
              </label>
              <select
                value={nodeRegion}
                onChange={(e) => setNodeRegion(e.target.value as NodeRegion)}
                className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white focus:outline-none focus:border-[#00FFFF]/60 cursor-pointer"
              >
                {NODE_REGIONS.map((reg) => (
                  <option key={reg.id} value={reg.id} className="bg-[#090C10]">
                    {reg.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-2">
                Startup Command
              </label>
              <input
                type="text"
                required
                maxLength={256}
                value={startupCommand}
                onChange={(e) => setStartupCommand(e.target.value)}
                className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 font-mono text-xs text-[#00FFFF] focus:outline-none focus:border-[#00FFFF]/60"
              />
            </div>
          </div>

          <label className="flex items-center justify-between gap-4 p-4 rounded-xl bg-[#05080B] border border-white/10 cursor-pointer">
            <div>
              <p className="text-sm font-medium text-white">Auto-Restart on Crash</p>
              <p className="text-xs text-zinc-400">
                Automatically recover the bot process if an unhandled exit occurs.
              </p>
            </div>
            <input
              type="checkbox"
              checked={autoRestart}
              onChange={(e) => setAutoRestart(e.target.checked)}
              className="w-4 h-4 accent-[#00FFFF] cursor-pointer"
            />
          </label>
        </div>

        {/* Right Free Plan Spec Summary */}
        <aside className="lg:col-span-4 facon-glass rounded-2xl p-6 flex flex-col gap-5">
          <div className="flex items-baseline justify-between gap-2 pb-4 border-b border-white/[0.08]">
            <div>
              <p className="text-xs text-zinc-400">Included Allocation</p>
              <h2 className="font-display text-lg font-semibold text-white">Free Server Plan</h2>
            </div>
            <span className="font-mono text-lg font-bold text-[#00FFFF]">FREE</span>
          </div>

          <div className="space-y-3 text-sm">
            {[
              { icon: ShieldCheck, label: 'RAM', val: FREE_PLAN_SPECS.ramLabel },
              { icon: Cpu, label: 'CPU', val: FREE_PLAN_SPECS.cpuLabel },
              { icon: HardDrive, label: 'Disk', val: FREE_PLAN_SPECS.diskLabel },
              { icon: Wifi, label: 'Bandwidth', val: FREE_PLAN_SPECS.bandwidthLabel },
              { icon: Archive, label: 'Backups', val: FREE_PLAN_SPECS.backupsLabel },
              { icon: Check, label: 'Deploy Limit', val: `${serverLimit} Servers` },
              { icon: Check, label: 'Price', val: FREE_PLAN_SPECS.priceLabel },
            ].map((row) => {
              const Icon = row.icon;
              return (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-zinc-400">
                    <Icon className="w-4 h-4 text-[#00FFFF]" />
                    <span>{row.label}</span>
                  </span>
                  <span className="font-mono font-semibold text-white tabular-nums">{row.val}</span>
                </div>
              );
            })}
          </div>

          <div className="pt-4 border-t border-white/[0.08] text-xs text-zinc-400">
            Account usage:{' '}
            <span className="font-mono text-zinc-200 tabular-nums">
              {existingServerCount} / {serverLimit}
            </span>{' '}
            servers deployed.
          </div>

          <button
            type="submit"
            disabled={submitting || limitReached || accountSuspended}
            className="h-11 px-5 rounded-lg bg-[#00FFFF] text-black text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-[#66FFFF] disabled:opacity-45 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            <span>{submitting ? 'Provisioning Node...' : 'Provision Free Server'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </aside>
      </form>
    </div>
  );
}
