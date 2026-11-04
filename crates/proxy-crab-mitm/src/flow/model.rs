//! 工作流域模型（ReqFlow 复刻计划 Task 10 Step 1/3）。
//!
//! 类型与字段逐一对齐归档 ReqFlow（`_archive/reqflow` main@485fa00）的
//! `src/types/model.ts`，serde 全部 camelCase，落盘形状与 ReqFlow 导出 JSON
//! 一致（工作流导入导出与模板引用语义共享同一形状）。9 类节点共用一个扁平
//! [`NodeConfig`]（全部字段可选，按节点类型取用），与 ReqFlow 相同。
//!
//! 宽容口径（保持「坏数据不整条不可读」的存储约定）：
//! - `method`/`url` 等开放字符串保留原文（ReqFlow 的 HttpMethod 联合是编译期
//!   约束，运行时/存储层不拒绝非标准方法）；
//! - `cookieMode` 历史 `browser` 档等未知值读入按缺省 [`NodeCookieMode::Snapshot`]
//!   语义归一；`csvDelimiter` 非法值读入回退逗号（与 ReqFlow 执行期语义一致）；
//! - 数值范围（重试上限、延时上限等）是执行期收敛，不属于存储校验。
//!
//! 本模块同时承载 refId 短码原语（对齐 `engine/ref-id.ts`）与读时迁移入口
//! [`migrate_workflow`]（对齐归档 `WorkflowRepo.get` 的 `ensureWorkflowRefIds`
//! 语义：回填缺失短码并把 config 里的旧内部 id 模板引用改写为短码，幂等）。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// 工作流定义文档的当前 schema 版本。读取到更低版本的文档时按
/// [`migrate_workflow`] 的迁移链逐版本推进；更高版本直接判为不支持
/// （向前不兼容，避免静默丢字段）。
pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;

/// 画布平面坐标（节点位置）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// 项目：流程的顶层分组容器（ReqFlow `Project`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 展示用颜色（HEX，如 `#4f46e5`）。
    #[serde(default)]
    pub color: String,
    /// 项目级变量（与项目下全部流程共享，优先级低于流程级变量）。
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    /// 项目级 secret 变量表（运行记录脱敏、导出剔除值）。
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 工作流：属于某个项目的节点画布编排（ReqFlow `Workflow`）。
///
/// `schemaVersion` 是文档版本号（见 [`WORKFLOW_SCHEMA_VERSION`]）；写入恒为
/// 当前版本，读取低版本文档时经 [`migrate_workflow`] 推进。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    /// 流程级变量（模板 `{{ var.<名> }}` 命名空间）。
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
    /// 流程级 secret 变量表（运行记录脱敏、导出剔除值）。
    #[serde(default)]
    pub secret_variables: BTreeMap<String, String>,
    #[serde(default)]
    pub schema_version: u32,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 节点类型字面量联合（serde camelCase 恰好产出 ReqFlow 的 9 个字面量）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowNodeType {
    Start,
    HttpReplay,
    Condition,
    Loop,
    Delay,
    SetVariable,
    Assert,
    Transform,
    StickyNote,
}

/// 画布节点。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: WorkflowNodeType,
    pub position: Position,
    pub config: NodeConfig,
    /// 展示名；缺省用节点注册表的默认标签。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 节点引用短码（5 位纯字母，见 [`is_valid_ref_id`]）：模板
    /// `{{ node.<refId>.path }}` 的解析键，流程内唯一；缺省读取侧回退内部 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
}

/// 条件分支出口标识：条件节点出边手柄，`'true'` 真分支 / `'false'` 假分支。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConditionBranchHandle {
    True,
    False,
}

/// 画布连线：source → target 的有向边。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    /// 分支手柄，仅 source 为 condition 节点时落值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handle: Option<ConditionBranchHandle>,
}

/// 节点失败策略：失败即停（缺省）/ 失败继续。非法值在反序列化边界直接拒绝
/// （整份文档判损坏），落实「failPolicy 合法值」校验口径。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeFailPolicy {
    Stop,
    Continue,
}

/// 请求覆盖项：在引用快照基础上手动覆盖的部分字段（仅覆盖给出的字段）。
///
/// `method` 保留原文以容忍非标准方法（见模块头宽容口径）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    /// 从引用快照中删除的请求头（大小写不敏感）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_headers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// 无引用时作为请求基线保存的手动请求。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// header 保真单项的取值方式：捕获值恢复 / 手动指定（支持模板）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HeaderFidelitySource {
    FromCapture,
    Static,
}

/// header 保真单项：单个受保护头的注入取值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFidelityItem {
    pub source: HeaderFidelitySource,
    /// `source = 'static'` 时的注入值；fromCapture 时忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// 节点级 header 保真配置：按头逐项，键缺省 = 回放捕获值。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeHeaderFidelity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<HeaderFidelityItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referer: Option<HeaderFidelityItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<HeaderFidelityItem>,
}

/// 重放请求的 Cookie 携带方式。缺省（字段不存在）按 snapshot 处理；历史残留
/// 的 `browser` 等未知值读入归一为 snapshot（ReqFlow 执行期同语义）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeCookieMode {
    Snapshot,
    Custom,
}

impl NodeCookieMode {
    fn deserialize_lenient(value: &str) -> Self {
        match value {
            "custom" => Self::Custom,
            // 'snapshot' 与历史 'browser' / 其他未知值都按缺省快照语义。
            _ => Self::Snapshot,
        }
    }
}

impl<'de> Deserialize<'de> for NodeCookieMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::deserialize_lenient(&String::deserialize(deserializer)?))
    }
}

/// 变量赋值项的取值来源：input 聚合入参 / node 指定节点输出 / var 既有变量 /
/// literal 字面量。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VariableAssignmentSource {
    Input,
    Node,
    Var,
    Literal,
}

/// 变量赋值项（setVariable 节点 `assignments` 的元素）：按数组顺序执行。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VariableAssignment {
    /// 目标变量名（空名在执行期按节点失败处理）。
    pub name: String,
    pub from: VariableAssignmentSource,
    /// 点分取值路径（空串/缺省 = 取来源根值；from = literal 时忽略）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `from = 'node'` 时的源节点 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// `from = 'literal'` 时的字面量值（字符串支持模板渲染）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

/// 状态码断言的比较方式：精确等于或落在某百位段。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum StatusCodeOperator {
    #[serde(rename = "eq")]
    Eq,
    #[serde(rename = "2xx")]
    Class2Xx,
    #[serde(rename = "3xx")]
    Class3Xx,
    #[serde(rename = "4xx")]
    Class4Xx,
    #[serde(rename = "5xx")]
    Class5Xx,
}

/// JSONPath 断言的比较方式（exists = 路径至少匹配到一个值）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JsonPathOperator {
    Eq,
    Ne,
    Contains,
    Regex,
    Exists,
}

/// 状态码断言规则：对入参的数字 status 字段做段/精确比较。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusAssertionRule {
    pub op: StatusCodeOperator,
    /// `op = 'eq'` 时的期望状态码；段比较时忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u16>,
}

/// JSONPath 断言规则：取值后逐值比较（deep equal）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JsonPathAssertionRule {
    pub path: String,
    pub op: JsonPathOperator,
    /// eq/ne/contains 参与比较（任意 JSON）；regex 为正则源文本；exists 忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
}

/// JSON Schema 断言规则：对目标值校验常用子集关键字（type/required/properties/items/enum）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaAssertionRule {
    /// 待校验目标的 JSONPath（缺省/空串 = 对入参根值整体校验）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Schema 定义（保留原文，子集校验在执行期）。
    pub schema: JsonValue,
}

/// 断言规则判别联合（按 `kind` 分派）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssertionRule {
    Status(StatusAssertionRule),
    JsonPath(JsonPathAssertionRule),
    Schema(SchemaAssertionRule),
}

/// 条件构建器的 15 个比较操作符（编译语义在引擎载荷侧）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConditionOperator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsEmpty,
    IsNotEmpty,
    IsTrue,
    IsFalse,
    Matches,
}

/// 条件树叶子：一条「左值 操作符 右值」判定（一元操作符不用 right）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionLeaf {
    /// 左值模板（裸路径 = input 简写；一元操作符留空 = 判断整个入参根）。
    pub left: String,
    pub operator: ConditionOperator,
    /// 右值（标量；一元操作符缺省）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<JsonValue>,
}

/// 条件树分组的组内连接方式。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConditionGroupOperator {
    #[default]
    And,
    Or,
}

/// 条件树分组：嵌套表达复合条件；条件节点落库形态的根恒为本类型。
///
/// 形状差异说明：根对象不携带 `type` 判别键——引擎与画布只消费
/// `op` / `not` / `children`，ReqFlow 导出根上的 `type: 'group'` 键在读取侧
/// 由 serde 忽略；嵌套子项经 [`ConditionNode`] 的 `type` 正常分派（根再带
/// 判别键会与内部 tag 枚举重复注入同名键）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionGroup {
    pub op: ConditionGroupOperator,
    /// 整组取反（缺省 false 不落键）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub not: bool,
    /// 子项（叶子/嵌套分组，按数组顺序求值）。
    pub children: Vec<ConditionNode>,
}

/// 条件树节点判别联合（按 `type` 分派；分组可嵌套）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConditionNode {
    Cond(ConditionLeaf),
    Group(ConditionGroup),
}

/// 条件构建器的旧版扁平规则行（legacy，仅旧数据迁移读取）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionRuleRow {
    /// 与上一条规则行的连接方式（首行忽略）。
    pub join: ConditionGroupOperator,
    pub left: String,
    pub op: ConditionOperator,
    /// 右值模板；一元操作符不使用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<JsonValue>,
}

/// 循环节点的迭代数据源：JSON 数组字面量或模板字符串（渲染后 JSON.parse）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum LoopItems {
    Array(Vec<JsonValue>),
    Template(String),
}

/// CSV 分隔符（仅 `,` / `;` / `\t` 合法；非法值读入回退逗号，执行期同语义）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum CsvDelimiter {
    #[serde(rename = ",")]
    Comma,
    #[serde(rename = ";")]
    Semicolon,
    #[serde(rename = "\t")]
    Tab,
}

impl CsvDelimiter {
    fn deserialize_lenient(value: &str) -> Self {
        match value {
            ";" => Self::Semicolon,
            "\t" => Self::Tab,
            // ',' 与其他非法值都回退缺省逗号。
            _ => Self::Comma,
        }
    }
}

impl<'de> Deserialize<'de> for CsvDelimiter {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::deserialize_lenient(&String::deserialize(deserializer)?))
    }
}

/// 提取规则的查询语言：JSONPath 子集或 JMESPath。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransformEngine {
    JsonPath,
    Jmespath,
}

/// 提取规则（transform 节点 `extractions` 的元素）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransformExtractionRule {
    /// 规则名（多规则时输出对象的键；单条规则时忽略）。
    pub name: String,
    pub engine: TransformEngine,
    /// 查询表达式（如 `$.data.token`）。
    pub path: String,
}

/// 重试退避配置（全节点可选；数值上限在执行期收敛）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRetryConfig {
    /// 最大尝试次数（含首次；1 = 不重试）。
    pub max_attempts: u32,
    /// 首次重试前的等待毫秒数。
    pub backoff_ms: u64,
    /// 退避乘数（缺省 2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiplier: Option<f64>,
}

/// 节点固定输出（pinned data）：存在时节点不执行，直接以 value 为 output。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodePinnedOutput {
    /// 固定的输出值。
    pub value: JsonValue,
    /// 固定时刻（Unix 毫秒）。
    pub pinned_at: u64,
    /// 来源运行 id。
    pub source_run_id: String,
}

/// 便签卡尺寸（像素；缺省/非法值按默认尺寸渲染）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteSize {
    pub width: f64,
    pub height: f64,
}

/// 节点配置：一次请求重放/逻辑处理的全部可调参数。9 类节点共用，所有字段
/// 可选、按节点类型取用，字段清单逐一对齐 ReqFlow `NodeConfig`。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    /* ---- httpReplay 节点 ---- */
    /// 引用请求库的条目 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// 未引用快照时使用的独立请求基线。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_request: Option<ManualRequest>,
    /// 手动覆盖 method / url / headers / removedHeaders / body（`override` 为
    /// Rust 保留字，字段名经 serde rename 对齐）。
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    pub override_: Option<RequestOverride>,
    /// 前置处理脚本：input → 请求上下文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_process: Option<String>,
    /// 后置处理脚本：response → output。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_process: Option<String>,
    /// 重放超时（毫秒）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// 失败策略，缺省 stop。非法值在反序列化边界拒绝（见 [`NodeFailPolicy`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_policy: Option<NodeFailPolicy>,
    /// header 保真配置（缺省 = 全部不注入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_fidelity: Option<NodeHeaderFidelity>,
    /// Cookie 携带方式（缺省/未知值 = snapshot）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie_mode: Option<NodeCookieMode>,
    /// Cookie 自定义值（cookieMode = custom 时生效；支持模板）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie_value: Option<String>,

    /* ---- condition 节点 ---- */
    /// 条件表达式（脚本函数体；条件树编译产物，缺省/空串视为恒 false）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    /// 真分支下游节点 id 清单（legacy，仅旧数据迁移读取）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub true_targets: Option<Vec<String>>,
    /// 假分支下游节点 id 清单（legacy）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub false_targets: Option<Vec<String>>,
    /// 结构化条件规则行（legacy 扁平 DNF 形态，迁移读取源）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition_rules: Option<Vec<ConditionRuleRow>>,
    /// 条件树（落库形态，根恒为 group；引擎只读 expression，本字段零参与执行）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<ConditionGroup>,

    /* ---- loop 节点 ---- */
    /// 迭代数据源（数组字面量或模板字符串；缺省 = 空数组）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<LoopItems>,
    /// 迭代轮数上限（缺省 100，硬上限 1000 执行期收敛）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    /// CSV 数据源文本（优先于 items）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csv_text: Option<String>,
    /// CSV 分隔符（非法值读入回退逗号）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csv_delimiter: Option<CsvDelimiter>,
    /// 并发迭代数（1~16；缺省/非法 1 = 串行）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    /// 限速间隔毫秒（0~60000）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,

    /* ---- delay 节点 ---- */
    /// 延时时长毫秒（上限 300000，超限执行期判失败）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /* ---- setVariable 节点 ---- */
    /// 赋值项列表（缺省空 = 纯透传）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignments: Option<Vec<VariableAssignment>>,

    /* ---- assert 节点 ---- */
    /// 断言规则列表（缺省/空 = 无断言透传）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertions: Option<Vec<AssertionRule>>,

    /* ---- transform 节点 ---- */
    /// 提取规则列表（缺省/空 = 透传 input）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extractions: Option<Vec<TransformExtractionRule>>,

    /* ---- stickyNote 节点（纯注释卡，不入执行拓扑） ---- */
    /// 便签正文（纯文本，支持换行）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 便签配色（预设色板 token 名）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// 便签卡尺寸。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<StickyNoteSize>,

    /* ---- 全节点 ---- */
    /// 重试退避配置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<NodeRetryConfig>,
    /// 固定输出（存在时节点不执行）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_output: Option<NodePinnedOutput>,
}

/* ------------------------------------------------------------------ *
 * refId 短码原语（对齐归档 engine/ref-id.ts）
 * ------------------------------------------------------------------ */

/// 短码长度（固定 5 位纯字母）。
const REF_ID_LENGTH: usize = 5;
/// 短码字符集：52 个大小写字母（无数字，避免与模板路径数字段歧义）。
const REF_ID_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// 是否为合法短码（恰好 5 位纯 ASCII 字母）。缺失/空串不算非法——读取侧
/// 回退内部 id，属合法形态（与归档 `isValidRefId` 一致）。
pub fn is_valid_ref_id(value: &str) -> bool {
    value.len() == REF_ID_LENGTH && value.bytes().all(|byte| byte.is_ascii_alphabetic())
}

/// 判断短码占用的集合：节点 id 与既有 refId 都不可被新短码命中。
fn taken_ref_keys(workflow: &Workflow) -> BTreeSet<String> {
    let mut taken = BTreeSet::new();
    for node in &workflow.nodes {
        taken.insert(node.id.clone());
        if let Some(ref_id) = non_empty_ref_id(node) {
            taken.insert(ref_id);
        }
    }
    taken
}

fn non_empty_ref_id(node: &WorkflowNode) -> Option<String> {
    node.ref_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// 生成一个不在 `exclude` 占用集合内的随机 5 位字母短码（冲突重摇）。
pub fn generate_ref_id(exclude: &BTreeSet<String>) -> String {
    let mut bytes = [0u8; REF_ID_LENGTH];
    let mut attempt = 0u8;
    loop {
        attempt = attempt.wrapping_add(1);
        if getrandom::fill(&mut bytes).is_err() {
            // OS 随机源不可用的兜底（受支持平台几乎不触发）：时钟纳秒熵
            // 混入尝试计数，保证候选逐轮变化、不困在同一值上。
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos())
                .unwrap_or(0);
            for (index, slot) in bytes.iter_mut().enumerate() {
                *slot = (nanos >> (index * 3)) as u8 ^ attempt;
            }
        }
        let candidate: String = bytes
            .iter()
            .map(|byte| REF_ID_ALPHABET[*byte as usize % REF_ID_ALPHABET.len()] as char)
            .collect();
        if !exclude.contains(&candidate) {
            return candidate;
        }
    }
}

/* ------------------------------------------------------------------ *
 * 模板引用改写（对齐归档 storage/workflow-transfer.ts 的迁移通道）
 * ------------------------------------------------------------------ */

/// 改写模板字符串中对旧节点内部 id 的引用（`{{ node.<oldId>` → 新 refId）。
///
/// 扫描 `{{ ... }}` 表达式；内容 trim 后以 `node.<token>` 开头且 token 命中
/// 映射表时替换，token 是到下一个「.」或表达式结束为止的完整片段（不误替换
/// 仅前缀相同的 id）；根不是 node / 未命中 / 语法不符的表达式原样保留；
/// 未闭合的 `{{` 尾部文本整体按字面量保留。
pub fn rewrite_template_node_refs(raw: &str, ref_id_by_node_id: &BTreeMap<String, String>) -> String {
    if !raw.contains("{{") || ref_id_by_node_id.is_empty() {
        return raw.to_owned();
    }
    let mut result = String::with_capacity(raw.len());
    let mut cursor = 0;
    while cursor < raw.len() {
        let Some(open) = raw[cursor..].find("{{").map(|offset| cursor + offset) else {
            result.push_str(&raw[cursor..]);
            break;
        };
        let Some(close) = raw[open + 2..].find("}}").map(|offset| open + 2 + offset) else {
            // 未闭合：其余整体按字面量保留（与模板引擎的兜底语义一致）。
            result.push_str(&raw[cursor..]);
            break;
        };
        let content = &raw[open + 2..close];
        result.push_str(&raw[cursor..open + 2]);

        // 与模板引擎一致：内容先 trim 再解析，重建时把首尾空白原样接回。
        let trimmed = content.trim();
        if let Some(rest) = trimmed.strip_prefix("node.") {
            // token = 到下一个「.」为止的完整片段。
            let token = match rest.find('.') {
                Some(dot) => &rest[..dot],
                None => rest,
            };
            if let Some(replacement) = ref_id_by_node_id.get(token) {
                result.push_str(leading_whitespace(content));
                result.push_str("node.");
                result.push_str(replacement);
                result.push_str(&rest[token.len()..]);
                result.push_str(trailing_whitespace(content));
                result.push_str("}}");
                cursor = close + 2;
                continue;
            }
        }
        // 不在映射表 / 根不是 node / 语法不符：表达式原样保留。
        result.push_str(content);
        result.push_str("}}");
        cursor = close + 2;
    }
    result
}

fn leading_whitespace(content: &str) -> &str {
    let trimmed_start = content.len() - content.trim_start().len();
    &content[..trimmed_start]
}

fn trailing_whitespace(content: &str) -> &str {
    let start = content.len() - content.trim_start().len();
    let inner_end = start + content.trim_start().trim_end().len();
    &content[inner_end..]
}

/// 深度改写 JSON 值中全部字符串里的旧节点引用 token（对象键不改写）。
fn remap_value_node_refs(
    value: JsonValue,
    ref_id_by_node_id: &BTreeMap<String, String>,
) -> JsonValue {
    match value {
        JsonValue::String(text) => {
            JsonValue::String(rewrite_template_node_refs(&text, ref_id_by_node_id))
        }
        JsonValue::Array(items) => JsonValue::Array(
            items
                .into_iter()
                .map(|item| remap_value_node_refs(item, ref_id_by_node_id))
                .collect(),
        ),
        JsonValue::Object(entries) => JsonValue::Object(
            entries
                .into_iter()
                .map(|(key, item)| (key, remap_value_node_refs(item, ref_id_by_node_id)))
                .collect(),
        ),
        other => other,
    }
}

/// 改写一个节点 config 中全部字符串值的模板引用（经 JSON 值往返）。
/// 供读时迁移与导入重映射共用（transfer.rs 的映射表为「旧 token → 新 refId」）。
pub(crate) fn remap_node_config_refs(
    config: &NodeConfig,
    ref_id_by_node_id: &BTreeMap<String, String>,
) -> NodeConfig {
    let Ok(value) = serde_json::to_value(config) else {
        return config.clone();
    };
    let remapped = remap_value_node_refs(value, ref_id_by_node_id);
    serde_json::from_value(remapped).unwrap_or_else(|_| config.clone())
}

/* ------------------------------------------------------------------ *
 * 读时迁移（对齐归档 WorkflowRepo.get 的 ensureWorkflowRefIds 语义）
 * ------------------------------------------------------------------ */

/// 把低 schema 版本的流程定义推进到当前版本，返回是否发生了迁移。
///
/// 版本 0（历史文档，缺 `schemaVersion` 字段）→ 1：refId 回填——缺失短码的
/// 节点随机生成 5 位字母短码（占用集合 = 全部节点 id + 既有 refId，冲突重摇；
/// 已有短码含手工写坏的非法值原样保留），并把全部节点 config 字符串中的
/// `{{ node.<旧内部 id>` 模板引用批量改写为对应短码。幂等：全部节点均已持有
/// 短码时零改写。
pub fn migrate_workflow(workflow: &mut Workflow) -> bool {
    let mut changed = false;
    if workflow.schema_version < 1 {
        changed = ensure_ref_ids(workflow);
    }
    // 后续字段演进在此追加版本段（`schema_version < 2 && …` 形态）。
    if workflow.schema_version < WORKFLOW_SCHEMA_VERSION {
        workflow.schema_version = WORKFLOW_SCHEMA_VERSION;
        changed = true;
    }
    changed
}

/// refId 回填（[`migrate_workflow`] 的版本 0 → 1 通道）：返回是否发生改写。
fn ensure_ref_ids(workflow: &mut Workflow) -> bool {
    let mut taken = taken_ref_keys(workflow);
    let mut changed = false;
    let mut ref_id_by_node_id: BTreeMap<String, String> = BTreeMap::new();
    for node in &workflow.nodes {
        let ref_id = match non_empty_ref_id(node) {
            Some(existing) => existing,
            None => {
                changed = true;
                let generated = generate_ref_id(&taken);
                taken.insert(generated.clone());
                generated
            }
        };
        ref_id_by_node_id.insert(node.id.clone(), ref_id);
    }
    if !changed {
        return false;
    }
    for node in &mut workflow.nodes {
        let Some(ref_id) = ref_id_by_node_id.get(&node.id) else {
            continue;
        };
        node.ref_id = Some(ref_id.clone());
        node.config = remap_node_config_refs(&node.config, &ref_id_by_node_id);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_id_validation_and_generation_match_archive_pattern() {
        assert!(is_valid_ref_id("abcde"));
        assert!(is_valid_ref_id("AbCdE"));
        assert!(!is_valid_ref_id("abcd"));
        assert!(!is_valid_ref_id("abcdef"));
        assert!(!is_valid_ref_id("abc1e"));
        assert!(!is_valid_ref_id(""));
        let exclude = BTreeSet::from(["aaaaa".to_owned()]);
        let generated = generate_ref_id(&exclude);
        assert!(is_valid_ref_id(&generated));
        assert!(!exclude.contains(&generated));
    }

    #[test]
    fn template_rewrite_rewrites_whole_tokens_only() {
        let map = BTreeMap::from([("n1".to_owned(), "abcde".to_owned())]);
        assert_eq!(
            rewrite_template_node_refs("{{ node.n1.body.token }}", &map),
            "{{ node.abcde.body.token }}"
        );
        // 前缀雷同的 id 不受影响（token 边界）。
        assert_eq!(
            rewrite_template_node_refs("{{ node.n1x.path }}", &map),
            "{{ node.n1x.path }}"
        );
        // 根不是 node / 未命中：原样保留。
        assert_eq!(
            rewrite_template_node_refs("{{ var.token }} {{ node.n2.path }}", &map),
            "{{ var.token }} {{ node.n2.path }}"
        );
        // 保留首尾空白与表达式其余文本。
        assert_eq!(
            rewrite_template_node_refs("{{  node.n1  }}", &map),
            "{{  node.abcde  }}"
        );
        // 未闭合的 {{ 尾部整体按字面量保留。
        assert_eq!(rewrite_template_node_refs("x {{ node.n1", &map), "x {{ node.n1");
        // 无 {{ 时零拷贝语义（原样返回）。
        assert_eq!(rewrite_template_node_refs("plain", &map), "plain");
    }

    #[test]
    fn lenient_enums_normalize_legacy_values() {
        assert_eq!(
            serde_json::from_value::<NodeCookieMode>(serde_json::json!("browser")).unwrap(),
            NodeCookieMode::Snapshot
        );
        assert_eq!(
            serde_json::from_value::<NodeCookieMode>(serde_json::json!("custom")).unwrap(),
            NodeCookieMode::Custom
        );
        assert_eq!(
            serde_json::from_value::<CsvDelimiter>(serde_json::json!("x")).unwrap(),
            CsvDelimiter::Comma
        );
        assert_eq!(
            serde_json::to_value(CsvDelimiter::Tab).unwrap(),
            serde_json::json!("\t")
        );
        // failPolicy 是严格枚举：非法值在反序列化边界拒绝。
        let config: Result<NodeConfig, _> =
            serde_json::from_value(serde_json::json!({ "failPolicy": "sometimes" }));
        assert!(config.is_err());
    }
}
