import { describe, expect, test, afterEach } from "bun:test";
import { byteCount, normalizeList, normalizeSummaries, requestInPage, wait } from "../src/api";

const originalFetch = globalThis.fetch;
const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
  else Reflect.deleteProperty(globalThis, "location");
});
const summary = { status: "success", task_errno: 0, list: [{ path: "/照片", size: 9603576627, filenum: 1776, dirnum: 23 }] };

describe("API response validation", () => {
  test("exact byte counts, including integer strings", () => {
    expect(byteCount("62152773712")).toBe(62152773712);
    for (const value of [-1, 1.5, NaN, Infinity, undefined, null, "", "0.5", Number.MAX_SAFE_INTEGER + 1]) expect(() => byteCount(value)).toThrow();
  });
  test("folder list size is ignored, file size is preserved", () => {
    const result = normalizeList({ list: [{ fs_id: 1, path: "/照片", isdir: 1, size: 99999 }, { fs_id: 2, path: "/a.txt", isdir: 0, size: 12 }] }, "/");
    expect(result.entries.map(e => e.size)).toEqual([0, 12]);
    expect(result.hasMore).toBe(false);
  });
  test("pagination uses the requested size, including verified 1000-item pages", () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({ path: "/文件" + i, isdir: 0, size: 1 }));
    expect(normalizeList({ list }, "/").hasMore).toBe(true);
    expect(normalizeList({ list: list.slice(0, 272) }, "/").hasMore).toBe(false);
    expect(normalizeList({ list: list.slice(0, 100) }, "/", 100).hasMore).toBe(true);
    expect(normalizeList({ list: [], has_more: 1 }, "/").hasMore).toBe(true);
    expect(normalizeList({ list: [] }, "/").hasMore).toBe(false);
    expect(() => normalizeList({ list }, "/", 0)).toThrow();
  });
  test("rejects invalid paths and missing lists instead of empty successes", () => {
    for (const data of [{}, { list: null }, { list: [{ path: "/other/a", isdir: 0, size: 2 }] }, { list: [{ path: "/nested/a/b", isdir: 0, size: 2 }] }]) expect(() => normalizeList(data, "/nested")).toThrow();
  });
  test("real observed summary shape matches size and counts", () => {
    const result = normalizeSummaries(summary, ["/照片"])[0];
    expect(result.size).toBe(9603576627);
    expect(result.fileCount).toBe(1776);
    expect(result.directoryCount).toBe(23);
  });
  test("matches task results by path, not order", () => {
    const result = normalizeSummaries({ status: "success", list: [{ path: "/b", size: 2, filenum: 1, dirnum: 0 }, { path: "/a", size: 3, filenum: 1, dirnum: 0 }] }, ["/a", "/b"]);
    expect(result[0].path).toBe("/b");
  });
  test("rejects partial, failed, duplicate and invalid summary results", () => {
    expect(() => normalizeSummaries(summary, ["/照片", "/missing"])).toThrow();
    expect(() => normalizeSummaries({ ...summary, status: "running" }, ["/照片"])).toThrow();
    expect(() => normalizeSummaries({ ...summary, task_errno: 2 }, ["/照片"])).toThrow();
    expect(() => normalizeSummaries({ ...summary, list: [...summary.list, ...summary.list] }, ["/照片"])).toThrow();
    expect(() => normalizeSummaries({ ...summary, list: [{ ...summary.list[0], size: -1 }] }, ["/照片"])).toThrow();
  });
});

describe("read-only page bridge", () => {
  function setup(account = "42", fail?: number) {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://pan.baidu.com" } });
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const identity = String(url).startsWith("/api/gettemplatevariable");
      return Response.json(identity ? { errno: 0, result: { uk: account } } : fail !== undefined ? { errno: fail } : { errno: 0, taskid: "123456", list: [] });
    }) as typeof fetch;
    return requests;
  }
  test("summary uses POST and exactly the observed list body", async () => {
    const requests = setup();
    const result = await requestInPage({ operation: "summary", accountId: "42", paths: ["/照片"] });
    expect(result.ok).toBe(true);
    expect(requests[1].url.startsWith("/api/dirsize?")).toBe(true);
    expect(requests[1].init?.method).toBe("POST");
    expect(new URLSearchParams(String(requests[1].init?.body)).get("list")).toBe('[{"path":"/照片"}]');
  });
  test("account mismatch prevents reading a different user's files", async () => {
    const requests = setup("43");
    const result = await requestInPage({ operation: "list", accountId: "42", path: "/" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("切换账户");
    expect(requests).toHaveLength(1);
  });
  test("task polling sends taskid, and list requests stay GET", async () => {
    const requests = setup();
    await requestInPage({ operation: "task", taskId: "123456" });
    expect(requests[1].url).toContain("taskid=123456");
    expect(requests[1].init?.method).toBe("GET");
    await requestInPage({ operation: "list", path: "/照片", page: 2 });
    expect(requests.at(-1)?.url).toContain("page=2");
    expect(requests.at(-1)?.url).toContain("num=1000");
    expect(requests.at(-1)?.init?.method).toBe("GET");
  });
  test("API errors and signed-out accounts are not success", async () => {
    setup("42", -6);
    expect((await requestInPage({ operation: "quota" })).error).toContain("登录");
    setup("0");
    expect((await requestInPage({ operation: "identity" })).ok).toBe(false);
  });
  test("validates batch sizes and refuses arbitrary operations", async () => {
    const requests = setup();
    expect((await requestInPage({ operation: "summary", paths: ["/"] })).ok).toBe(false);
    expect((await requestInPage({ operation: "summary", paths: Array(21).fill("/a") })).ok).toBe(false);
    expect((await requestInPage({ operation: "task", taskId: "bad" })).ok).toBe(false);
    // Runtime validation also covers a tampered UI request.
    expect((await requestInPage({ operation: "delete" as never })).ok).toBe(false);
    expect(requests.every(r => r.url.startsWith("/api/gettemplatevariable"))).toBe(true);
  });
  test("cancellable delay does not wait for the whole interval", async () => {
    const controller = new AbortController();
    const promise = wait(60_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
