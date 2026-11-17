import React, { useMemo, useState } from 'react';
import { PlusSquare, Search, Trash2 } from 'lucide-react';
import { AppPage, BotServer, FREE_PLAN_SPECS, ServerStatus } from '../types/hosting';
import { RunnerFleetSummary } from '../services/runnerService';
import { ServerCard } from '../components/ServerCard';

interface ServersPageProps {
  servers: BotServer[];
  runnerFleetMap?: Record<string, RunnerFleetSummary>;
  onNavigate: (page: AppPage) => void;
  onOpenConsole: (serverId: string) => void;
  onPowerAction: (server: BotServer, action: 'start' | 'stop' | 'restart') => Promise<unknown>;
  onDeleteServer: (server: BotServer) => Promise<void>;
}

export function ServersPage({
  servers,
  runnerFleetMap,
  onNavigate,
  onOpenConsole,
  onPowerAction,
  onDeleteServer,
}: ServersPageProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ServerStatus>('all');
  const [confirmDelete, setConfirmDelete] = useState<BotServer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return servers.filter((srv) => {
      const matchesStatus = statusFilter === 'all' || srv.status === statusFilter;
      const matchesQuery =
        !q ||
        srv.name.toLowerCase().includes(q) ||
        srv.runtime.toLowerCase().includes(q) ||
        srv.appType.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [servers, search, statusFilter]);

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await onDeleteServer(confirmDelete);
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Servers
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Manage power states, inspect telemetry, or open a live server console ({servers.length} /{' '}
            {FREE_PLAN_SPECS.maxServersPerUser} free nodes deployed).
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('create-server')}
          className="h-10 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] transition-colors self-start sm:self-auto cursor-pointer"
        >
          <PlusSquare className="w-4 h-4" />
          <span>New Free Server</span>
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by server name, runtime, or bot type..."
            className="w-full h-10 pl-10 pr-4 rounded-lg bg-[#06090D] border border-white/10 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#00FFFF]/60"
          />
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#070A0F] border border-white/10 overflow-x-auto">
          {(['all', 'running', 'stopped', 'suspended'] as const).map((tab) => {
            const active = statusFilter === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors whitespace-nowrap cursor-pointer ${
                  active ? 'bg-[#00FFFF] text-black font-semibold' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {tab}
              </button>
            );
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="facon-glass rounded-xl p-10 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-zinc-300 font-medium">
            {servers.length === 0 ? 'No servers deployed yet' : 'No servers match your filter'}
          </p>
          <p className="text-xs text-zinc-500">
            {servers.length === 0
              ? 'Create your first free container to begin hosting.'
              : 'Clear your search query or select a different status filter.'}
          </p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {filtered.map((srv) => (
            <ServerCard
              key={srv.id}
              server={srv}
              runnerSummary={runnerFleetMap?.[srv.id]}
              onOpenConsole={onOpenConsole}
              onPowerAction={onPowerAction}
              onDelete={async (s) => setConfirmDelete(s)}
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="facon-glass rounded-2xl max-w-md w-full p-6 flex flex-col gap-5">
            <div className="flex items-center gap-3 text-rose-400">
              <Trash2 className="w-5 h-5" />
              <h2 className="font-display text-lg font-semibold text-white">
                Delete Server Container
              </h2>
            </div>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Are you sure you want to permanently remove{' '}
              <span className="text-white font-medium">{confirmDelete.name}</span>? All workspace
              files and environment variables inside this node will be deleted.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmDelete(null)}
                className="h-10 px-4 rounded-lg border border-white/15 text-xs font-medium text-zinc-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="h-10 px-4 rounded-lg bg-rose-500 text-white text-xs font-semibold hover:bg-rose-400 disabled:opacity-50 cursor-pointer"
              >
                {deleting ? 'Deleting...' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
