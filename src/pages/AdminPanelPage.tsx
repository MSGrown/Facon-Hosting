import React, { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Play, ShieldAlert, Square, Trash2 } from 'lucide-react';
import { ADMIN_BOOTSTRAPPED_EMAIL, BotServer, FREE_PLAN_SPECS, UserProfile } from '../types/hosting';
import { useAuth } from '../context/AuthContext';
import {
  adminSetServerStatus,
  adminToggleUserRole,
  adminToggleUserSuspension,
  deleteBotServer,
  subscribeToAllServersAdmin,
  subscribeToAllUsersAdmin,
} from '../services/hostingService';
import { deleteBackendRunner, startBackendRunner, stopBackendRunner } from '../services/runnerService';
import { StatusIndicator } from '../components/StatusIndicator';

export function AdminPanelPage() {
  const { user, isAdmin } = useAuth();
  const [allServers, setAllServers] = useState<BotServer[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [tab, setTab] = useState<'servers' | 'users'>('servers');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const unsubServers = subscribeToAllServersAdmin(setAllServers);
    const unsubUsers = subscribeToAllUsersAdmin(setAllUsers);
    return () => {
      unsubServers();
      unsubUsers();
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="facon-glass rounded-2xl p-10 text-center flex flex-col items-center gap-3">
        <ShieldAlert className="w-8 h-8 text-rose-400" />
        <h1 className="font-display text-xl font-semibold text-white">Administrator Access Required</h1>
        <p className="text-sm text-zinc-400 max-w-md">
          Your account does not hold platform administrator privileges.
        </p>
      </div>
    );
  }

  const runningNodes = allServers.filter((s) => s.status === 'running').length;
  const suspendedNodes = allServers.filter((s) => s.status === 'suspended').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Admin Panel
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Platform-wide container governance, node state overrides, and user access control.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#070A0F] border border-white/10 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setTab('servers')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
              tab === 'servers' ? 'bg-[#00FFFF] text-black font-semibold' : 'text-zinc-400 hover:text-white'
            }`}
          >
            All Servers ({allServers.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('users')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
              tab === 'users' ? 'bg-[#00FFFF] text-black font-semibold' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Users ({allUsers.length})
          </button>
        </div>
      </div>

      {/* Platform KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Total Users</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-1">
            {allUsers.length}
          </p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Provisioned Nodes</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-1">
            {allServers.length}
          </p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Active Containers</p>
          <p className="font-mono text-2xl font-semibold text-[#00FFFF] tabular-nums mt-1">
            {runningNodes}
          </p>
        </div>
        <div className="facon-glass rounded-xl p-5">
          <p className="text-xs text-zinc-400">Suspended Containers</p>
          <p className="font-mono text-2xl font-semibold text-rose-400 tabular-nums mt-1">
            {suspendedNodes}
          </p>
        </div>
      </div>

      {/* Free Plan Platform Baseline */}
      <div className="rounded-xl border border-[#00FFFF]/25 bg-[#00FFFF]/[0.04] px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        <span className="font-medium text-[#00FFFF]">Global FREE Tier Allocation</span>
        <span className="font-mono text-zinc-200 tabular-nums">
          {FREE_PLAN_SPECS.ramLabel} RAM · {FREE_PLAN_SPECS.cpuLabel} CPU · {FREE_PLAN_SPECS.diskLabel} Disk ·{' '}
          {FREE_PLAN_SPECS.bandwidthLabel} · {FREE_PLAN_SPECS.backupsLabel} Backups ·{' '}
          {FREE_PLAN_SPECS.maxServersPerUser} Servers/User
        </span>
      </div>

      {tab === 'servers' ? (
        <div className="facon-glass rounded-2xl overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="border-b border-white/[0.08] text-[11px] font-medium text-zinc-400">
                <th className="py-3.5 px-5">Server</th>
                <th className="py-3.5 px-4">Owner</th>
                <th className="py-3.5 px-4">Runtime / App</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4 text-right">CPU / RAM</th>
                <th className="py-3.5 px-5 text-right">Admin Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {allServers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-zinc-500">
                    No servers deployed on the platform yet.
                  </td>
                </tr>
              ) : (
                allServers.map((srv) => (
                  <tr key={srv.id} className="hover:bg-white/[0.02]">
                    <td className="py-3.5 px-5">
                      <p className="font-medium text-white">{srv.name}</p>
                      <p className="font-mono text-[11px] text-zinc-500">{srv.nodeRegion}</p>
                    </td>
                    <td className="py-3.5 px-4 text-zinc-300">{srv.ownerEmail}</td>
                    <td className="py-3.5 px-4 text-zinc-300">
                      {srv.runtime} · {srv.appType}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusIndicator status={srv.status} compact />
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-zinc-300 tabular-nums">
                      {srv.cpuUsage}%/{srv.cpuLimitPct}% · {srv.ramUsageMb}/
                      {Math.round(srv.ramLimitMb / 1024)}GB
                    </td>
                    <td className="py-3.5 px-5">
                      <div className="flex items-center justify-end gap-1.5">
                        {srv.status !== 'running' && (
                          <button
                            type="button"
                            disabled={busyId === srv.id}
                            onClick={async () => {
                              setBusyId(srv.id);
                              try {
                                await startBackendRunner(srv).catch(() => {});
                                await adminSetServerStatus(srv.id, 'running');
                              } finally {
                                setBusyId(null);
                              }
                            }}
                            title="Force Start / Restore"
                            className="h-8 px-2.5 rounded-md border border-white/10 text-zinc-200 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Play className="w-3 h-3" />
                            <span>Start</span>
                          </button>
                        )}
                        {srv.status === 'running' && (
                          <button
                            type="button"
                            disabled={busyId === srv.id}
                            onClick={async () => {
                              setBusyId(srv.id);
                              try {
                                await stopBackendRunner(srv.id).catch(() => {});
                                await adminSetServerStatus(srv.id, 'stopped');
                              } finally {
                                setBusyId(null);
                              }
                            }}
                            title="Stop container"
                            className="h-8 px-2.5 rounded-md border border-white/10 text-zinc-300 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Square className="w-3 h-3" />
                            <span>Stop</span>
                          </button>
                        )}
                        {srv.status !== 'suspended' ? (
                          <button
                            type="button"
                            disabled={busyId === srv.id}
                            onClick={async () => {
                              setBusyId(srv.id);
                              try {
                                await stopBackendRunner(srv.id).catch(() => {});
                                await adminSetServerStatus(srv.id, 'suspended');
                              } finally {
                                setBusyId(null);
                              }
                            }}
                            className="h-8 px-2.5 rounded-md border border-rose-500/30 text-rose-300 hover:bg-rose-500/15 inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Ban className="w-3 h-3" />
                            <span>Suspend</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === srv.id}
                            onClick={async () => {
                              setBusyId(srv.id);
                              await adminSetServerStatus(srv.id, 'stopped');
                              setBusyId(null);
                            }}
                            className="h-8 px-2.5 rounded-md border border-[#00FFFF]/30 text-[#00FFFF] hover:bg-[#00FFFF]/10 inline-flex items-center gap-1 cursor-pointer"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Unsuspend</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId === srv.id}
                          onClick={async () => {
                            setBusyId(srv.id);
                            try {
                              await deleteBackendRunner(srv.id).catch(() => {});
                              await deleteBotServer(srv.id);
                            } finally {
                              setBusyId(null);
                            }
                          }}
                          title="Delete server"
                          className="h-8 w-8 rounded-md border border-white/10 text-zinc-400 hover:text-rose-400 inline-flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="facon-glass rounded-2xl overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="border-b border-white/[0.08] text-[11px] font-medium text-zinc-400">
                <th className="py-3.5 px-5">Developer</th>
                <th className="py-3.5 px-4">Email</th>
                <th className="py-3.5 px-4">Role</th>
                <th className="py-3.5 px-4">Account State</th>
                <th className="py-3.5 px-5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {allUsers.map((u) => {
                const isPrimaryAdmin = u.email === ADMIN_BOOTSTRAPPED_EMAIL;
                return (
                  <tr key={u.uid} className="hover:bg-white/[0.02]">
                    <td className="py-3.5 px-5 font-medium text-white">{u.displayName}</td>
                    <td className="py-3.5 px-4 text-zinc-300">{u.email}</td>
                    <td className="py-3.5 px-4 font-mono text-[#00FFFF]">
                      {isPrimaryAdmin ? 'admin (root)' : u.role}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={u.suspended ? 'text-rose-400' : 'text-zinc-300'}>
                        {u.suspended
                          ? 'Suspended'
                          : `Active · FREE (${Math.max(
                              FREE_PLAN_SPECS.maxServersPerUser,
                              u.serverLimit || FREE_PLAN_SPECS.maxServersPerUser
                            )} servers)`}
                      </span>
                    </td>
                    <td className="py-3.5 px-5">
                      <div className="flex items-center justify-end gap-2">
                        {!isPrimaryAdmin && user && (
                          <>
                            <button
                              type="button"
                              disabled={busyId === u.uid}
                              onClick={async () => {
                                setBusyId(u.uid);
                                await adminToggleUserRole(
                                  u,
                                  u.role === 'admin' ? 'user' : 'admin',
                                  user.uid
                                );
                                setBusyId(null);
                              }}
                              className="h-8 px-3 rounded-md border border-white/15 text-zinc-300 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] cursor-pointer"
                            >
                              {u.role === 'admin' ? 'Revoke Admin' : 'Make Admin'}
                            </button>
                            <button
                              type="button"
                              disabled={busyId === u.uid}
                              onClick={async () => {
                                setBusyId(u.uid);
                                await adminToggleUserSuspension(u, !u.suspended);
                                setBusyId(null);
                              }}
                              className={`h-8 px-3 rounded-md border cursor-pointer ${
                                u.suspended
                                  ? 'border-[#00FFFF]/35 text-[#00FFFF]'
                                  : 'border-rose-500/35 text-rose-300'
                              }`}
                            >
                              {u.suspended ? 'Restore' : 'Suspend'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
