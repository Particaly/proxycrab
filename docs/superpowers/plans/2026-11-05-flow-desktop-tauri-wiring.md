# Flow Desktop Tauri Wiring Implementation Plan

> **For agentic workers:** 本计划按阶段（Stage）分批推进，每批内逐个 Task 执行、每个 Step 一行复选框。执行前先读 `AGENTS.md` 与 `docs/runtime-notes.md`。桌面 Tauri 命令是信任面操作：直调 `state.manager().xxx()` 薄包装，不经 HTTP 鉴权/审批（与 env-sets / request-library 先例一致），禁止在命令层新增业务逻辑。命令名在本计划内冻结；实现时如必须更名，先回写本计划再继续。

**Goal:** 把已完成的请求工作流域（主计划 `2026-11-03-request-workflow-reproduction.md` Task 1–28 全绿）接到桌面 Tauri 命令层，使桌面端出现并可用「工作流」「工作流导入导出」「运行记录」入口（工作流编辑器 / 运行画布 / 导入导出 / 脚本试跑），以及设置窗口的「MCP 暴露」「MCP 调用审计」分区。

**Background（缺口成因）:** 主计划各 Task 的前端接线只落在 `http-backend.ts`（CLI 浏览器端）；桌面 `tauri-backend.ts` 仅接了 `requestLibrary`。已核实：manager trait（`crates/proxy-crab-mgr/src/manager.rs:300-398`）已具备全部 flow 方法；前端类型（`src/api/types.ts`）、窗口（`WorkflowEditorWindow` / `WorkflowTransferWindow` / `RunHistoryWindow` / `RunDetailWindow` / `EnvSetsWindow`）与工具栏入口（`src/components/AppToolbar.vue` 按能力位 `v-if` 门控）全部就绪。缺口仅在「Rust 命令层 + 前端映射」，UI 组件零改动。

**Agreed decisions（2026-11-05 与用户确认）:**

| # | 决策 | 结论 |
|---|---|---|
| 1 | 范围 | 包含 MCP 档位/审计桌面接线（Task 5） |
| 2 | 进度事件降级 | 管理 HTTP 服务未启动时桌面无实时进度（运行记录窗口手动刷新兜底），接受并登记文档 |
| 3 | 桌面信任面 | Tauri 命令不走权限/审批链（既有先例：`create_env_set` 等） |
| 4 | UI 零改动 | `AppToolbar` / `launcher.ts` / 窗口组件不动，能力位出现即显示入口 |
| 5 | CRUD 变更广播 | flow 项目/流程 CRUD 维持现状不发变更事件（HTTP 层同样未发，两端口径一致）；编辑器以打开/手动刷新为准，如后续需要另立任务 |

## 参考范本（实现前先读）

- 桌面命令薄包装与 handler 注册：`src-tauri/src/lib.rs` 的 `get_env_sets` / `get_request_library_page` 命令族（含 dto 导入与 `invoke_handler` 列表）
- 前端能力位映射范本：`src/api/tauri-backend.ts` 的 `requestLibrary`（约 337–359 行）；invoke 参数 camelCase、命令名 snake_case
- CLI 端对照实现（方法集与返回形状）：`src/api/http-backend.ts` 的 `workflows` / `flowRuns` / `flowScriptDryRun` / `mcpTiers` / `mcpAudit`（约 462–588 行）
- HTTP 契约（camelCase 线格式、错误码）：`docs/backend-api.md`「Workflow projects and definitions」「Workflow runs」「MCP exposure tiers」「MCP tool call audit」
- 变更事件桥（运行进度自动到达桌面，零代码）：`src-tauri/src/lib.rs` 约 1269 行起（`http.subscribe_changes()` → `proxycrab://http-api-change`）
- trait 方法全集：`crates/proxy-crab-mgr/src/manager.rs:300-398`

## 明确不做

- 不改管理 HTTP API 路由、权限目录、分享面与 `skills/proxycrab/` 契约（桌面接线不触碰 HTTP 面；Task 6 仅核对文档）。
- 不补 flow 项目/流程 CRUD 的变更广播（决策 5）。
- 不做运行记录清理/留存上限（主计划决策 10）。
- 不改窗口组件与工具栏（决策 4）。

---

## 阶段 1 — Rust 命令层（`src-tauri/src/lib.rs`，Task 1–3 同文件建议串行）

### Task 1: flow 项目 / 流程 / 导入导出命令

**Files:**
- Modify: `src-tauri/src/lib.rs`（命令 + `proxy_crab_mgr::dto` 与 `proxy_crab_mitm::flow` 类型导入 + handler 注册）

- [x] **Step 1: 项目 5 命令**：`list_flow_projects`（分页参数缺省 Default）→ trait `flow_projects(FlowListQuery)`；`create_flow_project` / `get_flow_project` / `update_flow_project` / `delete_flow_project` → trait 同名族方法（`FlowProjectCreateRequest` / `FlowProjectUpdateRequest`）。
- [x] **Step 2: 流程 6 命令**：`list_workflows`（`WorkflowListQuery`，含 `projectId` 必填过滤）→ `workflows`；`create_workflow` → `create_workflow(WorkflowCreateRequest)`；`get_workflow` → `workflow(id)`；`save_workflow_graph` → `update_workflow(id, WorkflowUpdateRequest)`（图整体替换语义已在 trait 内，`nodes`+`edges` 必须成对）；`delete_workflow` → `delete_workflow`；`validate_workflow` → `validate_workflow`（返回 issues 列表）。
- [x] **Step 3: 导入导出 2 命令**：`export_workflows(ids: Vec<String>)` → trait `export_workflows`，返回 `transfer::WorkflowExportFile` 文档本体（桌面在映射层经 `saveFile` 落盘，非 HTTP 下载）；`import_workflows(request: WorkflowImportRequest)` → trait `import_workflows`。
- [x] **Step 4: 返回形状原则**：Tauri 命令返回数据 DTO 本体（`Project` / `Workflow` 线格式 camelCase，与 HTTP 相同类型）；包装形状差异在前端映射层适配，不在 Rust 侧造新 DTO。
- [x] **Step 5: 门禁**：`cargo check --workspace` / `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` 全绿。

### Task 2: 运行域命令

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: 4 命令**：`list_flow_runs(query: FlowRunListQuery)` → `workflow_runs`；`get_flow_run_detail(runId)` → `workflow_run_detail`（返回 `FlowRunDetailPayload`，含逐节点 checkpoint）；`trigger_flow_run(request: FlowRunTriggerRequest)` → `trigger_workflow_run`；`cancel_flow_run(runId)` → `cancel_workflow_run`。
- [x] **Step 2: 错误码保真**：`RunTriggerError` 的映射已在 manager 内完成（`409 proxy_not_running` / `404 not_found` / `409 conflict` / `422 workflow_graph_invalid` /「工作流运行记录库不可用」），命令层原样透传 `ManagerError`，前端已有对应文案。
- [ ] **Step 3: 进度事件验证（预期零代码）**：桌面触发一次运行，确认运行记录列表 / 打开中的运行详情 / 画布运行锁定随 `FlowRuns` 变更事件刷新（链路：`FlowRunManager` 广播 → 管理层桥接 `HttpApiChange` → 既有 http→Tauri 桥）。（blocked：链路已代码级核对存在——`src-tauri/src/lib.rs` 事件桥 `http.subscribe_changes()` → `proxycrab://http-api-change` ↔ 前端 `subscribeChanges`；实时刷新/画布锁定需真人 GUI 触发真实运行，无法自动化，归入 Task 7 Step 2 手工清单）
- [x] **Step 4: 降级登记（决策 2）**：管理 HTTP 服务启动失败时桌面桥不存在，进度不实时、列表手动刷新兜底——写入 `docs/runtime-notes.md`（Task 6 汇总落盘，此处先验证行为）。（已登记 + 代码级行为核对：22 个 flow 命令直调 manager 不经 HTTP，事件桥仅在 HTTP 服务启动成功时建立；活体降级演练归入 Task 7 Step 2 手工清单）

### Task 3: 脚本试跑命令

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: `flow_script_dry_run(request: FlowScriptDryRunRequest)`** → trait `flow_script_dry_run`，返回 `ScriptDryRunOutput`（`{ok,value,warnings}` / `{ok:false,error:{kind,message}}`，kind `syntax|blocked|runtime|timeout|invalid-return`）。编辑器「试跑」入口随能力位 `flowScriptDryRun` 自动出现。
- [ ] **Step 2: 验证**：编辑器内对一个前置/后置脚本试跑成功与超时两类路径。（blocked：需真人 GUI 操作编辑器试跑入口走两路径；命令映射与错误分类形状已代码级核对并经单测锁定，归入 Task 7 Step 2 手工清单）

---

## 阶段 2 — 前端映射（依赖阶段 1 的命令名冻结）

### Task 4: `tauri-backend.ts` 能力位映射

**Files:**
- Modify: `src/api/tauri-backend.ts`、`src/api/tauri-backend.test.mts`

- [x] **Step 1: `workflows`（9 方法）**：`listProjects` / `createProject` / `deleteProject` / `listWorkflows(projectId)` / `getWorkflow` / `createWorkflow` / `saveWorkflowGraph` / `deleteWorkflow` / `validateWorkflow` / `exportWorkflows` / `importWorkflows` 挂到 `createTauriBackend`（对照 `http-backend.ts:488-531` 的签名；`exportWorkflows` 返回信封文档本体）。
- [x] **Step 2: `flowRuns`（4 方法）+ `flowScriptDryRun`**：对照 `http-backend.ts:577-588`；`cancel` 吞掉成功空返回。
- [x] **Step 3: 包装形状前端适配**：如返回类型与 `types.ts` 既有契约存在包装差异（参照 `envSets.setActive` 先例），在映射层适配，不改 `types.ts`。
- [x] **Step 4: 不改入口组件**：`AppToolbar` / `launcher.ts` / 各窗口零改动；`pnpm build` 后桌面工具栏出现「工作流」「工作流导入导出」（资产菜单）、「运行记录」（资产菜单）、试跑入口。
- [x] **Step 5: vitest**：`tauri-backend.test.mts` 补能力位存在性与参数映射用例；`pnpm test:unit` 全绿。

### Task 5: MCP 档位 / 审计桌面接线（决策 1 纳入）

**Files:**
- Modify: `crates/proxy-crab-mgr/src/mcp/tools.rs`（或 `manager.rs`，按最小增量落点）、`crates/proxy-crab-mgr/src/manager.rs`、`src-tauri/src/lib.rs`、`src/api/tauri-backend.ts`、`src/api/tauri-backend.test.mts`

- [x] **Step 1: mgr 工具计数**：复用/提取 `POST /mcp` `tools/list` 的档位过滤逻辑，新增 trait 方法 `mcp_tool_count() -> ManagerResult<usize>`（当前档位下 `tools/list` 会出现的工具数；唯一实现方 `MitmManager`，加方法无下游破裂面）。
- [x] **Step 2: 桌面命令**：`get_mcp_tiers` / `replace_mcp_tiers(tiers: McpTiers)` / `list_mcp_audit(limit)` → trait `mcp_tiers` / `replace_mcp_tiers` / `mcp_audit`（Rust 返回 `Vec<McpAuditEntry>`，前端映射层包成 `{entries}` 对齐 `McpAuditPage`）；`get_mcp_tool_count` → `mcp_tool_count`。
- [x] **Step 3: 前端映射**：`tauri-backend.ts` 挂 `mcpTiers`（`get` / `save` / `toolCount`）与 `mcpAudit`（`list`）；注意 CLI 的 `toolCount` 走裸 JSON-RPC fetch，桌面改为直调命令。
- [ ] **Step 4: 验证**：设置窗口出现「MCP 暴露」（档位读写、工具数随档位变化）与「MCP 调用审计」分区；关闭执行档后工具数下降。（blocked：设置窗口两分区需真人 GUI 交互验证；档位/审计/工具数命令映射已代码级核对并经单测锁定，归入 Task 7 Step 2 手工清单）
- [x] **Step 5: 门禁**：Rust + 前端门禁同 Task 1 / Task 4。

---

## 阶段 3 — 收口

### Task 6: 文档同步（仓库硬约定）

**Files:**
- Modify: `docs/backend-api.md`、`docs/runtime-notes.md`、`docs/flow-acceptance.md`、`README.md`

- [x] **Step 1: `backend-api.md`**：更新「Workflow projects and definitions」末尾 "they do not yet publish UI change events" 过期备注（编辑器窗口已落地；CRUD 两端均不发变更事件，决策 5）；「Shared management contract」补充 flow 域桌面命令的信任面说明（对齐既有 "Direct Tauri calls are trusted" 叙述）。
- [x] **Step 2: `runtime-notes.md`**：登记决策 2 的进度事件降级（HTTP 服务未启动 → 桌面无实时进度，手动刷新兜底）。
- [x] **Step 3: `flow-acceptance.md`**：更新「通用说明」中「运行记录/运行画布窗口属 Task 22（未完成）」的过期表述；补桌面端操作路径（编辑器「运行」按钮 / 运行记录窗口），A-01 等场景标注桌面入口可用。
- [x] **Step 4: `README.md`**：「请求工作流（ReqFlow 复刻）」段落收口（桌面入口可用；删除/调整「详细文档后续补充」占位）；核对「桌面操作与远程浏览器管理」能力差异表。
- [x] **Step 5: Skill 面核对（硬约定检查项）**：确认 `skills/proxycrab/` 文档/脚本/评测无过期引用（桌面接线不改 HTTP/Skill 契约，预期零改动）。

### Task 7: 门禁与桌面端验收

**Files:**
- Create: `docs/flow-acceptance.md` 内增补桌面场景（并入 Task 6 Step 3 亦可）

- [x] **Step 1: 全量门禁**：`cargo check --workspace` / `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace` / `pnpm test:unit` / `pnpm build` / `pnpm format` 全绿。
- [ ] **Step 2: 桌面手工场景**（`pnpm tauri dev`，代理运行中 + 活动 Session 有目标流量）：（blocked：6 组场景需真人桌面 GUI + 真实代理流量/原生文件对话框，agent 无法驱动原生 WebView 窗口。已完成的代码级替代核对：22 个 flow 命令全部注册 `invoke_handler` 且签名与前端映射逐一核对一致、事件桥链路存在、降级路径符合决策 2、全部自动化门禁绿。6 组场景明细见收口 agent 报告，需人工在桌面执行）
  - 新建项目 → 新建流程 → 抓包「存入请求库」→ 画布拖入请求节点选条目 → 连线 保存 → 「校验」通过；
  - 编辑器「运行」→ Session 新增 `ProxyCrabRequest` capture → 运行记录 / 运行详情（运行画布）核对逐节点状态与耗时；运行中画布锁定、取消按钮生效；
  - 脚本试跑成功与错误分类文案正确；
  - 导入导出往返（桌面保存/选择对话框），secret 置空与脚本确认语义不变；
  - 设置窗口 MCP 两分区可用（并入 Task 5 Step 4 亦可）；
  - 降级路径（可选）：管理 HTTP 服务启动失败时运行仍可触发、记录可读，进度不实时。

## 分派建议

- **Agent 1（Rust）**：Task 1 → 2 → 3 → 5（Step 1–2，同文件串行避免冲突）。
- **Agent 2（前端）**：Task 4 → 5（Step 3）——依赖本计划冻结的命令名，可与 Agent 1 并行启动。
- **Agent 3（收口）**：Task 6 → 7，最后执行。
- 冲突点提示：`src-tauri/src/lib.rs` 与 `src/api/tauri-backend.ts` 被多个 Task 触碰，严格按上述顺序或交由同一 agent。
