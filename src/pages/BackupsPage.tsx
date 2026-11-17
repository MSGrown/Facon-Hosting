import React, { useEffect, useState } from 'react';
import { Archive, Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { AppPage, BotServer, FREE_PLAN_SPECS, ServerBackup, ServerFile } from '../types/hosting';
import {
  createServerBackup,
  deleteServerBackup,
  restoreServerBackup,
  subscribeToServerBackups,
  subscribeToServerFiles,
} from '../services/hostingService';

interface BackupsPageProps {
  server: BotServer | null;
  onNavigate: (page: AppPage) => void;
}

export function BackupsPage({ server, onNavigate }: BackupsPageProps) {
  const [backups, setBackups] = useState<ServerBackup[]>([]);
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!server) return;
    const unsubB = subscribeToServerBackups(server.id, setBackups);
    const unsubF = subscribeToServerFiles(server.id, setFiles);
    return () => {
      unsubB();
      unsubF();
    };
  }, [server?.id]);

  if (!server) {
    return (
      <div className="facon-glass rounded-2xl p-10 text-center flex flex-col items-center gap-4">
        <Archive className="w-8 h-8 text-[#00FFFF]" />
        <h1 className="font-display text-xl font-semibold text-white">No server selected</h1>
        <p className="text-sm text-zinc-400">
          Select or deploy a server to manage your {FREE_PLAN_SPECS.backupsLimit} free container backups.
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
  const limitReached = backups.length >= FREE_PLAN_SPECS.backupsLimit;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSuspended) return;
    setError(null);
    setNotice(null);
    setCreating(true);
    try {
      await createServerBackup(
        server,
        name || `snapshot-${backups.length + 1}`,
        note,
        files.length,
        backups.length
      );
      setName('');
      setNote('');
      setNotice('Backup snapshot created successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create backup.');
    } finally {
      setCreating(false);
    }
  };

  const handleDownloadManifest = (bak: ServerBackup) => {
    const manifest = {
      platform: 'FACON HOST',
      serverId: server.id,
      serverName: server.name,
      runtime: server.runtime,
      backupName: bak.name,
      fileCount: bak.fileCount,
      sizeMb: bak.sizeMb,
      files: files.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, content: f.content })),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.name}-${bak.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Backup Management
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Each Free Server Plan includes {FREE_PLAN_SPECS.backupsLimit} full workspace snapshot slots.
          </p>
        </div>
        <div className="facon-glass rounded-xl px-4 py-2.5 flex items-center gap-3 self-start sm:self-auto">
          <span className="text-xs text-zinc-400">Slots Used</span>
          <span className="font-mono text-sm font-semibold text-[#00FFFF] tabular-nums">
            {backups.length} / {FREE_PLAN_SPECS.backupsLimit}
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-xs text-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-[#00FFFF]/30 bg-[#00FFFF]/10 p-4 text-xs text-[#00FFFF]">
          {notice}
        </div>
      )}

      {/* Create Backup Form */}
      <form onSubmit={handleCreate} className="facon-glass rounded-2xl p-6 grid md:grid-cols-12 gap-4 items-end">
        <div className="md:col-span-4">
          <label className="block text-xs font-medium text-zinc-300 mb-1.5">Snapshot Name</label>
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="pre-deploy-v1"
            className="w-full h-10 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white focus:outline-none focus:border-[#00FFFF]/60"
          />
        </div>
        <div className="md:col-span-5">
          <label className="block text-xs font-medium text-zinc-300 mb-1.5">Note (Optional)</label>
          <input
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Working Discord slash commands build"
            className="w-full h-10 px-3.5 rounded-lg bg-[#05080B] border border-white/10 text-sm text-white focus:outline-none focus:border-[#00FFFF]/60"
          />
        </div>
        <div className="md:col-span-3">
          <button
            type="submit"
            disabled={creating || limitReached || isSuspended}
            className="w-full h-10 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center justify-center gap-2 hover:bg-[#66FFFF] disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>
              {creating
                ? 'Snapshotting...'
                : limitReached
                ? `Slot Limit (${FREE_PLAN_SPECS.backupsLimit}/${FREE_PLAN_SPECS.backupsLimit})`
                : 'Create Snapshot'}
            </span>
          </button>
        </div>
      </form>

      {/* Backups List */}
      <div className="facon-glass rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-white">Saved Snapshots</h2>
          <span className="font-mono text-xs text-zinc-500 tabular-nums">
            {files.length} workspace files tracked
          </span>
        </div>

        {backups.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">
            No backups created for {server.name} yet. Create a snapshot above before pushing major bot updates.
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {backups.map((bak) => (
              <div
                key={bak.id}
                className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div>
                  <p className="font-display text-base font-semibold text-white">{bak.name}</p>
                  <p className="text-xs text-zinc-400 mt-1 flex items-center gap-2 flex-wrap">
                    <span className="font-mono tabular-nums">{bak.sizeMb} MB</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{bak.fileCount} files</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#00FFFF] capitalize">{bak.status}</span>
                    {bak.note && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{bak.note}</span>
                      </>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isSuspended}
                    onClick={async () => {
                      await restoreServerBackup(server.id, bak);
                      setNotice(`Restored snapshot "${bak.name}" to ${server.name}.`);
                    }}
                    className="h-9 px-3.5 rounded-lg border border-white/15 bg-white/[0.03] text-xs font-medium text-zinc-200 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restore</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadManifest(bak)}
                    className="h-9 px-3 rounded-lg border border-white/15 bg-white/[0.03] text-xs text-zinc-300 hover:text-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export</span>
                  </button>
                  <button
                    type="button"
                    disabled={isSuspended}
                    onClick={async () => {
                      await deleteServerBackup(server.id, bak.id);
                      setNotice(`Deleted snapshot "${bak.name}".`);
                    }}
                    className="h-9 w-9 rounded-lg border border-white/15 bg-white/[0.03] text-zinc-400 hover:text-rose-400 hover:border-rose-500/40 inline-flex items-center justify-center disabled:opacity-40 cursor-pointer"
                    aria-label={`Delete backup ${bak.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
