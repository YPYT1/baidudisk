import type { DiskAdapter, Entry, ScanProgress, SpaceNode } from "./types";
import { requestGate, runQueue } from "./scheduler";

export interface ScanOptions {
  signal?: AbortSignal;
  delayMs?: number;
  concurrency?: number;
  onProgress?: (progress: ScanProgress) => void;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("扫描已停止", "AbortError");
}
function validateSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("文件大小无效，不能完成统计。");
  return size;
}
function addSafe(left: number, right: number): number {
  return validateSize(left + right);
}
export function createNode(entry: Entry): SpaceNode {
  return {
    ...entry,
    size: entry.isDirectory ? 0 : validateSize(entry.size),
    status: entry.isDirectory ? "unscanned" : "complete",
    children: [],
    listed: !entry.isDirectory,
    fileCount: entry.isDirectory ? 0 : 1,
    directoryCount: 0,
  };
}
export function createRoot(path = "/"): SpaceNode {
  const normalized = path === "/" ? "/" : path.replace(/\/$/, "");
  return createNode({ id: normalized, name: normalized === "/" ? "我的网盘" : normalized.split("/").at(-1)!, path: normalized, isDirectory: true, size: 0 });
}
export function refreshTotals(node: SpaceNode): void {
  if (!node.isDirectory) {
    validateSize(node.size);
    node.fileCount = 1;
    node.directoryCount = 0;
    return;
  }
  let size = 0, files = 0, directories = 0;
  for (const child of node.children) {
    refreshTotals(child);
    size = addSafe(size, child.size);
    files += child.fileCount;
    directories += child.directoryCount + Number(child.isDirectory);
  }
  node.size = size;
  node.fileCount = files;
  node.directoryCount = directories;
  if (node.status === "scanning") return;
  if (node.error) node.status = node.children.length || node.listed ? "partial" : "error";
  else if (node.listed && node.children.every(child => child.status === "complete")) node.status = "complete";
  else if (node.listed || node.children.length) node.status = "partial";
  else node.status = "unscanned";
}
async function interruptible<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("扫描已停止", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
/** Listing alone never claims to know the size of an unscanned child folder. */
export async function listDirectory(
  node: SpaceNode,
  adapter: DiskAdapter,
  signal?: AbortSignal,
  onRequest?: () => void | Promise<void>,
): Promise<void> {
  checkAbort(signal);
  if (!node.isDirectory) throw new Error("只能读取文件夹。");
  const previous = new Map(node.children.map(child => [child.path, child]));
  const entries = new Map<string, SpaceNode>();
  const pages = new Set<string>();
  const prefix = node.path === "/" ? "/" : node.path + "/";
  node.status = "scanning";
  node.listed = false;
  node.children = [];
  delete node.error;
  delete node.scannedAt;
  try {
    for (let page = 1; page <= 100_000; page++) {
      checkAbort(signal);
      await onRequest?.();
      checkAbort(signal);
      const result = await interruptible(adapter.list(node.path, page, signal), signal);
      checkAbort(signal);
      if (!Array.isArray(result.entries) || typeof result.hasMore !== "boolean") throw new Error("目录分页结果无效。");
      const fingerprint = result.entries.map(entry => `${entry.path}\0${entry.id}\0${Number(entry.isDirectory)}\0${entry.isDirectory ? 0 : entry.size}`).sort().join("\n");
      if (pages.has(fingerprint)) throw new Error("目录接口返回重复页，已停止以防止遗漏或无限循环。");
      pages.add(fingerprint);
      let added = 0;
      for (const entry of result.entries) {
        if (!entry.path.startsWith(prefix) || !entry.path.slice(prefix.length) || entry.path.slice(prefix.length).includes("/")) throw new Error("目录接口返回了不属于当前层的条目。");
        if (!entry.isDirectory) validateSize(entry.size);
        const duplicate = entries.get(entry.path);
        if (duplicate) {
          if (duplicate.id !== entry.id || duplicate.isDirectory !== entry.isDirectory || (!entry.isDirectory && duplicate.size !== entry.size)) throw new Error("扫描期间条目信息变化，请重新扫描。");
          continue;
        }
        const old = previous.get(entry.path);
        const child = old && old.id === entry.id && old.isDirectory === entry.isDirectory && (entry.isDirectory || old.size === entry.size) ? old : createNode(entry);
        child.name = entry.name;
        entries.set(entry.path, child);
        added++;
      }
      node.children = [...entries.values()];
      refreshTotals(node);
      if (!result.hasMore) {
        node.listed = true;
        node.status = "partial";
        node.scannedAt = new Date().toISOString();
        refreshTotals(node);
        return;
      }
      if (!added) throw new Error("目录分页没有新条目，统计未完成。");
    }
    throw new Error("目录分页超过安全上限，统计未完成。");
  } catch (error) {
    node.children = [...entries.values()];
    node.error = error instanceof Error ? error.message : "目录读取失败";
    node.status = "partial";
    refreshTotals(node);
    throw error;
  }
}
/** Bounded concurrent traversal; pages stay serial and individual failures retain verified results. */
export async function scanDirectory(node: SpaceNode, adapter: DiskAdapter, options: ScanOptions = {}): Promise<ScanProgress> {
  const signal = options.signal;
  checkAbort(signal);
  const gate = requestGate(options.delayMs ?? 120);
  const progress: ScanProgress = { directoriesRead: 0, filesFound: 0, requests: 0, currentPath: node.path };
  const visited = new Set<string>();
  let totalsAt = -Infinity;
  const report = () => options.onProgress?.({ ...progress });
  const updateTotals = (force = false) => {
    if (force || performance.now() - totalsAt >= 200) {
      refreshTotals(node);
      totalsAt = performance.now();
    }
  };
  try {
    await runQueue([node], async (directory, jobSignal) => {
      checkAbort(jobSignal);
      if (visited.has(directory.path)) throw new Error("目录树出现重复路径，统计未完成。");
      visited.add(directory.path);
      progress.currentPath = directory.path;
      report();
      try {
        await listDirectory(directory, adapter, jobSignal, async () => {
          await gate(jobSignal);
          checkAbort(jobSignal);
          progress.requests++;
          report();
        });
        checkAbort(jobSignal);
        progress.directoriesRead++;
      } catch (error) {
        if (jobSignal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        // listDirectory retains verified pages and explicitly marks failed directories.
      }
      progress.filesFound += directory.children.filter(child => !child.isDirectory).length;
      updateTotals();
      report();
      return directory.children.filter(child => child.isDirectory);
    }, { signal, concurrency: options.concurrency ?? 3 });
    updateTotals(true);
    if (node.status === "complete") node.scannedAt = new Date().toISOString();
    report();
    return { ...progress };
  } catch (error) {
    node.error = signal?.aborted ? "扫描已停止，结果不完整。" : error instanceof Error ? error.message : "扫描未完成。";
    node.status = "partial";
    updateTotals(true);
    report();
    throw error;
  }
}
