export interface QueueOptions {
  concurrency?: number;
  signal?: AbortSignal;
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("操作已停止", "AbortError");
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("操作已停止", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** A bounded dynamic queue. Drain cancelled jobs before returning so they cannot mutate a later scan. */
export async function runQueue<T>(initial: T[], worker: (item: T, signal: AbortSignal) => Promise<T[]>, options: QueueOptions = {}): Promise<void> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("并发数量必须在 1 到 6 之间。");
  const local = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
  checkCancelled(signal);
  const queue = [...initial];
  let cursor = 0;
  type Outcome = { job: Promise<Outcome>; children?: T[]; failed?: boolean; error?: unknown };
  const active = new Set<Promise<Outcome>>();
  try {
    while (cursor < queue.length || active.size) {
      checkCancelled(signal);
      while (cursor < queue.length && active.size < concurrency) {
        checkCancelled(signal);
        const item = queue[cursor++];
        let job: Promise<Outcome>;
        job = Promise.resolve().then(() => { checkCancelled(signal); return worker(item, signal); }).then(
          children => ({ job, children }),
          error => ({ job, failed: true, error }),
        );
        active.add(job);
      }
      const result = await Promise.race(active);
      active.delete(result.job);
      checkCancelled(signal);
      if (result.failed) throw result.error;
      if (cursor > 1024) { queue.splice(0, cursor); cursor = 0; }
      queue.push(...(result.children || []));
    }
  } catch (error) {
    local.abort();
    await Promise.allSettled(active);
    throw error;
  }
}
/** Bound both concurrent requests and their start frequency; page requests remain serial per directory. */
export function requestGate(intervalMs: number): (signal?: AbortSignal) => Promise<void> {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("请求间隔无效。");
  let nextStart = -Infinity;
  let tail = Promise.resolve();
  return signal => {
    const result = tail.then(async () => {
      checkCancelled(signal);
      await pause(Math.max(0, nextStart - performance.now()), signal);
      checkCancelled(signal);
      // Measure the actual start, so a blocked UI thread cannot release several slots at once.
      nextStart = performance.now() + intervalMs;
    });
    tail = result.catch(() => {});
    return result;
  };
}
