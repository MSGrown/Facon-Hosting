import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { verifyFirebaseIdToken, type VerifiedFirebaseUser } from './server/firebaseVerify.ts';
import { ensurePythonRuntime } from './server/pythonRuntime.ts';
import {
  getHostCapabilities,
  runnerManager,
  type StartRunnerRequest,
  type WorkspaceEnvInput,
  type WorkspaceFileInput,
} from './server/runnerManager.ts';

interface AuthenticatedRequest extends Request {
  authUser?: VerifiedFirebaseUser;
  rawIdToken?: string;
}

interface FirebaseConfig {
  projectId: string;
  firestoreDatabaseId: string;
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_BOOTSTRAPPED_EMAIL = 'sadhikmohammad292@gmail.com';
const MAX_SERVERS_PER_USER = 10;

const FREE_PLAN_SERVER_LIMITS = {
  ramLimitMb: 20480,
  cpuLimitPct: 500,
  diskLimitMb: 20480,
  bandwidthMbps: 500,
  backupLimit: 5,
} as const;

function loadFirebaseConfig(): FirebaseConfig {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<FirebaseConfig>;
  return {
    projectId: raw.projectId || '',
    firestoreDatabaseId: raw.firestoreDatabaseId || '(default)',
  };
}

const DEFAULT_PUBLIC_DOMAIN = 'https://faconmodshosting.ai.studio';

function getAllowedDomainHosts(): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', 'faconmodshosting.ai.studio']);
  const envUrl = process.env.PUBLIC_APP_URL || process.env.APP_URL || DEFAULT_PUBLIC_DOMAIN;
  if (envUrl) {
    try {
      hosts.add(new URL(envUrl).hostname.toLowerCase());
    } catch {
      // ignore invalid URL
    }
  }
  const custom = process.env.CUSTOM_DOMAIN || '';
  for (const part of custom.split(',')) {
    const clean = part.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (clean) hosts.add(clean);
  }
  return Array.from(hosts);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.run.app') ||
      host.endsWith('.ai.studio') ||
      host.endsWith('.web.app') ||
      host.endsWith('.firebaseapp.com')
    ) {
      return true;
    }
    return getAllowedDomainHosts().includes(host);
  } catch {
    return false;
  }
}

function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  return { stringValue: String(val ?? '') };
}

function toFirestoreFields(obj: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function readFirestoreInt(field: { integerValue?: string; doubleValue?: number } | undefined, fallback: number): number {
  if (!field) return fallback;
  if (field.integerValue !== undefined) {
    const n = Number(field.integerValue);
    return Number.isFinite(n) ? n : fallback;
  }
  if (field.doubleValue !== undefined && Number.isFinite(field.doubleValue)) {
    return field.doubleValue;
  }
  return fallback;
}

async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization Bearer token.' });
    return;
  }

  try {
    req.authUser = await verifyFirebaseIdToken(token);
    req.rawIdToken = token;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid Firebase session token.',
    });
  }
}

async function createAppAndServer(): Promise<void> {
  const app = express();
  // Essential for custom domains / Cloud Run / Firebase Hosting / Cloud Load Balancer reverse proxies
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));

  const INSTANCE_ID = crypto.randomUUID();
  const activeKeepaliveStreams = new Set<Response>();
  const verifiedIncomingOrigins = new Set<string>();
  const appUrlEnv = process.env.APP_URL || '';
  if (appUrlEnv && appUrlEnv !== 'MY_APP_URL') {
    try {
      verifiedIncomingOrigins.add(new URL(appUrlEnv).origin);
    } catch {
      // ignore invalid URL
    }
  }
  let observedCloudRunOrigin: string | null =
    Array.from(verifiedIncomingOrigins).find((u) => u.includes('.run.app')) || null;
  let lastExternalPingAt: string | null = null;
  let lastSelfPingAt: string | null = null;
  let lastSelfPingOk: boolean | null = null;

  app.use((req: Request, res: Response, next: NextFunction) => {
    const fwdHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const fwdProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    if (
      fwdHost &&
      !fwdHost.startsWith('localhost') &&
      !fwdHost.startsWith('127.0.0.1') &&
      !fwdHost.startsWith('0.0.0.0')
    ) {
      const originUrl = `${fwdProto === 'http' ? 'http' : 'https'}://${fwdHost}`;
      verifiedIncomingOrigins.add(originUrl);
      if (fwdHost.endsWith('.run.app') && !fwdHost.toLowerCase().startsWith('faconhosting.')) {
        observedCloudRunOrigin = originUrl;
      } else if (!observedCloudRunOrigin) {
        observedCloudRunOrigin = originUrl;
      }
    }

    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const getUptimeMode = () => {
    if (lastSelfPingOk === true) return 'dedicated-24x7' as const;
    if (lastSelfPingAt !== null && lastSelfPingOk === false) return 'ai-studio-auto-sleep' as const;
    return 'probing' as const;
  };

  const resolvePublicDomain = (req: Request): string => {
    const fwdHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (fwdHost && fwdHost.endsWith('.ai.studio')) {
      return `https://${fwdHost}`;
    }
    return DEFAULT_PUBLIC_DOMAIN;
  };

  const handlePing = (req: Request, res: Response) => {
    const source = String(req.query.source || 'external');
    if (source !== 'self') {
      lastExternalPingAt = new Date().toISOString();
    }
    const uptimeMode = getUptimeMode();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('x-facon-instance', INSTANCE_ID);
    res.json({
      ok: true,
      alive: true,
      instanceId: INSTANCE_ID,
      alwaysOnlineMode: true,
      uptimeMode,
      authProxyDetected: uptimeMode === 'ai-studio-auto-sleep',
      publicDomain: resolvePublicDomain(req),
      activeRunners: runnerManager.getActiveRunnerCount(),
      hasEnabledRunners: runnerManager.hasEnabledRunners(),
      observedCloudRunOrigin,
      lastExternalPingAt,
      lastSelfPingAt,
      lastSelfPingOk,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };

  app.get('/api/ping', handlePing);
  app.get('/ping', handlePing);
  app.get('/healthz', handlePing);

  app.get('/api/keepalive-stream', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('x-facon-instance', INSTANCE_ID);
    res.flushHeaders?.();

    activeKeepaliveStreams.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ instanceId: INSTANCE_ID, alwaysOnlineMode: true })}\n\n`);

    const streamTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        // ignore write after close
      }
    }, 15000);
    if (typeof streamTimer.unref === 'function') streamTimer.unref();

    const cleanup = () => {
      clearInterval(streamTimer);
      activeKeepaliveStreams.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.get('/api/health', (req: Request, res: Response) => {
    const uptimeMode = getUptimeMode();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-facon-instance', INSTANCE_ID);
    res.json({
      ok: true,
      instanceId: INSTANCE_ID,
      service: 'FACON HOST Runner Daemon',
      alwaysOnlineMode: true,
      uptimeMode,
      authProxyDetected: uptimeMode === 'ai-studio-auto-sleep',
      publicDomain: resolvePublicDomain(req),
      host: req.hostname,
      protocol: req.protocol,
      observedOrigin: observedCloudRunOrigin,
      verifiedOrigins: Array.from(verifiedIncomingOrigins),
      publicAppUrl: process.env.PUBLIC_APP_URL || process.env.APP_URL || DEFAULT_PUBLIC_DOMAIN,
      configuredCustomDomains: getAllowedDomainHosts(),
      activeRunners: runnerManager.getActiveRunnerCount(),
      hasEnabledRunners: runnerManager.hasEnabledRunners(),
      lastExternalPingAt,
      lastSelfPingAt,
      lastSelfPingOk,
      capabilities: getHostCapabilities(),
    });
  });

  // Authoritative backend-enforced 10-server limit + Firestore REST atomic provisioning
  app.post('/api/servers/provision', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const idToken = req.rawIdToken!;
      const fbCfg = loadFirebaseConfig();
      const baseDocPath = `projects/${fbCfg.projectId}/databases/${fbCfg.firestoreDatabaseId}/documents`;
      const firestoreBaseUrl = `https://firestore.googleapis.com/v1/${baseDocPath}`;

      const body = req.body as {
        serverId?: string;
        name?: string;
        runtime?: string;
        appType?: string;
        nodeRegion?: string;
        startupCommand?: string;
        autoRestart?: boolean;
        defaultEnvKey?: string;
        starterFiles?: {
          fileId?: string;
          name?: string;
          path?: string;
          mimeType?: string;
          content?: string;
          sizeBytes?: number;
        }[];
      };

      const serverId = String(body?.serverId || '').trim();
      const name = String(body?.name || '').trim().slice(0, 48);
      const runtime = String(body?.runtime || 'Python').trim();
      const appType = String(body?.appType || 'Discord Bot').trim();
      const nodeRegion = String(body?.nodeRegion || 'us-east-1').trim();
      const startupCommand = String(body?.startupCommand || '').trim().slice(0, 256);
      const autoRestart = Boolean(body?.autoRestart ?? true);
      const defaultEnvKey = String(body?.defaultEnvKey || 'BOT_TOKEN')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 64);

      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(serverId)) {
        res.status(400).json({ error: 'Invalid serverId format.' });
        return;
      }
      if (name.length < 2) {
        res.status(400).json({ error: 'Server name must be at least 2 characters.' });
        return;
      }
      if (startupCommand.length < 1) {
        res.status(400).json({ error: 'Startup command cannot be empty.' });
        return;
      }

      // 1. Check user account status & serverLimit on backend
      let userLimit = MAX_SERVERS_PER_USER;
      const userRes = await fetch(`${firestoreBaseUrl}/users/${encodeURIComponent(user.uid)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (userRes.ok) {
        const userDoc = (await userRes.json()) as {
          fields?: {
            suspended?: { booleanValue?: boolean };
            serverLimit?: { integerValue?: string; doubleValue?: number };
          };
        };
        if (userDoc.fields?.suspended?.booleanValue === true) {
          res.status(403).json({ error: 'Account suspended. Contact platform administrator.' });
          return;
        }
        const storedLimit = readFirestoreInt(userDoc.fields?.serverLimit, MAX_SERVERS_PER_USER);
        // Upgrade legacy 5-limit users cleanly up to 10; keep strict upper bound at 10
        userLimit = Math.min(MAX_SERVERS_PER_USER, Math.max(MAX_SERVERS_PER_USER, storedLimit));
      }

      // 2. Count existing servers owned by user directly in Firestore
      const queryRes = await fetch(`${firestoreBaseUrl}:runQuery`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'servers' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'ownerId' },
                op: 'EQUAL',
                value: { stringValue: user.uid },
              },
            },
            select: { fields: [{ fieldPath: 'id' }] },
          },
        }),
      });

      if (!queryRes.ok) {
        const errBody = await queryRes.text();
        res.status(502).json({ error: `Unable to verify server quota on backend (${queryRes.status}): ${errBody.slice(0, 180)}` });
        return;
      }

      const queryRows = (await queryRes.json()) as Array<{ document?: { name?: string } }>;
      const existingCount = queryRows.filter((row) => Boolean(row.document?.name)).length;

      if (existingCount >= MAX_SERVERS_PER_USER || existingCount >= userLimit) {
        res.status(403).json({
          error: `Server quota limit reached (${existingCount}/${MAX_SERVERS_PER_USER}). Delete an existing server before deploying another.`,
          existingCount,
          serverLimit: MAX_SERVERS_PER_USER,
        });
        return;
      }

      // 3. Atomically commit new server + starter subcollections with enforced 20GB / 500% / 20GB / 500Mbps / 5-backup specs
      const writes: Record<string, unknown>[] = [
        {
          update: {
            name: `${baseDocPath}/servers/${serverId}`,
            fields: toFirestoreFields({
              id: serverId,
              ownerId: user.uid,
              ownerEmail: (user.email || 'user@facon.host').slice(0, 160),
              name,
              runtime,
              appType,
              nodeRegion,
              status: 'starting',
              startupCommand,
              autoRestart,
              plan: 'FREE',
              ramLimitMb: FREE_PLAN_SERVER_LIMITS.ramLimitMb,
              cpuLimitPct: FREE_PLAN_SERVER_LIMITS.cpuLimitPct,
              diskLimitMb: FREE_PLAN_SERVER_LIMITS.diskLimitMb,
              bandwidthMbps: FREE_PLAN_SERVER_LIMITS.bandwidthMbps,
              backupLimit: FREE_PLAN_SERVER_LIMITS.backupLimit,
              cpuUsage: 0,
              ramUsageMb: 0,
              diskUsageMb: 1,
              networkMbps: 0,
              uptimeSeconds: 0,
            }),
          },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
          currentDocument: { exists: false },
        },
      ];

      const starterFiles = Array.isArray(body.starterFiles) ? body.starterFiles.slice(0, 20) : [];
      starterFiles.forEach((f, idx) => {
        const fid =
          f.fileId && /^[a-zA-Z0-9_-]{1,128}$/.test(f.fileId)
            ? f.fileId
            : `file${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const content = String(f.content || '').slice(0, 65536);
        const sizeBytes =
          typeof f.sizeBytes === 'number'
            ? Math.max(0, Math.min(104857600, Math.floor(f.sizeBytes)))
            : Buffer.byteLength(content, 'utf8');
        writes.push({
          update: {
            name: `${baseDocPath}/servers/${serverId}/files/${fid}`,
            fields: toFirestoreFields({
              name: String(f.name || 'file.txt').slice(0, 120),
              path: String(f.path || '/file.txt').slice(0, 256),
              sizeBytes,
              mimeType: String(f.mimeType || 'text/plain').slice(0, 80),
              content,
              isDirectory: false,
            }),
          },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        });
      });

      const envId = `env_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      writes.push({
        update: {
          name: `${baseDocPath}/servers/${serverId}/envVars/${envId}`,
          fields: toFirestoreFields({
            key: /^[A-Z_][A-Z0-9_]*$/.test(defaultEnvKey) ? defaultEnvKey : 'BOT_TOKEN',
            value: 'replace_with_your_token',
            isSecret: true,
          }),
        },
        updateTransforms: [
          { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      });

      const initialLogs = [
        {
          level: 'system',
          message: `Provisioned FREE cloud container on ${nodeRegion} (20 GB RAM · 500% CPU · 20 GB NVMe · 500 Mbps)`,
        },
        {
          level: 'info',
          message: `Mounted ${runtime} runtime image and workspace files`,
        },
        {
          level: 'cmd',
          message: `$ ${startupCommand}`,
        },
        {
          level: 'info',
          message: `[FACON HOST] ${name} (${appType}) online and ready.`,
        },
      ];
      initialLogs.forEach((entry, idx) => {
        const logId = `log${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        writes.push({
          update: {
            name: `${baseDocPath}/servers/${serverId}/logs/${logId}`,
            fields: toFirestoreFields({
              level: entry.level,
              message: entry.message.slice(0, 1000),
            }),
          },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
        });
      });

      const commitRes = await fetch(`${firestoreBaseUrl}:commit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ writes }),
      });

      if (!commitRes.ok) {
        const commitErr = await commitRes.text();
        res.status(400).json({ error: `Server provisioning rejected by Firestore: ${commitErr.slice(0, 240)}` });
        return;
      }

      res.json({
        ok: true,
        serverId,
        existingCount: existingCount + 1,
        serverLimit: MAX_SERVERS_PER_USER,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Backend server provisioning failed.',
      });
    }
  });

  app.get('/api/runner/fleet', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const fleet = runnerManager.getFleetForUser(user.uid, user.email);
      res.json({ fleet });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to inspect runner fleet.' });
    }
  });

  app.get('/api/runner/status/:serverId', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    try {
      const serverId = String(req.params.serverId || '');
      const user = req.authUser!;
      if (!runnerManager.canAccess(serverId, user.uid, user.email)) {
        res.status(403).json({ error: 'Forbidden: you do not own this server runner.' });
        return;
      }
      const snapshot = runnerManager.getSnapshot(serverId, user.uid);
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to read runner status.' });
    }
  });

  app.get('/api/runner/stream/:serverId', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    try {
      const serverId = String(req.params.serverId || '');
      const user = req.authUser!;
      if (!runnerManager.canAccess(serverId, user.uid, user.email)) {
        res.status(403).json({ error: 'Forbidden: you do not own this server runner.' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const writePayload = (rawJson: string) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${rawJson}\n\n`);
      };

      const detach = runnerManager.attachSseSubscriber(serverId, user.uid, writePayload);
      const pingTimer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          // ignore write after close
        }
      }, 15000);
      if (typeof pingTimer.unref === 'function') pingTimer.unref();

      const cleanup = () => {
        clearInterval(pingTimer);
        detach();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    } catch (err) {
      if (!res.headersSent) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to attach SSE console stream.' });
      }
    }
  });

  app.delete('/api/runner/:serverId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const serverId = String(req.params.serverId || '');
      const user = req.authUser!;
      await runnerManager.removeServer(serverId, user.uid, user.email);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to delete server runner.' });
    }
  });

  app.post('/api/runner/start', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const body = req.body as Partial<StartRunnerRequest> | undefined;
      const serverId = String(body?.serverId || '');
      if (!serverId) {
        res.status(400).json({ error: 'serverId is required.' });
        return;
      }

      const effectiveOwnerUid =
        body?.ownerUid && user.email === ADMIN_BOOTSTRAPPED_EMAIL
          ? String(body.ownerUid)
          : user.uid;

      if (body?.ownerUid && body.ownerUid !== user.uid && user.email !== ADMIN_BOOTSTRAPPED_EMAIL) {
        res.status(403).json({ error: 'Forbidden: owner mismatch.' });
        return;
      }

      const files: WorkspaceFileInput[] = Array.isArray(body?.files)
        ? body.files.map((f) => ({
            path: String(f.path || ''),
            content: String(f.content || ''),
            isDirectory: Boolean(f.isDirectory),
          }))
        : [];

      const envVars: WorkspaceEnvInput[] = Array.isArray(body?.envVars)
        ? body.envVars.map((v) => ({
            key: String(v.key || ''),
            value: String(v.value || ''),
          }))
        : [];

      const snapshot = await runnerManager.startServer(
        {
          serverId,
          ownerUid: effectiveOwnerUid,
          name: String(body?.name || serverId),
          runtime: String(body?.runtime || 'Node.js'),
          appType: String(body?.appType || 'Discord Bot'),
          startupCommand: String(body?.startupCommand || ''),
          autoRestart: Boolean(body?.autoRestart ?? true),
          files,
          envVars,
        },
        user.email
      );
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start backend runner.' });
    }
  });

  app.post('/api/runner/stop', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const serverId = String((req.body as { serverId?: string } | undefined)?.serverId || '');
      if (!serverId) {
        res.status(400).json({ error: 'serverId is required.' });
        return;
      }
      const snapshot = await runnerManager.stopServer(serverId, user.uid, user.email);
      res.json(snapshot);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to stop backend runner.' });
    }
  });

  app.post('/api/runner/stdin', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.authUser!;
      const body = req.body as { serverId?: string; input?: string } | undefined;
      const serverId = String(body?.serverId || '');
      const input = String(body?.input || '');
      if (!serverId) {
        res.status(400).json({ error: 'serverId is required.' });
        return;
      }
      runnerManager.sendStdin(serverId, input, user.uid, user.email);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to send stdin.' });
    }
  });

  app.post(
    '/api/runner/verify-discord',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const user = req.authUser!;
        const body = req.body as { serverId?: string; token?: string } | undefined;
        const serverId = String(body?.serverId || '');
        const token = String(body?.token || '');
        if (!serverId) {
          res.status(400).json({ error: 'serverId is required.' });
          return;
        }
        const gateway = await runnerManager.verifyServerDiscordToken(
          serverId,
          token,
          user.uid,
          user.email
        );
        res.json({ gateway });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Discord verification failed.' });
      }
    }
  );

  // Mount Vite middleware in development or static dist assets in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output missing. Run npm run build.');
      }
    });
  }

  const httpServer = http.createServer(app);
  // Prevent Cloud Run / GFE load balancer premature 502 idle socket closures
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;
  httpServer.requestTimeout = 300000;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws/console') {
      return;
    }

    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const serverId = reqUrl.searchParams.get('serverId') || '';
    const token = reqUrl.searchParams.get('token') || '';

    if (!serverId || !token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    void verifyFirebaseIdToken(token)
      .then((verified) => {
        if (!runnerManager.canAccess(serverId, verified.uid, verified.email)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          runnerManager.attachSubscriber(serverId, verified.uid, ws);
          ws.on('message', (raw) => {
            try {
              const parsed = JSON.parse(String(raw)) as { type?: string };
              if (parsed?.type === 'ping' && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
              }
            } catch {
              // ignore non-JSON messages
            }
          });
          const pingTimer = setInterval(() => {
            if (ws.readyState === 1) {
              try {
                ws.ping();
              } catch {
                // ignore ping error
              }
            }
          }, 20000);
          const stopPing = () => clearInterval(pingTimer);
          ws.once('close', stopPing);
          ws.once('error', stopPing);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  });

  // 24/7 Keepalive loop: hits verified Cloud Run ingress every 15s when bots are enabled (and every 30s baseline)
  let keepaliveTick = 0;
  const keepaliveTimer = setInterval(() => {
    keepaliveTick += 1;
    const hasEnabled = runnerManager.hasEnabledRunners();
    if (!hasEnabled && keepaliveTick % 2 !== 0) return;

    const targetOrigin =
      observedCloudRunOrigin ||
      Array.from(verifiedIncomingOrigins)[0] ||
      `http://127.0.0.1:${PORT}`;

    void fetch(`${targetOrigin}/api/ping?source=self`, {
      method: 'GET',
      headers: { 'User-Agent': 'FaconHost-Keepalive/1.0' },
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        lastSelfPingAt = new Date().toISOString();
        // Verify response genuinely reached this Express container (not an auth proxy HTML interstitial)
        lastSelfPingOk = r.ok && r.headers.get('x-facon-instance') === INSTANCE_ID;
      })
      .catch(() => {
        lastSelfPingAt = new Date().toISOString();
        lastSelfPingOk = false;
      });
  }, 15000);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

  const handleShutdown = () => {
    clearInterval(keepaliveTimer);
    for (const streamRes of activeKeepaliveStreams) {
      try {
        streamRes.end();
      } catch {
        // ignore close error
      }
    }
    activeKeepaliveStreams.clear();
    void runnerManager.shutdownForHostExit().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.once('SIGINT', handleShutdown);
  process.once('SIGTERM', handleShutdown);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[FACON HOST] Server & Runner Daemon listening on http://0.0.0.0:${PORT}`);
    void ensurePythonRuntime((msg) => console.log(`[FACON HOST] ${msg}`))
      .catch((err) => {
        console.warn('[FACON HOST] Python warmup deferred:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        void runnerManager.restorePersistedRunners();
      });
  });
}

process.on('uncaughtException', (err) => {
  console.error('[FACON HOST] Isolated uncaughtException in daemon:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FACON HOST] Isolated unhandledRejection in daemon:', reason);
});

void createAppAndServer();
