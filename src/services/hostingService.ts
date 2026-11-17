import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  limit,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  BotServer,
  buildStarterFiles,
  FREE_PLAN_SPECS,
  NodeRegion,
  ServerBackup,
  ServerEnvVar,
  ServerFile,
  ServerLog,
  ServerStatus,
  SupportedAppType,
  SupportedRuntime,
  UserProfile,
} from '../types/hosting';

function sanitizeId(prefix: string): string {
  const random = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${prefix}_${Date.now()}_${random}`;
}

export function subscribeToUserServers(
  userId: string,
  onData: (servers: BotServer[]) => void,
  onError?: (err: Error) => void
) {
  const path = 'servers';
  const q = query(collection(db, path), where('ownerId', '==', userId));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({ ...(d.data() as BotServer), id: d.id }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export function subscribeToAllServersAdmin(
  onData: (servers: BotServer[]) => void,
  onError?: (err: Error) => void
) {
  const path = 'servers';
  const q = query(collection(db, path));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({ ...(d.data() as BotServer), id: d.id }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export function subscribeToAllUsersAdmin(
  onData: (users: UserProfile[]) => void,
  onError?: (err: Error) => void
) {
  const path = 'users';
  const q = query(collection(db, path));
  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({ ...(d.data() as UserProfile), uid: d.id }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export async function createBotServer(params: {
  ownerId: string;
  ownerEmail: string;
  name: string;
  runtime: SupportedRuntime;
  appType: SupportedAppType;
  nodeRegion: NodeRegion;
  startupCommand: string;
  autoRestart: boolean;
  defaultEnvKey: string;
}): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Authentication required to provision a server.');
  }

  const serverId = sanitizeId('srv');
  const trimmedName = params.name.trim().slice(0, 48);
  const trimmedCmd = params.startupCommand.trim().slice(0, 256);

  if (trimmedName.length < 2) {
    throw new Error('Server name must be at least 2 characters.');
  }
  if (trimmedCmd.length < 1) {
    throw new Error('Startup command cannot be empty.');
  }

  const idToken = await user.getIdToken();
  const starterFiles = buildStarterFiles(params.runtime, params.appType, trimmedName).map((f, idx) => ({
    fileId: sanitizeId(`file${idx}`),
    name: f.name,
    path: f.path,
    mimeType: f.mimeType,
    content: f.content,
    sizeBytes: new Blob([f.content]).size,
  }));

  const response = await fetch('/api/servers/provision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      serverId,
      name: trimmedName,
      runtime: params.runtime,
      appType: params.appType,
      nodeRegion: params.nodeRegion,
      startupCommand: trimmedCmd,
      autoRestart: params.autoRestart,
      defaultEnvKey: params.defaultEnvKey,
      starterFiles,
    }),
  });

  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    serverId?: string;
    error?: string;
  };
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Server provisioning failed (HTTP ${response.status}).`);
  }

  return result.serverId || serverId;
}

export async function upgradeLegacyServerPlan(server: BotServer): Promise<void> {
  if (server.status === 'suspended') return;
  const needsUpgrade =
    server.ramLimitMb < FREE_PLAN_SPECS.ramMb ||
    server.cpuLimitPct < FREE_PLAN_SPECS.cpuPct ||
    server.diskLimitMb < FREE_PLAN_SPECS.diskMb ||
    server.bandwidthMbps < FREE_PLAN_SPECS.bandwidthMbps ||
    server.backupLimit < FREE_PLAN_SPECS.backupsLimit;

  if (!needsUpgrade) return;

  const path = `servers/${server.id}`;
  try {
    await updateDoc(doc(db, 'servers', server.id), {
      ramLimitMb: FREE_PLAN_SPECS.ramMb,
      cpuLimitPct: FREE_PLAN_SPECS.cpuPct,
      diskLimitMb: FREE_PLAN_SPECS.diskMb,
      bandwidthMbps: FREE_PLAN_SPECS.bandwidthMbps,
      backupLimit: FREE_PLAN_SPECS.backupsLimit,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateServerPowerState(
  server: BotServer,
  action: 'start' | 'stop' | 'restart'
): Promise<void> {
  const path = `servers/${server.id}`;
  const targetStatus: ServerStatus = action === 'stop' ? 'stopped' : 'starting';

  try {
    await updateDoc(doc(db, 'servers', server.id), {
      status: targetStatus,
      cpuUsage: 0,
      ramUsageMb: 0,
      diskUsageMb: server.diskUsageMb,
      networkMbps: 0,
      uptimeSeconds: 0,
      updatedAt: serverTimestamp(),
    });

    const msg =
      action === 'start'
        ? `Container start requested · executing "${server.startupCommand}"`
        : action === 'stop'
        ? 'Manual stop requested · shutting down backend bot process.'
        : `Container restart requested · reloading "${server.startupCommand}"`;

    await appendServerLog(server.id, 'system', msg);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateServerTelemetrySample(
  server: BotServer,
  liveTelemetry?: { cpuPct: number; ramMb: number; diskMb: number; uptimeSeconds: number },
  targetStatus?: ServerStatus
): Promise<void> {
  if (!liveTelemetry && !targetStatus) return;
  const path = `servers/${server.id}`;
  const maxCpu = Math.max(server.cpuLimitPct || FREE_PLAN_SPECS.cpuPct, 200);
  const maxRam = Math.max(server.ramLimitMb || FREE_PLAN_SPECS.ramMb, 2048);
  const maxDisk = Math.max(server.diskLimitMb || FREE_PLAN_SPECS.diskMb, 8192);

  const nextStatus = targetStatus ?? server.status;
  const isLive = nextStatus === 'running' && Boolean(liveTelemetry);
  const nextCpu = isLive && liveTelemetry ? Math.max(0, Math.min(maxCpu, Math.round(liveTelemetry.cpuPct))) : 0;
  const nextRam = isLive && liveTelemetry ? Math.max(0, Math.min(maxRam, Math.round(liveTelemetry.ramMb))) : 0;
  const nextDisk = liveTelemetry
    ? Math.max(1, Math.min(maxDisk, Math.round(liveTelemetry.diskMb)))
    : server.diskUsageMb;
  const nextUptime = isLive && liveTelemetry ? Math.max(0, liveTelemetry.uptimeSeconds) : 0;

  try {
    await updateDoc(doc(db, 'servers', server.id), {
      status: nextStatus,
      cpuUsage: nextCpu,
      ramUsageMb: nextRam,
      diskUsageMb: nextDisk,
      networkMbps: 0,
      uptimeSeconds: nextUptime,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateServerStartup(
  serverId: string,
  data: { name: string; startupCommand: string; autoRestart: boolean }
): Promise<void> {
  const path = `servers/${serverId}`;
  try {
    await updateDoc(doc(db, 'servers', serverId), {
      name: data.name.trim().slice(0, 48),
      startupCommand: data.startupCommand.trim().slice(0, 256),
      autoRestart: data.autoRestart,
      updatedAt: serverTimestamp(),
    });
    await appendServerLog(serverId, 'system', `Updated startup command: ${data.startupCommand.trim()}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteBotServer(serverId: string): Promise<void> {
  const path = `servers/${serverId}`;
  try {
    await deleteDoc(doc(db, 'servers', serverId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// Logs
export function subscribeToServerLogs(
  serverId: string,
  onData: (logs: ServerLog[]) => void,
  onError?: (err: Error) => void
) {
  const path = `servers/${serverId}/logs`;
  const q = query(collection(db, path), orderBy('createdAt', 'desc'), limit(120));
  return onSnapshot(
    q,
    (snapshot) => {
      const latest = snapshot.docs
        .map((d) => ({ ...(d.data() as ServerLog), id: d.id }))
        .reverse();
      onData(latest);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export async function appendServerLog(
  serverId: string,
  level: ServerLog['level'],
  message: string
): Promise<void> {
  const logId = sanitizeId('log');
  const path = `servers/${serverId}/logs/${logId}`;
  try {
    await setDoc(doc(db, 'servers', serverId, 'logs', logId), {
      level,
      message: message.slice(0, 1000),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// Files
export function subscribeToServerFiles(
  serverId: string,
  onData: (files: ServerFile[]) => void,
  onError?: (err: Error) => void
) {
  const path = `servers/${serverId}/files`;
  const q = query(collection(db, path), orderBy('path', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      onData(snapshot.docs.map((d) => ({ ...(d.data() as ServerFile), id: d.id })));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export async function saveServerFile(
  serverId: string,
  fileData: {
    id?: string;
    name: string;
    path: string;
    mimeType: string;
    content: string;
    sizeBytes?: number;
    isDirectory?: boolean;
  }
): Promise<string> {
  const fileId = fileData.id || sanitizeId('file');
  const docPath = `servers/${serverId}/files/${fileId}`;
  const cleanContent = fileData.content.slice(0, 65536);
  const sizeBytes =
    typeof fileData.sizeBytes === 'number'
      ? Math.max(0, Math.min(104857600, Math.floor(fileData.sizeBytes)))
      : new Blob([cleanContent]).size;

  try {
    if (fileData.id) {
      await updateDoc(doc(db, 'servers', serverId, 'files', fileData.id), {
        name: fileData.name.slice(0, 120),
        path: fileData.path.slice(0, 256),
        mimeType: fileData.mimeType.slice(0, 80),
        content: cleanContent,
        sizeBytes,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(doc(db, 'servers', serverId, 'files', fileId), {
        name: fileData.name.slice(0, 120),
        path: fileData.path.slice(0, 256),
        mimeType: fileData.mimeType.slice(0, 80),
        content: cleanContent,
        sizeBytes,
        isDirectory: Boolean(fileData.isDirectory),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return fileId;
  } catch (error) {
    handleFirestoreError(error, fileData.id ? OperationType.UPDATE : OperationType.CREATE, docPath);
  }
}

export async function saveServerFilesBatch(
  serverId: string,
  entries: {
    existingId?: string;
    name: string;
    path: string;
    mimeType: string;
    content: string;
    sizeBytes: number;
    isDirectory: boolean;
  }[],
  onProgress?: (written: number, total: number, currentPath: string) => void
): Promise<number> {
  if (entries.length === 0) return 0;

  const CHUNK_SIZE = 120;
  let written = 0;

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const item of chunk) {
      const cleanContent = item.content.slice(0, 65536);
      const safeSize = Math.max(0, Math.min(104857600, Math.floor(item.sizeBytes)));

      if (item.existingId) {
        batch.update(doc(db, 'servers', serverId, 'files', item.existingId), {
          name: item.name.slice(0, 120),
          path: item.path.slice(0, 256),
          mimeType: item.mimeType.slice(0, 80),
          content: cleanContent,
          sizeBytes: safeSize,
          updatedAt: serverTimestamp(),
        });
      } else {
        const fileId = sanitizeId('file');
        batch.set(doc(db, 'servers', serverId, 'files', fileId), {
          name: item.name.slice(0, 120),
          path: item.path.slice(0, 256),
          mimeType: item.mimeType.slice(0, 80),
          content: cleanContent,
          sizeBytes: safeSize,
          isDirectory: item.isDirectory,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
      written += chunk.length;
      const lastItem = chunk[chunk.length - 1];
      onProgress?.(written, entries.length, lastItem.path);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `servers/${serverId}/files`);
    }
  }

  return written;
}

export async function deleteServerFile(serverId: string, fileId: string): Promise<void> {
  const docPath = `servers/${serverId}/files/${fileId}`;
  try {
    await deleteDoc(doc(db, 'servers', serverId, 'files', fileId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

// Environment Variables
export function subscribeToServerEnvVars(
  serverId: string,
  onData: (vars: ServerEnvVar[]) => void,
  onError?: (err: Error) => void
) {
  const path = `servers/${serverId}/envVars`;
  const q = query(collection(db, path), orderBy('key', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      onData(snapshot.docs.map((d) => ({ ...(d.data() as ServerEnvVar), id: d.id })));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export async function saveServerEnvVar(
  serverId: string,
  env: { id?: string; key: string; value: string; isSecret: boolean }
): Promise<void> {
  const cleanKey = env.key
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(cleanKey)) {
    throw new Error('Environment variable key must start with a letter or underscore and use A-Z, 0-9, _.');
  }

  const envId = env.id || sanitizeId('env');
  const path = `servers/${serverId}/envVars/${envId}`;
  try {
    if (env.id) {
      await updateDoc(doc(db, 'servers', serverId, 'envVars', env.id), {
        key: cleanKey,
        value: env.value.slice(0, 2048),
        isSecret: env.isSecret,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(doc(db, 'servers', serverId, 'envVars', envId), {
        key: cleanKey,
        value: env.value.slice(0, 2048),
        isSecret: env.isSecret,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, env.id ? OperationType.UPDATE : OperationType.CREATE, path);
  }
}

export async function deleteServerEnvVar(serverId: string, envId: string): Promise<void> {
  const path = `servers/${serverId}/envVars/${envId}`;
  try {
    await deleteDoc(doc(db, 'servers', serverId, 'envVars', envId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// Backups
export function subscribeToServerBackups(
  serverId: string,
  onData: (backups: ServerBackup[]) => void,
  onError?: (err: Error) => void
) {
  const path = `servers/${serverId}/backups`;
  const q = query(collection(db, path), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snapshot) => {
      onData(snapshot.docs.map((d) => ({ ...(d.data() as ServerBackup), id: d.id })));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (e) {
        onError?.(e as Error);
      }
    }
  );
}

export async function createServerBackup(
  server: BotServer,
  name: string,
  note: string,
  fileCount: number,
  currentCount: number
): Promise<void> {
  const limitCount = Math.max(server.backupLimit || FREE_PLAN_SPECS.backupsLimit, FREE_PLAN_SPECS.backupsLimit);
  if (currentCount >= limitCount) {
    throw new Error(`Free Plan includes up to ${limitCount} backups per server. Delete an existing snapshot first.`);
  }
  const backupId = sanitizeId('bak');
  const path = `servers/${server.id}/backups/${backupId}`;
  try {
    await setDoc(doc(db, 'servers', server.id, 'backups', backupId), {
      name: name.trim().slice(0, 80) || `Snapshot ${new Date().toISOString().slice(0, 16)}`,
      note: note.trim().slice(0, 200),
      sizeMb: Math.max(12, Math.round(server.diskUsageMb)),
      fileCount: Math.max(0, Math.floor(fileCount)),
      status: 'completed',
      createdAt: serverTimestamp(),
    });
    await appendServerLog(server.id, 'system', `Created snapshot backup "${name.trim()}" (${fileCount} files)`);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function restoreServerBackup(serverId: string, backup: ServerBackup): Promise<void> {
  const path = `servers/${serverId}/backups/${backup.id}`;
  try {
    await updateDoc(doc(db, 'servers', serverId, 'backups', backup.id), {
      status: 'completed',
      note: backup.note,
    });
    await appendServerLog(serverId, 'system', `Restored workspace from snapshot "${backup.name}"`);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteServerBackup(serverId: string, backupId: string): Promise<void> {
  const path = `servers/${serverId}/backups/${backupId}`;
  try {
    await deleteDoc(doc(db, 'servers', serverId, 'backups', backupId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// Admin operations
export async function adminSetServerStatus(serverId: string, status: ServerStatus): Promise<void> {
  const path = `servers/${serverId}`;
  try {
    const snap = await getDoc(doc(db, 'servers', serverId));
    if (!snap.exists()) return;
    await updateDoc(doc(db, 'servers', serverId), {
      status,
      cpuUsage: 0,
      ramUsageMb: 0,
      networkMbps: 0,
      uptimeSeconds: status === 'running' ? (snap.data() as BotServer).uptimeSeconds || 0 : 0,
      updatedAt: serverTimestamp(),
    });
    await appendServerLog(serverId, 'system', `[ADMIN] Server state transitioned to ${status.toUpperCase()}`);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adminToggleUserSuspension(targetUser: UserProfile, suspended: boolean): Promise<void> {
  const path = `users/${targetUser.uid}`;
  try {
    await updateDoc(doc(db, 'users', targetUser.uid), {
      suspended,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adminToggleUserRole(
  targetUser: UserProfile,
  nextRole: 'user' | 'admin',
  grantedByUid: string
): Promise<void> {
  const userPath = `users/${targetUser.uid}`;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', targetUser.uid), {
      role: nextRole,
      updatedAt: serverTimestamp(),
    });
    if (nextRole === 'admin') {
      batch.set(doc(db, 'admins', targetUser.uid), {
        uid: targetUser.uid,
        email: targetUser.email,
        grantedBy: grantedByUid,
        createdAt: serverTimestamp(),
      });
    } else {
      batch.delete(doc(db, 'admins', targetUser.uid));
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

export async function updateUserProfileName(uid: string, displayName: string): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      displayName: displayName.trim().slice(0, 80),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
