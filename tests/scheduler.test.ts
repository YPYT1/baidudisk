import { expect, test } from "bun:test";
import { isRecent, LIST_MAX_AGE_MS, SUMMARY_MAX_AGE_MS } from "../src/freshness";
import { pause, requestGate, runQueue } from "../src/scheduler";

test("recent results have bounded reuse and old/future/invalid timestamps are rejected", () => {
  const now = Date.now();
  const timestamp = (age: number) => new Date(now - age).toISOString();
  expect(isRecent(timestamp(10_000), LIST_MAX_AGE_MS, now)).toBe(true);
  expect(isRecent(timestamp(60_000), LIST_MAX_AGE_MS, now)).toBe(false);
  expect(isRecent(timestamp(60_000), SUMMARY_MAX_AGE_MS, now)).toBe(true);
  expect(isRecent(timestamp(300_000), SUMMARY_MAX_AGE_MS, now)).toBe(false);
  expect(isRecent(timestamp(-1), SUMMARY_MAX_AGE_MS, now)).toBe(false);
  expect(isRecent("invalid", SUMMARY_MAX_AGE_MS, now)).toBe(false);
  expect(isRecent(undefined, SUMMARY_MAX_AGE_MS, now)).toBe(false);
});
test("dynamic queue visits newly discovered work with bounded concurrency", async () => {
  let active = 0, peak = 0;
  const seen: number[] = [];
  await runQueue([0], async (value, signal) => {
    active++; peak = Math.max(peak, active);
    await pause(10, signal);
    seen.push(value); active--;
    return value === 0 ? [1, 2, 3, 4] : [];
  }, { concurrency: 2 });
  expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
});
test("failure cancels and drains other workers before returning", async () => {
  const finished: number[] = [];
  let active = 0;
  await expect(runQueue([1, 2, 3], async (value, signal) => {
    active++;
    try {
      if (value === 1) { await pause(5, signal); throw new Error("failed"); }
      await pause(60_000, signal);
      finished.push(value);
      return [];
    } finally { active--; }
  }, { concurrency: 2 })).rejects.toThrow("failed");
  expect(active).toBe(0);
  expect(finished).toEqual([]);
});
test("external cancellation starts no later queue work", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const promise = runQueue([1, 2, 3], async (value, signal) => {
    started.push(value);
    await pause(60_000, signal);
    return [];
  }, { concurrency: 2, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(started).toEqual([1, 2]);
});
test("shared gate spaces concurrent request starts and is cancellable", async () => {
  const gate = requestGate(30);
  const times: number[] = [];
  await Promise.all(Array.from({ length: 3 }, async () => { await gate(); times.push(performance.now()); }));
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(26);
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(26);
  const delayed = requestGate(60_000);
  await delayed();
  const controller = new AbortController();
  const pending = delayed(controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
test("queue rejects unsafe concurrency settings", async () => {
  for (const concurrency of [0, -1, 7, 1.5]) await expect(runQueue([], async () => [], { concurrency })).rejects.toThrow("并发");
  expect(() => requestGate(-1)).toThrow();
});
