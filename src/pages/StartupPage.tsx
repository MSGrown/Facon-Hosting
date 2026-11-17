import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Plus, Save, Sliders, Trash2 } from 'lucide-react';
import { AppPage, BotServer, ServerEnvVar, SUPPORTED_RUNTIMES } from '../types/hosting';
import {
  deleteServerEnvVar,
  saveServerEnvVar,
  subscribeToServerEnvVars,
  updateServerStartup,
} from '../services/hostingService';

interface StartupPageProps {
  server: BotServer | null;
  onNavigate: (page: AppPage) => void;
}

export function StartupPage({ server, onNavigate }: StartupPageProps) {
  const [name, setName] = useState('');
  const [startupCommand, setStartupCommand] = useState('');
  const [autoRestart, setAutoRestart] = useState(true);
  const [savingStartup, setSavingStartup] = useState(false);
  const [startupNotice, setStartupNotice] = useState<string | null>(null);

  const [envVars, setEnvVars] = useState<ServerEnvVar[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newSecret, setNewSecret] = useState(true);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [envError, setEnvError] = useState<string | null>(null);

  useEffect(() => {
    if (!server) return;
    setName(server.name);
    setStartupCommand(server.startupCommand);
    setAutoRestart(server.autoRestart);
    const unsub = subscribeToServerEnvVars(server.id, setEnvVars);
    return () => unsub();
  }, [server?.id]);

  if (!server) {
    return (
      <div className="facon-glass rounded-2xl p-10 text-center flex flex-col items-center gap-4">
        <Sliders className="w-8 h-8 text-[#00FFFF]" />
        <h1 className="font-display text-xl font-semibold text-white">No server selected</h1>
        <p className="text-sm text-zinc-400">
          Select or deploy a server to configure startup commands and environment variables.
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
  const runtimePreset = SUPPORTED_RUNTIMES.find((r) => r.id === server.runtime);

  const handleSaveStartup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSuspended) return;
    setSavingStartup(true);
    setStartupNotice(null);
    try {
      await updateServerStartup(server.id, { name, startupCommand, autoRestart });
      setStartupNotice('Startup configuration saved.');
    } finally {
      setSavingStartup(false);
    }
  };

  const handleAddEnv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSuspended) return;
    setEnvError(null);
    try {
      await saveServerEnvVar(server.id, {
        key: newKey,
        value: newVal,
        isSecret: newSecret,
      });
      setNewKey('');
      setNewVal('');
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : 'Failed to save variable.');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
          Startup &amp; Environment
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Configure the launch command, crash recovery policy, and runtime environment variables for{' '}
          <span className="text-white font-medium">{server.name}</span>.
        </p>
      </div>

      {/* Startup Configuration */}
      <form onSubmit={handleSaveStartup} className="facon-glass rounded-2xl p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Startup Command</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Runtime: {server.runtime} ({runtimePreset?.version})
            </p>
          </div>
          {runtimePreset && (
            <button
              type="button"
              onClick={() => setStartupCommand(runtimePreset.defaultCmd)}
              className="text-xs text-[#00FFFF] hover:underline cursor-pointer"
            >
              Reset to default
            </button>
          )}
        </div>

        {startupNotice && (
          <div className="rounded-lg border border-[#00FFFF]/30 bg-[#00FFFF]/10 px-4 py-2.5 text-xs text-[#00FFFF]">
            {startupNotice}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Server Name</label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={48}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-11 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white focus:outline-none focus:border-[#00FFFF]/60"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
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

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRestart}
              onChange={(e) => setAutoRestart(e.target.checked)}
              className="w-4 h-4 accent-[#00FFFF] cursor-pointer"
            />
            <span className="text-sm text-zinc-200">Auto-restart container on unexpected exit</span>
          </label>

          <button
            type="submit"
            disabled={savingStartup || isSuspended}
            className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer self-start sm:self-auto"
          >
            <Save className="w-4 h-4" />
            <span>{savingStartup ? 'Saving...' : 'Save Startup Config'}</span>
          </button>
        </div>
      </form>

      {/* Environment Variables */}
      <section className="facon-glass rounded-2xl p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-5 h-5 text-[#00FFFF]" />
            <div>
              <h2 className="font-display text-lg font-semibold text-white">
                Environment Variables
              </h2>
              <p className="text-xs text-zinc-400">
                Inject bot tokens, API keys, and runtime flags securely into process.env / os.environ.
              </p>
            </div>
          </div>
          <span className="font-mono text-xs text-zinc-500 tabular-nums">
            {envVars.length} configured
          </span>
        </div>

        {envError && (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-200">
            {envError}
          </div>
        )}

        <form onSubmit={handleAddEnv} className="grid sm:grid-cols-12 gap-3 items-end">
          <div className="sm:col-span-4">
            <label className="block text-xs text-zinc-400 mb-1.5">Variable Key</label>
            <input
              type="text"
              required
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase())}
              placeholder="DISCORD_TOKEN"
              className="w-full h-10 px-3 rounded-lg bg-[#05080B] border border-white/10 font-mono text-xs text-white focus:outline-none focus:border-[#00FFFF]/60"
            />
          </div>
          <div className="sm:col-span-5">
            <label className="block text-xs text-zinc-400 mb-1.5">Value</label>
            <input
              type="text"
              required
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              placeholder="Paste token or config value"
              className="w-full h-10 px-3 rounded-lg bg-[#05080B] border border-white/10 font-mono text-xs text-white focus:outline-none focus:border-[#00FFFF]/60"
            />
          </div>
          <div className="sm:col-span-3 flex items-center gap-2">
            <label className="h-10 px-3 rounded-lg border border-white/10 bg-[#05080B] inline-flex items-center gap-2 text-xs text-zinc-300 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={newSecret}
                onChange={(e) => setNewSecret(e.target.checked)}
                className="accent-[#00FFFF]"
              />
              <span>Mask</span>
            </label>
            <button
              type="submit"
              disabled={isSuspended}
              className="flex-1 h-10 px-3 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center justify-center gap-1.5 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add</span>
            </button>
          </div>
        </form>

        <div className="divide-y divide-white/[0.06] border-t border-white/[0.08]">
          {envVars.length === 0 ? (
            <p className="py-6 text-xs text-zinc-500">No environment variables configured yet.</p>
          ) : (
            envVars.map((item) => {
              const revealed = Boolean(revealedIds[item.id]);
              return (
                <div
                  key={item.id}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-semibold text-[#00FFFF]">{item.key}</p>
                    <p className="font-mono text-xs text-zinc-300 mt-0.5 truncate">
                      {item.isSecret && !revealed
                        ? '••••••••••••••••••••••••'
                        : item.value || '(empty)'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.isSecret && (
                      <button
                        type="button"
                        onClick={() =>
                          setRevealedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                        }
                        className="h-8 px-2.5 rounded-md border border-white/10 text-xs text-zinc-400 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                      >
                        {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{revealed ? 'Hide' : 'Reveal'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isSuspended}
                      onClick={() => void deleteServerEnvVar(server.id, item.id)}
                      className="h-8 w-8 rounded-md border border-white/10 inline-flex items-center justify-center text-zinc-400 hover:text-rose-400 hover:border-rose-500/40 disabled:opacity-40 cursor-pointer"
                      aria-label={`Delete ${item.key}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
