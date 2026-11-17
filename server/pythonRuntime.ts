import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const RUNTIME_BASE_DIR = path.resolve(process.cwd(), '.facon_runtime');
const PYTHON_ROOT_DIR = path.join(RUNTIME_BASE_DIR, 'python');
const STANDALONE_PYTHON_BIN = path.join(PYTHON_ROOT_DIR, 'python', 'bin', 'python3');

// Standalone relocatable CPython 3.12 with pip & OpenSSL for x86_64 Linux glibc containers
const DEFAULT_PYTHON_TARBALL_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';

let activeProvisionPromise: Promise<string> | null = null;

export function findBinaryOnPath(binName: string): string | null {
  const pathDirs = (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    .split(path.delimiter)
    .filter(Boolean);
  const candidates = [...new Set([...pathDirs, '/usr/local/bin', '/usr/bin', '/bin'])];

  for (const dir of candidates) {
    const full = path.join(dir, binName);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      const stat = fs.statSync(full);
      if (stat.isFile()) return full;
    } catch {
      // continue searching
    }
  }
  return null;
}

export function getInstalledPythonInfo(): { bin: string; version: string; hasPip: boolean } | null {
  if (fs.existsSync(STANDALONE_PYTHON_BIN)) {
    const ver = spawnSync(STANDALONE_PYTHON_BIN, ['--version'], { encoding: 'utf8' });
    if (ver.status === 0) {
      return {
        bin: STANDALONE_PYTHON_BIN,
        version: (ver.stdout || ver.stderr || 'Python 3.12').trim(),
        hasPip: true,
      };
    }
  }

  const sysPython = findBinaryOnPath('python3');
  if (sysPython) {
    const ver = spawnSync(sysPython, ['--version'], { encoding: 'utf8' });
    if (ver.status === 0) {
      const pipCheck = spawnSync(sysPython, ['-m', 'pip', '--version'], { encoding: 'utf8' });
      return {
        bin: sysPython,
        version: (ver.stdout || ver.stderr || 'Python 3').trim(),
        hasPip: pipCheck.status === 0,
      };
    }
  }

  return null;
}

async function resolvePythonTarballUrl(): Promise<string> {
  try {
    const res = await fetch(
      'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest',
      { headers: { 'User-Agent': 'facon-host-runner' } }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        assets?: { name: string; browser_download_url: string }[];
      };
      const arch = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
      const match =
        data.assets?.find(
          (a) =>
            a.name.includes('3.12') &&
            a.name.includes(arch) &&
            a.name.includes('install_only_stripped.tar.gz')
        ) ||
        data.assets?.find(
          (a) =>
            a.name.includes('3.12') &&
            a.name.includes(arch) &&
            a.name.includes('install_only.tar.gz')
        );
      if (match?.browser_download_url) {
        return match.browser_download_url;
      }
    }
  } catch {
    // Fall back to known stable release URL
  }
  return DEFAULT_PYTHON_TARBALL_URL;
}

export async function ensurePythonRuntime(onLog?: (msg: string) => void): Promise<string> {
  const existing = getInstalledPythonInfo();
  if (existing && existing.hasPip) {
    return existing.bin;
  }

  if (activeProvisionPromise) {
    onLog?.('[SYSTEM] Waiting for Python 3.12 runtime installation to finish...');
    return activeProvisionPromise;
  }

  activeProvisionPromise = (async () => {
    try {
      fs.mkdirSync(PYTHON_ROOT_DIR, { recursive: true });
      const tarBin = findBinaryOnPath('tar');
      if (!tarBin) {
        throw new Error('Host missing "tar" utility to extract standalone Python runtime.');
      }

      const url =
        process.arch === 'x64'
          ? DEFAULT_PYTHON_TARBALL_URL
          : await resolvePythonTarballUrl();

      onLog?.('[SYSTEM] Installing standalone Python 3.12 + pip runtime (~33 MB)...');
      const archivePath = path.join(RUNTIME_BASE_DIR, 'python312.tar.gz');

      let res = await fetch(url, { headers: { 'User-Agent': 'facon-host-runner' } });
      if (!res.ok) {
        const latestUrl = await resolvePythonTarballUrl();
        res = await fetch(latestUrl, { headers: { 'User-Agent': 'facon-host-runner' } });
      }
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download Python runtime (HTTP ${res.status}).`);
      }

      const fileStream = fs.createWriteStream(archivePath);
      await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), fileStream);

      onLog?.('[SYSTEM] Extracting Python 3.12 runtime...');
      const extractRes = spawnSync(tarBin, ['-xzf', archivePath, '-C', PYTHON_ROOT_DIR], {
        encoding: 'utf8',
      });
      try {
        fs.unlinkSync(archivePath);
      } catch {
        // ignore cleanup failure
      }

      if (extractRes.status !== 0) {
        throw new Error(`tar extraction failed: ${extractRes.stderr || extractRes.stdout}`);
      }

      if (!fs.existsSync(STANDALONE_PYTHON_BIN)) {
        throw new Error('Standalone Python binary not found after extraction.');
      }

      const check = spawnSync(STANDALONE_PYTHON_BIN, ['--version'], { encoding: 'utf8' });
      if (check.status !== 0) {
        throw new Error(`Python verification failed: ${check.stderr || check.stdout}`);
      }

      onLog?.(`[SYSTEM] Ready: ${(check.stdout || check.stderr).trim()} with pip & SSL.`);
      return STANDALONE_PYTHON_BIN;
    } finally {
      activeProvisionPromise = null;
    }
  })();

  return activeProvisionPromise;
}

function detectImplicitPythonPackages(workspaceDir: string): string[] {
  const detected = new Set<string>();
  let scanned = 0;

  const walk = (dir: string) => {
    if (scanned >= 40) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.pydeps' || ent.name.startsWith('__')) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.py')) {
        scanned += 1;
        try {
          const src = fs.readFileSync(full, 'utf8');
          if (/^\s*(import|from)\s+discord\b/m.test(src)) detected.add('discord.py>=2.4.0');
          if (/^\s*(import|from)\s+dotenv\b/m.test(src)) detected.add('python-dotenv>=1.0.1');
          if (/^\s*(import|from)\s+aiohttp\b/m.test(src)) detected.add('aiohttp>=3.10.0');
          if (/^\s*(import|from)\s+requests\b/m.test(src)) detected.add('requests>=2.32.0');
          if (/^\s*(import|from)\s+colorama\b/m.test(src)) detected.add('colorama>=0.4.6');
        } catch {
          // ignore unreadable file
        }
      }
    }
  };

  walk(workspaceDir);
  return Array.from(detected);
}

export async function ensureWorkspacePythonDeps(
  pythonBin: string,
  workspaceDir: string,
  onLog: (level: 'system' | 'stdout' | 'stderr', msg: string) => void
): Promise<string> {
  const depsDir = path.join(workspaceDir, '.pydeps');
  const reqFile = path.join(workspaceDir, 'requirements.txt');
  const hashFile = path.join(depsDir, '.req_hash');

  let packages: string[] = [];
  let effectiveSpec = '';

  if (fs.existsSync(reqFile)) {
    const rawReq = fs.readFileSync(reqFile, 'utf8');
    effectiveSpec = rawReq.trim();
    if (effectiveSpec) {
      packages = ['-r', reqFile];
    }
  } else {
    const implicit = detectImplicitPythonPackages(workspaceDir);
    if (implicit.length > 0) {
      effectiveSpec = implicit.sort().join('\n');
      packages = implicit;
    }
  }

  if (packages.length === 0) {
    return depsDir;
  }

  const targetHash = crypto.createHash('sha256').update(effectiveSpec).digest('hex');
  if (fs.existsSync(hashFile)) {
    try {
      const existingHash = fs.readFileSync(hashFile, 'utf8').trim();
      if (existingHash === targetHash) {
        return depsDir;
      }
    } catch {
      // re-install if unreadable
    }
  }

  const pipCacheDir = path.join(RUNTIME_BASE_DIR, 'pip-cache');
  fs.mkdirSync(pipCacheDir, { recursive: true });
  fs.mkdirSync(depsDir, { recursive: true });
  onLog(
    'system',
    fs.existsSync(reqFile)
      ? 'Installing Python packages from requirements.txt...'
      : `Installing detected Python packages (${packages.join(', ')})...`
  );

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-m',
      'pip',
      'install',
      '--cache-dir',
      pipCacheDir,
      '--prefer-binary',
      '--disable-pip-version-check',
      '--root-user-action=ignore',
      '--upgrade',
      '--target',
      depsDir,
      ...packages,
    ];

    const pipChild = spawn(pythonBin, args, {
      cwd: workspaceDir,
      env: {
        PATH: `${path.dirname(pythonBin)}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        HOME: workspaceDir,
        PIP_CACHE_DIR: pipCacheDir,
        PYTHONUNBUFFERED: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    pipChild.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) onLog('stdout', l);
      }
    });

    pipChild.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) onLog('stderr', l);
      }
    });

    pipChild.on('error', (err) => reject(err));
    pipChild.once('exit', (code) => {
      if (stdoutBuf.trim()) onLog('stdout', stdoutBuf.trim());
      if (stderrBuf.trim()) onLog('stderr', stderrBuf.trim());
      if (code === 0) {
        try {
          fs.writeFileSync(hashFile, targetHash, 'utf8');
        } catch {
          // ignore
        }
        onLog('system', 'Python dependencies installed cleanly.');
        resolve();
      } else {
        reject(new Error(`pip install exited with code ${code ?? 1}`));
      }
    });
  });

  return depsDir;
}
