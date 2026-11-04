# Request Workflow (ReqFlow) Reproduction Implementation Plan

> **For agentic workers:** 本计划按阶段（Stage）分批推进，每批内逐个 Task 执行、每个 Step 一行复选框。执行前先读 `AGENTS.md` 与 `docs/runtime-notes.md`；任何新增 `/api/*` 路由必须同步登记权限目录（否则 500）；任何新增页面入口必须由 Backend 能力位决定。

**Goal:** 在 ProxyCrab 上复刻 ReqFlow 的「请求重放工作流」：工作区级请求库 → 项目/流程 → 节点画布编排 → DAG 执行（Rust 侧运行内嵌 JS 引擎）→ 运行记录与运行画布；节点请求经 ProxyCrab 既有代理/重放管线真实发起，无需浏览器扩展。

**Architecture:** 工作流域模型、存储与执行编排落在 `crates/proxy-crab-mitm`（复用 `Workspace` 初始化与迁移链、`ProxyCrab::replay` 出站管线、SQLite 存储形态），管理面（DTO / 路由 / 权限 / Agent 面）落在 `crates/proxy-crab-mgr`；ReqFlow 的 `engine/` 是**零平台依赖的纯逻辑**，整体移植为 JS 载荷，由 Rust 侧内嵌 QuickJS 运行时（rquickjs）执行，重放/存储/事件/取消以宿主函数回调 Rust（宿主桥）；前端在既有浮窗基座上新增请求库、画布、运行记录三类窗口，画布用 `@vue-flow/core`；最后在管理服务上以 **HTTP MCP 端点**（`POST /mcp`，JSON-RPC 2.0）把策展后的工具面暴露给外部 AI，鉴权/权限/审批链全部复用既有体系。

**Tech Stack:** Rust 2024 / Axum / hyper / rusqlite（既有）+ 新增 rquickjs（QuickJS）+ esbuild（JS 载荷打包）；Vue 3 / TypeScript / Vite（既有）+ 新增 `@vue-flow/core`；既有管理 HTTP API + 权限/审批体系；MCP 端点以 JSON-RPC 2.0 over HTTP 自实现（不引入 MCP SDK）。

**参考实现：** 已归档为本地仓库（`_archive/reqflow`，含完整 git 历史，主分支 `main` @ `485fa00`；上游 `https://github.com/Particaly/reqflow`，**已停止维护**）。其 `ROADMAP.md` 是功能权威规格（M0–M18 全部完成，M19/MCP 未实现）；`src/engine/**` 与 `src/**/*.test.*` 是行为契约资产。下文引用 `engine/...` 均指该归档仓库路径。

---

## Agreed contract（已确认决策）

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| 1 | 脚本引擎 | **内嵌 JS 引擎** | 节点前置/后置脚本、条件表达式、引擎逻辑同一运行时；保留 ReqFlow 的 JS 语义，不引入 Lua 版脚本契约 |
| 2 | 引擎落点 | **Rust 侧** | 工作流不依赖前端窗口存活；CLI / Agent / 无人值守可驱动；满足「无 API 不开入口」 |
| 3 | 引擎实现 | **移植 JS 引擎 + Rust 宿主桥** | `engine/` 整体作为 JS 载荷，跑在 rquickjs 里；Rust 只提供宿主能力（重放/存储/事件/取消/计时） |
| 4 | 完成度 | **全量对齐** | ReqFlow 现有全部功能进计划：9 类节点、请求中心（导入/导出/代码生成）、环境变量集、运行画布、批跑与重跑、工作流导入导出 |
| 5 | 重放桥 | **废弃** | 不移植 `reqflow-bridge`（ZTools 插件）、健康心跳、三模式分流；ProxyCrab 桌面端本身即本机网络栈 |
| 6 | 请求来源 | **新建工作区级请求库** | 抓包/Session 里任一请求可「存入请求库」；节点引用库内请求；与 Session 归档/清理解耦 |
| 7 | 画布库 | **`@vue-flow/core`** | 新增前端依赖；节点组件自绘、全部套 `base.css` token 与 13px 基准，不引入其默认主题 |
| 8 | JS 载荷工程 | **`flow-engine/` + 根脚本 esbuild 打包；产物提交入库 + `include_str!` 嵌入** | `cargo build` 独立可用（不依赖先跑 node 构建），沿用 CLI 嵌入 `dist` 的先例 |
| 9 | 存储介质 | **`<workspace>/flow/**` JSON（定义）+ `runs.db` SQLite（运行记录）** | 走既有 schema v3→v4 迁移链；定义用 JSON 便于人工审查与分享 |
| 10 | 运行记录留存 | **无自动清理**（与抓包历史一致） | 后续如需按条数/体积上限清理，另立任务 |
| 11 | MCP 暴露 | **管理服务上的 HTTP MCP 端点 + 策展工具面 + 读/写/执行三档开关** | 见阶段 5（Task 24–26）；鉴权、权限目录、审批窗全部复用既有体系，不新建鉴权机制 |

## 复刻映射（ReqFlow 能力 → ProxyCrab 落点）

| ReqFlow 能力 | ProxyCrab 处置 | 关键资产 |
|---|---|---|
| 请求捕获（DevTools Panel / debugger） | **替换**为代理抓包；「存入请求中心」改为「存入请求库」 | `crates/proxy-crab-mitm/src/proxy/**`、`POST /api/logs/*` |
| 请求中心（列表/过滤/分组/标签/详情） | **复用形态、新建域**：请求库窗口 | `LogTable.vue`、`VirtualList.vue`、`BodyViewer.vue`、`FilterBar.vue` 形态 |
| 请求重放（fetch + DNR 头保真） | **替换**为 `ProxyCrab::replay`：Rust 侧直接发头，无 forbidden header、无需 DNR | `crates/proxy-crab-mitm/src/proxy/replay.rs`、`POST /api/replay`、`ReplayWindow.vue` |
| Cookie 快照 / 自定义携带 | 由请求库条目 + 重放 headers 直接携带（无浏览器 jar 概念） | `src/utils/replay.ts`、`EditableKvTable.vue` |
| 项目 / 流程 / 节点 / 边模型 | **新建**（工作区持久化 + schema v4 迁移） | `crates/proxy-crab-mitm/src/workspace.rs`、`migration.rs` |
| 节点画布（React Flow） | **新建**（Vue Flow + 自绘节点，套 `base.css` token） | 新增 `src/windows/WorkflowEditorWindow.vue` 等 |
| 节点配置抽屉（请求/头/覆盖项/failPolicy/retry/pinnedOutput） | **新建**，请求头表复用 `EditableKvTable.vue` | `ReplayWindow.vue` 的 KV/body 形态 |
| 条件构建器（嵌套分组 + 15 操作符） | **移植**（编译目标仍为 JS 表达式，天然契合内嵌 JS） | `engine/condition-builder.ts` |
| DAG 执行引擎（并行/条件双出口/循环子运行/失败策略/重试/固定输出/重跑闭包） | **移植**（JS 载荷）+ Rust 侧运行编排（调度/取消/进度/checkpoint） | `engine/executor.ts`、`engine/logic-nodes.ts`、`run-controller.ts` |
| 脚本沙箱（offscreen + sandbox iframe + 硬超时） | **替换**为 rquickjs 上下文隔离（指令数/内存/时间上限） | 新增 `crates/proxy-crab-mitm/src/flow/runtime.rs` |
| 模板 `{{ }}`（node/input/var/env 四命名空间） | **移植** | `engine/template.ts` |
| 环境变量集 + 全局变量 + secret 脱敏 | **新建**存储与窗口；脱敏纯函数移植 | `engine/secret-mask.ts`、`storage/env-sets.ts` |
| 运行记录 + 运行画布（图快照/节点快照面板/重跑） | **新建**（SQLite 存运行记录，形态参照 `captures.db`） | `crates/proxy-crab-mitm/src/storage.rs`、`FloatingWindow.vue` |
| 导入（cURL / HAR / Postman） | **新建**（纯函数移植） | `app/pages/requests/{curl-import,har-import,import-convert}.ts` |
| 导出与代码生成（cURL / HAR / Postman / fetch / axios / Python） | **复用+新建**：cURL、HAR 复用既有实现，其余新建 | `src/utils/curl.ts`、`src/utils/har-export.ts` |
| 工作流导入导出（含 refId 迁移与脚本审查） | **新建**（纯函数移植） | `storage/workflow-transfer.ts`、`storage/validate.ts` |
| Agent 面（HTTP API + Skill） | **必做**（仓库硬约定）：新增 API 需同步 Skill 文档/脚本/评测 | `skills/proxycrab/**`、`docs/backend-api.md` |

## 明确不迁移（含理由）

| 项 | 理由 |
|---|---|
| `reqflow-bridge`（ZTools 重放桥）、桥健康心跳、`auto/bridge/browser` 三模式分流 | 决策 5：ProxyCrab 即本机网络栈，Rust 侧不受浏览器 forbidden header 限制，桥要解决的问题不存在 |
| DevTools Panel / `chrome.debugger` / DNR / offscreen / manifest sandbox / `chrome.storage` / IndexedDB / SW 保活与孤儿恢复 | Chrome 平台专有；对应能力由代理抓包、Rust 沙箱、工作区文件 + SQLite、常驻进程替代（R1/R8 类 SW 风险随之消失） |
| i18n 词典（zh/en 双词典） | ProxyCrab 无 i18n 机制、界面文案中文硬编码；保持与仓库一致 |
| Playwright 真机 E2E（扩展装载） | 基站形态不同；改为 Rust 集成测试 + 前端 vitest + 手工真机场景清单（见 Task 25） |
| M19 的宿主/桥侧形态（ZTools 内置 MCP 服务、桥侧工具声明、命令通道与长轮询） | 在新基座上不成立：ProxyCrab 自带管理 HTTP 服务与进程内执行，无需宿主 MCP 与命令通道；其**功能面**（工具暴露、三档开关、审计、导入脚本审查）在**阶段 5** 以 HTTP MCP 端点形态落地 |
| 面板降噪 / 徽标 / 引导 / 主题偏好等扩展外壳特性 | 属 Chrome 扩展外壳；ProxyCrab 有自身的窗口与设置体系 |

## 风险与开放问题

| # | 风险 / 问题 | 处置 |
|---|---|---|
| W1 | 移植的 JS 载荷成为 fork：上游 ReqFlow 已停止维护 | 在载荷目录登记来源与版本基线（`485fa00`）；载荷测试随代码入库，不回并上游 |
| W2 | 重放必须经 Session 管线 → 工作流运行要求代理运行中且存在目标 Session，且运行会产生大量 capture 记录 | 引入「工作流运行专用 Session」策略 + 依赖既有 `TrafficSource::Replay`（`source = "ProxyCrabRequest"`）过滤；运行前显式校验代理状态并给出明确错误 |
| W3 | 现有 `POST /api/replay` 是 fire-and-forget（只回 `log_id`），引擎需要响应出参 | Task 3 增加「等待完成并回传响应信封」的内部通路（复用既有 capture 完成信号），不改既有接口语义 |
| W4 | 内嵌 JS 运行时的取消/超时/内存治理是新的失败面 | 统一以「指令数 + 内存 + 墙钟」三重上限；超时归一到 `timeout` 类错误；宿主桥错误不跨边界抛裸异常 |
| W5 | 运行记录与图快照体积（ReqFlow 三档上限：单快照 256KB / 记录 2MB / 图快照 256KB）在 SQLite 中的增长 | 沿用既有截断自说明结构（`TruncatedSnapshot` 形态）+ 运行记录分页读取 |
| W6 | 工作流可被 Agent 经 HTTP API 触发（写 + 执行） | 新增 action 默认档位：读 `allow`、写 `approval`、删除/执行 `approval`（执行类默认收紧）；运行前二次确认可配置 |
| W7 | 新增 `/api/*` 路由未登记权限目录 → 500 `permission_check_failed` | 每个 API Task 的 Step 内显式包含权限目录登记与契约测试（`crates/proxy-crab-mgr/tests/permission_contract.rs`） |
| W8 | JS 载荷构建链进入 Rust 仓库（TS→单文件 JS） | 复用根 `package.json` 与既有 vitest：载荷源码放 `flow-engine/`，由根脚本打包，产物提交入库并由 Rust 侧 `include_str!` 嵌入；一个 Rust 单测校验载荷可加载并跑通 smoke 流程 |
| W9 | MCP 端点扩大暴露面：工具可触发写与执行，且沿管理服务 `0.0.0.0` 绑定对外 | 鉴权/权限/审批全部复用既有体系（不新建旁路）；策展工具面（脚本/权限/分享/CA/系统日志不暴露）；写与执行缺省关；审批超时按 MCP `isError` 如实返回；工具调用全量审计 |

## 契约状态

原 5 项待确认契约（画布库 / 载荷工程 / 存储介质 / 运行记录留存 / MCP）已全部拍板，结论并入 Agreed contract 表；MCP 的传输形态与工具面在阶段 5 展开。实施中若出现新的设计分叉，按 `AGENTS.md`「不确定先问」处理，不自行决定。

---

## 阶段 1 — 基座准备（Task 1–4）

### Task 1: 内嵌 JS 运行时与宿主桥骨架

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/mod.rs`、`crates/proxy-crab-mitm/src/flow/runtime.rs`、`crates/proxy-crab-mitm/src/flow/host.rs`
- Modify: `crates/proxy-crab-mitm/src/lib.rs`、`crates/proxy-crab-mitm/Cargo.toml`（新增 `rquickjs`）
- Create: `crates/proxy-crab-mitm/tests/flow_runtime.rs`

- [x] **Step 1: 选定运行时并接入**：`rquickjs`（vendored QuickJS），配置内存上限与中断处理器（指令数/墙钟双限），线程模型定为「单运行一个 VM 上下文」，禁止 `io/os` 之外的外部宿主对象进入沙箱。
- [x] **Step 2: 定义宿主函数最小面**：`host.replay`（异步）、`host.now`、`host.log`、`host.sleep`（可中断）、`host.emit`（运行事件）、`host.cancelled`（取消轮询）——全部以显式 JSON 载荷进出，错误归一为 `{kind, message}`。
- [x] **Step 3: 写失败面测试**：死循环（超指令数）、内存爆炸、脚本抛错、宿主函数抛错、取消中断，断言错误分类与 Rust 侧不被拖死。
- [x] **Step 4: 记录运行时约束到 `docs/runtime-notes.md`**（上限值、线程模型、失败分类）。

### Task 2: JS 引擎载荷（ReqFlow `engine/` 移植）与构建链

**Files:**
- Create: `flow-engine/src/**`（自 `_archive/reqflow/src/engine/**` 移植）、`flow-engine/src/index.ts`（对外契约：`runWorkflow`、`evaluateCondition`、`renderTemplate`、`validateWorkflowGraph`、`buildReplayRequest`、条件编译、断言/转换/循环语义）
- Create: `flow-engine/README.md`（来源与版本基线、与上游差异清单）
- Create: `scripts/build-flow-engine.mjs`（esbuild 打包为单文件 ESM）
- Modify: `package.json`（`flow:build` 脚本）、`vitest.config.ts`（include 增加 `flow-engine/**/*.test.mts`）、`tsconfig.json`（include 增加 `flow-engine/**`）、`pnpm format` 的 glob
- Create: `crates/proxy-crab-mitm/src/flow/bundle/engine.js`（构建产物，提交入库）

- [x] **Step 1: 移植纯逻辑模块**：`executor` / `logic-nodes` / `dependency-inference` / `template` / `run-variables` / `condition-builder` / `assert-nodes` / `transform-nodes` / `json-path` / `json-schema-lite` / `csv` / `error-class` / `run-record` / `run-graph-snapshot` / `ref-id` / `har-cookies` / `json-equal`。
- [x] **Step 2: 剥离平台触点**：把 `script.ts` / `replay.ts` / `header-fidelity.ts` 中依赖扩展/浏览器的部分改为宿主接口注入（`ScriptPort` / `ReplayPort` / 头注入策略），保留纯函数部分；`AbortSignal`/`setTimeout` 由宿主桥提供等价物。
- [x] **Step 3: 搬测试**：以 ReqFlow 的既有测试作为验收基线逐条跑通（这是本任务的主要验收口径，不允许「先跳过」）。
- [x] **Step 4: 打包与嵌入**：`pnpm flow:build` 产出单文件；Rust 侧 `include_str!` 嵌入并加 smoke 测试（加载载荷 → 跑通 start→httpReplay（桩宿主）→ 断言节点 → 结束）。
- [x] **Step 5: 登记来源与差异**：`flow-engine/README.md` 写明基线 `485fa00`、被剥离/替换的模块、以及后续如何再取上游。

### Task 3: 同步重放与结果回传（W3）

**Files:**
- Modify: `crates/proxy-crab-mitm/src/proxy/replay.rs`（新增「等待完成」内部通路）
- Modify: `crates/proxy-crab-mgr/src/manager.rs`、`crates/proxy-crab-mgr/src/dto.rs`
- Create: `crates/proxy-crab-mitm/tests/replay_await.rs`

- [x] **Step 1: 设计回传信封**：`{status, statusText, headers, body, bodyType, json?, durationMs, truncated}`，从 capture 完成信号 + blob 读取装配；超时/取消/网络失败归一为错误分类（对齐 ReqFlow `error-class` 的 `timeout|network|http|cancelled|script|blocked|unknown`）。
- [x] **Step 2: 实现内部等待通路**：不动 `POST /api/replay` 的既有语义（仍回 `log_id`），在 flow 域内提供「等待响应」的调用入口。
- [x] **Step 3: 边界**：4xx/5xx **不算失败**（按 ReqFlow 语义交由上层判定）、响应体超限截断并标记、代理未运行/ Session 不存在给出明确错误码。
- [x] **Step 4: 测试**：正常响应、4xx、超时、取消、代理停止、大 body 截断。

### Task 4: 工作区 schema v4 与 flow 存储骨架

**Files:**
- Modify: `crates/proxy-crab-mitm/src/workspace.rs`（初始化 `flow/` 目录族）、`crates/proxy-crab-mitm/src/migration.rs`（v3→v4）
- Create: `crates/proxy-crab-mitm/src/flow/store.rs`（请求库 / 流程定义 / 环境变量集的读写与原子替换）

- [x] **Step 1: 目录布局定案并落地**：`<workspace>/flow/{request-library/**, workflows/**, env-sets.json, runs.db}`；沿用既有原子写与独占锁约定。
- [x] **Step 2: 迁移链 v3→v4**：老工作区打开时原子推进；无旧数据时仅建目录，不写空文件。
- [x] **Step 3: 读写 API**：请求库条目、流程定义、环境变量集的最小 CRUD（Rust 侧，供后续任务复用），带形状校验与失败降级（对齐 ReqFlow `storage/validate.ts` 的读时校验口径）。
- [x] **Step 4: 测试**：迁移幂等、并发写、损坏文件降级、schema 版本推进。

---

## 阶段 2 — 请求库（复刻「请求中心」，Task 5–9）

### Task 5: 请求库模型与存储

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/request_library.rs`
- Create: `crates/proxy-crab-mitm/tests/request_library.rs`

- [x] **Step 1: 条目模型**：`{id, name, tags[], source('capture'|'import'|'manual'), origin, har: HarSnapshot, bodyRef?, createdAt, updatedAt}`；HAR 快照字段对齐 `engine/replay.ts` 的消费口径（method/url/headers/queryString/cookies/postData + response 摘要）。
- [x] **Step 2: body 存 blob**（二进制/大体积走文件，沿用既有 `CaptureBodyWriter` 形态），JSON 索引与 body 分离。
- [x] **Step 3: 从抓包入库**：`capture_id → 条目`，做形状归一（`engine/har-cookies.ts` 的 cookie 归一逻辑移植），默认命名 `method host+path`。
- [x] **Step 4: 测试**：入库/删除/标签/命名去重/大 body 截断策略。

### Task 6: 请求库 API 与权限登记（W7）

**Files:**
- Modify: `crates/proxy-crab-mgr/src/http.rs`、`crates/proxy-crab-mgr/src/dto.rs`、`crates/proxy-crab-mgr/src/manager.rs`、`crates/proxy-crab-mgr/src/permission.rs`
- Modify: `crates/proxy-crab-mgr/tests/permission_contract.rs`

- [x] **Step 1: 路由**：`GET/POST /api/request-library`、`GET/PUT/DELETE /api/request-library/{id}`、`POST /api/request-library/from-capture`、`GET /api/request-library/{id}/body`。
- [x] **Step 2: 权限目录登记**：读 `allow`、写 `approval`、删 `approval`（并更新 `docs/backend-api.md`）。
- [x] **Step 3: 契约测试**：权限契约 + DTO 形状（含分页与上限）。
- [x] **Step 4: 分享面**：`share-backend.ts` 明确不实现（自动隐藏入口）。

### Task 7: 请求库窗口

**Files:**
- Create: `src/windows/RequestLibraryWindow.vue`、`src/components/request-library/*.vue`
- Modify: `src/api/backend.ts`、`src/api/tauri-backend.ts`、`src/api/http-backend.ts`、`src/api/types.ts`、`src/windows/launcher.ts`、`src/components/AppToolbar.vue`

- [x] **Step 1: Backend 能力位**：`requestLibrary*` 可选方法（无则不显示入口）。
- [x] **Step 2: 列表**：关键字/标签/来源过滤、分组（标签/域名）、排序、批量删除、来源徽标（抓包入库/导入/手工）。
- [x] **Step 3: 详情**：Headers / Query / Body / Response 四 tab（复用 `BodyViewer.vue` 与既有 KV 展示形态）。
- [x] **Step 4: 入库入口**：日志详情与日志表右键「存入请求库」（复用 `ContextMenu.vue`）；冲突/重名提示。
- [x] **Step 5: 与仓库风格对齐**：`base.css` token、13px 基准、高信息密度；窗口标题与文案中文。

### Task 8: 导入（cURL / HAR / Postman）

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/import.rs`（或前端 `src/utils/request-library-import.ts`，视纯函数归属）
- Modify: `src/windows/RequestLibraryWindow.vue`（导入入口）

- [x] **Step 1: 移植 cURL 解析**（`app/pages/requests/curl-import.ts` 语义：`-H/-X/-d/--data-*/-F/-b/-u/-G/-I/-A/-e`、引号与续行、方法推断）。
- [x] **Step 2: 移植 HAR 解析**（body 64KB 安全截断）与 Postman Collection v2.1 解析。
- [x] **Step 3: 导入对话框**：粘贴/文件、预览条目、标签与去重策略。
- [x] **Step 4: 往返测试**：导出产物可回灌（与 Task 9 交叉验证）。

### Task 9: 导出与代码生成（六格式）

**Files:**
- Create: `src/utils/request-export.ts`（移植 `app/pages/requests/request-export.ts`）+ `src/utils/request-export-download.ts`
- Modify: `src/windows/RequestLibraryWindow.vue`、可选 `crates/proxy-crab-mgr/src/flow_export.rs`

- [x] **Step 1: 复用既有实现**：cURL（`src/utils/curl.ts`）、HAR（`src/utils/har-export.ts` 的逐条生成形态）适配单条请求条目。
- [x] **Step 2: 新建**：Postman v2.1、fetch、axios、Python requests（含二进制 body 字节级重建与长字符串分块）。
- [x] **Step 3: UI**：「导出为…」菜单 + 下载（桌面走既有 `saveFile` 通路）。
- [x] **Step 4: 测试**：六格式快照测试 + 二进制 body + 无 body/params 回退。

---

## 阶段 3 — 工作流模型与画布（Task 10–18）

### Task 10: 工作流域模型与持久化

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/model.rs`、`crates/proxy-crab-mitm/src/flow/validate.rs`
- Modify: `crates/proxy-crab-mitm/src/flow/store.rs`

- [x] **Step 1: 模型**：`Project`、`Workflow{nodes, edges, variables, secretVariables}`、`WorkflowNode{type, position, config, label?, refId?}`、`WorkflowEdge{source, target, sourceHandle?: 'true'|'false'}`；9 类节点的 `NodeConfig` 字段级对齐 ReqFlow（含 `override/headerFidelity/cookieMode/expression/condition/items/assignments/assertions/extractions/retry/pinnedOutput`）。
- [x] **Step 2: 校验口径**：图校验（唯一 start、refId 流程内唯一、边端点存在、便签不可连线）+ `failPolicy` 合法值；校验失败在建单前直接判失败。
- [x] **Step 3: 版本与迁移**：流程定义带 `schemaVersion`，为后续字段演进留迁移入口（refId 读时迁移参照 `WorkflowRepo.get` 语义）。
- [x] **Step 4: 测试**：模型往返、校验用例、旧数据归一。

### Task 11: 工作流 API 与权限登记

**Files:**
- Modify: `crates/proxy-crab-mgr/src/{http.rs,dto.rs,manager.rs,permission.rs}`
- Modify: `docs/backend-api.md`

- [x] **Step 1: 路由**：项目/流程 CRUD、图保存（整体替换）、`POST /api/workflows/{id}/validate`。
- [x] **Step 2: 权限登记**：读 `allow`、写 `approval`、删 `approval`。
- [x] **Step 3: 契约测试** + 分享面不实现。

### Task 12: 画布窗口骨架

**Files:**
- Create: `src/windows/WorkflowEditorWindow.vue`、`src/components/flow/{Canvas.vue,NodeShell.vue}`、`src/styles/flow.css`
- Modify: `package.json`（新增 `@vue-flow/core`）、`src/windows/launcher.ts`、`src/components/AppToolbar.vue`

- [x] **Step 1: 依赖接入**：`@vue-flow/core` + 自定义节点组件（不引入其默认主题，全部套 `base.css` token 与 13px 基准）。
- [x] **Step 2: 三栏骨架**：左侧流程列表 / 中间画布 / 右侧配置抽屉（抽屉形态复用既有浮窗内嵌面板约定）。
- [x] **Step 3: 保存与脏标记**：显式保存 + 离开守卫（对齐仓库「无自动保存」惯例）。

### Task 13: 画布交互

**Files:**
- Modify: `src/components/flow/Canvas.vue`、新增 `src/components/flow/{NodePanel.vue,CanvasToolbar.vue,node-issue-badge.ts,auto-layout.ts,graph-history.ts,node-clipboard.ts}`
- Create: `src/components/flow/*.test.mts`（纯函数部分）

- [x] **Step 1: 编辑**：拖入节点面板、连线（条件节点真/假双出口带标签）、框选/多选、删除、双击重命名、拖线到空白弹添加菜单并自动连线。
- [x] **Step 2: 视图**：缩放/平移/小地图/自动布局/对齐辅助线/视口持久化（按流程 id）。
- [x] **Step 3: 一致性**：撤销/重做（图快照历史）、复制/粘贴（剪贴板）、常驻校验徽标（error/warn/info 三级）。
- [x] **Step 4: 运行期锁定**：运行中拦截结构性编辑（粘贴/撤销/删除/drop/连线）并给单例提示。
- [x] **Step 5: 测试**：自动布局、图历史、剪贴板、校验徽标纯函数。

### Task 14: 节点配置面（请求类）

**Files:**
- Create: `src/components/flow/config/{ReplayNodeConfig.vue,RequestPicker.vue,HeaderRows.vue,FidelityModeControl.vue,CookieModeControl.vue,RetryFields.vue,RefIdField.vue}`
- Modify: `src/windows/WorkflowEditorWindow.vue`

- [x] **Step 1: 请求选择器**：从请求库挑选（搜索/标签/预览），支持手工请求（等价 `ReplayWindow` 的 body 三态：文本 / 引用请求库 body / 工作区资产）。
- [x] **Step 2: 覆盖项**：method/url/headers/removedHeaders/body；头行复用 `EditableKvTable.vue` 形态，带「删除 / 插入模板引用 / 插入环境变量」行内菜单。
- [x] **Step 3: 保真与 Cookie**：`headerFidelity{origin,referer,userAgent}` 每项「捕获值 / 自定义」二态；`cookieMode` 快照/自定义 + 值编辑。
- [x] **Step 4: 其余字段**：`timeoutMs`、`failPolicy`、`retry{maxAttempts,backoffMs,multiplier}`、`pinnedOutput`（含清除）、`refId` 编辑（5 位短码、流程内唯一、可改）。

### Task 15: 模板引用、表达式输入与 IO 面板

**Files:**
- Create: `src/components/expression-input/*`（移植 ReqFlow 的建议弹窗 + 实时预览形态）、`src/components/flow/{NodeIoDrawer.vue,template-dnd.ts}`
- Modify: `src/components/flow/config/*`

- [x] **Step 1: 模板语义对齐**：四命名空间（`node.<refId>.<path>` / `input` / `var` / `env`）+ 裸路径与 `$json` 别名；渲染永不因缺数据失败（空串 + 分类 warning）。
- [ ] **Step 2: 表达式输入**：建议（深路径补全、样本深度/条数上限）、防抖求值预览、缺失引用告警展示。
- [ ] **Step 3: IO 面板**：节点入参/出参字段树、chip 复制、**拖拽映射**（自定义 MIME）、路径截断与搜索、试跑结果标注。
- [ ] **Step 4: 试跑入参**：编辑器内试跑的结果并入会话态，供下游节点预览。

### Task 16: 逻辑节点配置（条件构建器 / 循环 / 延时 / 变量 / 断言 / 转换）

**Files:**
- Create: `src/components/flow/config/{ConditionBuilder.vue,LoopConfig.vue,DelayConfig.vue,SetVariableConfig.vue,AssertConfig.vue,TransformConfig.vue,StickyNoteConfig.vue}`
- Modify: `src/components/flow/config/*`

- [ ] **Step 1: 条件构建器**：递归分组树（且/或 + 整组取反 + 增删）、15 操作符、右值类型收敛；保存时编译为 `expression`（编译逻辑在载荷里，前端只编辑树）。
- [ ] **Step 2: 循环**：items / maxIterations / CSV 文本与分隔符 / 并发度 / 间隔；表单校验与上限提示（并发需隔离变量作用域门控）。
- [ ] **Step 3: 其余节点表单**：延时（上限校验）、变量赋值（来源四态与路径）、断言规则（status/jsonPath/schema）、转换提取（jsonPath/jmespath）、便签（文本/颜色/尺寸）。
- [ ] **Step 4: 测试**：条件树往返（树 ⇄ 表达式）、各表单校验边界。

### Task 17: 环境变量集与全局变量

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/env_sets.rs`、`src/windows/EnvSetsWindow.vue`
- Modify: `crates/proxy-crab-mgr/src/{http.rs,permission.rs}`、`src/components/AppToolbar.vue`

- [x] **Step 1: 存储**：环境变量集（版本化信封 + 迁移注册表）+ 全局变量/secret 变量；secret 全链路脱敏与导出剔除（移植 `engine/secret-mask.ts`）。
- [x] **Step 2: API + 权限**：集合 CRUD、激活集切换、脚本写回入口；读 `allow`、写 `approval`。
- [x] **Step 3: 窗口**：集合 CRUD/复制/删除、kv 编辑（secret 掩码）、一键激活（删除激活集自动清偏好）。
- [x] **Step 4: 运行期写回语义**：脚本 env 写回双写（运行快照立即更新 + 派发时落库）、串行队列、硬超时下已提交写回不回滚（与 ReqFlow 一致并在文档披露）。

### Task 18: 脚本编辑器与试跑

**Files:**
- Create: `src/components/flow/config/ScriptEditor.vue`、`src/components/flow/dry-run.ts`
- Modify: `crates/proxy-crab-mgr/src/{http.rs,permission.rs}`（试跑端点）

- [x] **Step 1: 编辑器**：Monaco（复用 `MonacoEditor.vue`）+ 前置/后置脚本骨架与上下文提示（pre：`input` → 覆盖对象；post：`response` → 返回出参）。
- [x] **Step 2: 试跑**：与执行链路同走宿主 JS 运行时（不建档、不落库、不广播），返回结果与错误分类。
- [x] **Step 3: 安全**：脚本超时（默认 5s）与指令/内存上限；错误分类 `syntax|blocked|runtime|timeout|invalid-return` 完整映射到 UI 文案。
- [x] **Step 4: 权限**：试跑 action 登记（`approval`），脚本内容不写入日志。

---

## 阶段 4 — 执行引擎与运行记录（Task 19–23）

### Task 19: 运行编排（Rust 侧）

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/run.rs`、`crates/proxy-crab-mitm/src/flow/run_store.rs`
- Modify: `crates/proxy-crab-mgr/src/{http.rs,permission.rs,manager.rs}`

- [x] **Step 1: 运行生命周期**：建单（`running` + 图快照）→ 逐节点 checkpoint → 定稿；运行注册表与取消（AbortController 等价物，取消优先于失败）。
- [ ] **Step 2: 进度事件**：节点级与运行级事件经既有变更广播机制推送到前端（复用 `proxycrab://http-api-change` / `/ui-api/changes` 形态）。
- [x] **Step 3: 前提校验**：代理运行中、目标 Session 存在、工作流图合法；不满足时明确报错不建单（或在建单后立即失败并给出原因）。
- [x] **Step 4: 写队列**：逐 run 串行化写回，防 checkpoint 交叠丢失；定稿排在挂起写之后。
- [x] **Step 5: 测试**：取消、并行度、写队列交错、进程重启后孤儿 `running` → `interrupted`（常驻进程下对应「重启扫描收敛」）。

### Task 20: 图执行语义落地（载荷侧收口）

**Files:**
- Modify: `flow-engine/src/**`（executor / logic-nodes 的宿主适配）
- Create: `crates/proxy-crab-mitm/tests/flow_semantics.rs`

- [x] **Step 1: 调度语义**：节点级并行（默认 4，可配）、每节点一次运行内至多执行一次、join 门槛（全部直接上游已结算）、确定性批内记录序。
- [x] **Step 2: 分支路由三套并存**：出边手柄 > legacy 清单 > 直通（「未带手柄的出边照常放行」必须保留）。
- [x] **Step 3: 循环**：循环体识别（Kahn 准入）、递归子运行、逐轮变量作用域、汇点聚合、迭代明细上限、取消时已完成轮次照常结算。
- [x] **Step 4: 其余语义**：失败策略 stop/continue、重试（仅同步求值类）、固定输出绕过执行、指定节点重跑（上游闭包预置 + 缺失即建单前失败）、循环单迭代重跑。
- [x] **Step 5: 端到端语义测试**：以桩宿主（假重放）覆盖上述全部路径，逐条对齐 ReqFlow 既有测试命名与断言口径。

### Task 21: 运行记录存储与体积控制

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/run_record.rs`
- Modify: `crates/proxy-crab-mitm/src/flow/run_store.rs`

- [ ] **Step 1: runs.db schema**：运行主表 + 节点运行表（含 loop 迭代明细），索引按 `workflowId` / `startedAt`。
- [ ] **Step 2: 快照三档**：单快照 256KB、整条记录 2MB、图快照 256KB；超限逐级收紧并**自说明截断**（`TruncatedSnapshot` 形态 + 尾部标记），读侧可识别。
- [ ] **Step 3: 图快照契约**：深拷贝零共享引用、恒剥离 `pinnedOutput`、超限降级为骨架并标记。
- [ ] **Step 4: 测试**：截断幂等、字节口径（UTF-8 边界）、降级披露字段。

### Task 22: 运行记录窗口与运行详情（运行画布）

**Files:**
- Create: `src/windows/{RunHistoryWindow.vue,RunDetailWindow.vue}`、`src/components/flow/{RunGraphView.vue,NodeRunPanel.vue}`
- Modify: `src/api/*`、`src/windows/launcher.ts`

- [ ] **Step 1: 运行列表**：分页、按流程/状态筛选、状态与触发方式徽标。
- [ ] **Step 2: 运行详情**：只读运行画布（按图快照还原；旧记录回落当前流程并提示；快照降级明确披露）+ 节点状态着色（interrupted 中停留 running 的节点按中性档）。
- [ ] **Step 3: 节点快照面板**：入参/返回值 JSON 查看器（移植 `json-tree` 形态）、固定输出、逐迭代列表、「从此起重跑」「重跑该轮」「在编辑器打开」。
- [ ] **Step 4: 运行入口**：编辑器「运行」按钮、工具栏快捷入口、运行中画布锁定与取消按钮（含 SW 回收类滞留问题的对应处置——常驻进程下仅需处理运行中止广播丢失）。

### Task 23: 工作流导入导出

**Files:**
- Create: `crates/proxy-crab-mitm/src/flow/transfer.rs`、`src/windows/WorkflowTransferWindow.vue`（或并入画布窗口）
- Modify: `crates/proxy-crab-mgr/src/{http.rs,permission.rs}`

- [x] **Step 1: 导出**：流程 + 引用到的请求库条目 + 环境变量集（secret 剔除）；格式带版本号。
- [x] **Step 2: 导入**：形状校验、refId 读时迁移、脚本逐条确认（缺省置空脚本）、冲突裁决（重名/refId 冲突）。
- [x] **Step 3: 与 Agent 面一致**：导入需显式 `confirmScripts` 语义（对齐 ReqFlow M19 的安全口径）。
- [ ] **Step 4: 测试**：往返一致、拒绝畸形输入、secret 不泄漏。

---

## 阶段 5 — MCP 暴露（Task 24–26）

### Task 24: MCP 端点骨架与鉴权接线

**Files:**
- Create: `crates/proxy-crab-mgr/src/mcp.rs`、`crates/proxy-crab-mgr/src/mcp/protocol.rs`
- Modify: `crates/proxy-crab-mgr/src/http.rs`、`crates/proxy-crab-mgr/src/permission.rs`、`crates/proxy-crab-mgr/src/dto.rs`、`docs/backend-api.md`

- [ ] **Step 1: `POST /mcp` 端点**：JSON-RPC 2.0 自实现（不引入 MCP SDK），覆盖 `initialize` / `tools/list` / `tools/call`；请求期无状态，每请求独立鉴权。
- [ ] **Step 2: 鉴权接线**：复用既有身份体系（`LocalLoopback` 或 `Bearer`），**不新建鉴权机制**；`POST /mcp` 自身登记为权限目录 action。
- [ ] **Step 3: 逐次鉴权与审批**：工具调用按「被映射的路由」逐次走 `allow/approval/deny`（更严者生效），审批复用桌面审批窗；审批超时/被拒按 MCP 语义回 `isError` 与可读原因，不静默降级。
- [ ] **Step 4: 边界**：工具超时、并发上限、客户端断开即取消底层运行；错误不泄漏内部路径与凭据。
- [ ] **Step 5: 测试**：初始化握手（含协议版本协商）、未授权、审批超时、未知工具/参数、畸形 JSON-RPC、断连取消。

### Task 25: 策展工具面与三档开关

**Files:**
- Create: `crates/proxy-crab-mgr/src/mcp/tools.rs`
- Modify: `crates/proxy-crab-mgr/src/permission.rs`、`src/windows/SettingsWindow.vue`、`crates/proxy-crab-mitm/src/flow/store.rs`（档位持久化）

- [ ] **Step 1: 工具清单（策展子集）**：抓包读取（会话列表 / 日志 ID 查询 / 日志详情 / body）、请求库（列表 / 详情 / 从抓包入库）、工作流（列表 / 详情 / 保存 / 校验）、运行（触发 / 取消 / 运行记录查询）。**不暴露**：脚本库、权限管理、分享、CA、系统日志、bypass、脱敏库。
- [ ] **Step 2: 三档开关**：读（缺省开）/ 写 / 执行（缺省关），工作区持久化；与权限目录协同（更严者生效）。
- [ ] **Step 3: 工具 schema**：入参/返回值与既有 DTO 一一对应；读类工具强制分页与体积上限（防一次拉爆），越界即拒绝并说明。
- [ ] **Step 4: 审计**：工具调用记录（工具名 / 身份 / 参数摘要 / 结果 / 审批决策 / 时间）落工作区并可从既有窗口查询；内容脱敏沿用既有 redaction 绑定。
- [ ] **Step 5: 测试**：档位矩阵（关闭时 `tools/list` 不出现 **且** `tools/call` 硬拒，两层都测）、越界参数、审计落库。

### Task 26: MCP 文档与评测

**Files:**
- Create: `docs/mcp.md`
- Modify: `skills/proxycrab/evals/evals.json`、`README.md`

- [ ] **Step 1: 接入文档**：客户端配置片段、工具清单与档位说明、审批链行为、安全边界与已知限制。
- [ ] **Step 2: 评测用例**：以 MCP 工具调用驱动的端到端场景（如「查最近失败请求 → 入库 → 建两节点流程 → 运行 → 汇报结果」）。
- [ ] **Step 3: 与 ReqFlow M19 对账**：逐条比对 DD-10 / M19-T1..T7（工具暴露、三档开关、审计、导入脚本审查），显式声明不适用项（宿主 MCP、桥侧工具声明、命令通道、长轮询）。

## 阶段 6 — 收口（Task 27–28）

### Task 27: Agent 面与文档同步（仓库硬约定）

**Files:**
- Modify: `skills/proxycrab/SKILL.md`、`skills/proxycrab/references/http-api.md`、`skills/proxycrab/references/best-practices.md`
- Create: `skills/proxycrab/scripts/{request-library-*.mjs,workflow-*.mjs,run-*.mjs}`
- Modify: `skills/proxycrab/evals/evals.json`、`docs/backend-api.md`、`docs/runtime-notes.md`、`README.md`

- [ ] **Step 1: 脚本**：请求库入库/查询、工作流 CRUD、运行与取消、运行记录查询（含 `log-wait.mjs` 式轮询形态）。
- [ ] **Step 2: 文档**：`http-api.md` 补全新端点与权限档位；`best-practices.md` 补「Agent 驱动工作流」的推荐姿势与风险（写/执行默认审批）；`SKILL.md` 链接 `docs/mcp.md` 并说明 MCP 与 HTTP API 是同一权限体系与同一审批链。
- [ ] **Step 3: 评测**：`evals.json` 增加可判定的评测用例（如「从指定 capture 建请求库条目并跑通一个两节点流程」）。
- [ ] **Step 4: README**：能力清单与截图位。

### Task 28: 端到端验收

**Files:**
- Create: `crates/proxy-crab-mitm/tests/flow_e2e.rs`、`docs/flow-acceptance.md`（手工真机场景清单）

- [ ] **Step 1: 自动化**：Rust 集成测试跑通「建请求库条目 → 建流程（请求 + 条件 + 循环 + 断言）→ 运行 → 校验运行记录与图快照」；前端 vitest 覆盖纯函数与窗口启动契约。
- [ ] **Step 2: 门禁**：`cargo check --workspace` / `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` / `pnpm build` / `pnpm test:unit` / `pnpm format` 全绿。
- [ ] **Step 3: 手工场景清单**（`docs/flow-acceptance.md`）：真实流量入库并重放、头保真（Origin/Referer/UA 与 Cookie 快照）、条件真/假走向、循环并发与取消、脚本写回环境变量、运行中断与重启收敛、Agent 经 HTTP API 触发工作流（审批链）、**外部 AI 经 MCP 触发工作流（档位与审批链）**、导入导出往返。
- [ ] **Step 4: 三面对账**：逐条比对 ReqFlow `ROADMAP.md` 的功能面（M0–M18）、**M19/MCP 功能面**（阶段 5 已逐条对账，此处复核）与 `明确不迁移` 清单，确认无遗漏项；把结论回写本计划（勾选状态）。
