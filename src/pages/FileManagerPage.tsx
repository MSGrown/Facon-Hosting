import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  CornerLeftUp,
  Download,
  FileCode2,
  FilePlus2,
  Folder,
  FolderCode,
  FolderPlus,
  PackageOpen,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AppPage, BotServer, ServerFile } from '../types/hosting';
import {
  appendServerLog,
  deleteServerFile,
  saveServerFile,
  saveServerFilesBatch,
  subscribeToServerFiles,
} from '../services/hostingService';
import {
  clearCachedZipBuffer,
  decodeBytesFromFirestore,
  encodeBytesForFirestore,
  ExtractionProgress,
  getCachedZipBuffer,
  hasUtf8ReplacementCorruption,
  inspectAndPrepareZipExtraction,
  joinWorkspacePath,
  normalizeWorkspaceDir,
  setCachedZipBuffer,
  ZipInspectionResult,
} from '../utils/zipExtractor';

interface FileManagerPageProps {
  server: BotServer | null;
  onNavigate: (page: AppPage) => void;
}

interface VisibleItem {
  key: string;
  name: string;
  path: string;
  isDirectory: boolean;
  fileDoc?: ServerFile;
  sizeBytes: number;
}

interface NoticeBanner {
  type: 'success' | 'error' | 'info';
  title: string;
  detail?: string;
}

function isZipFilename(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileManagerPage({ server, onNavigate }: FileManagerPageProps) {
  const [files, setFiles] = useState<ServerFile[]>([]);
  const [currentDir, setCurrentDir] = useState<string>('/');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [newFileName, setNewFileName] = useState('');
  const [showNewModal, setShowNewModal] = useState<'file' | 'folder' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<NoticeBanner | null>(null);

  // ZIP extraction state
  const [recentUploadedZip, setRecentUploadedZip] = useState<ServerFile | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractionTargetName, setExtractionTargetName] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    zipName: string;
    targetDir: string;
    inspection: ZipInspectionResult;
  } | null>(null);
  const [reselectPromptZip, setReselectPromptZip] = useState<ServerFile | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reselectInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCurrentDir('/');
    setSelectedId(null);
    setRecentUploadedZip(null);
    setNotice(null);
    if (!server) {
      setFiles([]);
      return;
    }
    const unsub = subscribeToServerFiles(server.id, (list) => {
      setFiles(list);
      setSelectedId((prev) => {
        if (prev && list.some((f) => f.id === prev && !f.isDirectory)) return prev;
        return list.find((f) => !f.isDirectory)?.id || null;
      });
    });
    return () => unsub();
  }, [server?.id]);

  const selectedFile = files.find((f) => f.id === selectedId) || null;

  useEffect(() => {
    if (!selectedFile || selectedFile.isDirectory || isZipFilename(selectedFile.name)) {
      setEditorContent('');
    } else {
      setEditorContent(selectedFile.content);
    }
  }, [selectedFile?.id, selectedFile?.content]);

  // Compute immediate children (folders + files) inside `currentDir`
  const visibleItems = useMemo<VisibleItem[]>(() => {
    const normDir = normalizeWorkspaceDir(currentDir);
    const prefix = normDir === '/' ? '/' : `${normDir}/`;
    const folderMap = new Map<string, VisibleItem>();
    const fileItems: VisibleItem[] = [];

    for (const docItem of files) {
      if (!docItem.path.startsWith(prefix)) continue;
      const remainder = docItem.path.slice(prefix.length);
      if (!remainder) continue;

      const slashIdx = remainder.indexOf('/');
      if (slashIdx === -1) {
        if (docItem.isDirectory) {
          folderMap.set(docItem.path, {
            key: docItem.id,
            name: docItem.name,
            path: docItem.path,
            isDirectory: true,
            fileDoc: docItem,
            sizeBytes: 0,
          });
        } else {
          fileItems.push({
            key: docItem.id,
            name: docItem.name,
            path: docItem.path,
            isDirectory: false,
            fileDoc: docItem,
            sizeBytes: docItem.sizeBytes,
          });
        }
      } else {
        const folderName = remainder.slice(0, slashIdx);
        const folderPath = joinWorkspacePath(normDir, folderName);
        if (!folderMap.has(folderPath)) {
          folderMap.set(folderPath, {
            key: `dir:${folderPath}`,
            name: folderName,
            path: folderPath,
            isDirectory: true,
            sizeBytes: 0,
          });
        }
      }
    }

    const sortedFolders = Array.from(folderMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const sortedFiles = fileItems.sort((a, b) => a.name.localeCompare(b.name));
    return [...sortedFolders, ...sortedFiles];
  }, [files, currentDir]);

  if (!server) {
    return (
      <div className="facon-glass rounded-2xl p-10 text-center flex flex-col items-center gap-4">
        <FolderCode className="w-8 h-8 text-[#00FFFF]" />
        <h1 className="font-display text-xl font-semibold text-white">No server selected</h1>
        <p className="text-sm text-zinc-400">Create or select a server to manage its files.</p>
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
  const dirSegments = currentDir === '/' ? [] : currentDir.split('/').filter(Boolean);

  const commitExtraction = async (
    zipName: string,
    targetDir: string,
    inspection: ZipInspectionResult,
    overwriteConflicts: boolean
  ) => {
    setExtracting(true);
    setExtractionTargetName(zipName);
    setPendingConflict(null);

    try {
      const entriesToWrite = overwriteConflicts
        ? inspection.entries
        : inspection.entries.filter((e) => !e.existingId);

      const skippedConflicts = overwriteConflicts ? 0 : inspection.conflicts.length;

      if (entriesToWrite.length === 0) {
        setNotice({
          type: 'info',
          title: `No new files extracted from ${zipName}`,
          detail: `Skipped ${skippedConflicts} existing file${skippedConflicts === 1 ? '' : 's'}.`,
        });
        return;
      }

      setProgress({
        phase: 'writing',
        processed: 0,
        total: entriesToWrite.length,
        currentPath: entriesToWrite[0].path,
      });

      const writtenCount = await saveServerFilesBatch(
        server.id,
        entriesToWrite,
        (written, total, currPath) => {
          setProgress({
            phase: 'writing',
            processed: written,
            total,
            currentPath: currPath,
          });
        }
      );

      await appendServerLog(
        server.id,
        'system',
        `Extracted ${zipName} into ${targetDir} (${writtenCount} entries written${
          inspection.blockedPaths.length > 0
            ? `, ${inspection.blockedPaths.length} unsafe paths blocked`
            : ''
        })`
      );

      const details: string[] = [
        `${inspection.totalFiles} file${inspection.totalFiles === 1 ? '' : 's'}`,
        `${inspection.totalFolders} folder${inspection.totalFolders === 1 ? '' : 's'}`,
      ];
      if (skippedConflicts > 0) details.push(`${skippedConflicts} skipped`);
      if (inspection.blockedPaths.length > 0) {
        details.push(`${inspection.blockedPaths.length} unsafe ZIP Slip path(s) blocked`);
      }
      if (inspection.damagedEntries.length > 0) {
        details.push(`${inspection.damagedEntries.length} damaged entry(s) skipped`);
      }
      if (inspection.truncatedFiles.length > 0) {
        details.push(`${inspection.truncatedFiles.length} oversized text file(s) truncated to 64 KB`);
      }

      setNotice({
        type: inspection.damagedEntries.length > 0 ? 'info' : 'success',
        title: `Extracted ${zipName} into ${targetDir}`,
        detail: details.join(' · '),
      });
      setRecentUploadedZip(null);
    } catch (err) {
      setNotice({
        type: 'error',
        title: `Failed to extract ${zipName}`,
        detail: err instanceof Error ? err.message : 'Unexpected extraction error.',
      });
    } finally {
      setExtracting(false);
      setExtractionTargetName(null);
      setProgress(null);
    }
  };

  const runZipExtractionFromBuffer = async (
    zipName: string,
    targetDir: string,
    buffer: ArrayBuffer | Uint8Array
  ) => {
    setExtracting(true);
    setExtractionTargetName(zipName);
    setNotice(null);
    setProgress({
      phase: 'reading',
      processed: 0,
      total: 1,
      currentPath: zipName,
    });

    try {
      const inspection = await inspectAndPrepareZipExtraction(
        buffer,
        targetDir,
        files,
        (prog) => setProgress(prog)
      );

      if (inspection.entries.length === 0) {
        setExtracting(false);
        setProgress(null);
        setNotice({
          type: inspection.blockedPaths.length > 0 ? 'error' : 'info',
          title:
            inspection.blockedPaths.length > 0
              ? `Blocked unsafe entries in ${zipName}`
              : `${zipName} contains no extractable files`,
          detail:
            inspection.blockedPaths.length > 0
              ? `Rejected ${inspection.blockedPaths.length} path traversal attempt(s).`
              : undefined,
        });
        return;
      }

      // Ask user before overwriting any existing files
      if (inspection.conflicts.length > 0) {
        setExtracting(false);
        setProgress(null);
        setPendingConflict({ zipName, targetDir, inspection });
        return;
      }

      await commitExtraction(zipName, targetDir, inspection, false);
    } catch (err) {
      setExtracting(false);
      setExtractionTargetName(null);
      setProgress(null);
      setNotice({
        type: 'error',
        title: `Unable to extract ${zipName}`,
        detail: err instanceof Error ? err.message : 'Corrupted or unsupported ZIP archive.',
      });
    }
  };

  const handleExtractServerZip = async (zipFile: ServerFile) => {
    if (isSuspended || extracting) return;

    // 1. Check in-memory session cache (supports large ZIPs > 46 KB)
    const cached = getCachedZipBuffer(server.id, zipFile.path);
    if (cached) {
      await runZipExtractionFromBuffer(zipFile.name, currentDir, cached);
      return;
    }

    // 2. Check Firestore base64 payload (persists across reloads for <= 46 KB ZIPs)
    const decoded = decodeBytesFromFirestore(zipFile.content);
    if (decoded) {
      await runZipExtractionFromBuffer(zipFile.name, currentDir, decoded);
      return;
    }

    // 3. Large ZIP after page reload (or legacy pre-update text-encoded ZIP): prompt user to select the archive file once
    setReselectPromptZip(zipFile);
  };

  const handleSaveEditor = async () => {
    if (!selectedFile || selectedFile.isDirectory || isSuspended) return;
    setSaving(true);
    try {
      await saveServerFile(server.id, {
        id: selectedFile.id,
        name: selectedFile.name,
        path: selectedFile.path,
        mimeType: selectedFile.mimeType,
        content: editorContent,
      });
      setNotice({ type: 'success', title: `Saved ${selectedFile.path}` });
    } catch (err) {
      setNotice({
        type: 'error',
        title: `Failed to save ${selectedFile.path}`,
        detail: err instanceof Error ? err.message : 'Write failed.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || isSuspended) return;
    setUploading(true);
    setNotice(null);
    setRecentUploadedZip(null);

    try {
      let uploadedCount = 0;
      let lastZipDoc: ServerFile | null = null;

      for (const f of Array.from(fileList)) {
        const safeName = f.name.slice(0, 120);
        const targetPath = joinWorkspacePath(currentDir, safeName);
        if (targetPath.length > 256) {
          throw new Error(`Path "${targetPath}" exceeds 256 character limit.`);
        }

        const existing = files.find((item) => item.path === targetPath);

        if (isZipFilename(safeName)) {
          const buffer = await f.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          setCachedZipBuffer(server.id, targetPath, buffer);

          const encoded = encodeBytesForFirestore(bytes);
          const storedContent =
            encoded ?? `[FACON ZIP Archive: ${safeName} · ${formatBytes(f.size)}]`;

          const newId = await saveServerFile(server.id, {
            id: existing?.id,
            name: safeName,
            path: targetPath,
            mimeType: 'application/zip',
            content: storedContent,
            sizeBytes: f.size,
          });

          setSelectedId(newId);
          lastZipDoc = {
            id: newId,
            name: safeName,
            path: targetPath,
            mimeType: 'application/zip',
            content: storedContent,
            sizeBytes: f.size,
            isDirectory: false,
          };
        } else {
          const text = await f.text();
          const newId = await saveServerFile(server.id, {
            id: existing?.id,
            name: safeName,
            path: targetPath,
            mimeType: f.type || 'text/plain',
            content: text.slice(0, 65536),
          });
          setSelectedId(newId);
        }
        uploadedCount += 1;
      }

      let mangledZipUploaded: string | null = null;
      if (lastZipDoc) {
        const uploadedBytes = getCachedZipBuffer(server.id, lastZipDoc.path);
        if (uploadedBytes && hasUtf8ReplacementCorruption(new Uint8Array(uploadedBytes))) {
          mangledZipUploaded = lastZipDoc.name;
        } else {
          setRecentUploadedZip(lastZipDoc);
        }
      }
      if (mangledZipUploaded) {
        setNotice({
          type: 'error',
          title: `Uploaded ${mangledZipUploaded}, but it already contains UTF-8 replacement bytes`,
          detail:
            'This .zip file appears to be a copy downloaded earlier when text decoding damaged binary streams. Please delete it and upload the original uncorrupted .zip file instead.',
        });
      } else {
        setNotice({
          type: 'success',
          title: `Uploaded ${uploadedCount} file${uploadedCount === 1 ? '' : 's'} into ${currentDir}`,
        });
      }
    } catch (err) {
      setNotice({
        type: 'error',
        title: 'File upload failed',
        detail: err instanceof Error ? err.message : 'Unable to upload file.',
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleReselectZipFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    const target = reselectPromptZip;
    if (!file || !target) return;

    setReselectPromptZip(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      setCachedZipBuffer(server.id, target.path, buffer);

      const encoded = encodeBytesForFirestore(bytes);
      if (encoded) {
        await saveServerFile(server.id, {
          id: target.id,
          name: target.name,
          path: target.path,
          mimeType: 'application/zip',
          content: encoded,
          sizeBytes: file.size,
        });
      }
      await runZipExtractionFromBuffer(target.name, currentDir, buffer);
    } catch (err) {
      setNotice({
        type: 'error',
        title: `Failed to read ${file.name}`,
        detail: err instanceof Error ? err.message : 'Unable to load archive.',
      });
    } finally {
      if (reselectInputRef.current) reselectInputRef.current.value = '';
    }
  };

  const handleCreateEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newFileName.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean || isSuspended || !showNewModal) return;

    const fullPath = joinWorkspacePath(currentDir, clean);
    const baseName = fullPath.split('/').pop() || clean;

    try {
      const id = await saveServerFile(server.id, {
        name: baseName,
        path: fullPath,
        mimeType: showNewModal === 'folder' ? 'inode/directory' : 'text/plain',
        content: showNewModal === 'folder' ? '' : `// ${fullPath}\n`,
        sizeBytes: showNewModal === 'folder' ? 0 : undefined,
        isDirectory: showNewModal === 'folder',
      });
      if (showNewModal === 'file') {
        setSelectedId(id);
      } else {
        setCurrentDir(fullPath);
      }
      setNewFileName('');
      setShowNewModal(null);
      setNotice({
        type: 'success',
        title: `Created ${showNewModal === 'folder' ? 'folder' : 'file'} ${fullPath}`,
      });
    } catch (err) {
      setNotice({
        type: 'error',
        title: 'Creation failed',
        detail: err instanceof Error ? err.message : 'Unable to create entry.',
      });
    }
  };

  const handleDeleteFolder = async (folderPath: string) => {
    if (isSuspended) return;
    const prefix = `${folderPath}/`;
    const targets = files.filter((f) => f.path === folderPath || f.path.startsWith(prefix));
    for (const target of targets) {
      clearCachedZipBuffer(server.id, target.path);
      await deleteServerFile(server.id, target.id);
    }
    setNotice({
      type: 'success',
      title: `Deleted folder ${folderPath}`,
      detail: `${targets.length} item${targets.length === 1 ? '' : 's'} removed.`,
    });
  };

  const handleDownload = (file: ServerFile) => {
    const isZip = isZipFilename(file.name);
    const zipBytes = isZip
      ? getCachedZipBuffer(server.id, file.path) || decodeBytesFromFirestore(file.content)
      : null;

    if (isZip && !zipBytes) {
      setNotice({
        type: 'error',
        title: `Binary download unavailable for ${file.name}`,
        detail:
          'This ZIP either exceeds the 46 KB browser persistence limit from a prior session or was uploaded before binary ZIP support. Use your original local .zip file instead.',
      });
      return;
    }

    const blob = zipBytes
      ? new Blob(
          [
            zipBytes instanceof ArrayBuffer
              ? zipBytes
              : (zipBytes.buffer.slice(
                  zipBytes.byteOffset,
                  zipBytes.byteOffset + zipBytes.byteLength
                ) as ArrayBuffer),
          ],
          { type: 'application/zip' }
        )
      : new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Header & Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            File Manager
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Upload bot code or ZIP archives, extract nested folders safely, and edit files inline.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleUploadFiles(e.target.files)}
          />
          <input
            ref={reselectInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => void handleReselectZipFile(e.target.files)}
          />
          <button
            type="button"
            disabled={isSuspended || uploading || extracting}
            onClick={() => fileInputRef.current?.click()}
            className="h-10 px-3.5 rounded-lg border border-white/15 bg-white/[0.04] text-xs font-medium text-white inline-flex items-center gap-2 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-4 h-4" />
            <span>{uploading ? 'Uploading...' : 'Upload Files / ZIP'}</span>
          </button>
          <button
            type="button"
            disabled={isSuspended}
            onClick={() => setShowNewModal('folder')}
            className="h-10 px-3.5 rounded-lg border border-white/15 bg-white/[0.04] text-xs font-medium text-white inline-flex items-center gap-2 hover:border-[#00FFFF]/50 hover:text-[#00FFFF] disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            <FolderPlus className="w-4 h-4" />
            <span>New Folder</span>
          </button>
          <button
            type="button"
            disabled={isSuspended}
            onClick={() => setShowNewModal('file')}
            className="h-10 px-3.5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>New File</span>
          </button>
        </div>
      </div>

      {/* Extraction Progress Bar */}
      {extracting && progress && (
        <div className="facon-glass rounded-xl p-4 border border-[#00FFFF]/40 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-white truncate">
              {progress.phase === 'reading' ? 'Inspecting archive' : 'Extracting files'}:{' '}
              <span className="text-[#00FFFF] font-mono">{extractionTargetName}</span>
            </span>
            <span className="font-mono text-[#00FFFF] tabular-nums shrink-0">
              {progressPct}% ({progress.processed}/{progress.total})
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-white/[0.08] overflow-hidden">
            <div
              className="h-full rounded-full bg-[#00FFFF] transition-all duration-150"
              style={{ width: `${Math.max(4, progressPct)}%` }}
            />
          </div>
          <p className="font-mono text-[11px] text-zinc-400 truncate">
            {progress.currentPath}
          </p>
        </div>
      )}

      {/* Instant Extract Prompt after ZIP Upload */}
      {recentUploadedZip && !extracting && (
        <div className="rounded-xl border border-[#00FFFF]/40 bg-[#00FFFF]/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Archive className="w-4 h-4 text-[#00FFFF] shrink-0" />
            <p className="text-xs text-zinc-100 break-words">
              Uploaded <span className="font-mono text-[#00FFFF]">{recentUploadedZip.name}</span>{' '}
              ({formatBytes(recentUploadedZip.sizeBytes)}) into{' '}
              <span className="font-mono text-white">{currentDir}</span>. Extract contents directly here?
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setRecentUploadedZip(null)}
              className="h-8 px-3 rounded-lg border border-white/15 text-xs text-zinc-300 hover:text-white cursor-pointer"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => void handleExtractServerZip(recentUploadedZip)}
              className="h-8 px-3.5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[#66FFFF] cursor-pointer"
            >
              <PackageOpen className="w-3.5 h-3.5" />
              <span>Extract Here</span>
            </button>
          </div>
        </div>
      )}

      {/* Status Notification Banner */}
      {notice && (
        <div
          className={`rounded-xl border px-4 py-3 flex items-start justify-between gap-3 text-xs ${
            notice.type === 'error'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : notice.type === 'info'
              ? 'border-amber-400/35 bg-amber-400/10 text-amber-200'
              : 'border-[#00FFFF]/35 bg-[#00FFFF]/10 text-[#00FFFF]'
          }`}
        >
          <div className="min-w-0 break-words [overflow-wrap:anywhere]">
            <p className="font-medium">{notice.title}</p>
            {notice.detail && <p className="opacity-85 mt-0.5">{notice.detail}</p>}
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-current opacity-70 hover:opacity-100 shrink-0 cursor-pointer"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleUploadFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed px-5 py-4 text-center text-xs transition-colors ${
          dragOver
            ? 'border-[#00FFFF] bg-[#00FFFF]/10 text-[#00FFFF]'
            : 'border-white/15 bg-[#05080B] text-zinc-400'
        }`}
      >
        Drag and drop source files or <span className="text-[#00FFFF] font-medium">.zip</span>{' '}
        archives into <span className="font-mono text-zinc-200">{currentDir}</span>
      </div>

      {/* Directory Breadcrumb Bar */}
      <div className="facon-glass rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 overflow-x-auto">
        <div className="flex items-center gap-1.5 text-xs font-mono min-w-0">
          <button
            type="button"
            onClick={() => setCurrentDir('/')}
            className={`px-2 py-1 rounded hover:bg-white/[0.06] cursor-pointer ${
              currentDir === '/' ? 'text-[#00FFFF] font-semibold' : 'text-zinc-400'
            }`}
          >
            /root
          </button>
          {dirSegments.map((seg, idx) => {
            const segPath = `/${dirSegments.slice(0, idx + 1).join('/')}`;
            const isLast = idx === dirSegments.length - 1;
            return (
              <React.Fragment key={segPath}>
                <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                <button
                  type="button"
                  onClick={() => setCurrentDir(segPath)}
                  className={`px-2 py-1 rounded hover:bg-white/[0.06] cursor-pointer truncate ${
                    isLast ? 'text-[#00FFFF] font-semibold' : 'text-zinc-300'
                  }`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {currentDir !== '/' && (
          <button
            type="button"
            onClick={() => {
              const parent = dirSegments.slice(0, -1).join('/');
              setCurrentDir(parent ? `/${parent}` : '/');
            }}
            className="h-8 px-2.5 rounded-lg border border-white/10 text-xs text-zinc-300 hover:text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
          >
            <CornerLeftUp className="w-3.5 h-3.5" />
            <span>Up</span>
          </button>
        )}
      </div>

      {/* Split Explorer + Editor */}
      <div className="grid lg:grid-cols-12 gap-5 items-stretch">
        {/* File & Folder List */}
        <div className="lg:col-span-5 facon-glass rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-300">
              Directory Contents ({currentDir})
            </span>
            <span className="font-mono text-xs text-zinc-500 tabular-nums">
              {visibleItems.length} item{visibleItems.length === 1 ? '' : 's'}
            </span>
          </div>

          <div className="divide-y divide-white/[0.06] max-h-[480px] overflow-y-auto">
            {visibleItems.length === 0 ? (
              <p className="p-6 text-xs text-zinc-500 text-center">
                This folder is empty. Upload files, extract a ZIP archive, or create a new file.
              </p>
            ) : (
              visibleItems.map((item) => {
                if (item.isDirectory) {
                  return (
                    <div
                      key={item.key}
                      className="px-4 py-3 flex items-center justify-between gap-2 hover:bg-white/[0.03] transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => setCurrentDir(item.path)}
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <Folder className="w-4 h-4 text-[#00FFFF] shrink-0" />
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-medium text-white truncate">
                            {item.name}/
                          </p>
                          <p className="font-mono text-[11px] text-zinc-500">Folder</p>
                        </div>
                      </button>

                      <button
                        type="button"
                        disabled={isSuspended}
                        onClick={() => void handleDeleteFolder(item.path)}
                        title="Delete folder"
                        className="h-8 w-8 rounded-md inline-flex items-center justify-center text-zinc-400 hover:text-rose-400 hover:bg-white/5 disabled:opacity-35 cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                }

                const file = item.fileDoc!;
                const active = file.id === selectedFile?.id;
                const isZip = isZipFilename(file.name);

                return (
                  <div
                    key={item.key}
                    className={`px-4 py-3 flex items-center justify-between gap-2 transition-colors ${
                      active ? 'bg-[#00FFFF]/10' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(file.id)}
                      className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      {isZip ? (
                        <Archive
                          className={`w-4 h-4 shrink-0 ${active ? 'text-[#00FFFF]' : 'text-amber-300'}`}
                        />
                      ) : (
                        <FileCode2
                          className={`w-4 h-4 shrink-0 ${active ? 'text-[#00FFFF]' : 'text-zinc-500'}`}
                        />
                      )}
                      <div className="min-w-0">
                        <p
                          className={`font-mono text-xs truncate ${
                            active ? 'text-white font-medium' : 'text-zinc-300'
                          }`}
                        >
                          {file.name}
                        </p>
                        <p className="font-mono text-[11px] text-zinc-500 tabular-nums">
                          {formatBytes(file.sizeBytes)}
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      {isZip && (
                        <button
                          type="button"
                          disabled={isSuspended || extracting}
                          onClick={() => void handleExtractServerZip(file)}
                          title="Extract ZIP into current directory"
                          className="h-8 px-2.5 rounded-md border border-[#00FFFF]/40 bg-[#00FFFF]/10 text-[#00FFFF] text-[11px] font-semibold inline-flex items-center gap-1 hover:bg-[#00FFFF] hover:text-black disabled:opacity-40 transition-colors cursor-pointer"
                        >
                          <PackageOpen className="w-3.5 h-3.5" />
                          <span>Extract</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDownload(file)}
                        title="Download file"
                        className="h-8 w-8 rounded-md inline-flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={isSuspended}
                        onClick={async () => {
                          clearCachedZipBuffer(server.id, file.path);
                          await deleteServerFile(server.id, file.id);
                          setNotice({ type: 'success', title: `Deleted ${file.path}` });
                        }}
                        title="Delete file"
                        className="h-8 w-8 rounded-md inline-flex items-center justify-center text-zinc-400 hover:text-rose-400 hover:bg-white/5 disabled:opacity-35 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Code Editor or ZIP Archive Inspector */}
        <div className="lg:col-span-7 facon-glass rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-white/[0.08] flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-zinc-200 truncate">
              {selectedFile ? selectedFile.path : 'Select a file to edit'}
            </span>
            {selectedFile && isZipFilename(selectedFile.name) ? (
              <button
                type="button"
                disabled={isSuspended || extracting}
                onClick={() => void handleExtractServerZip(selectedFile)}
                className="h-8 px-3.5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer shrink-0"
              >
                <PackageOpen className="w-3.5 h-3.5" />
                <span>Extract to {currentDir}</span>
              </button>
            ) : (
              selectedFile && (
                <button
                  type="button"
                  disabled={saving || isSuspended}
                  onClick={handleSaveEditor}
                  className="h-8 px-3.5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer shrink-0"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{saving ? 'Saving...' : 'Save Changes'}</span>
                </button>
              )
            )}
          </div>

          {selectedFile && isZipFilename(selectedFile.name) ? (
            <div className="flex-1 min-h-[420px] p-6 sm:p-8 bg-[#040608] flex flex-col items-center justify-center text-center gap-4">
              <div className="w-12 h-12 rounded-xl border border-[#00FFFF]/35 bg-[#00FFFF]/10 flex items-center justify-center text-[#00FFFF]">
                <Archive className="w-6 h-6" />
              </div>
              <div>
                <h2 className="font-display text-lg font-semibold text-white">
                  {selectedFile.name}
                </h2>
                <p className="font-mono text-xs text-zinc-400 mt-1 tabular-nums">
                  Archive size: {formatBytes(selectedFile.sizeBytes)} · Target: {currentDir}
                </p>
              </div>
              <p className="text-xs text-zinc-400 max-w-md leading-relaxed">
                Extracts nested folders and files directly into{' '}
                <span className="font-mono text-zinc-200">{currentDir}</span> with ZIP Slip
                traversal validation and overwrite confirmation.
              </p>
              <button
                type="button"
                disabled={isSuspended || extracting}
                onClick={() => void handleExtractServerZip(selectedFile)}
                className="h-10 px-5 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#66FFFF] disabled:opacity-40 cursor-pointer"
              >
                <PackageOpen className="w-4 h-4" />
                <span>Extract Archive Here</span>
              </button>
            </div>
          ) : selectedFile ? (
            <textarea
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-[420px] w-full p-4 bg-[#040608] font-mono text-xs text-zinc-100 leading-6 focus:outline-none resize-none"
            />
          ) : (
            <div className="flex-1 min-h-[420px] flex items-center justify-center text-xs text-zinc-500 p-6 text-center">
              Select a file on the left to inspect or edit its contents.
            </div>
          )}
        </div>
      </div>

      {/* Create New File / Folder Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateEntry}
            className="facon-glass rounded-2xl max-w-md w-full p-6 flex flex-col gap-4"
          >
            <h2 className="font-display text-lg font-semibold text-white">
              {showNewModal === 'folder' ? 'Create Folder' : 'Create Workspace File'}
            </h2>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">
                {showNewModal === 'folder' ? 'Folder Name' : 'File Path'} (inside {currentDir})
              </label>
              <input
                type="text"
                required
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder={showNewModal === 'folder' ? 'e.g. cogs' : 'e.g. commands.py'}
                className="w-full h-10 px-3.5 rounded-lg bg-[#05080B] border border-white/10 font-mono text-xs text-white focus:outline-none focus:border-[#00FFFF]/60"
              />
            </div>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowNewModal(null);
                  setNewFileName('');
                }}
                className="h-9 px-4 rounded-lg border border-white/15 text-xs text-zinc-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] cursor-pointer"
              >
                {showNewModal === 'folder' ? 'Create Folder' : 'Create File'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Overwrite Confirmation Modal */}
      {pendingConflict && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="facon-glass rounded-2xl max-w-lg w-full p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-amber-300">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h2 className="font-display text-lg font-semibold text-white">
                Confirm File Overwrite
              </h2>
            </div>

            <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
              Extracting <span className="font-mono text-[#00FFFF]">{pendingConflict.zipName}</span>{' '}
              into <span className="font-mono text-white">{pendingConflict.targetDir}</span> will
              collide with{' '}
              <span className="font-mono text-amber-300 font-semibold">
                {pendingConflict.inspection.conflicts.length}
              </span>{' '}
              existing file{pendingConflict.inspection.conflicts.length === 1 ? '' : 's'}:
            </p>

            <div className="rounded-xl border border-white/10 bg-[#05080B] p-3 max-h-40 overflow-y-auto font-mono text-xs text-zinc-300 space-y-1">
              {pendingConflict.inspection.conflicts.slice(0, 10).map((c) => (
                <div key={c.path} className="truncate">
                  {c.path}
                </div>
              ))}
              {pendingConflict.inspection.conflicts.length > 10 && (
                <div className="text-zinc-500">
                  +{pendingConflict.inspection.conflicts.length - 10} more existing file(s)
                </div>
              )}
            </div>

            {pendingConflict.inspection.blockedPaths.length > 0 && (
              <p className="text-xs text-amber-300 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>
                  Blocked {pendingConflict.inspection.blockedPaths.length} unsafe ZIP Slip path(s).
                </span>
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setPendingConflict(null)}
                className="h-9 px-4 rounded-lg border border-white/15 text-xs text-zinc-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  void commitExtraction(
                    pendingConflict.zipName,
                    pendingConflict.targetDir,
                    pendingConflict.inspection,
                    false
                  )
                }
                className="h-9 px-4 rounded-lg border border-[#00FFFF]/40 text-xs font-medium text-[#00FFFF] hover:bg-[#00FFFF]/10 cursor-pointer"
              >
                Skip Existing
              </button>
              <button
                type="button"
                onClick={() =>
                  void commitExtraction(
                    pendingConflict.zipName,
                    pendingConflict.targetDir,
                    pendingConflict.inspection,
                    true
                  )
                }
                className="h-9 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] cursor-pointer"
              >
                Overwrite All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-select Archive Prompt (for large >46KB ZIPs after reload or pre-update uploads) */}
      {reselectPromptZip && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="facon-glass rounded-2xl max-w-md w-full p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-[#00FFFF]">
              <Archive className="w-5 h-5 shrink-0" />
              <h2 className="font-display text-lg font-semibold text-white">
                Select Archive Source
              </h2>
            </div>
            <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
              The binary stream for{' '}
              <span className="font-mono text-[#00FFFF]">{reselectPromptZip.name}</span> is not in
              active browser memory (large archives &gt;46 KB or earlier uploads require local
              binary selection). Select the `.zip` file from your device to extract it directly
              into <span className="font-mono text-white">{currentDir}</span>.
            </p>
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setReselectPromptZip(null)}
                className="h-9 px-4 rounded-lg border border-white/15 text-xs text-zinc-300 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => reselectInputRef.current?.click()}
                className="h-9 px-4 rounded-lg bg-[#00FFFF] text-black text-xs font-semibold hover:bg-[#66FFFF] cursor-pointer"
              >
                Choose {reselectPromptZip.name}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
