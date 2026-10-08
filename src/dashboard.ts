import { BaiduAdapter, wait, type FolderSummary, type Quota } from "./api";
import { createRoot, listDirectory, scanDirectory } from "./scan-engine";
import { requestGate, runQueue } from "./scheduler";
import { isRecent, LIST_MAX_AGE_MS, SUMMARY_MAX_AGE_MS } from "./freshness";
import type { DiskAdapter, SavedScan, ScanProgress, SpaceNode, ScanStatus } from "./types";
import { colorForKey, extensionOf, groupFileTypes, layoutTreemap, selectEntries, type EntryKind, type SortDirection, type SortKey } from "./view-model";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const extension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
let root: SpaceNode = createRoot();
let current = root;
let adapter: DiskAdapter | undefined;
let live: BaiduAdapter | undefined;
let summaries = new Map<string, FolderSummary>();
let errors = new Map<string, string>();
let quota: Quota | undefined;
let demo = false;
let busy = false;
let largeFiles = false;
let controller: AbortController | undefined;
let savedAt = "";
let progressText = "";
let renderAt = 0;
let selectedPath = "";
let typeFilter = "";
const expandedPaths = new Set<string>(["/"]);
interface Metrics { size: number; files: number; dirs: number; complete: boolean; known: boolean; source: string }
interface Snapshot extends SavedScan { summaries: FolderSummary[] }
const labels: Record<ScanStatus, string> = { unscanned: "未统计", scanning: "统计中", complete: "已完成", partial: "部分完成", error: "失败，可重试" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (node instanceof HTMLButtonElement) node.type = "button";
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function formatSize(value: number): string {
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const level = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** level).toLocaleString("zh-CN", { maximumFractionDigits: level ? 2 : 0 })} ${units[level]}`;
}
let metricCache = new WeakMap<SpaceNode, Metrics>();
function metrics(node: SpaceNode): Metrics {
  const cached = metricCache.get(node);
  if (cached) return cached;
  const value = computeMetrics(node);
  metricCache.set(node, value);
  return value;
}
function computeMetrics(node: SpaceNode): Metrics {
  if (!node.isDirectory) return { size: node.size, files: 1, dirs: 0, complete: true, known: true, source: "文件大小" };
  const summary = summaries.get(node.path);
  if (summary) return { size: summary.size, files: summary.fileCount, dirs: summary.directoryCount, complete: true, known: true, source: demo ? "演示数据" : `官方统计 · ${new Date(summary.scannedAt).toLocaleString("zh-CN")}` };
  if (!node.listed && !node.children.length) return { size: 0, files: 0, dirs: 0, complete: false, known: false, source: "尚无统计结果" };
  const children = node.children.map(metrics);
  return {
    size: children.reduce((sum, c) => sum + c.size, 0),
    files: children.reduce((sum, c) => sum + c.files, 0),
    dirs: children.reduce((sum, c, i) => sum + c.dirs + Number(node.children[i].isDirectory), 0),
    complete: node.listed && !node.error && node.status !== "scanning" && children.every(c => c.complete) && !errors.has(node.path),
    known: node.listed || children.some(c => c.known),
    source: "条目汇总",
  };
}
function findNode(path: string, node = root): SpaceNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(path, child);
    if (found) return found;
  }
}
function fileNodes(node = root): SpaceNode[] {
  return node.children.flatMap(child => child.isDirectory ? fileNodes(child) : [child]);
}
function rowsToShow(): SpaceNode[] {
  const nodes = largeFiles ? fileNodes() : typeFilter ? fileNodes(current) : current.children;
  return selectEntries(typeFilter ? nodes.filter(node => !node.isDirectory && extensionOf(node.name) === typeFilter) : nodes, {
    kind: $<HTMLSelectElement>("kind").value as EntryKind,
    sort: $<HTMLSelectElement>("sort").value as SortKey,
    direction: $<HTMLSelectElement>("direction").value as SortDirection,
    query: $<HTMLInputElement>("filter").value,
  }, metrics);
}
function icon(directory: boolean): HTMLSpanElement {
  const node = element("span", "", directory ? "folder-icon" : "file-icon");
  node.setAttribute("aria-hidden", "true");
  return node;
}
function selectNode(node: SpaceNode): void {
  selectedPath = node.path;
  render(true);
}
function parentNode(): SpaceNode | undefined {
  if (current.path === "/") return undefined;
  return findNode(current.path.slice(0, current.path.lastIndexOf("/")) || "/");
}
function revealPath(path: string): void {
  expandedPaths.add("/");
  const parts = path.split("/").filter(Boolean);
  parts.forEach((_, index) => expandedPaths.add("/" + parts.slice(0, index + 1).join("/")));
}
function notice(text: string, error = false): void {
  $("notice").textContent = text;
  $("notice").className = `notice${error ? " error" : demo ? " demo" : ""}`;
}
function invalidateAncestors(path: string): void {
  for (const key of summaries.keys()) if (key === path || path.startsWith(key + "/") || key === "/") summaries.delete(key);
}
function renderDirectoryTree(): void {
  const tree = $("directory-tree");
  const fragment = document.createDocumentFragment();
  let count = 0;
  function append(node: SpaceNode, depth: number): void {
    if (++count > 1500) return;
    const line = element("div", "", "tree-line");
    line.style.paddingLeft = `${Math.min(depth, 10) * 12 + 3}px`;
    line.classList.toggle("active", !largeFiles && node.path === current.path);
    const expanded = expandedPaths.has(node.path);
    const toggle = element("button", expanded ? "−" : "+", "tree-toggle");
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${node.name}`);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.disabled = busy || !adapter;
    toggle.addEventListener("click", () => {
      if (expanded) { expandedPaths.delete(node.path); render(true); }
      else { expandedPaths.add(node.path); void navigate(node); }
    });
    const name = element("button", "", "tree-name");
    name.append(icon(true), element("span", node.name));
    name.title = node.path;
    name.disabled = busy || !adapter;
    if (node.path === current.path && !largeFiles) name.setAttribute("aria-current", "page");
    name.addEventListener("click", () => void navigate(node));
    line.append(toggle, name);
    fragment.append(line);
    if (expanded) {
      const folders = selectEntries(node.children, { kind: "folders", sort: "size", direction: "desc", query: "" }, metrics);
      for (const child of folders) append(child, depth + 1);
      if (!node.listed && !folders.length) fragment.append(element("div", "尚未读取下层", "tree-placeholder"));
    }
  }
  append(root, 0);
  if (count > 1500) fragment.append(element("div", "更多目录请在主列表查看", "tree-placeholder"));
  tree.replaceChildren(fragment);
}
function renderFileTypes(): void {
  const groups = groupFileTypes(fileNodes(largeFiles ? root : current));
  const total = groups.reduce((sum, group) => sum + group.size, 0);
  const rows = $("type-rows");
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const row = element("tr");
    row.classList.toggle("selected", typeFilter === group.extension);
    const cell = element("td");
    const button = element("button");
    const swatch = element("span", "", "type-swatch");
    swatch.style.backgroundColor = colorForKey(group.extension);
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, element("span", group.extension));
    button.title = `只看 ${group.extension} 文件`;
    button.disabled = busy;
    button.addEventListener("click", () => {
      typeFilter = typeFilter === group.extension ? "" : group.extension;
      $<HTMLSelectElement>("kind").value = "files";
      render(true);
    });
    cell.append(button);
    row.append(cell, element("td", total ? `${(group.size / total * 100).toFixed(1)}%` : "—", "number"), element("td", formatSize(group.size), "number"), element("td", group.count.toLocaleString("zh-CN"), "number"));
    fragment.append(row);
  }
  rows.replaceChildren(fragment);
  $("types-empty").hidden = groups.length > 0;
  $("type-count").textContent = `${groups.length} 种`;
  $("types-scope").textContent = largeFiles ? "所有已读取文件，包含已读取的子目录；不是全盘类型统计。" : "当前目录及已读取的子目录；尚未读取的文件不参与类型统计。";
}
function renderTreemap(entries: SpaceNode[]): void {
  const plot = $("treemap");
  plot.hidden = !$<HTMLInputElement>("show-map").checked;
  if (plot.hidden) return;
  const weighted = entries.filter(node => metrics(node).known && metrics(node).size > 0).sort((a, b) => metrics(b).size - metrics(a).size);
  const visible = weighted.slice(0, 300);
  const items = visible.map(node => ({ key: node.path, weight: metrics(node).size }));
  const rest = weighted.slice(300);
  const otherKey = "\u0000other";
  if (rest.length) items.push({ key: otherKey, weight: rest.reduce((sum, node) => sum + metrics(node).size, 0) });
  const width = plot.clientWidth || 1000;
  const height = plot.clientHeight || 200;
  const rectangles = layoutTreemap(items, width, height);
  const nodes = new Map(visible.map(node => [node.path, node]));
  const fragment = document.createDocumentFragment();
  for (const rect of rectangles) {
    const node = nodes.get(rect.key);
    const size = node ? metrics(node).size : items.at(-1)!.weight;
    const label = node?.name || `其他 ${rest.length} 项`;
    const tile = element("button", "", `map-tile${node ? node.isDirectory ? " is-folder" : " is-file" : ""}`);
    tile.style.left = `${rect.x / width * 100}%`;
    tile.style.top = `${rect.y / height * 100}%`;
    tile.style.width = `${rect.width / width * 100}%`;
    tile.style.height = `${rect.height / height * 100}%`;
    tile.style.backgroundColor = colorForKey(node ? node.isDirectory ? node.path : extensionOf(node.name) : otherKey);
    tile.classList.toggle("selected", node?.path === selectedPath);
    const tiny = rect.width < 55 || rect.height < 35;
    tile.classList.toggle("tiny", tiny);
    if (rect.width < 24 || rect.height < 24) tile.tabIndex = -1;
    tile.title = `${node?.path || label}：${formatSize(size)}${node && !metrics(node).complete ? "（部分大小）" : ""}${node?.isDirectory ? "；点击进入并自动分析" : ""}`;
    tile.setAttribute("aria-label", tile.title);
    tile.disabled = busy;
    tile.append(element("span", label), element("small", formatSize(size)));
    tile.addEventListener("click", () => {
      if (node) { if (node.isDirectory) void navigate(node); else selectNode(node); }
      else notice(`还有 ${rest.length} 个较小条目，合计 ${formatSize(size)}。可用上方列表筛选或排序查看。`);
    });
    fragment.append(tile);
  }
  if (!rectangles.length) fragment.append(element("p", entries.length ? "当前筛选中没有已知且大于 0 的条目；未知大小不会记为 0。" : "取得占用大小后，在这里按面积查看空间分布。"));
  plot.replaceChildren(fragment);
  $("map-scope").textContent = `${largeFiles || typeFilter ? "范围内已读取文件" : "本层文件夹 / 文件"} · 对应当前筛选列表 · 面积按已知大小比例`;
}
function render(force = false): void {
  if (!force && busy && performance.now() - renderAt < 200) return;
  renderAt = performance.now();
  metricCache = new WeakMap();
  const active = !!adapter;
  const m = metrics(largeFiles ? root : current);
  $("connection").textContent = demo ? "演示模式 · 非真实网盘" : live ? "已连接 · 本地只读" : "尚未连接";
  $("connection").classList.toggle("connected", !!live);
  $("quota").textContent = quota ? `${formatSize(quota.used)} / ${formatSize(quota.total)}` : "—";
  $("capacity-bar").style.width = quota ? `${Math.min(100, quota.used / Math.max(1, quota.total) * 100)}%` : "0";
  $("known-size").textContent = active && m.known ? formatSize(m.size) : "—";
  $("scope-state").textContent = active ? m.complete ? "当前目录已完整统计" : "仅已知大小 · 仍有未完成条目" : "等待连接";
  $("entry-count").textContent = active && current.listed ? `${current.children.length}` : "—";
  $("counts").textContent = active ? `${current.children.filter(n => n.isDirectory).length} 个文件夹 · ${current.children.filter(n => !n.isDirectory).length} 个文件` : "文件夹和文件";
  for (const id of ["scan", "refresh", "deep-scan"]) $<HTMLButtonElement>(id).disabled = !active || busy || largeFiles;
  for (const id of ["connect", "clear-cache", "home", "large-files"]) $<HTMLButtonElement>(id).disabled = busy;
  $("stop").hidden = !busy;
  $("progress").hidden = !busy;
  $("progress-text").textContent = progressText;
  $("view-label").textContent = largeFiles ? "仅包含已读取的文件" : "文件夹占用";
  $("home").classList.toggle("active", !largeFiles);
  $("large-files").classList.toggle("active", largeFiles);
  $("home").setAttribute("aria-pressed", String(!largeFiles));
  $("large-files").setAttribute("aria-pressed", String(largeFiles));
  $<HTMLOptionElement>("folders-option").disabled = largeFiles;
  $<HTMLButtonElement>("up").disabled = busy || !adapter || largeFiles || !parentNode();
  const scopeEntries = largeFiles ? fileNodes() : typeFilter ? fileNodes(current) : current.children;
  $("list-heading").textContent = largeFiles ? "已读取的大文件" : typeFilter ? "当前目录内已读取的类型文件" : "本层占用";
  $("share-heading").textContent = largeFiles || typeFilter ? "范围占比" : "本层占比";
  const sort = $<HTMLSelectElement>("sort").value;
  const direction = $<HTMLSelectElement>("direction").value;
  document.querySelectorAll<HTMLElement>("[data-column]").forEach(th => th.setAttribute("aria-sort", th.dataset.column === sort ? direction === "asc" ? "ascending" : "descending" : "none"));
  $("clear-type").hidden = !typeFilter;
  $("clear-type").textContent = `类型筛选：${typeFilter} · 清除`;
  const breadcrumbs = $("breadcrumbs");
  breadcrumbs.replaceChildren();
  if (largeFiles) breadcrumbs.append(element("span", "已发现的大文件"));
  else {
    const paths = ["/", ...current.path.split("/").filter(Boolean).map((_, i, parts) => "/" + parts.slice(0, i + 1).join("/"))];
    paths.forEach((path, index) => {
      if (index) breadcrumbs.append(element("span", "/"));
      const button = element("button", path === "/" ? "我的网盘" : path.split("/").at(-1)!);
      button.disabled = busy;
      button.addEventListener("click", () => { const node = findNode(path); if (node) void navigate(node); });
      breadcrumbs.append(button);
    });
  }
  const entries = rowsToShow();
  $("visible-count").textContent = `${entries.length} / ${scopeEntries.length} 个条目`;
  $<HTMLButtonElement>("export").disabled = entries.length === 0 || busy;
  // Keep the denominator stable when filtering; percent always refers to this scope's known total.
  const total = scopeEntries.reduce((sum, node) => sum + metrics(node).size, 0);
  const rows = $("rows");
  rows.replaceChildren();
  for (const node of entries) {
    const data = metrics(node);
    const error = errors.get(node.path) || (summaries.has(node.path) ? undefined : node.error);
    const status = error ? "error" : data.complete ? "complete" : node.status === "scanning" ? "scanning" : data.known ? "partial" : "unscanned";
    const tr = element("tr");
    tr.classList.toggle("selected", node.path === selectedPath);
    tr.addEventListener("click", event => { if (!(event.target as HTMLElement).closest("button") && !busy) selectNode(node); });
    const nameCell = element("td");
    const name = element("button", "", "name-button");
    name.append(icon(node.isDirectory), element("span", node.name, "name"));
    name.title = node.path;
    name.disabled = busy;
    name.addEventListener("click", () => node.isDirectory ? void navigate(node) : selectNode(node));
    nameCell.append(name);
    if (largeFiles) nameCell.append(element("span", node.path, "row-path"));
    const sizeCell = element("td", "", "number");
    sizeCell.title = data.known ? `${data.size.toLocaleString("zh-CN")} 字节${data.complete ? "" : "（部分）"}` : "未知大小不计为 0";
    sizeCell.append(element("span", data.known ? `${!data.complete ? "≥ " : ""}${formatSize(data.size)}` : "待统计", "bytes"));
    const shareCell = element("td", "", "share-cell");
    const percentage = total > 0 ? data.size / total * 100 : 0;
    const track = element("div", "", "share-meter");
    const fill = element("div", "", "bar-fill");
    fill.style.width = `${percentage}%`;
    track.append(fill, element("span", data.known && total > 0 ? `${percentage.toFixed(1)}%` : "—", "percentage"));
    shareCell.append(track);
    const filesCell = element("td", data.known ? `${!data.complete ? "≥ " : ""}${data.files.toLocaleString("zh-CN")}` : "—", "number");
    const dirsCell = element("td", node.isDirectory ? data.known ? `${!data.complete ? "≥ " : ""}${data.dirs.toLocaleString("zh-CN")}` : "—" : "—", "number");
    const statusCell = element("td");
    statusCell.title = error || `${data.source}；${data.files} 个文件，${data.dirs} 个子文件夹`;
    statusCell.append(element("span", labels[status], `badge ${status}`));
    const actionCell = element("td");
    if (node.isDirectory) {
      const open = element("button", "查看 ›", "row-action");
      open.title = "进入并自动分析下一层";
      open.disabled = busy;
      open.addEventListener("click", () => void navigate(node));
      actionCell.append(open);
    }
    tr.append(nameCell, shareCell, sizeCell, filesCell, dirsCell, statusCell, actionCell);
    rows.append(tr);
  }
  renderDirectoryTree();
  renderFileTypes();
  renderTreemap(entries);
  $("selection").textContent = selectedPath ? `${selectedPath} · ${formatSize(metrics(findNode(selectedPath) || current).size)}` : busy ? "正在分析 · 云端文件保持原样" : "就绪 · 云端文件保持原样";
  $("empty").hidden = entries.length > 0;
  const heading = $("empty").querySelector("h2")!;
  const description = $("empty").querySelector("p")!;
  const filtered = !!$<HTMLInputElement>("filter").value || $<HTMLSelectElement>("kind").value !== "all" || !!typeFilter;
  heading.textContent = !active ? "连接网盘，开始分析" : filtered ? "没有符合筛选条件的条目" : largeFiles ? "还没有读取到文件" : busy ? "正在自动分析本层…" : current.listed ? "这个文件夹为空" : "准备读取目录";
  description.textContent = !active ? "登录百度网盘网页版后连接，首页和进入的每一层都会自动分析。也可以先查看演示。" : filtered ? "调整“显示”选项、清空搜索或清除类型筛选。" : largeFiles ? "官方统计只有文件夹合计；进入文件夹或深度扫描后，才能发现具体文件。" : busy ? "正在读取目录和文件夹总大小，已完成结果会逐步显示。" : "点击“分析本层”重试；不会修改任何网盘文件。";
  $("demo").hidden = active;
  $("snapshot-time").textContent = `${demo ? "演示数据 · " : ""}${savedAt ? "最近快照：" + new Date(savedAt).toLocaleString("zh-CN") : "尚无扫描记录"}`;
}
async function save(): Promise<void> {
  savedAt = new Date().toISOString();
  if (!extension || demo || !live) return;
  const snapshot: Snapshot = { version: 1, accountId: live.accountId, savedAt, root, summaries: [...summaries.values()] };
  if (JSON.stringify(snapshot).length > 3_500_000) { notice("统计已完成，但记录较大，未自动保存。可导出当前列表；网盘文件不会受影响。"); return; }
  try { await chrome.storage.local.set({ ["scan:" + live.accountId]: snapshot }); }
  catch { notice("统计结果已保留在页面中，但本地保存失败。可导出当前列表。"); }
}
async function run(action: (signal: AbortSignal) => Promise<void>, persist = true): Promise<void> {
  if (busy) return;
  busy = true; controller = new AbortController(); progressText = "正在读取网盘…";
  render(true);
  try { await action(controller.signal); }
  catch (error) {
    const stopped = error instanceof Error && error.name === "AbortError";
    notice(stopped ? "已停止。已完成的结果仍然保留，未完成目录不会记为 0。" : error instanceof Error ? error.message : "操作失败，请重新连接。", !stopped);
  } finally {
    busy = false; controller = undefined;
    if (persist) await save();
    render(true);
  }
}
async function navigate(node: SpaceNode): Promise<void> {
  if (busy || !node.isDirectory) return;
  if (largeFiles || typeFilter) $<HTMLSelectElement>("kind").value = "all";
  largeFiles = false; current = node; selectedPath = node.path; typeFilter = "";
  revealPath(node.path);
  $<HTMLInputElement>("filter").value = "";
  render(true);
  await fastScan();
}
async function connect(): Promise<void> {
  if (!extension) { notice("当前是本地界面预览。真实网盘需要在 Chrome / Edge 中加载 dist 文件夹里的扩展。", true); return; }
  await run(async signal => {
    demo = false; live = undefined; adapter = undefined; quota = undefined;
    root = createRoot(); current = root; summaries.clear(); errors.clear(); savedAt = ""; largeFiles = false;
    typeFilter = ""; selectedPath = ""; expandedPaths.clear(); expandedPaths.add("/");
    const preferred = Number(new URLSearchParams(location.search).get("source"));
    const tabs = await chrome.tabs.query({ url: "https://pan.baidu.com/*" });
    const tab = tabs.find(t => t.id === preferred) || tabs.find(t => t.url?.includes("/disk/")) || tabs[0];
    if (!tab?.id) throw new Error("没有找到百度网盘标签页。请打开 pan.baidu.com 并登录，再点击连接。");
    const connection = new BaiduAdapter(tab.id);
    quota = await connection.connect();
    adapter = live = connection;
    const key = "scan:" + connection.accountId;
    const stored = (await chrome.storage.local.get(key))[key] as Snapshot | undefined;
    if (stored?.version === 1 && stored.accountId === connection.accountId && stored.root?.path === "/" && Array.isArray(stored.root.children) && Array.isArray(stored.summaries)) {
      root = stored.root; current = root; savedAt = stored.savedAt;
      summaries = new Map(stored.summaries.map(s => [s.path, s]));
      notice("已连接并恢复本账户的历史快照，正在自动分析首页。需要最新结果时可点击“重新查询”。");
    } else {
      await listDirectory(root, connection, signal);
      notice("已连接，正在自动分析首页文件夹占用；不会下载文件。");
    }
    await analyzeLayer(root, signal);
  });
}
async function analyzeLayer(target: SpaceNode, signal: AbortSignal, force = false): Promise<void> {
    invalidateAncestors(target.path);
    errors.delete(target.path);
    if (force || !target.listed || target.error || !isRecent(target.scannedAt, LIST_MAX_AGE_MS)) await listDirectory(target, adapter!, signal);
    const folders = target.children.filter(n => n.isDirectory);
    const pending = folders.filter(node => {
      const summary = summaries.get(node.path);
      if (!force && !errors.has(node.path) && summary && isRecent(summary.scannedAt, SUMMARY_MAX_AGE_MS)) return false;
      summaries.delete(node.path);
      errors.delete(node.path);
      return true;
    });
    const reused = folders.length - pending.length;
    let completed = reused;
    let failed = 0;
    const batches: SpaceNode[][] = [];
    for (let offset = 0; offset < pending.length; offset += 10) batches.push(pending.slice(offset, offset + 10));
    const gate = requestGate(demo ? 0 : 150);
    const update = () => {
      progressText = `已完成 ${completed} / ${folders.length} 个文件夹${reused ? ` · 复用 ${reused} 个近期结果` : ""} · 查询官方统计任务…`;
      $("progress-text").textContent = progressText;
    };
    update(); render(true);
    await runQueue(batches, async (batch, jobSignal) => {
      await gate(jobSignal);
      try {
        const results = demo ? await demoSummaries(batch.map(n => n.path), jobSignal) : await live!.summaries(batch.map(n => n.path), jobSignal, update);
        if (jobSignal.aborted) throw new DOMException("已停止扫描", "AbortError");
        for (const result of results) { summaries.set(result.path, result); errors.delete(result.path); }
        completed += results.length;
      } catch (error) {
        if (jobSignal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        const message = error instanceof Error ? error.message : "目录统计失败";
        for (const node of batch) errors.set(node.path, message);
        failed += batch.length;
      }
      update(); render(true);
      return [];
    }, { concurrency: 2, signal });
    const cacheNote = reused ? `复用了 ${reused} 个五分钟内的结果；需要最新大小请点“重新查询”。` : "";
    notice(demo ? "演示统计完成。这些是本地样例，不是你的网盘。" : failed ? `已取得 ${completed} 个文件夹的大小，另有 ${failed} 个未完成。悬停状态查看错误，可重新查询或进入该文件夹使用深度扫描。${cacheNote}` : `本层文件夹占用已取得，大小包含所有子文件夹；进入文件夹后会自动分析下一层。${cacheNote}`, failed > 0);
}
async function fastScan(force = false): Promise<void> {
  if (!adapter) return;
  const target = current;
  await run(signal => analyzeLayer(target, signal, force));
}
async function deepScan(): Promise<void> {
  if (!adapter) return;
  const target = current;
  await run(async signal => {
    invalidateAncestors(target.path);
    for (const key of summaries.keys()) if (target.path === "/" || key.startsWith(target.path + "/")) summaries.delete(key);
    for (const key of errors.keys()) if (key === target.path || target.path === "/" || key.startsWith(target.path + "/")) errors.delete(key);
    await scanDirectory(target, adapter!, { signal, delayMs: demo ? 5 : 120, concurrency: 3, onProgress(progress: ScanProgress) {
      progressText = `已读 ${progress.directoriesRead} 个目录 · ${progress.filesFound} 个文件 · ${progress.currentPath}`;
      render();
    } });
    notice(demo ? "演示深度扫描完成，非真实数据。" : target.status === "complete" ? "深度扫描完成，已累加全部文件的大小。" : "深度扫描部分完成；失败目录未计为 0，详情请查看状态。", target.status !== "complete");
  });
}
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function exportCsv(): void {
  metricCache = new WeakMap();
  const lines = [["路径", "类型", "已知字节数", "统计完整", "文件数", "子目录数", "来源", "快照时间"]];
  for (const node of rowsToShow()) {
    const data = metrics(node);
    lines.push([node.path, node.isDirectory ? "文件夹" : "文件", data.known ? String(data.size) : "", String(data.complete && !errors.has(node.path)), String(data.files), String(data.dirs), demo ? "演示数据" : data.source, savedAt]);
  }
  const blob = new Blob(["\ufeff" + lines.map(line => line.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = element("a"); link.href = url; link.download = `${demo ? "演示-" : ""}网盘空间-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Explicit, isolated sample data. It never contains account data and is never persisted.
const GiB = 1024 ** 3;
const demoTree: Record<string, { name: string; dir?: boolean; size?: number }[]> = {
  "/": [{ name: "课程资料", dir: true }, { name: "视频归档", dir: true }, { name: "照片备份", dir: true }, { name: "项目文件", dir: true }, { name: "旧备份.zip", size: 22 * GiB }, { name: "空文件夹", dir: true }],
  "/课程资料": [{ name: "编程课程", dir: true }, { name: "设计课程", dir: true }, { name: "阅读清单.pdf", size: 4 * 1024 ** 2 }],
  "/课程资料/编程课程": [{ name: "TypeScript课程.mp4", size: 45 * GiB }, { name: "练习资料.zip", size: 2 * GiB }],
  "/课程资料/设计课程": [{ name: "设计课程合集.zip", size: 28 * GiB }],
  "/视频归档": [{ name: "旅行视频.mov", size: 125 * GiB }, { name: "旧录像.mp4", size: 92 * GiB }],
  "/照片备份": [{ name: "2025照片.zip", size: 16 * GiB }, { name: "2026照片.zip", size: 27 * GiB }],
  "/项目文件": [{ name: "模型权重.bin", size: 56 * GiB }, { name: "源代码.zip", size: 1 * GiB }],
};
const demoAdapter: DiskAdapter = {
  async list(path, page, signal) {
    await wait(50, signal);
    return { entries: page === 1 ? (demoTree[path] || []).map(file => ({ id: path + file.name, name: file.name, path: (path === "/" ? "" : path) + "/" + file.name, isDirectory: !!file.dir, size: file.size ?? 0 })) : [], hasMore: false };
  },
};
async function demoSummaries(paths: string[], signal: AbortSignal): Promise<FolderSummary[]> {
  await wait(450, signal);
  function summarize(path: string): FolderSummary {
    let size = 0, fileCount = 0, directoryCount = 0;
    for (const file of demoTree[path] || []) {
      if (!file.dir) { size += file.size || 0; fileCount++; }
      else { const child = summarize(path + "/" + file.name); size += child.size; fileCount += child.fileCount; directoryCount += 1 + child.directoryCount; }
    }
    return { path, size, fileCount, directoryCount, scannedAt: new Date().toISOString() };
  }
  return paths.map(summarize);
}
async function startDemo(): Promise<void> {
  demo = true; live = undefined; adapter = demoAdapter;
  root = createRoot(); current = root; summaries.clear(); errors.clear(); largeFiles = false; savedAt = "";
  quota = { used: 580 * GiB, total: 1024 * GiB };
  typeFilter = ""; selectedPath = ""; expandedPaths.clear(); expandedPaths.add("/");
  notice("演示模式：所有名称、容量和文件均为本地样例，与你的网盘无关。");
  await fastScan();
}
$("connect").addEventListener("click", () => void connect());
$("scan").addEventListener("click", () => void fastScan());
$("refresh").addEventListener("click", () => void fastScan(true));
$("deep-scan").addEventListener("click", () => void deepScan());
$("stop").addEventListener("click", () => { controller?.abort(); notice("正在停止，不再发起后续查询；执行中的只读请求可能仍在等待响应，已完成结果会保留。"); });
$("demo").addEventListener("click", () => void startDemo());
$("filter").addEventListener("input", () => render(true));
$("sort").addEventListener("change", () => render(true));
$("direction").addEventListener("change", () => render(true));
$("kind").addEventListener("change", () => { typeFilter = ""; render(true); });
$("clear-type").addEventListener("click", () => { typeFilter = ""; render(true); });
$("show-map").addEventListener("change", () => render(true));
document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach(button => button.addEventListener("click", () => {
  const sort = $<HTMLSelectElement>("sort");
  const direction = $<HTMLSelectElement>("direction");
  if (sort.value === button.dataset.sort) direction.value = direction.value === "desc" ? "asc" : "desc";
  else { sort.value = button.dataset.sort!; direction.value = sort.value === "name" ? "asc" : "desc"; }
  render(true);
}));
$("up").addEventListener("click", () => { const parent = parentNode(); if (parent) void navigate(parent); });
$("export").addEventListener("click", exportCsv);
$("home").addEventListener("click", () => void navigate(root));
$("large-files").addEventListener("click", () => {
  largeFiles = true; typeFilter = ""; selectedPath = "";
  if ($<HTMLSelectElement>("kind").value === "folders") $<HTMLSelectElement>("kind").value = "files";
  $<HTMLInputElement>("filter").value = ""; render(true);
});
$("clear-cache").addEventListener("click", async () => {
  if (extension && live) await chrome.storage.local.remove("scan:" + live.accountId);
  root = createRoot(); current = root; summaries.clear(); errors.clear(); savedAt = ""; largeFiles = false;
  typeFilter = ""; selectedPath = ""; expandedPaths.clear(); expandedPaths.add("/");
  notice("本地统计记录已清除，云端文件没有变化。点击“分析本层”重新查询。"); render(true);
});
let resizeFrame = 0;
let lastMapWidth = 0;
let lastMapHeight = 0;
const mapResize = new ResizeObserver(entries => {
  const box = entries[0]?.contentRect;
  if (!box || (box.width === lastMapWidth && box.height === lastMapHeight)) return;
  lastMapWidth = box.width; lastMapHeight = box.height;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => render(true));
});
mapResize.observe($("treemap"));
render(true);
if (new URLSearchParams(location.search).get("demo") === "1") void startDemo();
else if (extension && new URLSearchParams(location.search).has("source")) void connect();
