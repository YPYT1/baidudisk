import type { SpaceNode } from "./types";

export type EntryKind = "all" | "folders" | "files";
export type SortKey = "size" | "name" | "files" | "dirs";
export type SortDirection = "asc" | "desc";
export interface ViewMetrics { size: number; files: number; dirs: number; known: boolean; complete: boolean }
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function selectEntries(nodes: SpaceNode[], options: { kind: EntryKind; sort: SortKey; direction: SortDirection; query: string }, metrics: (node: SpaceNode) => ViewMetrics): SpaceNode[] {
  const query = options.query.trim().toLocaleLowerCase();
  const direction = options.direction === "asc" ? 1 : -1;
  return nodes.filter(node => (options.kind === "all" || node.isDirectory === (options.kind === "folders")) && (!query || node.name.toLocaleLowerCase().includes(query) || node.path.toLocaleLowerCase().includes(query))).sort((a, b) => {
    if (options.sort !== "name") {
      const ma = metrics(a), mb = metrics(b);
      const va = ma[options.sort], vb = mb[options.sort];
      const ka = ma.known && Number.isFinite(va), kb = mb.known && Number.isFinite(vb);
      if (ka !== kb) return ka ? -1 : 1;
      if (ka && va !== vb) return (va < vb ? -1 : 1) * direction;
    }
    const nameOrder = collator.compare(a.name, b.name);
    if (nameOrder) return nameOrder * (options.sort === "name" ? direction : 1);
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index).toLowerCase() : "无扩展名";
}
export function groupFileTypes(nodes: SpaceNode[]): { extension: string; size: number; count: number }[] {
  const seen = new Set<string>();
  const groups = new Map<string, { extension: string; size: number; count: number }>();
  for (const node of nodes) {
    if (node.isDirectory || seen.has(node.path)) continue;
    seen.add(node.path);
    const extension = extensionOf(node.name);
    const group = groups.get(extension) || { extension, size: 0, count: 0 };
    group.size += Number.isFinite(node.size) && node.size >= 0 ? node.size : 0;
    group.count++;
    groups.set(extension, group);
  }
  return [...groups.values()].sort((a, b) => b.size - a.size || collator.compare(a.extension, b.extension));
}

export interface Rectangle { key: string; x: number; y: number; width: number; height: number }
/** Balanced area partition, normalized before summing to avoid overflow. */
export function layoutTreemap(items: { key: string; weight: number }[], width: number, height: number): Rectangle[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const valid = items.filter(item => Number.isFinite(item.weight) && item.weight > 0).sort((a, b) => b.weight - a.weight);
  if (!valid.length) return [];
  const max = valid[0]!.weight;
  const scaled = valid.map(item => ({ key: item.key, weight: item.weight / max })).filter(item => item.weight > 0);
  const result: Rectangle[] = [];
  function partition(start: number, end: number, x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    if (end - start === 1) { result.push({ key: scaled[start]!.key, x, y, width: w, height: h }); return; }
    let total = 0;
    for (let i = start; i < end; i++) total += scaled[i]!.weight;
    let left = scaled[start]!.weight;
    let split = start + 1;
    while (split < end - 1 && Math.abs(total / 2 - (left + scaled[split]!.weight)) < Math.abs(total / 2 - left)) left += scaled[split++]!.weight;
    const ratio = left / total;
    if (w >= h) {
      const first = w * ratio;
      partition(start, split, x, y, first, h);
      partition(split, end, x + first, y, w - first, h);
    } else {
      const first = h * ratio;
      partition(start, split, x, y, w, first);
      partition(split, end, x, y + first, w, h - first);
    }
  }
  partition(0, scaled.length, 0, 0, width, height);
  return result;
}
const palette = ["#245b85", "#296b56", "#8b532d", "#75528b", "#9d3f56", "#4c6881", "#6d6b28", "#256c77", "#94472f", "#574d9b", "#3e7440", "#885c72"];
export function colorForKey(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return palette[(hash >>> 0) % palette.length]!;
}
