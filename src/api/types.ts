// Types mirroring crates/proxy-crab-mitm/src/model.rs and crates/proxy-crab-mgr/src/dto.rs.
// Field names match serde's snake_case wire format exactly.

export interface ManagerError {
  code: string;
  message: string;
  actual_size?: number;
  max_size?: number;
}

// ---------- model.rs ----------

export type ColumnKind =
  "method" | "uri" | "code" | "source" | "stage" | "created_at" | "updated_at" | "script";

export type Column =
  | { kind: "method"; width: number }
  | { kind: "uri"; width: number }
  | { kind: "code"; width: number }
  | { kind: "source"; width: number }
  | { kind: "stage"; width: number }
  | { kind: "created_at"; width: number }
  | { kind: "updated_at"; width: number }
  | { kind: "script"; width: number; script_name: string };

export type FilterColumn =
  | { kind: "method" }
  | { kind: "uri" }
  | { kind: "code" }
  | { kind: "source" }
  | { kind: "stage" }
  | { kind: "script"; script_name: string };

export type FilterOption =
  | { kind: "column"; column: FilterColumn; regex: boolean }
  | { kind: "script"; script_name: string };

export interface SessionFilter {
  option: FilterOption | null;
  input: string;
}

export interface AppConfig {
  proxy_host: string;
  proxy_port: number;
  api_port: number;
  routing_script_name: string | null;
  active_session_id: number | null;
}

export interface SessionMetadata {
  id: number;
  name: string;
  created_at: number;
  description: string | null;
}

export interface SessionsPayload {
  sessions: SessionMetadata[];
  active_session_id: number | null;
}

export interface Script {
  name: string;
  display_name?: string | null;
  content: string;
}

export interface AgentsPreset {
  id: string;
  name: string;
  content: string;
}

export interface AgentsPresetState {
  active_id: string;
  presets: AgentsPreset[];
}

export type InterceptorKind = "request" | "response";

export interface InterceptorLibraryItem {
  name: string;
  display_name?: string | null;
  usage_count: number;
}

export interface InterceptorLibraryList {
  kind: InterceptorKind;
  items: InterceptorLibraryItem[];
}

export interface SessionInterceptorItem {
  name: string;
  display_name?: string | null;
  enabled: boolean;
  valid: boolean;
}

export interface SessionInterceptorsPayload {
  session_id: number;
  request: SessionInterceptorItem[];
  response: SessionInterceptorItem[];
}

export interface ReplaceSessionInterceptorsRequest {
  request: Array<{ name: string; enabled: boolean }>;
  response: Array<{ name: string; enabled: boolean }>;
}

export type CaptureOutcome = "in_progress" | "success" | "failed" | "tunneled";

export type ErrorStage =
  "connect" | "tls_handshake" | "request_body" | "interceptor" | "upstream" | "response_body";

export interface CaptureError {
  stage: ErrorStage;
  kind: string;
  message: string;
}

export type BodyPayload =
  | { type: "empty" }
  | { type: "text"; content: string; size: number }
  | { type: "json"; content: unknown; size: number }
  | { type: "binary"; size: number }
  | { type: "large"; size: number };

export type BodySourceType =
  { type: "original" } | { type: "string"; content: string } | { type: "asset"; asset_id: string };

export interface RequestInterceptorSnapshot {
  method: string;
  uri: string;
  version: string;
  headers: Record<string, string[]>;
  body: BodySourceType;
}

export interface ResponseInterceptorSnapshot {
  status: number;
  version: string;
  headers: Record<string, string[]>;
  body: BodySourceType;
}

/** Returned by the dedicated interceptor snapshot endpoint. Exactly one side is present. */
export interface InterceptorSnapshotPayload {
  request: RequestInterceptorSnapshot | null;
  response: ResponseInterceptorSnapshot | null;
}

/** Returned by the dedicated interceptor script content endpoint. */
export interface InterceptorContent {
  hash: string;
  content: string;
}

export type Modification =
  | {
      kind: "snapshot";
      request: RequestInterceptorSnapshot | null;
      response: ResponseInterceptorSnapshot | null;
    }
  | { kind: "method_set"; method: string }
  | { kind: "uri_set"; uri: string }
  | { kind: "status_set"; status: number }
  | { kind: "header_append"; name: string; value: string }
  | { kind: "header_set"; name: string; value: string }
  | { kind: "header_remove"; name: string; values: string[] }
  | { kind: "body_replace_string"; content: string }
  | { kind: "body_replace_asset"; asset_id: string }
  | { kind: "tag_set"; key: string; value: string };

/** Log detail omits the snapshot entry; fetch it from the snapshot endpoint instead. */
export type InterceptorModification = Exclude<Modification, { kind: "snapshot" }>;

export type InterceptorExecutionOrigin = "saved" | "temporary";

export type ProxyStatus =
  | { status: "stopped" }
  | { status: "starting" }
  | {
      status: "running";
      host: string;
      port: number;
      started_at: number;
      active_netlog: Record<string, number[]>;
      active_bypass_count?: number;
    }
  | { status: "stopping" }
  | { status: "failed"; message: string };

export interface SystemLogEntry {
  seq: number;
  timestamp: number;
  level: string;
  message: string;
}

export interface WorkspacePaths {
  current_path: string;
  configured_path: string;
}

/** 创建一次保存，字节通过返回的 Writer 追加。 */
export interface SaveFileRequest {
  filename: string;
}

export type HttpApiResource =
  | "workspace"
  | "config"
  | "proxy"
  | "sessions"
  | "archived_sessions"
  | "active_session"
  | "session_share"
  | "session_view"
  | "column_scripts"
  | "filter_scripts"
  | "routing_scripts"
  | "routing_selection"
  | "bypass"
  | "interceptors"
  | "session_interceptors"
  | "certificate"
  | "clash_subscription"
  | "clash_config"
  | "system_logs"
  | "env_sets"
  | "request_library"
  | "flow_runs"
  | "all";

export interface HttpApiChange {
  resources: HttpApiResource[];
  session_id?: number;
}

export interface SkillPathState {
  parent_path: string;
  target_path: string;
  error?: string;
}

export interface SkillManagerState {
  configured: boolean;
  config_error?: string;
  paths: SkillPathState[];
}

export interface SkillRemovalError {
  parent_path: string;
  message: string;
}

export interface SkillSaveResult {
  state: SkillManagerState;
  removal_errors: SkillRemovalError[];
}

// ---------- dto.rs ----------

export interface CreateSessionRequest {
  name?: string | null;
  description?: string | null;
  view?: {
    columns?: Column[];
    filter?: SessionFilter;
  } | null;
  interceptors?: {
    request?: Array<{ name: string; enabled: boolean }>;
    response?: Array<{ name: string; enabled: boolean }>;
  } | null;
}

export interface UpdateSessionRequest {
  name?: string | null;
  description?: string | null;
}

export interface ActiveSession {
  session_id: number | null;
}

export interface SessionShareSummary {
  session_id: number;
  persistent: boolean;
}

export interface SessionSharesPayload {
  shares: SessionShareSummary[];
}

export interface SessionShareConfig {
  sessionConfigShare?: { assets: string[] } | null;
  redactionScript?: string | null;
  persistent: boolean;
}

export interface SessionShareState {
  session_config_share?: { assets: string[] } | null;
  redaction_identity?: string | null;
  persistent: boolean;
  redaction_script?: string | null;
  session_id: number;
  enabled: boolean;
  token?: string;
}

export interface LogIdsRequest {
  session_id?: number | null;
  filter?: SessionFilter | null;
  ids?: number[] | null;
  min_id?: number | null;
  max_id?: number | null;
  limit?: number | null;
}

export interface CreateAgentsPresetRequest {
  name: string;
}

export interface UpdateAgentsPresetRequest {
  name?: string | null;
  content?: string | null;
}

export interface LogIdsPayload {
  matched_ids: number[];
  in_progress_ids: number[];
}

export interface LogViewItem {
  id: number;
  updated_at?: number | null;
}

export interface SessionViewInput {
  columns: Column[];
}

export interface LogViewsRequest {
  session_id?: number | null;
  logs: LogViewItem[];
  view?: SessionViewInput | null;
}

export interface LogViewRow {
  id: number;
  created_at: number;
  updated_at: number;
  outcome: CaptureOutcome;
  cells: string[];
}

export interface LogViewException {
  id: number;
  column_index?: number | null;
  code: string;
  message: string;
}

export interface LogViewsPayload {
  columns: Column[];
  rows: LogViewRow[];
  exceptions: LogViewException[];
}

export interface SessionViewPayload {
  redaction_revision?: string | null;
  session_id: number;
  columns: Column[];
  filter: SessionFilter;
}

export interface ReplaceSessionViewRequest {
  columns: Column[];
}

export interface HeaderItem {
  name: string;
  value: string;
}

export interface RequestDetail {
  method: string;
  uri: string;
  version: string;
  headers: HeaderItem[];
  tags: Record<string, string>;
  body: BodyPayload;
}

export interface ResponseDetail {
  status: number;
  status_text: string;
  version: string;
  headers: HeaderItem[];
  body: BodyPayload;
}

export interface WebSocketInterceptor {
  execution_id: number;
  name: string;
}
export interface WebSocketInvocation extends WebSocketInterceptor {
  invocation_id: number;
}
export interface WebSocketMessageRef {
  side: "request" | "response";
  id: number;
}
export interface WebSocketInfo {
  interceptors?: WebSocketInterceptor[];
  handshake_log_id: number;
  websocket_log_id: number;
  extensions: string;
  subprotocol: string | null;
  opened_at: number;
  closed_at: number | null;
  close_code: number | null;
  close_reason: string | null;
}
export interface WebSocketMessage {
  id: number;
  sequence?: number;
  root?: WebSocketMessageRef;
  parent?: WebSocketMessageRef;
  producer?: WebSocketInvocation & { send_index: number };
  dropped_by?: WebSocketInvocation;
  status?: "sent" | "dropped" | "unsent" | "failed";
  error?: string;
  errors?: (WebSocketInvocation & { error: string })[];
  type: "text" | "binary";
  started_at: number;
  completed_at: number;
  size: number;
  content_available: boolean;
  omitted_reason: string | null;
}
export interface WebSocketPage {
  messages: WebSocketMessage[];
  next_after_id: number;
  has_more: boolean;
}
export interface LogDetail {
  websocket?: WebSocketInfo;

  id: number;
  session_id: number;
  created_at: number;
  updated_at: number;
  source_type: string;
  source_addr: string | null;
  stage: string;
  outcome: CaptureOutcome;
  error: CaptureError | null;
  request: RequestDetail;
  response: ResponseDetail | null;
  request_interceptors: InterceptorExecution[];
  response_interceptors: InterceptorExecution[];
}

export interface InterceptorExecution {
  execution_id: number;
  origin: InterceptorExecutionOrigin;
  completed: boolean;
  phase: InterceptorKind;
  position: number;
  name: string;
  display_name?: string | null;
  script_hash: string;
  has_snapshot: boolean;
  modifications: InterceptorModification[];
  error: string | null;
}

export interface BreakpointSummary {
  id: number;
  session_id: number;
  capture_id: number;
  phase: InterceptorKind;
  position: number;
  interceptor_name: string;
  display_name?: string | null;
  method: string;
  uri: string;
  created_at: number;
  expires_at: number;
  remaining_ms: number;
}

export interface BreakpointQuery {
  session_id?: number | null;
  phase?: InterceptorKind | null;
  interceptor_name?: string | null;
}

export interface BreakpointDetailPayload {
  breakpoint: BreakpointSummary;
  log: LogDetail;
}

export interface ExtendBreakpointRequest {
  timeout_ms: number;
}

export interface ExecuteTemporaryScriptRequest {
  content: string;
}

export interface TemporaryExecutionResult {
  execution: InterceptorExecution;
  breakpoint: BreakpointSummary;
}

export interface ScriptRequest {
  name: string;
  content?: string;
}

export interface UpdateScriptRequest {
  content: string;
}

export interface DebugFilterScriptRequest {
  session_id?: number | null;
  log_id: number;
  input: string;
}

export interface InterceptorCreateRequest {
  kind: InterceptorKind;
  name: string;
  content?: string;
}

export interface InterceptorUpdateRequest {
  content: string;
}

export interface RoutingSelection {
  name: string | null;
}

export type BypassOutcome = "in_progress" | "success" | "failed";

export interface BypassEntry {
  id: number;
  created_at: number;
  updated_at: number;
  source: string;
  method: string;
  uri: string;
  version: string;
  reason: string;
  outcome: BypassOutcome;
  response_status: number | null;
  error: string | null;
  upload_bytes: number | null;
  download_bytes: number | null;
}

export interface BypassQuery {
  before_id?: number | null;
  limit?: number | null;
}

export interface BypassPage {
  rows: BypassEntry[];
  has_more: boolean;
}

export interface DeleteCount {
  deleted: number;
}

export interface SystemLogsQuery {
  after_seq?: number | null;
  limit?: number | null;
}

export interface CertificateResponse {
  pem: string;
}

export interface ClashSubscriptionState {
  enabled: boolean;
  server?: string;
}

export interface ClashConfig {
  yaml: string;
  default_yaml: string;
}

// ---------- env sets (flow/env_sets.rs; wire format is camelCase) ----------

/** 一个环境变量集；读取时 secretValues 的值恒为掩码 "******"。 */
export interface EnvVariableSet {
  id: string;
  name: string;
  values: Record<string, string>;
  secretValues: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** 全局变量表（普通 + secret）；读取时 secretValues 为掩码。 */
export interface EnvGlobalVariables {
  values: Record<string, string>;
  secretValues: Record<string, string>;
}

export interface EnvSetsPayload {
  sets: EnvVariableSet[];
  activeSetId: string | null;
  globals: EnvGlobalVariables;
}

/** MCP 暴露三档开关（plan Task 25 Step 2）：缺省读开 / 写关 / 执行关。 */
export interface McpTiers {
  read: boolean;
  write: boolean;
  execute: boolean;
}

/** MCP 工具调用审计单条记录（plan Task 25 Step 4；wire format 为 camelCase）。 */
export interface McpAuditEntry {
  seq: number;
  timestampMs: number;
  tool: string;
  identity: string;
  /** 参数摘要（服务端已截断）；denied/error 时配合 reason 展示。 */
  argumentsSummary: string;
  outcome: "ok" | "denied" | "error";
  decision: "allowed" | "denied";
  reason?: string;
}

/** `GET /api/mcp-audit` 返回：按 seq 倒序的最近调用记录。 */
export interface McpAuditPage {
  entries: McpAuditEntry[];
}

export interface CreateEnvSetRequest {
  name: string;
  /** 提供时按该集合复制（含 secret 值），新集合使用生成的 id。 */
  copyFrom?: string | null;
  values?: Record<string, string>;
  secretValues?: Record<string, string>;
}

export interface SaveEnvSetRequest {
  name: string;
  values: Record<string, string>;
  secretValues: Record<string, string>;
}

export interface ReplaceEnvGlobalsRequest {
  values: Record<string, string>;
  secretValues: Record<string, string>;
}

export interface EnvWriteBackRequest {
  setId: string;
  writes: Record<string, unknown>;
}

export interface EnvWriteBackResult {
  applied: number;
  dropped: number;
}

// ---------- flow workflows (flow/model.rs; wire format is camelCase) ----------

/** 9 类工作流节点类型（Rust `WorkflowNodeType` 的 camelCase 字面量）。 */
export type WorkflowNodeType =
  | "start"
  | "httpReplay"
  | "condition"
  | "loop"
  | "delay"
  | "setVariable"
  | "assert"
  | "transform"
  | "stickyNote";

/** 节点配置载荷：字段级语义由 flow-engine 定义，编辑器按类型按需读取。 */
export type WorkflowNodeConfig = Record<string, unknown>;

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: WorkflowNodePosition;
  config: WorkflowNodeConfig;
  /** 展示名；缺省用节点注册表的默认标签。 */
  label?: string;
  /** 节点引用短码（5 位纯字母），模板 `{{ node.<refId>.path }}` 的解析键。 */
  refId?: string;
}

/** 条件分支出边手柄：真 / 假出口。 */
export type WorkflowEdgeHandle = "true" | "false";

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** 分支手柄，仅 source 为 condition 节点时落值。 */
  sourceHandle?: WorkflowEdgeHandle | null;
}

/** 工作流项目：流程的顶层分组容器。 */
export interface FlowProject {
  id: string;
  name: string;
  description: string;
  /** 展示用颜色（HEX，如 `#4f46e5`）。 */
  color: string;
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}
// ---------- request library (flow/request_library.rs; wire format is camelCase) ----------

export type RequestLibrarySource = "capture" | "import" | "manual";

/** HAR 1.2 名值对（headers / queryString / 表单 params / cookies 共用）。 */
export interface RequestLibraryHarPair {
  name: string;
  value: string;
}

/** HAR 请求体：text 为原文（UTF-8，或 encoding="base64" 的 Base64）。 */
export interface RequestLibraryHarPostData {
  mimeType: string;
  params?: RequestLibraryHarPair[];
  text?: string | null;
  encoding?: string | null;
}

/** HAR 响应摘要（不含响应体：重放只消费请求侧）。 */
export interface RequestLibraryHarResponse {
  status: number;
  statusText?: string;
  httpVersion?: string;
  headers?: RequestLibraryHarPair[];
  content?: { size: number; mimeType: string };
  redirectURL?: string;
}

/** HAR 条目（请求库快照恒为单 entry；response 缺省表示未收到响应）。 */
export interface RequestLibraryHarEntry {
  startedDateTime?: string;
  time?: number;
  request: {
    method: string;
    url: string;
    httpVersion?: string;
    headers: RequestLibraryHarPair[];
    queryString: RequestLibraryHarPair[];
    cookies?: RequestLibraryHarPair[];
    postData?: RequestLibraryHarPostData | null;
  };
  response?: RequestLibraryHarResponse | null;
}

/** 最小 HAR 1.2 快照（`{log: {entries: [...]}}`），字段与 Rust 侧模型一一对应。 */
export interface RequestLibraryHarSnapshot {
  log: {
    version: string;
    creator?: { name: string; version?: string };
    entries: RequestLibraryHarEntry[];
  };
}

/** 请求库条目；请求体可能内联在 har.postData.text 或经 bodyRef 指向 blob。 */
export interface RequestLibraryEntry {
  id: string;
  name: string;
  tags: string[];
  source: RequestLibrarySource;
  origin: string;
  har: RequestLibraryHarSnapshot;
  bodyRef?: { path: string; size: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlowProjectsPage {
  projects: FlowProject[];
  total: number;
}

export interface WorkflowsPage {
  workflows: Workflow[];
  total: number;
}

export interface CreateFlowProjectRequest {
  name: string;
  description?: string;
  color?: string;
  variables?: Record<string, string>;
  secretVariables?: Record<string, string>;
}

export interface CreateWorkflowRequest {
  projectId: string;
  name: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: Record<string, string>;
  secretVariables?: Record<string, string>;
}

/** 图保存：nodes+edges 是一个整体替换单元，必须同时发送。 */
export interface SaveWorkflowGraphRequest {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowValidationIssue {
  /** 稳定的 kebab-case 代码（`missing-start`、`dangling-edge`、…）。 */
  code: string;
  message: string;
  /** 定位问题涉及的节点 id；流程级问题为空数组。 */
  nodeIds: string[];
}

export interface WorkflowValidationResult {
  issues: WorkflowValidationIssue[];
}

/* ---- Workflow transfer（计划 Task 23；crates/proxy-crab-mitm/src/flow/transfer.rs）---- */

/** 工作流导出信封：`GET /api/workflows/export` 的原始文档（非 `{ok,data}` 包装）。 */
export interface WorkflowExportEnvelope {
  format: string;
  version: number;
  exportedAt: number;
  /** 存储定义副本；secret 变量值已置空（名称保留）。 */
  workflows: Workflow[];
  /** 流程引用的请求库条目原文；空时省略。 */
  requests?: RequestLibraryEntry[];
  /** 全部环境变量集（整张 secretValues 表已剥除）；空时省略。 */
  envSets?: EnvVariableSet[];
}

/** 导入请求体：`file` 为信封原文；脚本按 confirm-scripts 语义逐条裁决。 */
export interface WorkflowImportRequest {
  file: WorkflowExportEnvelope;
  /** 导入副本的目标项目 id（必填，不校验存在性）。 */
  projectId: string;
  /** true 时仅 `confirmedScripts` 列出的脚本原样保留；缺省/false 时全部脚本置空。 */
  confirmScripts?: boolean;
  /** 保留脚本的键（`workflowIndex:nodeIndex:kind`），kind ∈ preProcess/postProcess/expression。 */
  confirmedScripts?: string[];
}

/** 一条导入成功的流程副本（index 为信封 workflows 数组下标）。 */
export interface WorkflowImportCreated {
  index: number;
  id: string;
  name: string;
}

/** 一条被形状校验跳过的流程及其问题清单（不创建副本）。 */
export interface WorkflowImportSkipped {
  index: number;
  name: string;
  issues: string[];
}

/** 信封扩展字段（requests/envSets）一族裁决结果：现有条目永不覆盖，新 id 原样入库。 */
export interface WorkflowImportExtensionOutcome {
  imported: number;
  skipped: { id: string; reason: string }[];
}

/** 导入结果：成功/跳过流程 + 扩展字段逐族裁决。 */
export interface WorkflowImportResult {
  imported: WorkflowImportCreated[];
  skipped: WorkflowImportSkipped[];
  requests: WorkflowImportExtensionOutcome;
  envSets: WorkflowImportExtensionOutcome;
}

/* ---- Flow runs（计划 Task 19；crates/proxy-crab-mitm/src/flow/run_store.rs）---- */

/** 运行状态（Rust `FlowRunRecord.status` 字面量；interrupted 为重启扫描收敛的孤儿终态）。 */
export type FlowRunStatus = "running" | "success" | "failed" | "cancelled" | "interrupted";

/** 节点执行状态（引擎 NodeRun.status；cancelled 为运行取消时已开始未跑完的结算态）。 */
export type FlowNodeRunStatus = "running" | "success" | "failed" | "cancelled" | "skipped";

/** 一次流程运行的记录头（`GET /api/flow/runs` 列表项与详情的 run 主体）。 */
export interface FlowRunRecord {
  id: string;
  workflowId: string;
  /** 记录落库时的流程名快照（流程已删除仍保留展示名）。 */
  workflowName: string;
  /** 触发方式（当前仅 manual；预留 debug 等取值）。 */
  trigger: string;
  status: FlowRunStatus;
  /** 回放目标 Session；早期记录可能缺省。 */
  sessionId?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /**
   * 运行创建时刻的图快照（节点 config 已剥离 pinnedOutput）；超 256KB 时降级为
   * 仅节点/连线骨架（顶层 `truncated: true`）。快照特性之前的旧记录缺省。
   */
  graphSnapshot?: unknown;
}

/** 触发一次流程运行的请求体（`POST /api/flow/runs`；sessionId 缺省由后端取活动 Session）。 */
export interface FlowRunTriggerRequest {
  workflowId: string;
  sessionId?: number;
}

/** 循环节点单轮迭代明细（引擎 LoopIterationRecord 同形）。 */
export interface FlowLoopIterationRecord {
  index: number;
  item: unknown;
  status: "success" | "failed" | "cancelled";
  output: unknown;
  startedAt: number;
  durationMs: number;
  error?: string;
}

/** 循环节点逐迭代进度与明细（引擎 LoopIterationsSummary 同形）。 */
export interface FlowLoopIterationsSummary {
  total: number;
  done: number;
  capped: boolean;
  records: FlowLoopIterationRecord[];
  truncated: boolean;
}

/** 单节点的执行 checkpoint（运行中实时 upsert，终态后不再变化）。 */
export interface FlowNodeRunRecord {
  runId: string;
  nodeId: string;
  status: FlowNodeRunStatus;
  /** 上游输出聚合的入参（超 256KB 时为 `{ __truncated, preview, originalBytes }` 包装）。 */
  input?: unknown;
  /** 节点返回值（同上截断包装口径）。 */
  output?: unknown;
  error?: string;
  startedAt?: number;
  durationMs?: number;
  /** 循环节点的逐迭代明细；其余节点 / 旧记录缺省。 */
  iterations?: FlowLoopIterationsSummary | null;
  updatedAt: number;
}

/** 运行详情：flatten 的 run 主记录 + 逐节点 checkpoint 列表。 */
export interface FlowRunDetail extends FlowRunRecord {
  nodeRuns: FlowNodeRunRecord[];
}

/** 运行分页列表。 */
export interface FlowRunPage {
  runs: FlowRunRecord[];
  total: number;
}

/** 运行列表筛选：workflowId / status 缺省表示不过滤；offset 按条数分页。 */
export interface FlowRunListQuery {
  workflowId?: string;
  status?: FlowRunStatus;
  limit?: number;
  offset?: number;
}

export interface RequestLibraryPage {
  entries: RequestLibraryEntry[];
  total: number;
}

/** 列表过滤：query 匹配名称与首个 HAR URL（忽略大小写）；tags 逗号分隔且需全部携带。 */
export interface RequestLibraryQuery {
  query?: string | null;
  tags?: string | null;
  source?: RequestLibrarySource | null;
  limit?: number | null;
  offset?: number | null;
}

export interface CreateRequestLibraryRequest {
  har: RequestLibraryHarSnapshot;
  name?: string | null;
  tags?: string[];
  origin?: string;
}

/** 部分更新：缺省字段保持不变；id/source/createdAt 不可改。 */
export interface UpdateRequestLibraryRequest {
  name?: string | null;
  tags?: string[] | null;
  origin?: string | null;
  har?: RequestLibraryHarSnapshot | null;
}

/** 从抓包入库；sessionId 缺省时使用活动 Session（无活动 Session 返回 409）。 */
export interface IngestCaptureRequest {
  capture_id: number;
  session_id?: number | null;
  name?: string | null;
  tags?: string[];
}

// ---------- flow script dry-run (flow/dry_run.rs; wire format is camelCase) ----------

/** 脚本模式：pre = 前置处理（请求前），post = 后置处理（响应后） */
export type FlowScriptSide = "pre" | "post";

/** 试跑错误分类（对齐引擎 ScriptError.kind 的有限集合） */
export type FlowScriptDryRunErrorKind =
  "syntax" | "blocked" | "runtime" | "timeout" | "invalid-return";

export interface FlowScriptDryRunRequest {
  side: FlowScriptSide;
  script: string;
  /** pre 脚本的样例入参（上游聚合对象，任意 JSON） */
  sampleInput?: unknown;
  /** post 脚本的样例响应信封（任意 JSON） */
  sampleResponse?: unknown;
}

export interface FlowScriptDryRunError {
  kind: FlowScriptDryRunErrorKind;
  /** 面向用户的可读信息（服务端已本地化） */
  message: string;
}

/** 一次脚本试跑的结果：成功带返回值与警告列表，失败带分类错误 */
export interface FlowScriptDryRunResult {
  ok: boolean;
  /** 成功返回值：pre 为请求上下文覆盖对象，post 为节点 output（未 return 时默认 response.body） */
  value?: unknown;
  warnings: string[];
  error?: FlowScriptDryRunError;
}

export interface HttpServiceStatus {
  running: boolean;
  host: string;
  port: number;
  error: string | null;
}

export type PermissionMode = "allow" | "approval" | "deny";
export type PermissionIdentityKind = "local" | "api_key";

export interface ApiActionView {
  id: string;
  method: string;
  route_template: string;
  default_mode: PermissionMode;
}

export interface PermissionIdentitySummary {
  id: string;
  kind: PermissionIdentityKind;
  name: string;
  prefix: string | null;
  created_at: number | null;
  last_used_at: number | null;
}

export interface PermissionEntry {
  action_id: string;
  mode: PermissionMode;
}

export interface IdentityPermissions {
  redaction_script?: string | null;
  identity: PermissionIdentitySummary;
  permissions: PermissionEntry[];
}

export interface CreatedApiKey {
  identity: PermissionIdentitySummary;
  api_key: string;
}

export interface PendingApproval {
  id: number;
  identity: PermissionIdentitySummary;
  action_id: string;
  method: string;
  route_template: string;
  actual_path: string;
  query: string | null;
  source: string | null;
  content_type: string | null;
  content_length: number | null;
  body_preview: string | null;
  body_preview_truncated: boolean;
  created_at: number;
  deadline_at: number;
}

export type ApprovalDecision = "allow" | "deny";

export interface ResolveApprovalRequest {
  decision: ApprovalDecision;
  duration_seconds: number | null;
}

export type ReplayBodyPayload =
  | { type: "text"; text: string; charset?: "utf8" }
  | {
      type: "body_ref";
      session_id: number;
      log_id: number;
      side: "request" | "response";
    }
  | { type: "asset"; asset_id: string };

export interface ReplayRequestPayload {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: ReplayBodyPayload;
}

export interface ReplayResult {
  log_id: number;
}

export interface AssetMetadata {
  id: string;
  size: number;
  content_type: string;
  sha256: string;
  created_at: number;
}

export interface BundleIntent {
  id: string;
  type: string;
  path: string;
  assets: string[];
}
export interface BundleFileStatus {
  path: string;
  status: "same" | "conflict" | "new";
  fingerprint: string | null;
  can_rename: boolean;
}
export interface BundleResolution {
  path: string;
  action: "keep" | "overwrite" | "rename";
  fingerprint: string | null;
  name?: string;
}
export interface BundleImportResult {
  import_id: string | null;
  files: BundleFileStatus[];
  sessions: SessionMetadata[];
}
