import { collection, getDocs } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { BotServer, ServerEnvVar, ServerFile } from '../types/hosting';

export type RunnerProcessState = 'stopped' | 'starting' | 'running' | 'crashed';
export type RunnerLogLevel = 'stdout' | 'stderr' | 'system' | 'gateway' | 'cmd';
export type RunnerHealthState = 'stopped' | 'healthy' | 'degraded' | 'recovering' | 'error';

export interface RunnerLogEntry {
  id: string;
  level: RunnerLogLevel;
  message: string;
  timestamp: string;
}

export interface DiscordGatewayStatus {
  appType: string;
  tokenPresent: boolean;
  tokenStatus: 'missing' | 'placeholder' | 'checking' | 'valid' | 'invalid' | 'error';
  connectionState: 'offline' | 'connecting' | 'online' | 'error';
  presenceStatus?: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
  activityType?: string | null;
  activityName?: string | null;
  guildCount?: number | null;
  botTag: string | null;
  botId: string | null;
  gatewayUrl: string | null;
  shards: number | null;
  sessionRemaining: number | null;
  sessionTotal: number | null;
  latencyMs: number | null;
  lastEvent: string;
  updatedAt: string;
}

export interface RunnerHealthStatus {
  status: RunnerHealthState;
  errorCount: number;
  restartCount: number;
  crashCount: number;
  oomCount: number;
  lastError: string | null;
  offlineReason: string | null;
  diagnosticHint: string | null;
  fatalError: boolean;
  rateLimitedUntil: string | null;
  nextRecoveryAt: string | null;
  lastCheckAt: string;
}

export interface RunnerTelemetry {
  cpuPct: number;
  ramMb: number;
  diskMb: number;
  uptimeSeconds: number;
  totalUptimeSeconds: number;
}

export interface HostCapabilities {
  nodeVersion: string;
  pythonVersion: string | null;
  javaAvailable: boolean;
  tsxAvailable: boolean;
  discordJsInstalled: boolean;
  availableRuntimes: string[];
  maxServersPerUser: number;
  hostTotalRamMb: number;
}

export interface RunnerSnapshot {
  serverId: string;
  ownerUid: string;
  enabled: boolean;
  state: RunnerProcessState;
  pid: number | null;
  startupCommand: string;
  runtime: string;
  appType: string;
  exitCode: number | null;
  startedAt: string | null;
  lastOfflineAt: string | null;
  telemetry: RunnerTelemetry;
  gateway: DiscordGatewayStatus;
  health: RunnerHealthStatus;
  logs: RunnerLogEntry[];
  hostCapabilities: HostCapabilities;
}

export interface RunnerFleetSummary {
  serverId: string;
  ownerUid: string;
  enabled: boolean;
  state: RunnerProcessState;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  lastOfflineAt: string | null;
  telemetry: RunnerTelemetry;
  gateway: DiscordGatewayStatus;
  health: RunnerHealthStatus;
}

export type HostUptimeMode = 'dedicated-24x7' | 'ai-studio-auto-sleep' | 'probing';

export interface HostHealthReport {
  ok: boolean;
  instanceId: string;
  service: string;
  alwaysOnlineMode: boolean;
  uptimeMode: HostUptimeMode;
  authProxyDetected: boolean;
  publicDomain: string;
  host: string;
  protocol: string;
  observedOrigin: string | null;
  verifiedOrigins: string[];
  publicAppUrl: string | null;
  configuredCustomDomains: string[];
  activeRunners: number;
  hasEnabledRunners: boolean;
  lastExternalPingAt: string | null;
  lastSelfPingAt: string | null;
  lastSelfPingOk: boolean | null;
  capabilities: HostCapabilities;
}

export const CLOUD_RUN_24X7_DEPLOY_COMMAND =
  'gcloud run deploy facon-host --source . --region asia-east1 --project nimble-sandbox-dlvvl --min-instances=1 --no-cpu-throttling --timeout=3600 --allow-unauthenticated --set-env-vars PUBLIC_APP_URL=https://faconmodshosting.ai.studio,CUSTOM_DOMAIN=faconmodshosting.ai.studio';

export async function getHostHealth(): Promise<HostHealthReport> {
  const res = await fetch('/api/health', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Health check failed (HTTP ${res.status})`);
  }
  return (await res.json()) as HostHealthReport;
}

async function getIdTokenOrThrow(forceRefresh = false): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required to access backend runner.');
  }
  return user.getIdToken(forceRefresh);
}

async function authorizedFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let token = await getIdTokenOrThrow();
  let res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    token = await getIdTokenOrThrow(true);
    res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers || {}),
      },
    });
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Runner API error (HTTP ${res.status})`);
  }
  return data;
}

async function fetchServerWorkspace(serverId: string): Promise<{
  files: { path: string; content: string; isDirectory: boolean }[];
  envVars: { key: string; value: string }[];
}> {
  const [filesSnap, envSnap] = await Promise.all([
    getDocs(collection(db, 'servers', serverId, 'files')),
    getDocs(collection(db, 'servers', serverId, 'envVars')),
  ]);

  const files = filesSnap.docs.map((d) => {
    const f = d.data() as ServerFile;
    return {
      path: f.path,
      content: f.content || '',
      isDirectory: Boolean(f.isDirectory),
    };
  });

  const envVars = envSnap.docs.map((d) => {
    const v = d.data() as ServerEnvVar;
    return {
      key: v.key,
      value: v.value || '',
    };
  });

  return { files, envVars };
}

export async function startBackendRunner(server: BotServer): Promise<RunnerSnapshot> {
  const { files, envVars } = await fetchServerWorkspace(server.id);
  return authorizedFetch<RunnerSnapshot>('/api/runner/start', {
    method: 'POST',
    body: JSON.stringify({
      serverId: server.id,
      ownerUid: server.ownerId,
      name: server.name,
      runtime: server.runtime,
      appType: server.appType,
      startupCommand: server.startupCommand,
      autoRestart: server.autoRestart,
      files,
      envVars,
    }),
  });
}

export async function stopBackendRunner(serverId: string): Promise<RunnerSnapshot> {
  return authorizedFetch<RunnerSnapshot>('/api/runner/stop', {
    method: 'POST',
    body: JSON.stringify({ serverId }),
  });
}

export async function deleteBackendRunner(serverId: string): Promise<void> {
  await authorizedFetch<{ ok: boolean }>(`/api/runner/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  });
}

export async function getBackendRunnerFleet(): Promise<RunnerFleetSummary[]> {
  const res = await authorizedFetch<{ fleet: RunnerFleetSummary[] }>('/api/runner/fleet');
  return Array.isArray(res.fleet) ? res.fleet : [];
}

export async function getBackendRunnerStatus(serverId: string): Promise<RunnerSnapshot> {
  return authorizedFetch<RunnerSnapshot>(`/api/runner/status/${encodeURIComponent(serverId)}`);
}

export async function sendBackendStdin(serverId: string, input: string): Promise<void> {
  await authorizedFetch<{ ok: boolean }>('/api/runner/stdin', {
    method: 'POST',
    body: JSON.stringify({ serverId, input }),
  });
}

export async function verifyServerDiscordGateway(server: BotServer): Promise<DiscordGatewayStatus> {
  const envSnap = await getDocs(collection(db, 'servers', server.id, 'envVars'));
  const envList = envSnap.docs.map((d) => d.data() as ServerEnvVar);
  const candidateKeys = ['DISCORD_TOKEN', 'BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'TOKEN'];
  const tokenDoc = candidateKeys
    .map((key) => envList.find((v) => v.key === key && String(v.value || '').trim()))
    .find(Boolean);
  const res = await authorizedFetch<{ gateway: DiscordGatewayStatus }>('/api/runner/verify-discord', {
    method: 'POST',
    body: JSON.stringify({
      serverId: server.id,
      token: tokenDoc?.value || '',
    }),
  });
  return res.gateway;
}

export interface StreamCallbacks {
  onInit: (snapshot: RunnerSnapshot) => void;
  onLog: (entry: RunnerLogEntry) => void;
  onState: (payload: {
    state: RunnerProcessState;
    pid: number | null;
    exitCode: number | null;
    startedAt: string | null;
    telemetry: RunnerTelemetry;
    gateway: DiscordGatewayStatus;
    health?: RunnerHealthStatus;
  }) => void;
  onTelemetry: (telemetry: RunnerTelemetry) => void;
  onGateway: (gateway: DiscordGatewayStatus) => void;
  onHealth?: (health: RunnerHealthStatus) => void;
  onConnectionChange: (connected: boolean, transport?: 'ws' | 'sse' | 'reconnecting') => void;
}

export function connectRunnerStream(serverId: string, callbacks: StreamCallbacks): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let sseAbort: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let connectTimeoutTimer: number | null = null;
  let lastActivityAt = Date.now();
  let wsFailures = 0;

  const stopTimers = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (connectTimeoutTimer !== null) {
      window.clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
  };

  const dispatchMessage = (rawJson: string) => {
    lastActivityAt = Date.now();
    try {
      const msg = JSON.parse(rawJson) as {
        type: string;
        snapshot?: RunnerSnapshot;
        entry?: RunnerLogEntry;
        state?: RunnerProcessState;
        pid?: number | null;
        exitCode?: number | null;
        startedAt?: string | null;
        telemetry?: RunnerTelemetry;
        gateway?: DiscordGatewayStatus;
        health?: RunnerHealthStatus;
      };

      if (msg.type === 'pong') {
        return;
      } else if (msg.type === 'init' && msg.snapshot) {
        callbacks.onInit(msg.snapshot);
      } else if (msg.type === 'log' && msg.entry) {
        callbacks.onLog(msg.entry);
      } else if (msg.type === 'state' && msg.state && msg.telemetry && msg.gateway) {
        callbacks.onState({
          state: msg.state,
          pid: msg.pid ?? null,
          exitCode: msg.exitCode ?? null,
          startedAt: msg.startedAt ?? null,
          telemetry: msg.telemetry,
          gateway: msg.gateway,
          health: msg.health,
        });
      } else if (msg.type === 'telemetry' && msg.telemetry) {
        callbacks.onTelemetry(msg.telemetry);
      } else if (msg.type === 'gateway' && msg.gateway) {
        callbacks.onGateway(msg.gateway);
      } else if (msg.type === 'health' && msg.health) {
        callbacks.onHealth?.(msg.health);
      }
    } catch {
      // ignore malformed event
    }
  };

  const openSseStream = async () => {
    if (closed) return;
    stopTimers();
    sseAbort?.abort();
    const controller = new AbortController();
    sseAbort = controller;

    try {
      let token = await getIdTokenOrThrow(wsFailures > 0);
      if (closed) return;
      let res = await fetch(`/api/runner/stream/${encodeURIComponent(serverId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        cache: 'no-store',
        signal: controller.signal,
      });

      if (res.status === 401 && !closed) {
        token = await getIdTokenOrThrow(true);
        res = await fetch(`/api/runner/stream/${encodeURIComponent(serverId)}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
      }

      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      callbacks.onConnectionChange(true, 'sse');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const evt of events) {
          const dataLines = evt
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length > 0) {
            dispatchMessage(dataLines.join('\n'));
          }
        }
      }
    } catch {
      // Fall through to reconnect
    }

    if (!closed && sseAbort === controller) {
      callbacks.onConnectionChange(false, 'reconnecting');
      reconnectTimer = window.setTimeout(() => void openSseStream(), 2000);
    }
  };

  const openSocket = async () => {
    if (closed) return;
    stopTimers();
    try {
      const token = await getIdTokenOrThrow(wsFailures > 0);
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/console?serverId=${encodeURIComponent(
        serverId
      )}&token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(url);
      ws = socket;
      let opened = false;

      // If WebSocket handshake stalls behind a proxy (e.g. .ai.studio), switch quickly to SSE stream
      connectTimeoutTimer = window.setTimeout(() => {
        if (!opened && !closed && ws === socket) {
          wsFailures += 1;
          try {
            socket.close();
          } catch {
            // ignore
          }
          void openSseStream();
        }
      }, 2500);

      socket.onopen = () => {
        if (ws !== socket || closed) return;
        opened = true;
        wsFailures = 0;
        if (connectTimeoutTimer !== null) {
          window.clearTimeout(connectTimeoutTimer);
          connectTimeoutTimer = null;
        }
        lastActivityAt = Date.now();
        callbacks.onConnectionChange(true, 'ws');
        heartbeatTimer = window.setInterval(() => {
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastActivityAt > 35000) {
            try {
              socket.close();
            } catch {
              // ignore
            }
            return;
          }
          try {
            socket.send('{"type":"ping"}');
          } catch {
            // ignore
          }
        }, 15000);
      };

      socket.onmessage = (event) => {
        dispatchMessage(String(event.data));
      };

      socket.onclose = () => {
        if (ws !== socket) return;
        stopTimers();
        if (closed) return;
        wsFailures += 1;
        callbacks.onConnectionChange(false, 'reconnecting');
        if (wsFailures >= 2) {
          void openSseStream();
        } else {
          reconnectTimer = window.setTimeout(() => void openSocket(), 1200);
        }
      };

      socket.onerror = () => {
        if (ws !== socket || closed) return;
        callbacks.onConnectionChange(false, 'reconnecting');
      };
    } catch {
      stopTimers();
      callbacks.onConnectionChange(false, 'reconnecting');
      if (!closed) {
        wsFailures += 1;
        reconnectTimer = window.setTimeout(
          () => void (wsFailures >= 2 ? openSseStream() : openSocket()),
          1500
        );
      }
    }
  };

  void openSocket();

  return () => {
    closed = true;
    stopTimers();
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    sseAbort?.abort();
    sseAbort = null;
    if (ws && ws.readyState < 2) {
      ws.close();
    }
    ws = null;
  };
}
