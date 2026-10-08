import { createRoot, scanDirectory } from "../src/scan-engine";
import type { DiskAdapter, Entry } from "../src/types";

const count = 12;
const latencyMs = 80;
const entry = (path: string, directory: boolean): Entry => ({ id: path, name: path.slice(1), path, isDirectory: directory, size: directory ? 0 : 1024 });
async function measure(label: string, options: Parameters<typeof scanDirectory>[2]) {
  let active = 0, maximum = 0, requests = 0;
  const adapter: DiskAdapter = { async list(path) {
    active++; maximum = Math.max(maximum, active); requests++;
    await Bun.sleep(latencyMs);
    active--;
    return { entries: path === "/" ? Array.from({ length: count }, (_, i) => entry(`/dir${i}`, true)) : [entry(path + "/file.bin", false)], hasMore: false };
  } };
  const start = performance.now();
  const root = createRoot();
  await scanDirectory(root, adapter, options);
  const elapsed = Math.round(performance.now() - start);
  if (root.size !== count * 1024 || root.status !== "complete") throw new Error("基准结果不完整或大小错误");
  console.log(`${label}: ${elapsed} ms; logical requests=${requests}; peak concurrency=${maximum}; exact bytes=${root.size}`);
  return elapsed;
}
console.log(`本地模拟基准：${count} 个子目录，每次列表响应延迟 ${latencyMs} ms；不是百度服务器测速。`);
await measure("旧版串行设置", { delayMs: 350, concurrency: 1 });
await measure("新版默认设置", {});
