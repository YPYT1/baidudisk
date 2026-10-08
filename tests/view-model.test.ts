import { describe, expect, test } from "bun:test";
import { colorForKey, extensionOf, groupFileTypes, layoutTreemap, selectEntries, type SortKey } from "../src/view-model";
import type { SpaceNode } from "../src/types";
function node(name: string, size = 0, directory = false, known = true): SpaceNode {
  return { id: name, name, path: "/" + name, size, isDirectory: directory, listed: known, status: known ? "complete" : "unscanned", children: [], fileCount: size, directoryCount: size };
}
const metrics = (n: SpaceNode) => ({ size: n.size, files: n.fileCount, dirs: n.directoryCount, known: n.listed, complete: n.status === "complete" });
const options = { kind: "all" as const, sort: "size" as const, direction: "desc" as const, query: "" };
describe("entry list", () => {
  for (const sort of ["size", "files", "dirs"] as SortKey[]) for (const direction of ["asc", "desc"] as const) test(`${sort} ${direction}: unknown stays last, zero is known`, () => {
    const input = [node("未知", 0, true, false), node("大", 20, true), node("空", 0, true), node("小", 10)];
    expect(selectEntries(input, { ...options, sort, direction }, metrics).map(n => n.name)).toEqual(direction === "asc" ? ["空", "小", "大", "未知"] : ["大", "小", "空", "未知"]);
    expect(input[0]!.name).toBe("未知");
  });
  test("kind and case-insensitive path search", () => {
    const input = [node("A.ZIP", 5), node("资料", 9, true)];
    input[1]!.path = "/BACKUP/资料";
    expect(selectEntries(input, { ...options, kind: "folders", query: "backup" }, metrics)).toEqual([input[1]!]);
    expect(selectEntries(input, { ...options, kind: "files", query: "a.zip" }, metrics)).toEqual([input[0]!]);
  });
  test("natural name order and deterministic numeric ties", () => {
    const input = [node("文件10"), node("文件2"), node("文件1")];
    expect(selectEntries(input, { ...options, sort: "name", direction: "asc" }, metrics).map(n => n.name)).toEqual(["文件1", "文件2", "文件10"]);
    expect(selectEntries(input, options, metrics).map(n => n.name)).toEqual(["文件1", "文件2", "文件10"]);
  });
});
describe("file types", () => {
  test("extensions", () => {
    expect(extensionOf("file.TAR.GZ")).toBe(".gz");
    for (const name of ["README", ".env", "file."]) expect(extensionOf(name)).toBe("无扩展名");
  });
  test("only real files; deduplicate paths; include zero-byte files", () => {
    const file = node("a.ZIP", 20);
    expect(groupFileTypes([file, file, node("b.zip", 10), node("c.mp4", 0), node("folder.zip", 5000, true)])).toEqual([
      { extension: ".zip", size: 30, count: 2 }, { extension: ".mp4", size: 0, count: 1 },
    ]);
  });
});
describe("treemap", () => {
  test("proportional areas, in bounds, no overlaps", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ key: String(i), weight: i + 1 }));
    const rects = layoutTreemap(items, 1100, 220);
    const total = items.reduce((s, item) => s + item.weight, 0);
    expect(rects).toHaveLength(items.length);
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]!;
      expect(a.width * a.height / (1100 * 220)).toBeCloseTo(items[Number(a.key)]!.weight / total, 10);
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(1100 + 1e-8); expect(a.y + a.height).toBeLessThanOrEqual(220 + 1e-8);
      for (const b of rects.slice(i + 1)) expect(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1e-8 || Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 1e-8).toBe(true);
    }
  });
  test("invalid inputs and extreme weights remain finite", () => {
    expect(layoutTreemap([{ key: "a", weight: 1 }], 0, 100)).toEqual([]);
    expect(layoutTreemap([{ key: "a", weight: 0 }, { key: "b", weight: NaN }, { key: "c", weight: -1 }, { key: "d", weight: Infinity }], 100, 100)).toEqual([]);
    const rects = layoutTreemap([{ key: "a", weight: 1e308 }, { key: "b", weight: 1e308 }, { key: "c", weight: 1e-308 }], 100, 100);
    expect(rects).toHaveLength(2);
    for (const rect of rects) for (const value of [rect.x, rect.y, rect.width, rect.height]) expect(Number.isFinite(value)).toBe(true);
    expect(rects[0]!.width * rects[0]!.height).toBe(5000);
  });
  test("color stable and valid", () => {
    expect(colorForKey(".zip")).toBe(colorForKey(".zip"));
    expect(colorForKey("课程")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
