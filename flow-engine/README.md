# flow-engine —— 工作流执行引擎载荷（ReqFlow 移植）

本目录是 ReqFlow 工作流执行引擎的 JS 载荷：由 Rust 侧内嵌 QuickJS（rquickjs）
运行，节点请求经 ProxyCrab 既有重放管线真实发起（宿主桥 `host.replay` 回调
Rust）。源码为 TypeScript（`src/**`），经 esbuild 打包为单文件产物并提交入库：

```
pnpm flow:build        # 打包 → crates/proxy-crab-mitm/src/flow/bundle/engine.js
pnpm test:unit         # flow-engine/**/*.test.mts 随仓库单测运行
```

## 来源与版本基线

- 参考实现归档仓库：`_archive/reqflow`（上游 `https://github.com/Particaly/reqflow`，
  已停止维护），基线 commit **`485fa00`**（main）。
- 移植原则「文件级搬移 + 触点替换，不重构」：模块结构、函数签名、中文注释与
  行为契约逐字保留；仅平台触点替换为宿主注入等价物（见下）。
- 测试即验收基线：归档 `src/engine/*.test.ts` 全量搬为 `src/*.test.mts`
  （断言口径零改动；仅 import 路径与个别浏览器 API 桩替换，见下）。
  本目录测试与源码一同作为行为契约资产维护，不回并上游。

## 对外契约（`src/index.ts`）

`runWorkflow`（完整运行入口，装配全部节点 runner）、`evaluateCondition`、
`renderTemplate`、`validateWorkflowGraph`、`buildReplayRequest`、条件编译
（`compileConditionTree` 等）、断言 / 转换 / 循环语义（`createAssertRunner` /
`createTransformRunner` / `createLoopRunner` 等）。

## 模块清单（与归档的对应关系）

| 本目录 | 归档（@ 485fa00） | 说明 |
| --- | --- | --- |
| `executor.ts` `logic-nodes.ts` `dependency-inference.ts` `template.ts` `run-variables.ts` `condition-builder.ts` `assert-nodes.ts` `transform-nodes.ts` `json-path.ts` `json-schema-lite.ts` `csv.ts` `error-class.ts` `run-record.ts` `run-graph-snapshot.ts` `ref-id.ts` `har-cookies.ts` `json-equal.ts` `secret-mask.ts` `script.ts` `script-port.ts` `replay-response.ts` `replay.ts` `header-fidelity.ts` | `src/engine/` 同名文件 | 计划 Task 2 Step 1 清单 + `secret-mask`（`run-record.iterations` 测试与落库脱敏链依赖，随基线一并搬入） |
| `types.ts` | `src/types/{ids,har,model}.ts` | 三文件合并；载荷目录无 `@` 别名，引擎与测试的 `@/types` 引用统一改写为 `./types` |
| `index.ts` | `src/engine/index.ts` | 按计划契约重排（见上）；`runWorkflow` / `evaluateCondition` 为新增契约名 |
| `run-workflow.ts` | （新增；装配语义对齐归档 `background/run-controller`） | `runWorkflow` 主装配 + `createHttpReplayRunner`（宿主桥出站）；归档的装配层在扩展 SW 里、不可移植 |
| `host-env.ts` `cancel-signal.ts` `utf8.ts` `base64.ts` `url-lite.ts` | （新增） | 平台触点的宿主注入等价物（见下） |

## 平台触点替换（Step 2：宿主注入点）

QuickJS 无 DOM / Node / 浏览器 API；归档代码中的环境依赖按「宿主桥提供等价物 +
保守缺省」替换，均在改动处有 `【宿主注入点】` 注释：

| 归档用法 | 载荷替换 | 落点 |
| --- | --- | --- |
| `setTimeout` / `clearTimeout`（重试退避、延时/限速等待） | `host-env.ts` 注入链：缺省惰性取 `globalThis`（单测 fake timers 零改动）；QuickJS 侧由 `run-workflow.ts` 探测全局 `host` 后以 `host.sleep` 组装 | `executor.ts` `logic-nodes.ts` |
| `AbortSignal` / `AbortController`（取消语义） | `cancel-signal.ts`：`CancelSignal` 结构子集 + `createCancelSource` 纯 JS 实现；DOM `AbortSignal` 结构兼容，既有测试直构 `AbortController` 零改动 | `executor.ts` `logic-nodes.ts` |
| `crypto.randomUUID`（runId / 连线 id） | `host-env.ts` 注入链：注入实现 → `globalThis.crypto.randomUUID` → 纯 JS 随机回退 | `executor.ts` `dependency-inference.ts` |
| `TextEncoder` / `TextDecoder`（快照字节计量与截断） | `utf8.ts` 纯 JS 实现（宿主已有原生实现时走快路径，语义一致） | `run-record.ts` `run-graph-snapshot.ts` |
| `atob`（二进制请求体解码） | `base64.ts` 的 `decodeBase64`（非法 base64 同样抛错退化，语义一致）；`encodeBase64` 供出站二进制 body 走 `bodyBase64` JSON 载荷 | `replay.ts` `run-workflow.ts` |
| `new URL` / `URLSearchParams`（origin 提取、URL 区间定位、查询参数枚举） | `url-lite.ts` 纯 JS 子集解析（host 小写 / 缺省端口省略 / opaque origin / urlencoded 解码与 WHATWG 同口径；边界见该文件头） | `header-fidelity.ts` `dependency-inference.ts` |
| MV3 CSP / offscreen 沙箱脚本通道（`script.ts` 的 'blocked' 类别、`script-port`） | 脚本与引擎同一 QuickJS realm，缺省本地 eval 端口（载荷本身已在 Rust 三重上限沙箱内）；`ScriptExecPort` 仍可注入外部通道；'blocked' 分类保留（环境性拒绝语义不变） | `run-workflow.ts` |
| DNR 头注入（Origin / Referer / UA / Cookie 网络层 set） | ProxyCrab 基座由 Rust 重放管线直接发头：决策纯函数保留，`run-workflow.ts` 把决策头并入出站 headers | `header-fidelity.ts` `run-workflow.ts` |
| `background/run-controller`（runner 表装配、事件转发、变量/环境注入） | `run-workflow.ts`（新增装配面，见模块清单） | — |

## 新增依赖

| 依赖 | 版本 | 许可 | 理由 |
| --- | --- | --- | --- |
| `jmespath` | ^0.16.0 | Apache-2.0 | 归档 `transform-nodes.ts` 既有依赖（JMESPath 提取引擎）。选择引入 npm 依赖参与打包而非内联实现：它是 transform 节点的行为契约（`transform-nodes.test.mts` 锁定其投影 / 管道 / 函数语义），自实现必然引入行为分叉；纯 JS 无环境依赖，esbuild 直接打进载荷。许可随分发登记于此（Apache-2.0，copyright Apache Software Foundation / jmespath.js contributors）。 |
| `esbuild` | ^0.25.0 | MIT | 仅构建期（devDependency）：打包载荷单文件产物。 |
| `@types/jmespath` | ^0.15.2 | MIT | 仅类型期（devDependency）。 |

## 与归档的行为差异（有意变更）

1. **测试文件名**：`.test.ts` → `.test.mts`（仓库 vitest 口径），import 的
   `@/types` → `./types`。
2. **`logic-nodes.loop-debug.test.mts`** 一处 `records.at(-1)` 改为下标访问
   （仓库 tsconfig lib 为 ES2020；断言口径不变）。
3. **`script.csp-blocked.test.mts`** 保留：以「替换全局 Function 构造器」模拟
   CSP 拦截，不依赖浏览器环境，QuickJS 语义下同样成立（QuickJS 无 CSP，
   'blocked' 分类仅供环境性拒绝复用）。
4. **未搬入**：`engine.test.ts`（工程基建冒烟，断言的是归档工程 `@/` 别名与
   `APP_NAME`，非引擎行为）；无其余遗漏。

## 后续如何再取上游

上游已停止维护（计划背景），本载荷以「fork 形态」维护（风险 W1 的处置即
登记基线 + 随代码携带测试）。若归档仓库出现新提交需要跟进：

1. `git -C D:\workspace\self\_archive\reqflow log --oneline 485fa00..main -- src/engine src/types` 列出差异提交；
2. 对涉及文件重跑「文件级搬移 + 触点替换」流程（本 README 的触点表即替换清单，
   `rg -n "宿主注入点" flow-engine/src` 可列出全部改动点）；
3. 以本目录既有 `.test.mts` 与新增上游测试共同验收（断言口径冲突时以上游
   行为契约为准并在此登记差异）。

## 载荷运行约束（QuickJS）

- 仅纯 JS + 全局 `host` 宿主桥对象（`replay` / `now` / `log` / `sleep` /
  `emit` / `cancelled`，形状见 `crates/proxy-crab-mitm/src/flow/host.rs`）；
  禁 DOM / Node / 浏览器 API（触点替换即为此约束服务）。
- 产物为 IIFE 单文件（Task 1 运行时以普通脚本 eval 加载，顶层不支持
  import/export；引擎对外契约挂全局 `__flowEngine`）。
- 出站二进制请求体经 `bodyBase64`（base64 文本）进 `host.replay` 的 JSON
  载荷，宿主侧解码后按原始字节发送；响应信封形状对齐计划 Task 3。
- 运行编排（取消 / 进度 / checkpoint / 运行记录落库）由计划 Task 19/20 在
  Rust 侧接线；载荷侧取消语义已按 `CancelSignal` 预留。
