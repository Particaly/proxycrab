import type { FileWriter } from "./save-file";
import type {
  ActiveSession,
  ApiActionView,
  AgentsPresetState,
  AppConfig,
  AssetMetadata,
  BreakpointDetailPayload,
  BreakpointQuery,
  BreakpointSummary,
  BypassPage,
  BypassQuery,
  CertificateInstallState,
  CertificateResponse,
  ClashConfig,
  ClashSubscriptionState,
  CreatedApiKey,
  CreateAgentsPresetRequest,
  CreateEnvSetRequest,
  CreateFlowProjectRequest,
  CreateSessionRequest,
  CreateWorkflowRequest,
  DebugFilterScriptRequest,
  DeleteCount,
  EnvGlobalVariables,
  EnvSetsPayload,
  EnvVariableSet,
  EnvWriteBackRequest,
  EnvWriteBackResult,
  FlowScriptDryRunRequest,
  FlowScriptDryRunResult,
  FlowRunDetail,
  FlowRunListQuery,
  FlowRunPage,
  FlowRunRecord,
  FlowRunTriggerRequest,
  ExecuteTemporaryScriptRequest,
  ExtendBreakpointRequest,
  FlowProject,
  FlowProjectsPage,
  CreateRequestLibraryRequest,
  IngestCaptureRequest,
  RequestLibraryEntry,
  RequestLibraryPage,
  RequestLibraryQuery,
  UpdateRequestLibraryRequest,
  InterceptorCreateRequest,
  InterceptorContent,
  InterceptorKind,
  InterceptorLibraryList,
  InterceptorSnapshotPayload,
  InterceptorUpdateRequest,
  HttpServiceStatus,
  HttpApiChange,
  IdentityPermissions,
  LogDetail,
  LogIdsPayload,
  LogIdsRequest,
  LogViewsPayload,
  LogViewsRequest,
  McpAuditPage,
  McpTiers,
  ProxyStatus,
  PendingApproval,
  PermissionEntry,
  PermissionIdentitySummary,
  ReplaceEnvGlobalsRequest,
  ReplaceSessionInterceptorsRequest,
  ReplaceSessionViewRequest,
  ReplayRequestPayload,
  ReplayResult,
  ResolveApprovalRequest,
  RoutingSelection,
  SaveEnvSetRequest,
  SaveFileRequest,
  SaveWorkflowGraphRequest,
  Script,
  ScriptRequest,
  SessionFilter,
  SessionMetadata,
  SessionsPayload,
  SessionShareState,
  SessionSharesPayload,
  SessionShareConfig,
  SessionInterceptorsPayload,
  SessionViewPayload,
  SystemLogEntry,
  SystemLogsQuery,
  SystemProxyStatus,
  SkillManagerState,
  SkillSaveResult,
  UpdateScriptRequest,
  Workflow,
  WorkflowExportEnvelope,
  WorkflowImportRequest,
  WorkflowImportResult,
  WorkflowValidationResult,
  WorkflowsPage,
  UpdateAgentsPresetRequest,
  UpdateSessionRequest,
  TemporaryExecutionResult,
  WorkspacePaths,
} from "./types";
import type { BodySide, BodyTarget, LoadedBody } from "./body";

export type Unsubscribe = () => void;

export interface SkillManager {
  getState(): Promise<SkillManagerState>;
  savePaths(paths: string[], deleteRemoved: boolean): Promise<SkillSaveResult>;
  sync(): Promise<SkillManagerState>;
}

export interface HostOperations {
  readonly skillManager: SkillManager;
  switchWorkspace?(): Promise<void>;
  openDevtools?(): Promise<void>;
  replaceConfig(config: AppConfig): Promise<AppConfig>;
  regenerateCertificate(): Promise<CertificateResponse>;
  /**
   * Windows 桌面端系统代理接管：代理启停时自动设置/恢复系统代理。
   * 未实现（CLI）或平台不支持时 UI 不展示对应状态。
   */
  readonly systemProxy?: {
    status(): Promise<SystemProxyStatus>;
  };
  /**
   * Windows 桌面端 CA 一键安装到当前用户受信任的根证书存储。
   * 未实现（CLI）时 UI 不展示安装入口。
   */
  readonly certificateInstall?: {
    status(): Promise<CertificateInstallState>;
    install(): Promise<void>;
  };
}

/**
 * Backend abstraction: every capability the UI needs from the host process.
 * The Tauri implementation (tauri-backend.ts) maps these onto `invoke` calls;
 * an alternative implementation (e.g. plain HTTP against the management API)
 * can be dropped in without touching any component.
 *
 * 能力位由方法是否存在表达：可选方法未实现时，UI 不展示对应入口，而不是探测
 * 一个独立的能力配置。分享后端只暴露只读接口，因此没有 replay、Session 写入、
 * 审批等方法。
 */
export interface Backend {
  readonly clashSubscription?: {
    getState(): Promise<ClashSubscriptionState>;
    enable(server: string): Promise<ClashSubscriptionState>;
    disable(): Promise<ClashSubscriptionState>;
  };
  readonly clashConfig?: {
    get(): Promise<ClashConfig>;
    save(yaml: string): Promise<ClashConfig>;
    reset(): Promise<ClashConfig>;
  };
  /**
   * 环境变量集与全局变量；读取返回掩码后的 secret 值，保存时未改动的掩码
   * 值自动保留原明文。未实现时 UI 不展示「环境变量」入口。
   */
  readonly envSets?: {
    get(): Promise<EnvSetsPayload>;
    create(request: CreateEnvSetRequest): Promise<EnvVariableSet>;
    save(id: string, request: SaveEnvSetRequest): Promise<EnvVariableSet>;
    remove(id: string): Promise<void>;
    setActive(id: string | null): Promise<string | null>;
    saveGlobals(request: ReplaceEnvGlobalsRequest): Promise<EnvGlobalVariables>;
    writeBack(request: EnvWriteBackRequest): Promise<EnvWriteBackResult>;
  };
  /**
   * MCP 暴露三档开关（读/写/执行）与当前暴露的工具数量。未实现时 UI 不
   * 展示「MCP 暴露」分区。
   */
  readonly mcpTiers?: {
    get(): Promise<McpTiers>;
    save(tiers: McpTiers): Promise<McpTiers>;
    /** 当前 tools/list 实际暴露的工具数量（随档位过滤变化）。 */
    toolCount(): Promise<number>;
  };
  /**
   * MCP 工具调用审计（plan Task 25 Step 4）：最近调用记录，seq 倒序，只读。
   * 未实现时 UI 不展示「MCP 调用审计」分区。
   */
  readonly mcpAudit?: {
    /** 读取最近 limit 条；缺省 100，服务端上限 500。 */
    list(limit?: number): Promise<McpAuditPage>;
  };
  /**
   * 请求工作流域：项目 / 流程定义 CRUD、图整体保存与结构校验。未实现时
   * UI 不展示「工作流」入口（Tauri 命令尚未提供，桌面端暂无该入口）。
   */
  readonly workflows?: {
    listProjects(): Promise<FlowProjectsPage>;
    createProject(request: CreateFlowProjectRequest): Promise<FlowProject>;
    deleteProject(id: string): Promise<void>;
    listWorkflows(projectId: string): Promise<WorkflowsPage>;
    getWorkflow(id: string): Promise<Workflow>;
    createWorkflow(request: CreateWorkflowRequest): Promise<Workflow>;
    saveWorkflowGraph(id: string, request: SaveWorkflowGraphRequest): Promise<Workflow>;
    deleteWorkflow(id: string): Promise<void>;
    validateWorkflow(id: string): Promise<WorkflowValidationResult>;
    /** 导出工作流信封（原始文档，非 `{ok,data}` 包装；secret 值已置空）。 */
    exportWorkflows(ids: string[]): Promise<WorkflowExportEnvelope>;
    /** 导入信封：confirm-scripts 语义裁决脚本，现有请求库/环境集条目永不覆盖。 */
    importWorkflows(request: WorkflowImportRequest): Promise<WorkflowImportResult>;
  };
  /**
   * 流程 pre/post 脚本试跑（计划 Task 18）：在服务端 flow 引擎载荷里以一次性
   * VM 执行脚本并返回结果/错误分类，不落库不广播。未实现时脚本编辑器不展示
   * 「试跑」入口。
   */
  flowScriptDryRun?(request: FlowScriptDryRunRequest): Promise<FlowScriptDryRunResult>;
  /**
   * 流程运行记录（计划 Task 19）：分页列表 / 详情（run 主记录 + 逐节点
   * checkpoint）/ 触发与取消。未实现时 UI 不展示「运行记录」入口与运行按钮。
   */
  readonly flowRuns?: {
    list(query: FlowRunListQuery): Promise<FlowRunPage>;
    get(id: string): Promise<FlowRunDetail>;
    /**
     * 触发一次运行（按最近保存的流程定义）。前置校验失败时报
     * 409 proxy_not_running / 404 not_found / 409 conflict / 422 workflow_graph_invalid。
     */
    trigger(request: FlowRunTriggerRequest): Promise<FlowRunRecord>;
    /** 取消进行中的运行；运行已结算（或不存在）时报 not_found。 */
    cancel(id: string): Promise<void>;
  };
  readonly host?: HostOperations;
  /**
   * 工作区级请求库（请求重放工作流的请求来源）。未实现时 UI 不展示
   * 「请求库」入口与「存入请求库」动作。
   */
  readonly requestLibrary?: {
    page(query: RequestLibraryQuery): Promise<RequestLibraryPage>;
    get(id: string): Promise<RequestLibraryEntry>;
    create(request: CreateRequestLibraryRequest): Promise<RequestLibraryEntry>;
    update(id: string, request: UpdateRequestLibraryRequest): Promise<RequestLibraryEntry>;
    remove(id: string): Promise<void>;
    ingestFromCapture(request: IngestCaptureRequest): Promise<RequestLibraryEntry>;
    /** 读取条目请求体原始字节（blob 或内联文本），无存储请求体时报 body_not_found。 */
    getBody(id: string, maxSize?: number): Promise<LoadedBody>;
  };

  fetchBody(target: BodyTarget, side: BodySide, maxSize?: number): Promise<LoadedBody>;
  downloadBody?(target: BodyTarget, side: BodySide, filename: string): Promise<boolean>;
  subscribeChanges(handler: (change: HttpApiChange) => void): Promise<Unsubscribe>;
  subscribeApprovalChanges(handler: (count: number) => void): Promise<Unsubscribe>;
  openExternal(url: string): Promise<void>;
  /**
   * 创建本地文件 Writer：Tauri 弹保存对话框（用户取消时返回 null），
   * 浏览器在 markAsFinish 时触发下载；markAsError 放弃保存。
   */
  saveFile(request: SaveFileRequest): Promise<FileWriter | null>;

  // workspace & config
  getWorkspace(): Promise<WorkspacePaths>;
  getConfig(): Promise<AppConfig>;
  getAgentsPresets(): Promise<AgentsPresetState>;
  createAgentsPreset(request: CreateAgentsPresetRequest): Promise<AgentsPresetState>;
  updateAgentsPreset(id: string, request: UpdateAgentsPresetRequest): Promise<AgentsPresetState>;
  activateAgentsPreset(id: string): Promise<AgentsPresetState>;
  deleteAgentsPreset(id: string): Promise<AgentsPresetState>;
  reimportDefaultAgentsPresets(): Promise<AgentsPresetState>;

  // proxy lifecycle
  getProxyStatus(): Promise<ProxyStatus>;
  startProxy(): Promise<ProxyStatus>;
  stopProxy(): Promise<ProxyStatus>;
  listLocalIps?(): Promise<string[]>;

  importBundle?(
    file: File,
    acceptedIntentIds: string[],
  ): Promise<import("./types").BundleImportResult>;
  resolveBundle?(
    id: string,
    resolutions: import("./types").BundleResolution[],
  ): Promise<import("./types").BundleImportResult>;
  downloadSessionConfig?(): Promise<void>;

  // sessions
  listSessions(): Promise<SessionsPayload>;
  listArchivedSessions(): Promise<SessionMetadata[]>;
  createSession(request: CreateSessionRequest): Promise<SessionMetadata>;
  updateSession(id: number, request: UpdateSessionRequest): Promise<SessionMetadata>;
  archiveSession(id: number): Promise<SessionMetadata>;
  restoreSession(id: number): Promise<SessionMetadata>;
  deleteArchivedSession(id: number): Promise<void>;
  replaceActiveSession(active: ActiveSession): Promise<ActiveSession>;
  listSessionShares?(): Promise<SessionSharesPayload>;
  getSessionShare(sessionId: number): Promise<SessionShareState>;
  enableSessionShare(
    sessionId: number,
    sessionShareConfig?: SessionShareConfig,
  ): Promise<SessionShareState>;
  disableSessionShare(sessionId: number): Promise<SessionShareState>;

  getWebSocketMessages?(
    sessionId: number,
    id: number,
    side: BodySide,
    afterId: number,
    limit?: number,
  ): Promise<import("./types").WebSocketPage>;
  fetchWebSocketMessageBody?(
    sessionId: number,
    id: number,
    side: BodySide,
    messageId: number,
  ): Promise<LoadedBody>;

  // capture logs
  getLogIds(request: LogIdsRequest): Promise<LogIdsPayload>;
  getLogViews(request: LogViewsRequest): Promise<LogViewsPayload>;
  validateFilterRegex(pattern: string): Promise<string | null>;
  getLog(sessionId: number | null, id: number): Promise<LogDetail>;
  replay?(sessionId: number, request: ReplayRequestPayload): Promise<ReplayResult>;
  listAssets(): Promise<AssetMetadata[]>;
  /** 读取资源原始字节用于详情预览；后端未暴露时资源详情只展示元数据。 */
  readAsset?(id: string): Promise<Uint8Array<ArrayBuffer>>;
  uploadAsset?(id: string, file: Blob): Promise<AssetMetadata>;
  getInterceptorContent(
    sessionId: number | null,
    id: number,
    executionId: number,
  ): Promise<InterceptorContent>;
  getInterceptorSnapshot(
    sessionId: number | null,
    id: number,
    executionId: number,
  ): Promise<InterceptorSnapshotPayload>;
  listBreakpoints(query: BreakpointQuery): Promise<BreakpointSummary[]>;
  getBreakpoint(id: number): Promise<BreakpointDetailPayload>;
  extendBreakpoint(id: number, request: ExtendBreakpointRequest): Promise<BreakpointSummary>;
  releaseBreakpoint(id: number): Promise<void>;
  executeBreakpointScript(
    id: number,
    request: ExecuteTemporaryScriptRequest,
  ): Promise<TemporaryExecutionResult>;
  getSessionView(sessionId: number | null): Promise<SessionViewPayload>;
  replaceSessionView?(
    sessionId: number | null,
    request: ReplaceSessionViewRequest,
  ): Promise<SessionViewPayload>;
  replaceSessionFilter?(sessionId: number, filter: SessionFilter): Promise<SessionViewPayload>;

  // Owner-managed redaction library and identity/share bindings.
  listRedactionScripts?(): Promise<Script[]>;
  getRedactionScript?(name: string): Promise<Script>;
  createRedactionScript?(request: ScriptRequest): Promise<void>;
  updateRedactionScript?(name: string, request: UpdateScriptRequest): Promise<void>;
  deleteRedactionScript?(name: string): Promise<void>;
  setHttpIdentityRedaction?(
    id: string,
    redactionScript: string | null,
  ): Promise<IdentityPermissions>;

  // column scripts
  listColumnScripts(): Promise<Script[]>;
  createColumnScript(request: ScriptRequest): Promise<void>;
  getColumnScript(name: string): Promise<Script>;
  updateColumnScript(name: string, request: UpdateScriptRequest): Promise<void>;
  deleteColumnScript(name: string): Promise<void>;

  // filter scripts
  listFilterScripts(): Promise<Script[]>;
  createFilterScript(request: ScriptRequest): Promise<void>;
  getFilterScript(name: string): Promise<Script>;
  updateFilterScript(name: string, request: UpdateScriptRequest): Promise<void>;
  deleteFilterScript(name: string): Promise<void>;
  debugFilterScript(name: string, request: DebugFilterScriptRequest): Promise<boolean>;

  // routing scripts
  listRoutingScripts(): Promise<Script[]>;
  createRoutingScript(request: ScriptRequest): Promise<void>;
  getRoutingScript(name: string): Promise<Script>;
  updateRoutingScript(name: string, request: UpdateScriptRequest): Promise<void>;
  deleteRoutingScript(name: string): Promise<void>;
  getRoutingSelection(): Promise<RoutingSelection>;
  replaceRoutingSelection(selection: RoutingSelection): Promise<RoutingSelection>;

  // interceptors
  listInterceptors(kind: InterceptorKind): Promise<InterceptorLibraryList>;
  createInterceptor(request: InterceptorCreateRequest): Promise<void>;
  getInterceptor(kind: InterceptorKind, name: string): Promise<Script>;
  updateInterceptor(
    kind: InterceptorKind,
    name: string,
    request: InterceptorUpdateRequest,
  ): Promise<void>;
  deleteInterceptor(kind: InterceptorKind, name: string): Promise<void>;
  getSessionInterceptors(sessionId: number | null): Promise<SessionInterceptorsPayload>;
  replaceSessionInterceptors(
    sessionId: number | null,
    request: ReplaceSessionInterceptorsRequest,
  ): Promise<SessionInterceptorsPayload>;

  // certificate
  getCertificate(): Promise<CertificateResponse>;

  // system logs
  getSystemLogs(query: SystemLogsQuery): Promise<SystemLogEntry[]>;
  clearSystemLogs(): Promise<void>;

  // bypass traffic
  getBypassEntries(query: BypassQuery): Promise<BypassPage>;
  deleteBypassEntry(id: number): Promise<void>;
  deleteBypassEntries(ids: number[]): Promise<DeleteCount>;
  clearBypassEntries(): Promise<DeleteCount>;

  // management HTTP service status
  getHttpServiceError(): Promise<string | null>;
  getHttpServiceStatus(): Promise<HttpServiceStatus>;
  getHttpPermissionCatalog(): Promise<ApiActionView[]>;
  listHttpPermissionIdentities(): Promise<PermissionIdentitySummary[]>;
  getHttpIdentityPermissions(id: string): Promise<IdentityPermissions>;
  replaceHttpIdentityPermissions(
    id: string,
    permissions: PermissionEntry[],
  ): Promise<IdentityPermissions>;
  createHttpApiKey(name: string): Promise<CreatedApiKey>;
  deleteHttpApiKey(id: string): Promise<void>;
  listHttpApprovals?(): Promise<PendingApproval[]>;
  resolveHttpApproval?(id: number, request: ResolveApprovalRequest): Promise<void>;
}
