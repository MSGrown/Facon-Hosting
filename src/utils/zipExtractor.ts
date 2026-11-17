import JSZip from 'jszip';
import { Inflate, inflateSync, unzipSync } from 'fflate';
import { ServerFile } from '../types/hosting';

export const ZIP_B64_PREFIX = '__FACON_ZIP_B64__:';
export const MAX_FIRESTORE_B64_BYTES = 46000;
export const MAX_ZIP_FILE_COUNT = 500;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB safety cap
export const MAX_TEXT_CONTENT_CHARS = 65536;

// Session cache for large ZIP files (> 46 KB) that exceed a single Firestore document text field
const zipBufferCache = new Map<string, ArrayBuffer>();

export function setCachedZipBuffer(serverId: string, path: string, buffer: ArrayBuffer): void {
  zipBufferCache.set(`${serverId}:${path}`, buffer);
}

export function getCachedZipBuffer(serverId: string, path: string): ArrayBuffer | undefined {
  return zipBufferCache.get(`${serverId}:${path}`);
}

export function clearCachedZipBuffer(serverId: string, path: string): void {
  zipBufferCache.delete(`${serverId}:${path}`);
}

export function encodeBytesForFirestore(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_FIRESTORE_B64_BYTES) {
    return null;
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return `${ZIP_B64_PREFIX}${btoa(binary)}`;
}

export function decodeBytesFromFirestore(content: string): Uint8Array | null {
  if (!content.startsWith(ZIP_B64_PREFIX)) {
    return null;
  }
  try {
    const b64 = content.slice(ZIP_B64_PREFIX.length);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function normalizeWorkspaceDir(dir: string): string {
  const cleaned = dir.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!cleaned || cleaned === '/') return '/';
  const withoutTrailing = cleaned.replace(/\/+$/, '');
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`;
}

export function joinWorkspacePath(baseDir: string, relativePath: string): string {
  const normBase = normalizeWorkspaceDir(baseDir);
  const normRel = relativePath.replace(/^\/+/, '');
  if (!normRel) return normBase;
  return normBase === '/' ? `/${normRel}` : `${normBase}/${normRel}`;
}

/**
 * Prevents ZIP Slip path traversal attacks by rejecting null bytes, drive letters,
 * parent directory references (`..`), and paths escaping the target directory.
 */
export function sanitizeZipEntryPath(rawEntryName: string): string | null {
  if (!rawEntryName || rawEntryName.includes('\0')) return null;

  if (/^[a-zA-Z]:/.test(rawEntryName) || rawEntryName.startsWith('\\\\')) {
    return null;
  }

  const slashNormalized = rawEntryName.replace(/\\/g, '/').trim();
  if (slashNormalized.startsWith('/')) {
    return null;
  }

  const rawSegments = slashNormalized.split('/');
  const cleanSegments: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      return null;
    }
    if (/[\x00-\x1f\x7f]/.test(seg)) {
      return null;
    }
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) return null;

  if (cleanSegments[0] === '__MACOSX') {
    return null;
  }

  const safeRelative = cleanSegments.join('/');
  if (safeRelative.length > 240) return null;
  const baseName = cleanSegments[cleanSegments.length - 1];
  if (baseName.length > 120) return null;

  return safeRelative;
}

const TEXT_EXTENSIONS = new Set([
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'example', 'gitignore', 'dockerignore',
  'java', 'kt', 'go', 'mod', 'sum', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'sh', 'bash', 'zsh', 'bat', 'ps1', 'html', 'htm', 'css', 'scss', 'svg', 'xml',
  'sql', 'csv', 'log', 'lock', 'dockerfile', 'makefile', 'requirements',
]);

function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() || '' : lower;
  if (ext === 'py') return 'text/x-python';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'application/javascript';
  if (ext === 'ts' || ext === 'tsx') return 'text/typescript';
  if (ext === 'json') return 'application/json';
  if (ext === 'md') return 'text/markdown';
  if (ext === 'java') return 'text/x-java-source';
  if (ext === 'go') return 'text/x-go';
  if (ext === 'rs') return 'text/x-rustsrc';
  if (ext === 'c' || ext === 'h') return 'text/x-csrc';
  if (ext === 'cpp' || ext === 'hpp') return 'text/x-c++src';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  if (ext === 'css') return 'text/css';
  if (ext === 'zip') return 'application/zip';
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function isLikelyTextBytes(bytes: Uint8Array, filename: string): boolean {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() || '' : lower;
  if (TEXT_EXTENSIONS.has(ext) || lower === 'dockerfile' || lower === 'makefile') {
    return true;
  }
  const sampleLen = Math.min(bytes.length, 512);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface RawParsedEntry {
  name: string;
  isDir: boolean;
  bytes: Uint8Array;
}

function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

export function hasUtf8ReplacementCorruption(bytes: Uint8Array): boolean {
  let replacementHits = 0;
  const limit = Math.min(bytes.length - 2, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
      replacementHits += 1;
      if (replacementHits >= 3) return true;
    }
  }
  return false;
}

function detectNonZipFormatError(bytes: Uint8Array, fallbackMessage: string): string {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'This file is a GZIP (.gz / .tar.gz) archive, not a standard .zip archive.';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x72 &&
    bytes[3] === 0x21
  ) {
    return 'This file is a RAR archive renamed to .zip. Please re-compress as a standard .zip file.';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf
  ) {
    return 'This file is a 7z archive renamed to .zip. Please re-compress as a standard .zip file.';
  }

  if (hasUtf8ReplacementCorruption(bytes)) {
    return 'This .zip file is permanently damaged because binary bytes were replaced with UTF-8 replacement characters (EF BF BD)—usually from a copy downloaded before binary ZIP support. Please delete this copy and upload your original .zip file directly.';
  }

  return fallbackMessage;
}

interface RecoveryScanResult {
  entries: RawParsedEntry[];
  damagedEntries: string[];
  encryptedCount: number;
}

/**
 * Fallback Layer 3: Scans Central Directory (PK\x01\x02) and Local File Headers (PK\x03\x04)
 * directly to recover intact entries from archives with malformed End-of-Central-Directory
 * offsets or partially damaged streams.
 */
function recoverZipByScanningHeaders(bytes: Uint8Array): RecoveryScanResult {
  const results: RawParsedEntry[] = [];
  const damagedEntries: string[] = [];
  let encryptedCount = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // Collect Central Directory sizes/methods keyed by localHeaderOffset and filename
  const cdSizesByOffset = new Map<number, { compSize: number; uncompSize: number; method: number }>();
  const cdSizesByName = new Map<string, { compSize: number; uncompSize: number; method: number }>();
  let firstCdOffset = bytes.length;

  for (let i = 0; i <= bytes.length - 46; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x01 &&
      bytes[i + 3] === 0x02
    ) {
      if (i < firstCdOffset) firstCdOffset = i;
      const method = readUint16LE(bytes, i + 10);
      const compSize = readUint32LE(bytes, i + 20);
      const uncompSize = readUint32LE(bytes, i + 24);
      const fnLen = readUint16LE(bytes, i + 28);
      const exLen = readUint16LE(bytes, i + 30);
      const cmtLen = readUint16LE(bytes, i + 32);
      const localOffset = readUint32LE(bytes, i + 42);
      if (fnLen > 0 && fnLen <= 512 && i + 46 + fnLen <= bytes.length) {
        const name = decoder.decode(bytes.subarray(i + 46, i + 46 + fnLen));
        cdSizesByOffset.set(localOffset, { compSize, uncompSize, method });
        cdSizesByName.set(name, { compSize, uncompSize, method });
        i += 45 + fnLen + exLen + cmtLen;
      }
    }
  }

  // Scan all Local File Headers (PK\x03\x04)
  const localOffsets: number[] = [];
  for (let i = 0; i <= bytes.length - 30; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      const fnLen = readUint16LE(bytes, i + 26);
      const exLen = readUint16LE(bytes, i + 28);
      if (fnLen > 0 && fnLen <= 512 && i + 30 + fnLen + exLen <= bytes.length) {
        localOffsets.push(i);
      }
    }
  }

  if (localOffsets.length === 0) {
    throw new Error(
      detectNonZipFormatError(bytes, 'No valid ZIP file headers (PK) were found in this archive.')
    );
  }

  for (let idx = 0; idx < localOffsets.length; idx++) {
    const pos = localOffsets[idx];
    if (pos + 30 > bytes.length) continue;

    const flags = readUint16LE(bytes, pos + 6);
    let method = readUint16LE(bytes, pos + 8);
    let compSize = readUint32LE(bytes, pos + 18);
    const fnLen = readUint16LE(bytes, pos + 26);
    const exLen = readUint16LE(bytes, pos + 28);
    const dataStart = pos + 30 + fnLen + exLen;

    if (fnLen === 0 || dataStart > bytes.length) continue;
    const rawName = decoder.decode(bytes.subarray(pos + 30, pos + 30 + fnLen));
    const isDir = rawName.endsWith('/');

    if (isDir) {
      results.push({ name: rawName, isDir: true, bytes: new Uint8Array(0) });
      continue;
    }

    if ((flags & 0x01) !== 0) {
      encryptedCount += 1;
      damagedEntries.push(rawName);
      continue;
    }

    const cdInfo = cdSizesByOffset.get(pos) || cdSizesByName.get(rawName);
    if ((compSize === 0 || (flags & 0x08) !== 0 || dataStart + compSize > bytes.length) && cdInfo && cdInfo.compSize > 0) {
      compSize = cdInfo.compSize;
      method = cdInfo.method;
    }

    let compressedSlice: Uint8Array;
    if (compSize > 0 && dataStart + compSize <= bytes.length) {
      compressedSlice = bytes.subarray(dataStart, dataStart + compSize);
    } else {
      const nextLocal = idx + 1 < localOffsets.length ? localOffsets[idx + 1] : bytes.length;
      const boundary = firstCdOffset > dataStart ? Math.min(nextLocal, firstCdOffset) : nextLocal;
      compressedSlice = bytes.subarray(dataStart, Math.max(dataStart, boundary));
    }

    if (method === 0) {
      results.push({ name: rawName, isDir: false, bytes: compressedSlice });
    } else if (method === 8) {
      try {
        const inflated = inflateSync(compressedSlice);
        results.push({ name: rawName, isDir: false, bytes: inflated });
      } catch {
        // Streaming Inflate ignores trailing Data Descriptors (12/16/24 bytes) or extra padding
        let streamFinal = false;
        const chunks: Uint8Array[] = [];
        let streamFailed = false;
        try {
          const inflator = new Inflate((chunk, final) => {
            chunks.push(chunk);
            if (final) streamFinal = true;
          });
          inflator.push(compressedSlice, true);
        } catch {
          streamFailed = true;
        }

        if (!streamFailed && streamFinal) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(totalLen);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          results.push({ name: rawName, isDir: false, bytes: merged });
          continue;
        }

        damagedEntries.push(rawName);
      }
    } else {
      damagedEntries.push(rawName);
    }
  }

  if (results.length === 0) {
    if (encryptedCount > 0 && encryptedCount === damagedEntries.length) {
      throw new Error('Password-protected / encrypted ZIP archives are not supported. Please extract or re-zip without encryption.');
    }
    throw new Error(
      detectNonZipFormatError(
        bytes,
        damagedEntries.length > 0
          ? `Unable to decompress ${damagedEntries.length} damaged archive entr${damagedEntries.length === 1 ? 'y' : 'ies'} (${damagedEntries[0]}).`
          : 'No extractable files were found in this archive.'
      )
    );
  }

  return { entries: results, damagedEntries, encryptedCount };
}

async function parseArchiveEntries(
  bytes: Uint8Array,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<{ entries: RawParsedEntry[]; damagedEntries: string[] }> {
  // Strategy 1: JSZip
  try {
    const zip = await JSZip.loadAsync(bytes);
    const rawEntries = Object.values(zip.files);
    if (rawEntries.length > MAX_ZIP_FILE_COUNT) {
      throw new Error(
        `Archive contains ${rawEntries.length} entries, exceeding the ${MAX_ZIP_FILE_COUNT}-entry limit.`
      );
    }

    const parsed: RawParsedEntry[] = [];
    for (let i = 0; i < rawEntries.length; i++) {
      const entry = rawEntries[i];
      onProgress?.({
        phase: 'reading',
        processed: i + 1,
        total: rawEntries.length,
        currentPath: entry.name,
      });
      const entryBytes = entry.dir ? new Uint8Array(0) : await entry.async('uint8array');
      parsed.push({ name: entry.name, isDir: entry.dir, bytes: entryBytes });
      if (i % 6 === 0) await yieldToMainThread();
    }
    return { entries: parsed, damagedEntries: [] };
  } catch (jsZipErr) {
    // Strategy 2: fflate unzipSync (handles non-standard EOCD offsets JSZip rejects)
    try {
      const unzipped = unzipSync(bytes);
      const keys = Object.keys(unzipped);
      if (keys.length > MAX_ZIP_FILE_COUNT) {
        throw new Error(
          `Archive contains ${keys.length} entries, exceeding the ${MAX_ZIP_FILE_COUNT}-entry limit.`
        );
      }
      const parsed: RawParsedEntry[] = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!key || key.trim() === '') continue;
        const data = unzipped[key];
        const isDir = key.endsWith('/') && data.byteLength === 0;
        onProgress?.({
          phase: 'reading',
          processed: i + 1,
          total: keys.length,
          currentPath: key,
        });
        parsed.push({ name: key, isDir, bytes: data });
        if (i % 6 === 0) await yieldToMainThread();
      }
      if (parsed.length > 0) return { entries: parsed, damagedEntries: [] };
    } catch {
      // Proceed to Strategy 3 header recovery scanner
    }

    // Strategy 3: Direct Local File Header (PK\x03\x04) recovery scanner
    try {
      const recovered = recoverZipByScanningHeaders(bytes);
      if (recovered.entries.length > MAX_ZIP_FILE_COUNT) {
        throw new Error(
          `Archive contains ${recovered.entries.length} entries, exceeding the ${MAX_ZIP_FILE_COUNT}-entry limit.`
        );
      }
      recovered.entries.forEach((item, idx) => {
        onProgress?.({
          phase: 'reading',
          processed: idx + 1,
          total: recovered.entries.length,
          currentPath: item.name,
        });
      });
      return { entries: recovered.entries, damagedEntries: recovered.damagedEntries };
    } catch (recoveryErr) {
      const msg =
        recoveryErr instanceof Error
          ? recoveryErr.message
          : jsZipErr instanceof Error
          ? jsZipErr.message
          : 'Corrupted or unsupported ZIP archive.';
      throw new Error(detectNonZipFormatError(bytes, msg));
    }
  }
}

export interface ExtractedWorkspaceEntry {
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  content: string;
  isDirectory: boolean;
  existingId?: string;
}

export interface ZipInspectionResult {
  entries: ExtractedWorkspaceEntry[];
  conflicts: ExtractedWorkspaceEntry[];
  blockedPaths: string[];
  truncatedFiles: string[];
  damagedEntries: string[];
  totalFiles: number;
  totalFolders: number;
  totalBytes: number;
}

export interface ExtractionProgress {
  phase: 'reading' | 'writing';
  processed: number;
  total: number;
  currentPath: string;
}

export async function inspectAndPrepareZipExtraction(
  archiveData: ArrayBuffer | Uint8Array,
  targetDirectory: string,
  existingFiles: ServerFile[],
  onProgress?: (progress: ExtractionProgress) => void
): Promise<ZipInspectionResult> {
  const bytes =
    archiveData instanceof Uint8Array ? archiveData : new Uint8Array(archiveData);

  const normDir = normalizeWorkspaceDir(targetDirectory);
  const existingByPath = new Map<string, ServerFile>();
  existingFiles.forEach((f) => existingByPath.set(f.path, f));

  const { entries: parsedEntries, damagedEntries } = await parseArchiveEntries(bytes, onProgress);

  const entriesMap = new Map<string, ExtractedWorkspaceEntry>();
  const blockedPaths: string[] = [];
  const truncatedFiles: string[] = [];
  let runningBytes = 0;

  const ensureParentDirectories = (fullFilePath: string) => {
    const parts = fullFilePath.split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = `/${parts.slice(0, i + 1).join('/')}`;
      if (dirPath === normDir || dirPath.length > 256) continue;
      if (!entriesMap.has(dirPath) && !existingByPath.has(dirPath)) {
        entriesMap.set(dirPath, {
          name: parts[i].slice(0, 120),
          path: dirPath,
          sizeBytes: 0,
          mimeType: 'inode/directory',
          content: '',
          isDirectory: true,
        });
      }
    }
  };

  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    const isMacJunk = entry.name.startsWith('__MACOSX/') || entry.name === '__MACOSX';
    const safeRelative = sanitizeZipEntryPath(entry.name);

    if (!safeRelative) {
      if (!isMacJunk && entry.name.trim() !== '') {
        blockedPaths.push(entry.name);
      }
      continue;
    }

    const targetPath = joinWorkspacePath(normDir, safeRelative);
    if (
      targetPath.length > 256 ||
      (normDir !== '/' && !targetPath.startsWith(`${normDir}/`) && targetPath !== normDir)
    ) {
      blockedPaths.push(entry.name);
      continue;
    }

    if (entry.isDir) {
      ensureParentDirectories(`${targetPath}/placeholder`);
      const dirName = safeRelative.split('/').pop() || safeRelative;
      if (!existingByPath.has(targetPath)) {
        entriesMap.set(targetPath, {
          name: dirName.slice(0, 120),
          path: targetPath,
          sizeBytes: 0,
          mimeType: 'inode/directory',
          content: '',
          isDirectory: true,
        });
      }
    } else {
      runningBytes += entry.bytes.byteLength;
      if (runningBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw new Error(
          'Archive uncompressed size exceeds the 100 MB safety threshold (possible ZIP bomb).'
        );
      }

      ensureParentDirectories(targetPath);

      const fileName = safeRelative.split('/').pop() || safeRelative;
      const mimeType = guessMimeType(fileName);
      let storedContent = '';

      if (isLikelyTextBytes(entry.bytes, fileName)) {
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(entry.bytes);
        if (decoded.length > MAX_TEXT_CONTENT_CHARS) {
          storedContent = decoded.slice(0, MAX_TEXT_CONTENT_CHARS);
          truncatedFiles.push(targetPath);
        } else {
          storedContent = decoded;
        }
      } else {
        const b64 = encodeBytesForFirestore(entry.bytes);
        if (b64) {
          storedContent = b64;
        } else {
          storedContent = `[Binary asset: ${fileName} · ${entry.bytes.byteLength} bytes]`;
        }
      }

      const existing = existingByPath.get(targetPath);
      entriesMap.set(targetPath, {
        name: fileName.slice(0, 120),
        path: targetPath,
        sizeBytes: entry.bytes.byteLength,
        mimeType: mimeType.slice(0, 80),
        content: storedContent,
        isDirectory: false,
        existingId: existing?.id,
      });
    }
  }

  const allEntries = Array.from(entriesMap.values());
  const conflicts = allEntries.filter((item) => !item.isDirectory && Boolean(item.existingId));
  const totalFiles = allEntries.filter((e) => !e.isDirectory).length;
  const totalFolders = allEntries.filter((e) => e.isDirectory).length;

  return {
    entries: allEntries,
    conflicts,
    blockedPaths,
    truncatedFiles,
    damagedEntries,
    totalFiles,
    totalFolders,
    totalBytes: runningBytes,
  };
}
