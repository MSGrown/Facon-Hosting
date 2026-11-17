import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { auditDiscordBotWorkspace, ensureDiscordShieldArtifacts } from './discordShield.ts';
import {
  ensurePythonRuntime,
  ensureWorkspacePythonDeps,
  findBinaryOnPath,
  getInstalledPythonInfo,
} from './pythonRuntime.ts';

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

export interface WorkspaceFileInput {
  path: string;
  content: string;
  isDirectory?: boolean;
}

export interface WorkspaceEnvInput {
  key: string;
  value: string;
}

export interface StartRunnerRequest {
  serverId: string;
  ownerUid: string;
  name: string;
  runtime: string;
  appType: string;
  startupCommand: string;
  autoRestart: boolean;
  files: WorkspaceFileInput[];
  envVars: WorkspaceEnvInput[];
}

interface PersistedRunnerRecord {
  enabled: boolean;
  payload: StartRunnerRequest;
  cumulativeUptimeSeconds: number;
  restartCount: number;
  crashCount: number;
  oomCount: number;
  lastOfflineReason: string | null;
  lastOfflineAt: string | null;
  updatedAt: string;
}

interface ManagedRunner {
  serverId: string;
  ownerUid: string;
  name: string;
  runtime: string;
  appType: string;
  startupCommand: string;
  autoRestart: boolean;
  enabled: boolean;
  state: RunnerProcessState;
  child: ChildProcess | null;
  pid: number | null;
  exitCode: number | null;
  startedAtMs: number | null;
  lastOfflineAt: string | null;
  cumulativeUptimeSeconds: number;
  manualStopRequested: boolean;
  startInProgress: boolean;
  consecutiveCrashes: number;
  oomDetectedInRun: boolean;
  restartTimer: NodeJS.Timeout | null;
  telemetryTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  telemetryBusy: boolean;
  lastCpuSample: { procTicks: number; wallMs: number } | null;
  telemetry: RunnerTelemetry;
  gateway: DiscordGatewayStatus;
  health: RunnerHealthStatus;
  logs: RunnerLogEntry[];
  subscribers: Set<WebSocket>;
  sseSubscribers: Set<(rawJson: string) => void>;
  stdoutRemainder: string;
  stderrRemainder: string;
  lastStartPayload: StartRunnerRequest | null;
  lastDiagnosticAtMs?: Record<string, number>;
  lastGatewayAliveMs?: number | null;
  startingSinceMs?: number | null;
}

interface ResolvedCommandStep {
  executable: string;
  args: string[];
  display: string;
  isPython: boolean;
  isNode: boolean;
  isJava: boolean;
}

const ADMIN_BOOTSTRAPPED_EMAIL = 'sadhikmohammad292@gmail.com';
const MAX_SERVERS_PER_USER = 10;
const MAX_CPU_PCT = 500;
const ZIP_B64_PREFIX = '__FACON_ZIP_B64__:';
const MAX_LOG_BUFFER = 300;
const WORKSPACES_ROOT = path.resolve(process.cwd(), '.facon_workspaces');
const REGISTRY_PATH = path.join(WORKSPACES_ROOT, '_registry.json');
const RECOVERY_BACKOFF_MS = [1500, 3000, 8000, 15000, 30000, 60000, 120000];
const CONFIG_ERROR_BACKOFF_MS = [60000, 180000, 300000];

function ensureWorkspacesRoot(): void {
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
}

function getHostTotalRamMb(): number {
  return Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
}

function getSafeProcessSoftRamLimitMb(): number {
  // Isolate each bot to at most 40% of physical host RAM (capped between 384 MB and 4096 MB)
  // so one runaway bot cannot OOM-kill the supervisor daemon or sibling bots.
  const hostMb = getHostTotalRamMb();
  return Math.max(384, Math.min(4096, Math.floor(hostMb * 0.4)));
}

export function getHostCapabilities(): HostCapabilities {
  const projectRoot = process.cwd();
  const tsxBin = path.resolve(projectRoot, 'node_modules', '.bin', 'tsx');
  const discordPkg = path.resolve(projectRoot, 'node_modules', 'discord.js', 'package.json');
  const pyInfo = getInstalledPythonInfo();
  const pythonVersion =
    pyInfo && pyInfo.hasPip
      ? `${pyInfo.version} + pip`
      : pyInfo
      ? `${pyInfo.version} (auto-pip 3.12)`
      : 'Python 3.12 (auto-provision)';

  const javaAvailable = Boolean(findBinaryOnPath('java'));
  const javacAvailable = Boolean(findBinaryOnPath('javac'));
  const availableRuntimes = ['Node.js', 'JavaScript'];
  const tsxAvailable = fs.existsSync(tsxBin);
  if (tsxAvailable) availableRuntimes.push('TypeScript');
  availableRuntimes.push('Python');
  if (javaAvailable && javacAvailable) availableRuntimes.push('Java');
  else if (javaAvailable) availableRuntimes.push('Java (JRE)');
  if (findBinaryOnPath('go')) availableRuntimes.push('Go');
  if (findBinaryOnPath('cargo')) availableRuntimes.push('Rust');
  if (findBinaryOnPath('g++')) availableRuntimes.push('C++');
  if (findBinaryOnPath('gcc')) availableRuntimes.push('C');

  return {
    nodeVersion: process.version,
    pythonVersion,
    javaAvailable,
    tsxAvailable,
    discordJsInstalled: fs.existsSync(discordPkg),
    availableRuntimes,
    maxServersPerUser: MAX_SERVERS_PER_USER,
    hostTotalRamMb: getHostTotalRamMb(),
  };
}

function makeInitialGateway(appType: string): DiscordGatewayStatus {
  return {
    appType,
    tokenPresent: false,
    tokenStatus: 'missing',
    connectionState: 'offline',
    presenceStatus: 'offline',
    activityType: null,
    activityName: null,
    guildCount: null,
    botTag: null,
    botId: null,
    gatewayUrl: null,
    shards: null,
    sessionRemaining: null,
    sessionTotal: null,
    latencyMs: null,
    lastEvent:
      appType === 'Discord Bot'
        ? 'Waiting for container start & Discord bot login.'
        : `Gateway status applies to Discord Bot workloads (current: ${appType}).`,
    updatedAt: new Date().toISOString(),
  };
}

function resolveDiscordTokenFromWorkspace(
  envVars: WorkspaceEnvInput[],
  files: WorkspaceFileInput[]
): string | null {
  const candidateKeys = ['DISCORD_TOKEN', 'BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'TOKEN'];
  for (const key of candidateKeys) {
    const found = envVars.find((v) => v.key === key && String(v.value || '').trim());
    if (found) return String(found.value).trim();
  }
  const dotEnv = files.find((f) => !f.isDirectory && f.path.replace(/^\/+/, '') === '.env');
  if (dotEnv?.content) {
    for (const line of dotEnv.content.split(/\r?\n/)) {
      const m = line.match(/^\s*(DISCORD_TOKEN|BOT_TOKEN|DISCORD_BOT_TOKEN|TOKEN)\s*=\s*(.+?)\s*$/);
      if (m) {
        const val = m[2].replace(/^['"]|['"]$/g, '').trim();
        if (val) return val;
      }
    }
  }
  return null;
}

function makeInitialHealth(): RunnerHealthStatus {
  return {
    status: 'stopped',
    errorCount: 0,
    restartCount: 0,
    crashCount: 0,
    oomCount: 0,
    lastError: null,
    offlineReason: null,
    diagnosticHint: null,
    fatalError: false,
    rateLimitedUntil: null,
    nextRecoveryAt: null,
    lastCheckAt: new Date().toISOString(),
  };
}

function sanitizeServerId(serverId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(serverId)) {
    throw new Error('Invalid server identifier.');
  }
  return serverId;
}

function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escapeNext = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function optimizeNodeArgs(rest: string[]): string[] {
  const flags: string[] = [];
  if (!rest.includes('--enable-source-maps')) {
    flags.push('--enable-source-maps');
  }
  if (!rest.some((a) => a.startsWith('--max-old-space-size'))) {
    flags.push(`--max-old-space-size=${getSafeProcessSoftRamLimitMb()}`);
  }
  return [...flags, ...rest];
}

function optimizeJavaArgs(rest: string[]): string[] {
  const hasHeapFlag = rest.some((arg) => arg.startsWith('-Xmx'));
  const hasGcFlag = rest.some((arg) => arg.startsWith('-XX:+Use'));
  const extra: string[] = [];
  if (!hasHeapFlag) {
    extra.push(`-Xmx${getSafeProcessSoftRamLimitMb()}m`);
  }
  if (!hasGcFlag) extra.push('-XX:+UseG1GC');
  return [...extra, ...rest];
}

async function resolveCommandStep(
  segment: string,
  workspaceDir: string,
  onLog?: (msg: string) => void
): Promise<ResolvedCommandStep> {
  const tokens = tokenizeCommand(segment);
  if (tokens.length === 0) {
    throw new Error('Startup command cannot be empty.');
  }

  const bin = tokens[0];
  const rest = tokens.slice(1);
  const projectRoot = process.cwd();
  const tsxBin = path.resolve(projectRoot, 'node_modules', '.bin', 'tsx');

  if (bin === 'node') {
    const optimized = optimizeNodeArgs(rest);
    return {
      executable: process.execPath,
      args: optimized,
      display: `node ${optimized.join(' ')}`,
      isPython: false,
      isNode: true,
      isJava: false,
    };
  }

  if (bin === 'tsx') {
    if (!fs.existsSync(tsxBin)) {
      throw new Error('tsx binary is not installed on this host.');
    }
    return {
      executable: tsxBin,
      args: rest,
      display: `tsx ${rest.join(' ')}`,
      isPython: false,
      isNode: true,
      isJava: false,
    };
  }

  if (bin === 'npx') {
    if (rest[0] === 'tsx') {
      if (!fs.existsSync(tsxBin)) {
        throw new Error('tsx binary is not installed on this host.');
      }
      return {
        executable: tsxBin,
        args: rest.slice(1),
        display: `tsx ${rest.slice(1).join(' ')}`,
        isPython: false,
        isNode: true,
        isJava: false,
      };
    }
    throw new Error(`Unsupported npx package "${rest[0] || ''}". Use node, tsx, python3, or java.`);
  }

  if (bin === 'python3' || bin === 'python') {
    const pyBin = await ensurePythonRuntime(onLog);
    const hasUnbuffered = rest.includes('-u');
    const finalArgs = hasUnbuffered ? rest : ['-u', ...rest];
    return {
      executable: pyBin,
      args: finalArgs,
      display: `python3 ${finalArgs.join(' ')}`,
      isPython: true,
      isNode: false,
      isJava: false,
    };
  }

  if (bin === 'java') {
    const javaBin = findBinaryOnPath('java');
    if (!javaBin) {
      throw new Error('Java runtime (java) is not installed on this cloud host.');
    }
    const optimized = optimizeJavaArgs(rest);
    return {
      executable: javaBin,
      args: optimized,
      display: `java ${optimized.join(' ')}`,
      isPython: false,
      isNode: false,
      isJava: true,
    };
  }

  if (bin === 'javac') {
    const javacBin = findBinaryOnPath('javac');
    if (!javacBin) {
      throw new Error('Java compiler (javac) is not installed on this cloud host.');
    }
    return {
      executable: javacBin,
      args: rest,
      display: `javac ${rest.join(' ')}`,
      isPython: false,
      isNode: false,
      isJava: true,
    };
  }

  if (bin === 'npm') {
    const npmBin = findBinaryOnPath('npm');
    if (!npmBin) {
      throw new Error('npm is not installed on this host.');
    }
    const sub = rest[0] || '';
    if (sub !== 'start' && sub !== 'run') {
      throw new Error('Only "npm start" or "npm run <script>" is permitted for workspace execution.');
    }
    return {
      executable: npmBin,
      args: rest,
      display: `npm ${rest.join(' ')}`,
      isPython: false,
      isNode: true,
      isJava: false,
    };
  }

  if (bin === 'go' || bin === 'cargo' || bin === 'g++' || bin === 'gcc') {
    const found = findBinaryOnPath(bin);
    if (!found) {
      const caps = getHostCapabilities();
      throw new Error(
        `Runtime binary "${bin}" is not installed on this cloud node. Installed runtimes: ${caps.availableRuntimes.join(
          ', '
        )}.`
      );
    }
    return {
      executable: found,
      args: rest,
      display: `${bin} ${rest.join(' ')}`,
      isPython: false,
      isNode: false,
      isJava: false,
    };
  }

  if (bin.startsWith('./')) {
    const candidate = path.resolve(workspaceDir, bin.slice(2));
    if (!candidate.startsWith(workspaceDir + path.sep)) {
      throw new Error('Executable path escapes workspace directory.');
    }
    return {
      executable: candidate,
      args: rest,
      display: `${bin} ${rest.join(' ')}`.trim(),
      isPython: false,
      isNode: false,
      isJava: false,
    };
  }

  const caps = getHostCapabilities();
  throw new Error(
    `Runtime binary "${bin}" is not installed on this cloud node. Installed runtimes: ${caps.availableRuntimes.join(
      ', '
    )}.`
  );
}

async function resolveExecutablePipeline(
  rawCommand: string,
  workspaceDir: string,
  onLog?: (msg: string) => void
): Promise<{ preSteps: ResolvedCommandStep[]; mainStep: ResolvedCommandStep }> {
  const segments = rawCommand
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Startup command cannot be empty.');
  }
  if (segments.length > 3) {
    throw new Error('Startup command pipeline supports up to 3 chained steps.');
  }

  const steps: ResolvedCommandStep[] = [];
  for (const seg of segments) {
    steps.push(await resolveCommandStep(seg, workspaceDir, onLog));
  }

  return {
    preSteps: steps.slice(0, -1),
    mainStep: steps[steps.length - 1],
  };
}

function getWorkspaceDir(serverId: string): string {
  const safeId = sanitizeServerId(serverId);
  const dir = path.resolve(WORKSPACES_ROOT, safeId);
  if (!dir.startsWith(WORKSPACES_ROOT + path.sep)) {
    throw new Error('Invalid workspace directory path.');
  }
  return dir;
}

function materializeWorkspace(
  serverId: string,
  files: WorkspaceFileInput[],
  envVars: WorkspaceEnvInput[]
): string {
  ensureWorkspacesRoot();
  const workspaceDir = getWorkspaceDir(serverId);

  if (fs.existsSync(workspaceDir)) {
    for (const entry of fs.readdirSync(workspaceDir)) {
      if (entry === 'node_modules' || entry === '.pydeps' || entry === '__pycache__') continue;
      fs.rmSync(path.join(workspaceDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  const hostNodeModules = path.resolve(process.cwd(), 'node_modules');
  const wsNodeModules = path.join(workspaceDir, 'node_modules');
  if (fs.existsSync(hostNodeModules) && !fs.existsSync(wsNodeModules)) {
    try {
      fs.symlinkSync(hostNodeModules, wsNodeModules, 'dir');
    } catch {
      // Ignore symlink error if filesystem forbids it
    }
  }

  for (const file of files) {
    const rel = String(file.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) continue;
    const resolved = path.resolve(workspaceDir, rel);
    if (!resolved.startsWith(workspaceDir + path.sep)) {
      continue;
    }

    if (file.isDirectory) {
      fs.mkdirSync(resolved, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const rawContent = typeof file.content === 'string' ? file.content : '';
    if (rawContent.startsWith(ZIP_B64_PREFIX)) {
      const b64 = rawContent.slice(ZIP_B64_PREFIX.length);
      fs.writeFileSync(resolved, Buffer.from(b64, 'base64'));
    } else {
      fs.writeFileSync(resolved, rawContent, 'utf8');
    }
  }

  const envLines = envVars
    .filter((v) => /^[A-Z_][A-Z0-9_]*$/.test(v.key))
    .map((v) => {
      const escaped = String(v.value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      return `${v.key}="${escaped}"`;
    });
  fs.writeFileSync(path.join(workspaceDir, '.env'), `${envLines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  return workspaceDir;
}

async function measureDirectoryBytesAsync(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(curr, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.isSymbolicLink()) continue;
      const full = path.join(curr, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(full);
          total += st.size;
        } catch {
          // ignore race
        }
      }
    }
  }
  return total;
}

async function readLinuxProcessStatsAsync(
  pid: number,
  prevSample: { procTicks: number; wallMs: number } | null
): Promise<{ ramMb: number; cpuPct: number; sample: { procTicks: number; wallMs: number } | null }> {
  let ramMb = 0;
  let cpuPct = 0;
  let nextSample: { procTicks: number; wallMs: number } | null = prevSample;

  try {
    const rawStatm = await fsp.readFile(`/proc/${pid}/statm`, 'utf8');
    const statm = rawStatm.trim().split(/\s+/);
    const residentPages = Number(statm[1] || 0);
    if (Number.isFinite(residentPages) && residentPages > 0) {
      ramMb = Math.max(1, Math.round((residentPages * 4096) / (1024 * 1024)));
    }
  } catch {
    // /proc may be unavailable temporarily on exit
  }

  try {
    const rawStat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = rawStat.lastIndexOf(')');
    if (closeParen !== -1) {
      const fields = rawStat.slice(closeParen + 2).trim().split(/\s+/);
      const utime = Number(fields[11] || 0);
      const stime = Number(fields[12] || 0);
      const totalTicks = utime + stime;
      const nowMs = Date.now();
      if (prevSample && nowMs > prevSample.wallMs) {
        const deltaTicks = Math.max(0, totalTicks - prevSample.procTicks);
        const deltaMs = nowMs - prevSample.wallMs;
        const cpuMs = deltaTicks * 10;
        cpuPct = Math.max(0, Math.min(MAX_CPU_PCT, Math.round((cpuMs / deltaMs) * 100)));
      }
      nextSample = { procTicks: totalTicks, wallMs: nowMs };
    }
  } catch {
    // ignore
  }

  return { ramMb, cpuPct, sample: nextSample };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killChildProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fallback to direct child signal if not group leader
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited
  }
}

async function fetchDiscordWithRateLimitRetry(
  url: string,
  token: string,
  maxRetries = 2
): Promise<globalThis.Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 429 && attempt < maxRetries) {
      attempt += 1;
      const retryHeader = res.headers.get('retry-after');
      let waitMs = retryHeader ? Number(retryHeader) * 1000 : 1200;
      if (!Number.isFinite(waitMs) || waitMs <= 0) {
        try {
          const body = (await res.json()) as { retry_after?: number };
          if (typeof body.retry_after === 'number') {
            waitMs = Math.ceil(body.retry_after * 1000);
          }
        } catch {
          waitMs = 1200;
        }
      }
      const boundedWait = Math.min(4500, Math.max(300, waitMs + 100));
      await new Promise((r) => setTimeout(r, boundedWait));
      continue;
    }

    return res;
  }
}

export async function probeDiscordTokenWithApi(rawToken: string): Promise<{
  ok: boolean;
  tokenStatus: DiscordGatewayStatus['tokenStatus'];
  botTag: string | null;
  botId: string | null;
  gatewayUrl: string | null;
  shards: number | null;
  sessionRemaining: number | null;
  sessionTotal: number | null;
  latencyMs: number | null;
  rateLimitedMs: number | null;
  message: string;
}> {
  const token = rawToken.trim();
  if (!token) {
    return {
      ok: false,
      tokenStatus: 'missing',
      botTag: null,
      botId: null,
      gatewayUrl: null,
      shards: null,
      sessionRemaining: null,
      sessionTotal: null,
      latencyMs: null,
      rateLimitedMs: null,
      message: 'DISCORD_TOKEN is empty.',
    };
  }
  if (token === 'replace_with_your_token') {
    return {
      ok: false,
      tokenStatus: 'placeholder',
      botTag: null,
      botId: null,
      gatewayUrl: null,
      shards: null,
      sessionRemaining: null,
      sessionTotal: null,
      latencyMs: null,
      rateLimitedMs: null,
      message:
        'DISCORD_TOKEN is still set to the default placeholder. Paste your real token from the Discord Developer Portal in Startup → Environment Variables.',
    };
  }

  const started = Date.now();
  try {
    const meRes = await fetchDiscordWithRateLimitRetry('https://discord.com/api/v10/users/@me', token);
    const latencyMs = Math.max(1, Date.now() - started);

    if (meRes.status === 401) {
      return {
        ok: false,
        tokenStatus: 'invalid',
        botTag: null,
        botId: null,
        gatewayUrl: null,
        shards: null,
        sessionRemaining: null,
        sessionTotal: null,
        latencyMs,
        rateLimitedMs: null,
        message:
          'Discord API rejected DISCORD_TOKEN (401 Unauthorized). Reset your bot token in the Discord Developer Portal.',
      };
    }

    if (meRes.status === 429) {
      const retrySec = Number(meRes.headers.get('retry-after') || 5);
      return {
        ok: false,
        tokenStatus: 'error',
        botTag: null,
        botId: null,
        gatewayUrl: null,
        shards: null,
        sessionRemaining: null,
        sessionTotal: null,
        latencyMs,
        rateLimitedMs: Math.max(1000, Math.round(retrySec * 1000)),
        message: `Discord API rate limited (429). Retry after ~${Math.ceil(retrySec)}s.`,
      };
    }

    if (!meRes.ok) {
      return {
        ok: false,
        tokenStatus: 'error',
        botTag: null,
        botId: null,
        gatewayUrl: null,
        shards: null,
        sessionRemaining: null,
        sessionTotal: null,
        latencyMs,
        rateLimitedMs: null,
        message: `Discord API returned HTTP ${meRes.status} while verifying bot identity.`,
      };
    }

    const meData = (await meRes.json()) as {
      id: string;
      username: string;
      discriminator?: string;
    };
    const botTag =
      meData.discriminator && meData.discriminator !== '0'
        ? `${meData.username}#${meData.discriminator}`
        : `@${meData.username}`;

    let gatewayUrl: string | null = 'wss://gateway.discord.gg';
    let shards: number | null = 1;
    let sessionRemaining: number | null = null;
    let sessionTotal: number | null = null;

    const gwRes = await fetchDiscordWithRateLimitRetry('https://discord.com/api/v10/gateway/bot', token);
    if (gwRes.ok) {
      const gwData = (await gwRes.json()) as {
        url?: string;
        shards?: number;
        session_start_limit?: { total?: number; remaining?: number };
      };
      gatewayUrl = gwData.url || gatewayUrl;
      shards = typeof gwData.shards === 'number' ? gwData.shards : shards;
      sessionRemaining = gwData.session_start_limit?.remaining ?? null;
      sessionTotal = gwData.session_start_limit?.total ?? null;
    }

    return {
      ok: true,
      tokenStatus: 'valid',
      botTag,
      botId: meData.id,
      gatewayUrl,
      shards,
      sessionRemaining,
      sessionTotal,
      latencyMs,
      rateLimitedMs: null,
      message: `Verified Discord Bot "${botTag}" (ID ${meData.id}) · Gateway ${gatewayUrl} (${shards ?? 1} shard · ${latencyMs}ms).`,
    };
  } catch (err) {
    return {
      ok: false,
      tokenStatus: 'error',
      botTag: null,
      botId: null,
      gatewayUrl: null,
      shards: null,
      sessionRemaining: null,
      sessionTotal: null,
      latencyMs: null,
      rateLimitedMs: null,
      message: err instanceof Error ? err.message : 'Network error reaching discord.com API.',
    };
  }
}

class RunnerManager {
  private runners = new Map<string, ManagedRunner>();
  private registryWriteTimer: NodeJS.Timeout | null = null;
  private supervisorTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startGlobalSupervisor();
  }

  public hasEnabledRunners(): boolean {
    for (const r of this.runners.values()) {
      if (r.enabled && !r.manualStopRequested) return true;
    }
    return false;
  }

  public getActiveRunnerCount(): number {
    let count = 0;
    for (const r of this.runners.values()) {
      if (r.state === 'running' || r.state === 'starting') count += 1;
    }
    return count;
  }

  private startGlobalSupervisor(): void {
    if (this.supervisorTimer) return;
    // Independent 24/7 process supervisor: runs regardless of browser tabs, dashboard refreshes, or logouts.
    this.supervisorTimer = setInterval(() => {
      const now = Date.now();
      for (const runner of this.runners.values()) {
        if (!runner.enabled || runner.manualStopRequested) {
          continue;
        }

        // Case D: hung startup exceeding 120s
        if (runner.startInProgress && runner.startingSinceMs && now - runner.startingSinceMs > 120000) {
          runner.startInProgress = false;
          runner.state = 'crashed';
          runner.startingSinceMs = null;
          this.pushLog(runner, 'stderr', '[SUPERVISOR] Startup exceeded 120s timeout — scheduling automatic retry.');
          this.scheduleRecovery(runner, 'Startup timed out after 120s.', false);
          continue;
        }

        if (runner.startInProgress) {
          continue;
        }

        // Case A: runner believes it is running, verify OS PID and live Discord Gateway heartbeat
        if (runner.state === 'running') {
          if (!runner.pid || !isPidAlive(runner.pid)) {
            this.clearChildTimers(runner);
            this.detachChildListeners(runner.child);
            const crashedAfterSec = runner.startedAtMs
              ? Math.max(0, Math.floor((now - runner.startedAtMs) / 1000))
              : 0;
            runner.cumulativeUptimeSeconds += crashedAfterSec;
            runner.child = null;
            runner.pid = null;
            runner.startedAtMs = null;
            runner.lastGatewayAliveMs = null;
            runner.state = 'crashed';
            runner.lastOfflineAt = new Date().toISOString();
            runner.gateway = {
              ...runner.gateway,
              connectionState: runner.gateway.connectionState === 'error' ? 'error' : 'offline',
              presenceStatus: 'offline',
              activityType: null,
              activityName: null,
              latencyMs: null,
              updatedAt: new Date().toISOString(),
            };
            this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
            const reason = 'Process terminated unexpectedly (supervisor detected missing PID).';
            this.pushLog(runner, 'stderr', `[SUPERVISOR] ${reason}`);
            this.scheduleRecovery(runner, reason, false);
            continue;
          }

          // Watch for frozen Discord Gateway WebSocket (>120s without online heartbeat after initial login)
          if (
            runner.appType === 'Discord Bot' &&
            runner.startedAtMs &&
            now - runner.startedAtMs > 120000 &&
            runner.lastGatewayAliveMs &&
            now - runner.lastGatewayAliveMs > 120000 &&
            runner.child
          ) {
            this.pushLog(
              runner,
              'stderr',
              '[SUPERVISOR] Discord Gateway connection unresponsive for >120s — recycling process to bring bot back Online.'
            );
            runner.lastGatewayAliveMs = null;
            try {
              killChildProcessTree(runner.child, 'SIGTERM');
            } catch {
              // exit handler will schedule fast recovery
            }
          }
          continue;
        }

        // Case B & C: runner is enabled but stopped/crashed without pending recovery timer
        if ((runner.state === 'crashed' || runner.state === 'stopped') && !runner.restartTimer && runner.lastStartPayload) {
          this.scheduleRecovery(
            runner,
            runner.health.offlineReason || 'Bot process is offline while Always-Online hosting is enabled.',
            false
          );
        }
      }
    }, 8000);
    // Keep event loop alive intentionally while supervisor runs, or let httpServer hold it
  }

  private loadRegistry(): Record<string, PersistedRunnerRecord> {
    try {
      if (!fs.existsSync(REGISTRY_PATH)) return {};
      const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
      return JSON.parse(raw) as Record<string, PersistedRunnerRecord>;
    } catch {
      return {};
    }
  }

  private writeRegistryNow(): void {
    try {
      ensureWorkspacesRoot();
      const existing = this.loadRegistry();
      const data: Record<string, PersistedRunnerRecord> = { ...existing };

      for (const r of this.runners.values()) {
        if (r.lastStartPayload) {
          const currentSessionSec =
            r.startedAtMs && r.state === 'running'
              ? Math.max(0, Math.floor((Date.now() - r.startedAtMs) / 1000))
              : 0;
          data[r.serverId] = {
            enabled: r.enabled,
            payload: r.lastStartPayload,
            cumulativeUptimeSeconds: r.cumulativeUptimeSeconds + currentSessionSec,
            restartCount: r.health.restartCount,
            crashCount: r.health.crashCount,
            oomCount: r.health.oomCount,
            lastOfflineReason: r.health.offlineReason,
            lastOfflineAt: r.lastOfflineAt,
            updatedAt: new Date().toISOString(),
          };
        }
      }

      const tmpPath = `${REGISTRY_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      fs.renameSync(tmpPath, REGISTRY_PATH);
    } catch {
      // non-fatal registry write error
    }
  }

  private schedulePersistRegistry(): void {
    if (this.registryWriteTimer) return;
    this.registryWriteTimer = setTimeout(() => {
      this.registryWriteTimer = null;
      this.writeRegistryNow();
    }, 250);
  }

  public async restorePersistedRunners(): Promise<void> {
    const registry = this.loadRegistry();
    const entries = Object.values(registry).filter((rec) => rec.enabled && rec.payload);
    if (entries.length === 0) return;

    for (const rec of entries) {
      try {
        const req = rec.payload;
        if (!this.canOwnerCreateOrRun(req.ownerUid, req.serverId, ADMIN_BOOTSTRAPPED_EMAIL)) {
          continue;
        }
        const runner = this.getOrCreateRunner(req.serverId, req.ownerUid, req);
        runner.cumulativeUptimeSeconds = rec.cumulativeUptimeSeconds || 0;
        runner.health.restartCount = rec.restartCount || 0;
        runner.health.crashCount = rec.crashCount || 0;
        runner.health.oomCount = rec.oomCount || 0;
        runner.lastOfflineAt = rec.lastOfflineAt || null;
        console.log(`[FACON HOST] Supervisor reviving enabled 24/7 bot ${req.serverId} (${req.name})`);
        await this.startServer(req, ADMIN_BOOTSTRAPPED_EMAIL, true);
      } catch (err) {
        console.warn(
          `[FACON HOST] Supervisor failed to restore ${rec.payload.serverId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  public canOwnerCreateOrRun(ownerUid: string, serverId: string, requesterEmail: string): boolean {
    if (requesterEmail === ADMIN_BOOTSTRAPPED_EMAIL) return true;
    const activeOwned = Array.from(this.runners.values()).filter(
      (r) => r.ownerUid === ownerUid && r.serverId !== serverId && (r.enabled || r.state === 'running')
    );
    return activeOwned.length < MAX_SERVERS_PER_USER;
  }

  private getOrCreateRunner(
    serverId: string,
    ownerUid: string,
    meta?: { name?: string; runtime?: string; appType?: string; startupCommand?: string; autoRestart?: boolean }
  ): ManagedRunner {
    const safeId = sanitizeServerId(serverId);
    const existing = this.runners.get(safeId);
    if (existing) {
      return existing;
    }

    const appType = meta?.appType || 'Discord Bot';
    const created: ManagedRunner = {
      serverId: safeId,
      ownerUid,
      name: meta?.name || safeId,
      runtime: meta?.runtime || 'Node.js',
      appType,
      startupCommand: meta?.startupCommand || '',
      autoRestart: meta?.autoRestart ?? true,
      enabled: false,
      state: 'stopped',
      child: null,
      pid: null,
      exitCode: null,
      startedAtMs: null,
      lastOfflineAt: null,
      cumulativeUptimeSeconds: 0,
      manualStopRequested: false,
      startInProgress: false,
      consecutiveCrashes: 0,
      oomDetectedInRun: false,
      restartTimer: null,
      telemetryTimer: null,
      healthTimer: null,
      telemetryBusy: false,
      lastCpuSample: null,
      telemetry: { cpuPct: 0, ramMb: 0, diskMb: 0, uptimeSeconds: 0, totalUptimeSeconds: 0 },
      gateway: makeInitialGateway(appType),
      health: makeInitialHealth(),
      logs: [],
      subscribers: new Set<WebSocket>(),
      sseSubscribers: new Set<(rawJson: string) => void>(),
      stdoutRemainder: '',
      stderrRemainder: '',
      lastStartPayload: null,
    };
    this.runners.set(safeId, created);
    return created;
  }

  public canAccess(serverId: string, userUid: string, userEmail: string): boolean {
    const safeId = sanitizeServerId(serverId);
    const runner = this.runners.get(safeId);
    if (!runner) return true;
    return runner.ownerUid === userUid || userEmail === ADMIN_BOOTSTRAPPED_EMAIL;
  }

  public getFleetForUser(userUid: string, userEmail: string): RunnerFleetSummary[] {
    const isAdmin = userEmail === ADMIN_BOOTSTRAPPED_EMAIL;
    const list: RunnerFleetSummary[] = [];
    for (const r of this.runners.values()) {
      if (!isAdmin && r.ownerUid !== userUid) continue;
      const aliveRunning = r.state === 'running' && r.pid !== null && isPidAlive(r.pid);
      const effectiveState: RunnerProcessState =
        r.state === 'running' && !aliveRunning ? 'crashed' : r.state;
      const sessionSec =
        effectiveState === 'running' && r.startedAtMs
          ? Math.max(0, Math.floor((Date.now() - r.startedAtMs) / 1000))
          : 0;
      list.push({
        serverId: r.serverId,
        ownerUid: r.ownerUid,
        enabled: r.enabled,
        state: effectiveState,
        pid: aliveRunning ? r.pid : null,
        exitCode: r.exitCode,
        startedAt: effectiveState === 'running' && r.startedAtMs ? new Date(r.startedAtMs).toISOString() : null,
        lastOfflineAt: r.lastOfflineAt,
        telemetry: {
          ...r.telemetry,
          cpuPct: effectiveState === 'running' ? r.telemetry.cpuPct : 0,
          ramMb: effectiveState === 'running' ? r.telemetry.ramMb : 0,
          uptimeSeconds: sessionSec,
          totalUptimeSeconds: r.cumulativeUptimeSeconds + sessionSec,
        },
        gateway: r.gateway,
        health: r.health,
      });
    }
    return list;
  }

  private broadcast(runner: ManagedRunner, payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    for (const ws of runner.subscribers) {
      if (ws.readyState === 1) {
        try {
          ws.send(raw);
        } catch {
          runner.subscribers.delete(ws);
        }
      } else if (ws.readyState > 1) {
        runner.subscribers.delete(ws);
      }
    }
    for (const sendSse of runner.sseSubscribers) {
      try {
        sendSse(raw);
      } catch {
        runner.sseSubscribers.delete(sendSse);
      }
    }
  }

  private pushLog(runner: ManagedRunner, level: RunnerLogLevel, message: string): void {
    const clean = message.replace(/\r$/, '');
    if (!clean) return;
    const entry: RunnerLogEntry = {
      id: `rlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      level,
      message: clean.slice(0, 2000),
      timestamp: new Date().toISOString(),
    };
    runner.logs.push(entry);
    if (runner.logs.length > MAX_LOG_BUFFER) {
      runner.logs = runner.logs.slice(-MAX_LOG_BUFFER);
    }
    this.broadcast(runner, { type: 'log', entry });
  }

  private broadcastState(runner: ManagedRunner): void {
    const sessionSec =
      runner.startedAtMs && runner.state === 'running'
        ? Math.max(0, Math.floor((Date.now() - runner.startedAtMs) / 1000))
        : 0;
    this.broadcast(runner, {
      type: 'state',
      enabled: runner.enabled,
      state: runner.state,
      pid: runner.pid,
      exitCode: runner.exitCode,
      startedAt: runner.startedAtMs ? new Date(runner.startedAtMs).toISOString() : null,
      lastOfflineAt: runner.lastOfflineAt,
      telemetry: {
        ...runner.telemetry,
        uptimeSeconds: sessionSec,
        totalUptimeSeconds: runner.cumulativeUptimeSeconds + sessionSec,
      },
      gateway: runner.gateway,
      health: runner.health,
    });
  }

  private updateHealth(runner: ManagedRunner, patch: Partial<RunnerHealthStatus>): void {
    runner.health = {
      ...runner.health,
      ...patch,
      lastCheckAt: new Date().toISOString(),
    };
    this.broadcast(runner, { type: 'health', health: runner.health });
  }

  private shouldEmitDiagnostic(runner: ManagedRunner, key: string, cooldownMs = 5000): boolean {
    if (!runner.lastDiagnosticAtMs) runner.lastDiagnosticAtMs = {};
    const now = Date.now();
    const prev = runner.lastDiagnosticAtMs[key] || 0;
    if (now - prev < cooldownMs) return false;
    runner.lastDiagnosticAtMs[key] = now;
    return true;
  }

  private inspectOutputForDiagnostics(runner: ManagedRunner, line: string, isStderr: boolean): void {
    if (
      line.startsWith('[DIAGNOSTIC]') ||
      line.startsWith('[SHIELD]') ||
      line.startsWith('[SUPERVISOR]')
    ) {
      return;
    }
    const lower = line.toLowerCase();

    if (lower.startsWith('[perf warning]')) {
      this.updateHealth(runner, {
        status: 'degraded',
        lastError: line.trim().slice(0, 220),
        diagnosticHint:
          'Event loop blocked by synchronous I/O (requests.get / time.sleep) or host CPU throttling. Replace blocking calls with async aiohttp/asyncio.sleep and ensure Always-Online keepalive is active.',
      });
      return;
    }

    // Detect Out-Of-Memory signatures explicitly
    if (
      lower.includes('javascript heap out of memory') ||
      lower.includes('err_out_of_memory') ||
      lower.includes('allocation failed - process out of memory') ||
      lower.includes('memoryerror') ||
      lower.includes('outofmemoryerror') ||
      lower.includes('std::bad_alloc')
    ) {
      runner.oomDetectedInRun = true;
      this.updateHealth(runner, {
        status: 'error',
        errorCount: runner.health.errorCount + 1,
        lastError: 'Out-Of-Memory (OOM) detected in bot process.',
        offlineReason: 'Process ran out of memory (OOM) and was isolated cleanly.',
        diagnosticHint:
          'Check for unbounded caches, large arrays, or duplicate message collectors retaining memory over time.',
      });
      return;
    }

    const isUnhandledAsync =
      lower.includes('unhandledpromiserejection') ||
      lower.includes('task exception was never retrieved') ||
      lower.includes('unhandled rejection') ||
      lower.includes('traceback (most recent call last)');

    const isSyntaxOrImportFatal =
      lower.includes('syntaxerror:') ||
      lower.includes('indentationerror:') ||
      lower.includes('err_module_not_found') ||
      lower.includes('cannot find module') ||
      lower.includes("no module named '");

    if (
      lower.includes('maxlistenersexceededwarning') ||
      lower.includes('possible eventemitter memory leak')
    ) {
      this.updateHealth(runner, {
        status: 'degraded',
        errorCount: runner.health.errorCount + 1,
        lastError: 'Duplicate event listeners detected (MaxListenersExceededWarning).',
        diagnosticHint:
          'Avoid registering client.on(...) inside other event callbacks or loops; register command/event listeners once at startup.',
      });
    }

    if (
      lower.includes('10062') ||
      lower.includes('unknown interaction') ||
      lower.includes('interaction has already been acknowledged') ||
      lower.includes('did not respond in time') ||
      lower.includes('40060')
    ) {
      if (this.shouldEmitDiagnostic(runner, 'interaction_timeout', 5000)) {
        this.updateHealth(runner, {
          status: 'degraded',
          errorCount: runner.health.errorCount + 1,
          lastError: 'Discord Interaction Timeout (10062 / 40060).',
          diagnosticHint:
            'Discord requires an ACK within 3s of creation. Runtime Shield forces IPv4 DNS/aiohttp and auto-defers at ~1.1s, but serverless CPU throttling or sync I/O (requests/time.sleep) can still delay Gateway dispatch. Keep /api/ping monitored for unthrottled CPU.',
        });
        this.pushLog(
          runner,
          'gateway',
          '[DIAGNOSTIC] Discord interaction timed out (>3s). Call deferReply()/response.defer() first, avoid sync blocking calls, and keep /api/ping active on Cloud Run.'
        );
      }
      return;
    }

    if (
      lower.includes('429') &&
      (lower.includes('rate limit') || lower.includes('ratelimit') || lower.includes('too many requests'))
    ) {
      const retrySecMatch = line.match(/retry[_ ]?after[:=\s]+([0-9.]+)/i);
      const retryMs = retrySecMatch ? Math.ceil(Number(retrySecMatch[1]) * 1000) : 5000;
      this.updateHealth(runner, {
        status: 'degraded',
        errorCount: runner.health.errorCount + 1,
        lastError: 'Discord API 429 rate limit encountered.',
        diagnosticHint:
          'Avoid calling tree.sync() or bulk edits on every message/restart. Wait for Retry-After before retrying.',
        rateLimitedUntil: new Date(Date.now() + retryMs).toISOString(),
      });
      return;
    }

    if (isStderr && isSyntaxOrImportFatal) {
      this.updateHealth(runner, {
        status: 'error',
        fatalError: true,
        errorCount: runner.health.errorCount + 1,
        lastError: line.trim().slice(0, 220),
        offlineReason: `Code/dependency error: ${line.trim().slice(0, 180)}`,
        diagnosticHint: lower.includes("no module named '")
          ? 'Add the missing Python package to /requirements.txt and click Restart.'
          : lower.includes('cannot find module') || lower.includes('err_module_not_found')
          ? 'Verify imports and /package.json dependencies before restarting.'
          : 'Fix the syntax error reported above; supervisor will retry safely on backoff or immediately on Restart.',
      });
    } else if (isStderr && isUnhandledAsync) {
      this.updateHealth(runner, {
        status: 'degraded',
        errorCount: runner.health.errorCount + 1,
        lastError: line.trim().slice(0, 220),
        diagnosticHint:
          'Wrap async command handlers in try/catch (or attach @bot.event on_command_error / process.on("unhandledRejection")) so one failed command cannot drop the bot.',
      });
    }

    if (runner.appType !== 'Discord Bot') return;

    if (
      lower.includes('used disallowed intents') ||
      lower.includes('disallowed intent') ||
      lower.includes('4014')
    ) {
      runner.gateway = {
        ...runner.gateway,
        connectionState: 'error',
        lastEvent:
          'Discord rejected Privileged Gateway Intents (4014). Enable Message Content / Server Members Intent in Discord Developer Portal.',
        updatedAt: new Date().toISOString(),
      };
      this.updateHealth(runner, {
        status: 'error',
        fatalError: true,
        errorCount: runner.health.errorCount + 1,
        lastError: 'Disallowed Gateway Intents (4014).',
        offlineReason: 'Discord closed connection (4014 Disallowed Intents).',
        diagnosticHint:
          'Open Discord Developer Portal -> Bot -> Privileged Gateway Intents and toggle Message Content Intent ON. Auto-recovery will retry safely in slow backoff.',
      });
      this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
      return;
    }

    if (
      lower.includes('invalid token') ||
      lower.includes('improper token') ||
      lower.includes('tokeninvalid') ||
      lower.includes('4004')
    ) {
      runner.gateway = {
        ...runner.gateway,
        tokenStatus: 'invalid',
        connectionState: 'error',
        lastEvent: 'Discord Gateway authentication failed (4004 Invalid Token). Check DISCORD_TOKEN.',
        updatedAt: new Date().toISOString(),
      };
      this.updateHealth(runner, {
        status: 'error',
        fatalError: true,
        errorCount: runner.health.errorCount + 1,
        lastError: 'Invalid Discord Bot Token (4004).',
        offlineReason: 'Discord rejected DISCORD_TOKEN (4004 Invalid Token).',
        diagnosticHint: 'Reset your Bot Token in Discord Developer Portal and update DISCORD_TOKEN under Startup.',
      });
      this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
      return;
    }

    if (
      lower.includes('logged in as') ||
      lower.includes('online as') ||
      lower.includes('client ready') ||
      lower.includes('gateway ready') ||
      lower.includes('shard 0 ready') ||
      lower.includes('has connected to gateway') ||
      lower.includes('connected to discord') ||
      lower.includes('bot is ready')
    ) {
      runner.gateway = {
        ...runner.gateway,
        tokenStatus:
          runner.gateway.tokenStatus === 'placeholder' || runner.gateway.tokenStatus === 'missing'
            ? runner.gateway.tokenStatus
            : 'valid',
        connectionState: 'online',
        lastEvent: line.trim().slice(0, 240),
        updatedAt: new Date().toISOString(),
      };
      this.updateHealth(runner, {
        status: 'healthy',
        fatalError: false,
        offlineReason: null,
        nextRecoveryAt: null,
        rateLimitedUntil: null,
        diagnosticHint: null,
      });
      this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
      return;
    }

    if (isStderr && lower.includes("no module named '")) {
      runner.gateway = {
        ...runner.gateway,
        connectionState: 'error',
        lastEvent: `${line.trim()} — Add this package to /requirements.txt and click Restart.`,
        updatedAt: new Date().toISOString(),
      };
      this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
    }
  }

  private handleGatewayControlLine(runner: ManagedRunner, rawJson: string): void {
    try {
      const data = JSON.parse(rawJson) as {
        connectionState?: 'offline' | 'connecting' | 'online' | 'error';
        presenceStatus?: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
        botTag?: string | null;
        botId?: string | null;
        activityType?: string | null;
        activityName?: string | null;
        latencyMs?: number | null;
        shards?: number | null;
        guildCount?: number | null;
        event?: string | null;
      };

      const prev = runner.gateway;
      const nextConn = data.connectionState || prev.connectionState;
      const isOnline = nextConn === 'online';
      const nextPresence =
        data.presenceStatus || (isOnline ? 'online' : 'offline');
      const nextActType = isOnline ? (data.activityType ?? null) : null;
      const nextActName = isOnline ? (data.activityName ?? null) : null;
      const actDisplay =
        nextActName ? `${nextActType || 'Playing'} ${nextActName}` : null;

      const summaryEvent =
        data.event ||
        (isOnline
          ? actDisplay
            ? `Online (${actDisplay})`
            : 'Discord Gateway connected'
          : 'Discord Gateway offline');

      runner.gateway = {
        ...prev,
        tokenPresent: true,
        tokenStatus:
          nextConn === 'online'
            ? 'valid'
            : prev.tokenStatus,
        connectionState: nextConn,
        presenceStatus: nextPresence,
        activityType: nextActType,
        activityName: nextActName,
        botTag: data.botTag || prev.botTag,
        botId: data.botId || prev.botId,
        shards: typeof data.shards === 'number' ? data.shards : prev.shards,
        latencyMs: isOnline && typeof data.latencyMs === 'number' ? data.latencyMs : isOnline ? prev.latencyMs : null,
        guildCount: typeof data.guildCount === 'number' ? data.guildCount : prev.guildCount,
        lastEvent: summaryEvent,
        updatedAt: new Date().toISOString(),
      };

      if (isOnline) {
        runner.lastGatewayAliveMs = Date.now();
        this.updateHealth(runner, {
          status: 'healthy',
          fatalError: false,
          offlineReason: null,
          nextRecoveryAt: null,
          rateLimitedUntil: null,
          diagnosticHint: null,
        });
      }

      const changedMeaningfully =
        prev.connectionState !== runner.gateway.connectionState ||
        prev.presenceStatus !== runner.gateway.presenceStatus ||
        prev.activityType !== runner.gateway.activityType ||
        prev.activityName !== runner.gateway.activityName ||
        (Boolean(data.event) && data.event !== prev.lastEvent);

      if (changedMeaningfully) {
        const tag = runner.gateway.botTag || runner.name;
        const pingNote =
          typeof runner.gateway.latencyMs === 'number' ? ` · ${runner.gateway.latencyMs}ms` : '';
        const guildNote =
          typeof runner.gateway.guildCount === 'number' ? ` · ${runner.gateway.guildCount} servers` : '';
        const actNote = actDisplay ? ` · Status: ${actDisplay}` : isOnline ? ' · Status: Online' : '';
        this.pushLog(
          runner,
          'gateway',
          `${tag} Gateway ${runner.gateway.connectionState.toUpperCase()}${actNote}${pingNote}${guildNote}`
        );
      }

      this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
    } catch {
      // ignore malformed gateway telemetry packet
    }
  }

  private flushStreamLines(runner: ManagedRunner, chunk: string, streamType: 'stdout' | 'stderr'): void {
    const key = streamType === 'stdout' ? 'stdoutRemainder' : 'stderrRemainder';
    const combined = runner[key] + chunk;
    const parts = combined.split(/\r?\n/);
    runner[key] = parts.pop() || '';
    for (const line of parts) {
      if (line.length > 0) {
        if (line.startsWith('__FACON_GW__')) {
          this.handleGatewayControlLine(runner, line.slice('__FACON_GW__'.length));
          continue;
        }
        this.pushLog(runner, streamType, line);
        this.inspectOutputForDiagnostics(runner, line, streamType === 'stderr');
      }
    }
  }

  public getSnapshot(serverId: string, ownerUid: string): RunnerSnapshot {
    const runner = this.getOrCreateRunner(serverId, ownerUid);
    const aliveRunning =
      runner.state === 'running' && runner.pid !== null && isPidAlive(runner.pid);
    const effectiveState: RunnerProcessState =
      runner.state === 'running' && !aliveRunning ? 'crashed' : runner.state;
    const sessionSec =
      effectiveState === 'running' && runner.startedAtMs
        ? Math.max(0, Math.floor((Date.now() - runner.startedAtMs) / 1000))
        : 0;

    return {
      serverId: runner.serverId,
      ownerUid: runner.ownerUid,
      enabled: runner.enabled,
      state: effectiveState,
      pid: aliveRunning ? runner.pid : null,
      startupCommand: runner.startupCommand,
      runtime: runner.runtime,
      appType: runner.appType,
      exitCode: runner.exitCode,
      startedAt:
        effectiveState === 'running' && runner.startedAtMs
          ? new Date(runner.startedAtMs).toISOString()
          : null,
      lastOfflineAt: runner.lastOfflineAt,
      telemetry: {
        ...runner.telemetry,
        cpuPct: effectiveState === 'running' ? runner.telemetry.cpuPct : 0,
        ramMb: effectiveState === 'running' ? runner.telemetry.ramMb : 0,
        uptimeSeconds: sessionSec,
        totalUptimeSeconds: runner.cumulativeUptimeSeconds + sessionSec,
      },
      gateway: runner.gateway,
      health: runner.health,
      logs: runner.logs,
      hostCapabilities: getHostCapabilities(),
    };
  }

  public attachSubscriber(serverId: string, ownerUid: string, ws: WebSocket): void {
    const runner = this.getOrCreateRunner(serverId, ownerUid);
    runner.subscribers.add(ws);

    const snapshot = this.getSnapshot(serverId, ownerUid);
    try {
      ws.send(JSON.stringify({ type: 'init', snapshot }));
    } catch {
      runner.subscribers.delete(ws);
      return;
    }

    const cleanup = () => {
      runner.subscribers.delete(ws);
    };
    ws.once('close', cleanup);
    ws.once('error', cleanup);
  }

  public attachSseSubscriber(
    serverId: string,
    ownerUid: string,
    sendRaw: (rawJson: string) => void
  ): () => void {
    const runner = this.getOrCreateRunner(serverId, ownerUid);
    runner.sseSubscribers.add(sendRaw);
    const snapshot = this.getSnapshot(serverId, ownerUid);
    try {
      sendRaw(JSON.stringify({ type: 'init', snapshot }));
    } catch {
      runner.sseSubscribers.delete(sendRaw);
    }
    return () => {
      runner.sseSubscribers.delete(sendRaw);
    };
  }

  private clearChildTimers(runner: ManagedRunner): void {
    if (runner.telemetryTimer) {
      clearInterval(runner.telemetryTimer);
      runner.telemetryTimer = null;
    }
    if (runner.healthTimer) {
      clearInterval(runner.healthTimer);
      runner.healthTimer = null;
    }
  }

  private clearAllTimers(runner: ManagedRunner): void {
    this.clearChildTimers(runner);
    if (runner.restartTimer) {
      clearTimeout(runner.restartTimer);
      runner.restartTimer = null;
    }
  }

  private detachChildListeners(child: ChildProcess | null): void {
    if (!child) return;
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
  }

  private scheduleRecovery(runner: ManagedRunner, reason: string, isConfigError: boolean): void {
    if (!runner.enabled || runner.manualStopRequested || !runner.lastStartPayload) {
      return;
    }
    if (runner.restartTimer) {
      return;
    }

    runner.consecutiveCrashes += 1;
    const schedule = isConfigError ? CONFIG_ERROR_BACKOFF_MS : RECOVERY_BACKOFF_MS;
    const delayMs = schedule[Math.min(runner.consecutiveCrashes - 1, schedule.length - 1)];
    const nextIso = new Date(Date.now() + delayMs).toISOString();

    this.updateHealth(runner, {
      status: isConfigError ? 'error' : 'recovering',
      errorCount: runner.health.errorCount + 1,
      restartCount: runner.health.restartCount + 1,
      lastError: runner.health.lastError || reason,
      offlineReason: reason,
      nextRecoveryAt: nextIso,
    });

    this.pushLog(
      runner,
      'system',
      `[SUPERVISOR] Recovery #${runner.health.restartCount} scheduled in ${Math.round(
        delayMs / 1000
      )}s (${reason}).`
    );
    this.broadcastState(runner);
    this.schedulePersistRegistry();

    runner.restartTimer = setTimeout(() => {
      runner.restartTimer = null;
      if (!runner.enabled || runner.manualStopRequested || !runner.lastStartPayload) {
        return;
      }
      this.updateHealth(runner, { nextRecoveryAt: null });
      void this.startServer(runner.lastStartPayload, ADMIN_BOOTSTRAPPED_EMAIL, true);
    }, delayMs);
  }

  public async stopServer(serverId: string, requesterUid: string, requesterEmail: string): Promise<RunnerSnapshot> {
    const safeId = sanitizeServerId(serverId);
    const runner = this.getOrCreateRunner(safeId, requesterUid);
    if (!this.canAccess(safeId, requesterUid, requesterEmail)) {
      throw new Error('Unauthorized to stop this server.');
    }

    runner.enabled = false;
    runner.manualStopRequested = true;
    this.clearAllTimers(runner);

    if (runner.child && runner.state !== 'stopped') {
      const child = runner.child;
      if (runner.startedAtMs && runner.state === 'running') {
        runner.cumulativeUptimeSeconds += Math.max(
          0,
          Math.floor((Date.now() - runner.startedAtMs) / 1000)
        );
      }
      this.pushLog(runner, 'system', `Sending SIGTERM to process PID ${child.pid}...`);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const forceTimer = setTimeout(() => {
          killChildProcessTree(child, 'SIGKILL');
          finish();
        }, 2500);
        child.once('exit', () => {
          clearTimeout(forceTimer);
          finish();
        });
        killChildProcessTree(child, 'SIGTERM');
      });
      this.detachChildListeners(child);
    }

    runner.child = null;
    runner.pid = null;
    runner.startedAtMs = null;
    runner.lastOfflineAt = new Date().toISOString();
    runner.state = 'stopped';
    runner.consecutiveCrashes = 0;
    runner.lastCpuSample = null;
    runner.telemetry = {
      ...runner.telemetry,
      cpuPct: 0,
      ramMb: 0,
      uptimeSeconds: 0,
      totalUptimeSeconds: runner.cumulativeUptimeSeconds,
    };
    runner.gateway = {
      ...runner.gateway,
      connectionState: 'offline',
      presenceStatus: 'offline',
      activityType: null,
      activityName: null,
      latencyMs: null,
      lastEvent: 'Stopped manually by user.',
      updatedAt: new Date().toISOString(),
    };
    this.updateHealth(runner, {
      status: 'stopped',
      fatalError: false,
      offlineReason: 'Stopped manually by user.',
      nextRecoveryAt: null,
    });
    this.pushLog(runner, 'system', 'Process stopped by user.');
    this.broadcastState(runner);
    this.writeRegistryNow();
    return this.getSnapshot(safeId, runner.ownerUid);
  }

  public async removeServer(serverId: string, requesterUid: string, requesterEmail: string): Promise<void> {
    const safeId = sanitizeServerId(serverId);
    const runner = this.runners.get(safeId);
    if (runner) {
      if (!this.canAccess(safeId, requesterUid, requesterEmail)) {
        throw new Error('Unauthorized to remove this server runner.');
      }
      await this.stopServer(safeId, requesterUid, requesterEmail);
      this.runners.delete(safeId);
    }

    try {
      const existing = this.loadRegistry();
      if (existing[safeId]) {
        delete existing[safeId];
        const tmpPath = `${REGISTRY_PATH}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(existing), 'utf8');
        fs.renameSync(tmpPath, REGISTRY_PATH);
      }
    } catch {
      // ignore registry cleanup error
    }

    try {
      const wsDir = getWorkspaceDir(safeId);
      if (fs.existsSync(wsDir)) {
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    } catch {
      // ignore workspace cleanup error
    }
  }

  private async runBuildPreStep(
    runner: ManagedRunner,
    step: ResolvedCommandStep,
    workspaceDir: string,
    childEnv: Record<string, string>
  ): Promise<void> {
    this.pushLog(runner, 'cmd', `$ ${step.display} (build step)`);
    await new Promise<void>((resolve, reject) => {
      const buildChild = spawn(step.executable, step.args, {
        cwd: workspaceDir,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      buildChild.stdout?.on('data', (chunk: Buffer) => {
        this.flushStreamLines(runner, chunk.toString('utf8'), 'stdout');
      });
      buildChild.stderr?.on('data', (chunk: Buffer) => {
        this.flushStreamLines(runner, chunk.toString('utf8'), 'stderr');
      });
      buildChild.once('error', (err) => {
        this.detachChildListeners(buildChild);
        reject(err);
      });
      buildChild.once('exit', (code) => {
        this.detachChildListeners(buildChild);
        if (code === 0) resolve();
        else reject(new Error(`Build step "${step.display}" exited with code ${code ?? 1}.`));
      });
    });
  }

  public async startServer(
    req: StartRunnerRequest,
    requesterEmail: string,
    isSupervisorRecovery = false
  ): Promise<RunnerSnapshot> {
    const safeId = sanitizeServerId(req.serverId);
    const runner = this.getOrCreateRunner(safeId, req.ownerUid, req);
    if (!this.canAccess(safeId, req.ownerUid, requesterEmail)) {
      throw new Error('Unauthorized to control this server runner.');
    }
    if (!this.canOwnerCreateOrRun(req.ownerUid, safeId, requesterEmail)) {
      throw new Error(`Account limit reached: maximum ${MAX_SERVERS_PER_USER} servers allowed per user.`);
    }

    if (runner.startInProgress) {
      this.pushLog(runner, 'system', 'Start request already in progress; deduplicating.');
      return this.getSnapshot(safeId, runner.ownerUid);
    }

    runner.startInProgress = true;
    try {
      this.clearAllTimers(runner);

      // Stop any existing running child gracefully first so Discord receives clean offline close
      if (runner.child) {
        const oldChild = runner.child;
        runner.child = null;
        this.detachChildListeners(oldChild);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const force = setTimeout(() => {
            killChildProcessTree(oldChild, 'SIGKILL');
            finish();
          }, 1800);
          oldChild.once('exit', () => {
            clearTimeout(force);
            finish();
          });
          killChildProcessTree(oldChild, 'SIGTERM');
        });
      }

      if (!isSupervisorRecovery) {
        runner.consecutiveCrashes = 0;
      }

      runner.name = req.name;
      runner.runtime = req.runtime;
      runner.appType = req.appType;
      runner.startupCommand = req.startupCommand;
      runner.autoRestart = req.autoRestart;
      runner.enabled = true;
      runner.lastStartPayload = req;
      runner.manualStopRequested = false;
      runner.oomDetectedInRun = false;
      runner.lastGatewayAliveMs = null;
      runner.startingSinceMs = Date.now();
      runner.exitCode = null;
      runner.state = 'starting';
      runner.stdoutRemainder = '';
      runner.stderrRemainder = '';
      this.updateHealth(runner, {
        status: isSupervisorRecovery ? 'recovering' : 'healthy',
        fatalError: false,
        offlineReason: null,
        nextRecoveryAt: null,
      });

      this.pushLog(runner, 'system', `Syncing ${req.files.length} workspace file(s) to container...`);
      this.broadcastState(runner);
      const workspaceDir = materializeWorkspace(safeId, req.files, req.envVars);
      const diskBytes = await measureDirectoryBytesAsync(workspaceDir);
      runner.telemetry = {
        cpuPct: 0,
        ramMb: 0,
        diskMb: Math.max(1, Math.round((diskBytes / (1024 * 1024)) * 10) / 10),
        uptimeSeconds: 0,
        totalUptimeSeconds: runner.cumulativeUptimeSeconds,
      };

      if (req.appType === 'Discord Bot') {
        const resolvedToken = resolveDiscordTokenFromWorkspace(req.envVars, req.files);
        if (!resolvedToken) {
          runner.gateway = {
            ...makeInitialGateway(req.appType),
            tokenPresent: false,
            tokenStatus: 'missing',
            connectionState: 'connecting',
            lastEvent: 'No DISCORD_TOKEN env var set — waiting for bot login via workspace config...',
          };
        } else if (resolvedToken === 'replace_with_your_token') {
          runner.gateway = {
            ...makeInitialGateway(req.appType),
            tokenPresent: true,
            tokenStatus: 'placeholder',
            lastEvent:
              'Token env var is still set to placeholder "replace_with_your_token". Replace it in Startup → Environment Variables.',
          };
          this.pushLog(
            runner,
            'gateway',
            'Warning: Token env var is still the default placeholder. Replace it in Startup → Environment Variables.'
          );
        } else {
          runner.gateway = {
            ...makeInitialGateway(req.appType),
            tokenPresent: true,
            tokenStatus: 'checking',
            connectionState: 'connecting',
            lastEvent: 'Verifying bot token against Discord API v10...',
          };
          this.broadcastState(runner);

          const check = await probeDiscordTokenWithApi(resolvedToken);
          runner.gateway = {
            appType: req.appType,
            tokenPresent: true,
            tokenStatus: check.tokenStatus,
            connectionState: check.ok ? 'connecting' : 'error',
            presenceStatus: 'offline',
            activityType: null,
            activityName: null,
            guildCount: null,
            botTag: check.botTag,
            botId: check.botId,
            gatewayUrl: check.gatewayUrl,
            shards: check.shards,
            sessionRemaining: check.sessionRemaining,
            sessionTotal: check.sessionTotal,
            latencyMs: check.latencyMs,
            lastEvent: check.message,
            updatedAt: new Date().toISOString(),
          };
          this.pushLog(runner, 'gateway', check.message);
          if (check.tokenStatus === 'invalid') {
            this.updateHealth(runner, {
              status: 'error',
              fatalError: true,
              errorCount: runner.health.errorCount + 1,
              lastError: 'Invalid DISCORD_TOKEN (401 Unauthorized).',
              offlineReason: 'Discord rejected DISCORD_TOKEN (401 Unauthorized).',
              diagnosticHint: 'Update DISCORD_TOKEN in Startup -> Environment Variables before starting.',
            });
          } else if (check.rateLimitedMs) {
            this.updateHealth(runner, {
              status: 'degraded',
              rateLimitedUntil: new Date(Date.now() + check.rateLimitedMs).toISOString(),
            });
          }
        }
      } else {
        runner.gateway = makeInitialGateway(req.appType);
      }

      let pipeline: { preSteps: ResolvedCommandStep[]; mainStep: ResolvedCommandStep };
      try {
        pipeline = await resolveExecutablePipeline(req.startupCommand, workspaceDir, (msg) => {
          this.pushLog(runner, 'system', msg);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to parse startup command.';
        runner.state = 'crashed';
        runner.exitCode = 127;
        runner.lastOfflineAt = new Date().toISOString();
        this.pushLog(runner, 'stderr', msg);
        this.scheduleRecovery(runner, msg, true);
        return this.getSnapshot(safeId, runner.ownerUid);
      }

      let pythonDepsDir = '';
      const usesPython =
        pipeline.mainStep.isPython || pipeline.preSteps.some((s) => s.isPython);
      if (usesPython) {
        const pyStep = pipeline.mainStep.isPython
          ? pipeline.mainStep
          : pipeline.preSteps.find((s) => s.isPython)!;
        try {
          pythonDepsDir = await ensureWorkspacePythonDeps(
            pyStep.executable,
            workspaceDir,
            (lvl, msg) => {
              this.pushLog(runner, lvl, msg);
            }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to install Python dependencies.';
          runner.state = 'crashed';
          runner.exitCode = 1;
          runner.lastOfflineAt = new Date().toISOString();
          this.pushLog(runner, 'stderr', msg);
          this.scheduleRecovery(runner, msg, false);
          return this.getSnapshot(safeId, runner.ownerUid);
        }
      }

      const execDir = path.dirname(pipeline.mainStep.executable);
      const childEnv: Record<string, string> = {
        PATH: `${execDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        HOME: workspaceDir,
        LANG: process.env.LANG || 'C.UTF-8',
        TERM: 'xterm-256color',
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '16',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '0',
        NODE_PATH: path.resolve(process.cwd(), 'node_modules'),
      };
      if (pythonDepsDir) {
        childEnv.PYTHONPATH = `${pythonDepsDir}${path.delimiter}${workspaceDir}`;
      }
      for (const v of req.envVars) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(v.key)) {
          const val = String(v.value ?? '');
          if (v.key === 'PATH' && !val.trim()) continue;
          childEnv[v.key] = val;
        }
      }

      let nodeShieldFlags = '';
      if (req.appType === 'Discord Bot') {
        const auditFindings = auditDiscordBotWorkspace(req.files);
        for (const finding of auditFindings.slice(0, 6)) {
          this.pushLog(runner, 'gateway', `[DIAGNOSTIC] ${finding.file}: ${finding.message}`);
        }

        try {
          const shield = ensureDiscordShieldArtifacts();
          if (usesPython) {
            const existingPyPath = childEnv.PYTHONPATH ? `${path.delimiter}${childEnv.PYTHONPATH}` : '';
            childEnv.PYTHONPATH = `${shield.pythonShieldDir}${existingPyPath}${
              existingPyPath ? '' : `${path.delimiter}${workspaceDir}`
            }`;
          }
          if (pipeline.mainStep.isNode) {
            nodeShieldFlags = `--dns-result-order=ipv4first --import ${shield.nodeShieldImportUrl}`;
          }

          this.pushLog(
            runner,
            'gateway',
            '[SHIELD] FACON Discord Interaction Guard active (<3s auto-defer, safe deferred/reply routing & error capture).'
          );
        } catch (shieldErr) {
          this.pushLog(
            runner,
            'system',
            `[SHIELD] Runtime guard skipped: ${shieldErr instanceof Error ? shieldErr.message : shieldErr}`
          );
        }
      }

      for (const pre of pipeline.preSteps) {
        try {
          await this.runBuildPreStep(runner, pre, workspaceDir, childEnv);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Pre-start build step failed.';
          runner.state = 'crashed';
          runner.exitCode = 1;
          runner.lastOfflineAt = new Date().toISOString();
          this.pushLog(runner, 'stderr', msg);
          this.scheduleRecovery(runner, msg, true);
          return this.getSnapshot(safeId, runner.ownerUid);
        }
      }

      if (nodeShieldFlags) {
        const existingNodeOpts = (childEnv.NODE_OPTIONS || '').trim();
        childEnv.NODE_OPTIONS = existingNodeOpts ? `${existingNodeOpts} ${nodeShieldFlags}` : nodeShieldFlags;
      }

      const mainCmd = pipeline.mainStep;
      this.pushLog(runner, 'cmd', `$ ${mainCmd.display}`);

      const child = spawn(mainCmd.executable, mainCmd.args, {
        cwd: workspaceDir,
        env: childEnv,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const bootStartedAt = Date.now();
      runner.child = child;
      runner.pid = child.pid ?? null;
      runner.startedAtMs = bootStartedAt;
      runner.state = 'running';
      this.updateHealth(runner, {
        status: 'healthy',
        fatalError: false,
        offlineReason: null,
        nextRecoveryAt: null,
      });
      this.broadcastState(runner);
      this.writeRegistryNow();

      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.flushStreamLines(runner, chunk.toString('utf8'), 'stdout');
        } catch {
          // isolate stream failure from supervisor
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        try {
          this.flushStreamLines(runner, chunk.toString('utf8'), 'stderr');
        } catch {
          // isolate stream failure from supervisor
        }
      });

      child.once('error', (err: Error) => {
        this.updateHealth(runner, {
          status: 'error',
          errorCount: runner.health.errorCount + 1,
          lastError: err.message,
          offlineReason: `Process spawn error: ${err.message}`,
        });
        this.pushLog(runner, 'stderr', `Process spawn error: ${err.message}`);
      });

      const softRamLimitMb = getSafeProcessSoftRamLimitMb();
      runner.telemetryTimer = setInterval(() => {
        if (!runner.pid || runner.state !== 'running' || runner.telemetryBusy) return;
        runner.telemetryBusy = true;
        void Promise.all([
          readLinuxProcessStatsAsync(runner.pid, runner.lastCpuSample),
          measureDirectoryBytesAsync(workspaceDir),
        ])
          .then(([stats, dirBytes]) => {
            runner.lastCpuSample = stats.sample;
            const diskMb = Math.max(1, Math.round((dirBytes / (1024 * 1024)) * 10) / 10);
            const sessionSec = runner.startedAtMs
              ? Math.max(0, Math.floor((Date.now() - runner.startedAtMs) / 1000))
              : 0;
            runner.telemetry = {
              cpuPct: stats.cpuPct,
              ramMb: stats.ramMb,
              diskMb,
              uptimeSeconds: sessionSec,
              totalUptimeSeconds: runner.cumulativeUptimeSeconds + sessionSec,
            };
            this.broadcast(runner, { type: 'telemetry', telemetry: runner.telemetry });

            // Isolate runaway memory leak before kernel OOM kills sibling bots
            if (stats.ramMb > softRamLimitMb * 1.15 && runner.child) {
              runner.oomDetectedInRun = true;
              this.pushLog(
                runner,
                'stderr',
                `[ISOLATION GUARD] Bot RAM reached ${stats.ramMb} MB (host safety cap ${softRamLimitMb} MB). Recycling container cleanly to protect host stability.`
              );
              try {
                runner.child.kill('SIGTERM');
              } catch {
                // ignore
              }
            }
          })
          .catch(() => {
            // keep telemetry loop isolated
          })
          .finally(() => {
            runner.telemetryBusy = false;
          });
      }, 2500);

      runner.healthTimer = setInterval(() => {
        if (runner.state !== 'running' || !runner.pid) return;
        if (!isPidAlive(runner.pid)) {
          this.updateHealth(runner, {
            status: 'degraded',
            lastError: `Process PID ${runner.pid} became unresponsive.`,
          });
          return;
        }
        if (runner.startedAtMs && Date.now() - runner.startedAtMs > 60000) {
          runner.consecutiveCrashes = 0;
          if (runner.health.status === 'recovering') {
            this.updateHealth(runner, { status: 'healthy', offlineReason: null, nextRecoveryAt: null });
          } else {
            this.updateHealth(runner, {});
          }
          this.schedulePersistRegistry();
        }
      }, 15000);

      child.once('exit', (code, signal) => {
        this.detachChildListeners(child);

        if (runner.stdoutRemainder) {
          if (runner.stdoutRemainder.startsWith('__FACON_GW__')) {
            this.handleGatewayControlLine(runner, runner.stdoutRemainder.slice('__FACON_GW__'.length));
          } else {
            this.pushLog(runner, 'stdout', runner.stdoutRemainder);
            this.inspectOutputForDiagnostics(runner, runner.stdoutRemainder, false);
          }
          runner.stdoutRemainder = '';
        }
        if (runner.stderrRemainder) {
          if (runner.stderrRemainder.startsWith('__FACON_GW__')) {
            this.handleGatewayControlLine(runner, runner.stderrRemainder.slice('__FACON_GW__'.length));
          } else {
            this.pushLog(runner, 'stderr', runner.stderrRemainder);
            this.inspectOutputForDiagnostics(runner, runner.stderrRemainder, true);
          }
          runner.stderrRemainder = '';
        }

        this.clearChildTimers(runner);
        runner.child = null;
        runner.pid = null;
        const resolvedCode = code ?? (signal === 'SIGKILL' ? 137 : signal ? 1 : 0);
        runner.exitCode = resolvedCode;
        runner.lastCpuSample = null;
        const ranDurationMs = runner.startedAtMs ? Date.now() - runner.startedAtMs : 0;
        runner.cumulativeUptimeSeconds += Math.max(0, Math.floor(ranDurationMs / 1000));
        runner.startedAtMs = null;
        runner.lastOfflineAt = new Date().toISOString();

        if (runner.manualStopRequested || !runner.enabled) {
          runner.state = 'stopped';
          runner.gateway = {
            ...runner.gateway,
            connectionState: 'offline',
            presenceStatus: 'offline',
            activityType: null,
            activityName: null,
            latencyMs: null,
            updatedAt: new Date().toISOString(),
          };
          this.updateHealth(runner, {
            status: 'stopped',
            offlineReason: runner.health.offlineReason || 'Stopped manually by user.',
          });
          this.broadcastState(runner);
          this.writeRegistryNow();
          return;
        }

        const isOomExit = runner.oomDetectedInRun || signal === 'SIGKILL' || resolvedCode === 137;
        const offlineReason = isOomExit
          ? 'Out-of-memory (OOM / SIGKILL exit 137) — auto-recovering isolated bot process.'
          : code === 0
          ? 'Process exited unexpectedly (exit code 0) while lifetime hosting is enabled.'
          : runner.health.offlineReason ||
            `Unexpected process termination (${signal ? `signal ${signal}` : `exit code ${resolvedCode}`}).`;

        runner.state = 'crashed';
        this.updateHealth(runner, {
          crashCount: runner.health.crashCount + 1,
          oomCount: isOomExit ? runner.health.oomCount + 1 : runner.health.oomCount,
          offlineReason,
        });

        this.pushLog(
          runner,
          'stderr',
          `[OFFLINE DETECTED] ${offlineReason}`
        );

        runner.gateway = {
          ...runner.gateway,
          connectionState: runner.gateway.connectionState === 'error' ? 'error' : 'offline',
          presenceStatus: 'offline',
          activityType: null,
          activityName: null,
          latencyMs: null,
          lastEvent: offlineReason,
          updatedAt: new Date().toISOString(),
        };

        // Reset backoff counter after >= 60s of healthy operation
        if (ranDurationMs >= 60000) {
          runner.consecutiveCrashes = 0;
        }

        // Always keep trying to recover while enabled (24/7 lifetime hosting), using fast backoff unless immediate startup config error
        const isBootConfigError = ranDurationMs < 20000 && runner.health.fatalError;
        this.scheduleRecovery(runner, offlineReason, isBootConfigError);
      });

      return this.getSnapshot(safeId, runner.ownerUid);
    } finally {
      runner.startInProgress = false;
      runner.startingSinceMs = null;
    }
  }

  public sendStdin(
    serverId: string,
    input: string,
    requesterUid: string,
    requesterEmail: string
  ): void {
    const safeId = sanitizeServerId(serverId);
    const runner = this.runners.get(safeId);
    if (!runner || !runner.child || runner.state !== 'running') {
      throw new Error('Backend process is not currently running.');
    }
    if (!this.canAccess(safeId, requesterUid, requesterEmail)) {
      throw new Error('Unauthorized to write to process stdin.');
    }
    this.pushLog(runner, 'cmd', `> ${input}`);
    runner.child.stdin?.write(`${input}\n`);
  }

  public async verifyServerDiscordToken(
    serverId: string,
    token: string,
    requesterUid: string,
    requesterEmail: string
  ): Promise<DiscordGatewayStatus> {
    const safeId = sanitizeServerId(serverId);
    const runner = this.getOrCreateRunner(safeId, requesterUid);
    if (!this.canAccess(safeId, requesterUid, requesterEmail)) {
      throw new Error('Unauthorized.');
    }
    const result = await probeDiscordTokenWithApi(token);
    runner.gateway = {
      appType: runner.appType,
      tokenPresent: Boolean(token.trim()),
      tokenStatus: result.tokenStatus,
      connectionState:
        result.ok && runner.state === 'running' && runner.gateway.connectionState === 'online'
          ? 'online'
          : result.ok
          ? runner.state === 'running'
            ? 'connecting'
            : 'offline'
          : 'error',
      botTag: result.botTag,
      botId: result.botId,
      gatewayUrl: result.gatewayUrl,
      shards: result.shards,
      sessionRemaining: result.sessionRemaining,
      sessionTotal: result.sessionTotal,
      latencyMs: result.latencyMs,
      lastEvent: result.message,
      updatedAt: new Date().toISOString(),
    };
    this.pushLog(runner, 'gateway', result.message);
    this.broadcast(runner, { type: 'gateway', gateway: runner.gateway });
    return runner.gateway;
  }

  // Graceful host shutdown: terminate OS children cleanly WITHOUT disabling `enabled: true` in _registry.json!
  // On next container boot, restorePersistedRunners() revives every enabled bot automatically.
  public async shutdownForHostExit(): Promise<void> {
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = null;
    }
    this.writeRegistryNow();

    const active = Array.from(this.runners.values()).filter((r) => r.child);
    await Promise.all(
      active.map(async (r) => {
        this.clearAllTimers(r);
        const child = r.child;
        if (!child) return;
        // Mark manualStopRequested in memory ONLY (do not overwrite persisted enabled=true!)
        r.manualStopRequested = true;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const force = setTimeout(() => {
            killChildProcessTree(child, 'SIGKILL');
            finish();
          }, 2000);
          child.once('exit', () => {
            clearTimeout(force);
            finish();
          });
          killChildProcessTree(child, 'SIGTERM');
        });
        this.detachChildListeners(child);
        r.child = null;
      })
    );
  }
}

export const runnerManager = new RunnerManager();
