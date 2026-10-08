import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/dashboard.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
for (const file of ["manifest.json", "dashboard.html", "styles.css"]) {
  await Bun.write(`dist/${file}`, Bun.file(`public/${file}`));
}
console.log(`扩展构建完成：加载 ${resolve("dist")}`);
