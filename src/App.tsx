/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DashboardShell } from './components/DashboardShell';
import { TelemetryPoint } from './components/TelemetryChart';
import { HomePage } from './pages/HomePage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { ServersPage } from './pages/ServersPage';
import { CreateServerPage } from './pages/CreateServerPage';
import { ConsolePage } from './pages/ConsolePage';
import { FileManagerPage } from './pages/FileManagerPage';
import { StartupPage } from './pages/StartupPage';
import { BackupsPage } from './pages/BackupsPage';
import { AccountSettingsPage } from './pages/AccountSettingsPage';
import { AdminPanelPage } from './pages/AdminPanelPage';
import {
  deleteBotServer,
  subscribeToUserServers,
  updateServerPowerState,
  updateServerTelemetrySample,
  upgradeLegacyServerPlan,
} from './services/hostingService';
import {
  deleteBackendRunner,
  getBackendRunnerFleet,
  RunnerFleetSummary,
  RunnerSnapshot,
  startBackendRunner,
  stopBackendRunner,
} from './services/runnerService';
import { AppPage, BotServer, FREE_PLAN_SPECS, ServerStatus } from './types/hosting';

const PROTECTED_PAGES: AppPage[] = [
  'dashboard',
  'servers',
  'create-server',
  'console',
  'files',
  'startup',
  'backups',
  'settings',
  'admin',
];

function parseInitialPage(): AppPage {
  const hash = window.location.hash.replace(/^#\/?/, '') as AppPage;
  const all: AppPage[] = [
    'home',
    'login',
    'register',
    ...PROTECTED_PAGES,
  ];
  return all.includes(hash) ? hash : 'home';
}

function nowTimeLabel(): string {
  const d = new Date();
  return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function snapshotToFleetSummary(snap: RunnerSnapshot): RunnerFleetSummary {
  return {
    serverId: snap.serverId,
    ownerUid: snap.ownerUid,
    enabled: snap.enabled,
    state: snap.state,
    pid: snap.pid,
    exitCode: snap.exitCode,
    startedAt: snap.startedAt,
    lastOfflineAt: snap.lastOfflineAt,
    telemetry: snap.telemetry,
    gateway: snap.gateway,
    health: snap.health,
  };
}

function FaconHostRouter() {
  const { user, loading: authLoading } = useAuth();
  const [page, setPage] = useState<AppPage>(() => parseInitialPage());
  const [servers, setServers] = useState<BotServer[]>([]);
  const [serversLoading, setServersLoading] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [fleetById, setFleetById] = useState<Record<string, RunnerFleetSummary>>({});
  const [fleetLoaded, setFleetLoaded] = useState(false);

  const [cpuHistory, setCpuHistory] = useState<TelemetryPoint[]>([]);
  const [ramHistory, setRamHistory] = useState<TelemetryPoint[]>([]);
  const [diskHistory, setDiskHistory] = useState<TelemetryPoint[]>([]);

  const reviveAttemptAtRef = useRef<Map<string, number>>(new Map());
  const manuallyStoppedRef = useRef<Set<string>>(new Set());

  const navigate = (next: AppPage) => {
    setPage(next);
    window.location.hash = next === 'home' ? '' : `#/${next}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const onHash = () => setPage(parseInitialPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Auth route guard
  useEffect(() => {
    if (authLoading) return;
    const isVerifiedUser = Boolean(user && user.emailVerified);

    if (PROTECTED_PAGES.includes(page) && !isVerifiedUser) {
      navigate('login');
    } else if ((page === 'login' || page === 'register') && isVerifiedUser) {
      navigate('dashboard');
    }
  }, [authLoading, user, page]);

  // Firestore servers subscription
  useEffect(() => {
    if (!user || !user.emailVerified) {
      setServers([]);
      setSelectedServerId(null);
      return;
    }

    setServersLoading(true);
    const unsub = subscribeToUserServers(
      user.uid,
      (list) => {
        setServers(list);
        setServersLoading(false);
        setSelectedServerId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          return list[0]?.id || null;
        });
        for (const srv of list) {
          if (
            srv.status !== 'suspended' &&
            (srv.ramLimitMb < FREE_PLAN_SPECS.ramMb ||
              srv.cpuLimitPct < FREE_PLAN_SPECS.cpuPct ||
              srv.diskLimitMb < FREE_PLAN_SPECS.diskMb ||
              srv.bandwidthMbps < FREE_PLAN_SPECS.bandwidthMbps ||
              srv.backupLimit < FREE_PLAN_SPECS.backupsLimit)
          ) {
            void upgradeLegacyServerPlan(srv);
          }
        }
      },
      () => setServersLoading(false)
    );
    return () => unsub();
  }, [user?.uid, user?.emailVerified]);

  // Poll authoritative backend supervisor fleet status every 3.5s
  useEffect(() => {
    reviveAttemptAtRef.current.clear();
    manuallyStoppedRef.current.clear();
    if (!user || !user.emailVerified) {
      setFleetById({});
      setFleetLoaded(false);
      return;
    }

    let cancelled = false;
    const syncFleet = async () => {
      try {
        const list = await getBackendRunnerFleet();
        if (cancelled) return;
        const map: Record<string, RunnerFleetSummary> = {};
        for (const item of list) {
          map[item.serverId] = item;
        }
        setFleetById(map);
        setFleetLoaded(true);
      } catch {
        // Keep previous snapshot on transient network hiccup
      }
    };

    void syncFleet();
    const timer = window.setInterval(() => void syncFleet(), 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user?.uid, user?.emailVerified]);

  // Merge strictly truthful backend process state & real telemetry into server records
  const displayServers = useMemo<BotServer[]>(() => {
    return servers.map((srv) => {
      if (srv.status === 'suspended') {
        return {
          ...srv,
          cpuUsage: 0,
          ramUsageMb: 0,
          networkMbps: 0,
          uptimeSeconds: 0,
        };
      }

      const runner = fleetById[srv.id];
      if (runner) {
        let resolvedStatus: ServerStatus = 'stopped';
        if (runner.state === 'running') {
          resolvedStatus = 'running';
        } else if (runner.state === 'starting') {
          resolvedStatus = 'starting';
        } else if (runner.state === 'crashed') {
          resolvedStatus = runner.enabled && runner.health.nextRecoveryAt ? 'restarting' : 'stopped';
        }

        const isRunning = resolvedStatus === 'running';
        return {
          ...srv,
          status: resolvedStatus,
          cpuUsage: isRunning ? runner.telemetry.cpuPct : 0,
          ramUsageMb: isRunning ? runner.telemetry.ramMb : 0,
          diskUsageMb: runner.telemetry.diskMb > 0 ? runner.telemetry.diskMb : srv.diskUsageMb,
          networkMbps: 0,
          uptimeSeconds: isRunning ? runner.telemetry.uptimeSeconds : 0,
        };
      }

      if (fleetLoaded) {
        const revivingColdStart =
          (srv.status === 'running' || srv.status === 'starting' || srv.status === 'restarting') &&
          srv.autoRestart &&
          !manuallyStoppedRef.current.has(srv.id) &&
          reviveAttemptAtRef.current.has(srv.id);
        return {
          ...srv,
          status: revivingColdStart ? 'starting' : 'stopped',
          cpuUsage: 0,
          ramUsageMb: 0,
          networkMbps: 0,
          uptimeSeconds: 0,
        };
      }

      return srv;
    });
  }, [servers, fleetById, fleetLoaded]);

  const activeServer = useMemo(
    () => displayServers.find((s) => s.id === selectedServerId) || displayServers[0] || null,
    [displayServers, selectedServerId]
  );

  // Record rolling telemetry history from genuine backend metrics
  useEffect(() => {
    const isServerScoped = ['console', 'files', 'startup', 'backups'].includes(page);
    const targetCpu = isServerScoped && activeServer
      ? activeServer.cpuUsage
      : displayServers.reduce((sum, s) => sum + s.cpuUsage, 0);
    const targetRam = isServerScoped && activeServer
      ? activeServer.ramUsageMb
      : displayServers.reduce((sum, s) => sum + s.ramUsageMb, 0);
    const targetDisk = isServerScoped && activeServer
      ? activeServer.diskUsageMb
      : displayServers.reduce((sum, s) => sum + s.diskUsageMb, 0);

    const label = nowTimeLabel();
    setCpuHistory((prev) => [...prev.slice(-11), { label, value: targetCpu }]);
    setRamHistory((prev) => [...prev.slice(-11), { label, value: targetRam }]);
    setDiskHistory((prev) => [...prev.slice(-11), { label, value: targetDisk }]);
  }, [displayServers, activeServer?.id, page]);

  // Cold-start auto-revive: if container recycled on Cloud Run while enabled bots were running, restore them automatically
  useEffect(() => {
    if (!fleetLoaded || !user || !user.emailVerified) return;

    const now = Date.now();
    for (const srv of servers) {
      if (srv.status === 'suspended') continue;
      if (manuallyStoppedRef.current.has(srv.id)) continue;
      const shouldBeOnline =
        (srv.status === 'running' || srv.status === 'starting' || srv.status === 'restarting') &&
        Boolean(srv.autoRestart);
      if (!shouldBeOnline) continue;

      const runner = fleetById[srv.id];
      const runnerNeedsRevive = !runner || (runner.state === 'stopped' && !runner.enabled);
      if (!runnerNeedsRevive) continue;

      const lastAttempt = reviveAttemptAtRef.current.get(srv.id) || 0;
      if (now - lastAttempt < 20000) continue;

      reviveAttemptAtRef.current.set(srv.id, now);
      void startBackendRunner(srv)
        .then((snap) => {
          setFleetById((prev) => ({ ...prev, [srv.id]: snapshotToFleetSummary(snap) }));
        })
        .catch(() => {
          // Keep Firestore desired-online state intact so next supervisor/fleet tick retries cleanly
        });
    }
  }, [fleetLoaded, servers, fleetById, user?.uid, user?.emailVerified]);

  const hasActiveBots = useMemo(
    () =>
      displayServers.some(
        (s) => s.status === 'running' || s.status === 'starting' || s.status === 'restarting'
      ),
    [displayServers]
  );

  // Keep container HTTP & CPU warm across ALL pages while user has dashboard open and any bot is running (plus instant wake on tab resume)
  useEffect(() => {
    if (!user || !user.emailVerified || !hasActiveBots) return;

    let closed = false;
    let stream: EventSource | null = null;
    let reconnectTimer: number | null = null;

    const connectStream = () => {
      if (closed || typeof EventSource === 'undefined') return;
      try {
        stream?.close();
      } catch {
        // ignore close error
      }
      const es = new EventSource('/api/keepalive-stream');
      stream = es;
      es.onerror = () => {
        try {
          es.close();
        } catch {
          // ignore
        }
        if (stream === es) stream = null;
        if (!closed && reconnectTimer === null) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectStream();
          }, 5000);
        }
      };
    };

    const ping = () => {
      void fetch('/api/ping?source=dashboard', { cache: 'no-store' }).catch(() => {});
      if (!stream || stream.readyState === EventSource.CLOSED) {
        connectStream();
      }
    };
    const onResume = () => {
      if (document.visibilityState === 'visible') {
        ping();
      }
    };

    connectStream();
    ping();
    const timer = window.setInterval(ping, 20000);
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('online', ping);
    return () => {
      closed = true;
      window.clearInterval(timer);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      try {
        stream?.close();
      } catch {
        // ignore close error
      }
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', ping);
    };
  }, [user?.uid, user?.emailVerified, hasActiveBots]);

  // Periodically persist genuine live backend telemetry to Firestore (never fake numbers)
  useEffect(() => {
    if (!fleetLoaded || !PROTECTED_PAGES.includes(page)) return;

    const timer = window.setInterval(() => {
      for (const srv of servers) {
        if (srv.status === 'suspended') continue;
        const runner = fleetById[srv.id];
        if (!runner) {
          const awaitingColdStartRevive =
            (srv.status === 'running' || srv.status === 'starting' || srv.status === 'restarting') &&
            Boolean(srv.autoRestart) &&
            !manuallyStoppedRef.current.has(srv.id);
          if (
            !awaitingColdStartRevive &&
            (srv.status === 'running' || srv.cpuUsage > 0 || srv.ramUsageMb > 0 || srv.uptimeSeconds > 0)
          ) {
            void updateServerTelemetrySample(srv, undefined, 'stopped');
          }
          continue;
        }
        if (runner.state === 'running') {
          void updateServerTelemetrySample(srv, runner.telemetry, 'running');
        } else {
          const truthfulStatus: ServerStatus =
            runner.state === 'starting'
              ? 'starting'
              : runner.enabled || (runner.state === 'crashed' && runner.health.nextRecoveryAt)
              ? 'restarting'
              : 'stopped';
          if (srv.status !== truthfulStatus || srv.cpuUsage > 0 || srv.uptimeSeconds > 0) {
            void updateServerTelemetrySample(srv, runner.telemetry, truthfulStatus);
          }
        }
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [servers, fleetById, fleetLoaded, page]);

  const handleOpenConsole = (serverId: string) => {
    setSelectedServerId(serverId);
    navigate('console');
  };

  const handlePowerAction = async (
    server: BotServer,
    action: 'start' | 'stop' | 'restart'
  ): Promise<RunnerSnapshot> => {
    if (action === 'stop') {
      manuallyStoppedRef.current.add(server.id);
      reviveAttemptAtRef.current.delete(server.id);
    } else {
      manuallyStoppedRef.current.delete(server.id);
      reviveAttemptAtRef.current.set(server.id, Date.now());
    }

    await updateServerPowerState(server, action);
    if (action === 'stop') {
      const snap = await stopBackendRunner(server.id);
      setFleetById((prev) => ({ ...prev, [server.id]: snapshotToFleetSummary(snap) }));
      await updateServerTelemetrySample(server, snap.telemetry, 'stopped');
      return snap;
    } else {
      try {
        const snap = await startBackendRunner(server);
        setFleetById((prev) => ({ ...prev, [server.id]: snapshotToFleetSummary(snap) }));
        await updateServerTelemetrySample(
          server,
          snap.telemetry,
          snap.state === 'running' ? 'running' : snap.enabled ? 'starting' : 'stopped'
        );
        return snap;
      } catch (err) {
        if (!server.autoRestart) {
          await updateServerTelemetrySample(server, undefined, 'stopped').catch(() => {});
        }
        throw err;
      }
    }
  };

  const handleDeleteServer = async (server: BotServer) => {
    await deleteBackendRunner(server.id).catch(() => {
      // Proceed with Firestore delete even if runner directory did not exist
    });
    await deleteBotServer(server.id);
    setFleetById((prev) => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });
    if (selectedServerId === server.id) {
      setSelectedServerId(null);
    }
  };

  if (authLoading && PROTECTED_PAGES.includes(page)) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-[#00FFFF]/30 border-t-[#00FFFF] animate-spin" />
          <p className="text-xs font-mono text-zinc-400">Connecting to FACON HOST...</p>
        </div>
      </div>
    );
  }

  if (page === 'home') {
    return <HomePage onNavigate={navigate} />;
  }

  if (page === 'login' || page === 'register') {
    return <AuthPage mode={page} onNavigate={navigate} />;
  }

  return (
    <DashboardShell
      currentPage={page}
      onNavigate={navigate}
      servers={displayServers}
      activeServer={activeServer}
      onSelectServer={setSelectedServerId}
    >
      {page === 'dashboard' && (
        <DashboardPage
          servers={displayServers}
          runnerFleetMap={fleetById}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
          diskHistory={diskHistory}
          onNavigate={navigate}
          onOpenConsole={handleOpenConsole}
          onPowerAction={handlePowerAction}
          loading={serversLoading}
        />
      )}

      {page === 'servers' && (
        <ServersPage
          servers={displayServers}
          runnerFleetMap={fleetById}
          onNavigate={navigate}
          onOpenConsole={handleOpenConsole}
          onPowerAction={handlePowerAction}
          onDeleteServer={handleDeleteServer}
        />
      )}

      {page === 'create-server' && (
        <CreateServerPage
          existingServerCount={servers.length}
          onCreated={(newId) => {
            setSelectedServerId(newId);
            navigate('console');
          }}
          onNavigate={navigate}
        />
      )}

      {page === 'console' && (
        <ConsolePage
          server={activeServer}
          fleetSummary={activeServer ? fleetById[activeServer.id] : undefined}
          cpuHistory={cpuHistory}
          ramHistory={ramHistory}
          diskHistory={diskHistory}
          onPowerAction={handlePowerAction}
          onNavigate={navigate}
        />
      )}

      {page === 'files' && <FileManagerPage server={activeServer} onNavigate={navigate} />}

      {page === 'startup' && <StartupPage server={activeServer} onNavigate={navigate} />}

      {page === 'backups' && <BackupsPage server={activeServer} onNavigate={navigate} />}

      {page === 'settings' && (
        <AccountSettingsPage serverCount={servers.length} onNavigate={navigate} />
      )}

      {page === 'admin' && <AdminPanelPage />}
    </DashboardShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <FaconHostRouter />
      </AuthProvider>
    </ErrorBoundary>
  );
}
