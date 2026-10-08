import { expect, test } from "bun:test";
import { BaiduAdapter, abortIfNeeded } from "../src/api";

const success = { status: "success", task_errno: 0, list: [{ path: "/a", size: 10, filenum: 1, dirnum: 0 }] };
class FakeAdapter extends BaiduAdapter {
  calls: string[] = [];
  tasks: Record<string, unknown>[];
  constructor(tasks: Record<string, unknown>[]) { super(1); this.tasks = [...tasks]; }
  override async call(input: Parameters<BaiduAdapter["call"]>[0], signal?: AbortSignal): Promise<Record<string, unknown>> {
    abortIfNeeded(signal);
    this.calls.push(input.operation);
    return input.operation === "summary" ? { taskid: "123" } : this.tasks.shift() ?? { status: "failed" };
  }
}
test("ready tasks are queried immediately, without a mandatory one-second wait", async () => {
  const adapter = new FakeAdapter([success]);
  const start = performance.now();
  const result = await adapter.summaries(["/a"]);
  expect(result[0].size).toBe(10);
  expect(adapter.calls).toEqual(["summary", "task"]);
  expect(performance.now() - start).toBeLessThan(900);
});
test("pending tasks poll again and validate the completed result", async () => {
  const adapter = new FakeAdapter([{ status: "pending" }, success]);
  const result = await adapter.summaries(["/a"]);
  expect(result[0].size).toBe(10);
  expect(adapter.calls).toEqual(["summary", "task", "task"]);
});
test("cancelling pending polling stops later task requests", async () => {
  const adapter = new FakeAdapter([{ status: "running" }, success]);
  const controller = new AbortController();
  const promise = adapter.summaries(["/a"], controller.signal);
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(adapter.calls.filter(operation => operation === "task")).toHaveLength(1);
});
test("failed and mismatched tasks never become zero-sized successes", async () => {
  await expect(new FakeAdapter([{ status: "failed" }]).summaries(["/a"])).rejects.toThrow();
  await expect(new FakeAdapter([success]).summaries(["/other"])).rejects.toThrow("不匹配");
});
