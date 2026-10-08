import { describe, expect, test } from "bun:test";
import { createNode, createRoot, listDirectory, refreshTotals, scanDirectory } from "../src/scan-engine";
import type { DiskAdapter, Entry, ListPage, SpaceNode } from "../src/types";
const file = (path: string, size: number): Entry => ({ id: path, path, name: path.split("/").at(-1)!, size, isDirectory: false });
const folder = (path: string, bogusSize = 0): Entry => ({ ...file(path, bogusSize), isDirectory: true });
function fixture(pages: Record<string, ListPage | Error>): DiskAdapter {
  return { async list(path, page) { const result = pages[`${path}:${page}`] ?? { entries: [], hasMore: false }; if (result instanceof Error) throw result; return result; } };
}
function child(node: SpaceNode, path: string): SpaceNode { return node.children.find(c => c.path === path)!; }
const data = fixture({
  "/:1": { entries: [folder("/a", 99999), folder("/empty"), file("/root.txt", 10)], hasMore: false },
  "/a:1": { entries: [file("/a/first", 100), folder("/a/nested")], hasMore: false },
  "/a/nested:1": { entries: [file("/a/nested/last", 200)], hasMore: false },
});

describe("directory scanning", () => {
  test("never trusts the API's folder size", () => {
    const node = createNode(folder("/a", 999999));
    expect(node.size).toBe(0);
    expect(node.status).toBe("unscanned");
  });
  test("listing alone is partial when folders are unscanned", async () => {
    const root = createRoot();
    await listDirectory(root, data);
    expect(root.size).toBe(10);
    expect(root.listed).toBe(true);
    expect(root.status).toBe("partial");
    expect(child(root, "/a").status).toBe("unscanned");
  });
  test("nested sizes and counts are exact", async () => {
    const root = createRoot();
    const progress = await scanDirectory(root, data, { delayMs: 0 });
    expect(root.size).toBe(310);
    expect(root.fileCount).toBe(3);
    expect(root.directoryCount).toBe(3);
    expect(root.status).toBe("complete");
    expect(child(root, "/a").size).toBe(300);
    expect(child(root, "/empty").size).toBe(0);
    expect(child(root, "/empty").status).toBe("complete");
    expect(progress.directoriesRead).toBe(4);
    expect(progress.requests).toBe(4);
    expect(progress.filesFound).toBe(3);
  });
  test("handles multiple pages and overlapping entries without double counting", async () => {
    const root = createRoot();
    await scanDirectory(root, fixture({
      "/:1": { entries: [file("/a", 10), file("/b", 20)], hasMore: true },
      "/:2": { entries: [file("/b", 20), file("/c", 30)], hasMore: false },
    }), { delayMs: 0 });
    expect(root.size).toBe(60);
    expect(root.fileCount).toBe(3);
    expect(root.status).toBe("complete");
  });
  test("repeated pages cannot loop or become complete", async () => {
    const root = createRoot();
    await expect(listDirectory(root, fixture({
      "/:1": { entries: [file("/a", 10)], hasMore: true },
      "/:2": { entries: [file("/a", 10)], hasMore: true },
    }))).rejects.toThrow("重复页");
    expect(root.size).toBe(10);
    expect(root.status).toBe("partial");
    expect(root.listed).toBe(false);
  });
  test("a failed second page retains verified first-page sizes", async () => {
    const root = createRoot();
    await expect(listDirectory(root, fixture({
      "/:1": { entries: [file("/a", 10)], hasMore: true },
      "/:2": new Error("network failure"),
    }))).rejects.toThrow();
    expect(root.size).toBe(10);
    expect(root.status).toBe("partial");
    expect(root.error).toBe("network failure");
  });
  test("a failed child propagates partial while other siblings complete", async () => {
    const root = createRoot();
    await scanDirectory(root, fixture({
      "/:1": { entries: [folder("/bad"), folder("/good")], hasMore: false },
      "/bad:1": new Error("unavailable"),
      "/good:1": { entries: [file("/good/ok", 44)], hasMore: false },
    }), { delayMs: 0 });
    expect(root.size).toBe(44);
    expect(root.status).toBe("partial");
    expect(child(root, "/bad").status).toBe("error");
    expect(child(root, "/good").status).toBe("complete");
  });
  test("rescanning rereads directories and removes deleted files", async () => {
    const root = createRoot();
    await scanDirectory(root, data, { delayMs: 0 });
    await scanDirectory(root, fixture({ "/:1": { entries: [file("/only", 8)], hasMore: false } }), { delayMs: 0 });
    expect(root.size).toBe(8);
    expect(root.fileCount).toBe(1);
    expect(root.directoryCount).toBe(0);
    expect(root.children).toHaveLength(1);
  });
  test("refresh recomputes rather than incrementing existing totals", async () => {
    const root = createRoot();
    await scanDirectory(root, data, { delayMs: 0 });
    refreshTotals(root); refreshTotals(root);
    expect(root.size).toBe(310);
    child(root, "/root.txt").size = 20;
    refreshTotals(root);
    expect(root.size).toBe(320);
  });
  test("rejects invalid sizes and paths", async () => {
    expect(() => createNode(file("/negative", -1))).toThrow();
    await expect(listDirectory(createRoot(), fixture({ "/:1": { entries: [file("/not/immediate", 1)], hasMore: false } }))).rejects.toThrow("当前层");
    await expect(listDirectory(createRoot(), fixture({ "/:1": { entries: [], hasMore: true } }))).rejects.toThrow("新条目");
  });
  test("same-path metadata changing across pages cannot become a fake success", async () => {
    const root = createRoot();
    await expect(listDirectory(root, fixture({
      "/:1": { entries: [file("/a", 10)], hasMore: true },
      "/:2": { entries: [file("/a", 11)], hasMore: false },
    }))).rejects.toThrow("变化");
    expect(root.status).toBe("partial");
  });
  test("cancellation rejects promptly even while an adapter is pending", async () => {
    const root = createRoot();
    const controller = new AbortController();
    const adapter: DiskAdapter = { list: () => new Promise(() => {}) };
    const result = scanDirectory(root, adapter, { signal: controller.signal, delayMs: 0, onProgress(p) { if (p.requests === 1) setTimeout(() => controller.abort(), 0); } });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(root.status).not.toBe("complete");
  });
  test("cancelling between directories preserves verified siblings", async () => {
    const root = createRoot();
    const controller = new AbortController();
    const promise = scanDirectory(root, data, { signal: controller.signal, delayMs: 0, concurrency: 1, onProgress(p) { if (p.directoriesRead === 2) controller.abort(); } });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(root.size).toBe(110);
    expect(root.status).toBe("partial");
  });
  test("throttles requests and can stop during the delay", async () => {
    const times: number[] = [];
    const adapter: DiskAdapter = { async list(path) { times.push(performance.now()); return { entries: path === "/" ? [folder("/a")] : [], hasMore: false }; } };
    await scanDirectory(createRoot(), adapter, { delayMs: 30 });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(27);
    const controller = new AbortController();
    const root = createRoot();
    const promise = scanDirectory(root, data, { delayMs: 60_000, signal: controller.signal, onProgress(p) { if (p.directoriesRead === 1) controller.abort(); } });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(root.status).not.toBe("complete");
  });
  test("parallel traversal bounds workers, serializes folder pages and matches serial totals", async () => {
    let active = 0, peak = 0;
    const paths = new Set<string>();
    const calls: string[] = [];
    const adapter: DiskAdapter = { async list(path, page) {
      expect(paths.has(path)).toBe(false);
      paths.add(path); calls.push(`${path}:${page}`);
      active++; peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--; paths.delete(path);
      return path === "/" ? { entries: Array.from({ length: 8 }, (_, i) => folder(`/d${i}`)), hasMore: false } : { entries: [file(`${path}/f${page}`, page * 10)], hasMore: page === 1 };
    } };
    const parallel = createRoot();
    await scanDirectory(parallel, adapter, { delayMs: 0, concurrency: 3 });
    expect(peak).toBe(3);
    expect(parallel.size).toBe(240);
    expect(parallel.fileCount).toBe(16);
    expect(parallel.status).toBe("complete");
    for (let i = 0; i < 8; i++) expect(calls.indexOf(`/d${i}:1`)).toBeLessThan(calls.indexOf(`/d${i}:2`));
    const serial = createRoot();
    await scanDirectory(serial, adapter, { delayMs: 0, concurrency: 1 });
    expect(serial.size).toBe(parallel.size);
  });
  test("cancelling concurrent pending requests leaves no late tree mutation", async () => {
    const root = createRoot();
    const controller = new AbortController();
    let active = 0, started = 0;
    const adapter: DiskAdapter = { async list(path) {
      if (path === "/") return { entries: [folder("/a"), folder("/b"), folder("/c"), folder("/d")], hasMore: false };
      active++; started++;
      if (active === 3) controller.abort();
      await Bun.sleep(20);
      active--;
      return { entries: [file(path + "/late", 9)], hasMore: false };
    } };
    await expect(scanDirectory(root, adapter, { delayMs: 0, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const snapshot = JSON.stringify(root);
    await Bun.sleep(35);
    expect(JSON.stringify(root)).toBe(snapshot);
    expect(started).toBe(3);
    expect(root.status).not.toBe("complete");
  });
  test("a later rescan recovers an errored folder", async () => {
    const root = createRoot();
    await scanDirectory(root, fixture({ "/:1": new Error("offline") }), { delayMs: 0 });
    expect(root.status).toBe("error");
    await scanDirectory(root, data, { delayMs: 0 });
    expect(root.status).toBe("complete");
    expect(root.error).toBeUndefined();
  });
});
