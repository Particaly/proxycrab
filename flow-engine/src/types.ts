/**
 * 引擎共享类型（自归档 src/types/{ids,har,model}.ts @ 485fa00 合并搬运）。
 *
 * 载荷移植约定：归档按 ids / har / model 三文件组织并通过 `@/types` 别名引用；
 * 载荷目录独立于前端 src/（无 `@` 别名），故合并为单文件并把引擎与测试的
 * `@/types` / `@/types/har` 引用统一改写为相对路径 `./types`。内容除合并头注释
 * 与本段说明外逐字保留（含未消费字段——模型形状是行为契约的一部分，保持与
 * 上游一致便于后续任务对齐存储层）。
 *
 * 领域约定（自 model.ts）：
 * - 时间戳一律为 Unix 毫秒数（Date.now()），利于建索引与排序；
 * - 实体 id 使用品牌类型（见下方 ids 区段），运行时就是普通 string，零开销；
 * - 节点 / 边仅在所属工作流内唯一。
 */

/* ================================================================== *
 * ids 区段（自归档 src/types/ids.ts @ 485fa00 逐字搬运）
 * ================================================================== */

/**
 * 品牌 id 类型：编译期区分不同实体的 id，避免 ProjectId / RequestId 等混用。
 * 运行时就是普通 string（IndexedDB key 亦按 string 存储），零开销。
 */

/** 品牌标记符号（仅存在于类型层，运行时不存在） */
declare const brand: unique symbol;

/** 为 T 打上 B 品牌标记（不可变属性，仅类型层） */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 项目 id */
export type ProjectId = Brand<string, "ProjectId">;

/** 工作流 id */
export type WorkflowId = Brand<string, "WorkflowId">;

/** 请求中心快照 id */
export type RequestId = Brand<string, "RequestId">;

/** 运行记录 id */
export type RunId = Brand<string, "RunId">;

/** 画布节点 id（工作流内唯一） */
export type NodeId = Brand<string, "NodeId">;

/** 画布连线 id（工作流内唯一） */
export type EdgeId = Brand<string, "EdgeId">;

/** 断言为项目 id（零运行时开销，仅做编译期标记） */
export const asProjectId = (value: string): ProjectId => value as ProjectId;

/** 断言为工作流 id */
export const asWorkflowId = (value: string): WorkflowId => value as WorkflowId;

/** 断言为请求快照 id */
export const asRequestId = (value: string): RequestId => value as RequestId;

/** 断言为运行记录 id */
export const asRunId = (value: string): RunId => value as RunId;

/** 断言为节点 id */
export const asNodeId = (value: string): NodeId => value as NodeId;

/** 断言为连线 id */
export const asEdgeId = (value: string): EdgeId => value as EdgeId;

/** 环境变量集 id（M10-T4） */
export type EnvSetId = Brand<string, "EnvSetId">;

/** 断言为环境变量集 id（零运行时开销，仅做编译期标记） */
export const asEnvSetId = (value: string): EnvSetId => value as EnvSetId;

/* ================================================================== *
 * har 区段（自归档 src/types/har.ts @ 485fa00 逐字搬运）
 * ================================================================== */

/**
 * HAR 1.2 精简建模。
 *
 * RequestRecord.har 保存捕获时的完整 HAR 快照，重放（M5-T2）按 request 字段
 * 重建请求。仅建模引擎用到的字段，完整规范见
 * http://www.softwareishard.com/blog/har-12-spec/ 。
 */

/** HAR 通用键值对（请求 / 响应头） */
export interface HarHeader {
  name: string;
  value: string;
}

/** HAR 查询参数（URL ?key=value 对） */
export interface HarQueryString {
  name: string;
  value: string;
}

/** HAR Cookie */
export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

/** HAR 请求体（postData） */
export interface HarPostData {
  /** 请求体 MIME 类型，如 application/json */
  mimeType: string;
  /** 表单参数（mimeType 为 form 系列时） */
  params?: Array<{ name: string; value: string }>;
  /** 请求体原始文本（可能被截断，见 M2-T4 体积管理） */
  text?: string;
  /** 文本编码方式（如 'base64'——二进制 body 以 base64 文本记录）；缺省为纯文本（M10-T2 导出方向消费） */
  encoding?: string;
}

/** HAR 响应内容 */
export interface HarContent {
  /** 响应体字节数 */
  size: number;
  /** 压缩节省的字节数（未知为 -1） */
  compression?: number;
  mimeType: string;
  /** 响应体文本（可能被截断） */
  text?: string;
  /** 文本编码方式（如 base64） */
  encoding?: string;
}

/** HAR 时间分解（单位毫秒，-1 表示不适用 / 未知） */
export interface HarTimings {
  blocked?: number;
  dns?: number;
  connect?: number;
  send: number;
  wait: number;
  receive: number;
  ssl?: number;
}

/** HAR 请求 */
export interface HarRequest {
  method: string;
  url: string;
  /** HTTP 版本，如 HTTP/1.1 */
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryString[];
  cookies?: HarCookie[];
  /** 头部字节数（未知为 -1） */
  headersSize: number;
  /** 请求体字节数（未知为 -1） */
  bodySize: number;
  postData?: HarPostData;
}

/** HAR 响应 */
export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies?: HarCookie[];
  content: HarContent;
  /** Location 跳转地址（非重放为空串） */
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

/** HAR 条目：一次请求 / 响应交换 */
export interface HarEntry {
  /** 条目开始时间（ISO 8601 字符串，HAR 规范约定） */
  startedDateTime: string;
  /** 总耗时（毫秒） */
  time: number;
  request: HarRequest;
  response: HarResponse;
  timings: HarTimings;
  /** Chrome 附加字段：资源类型（xhr / fetch / script ...） */
  _resourceType?: string;
  /**
   * Chrome 附加方法（仅 chrome.devtools.network.onRequestFinished 给出的
   * entry 携带）：异步读取响应体正文。content.text 在事件回调时通常为空，
   * 必须经此方法获取（见 use-captured-requests 的捕获接线）。
   * 入库 / 落库序列化时会因「函数不可结构化克隆」被丢弃，不影响存储体积。
   */
  getContent?: (callback: (content: string, encoding: string) => void) => void;
}

/** HAR 创建者信息 */
export interface HarCreator {
  name: string;
  version?: string;
}

/** HAR 日志根对象 */
export interface HarLog {
  /** HAR 格式版本，如 '1.2' */
  version: string;
  creator: HarCreator;
  entries: HarEntry[];
}

/** 完整 HAR 快照（RequestRecord.har 的类型） */
export interface HarSnapshot {
  log: HarLog;
}

/* ================================================================== *
 * model 区段（自归档 src/types/model.ts @ 485fa00 逐字搬运，仅去跨文件 import）
 * ================================================================== */

/** Unix 毫秒时间戳 */
export type Timestamp = number;

/** 画布平面坐标（节点位置） */
export interface Position {
  x: number;
  y: number;
}

/** 常见 HTTP 方法（节点覆盖重放请求用；HAR 原始字段保持 string） */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** HTTP 方法字面量联合 */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 流程级变量表（M7-T2 变量系统的流程作用域；项目级 Project.variables 同形） */
export type WorkflowVariables = Record<string, string>;

/**
 * 环境变量集（M10-T4）：dev / staging / prod 这类**命名环境**的键值集合，
 * 与既有流程级 / 项目级 / 全局变量（M7-T2）正交——变量经模板
 * `{{ env.<键名> }}` 引用（独立命名空间，与 `{{ var.<名> }}` 互不冲突）。
 */
export interface EnvVariableSet {
  /** 集合 id（EnvVariableSetId 品牌类型，见 ids 区段） */
  id: EnvSetId;
  /** 集合名（如 dev / staging / prod；仅展示用，可重名） */
  name: string;
  /** 普通环境变量表（键值均为字符串；WorkflowVariables 同形，复用同一校验） */
  values: WorkflowVariables;
  /**
   * secret 环境变量表（M9-T5 脱敏链路复用；与 values 同形但值为敏感信息）。
   * 运行期并入同一 env 命名空间（集合内 secret 覆盖同名普通变量）。
   */
  secretValues: WorkflowVariables;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** 项目：流程的顶层分组容器 */
export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  /** 展示用颜色（HEX，如 '#4f46e5'） */
  color: string;
  /** 项目级变量（M7-T2，可选；与项目下全部流程共享，优先级低于流程级变量） */
  variables?: WorkflowVariables;
  /** 项目级 secret 变量表（M9-T5，可选；运行期并入同一变量命名空间，同级内 secret 覆盖同名普通变量） */
  secretVariables?: WorkflowVariables;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** 工作流：属于某个项目的节点画布编排 */
export interface Workflow {
  id: WorkflowId;
  projectId: ProjectId;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 流程级变量（可选） */
  variables?: WorkflowVariables;
  /** 流程级 secret 变量表（M9-T5，可选；语义同 Project.secretVariables） */
  secretVariables?: WorkflowVariables;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * 节点类型字面量联合：start / httpReplay / condition / loop / delay /
 * setVariable / assert / transform / stickyNote（执行语义分别见
 * executor.ts / logic-nodes.ts / assert-nodes.ts / transform-nodes.ts 文件头）。
 * stickyNote 为纯注释卡、不入执行拓扑（各处理环节显式排除）。
 */
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

/** 请求覆盖项：在引用快照基础上手动覆盖的部分字段（仅覆盖给出的字段） */
export interface RequestOverride {
  method?: HttpMethod;
  url?: string;
  headers?: Record<string, string>;
  /** 从引用快照中删除的请求头（大小写不敏感） */
  removedHeaders?: string[];
  body?: string;
}

/** 无引用时作为请求基线保存的手动请求 */
export interface ManualRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 节点失败策略：失败即停 / 失败继续（执行语义见 M5-T4） */
export type NodeFailPolicy = "stop" | "continue";

/**
 * header 保真单项的取值方式（M9-T3）：
 *   - 'fromCapture'：从原始请求快照（HAR 基线）恢复该头的捕获值；
 *   - 'static'：使用手动指定的值（支持 {{ }} 模板渲染）。
 */
export type HeaderFidelitySource = "fromCapture" | "static";

/** header 保真单项配置（M9-T3）：单个受保护头的注入取值 */
export interface HeaderFidelityItem {
  /** 取值方式：从原始请求恢复 / 手动指定 */
  source: HeaderFidelitySource;
  /** source='static' 时的注入值（支持 {{ }} 模板）；fromCapture 时忽略本字段 */
  value?: string;
}

/**
 * 节点级 header 保真配置（M9-T3，NodeConfig.headerFidelity）：按头逐项配置，
 * **键缺省 = 回放捕获值（fromCapture）**。归档经 DNR 网络层注入；载荷移植后
 * （ProxyCrab 基座）头由 Rust 重放管线直接发送，注入决策仍由本形状驱动
 * （见 header-fidelity.ts 的宿主注入点说明）。
 */
export interface NodeHeaderFidelity {
  /** Origin 头注入配置（缺省 = 回放捕获值） */
  origin?: HeaderFidelityItem;
  /** Referer 头注入配置（缺省 = 回放捕获值） */
  referer?: HeaderFidelityItem;
  /** User-Agent 头注入配置（缺省 = 回放捕获值） */
  userAgent?: HeaderFidelityItem;
}

/**
 * 重放请求的 Cookie 携带方式（NodeConfig.cookieMode）：
 *   - 'snapshot'：回放捕获快照里的 Cookie（捕获时的值）；
 *   - 'custom'：注入 config.cookieValue 指定的值（支持 {{ }} 模板）。
 * 缺省（字段不存在）按 'snapshot' 处理。
 */
export type NodeCookieMode = "snapshot" | "custom";

/**
 * 变量赋值项（M7-T1 setVariable 节点，config.assignments 的元素）：
 * 从指定来源提取值写入运行期变量（同名覆盖；多个赋值项按数组顺序执行，
 * 后一项可读到前一项刚写入的值）。
 */
export interface VariableAssignment {
  /** 目标变量名（写入运行期变量表；空名在执行期按节点失败处理） */
  name: string;
  /** 取值来源：input 聚合入参 / node 指定节点输出 / var 既有变量 / literal 字面量 */
  from: VariableAssignmentSource;
  /**
   * 点分取值路径（resolvePath 语义，如 'body.token'；空串 / 缺省 = 取来源根值）。
   * from='literal' 时忽略本字段。
   */
  path?: string;
  /** from='node' 时的源节点 id（其 output 为取值根；其余来源忽略本字段） */
  node?: NodeId;
  /**
   * from='literal' 时的字面量值（任意 JSON；字符串支持 {{ }} 模板——按当前节点
   * 的模板上下文渲染后写入，如 "Bearer {{ var.token }}"）。其余来源忽略本字段。
   */
  value?: unknown;
}

/** 变量赋值项的取值来源字面量联合 */
export type VariableAssignmentSource = "input" | "node" | "var" | "literal";

/* ------------------------------------------------------------------ *
 * 断言规则（M10-T3 assert 节点，config.assertions 的元素）
 * ------------------------------------------------------------------ */

/** 状态码断言的比较方式：精确等于某状态码，或落在某百位段（2xx / 3xx / ...） */
export type StatusCodeOperator = "eq" | "2xx" | "3xx" | "4xx" | "5xx";

/** JSONPath 断言的比较方式（exists = 路径至少匹配到一个值；其余对每个匹配值判定） */
export type JsonPathOperator = "eq" | "ne" | "contains" | "regex" | "exists";

/** 状态码断言规则：对入参的数字 status 字段（上游响应输出）做段 / 精确比较 */
export interface StatusAssertionRule {
  /** 规则类别判别键 */
  kind: "status";
  /** 比较方式：精确 / 段 */
  op: StatusCodeOperator;
  /** op='eq' 时的期望状态码（如 200）；段比较时忽略本字段 */
  value?: number;
}

/** JSONPath 断言规则：对入参按 JSONPath 子集取值后逐值比较（子集见 json-path.ts） */
export interface JsonPathAssertionRule {
  /** 规则类别判别键 */
  kind: "jsonPath";
  /** JSONPath 表达式（如 $.body.token；语法子集见 json-path.ts 文件头） */
  path: string;
  /** 比较方式 */
  op: JsonPathOperator;
  /**
   * 期望值：op='eq' / 'ne' / 'contains' 时参与比较（任意 JSON 值，deep equal）；
   * op='regex' 时为正则源文本字符串；op='exists' 时忽略本字段。
   */
  value?: unknown;
}

/** JSON Schema 断言规则：对目标值校验常用子集关键字（子集与边界见 json-schema-lite.ts） */
export interface SchemaAssertionRule {
  /** 规则类别判别键 */
  kind: "schema";
  /**
   * 待校验目标的 JSONPath（可选；缺省 / 空串 = 对入参根值整体校验）。
   */
  path?: string;
  /** Schema 定义（常用子集：type / required / properties / items / enum） */
  schema: Record<string, unknown>;
}

/** 断言规则判别联合（按 kind 分派求值，见 assert-nodes.ts） */
export type AssertionRule = StatusAssertionRule | JsonPathAssertionRule | SchemaAssertionRule;

/* ------------------------------------------------------------------ *
 * 条件构建器规则行（M13-T3 condition 节点可视化构建，config.conditionRules 的元素）
 * ------------------------------------------------------------------ */

/**
 * 条件规则行的比较操作符。编译语义（数值收敛边界 / NaN 决策 / 模板取值口径）
 * 见 condition-builder.ts 文件头——本类型只定义取值集合，不携带语义。
 */
export type ConditionOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "isTrue"
  | "isFalse"
  | "matches";

/**
 * 条件构建器的一条结构化规则行（M13-T3 形态，**legacy**）：M16-T2 起条件节点
 * 落库形态为嵌套分组树（ConditionGroup，见下），本类型保留用于旧数据迁移读取
 * （condition-builder.ts 的 migrateConditionRules 把扁平 DNF 行迁为树）。
 */
export interface ConditionRuleRow {
  /**
   * 与上一条规则行的连接方式（首行忽略）：'and' = 与上一条同组（组内 AND）；
   * 'or' = 关闭当前组、开启新组（组间 OR）。
   */
  join: "and" | "or";
  /**
   * 左值模板（支持 {{ }}，条件沙箱内仅可引用 input / var 命名空间；裸路径 =
   * input 简写）。
   */
  left: string;
  /** 比较操作符（语义清单见 condition-builder.ts 的 CONDITION_OPERATORS） */
  op: ConditionOperator;
  /** 右值模板（支持 {{ }}，取值口径同左值）；一元操作符不使用 */
  right?: string;
}

/* ------------------------------------------------------------------ *
 * 条件节点落库结构（M16-T2：嵌套分组树）
 * ------------------------------------------------------------------ */

/**
 * 条件树叶子：一条「左值 操作符 右值」判定。left 为模板（支持 {{ }}，条件
 * 沙箱仅 input / var 命名空间；裸路径 = input 简写）；right 为标量；一元操作符
 * （isEmpty / isNotEmpty / isTrue / isFalse）不使用 right。
 */
export interface ConditionLeaf {
  /** 节点类别判别键 */
  type: "cond";
  /** 左值模板（一元操作符留空 = 判断整个入参根） */
  left: string;
  /** 比较操作符（语义见 condition-builder.ts） */
  operator: ConditionOperator;
  /** 右值（标量；一元操作符缺省） */
  right?: unknown;
}

/**
 * 条件树分组：op 描述组内各子项的连接方式（'and' 且 / 'or' 或），not 为真时
 * 整组取反；children 可含叶子与嵌套分组。条件节点落库为 config.condition
 * （根恒为本类型，缺省空组）。
 */
export interface ConditionGroup {
  /** 节点类别判别键 */
  type: "group";
  /** 组内连接方式：and = 全部命中；or = 任一命中 */
  op: "and" | "or";
  /** 整组取反（缺省 false 不落键） */
  not?: boolean;
  /** 子项（叶子 / 嵌套分组，按数组顺序求值） */
  children: ConditionNode[];
}

/** 条件树节点判别联合（分组可嵌套） */
export type ConditionNode = ConditionLeaf | ConditionGroup;

/** 节点配置：一次请求重放的可调参数（均可选，按节点类型取用） */
export interface NodeConfig {
  /** 引用请求中心的快照 id */
  requestId?: RequestId;
  /** 未引用快照时使用的独立请求基线 */
  manualRequest?: ManualRequest;
  /** 手动覆盖 method / url / headers / body */
  override?: RequestOverride;
  /** 前置处理脚本：input → 请求上下文 */
  preProcess?: string;
  /** 后置处理脚本：响应 → output */
  postProcess?: string;
  /** 重放超时（毫秒） */
  timeoutMs?: number;
  /** 失败策略，缺省为 'stop' */
  failPolicy?: NodeFailPolicy;
  /** header 保真配置（M9-T3，可选）：按节点注入 Origin / Referer / UA */
  headerFidelity?: NodeHeaderFidelity;
  /** Cookie 携带方式（可选；缺省 = 'snapshot'）。'custom' = 注入 cookieValue 指定的值 */
  cookieMode?: NodeCookieMode;
  /** Cookie 自定义值（cookieMode = 'custom' 时生效；支持 {{ }} 模板） */
  cookieValue?: string;

  /* ---- condition 节点（M7-T1；语义见 logic-nodes.ts） ---- */
  /**
   * 条件表达式（脚本函数体，形参 input / vars——vars 为当前运行期变量表；
   * 返回值经 JS truthy 判定）。缺省 / 空串视为恒 false。
   * M16-T2 起本字段是 config.condition 条件树的**编译产物**
   * （见 condition-builder.ts 的 compileConditionTree）。
   */
  expression?: string;
  /** 真分支下游节点 id 列表（**legacy**，M16-T1 前的手柄缺失数据口径；缺省空数组） */
  trueTargets?: NodeId[];
  /** 假分支下游节点 id 列表（**legacy**，语义同 trueTargets） */
  falseTargets?: NodeId[];
  /** 结构化条件规则行（**legacy**，M13-T3 旧形态）：M16-T2 起迁移读取源 */
  conditionRules?: ConditionRuleRow[];
  /** 条件树（M16-T2 落库形态，根恒为 group）：可视化构建器的唯一事实来源 */
  condition?: ConditionGroup;

  /* ---- loop 节点（M7-T1；M10-T6 增量 CSV 数据源 / 并发 / 限速） ---- */
  /**
   * 迭代数据源：JSON 数组字面量（直接使用）或模板字符串（按当前节点模板上下文
   * 渲染后 JSON.parse；解析失败 / 结果非数组 → 节点 failed）。
   */
  items?: string | unknown[];
  /** 迭代轮数上限（缺省 100；配置值 > 1000（硬上限）时执行期收敛到 1000） */
  maxIterations?: number;
  /** CSV 数据源文本（M10-T6，可选）：配置时**优先于 items**（CSV 场景 items 被忽略） */
  csvText?: string;
  /** CSV 分隔符（M10-T6，仅 ',' / ';' / '\t' 合法；缺省 / 非法回退 ','） */
  csvDelimiter?: "," | ";" | "\t";
  /** 并发迭代数（M10-T6，1~16；缺省 / 非法值 1 = 既有串行语义逐字不变） */
  concurrency?: number;
  /** 限速间隔毫秒（M10-T6，0~60000；缺省 / 非法值 0）：相邻两批迭代开始前的等待时间 */
  intervalMs?: number;

  /* ---- delay 节点（M7-T1） ---- */
  /**
   * 延时时长（毫秒）。上限 300000（5 分钟）：超出 → 节点 failed；
   * 缺省 / 非法值按 0 处理（立即透传）。等待期间响应取消。
   */
  durationMs?: number;

  /* ---- setVariable 节点（M7-T1） ---- */
  /** 赋值项列表（按顺序执行；缺省空数组 = 纯透传） */
  assignments?: VariableAssignment[];

  /* ---- assert 节点（M10-T3） ---- */
  /** 断言规则列表（按数组顺序逐一求值；任一失败 → 节点 failed）。缺省 / 空数组 = 无断言 */
  assertions?: AssertionRule[];

  /* ---- pinned data（M10-T5） ---- */
  /** 固定输出（n8n 式 pinned data，可选）：存在时该节点在运行中**不执行** */
  pinnedOutput?: NodePinnedOutput;

  /* ---- transform 节点（M10-T6） ---- */
  /** 提取规则列表（按数组顺序求值）。语义见 transform-nodes.ts */
  extractions?: TransformExtractionRule[];

  /* ---- stickyNote 节点（M13-T5，纯注释卡 / 不入执行拓扑） ---- */
  /** 便签正文（纯文本，支持换行）。便签不参与执行 */
  text?: string;
  /** 便签配色（预设色板项的 token 名；缺省 / 未知值按默认琥珀色渲染） */
  color?: string;
  /** 便签卡尺寸（像素；缺省 / 非法值按默认尺寸渲染） */
  size?: { width: number; height: number };

  /* ---- 全节点重试退避（M10-T6） ---- */
  /**
   * 重试退避配置（可选；仅 httpReplay / transform / condition / setVariable /
   * assert 等同步求值类 runner 生效——loop / delay 自身即长时节点不重试）。
   */
  retry?: NodeRetryConfig;
}

/**
 * 节点固定输出（M10-T5 pinned data，config.pinnedOutput 的值）：
 * 记录固定值、固定时刻与来源运行（追溯「值从哪次运行来」）。
 */
export interface NodePinnedOutput {
  /** 固定的输出值（运行时直接作为该节点 output，不执行节点） */
  value: unknown;
  /** 固定时刻（毫秒时间戳） */
  pinnedAt: number;
  /** 来源运行 id（从哪次运行的节点输出固定） */
  sourceRunId: RunId;
}

/* ------------------------------------------------------------------ *
 * 数据处理（M10-T6 transform 节点，config.extractions 的元素）
 * ------------------------------------------------------------------ */

/** 提取规则的查询语言：JSONPath 子集（json-path）或 JMESPath（jmespath 库） */
export type TransformEngine = "jsonPath" | "jmespath";

/** 提取规则：按查询语言从 input 提取一个值（规则名用于多规则组对象） */
export interface TransformExtractionRule {
  /** 规则名（多条规则时输出对象的键；单条规则时忽略——直接产出提取值） */
  name: string;
  /** 查询语言 */
  engine: TransformEngine;
  /** 查询表达式（如 $.data.token 或 response.body.items[*].id） */
  path: string;
}

/** 重试退避配置（M10-T6，config.retry）：runner 抛错后按退避间隔重试 */
export interface NodeRetryConfig {
  /** 最大尝试次数（含首次；1 = 不重试。上限 5，超出执行期收敛） */
  maxAttempts: number;
  /** 首次重试前的等待毫秒数（0 = 立即重试；上限 30000，超出执行期收敛） */
  backoffMs: number;
  /** 退避乘数（前次等待 × 乘数；缺省 2，上限 4） */
  multiplier?: number;
}

/** 画布节点 */
export interface WorkflowNode {
  id: NodeId;
  type: WorkflowNodeType;
  position: Position;
  config: NodeConfig;
  /** Optional user-facing label; omitted nodes use the registry default label. */
  label?: string;
  /**
   * 节点引用短码（M15-T2，可选）：5 位纯字母（ref-id 的 REF_ID_PATTERN），
   * 模板引用 `{{ node.<refId>.path }}` 的解析键。缺省（存量数据 / 测试直构
   * 节点）时读取侧一律回退内部 id（`refId ?? id`）。
   */
  refId?: string;
}

/**
 * 条件分支出口标识（M16-T1）：条件节点的两个出边手柄 id——
 * 'true' = 真分支（表达式为真时执行）、'false' = 假分支。
 */
export type ConditionBranchHandle = "true" | "false";

/** 画布连线：source → target 的有向边 */
export interface WorkflowEdge {
  id: EdgeId;
  source: NodeId;
  target: NodeId;
  /**
   * 出边手柄（M16-T1，可选）：仅 source 为 condition 节点时落值——分支走向
   * 直接由「从哪个出口连线」决定。
   */
  sourceHandle?: ConditionBranchHandle;
}

/** 请求来源渠道（可扩展） */
export type RequestSource = "devtools" | "import" | "manual";

/** 请求中心的一条请求快照（含完整 HAR，体积较大故入 IndexedDB） */
export interface RequestRecord {
  id: RequestId;
  name: string;
  tags: string[];
  source: RequestSource;
  /** 捕获时所在页面 origin（如 'https://example.com'） */
  origin: string;
  har: HarSnapshot;
  createdAt: Timestamp;
}

/** 节点执行状态 */
export type NodeRunStatus = "running" | "success" | "failed" | "skipped";

/**
 * 单轮循环迭代的执行明细（M13-T9 逐迭代调试，NodeRun.iterations.records 的
 * 元素）：仅循环节点在执行期间由 loop runner 产出，其余节点恒无。
 */
export interface LoopIterationRecord {
  /** 迭代下标（0 起，与 var.loop.index 一致） */
  index: number;
  /** 本轮迭代项（var.loop.item 的值；超限截断遵循 M5-T5 惯例） */
  item: unknown;
  /** 本轮状态：success / failed；cancelled = 运行取消时已开始但未跑完的轮次 */
  status: "success" | "failed" | "cancelled";
  /** 本轮聚合输出；仅 success 轮有值，其余为 null */
  output: unknown;
  /** 本轮开始时刻（毫秒时间戳） */
  startedAt: Timestamp;
  /** 本轮耗时（毫秒） */
  durationMs: number;
  /** 失败轮错误信息（status = 'failed' 时存在；与 loop 节点失败摘要同源文案） */
  error?: string;
}

/**
 * 循环节点的迭代进度与逐迭代明细（M13-T9，NodeRun.iterations 的值）：仅 loop
 * 节点执行后携带，其余节点恒无该字段（向后兼容）。
 */
export interface LoopIterationsSummary {
  /** 实际轮数（min(items 解析长度, maxIterations)） */
  total: number;
  /** 已结算轮数（产出明细的轮次：success / failed / cancelled；未启动轮不计） */
  done: number;
  /** 轮数是否被 maxIterations 上限截断（items 实际长度 > total 时为 true） */
  capped: boolean;
  /** 逐迭代明细（按 index 升序） */
  records: LoopIterationRecord[];
  /** 明细条数是否被截断（超出明细上限时保留前段；进度以 total / done 为准） */
  truncated: boolean;
}

/** 单节点执行记录：该节点最后一次执行的完整快照（调试回放用，见 M6-T2） */
export interface NodeRun {
  status: NodeRunStatus;
  /** 上游节点输出聚合成的入参 */
  input: unknown;
  /** 后置处理产出的返回值 */
  output: unknown;
  error?: string;
  startedAt: Timestamp;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /**
   * 循环节点的迭代进度与逐迭代明细（M13-T9，可选）：仅 loop 节点执行后由
   * loop runner 经执行器快照扩展槽并入。其余节点 / 旧记录恒无此字段。
   */
  iterations?: LoopIterationsSummary;
}

/**
 * 工作流运行状态。'interrupted'（运行中断）为归档 SW 孤儿扫描专有的落库终态：
 * 该状态只存在于落库记录，执行器自身从不产生该迁移（载荷基座无 SW 回收问题，
 * 保留取值仅为记录形状兼容）。
 */
export type RunStatus = "running" | "success" | "failed" | "cancelled" | "interrupted";

/** 运行触发方式：编辑器手动运行 / 单节点调试（M6-T4，可扩展） */
export type RunTrigger = "manual" | "debug";

/**
 * 运行时图快照（M17-T1）：运行开始时刻的流程节点 / 连线副本。
 * 构建口径（JSON 安全深拷贝 + 恒定剥离 config.pinnedOutput + 256KB 体积上限
 * 超限降级）见 run-graph-snapshot.ts 文件头。
 */
export interface RunGraphSnapshot {
  /** 运行开始时刻的流程节点（纯数据副本，config 已剥离固定输出） */
  nodes: WorkflowNode[];
  /** 运行开始时刻的流程连线 */
  edges: WorkflowEdge[];
  /** 体积超限降级标记（可选）：true 时 nodes 为「骨架」形态 */
  truncated?: boolean;
}

/** 一次工作流运行的记录 */
export interface RunRecord {
  id: RunId;
  workflowId: WorkflowId;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: Timestamp;
  /** 结束时间；status 为 'running' / 'interrupted' 时尚未产生（中断时刻不可知） */
  finishedAt?: Timestamp;
  /** 运行级错误摘要（status 为 'failed' / 'cancelled' / 'interrupted' 时） */
  error?: string;
  /** 按节点 id 索引的执行快照 */
  nodeRuns: Record<NodeId, NodeRun>;
  /** 运行时图快照（M17-T1，可选）：运行开始时随记录落库 */
  graph?: RunGraphSnapshot;
}
