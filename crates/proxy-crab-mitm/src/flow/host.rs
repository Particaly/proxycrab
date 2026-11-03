//! 工作流宿主桥（ReqFlow 复刻计划 Task 1）。
//!
//! 定义沙箱内脚本可见的 `host` 能力面：全部能力以显式 JSON 载荷进出，
//! 错误统一归一为 [`FlowError`]（`kind` 取值对齐 ReqFlow `engine/error-class.ts`
//! 的有限类别集合）。真实重放/事件接线由后续任务（计划 Task 19/20）提供实现，
//! 本任务只约定接口与取消语义，测试用桩实现（`tests/flow_runtime.rs`）。

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use tokio::sync::watch;

/// 运行失败/宿主错误的有限类别，对齐 ReqFlow `engine/error-class.ts` 的
/// `NodeErrorCategory`（`script | timeout | blocked | network | http | cancelled | unknown`）。
///
/// 归类约定（详见 flow::runtime）：脚本自身抛错/语法错误 → `script`；
/// 指令配额、墙钟、内存任一预算耗尽 → `timeout`；脚本被运行环境拒绝 → `blocked`；
/// 宿主桥错误（如重放网络失败）在跨越 JS/Rust 边界时保持宿主给定的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FlowErrorKind {
    /// 脚本自身错误（语法错误、运行时抛错）
    Script,
    /// 执行预算耗尽（指令配额 / 墙钟 / 内存超限）
    Timeout,
    /// 脚本被运行环境拒绝（沙箱通道不可用等环境性拒绝）
    Blocked,
    /// 重放网络失败
    Network,
    /// 重放 HTTP 失败（4xx/5xx 是否判失败由上层决定，分类时单列）
    Http,
    /// 运行被取消（取消优先于其他分类）
    Cancelled,
    /// 其余未分类错误
    Unknown,
}

impl FlowErrorKind {
    /// 类别字符串（异常对象上 `kind` 属性与日志输出使用）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::Timeout => "timeout",
            Self::Blocked => "blocked",
            Self::Network => "network",
            Self::Http => "http",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }

    /// 解析类别字符串；不在有限集合内时返回 `None`（由调用方归一为 script/unknown）。
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "script" => Self::Script,
            "timeout" => Self::Timeout,
            "blocked" => Self::Blocked,
            "network" => Self::Network,
            "http" => Self::Http,
            "cancelled" => Self::Cancelled,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }
}

impl std::fmt::Display for FlowErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 运行失败/宿主桥错误：`kind` + `message`。
///
/// 该形状同时用于宿主 trait 的返回与 VM 运行结果，保证错误分类跨
/// JS/Rust 边界不丢失；Display 采用 `[kind] message` 前缀形式，
/// 与 ReqFlow runner 的错误前缀约定一致。
#[derive(Debug, Clone, thiserror::Error)]
#[error("[{kind}] {message}")]
pub struct FlowError {
    /// 错误类别（有限集合，见 [`FlowErrorKind`]）
    pub kind: FlowErrorKind,
    /// 可读错误信息
    pub message: String,
}

impl FlowError {
    /// 按类别与消息构造。
    pub fn new(kind: FlowErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// 脚本错误便捷构造。
    pub fn script(message: impl Into<String>) -> Self {
        Self::new(FlowErrorKind::Script, message)
    }

    /// 预算耗尽便捷构造（归一为 timeout 类）。
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(FlowErrorKind::Timeout, message)
    }

    /// 取消便捷构造。
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(FlowErrorKind::Cancelled, message)
    }

    /// 未分类错误便捷构造。
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(FlowErrorKind::Unknown, message)
    }
}

/// 运行取消原语：VM 中断处理器、宿主调用竞速与 `host.cancelled` 轮询共享的
/// 同一状态。运行编排方（计划 Task 19）持有实例发起取消，宿主实现与
/// [`FlowRuntime`](super::runtime::FlowRuntime) 各持克隆。
///
/// 克隆即共享同一状态（底层为 `watch` 通道）。
#[derive(Clone)]
pub struct FlowCancel {
    tx: watch::Sender<bool>,
    rx: watch::Receiver<bool>,
}

impl Default for FlowCancel {
    fn default() -> Self {
        let (tx, rx) = watch::channel(false);
        Self { tx, rx }
    }
}

impl FlowCancel {
    /// 创建未取消状态的句柄。
    pub fn new() -> Self {
        Self::default()
    }

    /// 发起取消；幂等，重复调用无副作用。
    pub fn cancel(&self) {
        self.tx.send_if_modified(|cancelled| {
            if *cancelled {
                false
            } else {
                *cancelled = true;
                true
            }
        });
    }

    /// 当前是否已取消。
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// 等待取消发生；已取消时立即返回。用于宿主调用与取消信号竞速。
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// 宿主桥最小面。所有能力以显式 JSON 载荷进出；失败必须以 [`FlowError`]
/// 返回（kind 归一），不得跨边界抛裸异常。实现应尽快返回——运行取消时，
/// 运行时会主动放弃等待中的调用并归一为 `cancelled`。
///
/// 各方法的载荷形状是后续任务（计划 Task 3/19/20）的对接契约：
/// `replay` 的请求描述与响应信封在 Task 3 定稿；`log`/`emit` 的字段
/// 归运行编排约定；本任务仅保证「JSON 进、JSON 出、错误带 kind」。
#[async_trait]
pub trait FlowHost: Send + Sync + 'static {
    /// `host.replay(payload)` —— 经既有重放管线发起出站请求（异步）。
    /// 成功返回响应信封对象；4xx/5xx 属正常响应，是否判失败由脚本/上层决定
    /// （对齐 ReqFlow 语义）。
    async fn replay(&self, payload: JsonValue) -> Result<JsonValue, FlowError>;

    /// `host.now()` —— 当前 Unix 墙钟毫秒数。
    async fn now(&self) -> Result<JsonValue, FlowError>;

    /// `host.log(payload)` —— 记录一条运行日志，返回 null。
    async fn log(&self, payload: JsonValue) -> Result<JsonValue, FlowError>;

    /// `host.sleep(ms)` —— 睡眠指定毫秒（JSON 数字载荷），返回 null。
    /// 「可中断」由运行时保证：取消发生时等待被放弃并归一为 `cancelled`。
    async fn sleep(&self, payload: JsonValue) -> Result<JsonValue, FlowError>;

    /// `host.emit(payload)` —— 上报一条运行事件（节点进度等），返回 null。
    async fn emit(&self, payload: JsonValue) -> Result<JsonValue, FlowError>;

    /// `host.cancelled()` —— 取消轮询：立即返回当前是否已取消（布尔）。
    async fn cancelled(&self) -> Result<JsonValue, FlowError>;
}
