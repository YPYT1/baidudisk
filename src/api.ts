import type { DiskAdapter, Entry, ListPage } from "./types";

export interface FolderSummary {
  path: string;
  size: number;
  fileCount: number;
  directoryCount: number;
  scannedAt: string;
}
export interface Quota { used: number; total: number }
type Operation = "identity" | "list" | "quota" | "summary" | "task";
interface PageRequest {
  operation: Operation;
  path?: string;
  page?: number;
  paths?: string[];
  taskId?: string;
  accountId?: string;
}
type Json = Record<string, unknown>;

// Serialized by Chrome into the already logged-in tab. Keep this function self-contained.
// Only the fixed, read-only endpoints below are reachable; no arbitrary URL or cookie access.
export async function requestInPage(input: PageRequest): Promise<{ ok: boolean; data?: Json; error?: string }> {
  try {
    if (location.origin !== "https://pan.baidu.com") throw new Error("请先打开百度网盘网页版。");
    async function request(endpoint: string, params: Record<string, string> = {}, body?: string): Promise<Json> {
      const query = new URLSearchParams({ app_id: "250528", web: "1", clienttype: "0", ...params });
      const response = await fetch(`${endpoint}?${query}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: body === undefined ? undefined : { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`网盘请求失败（HTTP ${response.status}），请稍后重试。`);
      const data = await response.json() as Json;
      if (data.errno !== 0) {
        const code = data.errno;
        if (code === -6 || code === -9) throw new Error("登录已失效，请回百度网盘网页重新登录。");
        throw new Error(`网盘接口返回错误 ${String(code)}，请稍后重试，不会将它记为 0。`);
      }
      return data;
    }
    const identity = await request("/api/gettemplatevariable", { fields: '["uk"]' });
    const accountId = String((identity.result as Json | undefined)?.uk ?? "");
    if (!accountId || accountId === "0") throw new Error("未获取到登录账户，请先在网盘网页登录。");
    if (input.accountId && input.accountId !== accountId) throw new Error("网盘已切换账户，请重新连接后再扫描。");
    let data: Json;
    switch (input.operation) {
      case "identity": data = { accountId }; break;
      case "list":
        data = await request("/api/list", { dir: input.path ?? "/", page: String(input.page ?? 1), num: "1000", order: "name", desc: "0" });
        break;
      case "quota": data = await request("/api/quota", { checkfree: "1", checkexpire: "1" }); break;
      case "summary": {
        if (!input.paths?.length || input.paths.length > 20 || input.paths.some(p => !p.startsWith("/") || p === "/")) throw new Error("统计目录列表无效。");
        // POST creates a calculation task only; it does not alter any stored file.
        const body = new URLSearchParams({ list: JSON.stringify(input.paths.map(path => ({ path }))) });
        data = await request("/api/dirsize", {}, body.toString());
        break;
      }
      case "task":
        if (!input.taskId || !/^\d+$/.test(input.taskId)) throw new Error("统计任务编号无效。");
        data = await request("/api/taskquery", { taskid: input.taskId });
        break;
      default: throw new Error("不支持的操作。");
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "请求失败，请重试。" };
  }
}

export function byteCount(value: unknown, label = "大小"): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error(`${label}字段无效，统计未完成。`);
  return number;
}
export function normalizeList(data: Json, directory: string, pageSize = 1000): ListPage {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("目录分页大小无效。");
  if (!Array.isArray(data.list)) throw new Error("目录接口未返回有效列表。");
  const prefix = directory === "/" ? "/" : directory.replace(/\/$/, "") + "/";
  const entries: Entry[] = data.list.map(value => {
    const raw = value as Json;
    if (!raw || typeof raw.path !== "string" || !raw.path.startsWith(prefix) || raw.path.slice(prefix.length).includes("/") || !raw.path.slice(prefix.length)) throw new Error("目录接口返回了不属于当前目录的条目。");
    if (raw.isdir !== 0 && raw.isdir !== 1) throw new Error("无法识别条目的文件类型。");
    return {
      id: String(raw.fs_id ?? raw.path),
      path: raw.path,
      name: typeof raw.server_filename === "string" ? raw.server_filename : raw.path.slice(prefix.length),
      isDirectory: raw.isdir === 1,
      size: raw.isdir === 1 ? 0 : byteCount(raw.size),
    };
  });
  const more = data.has_more ?? data.hasmore;
  return { entries, hasMore: more === undefined ? entries.length >= pageSize : more === true || more === 1 || more === "1" };
}
export function normalizeSummaries(data: Json, expected: string[]): FolderSummary[] {
  if (data.status !== "success" || (data.task_errno !== undefined && data.task_errno !== 0) || !Array.isArray(data.list)) throw new Error("文件夹统计任务未成功完成。");
  const wanted = new Set(expected);
  const seen = new Set<string>();
  const summaries = data.list.map(value => {
    const raw = value as Json;
    if (!raw || typeof raw.path !== "string" || !wanted.has(raw.path) || seen.has(raw.path)) throw new Error("统计任务返回了重复或不匹配的目录。");
    if (raw.errno !== undefined && raw.errno !== 0) throw new Error(`目录 ${raw.path} 统计失败。`);
    seen.add(raw.path);
    return { path: raw.path, size: byteCount(raw.size), fileCount: byteCount(raw.filenum, "文件数"), directoryCount: byteCount(raw.dirnum, "目录数"), scannedAt: new Date().toISOString() };
  });
  if (seen.size !== wanted.size) throw new Error("统计结果缺少部分目录，请重试或使用深度扫描。");
  return summaries;
}
export function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已停止扫描", "AbortError");
}
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("已停止扫描", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export class BaiduAdapter implements DiskAdapter {
  accountId = "";
  constructor(public tabId: number) {}
  async call(input: PageRequest, signal?: AbortSignal): Promise<Json> {
    abortIfNeeded(signal);
    const results = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: "MAIN", func: requestInPage, args: [{ ...input, accountId: this.accountId || undefined }] });
    abortIfNeeded(signal);
    const result = results[0]?.result;
    if (!result?.ok || !result.data) throw new Error(result?.error || "无法连接网盘标签页，请保持网页打开并重新连接。");
    return result.data;
  }
  async connect(): Promise<Quota> {
    const data = await this.call({ operation: "identity" });
    this.accountId = String(data.accountId);
    const quota = await this.call({ operation: "quota" });
    return { used: byteCount(quota.used), total: byteCount(quota.total) };
  }
  async list(path: string, page: number, signal?: AbortSignal): Promise<ListPage> {
    return normalizeList(await this.call({ operation: "list", path, page }, signal), path);
  }
  async summaries(paths: string[], signal?: AbortSignal, onPoll?: () => void): Promise<FolderSummary[]> {
    const task = await this.call({ operation: "summary", paths }, signal);
    if (!task.taskid) throw new Error("网盘未返回统计任务编号。");
    // Query immediately; increase waits only while the server is still calculating.
    const deadline = performance.now() + 120_000;
    for (let attempt = 0; attempt < 160 && performance.now() < deadline; attempt++) {
      if (attempt > 0) await wait(Math.min(attempt === 1 ? 250 : attempt === 2 ? 500 : attempt < 6 ? 1000 : 1500, Math.max(0, deadline - performance.now())), signal);
      abortIfNeeded(signal);
      if (performance.now() >= deadline) break;
      onPoll?.();
      const data = await this.call({ operation: "task", taskId: String(task.taskid) }, signal);
      if (performance.now() >= deadline) break;
      if (data.status === "running" || data.status === "pending") continue;
      return normalizeSummaries(data, paths);
    }
    throw new Error("文件夹统计超过两分钟，请稍后重试或使用深度扫描。");
  }
}
