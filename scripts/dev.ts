import "./build";
import { resolve, sep } from "node:path";

const root = resolve("dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3210,
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.pathname === "/" ? "dashboard.html" : decodeURIComponent(url.pathname.slice(1));
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});
console.log(`界面预览：${server.url}（仅本地演示数据；真实网盘需要加载扩展）`);
