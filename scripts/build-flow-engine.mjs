// flow-engine JS 载荷构建（ReqFlow 复刻计划 Task 2 Step 4）。
// 用 esbuild 把 flow-engine/src/index.ts 打包为单文件（target es2022，不压缩
// 以保持产物可审查），产物提交入库并由 Rust 侧 include_str! 嵌入：
//   crates/proxy-crab-mitm/src/flow/bundle/engine.js
// 格式为 IIFE（globalName __flowEngine）：Task 1 的 FlowRuntime 以「普通脚本
// eval」加载载荷（顶层 eval 不支持 import/export 语法，异步入口统一 async IIFE），
// 故产物必须是不含模块语法的单文件脚本，IIFE 返回值挂到全局 __flowEngine。
// platform: 'neutral' —— 不注入 Node / 浏览器内建（Buffer / process 等），
// 与「载荷仅纯 JS + 宿主桥注入的 host 对象」的约束一致（运行环境 QuickJS）。
import { build } from "esbuild";

const outfile = "crates/proxy-crab-mitm/src/flow/bundle/engine.js";

const result = await build({
  entryPoints: ["flow-engine/src/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "__flowEngine",
  target: "es2022",
  platform: "neutral",
  // neutral 平台不读默认 main 字段，显式给出解析顺序（jmespath 为 CJS 包，
  // 无 module/exports 字段——esbuild 打包时转为载荷内联模块）
  mainFields: ["module", "main"],
  minify: false,
  sourcemap: false,
  legalComments: "inline",
  outfile,
  logLevel: "info",
});

if (result.errors.length > 0) {
  console.error("flow-engine bundle failed");
  process.exit(1);
}
console.log(`flow-engine bundle written to ${outfile}`);
