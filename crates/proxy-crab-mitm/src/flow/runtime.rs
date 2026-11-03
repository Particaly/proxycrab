//! 内嵌 QuickJS 运行时（rquickjs，vendored QuickJS）。
//!
//! 线程模型：单次运行一个 VM 上下文（一个 `AsyncRuntime` + `AsyncContext`），
//! 运行结束整体丢弃，不同运行的 VM 互不共享；运行时为 tokio 原生
//! （rquickjs `futures` + `parallel` feature），宿主异步调用以 Promise 等待，
//! 不阻塞 tokio worker 线程。沙箱只含 QuickJS 标准内建（Math/JSON/Date/
//! RegExp 等），不启用 rquickjs 的 loader/std 模块，因此 io/os 等外部宿主
//! 对象不可能进入沙箱，唯一注入的全局对象是 `host`（见 [`super::host`]）。
//!
//! 三重上限（见 [`FlowLimits`]）：内存（QuickJS 堆限额）、指令配额（中断
//! 处理器触发次数，QuickJS 约每数千条字节码触发一次）、墙钟（累计「活跃」
//! JS 执行时间，await 宿主调用期间不计时）。取消优先于一切超限。

use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use rquickjs::{
    AsyncContext, AsyncRuntime, Ctx, Exception, Function, Object, Value,
    function::Async as AsyncFunc,
};
use serde_json::Value as JsonValue;

use super::host::{FlowCancel, FlowError, FlowErrorKind, FlowHost};

/// 中断原因槽位：无中断。
const INTERRUPT_NONE: u8 = 0;
/// 中断原因槽位：运行被取消（优先于超限）。
const INTERRUPT_CANCELLED: u8 = 1;
/// 中断原因槽位：指令配额耗尽。
const INTERRUPT_INSTRUCTIONS: u8 = 2;
/// 中断原因槽位：墙钟预算耗尽。
const INTERRUPT_WALL_CLOCK: u8 = 3;

/// 运行三重上限。任一预算耗尽统一归一为 `timeout` 类错误（取消除外）；
/// 上限值均为可配置默认，由调用方按场景收紧或放宽。
#[derive(Debug, Clone, Copy)]
pub struct FlowLimits {
    /// QuickJS 堆内存上限（字节）。默认 64 MiB。
    pub memory_bytes: usize,
    /// 指令配额：中断处理器触发次数上限（每次触发约对应数千条字节码指令）。
    /// 默认 100_000。
    pub instruction_quota: u64,
    /// 墙钟预算：累计「活跃」JS 执行时间上限（await 宿主调用期间不计时）。
    /// 默认 30 秒。
    pub wall_clock: Duration,
}

impl Default for FlowLimits {
    fn default() -> Self {
        Self {
            memory_bytes: 64 * 1024 * 1024,
            instruction_quota: 100_000,
            wall_clock: Duration::from_secs(30),
        }
    }
}

/// 一次工作流运行的 JS 虚拟机：持有独立的 AsyncRuntime/AsyncContext、
/// 三重上限与宿主桥包装。创建（[`FlowRuntime::new`]）与使用（[`FlowRuntime::run`]）
/// 均为 async；[`FlowRuntime::cancel`] 可从任意线程发起取消。
pub struct FlowRuntime {
    ctx: AsyncContext,
    cancel: FlowCancel,
    /// 最近一次中断处理器的触发原因（分类 Interrupted 错误时读取）。
    interrupt_reason: Arc<AtomicU8>,
}

impl FlowRuntime {
    /// 创建 VM：配置三重上限、安装中断处理器并注册 `host` 全局对象。
    ///
    /// - `host`：宿主桥实现；真实重放接线在后续任务提供，测试用桩实现。
    /// - `cancel`：与宿主实现/运行编排共享的取消句柄，取消优先于超限。
    /// - `limits`：三重上限，超限统一归 `timeout`。
    ///
    /// 失败仅发生在 VM 初始化（内存不足等），归一为 `unknown` 类 [`FlowError`]。
    pub async fn new(
        host: Arc<dyn FlowHost>,
        cancel: FlowCancel,
        limits: FlowLimits,
    ) -> Result<Self, FlowError> {
        let map_init = |error: rquickjs::Error| {
            FlowError::unknown(format!("failed to initialize flow VM: {error}"))
        };
        let runtime = AsyncRuntime::new().map_err(map_init)?;
        runtime.set_memory_limit(limits.memory_bytes).await;
        // 默认 256 KiB 对工作流引擎的递归处理（json-path 等）偏紧，放宽到 1 MiB。
        runtime.set_max_stack_size(1024 * 1024).await;

        // 中断处理器：由引擎在执行字节码期间周期性调用，返回 true 即不可恢复地
        // 中断当前执行。计数器/计时状态留在闭包内；触发原因写入原子槽位供分类。
        let interrupt_reason = Arc::new(AtomicU8::new(INTERRUPT_NONE));
        let reason_slot = interrupt_reason.clone();
        let handler_cancel = cancel.clone();
        let mut ticks: u64 = 0;
        let mut last_tick = Instant::now();
        let mut active_time = Duration::ZERO;
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                let now = Instant::now();
                active_time += now - last_tick;
                last_tick = now;
                if handler_cancel.is_cancelled() {
                    reason_slot.store(INTERRUPT_CANCELLED, Ordering::Relaxed);
                    return true;
                }
                ticks += 1;
                if ticks >= limits.instruction_quota {
                    reason_slot.store(INTERRUPT_INSTRUCTIONS, Ordering::Relaxed);
                    return true;
                }
                if active_time >= limits.wall_clock {
                    reason_slot.store(INTERRUPT_WALL_CLOCK, Ordering::Relaxed);
                    return true;
                }
                false
            })))
            .await;

        let ctx = AsyncContext::full(&runtime).await.map_err(map_init)?;
        // 宿主调用统一与取消信号竞速：取消时立即放弃等待中的调用（含慢重放/睡眠），
        // 不必等宿主操作自然完成。
        let guarded: Arc<dyn FlowHost> = Arc::new(GuardedHost {
            inner: host,
            cancel: cancel.clone(),
        });
        register_host_object(&ctx, guarded)
            .await
            .map_err(map_init)?;

        Ok(Self {
            ctx,
            cancel,
            interrupt_reason,
        })
    }

    /// 执行脚本并等待其返回值：脚本可返回普通值或 Promise（如 async IIFE），
    /// 返回值经 JSON 载荷化后交付（契约要求运行结果为显式 JSON）。
    ///
    /// 失败统一归一为 [`FlowError`]：脚本抛错/语法错误 → `script`，
    /// 中断（配额/墙钟）与内存超限 → `timeout`，取消 → `cancelled`，
    /// 宿主桥错误保持宿主给定的类别，其余 VM 错误 → `unknown`。
    pub async fn run(&self, script: &str) -> Result<JsonValue, FlowError> {
        let interrupt_reason = self.interrupt_reason.clone();
        let cancel = self.cancel.clone();
        let main = self
            .ctx
            .async_with(async |ctx| -> Result<JsonValue, FlowError> {
                let value: Value = match ctx.eval(script) {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(classify_failure(&ctx, error, &interrupt_reason, &cancel));
                    }
                };
                // 顶层 eval 不支持 await，异步脚本以 async IIFE 返回 Promise，这里统一等待。
                let value = if let Some(promise) = value.clone().into_promise() {
                    match promise.into_future().await {
                        Ok(value) => value,
                        Err(error) => {
                            return Err(classify_failure(&ctx, error, &interrupt_reason, &cancel));
                        }
                    }
                } else {
                    // 非 Promise 结果原样载荷化。
                    value
                };
                json_in(&ctx, value)
            });

        tokio::pin!(main);
        // 驱动 VM 内部 executor（宿主 future 与微任务），主 future 完成即返回，
        // 残留任务随 VM 丢弃——保证 Rust 侧不会被失控脚本拖死。
        let drive = self.ctx.runtime().drive();
        tokio::pin!(drive);
        tokio::select! {
            result = &mut main => result,
            _ = &mut drive => Err(FlowError::unknown("flow VM driver exited unexpectedly")),
        }
    }

    /// 发起取消；幂等。中断处理器与等待中的宿主调用都会立即感知。
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// 当前是否已取消。
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// 宿主调用包装：每个调用与取消信号竞速，取消发生时放弃等待并归一为
/// `cancelled`（宿主实现无需自行感知取消即可获得可中断语义）。
struct GuardedHost {
    inner: Arc<dyn FlowHost>,
    cancel: FlowCancel,
}

impl GuardedHost {
    /// 将一次宿主调用与取消信号竞速执行。
    async fn guard<F>(&self, call: F) -> Result<JsonValue, FlowError>
    where
        F: std::future::Future<Output = Result<JsonValue, FlowError>>,
    {
        tokio::select! {
            result = call => result,
            _ = self.cancel.cancelled() => Err(FlowError::cancelled("run cancelled during host call")),
        }
    }
}

#[async_trait::async_trait]
impl FlowHost for GuardedHost {
    async fn replay(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.replay(payload)).await
    }

    async fn now(&self) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.now()).await
    }

    async fn log(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.log(payload)).await
    }

    async fn sleep(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.sleep(payload)).await
    }

    async fn emit(&self, payload: JsonValue) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.emit(payload)).await
    }

    async fn cancelled(&self) -> Result<JsonValue, FlowError> {
        self.guard(self.inner.cancelled()).await
    }
}

/// 宿主桥的 userdata 槽位：宿主函数以泛型 fn item 注册（不能使用捕获状态的
/// 闭包——其参数生命周期是晚期绑定的，无法满足 rquickjs 对宿主 future 的
/// `'js` 约束），宿主桥经 `Ctx::userdata` 在调用期取回。
struct HostSlot {
    host: Arc<dyn FlowHost>,
}

// 槽位不含任何绑定 'js 的数据，生命周期变换不影响类型形状。
unsafe impl<'js> rquickjs::JsLifetime<'js> for HostSlot {
    type Changed<'to> = HostSlot;
}

/// `host.replay(payload)`：JSON 载荷进 → 异步重放 → JSON 载荷出。
async fn host_replay<'js>(
    ctx: Ctx<'js>,
    payload: Value<'js>,
) -> Result<Value<'js>, rquickjs::Error> {
    let payload = match json_in(&ctx, payload) {
        Ok(payload) => payload,
        Err(error) => return Err(throw_flow(&ctx, error)),
    };
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.replay(payload).await)
}

/// `host.now()`：当前 Unix 墙钟毫秒数。
async fn host_now<'js>(ctx: Ctx<'js>) -> Result<Value<'js>, rquickjs::Error> {
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.now().await)
}

/// `host.log(payload)`：记录一条运行日志。
async fn host_log<'js>(ctx: Ctx<'js>, payload: Value<'js>) -> Result<Value<'js>, rquickjs::Error> {
    let payload = match json_in(&ctx, payload) {
        Ok(payload) => payload,
        Err(error) => return Err(throw_flow(&ctx, error)),
    };
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.log(payload).await)
}

/// `host.sleep(ms)`：睡眠指定毫秒，取消时由运行时放弃等待。
async fn host_sleep<'js>(
    ctx: Ctx<'js>,
    payload: Value<'js>,
) -> Result<Value<'js>, rquickjs::Error> {
    let payload = match json_in(&ctx, payload) {
        Ok(payload) => payload,
        Err(error) => return Err(throw_flow(&ctx, error)),
    };
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.sleep(payload).await)
}

/// `host.emit(payload)`：上报一条运行事件。
async fn host_emit<'js>(ctx: Ctx<'js>, payload: Value<'js>) -> Result<Value<'js>, rquickjs::Error> {
    let payload = match json_in(&ctx, payload) {
        Ok(payload) => payload,
        Err(error) => return Err(throw_flow(&ctx, error)),
    };
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.emit(payload).await)
}

/// `host.cancelled()`：取消轮询，立即返回当前状态。
async fn host_cancelled<'js>(ctx: Ctx<'js>) -> Result<Value<'js>, rquickjs::Error> {
    let host = host_slot(&ctx)?;
    host_result(&ctx, host.host.cancelled().await)
}

/// 取回宿主桥槽位（支持并发读）；未注册属内部错误，注入 JS 异常。
fn host_slot<'a, 'js>(
    ctx: &'a Ctx<'js>,
) -> Result<rquickjs::runtime::UserDataGuard<'a, HostSlot>, rquickjs::Error> {
    ctx.userdata::<HostSlot>().ok_or(rquickjs::Error::Unknown)
}

/// 在全局对象上注册 `host`：六个宿主函数，全部以 JSON 载荷进出；
/// 宿主错误转成带 `kind`/`message` 属性的 JS Error 抛出，保证分类跨边界保留。
async fn register_host_object(
    ctx: &AsyncContext,
    host: Arc<dyn FlowHost>,
) -> Result<(), rquickjs::Error> {
    ctx.async_with(async |ctx| -> Result<(), rquickjs::Error> {
        ctx.store_userdata(HostSlot { host })?;
        let host_object = Object::new(ctx.clone())?;
        host_object.set(
            "replay",
            Function::new(ctx.clone(), AsyncFunc(host_replay))?,
        )?;
        host_object.set("now", Function::new(ctx.clone(), AsyncFunc(host_now))?)?;
        host_object.set("log", Function::new(ctx.clone(), AsyncFunc(host_log))?)?;
        host_object.set("sleep", Function::new(ctx.clone(), AsyncFunc(host_sleep))?)?;
        host_object.set("emit", Function::new(ctx.clone(), AsyncFunc(host_emit))?)?;
        host_object.set(
            "cancelled",
            Function::new(ctx.clone(), AsyncFunc(host_cancelled))?,
        )?;
        ctx.globals().set("host", host_object)?;
        Ok(())
    })
    .await
}

/// 宿主调用结果转 JS 值：成功载荷化，宿主错误注入 JS 异常。
fn host_result<'js>(
    ctx: &Ctx<'js>,
    result: Result<JsonValue, FlowError>,
) -> Result<Value<'js>, rquickjs::Error> {
    match result {
        Ok(payload) => json_out(ctx, &payload),
        Err(error) => Err(throw_flow(ctx, error)),
    }
}

/// 把宿主桥错误注入 JS：抛出带 `kind`/`message` 属性的 Error 对象，
/// 返回 `Error::Exception` 供宿主函数返回（rquickjs 以当前异常为拒绝原因）。
fn throw_flow(ctx: &Ctx<'_>, error: FlowError) -> rquickjs::Error {
    match Exception::from_message(ctx.clone(), &error.message) {
        Ok(exception) => {
            let _ = exception.set("kind", error.kind.as_str());
            exception.throw()
        }
        Err(js_error) => js_error,
    }
}

/// 把 JS 值载荷化为 JSON：契约要求宿主进出与运行结果均为显式 JSON
/// （`undefined` 视为 null；循环引用/BigInt 等不可 JSON 化的值归 script 类错误）。
fn json_in<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> Result<JsonValue, FlowError> {
    match ctx.json_stringify(value) {
        Ok(Some(text)) => {
            let text = text.to_string().map_err(|error| {
                FlowError::script(format!("host payload is not readable: {error}"))
            })?;
            serde_json::from_str(&text).map_err(|error| {
                FlowError::script(format!("host payload is not valid JSON: {error}"))
            })
        }
        Ok(None) => Ok(JsonValue::Null),
        Err(error) => Err(FlowError::script(format!(
            "host payload is not JSON-serializable: {error}"
        ))),
    }
}

/// 把 JSON 载荷还原为 JS 值（null/布尔/数字/字符串/数组/对象）。
/// 整数在 i32 范围内用整数表示，其余用浮点，保持 JSON 数值语义。
fn json_out<'js>(ctx: &Ctx<'js>, value: &JsonValue) -> Result<Value<'js>, rquickjs::Error> {
    Ok(match value {
        JsonValue::Null => Value::new_null(ctx.clone()),
        JsonValue::Bool(flag) => Value::new_bool(ctx.clone(), *flag),
        JsonValue::Number(number) => {
            if let Some(int) = number.as_i64() {
                if int >= i32::MIN as i64 && int <= i32::MAX as i64 {
                    Value::new_int(ctx.clone(), int as i32)
                } else {
                    Value::new_float(ctx.clone(), int as f64)
                }
            } else {
                Value::new_float(ctx.clone(), number.as_f64().unwrap_or(f64::NAN))
            }
        }
        JsonValue::String(text) => rquickjs::String::from_str(ctx.clone(), text)?.into_value(),
        JsonValue::Array(items) => {
            let array = rquickjs::Array::new(ctx.clone())?;
            for (index, item) in items.iter().enumerate() {
                array.set(index, json_out(ctx, item)?)?;
            }
            array.into_value()
        }
        JsonValue::Object(entries) => {
            let object = Object::new(ctx.clone())?;
            for (key, item) in entries {
                object.set(key.as_str(), json_out(ctx, item)?)?;
            }
            object.into_value()
        }
    })
}

/// 把 VM 执行错误归一为 [`FlowError`]：内存分配失败与 JS 异常中的
/// out of memory 归 timeout（内存预算），JS 异常中的 interrupted 按中断
/// 处理器记录的原因归类（取消优先于超限），其余 JS 异常按异常对象上的
/// kind 归类（宿主桥错误保持原类别，默认 script），其余 VM 错误归 unknown。
fn classify_failure(
    ctx: &Ctx<'_>,
    error: rquickjs::Error,
    interrupt_reason: &AtomicU8,
    cancel: &FlowCancel,
) -> FlowError {
    match error {
        rquickjs::Error::Allocation => FlowError::timeout("memory limit exceeded"),
        rquickjs::Error::Exception => {
            let value = ctx.catch();
            let message = exception_message(&value);
            if message
                .as_deref()
                .is_some_and(|text| text.contains("out of memory"))
            {
                return FlowError::timeout("memory limit exceeded");
            }
            if message
                .as_deref()
                .is_some_and(|text| text.contains("interrupted"))
            {
                return classify_interrupt(interrupt_reason, cancel);
            }
            classify_exception_value(value, message, cancel)
        }
        other => FlowError::unknown(format!("runtime error: {other}")),
    }
}

/// 把中断处理器记录的触发原因归一为错误；取消优先于超限。
fn classify_interrupt(interrupt_reason: &AtomicU8, cancel: &FlowCancel) -> FlowError {
    match interrupt_reason.load(Ordering::Relaxed) {
        INTERRUPT_CANCELLED => FlowError::cancelled("run cancelled"),
        INTERRUPT_INSTRUCTIONS => FlowError::timeout("instruction quota exceeded"),
        INTERRUPT_WALL_CLOCK => FlowError::timeout("wall-clock budget exceeded"),
        // 处理器未记录原因（防御）：按取消状态兜底归一。
        _ if cancel.is_cancelled() => FlowError::cancelled("run cancelled"),
        _ => FlowError::timeout("execution interrupted by limits"),
    }
}

/// 按 JS 异常值归类：对象携带合法 `kind` 属性（宿主桥错误或脚本透传）时保持
/// 该类别；其余脚本异常归 script（取消竞速中优先取消语义）。
fn classify_exception_value(
    value: Value<'_>,
    message: Option<String>,
    cancel: &FlowCancel,
) -> FlowError {
    if let Some(kind) = value
        .as_object()
        .and_then(|object| object.get::<_, Option<String>>("kind").ok())
        .flatten()
        .and_then(|kind| FlowErrorKind::parse(&kind))
    {
        return FlowError::new(kind, message.unwrap_or_else(|| kind.to_string()));
    }
    if cancel.is_cancelled() {
        // 取消竞速中脚本主动抛错（防御）：取消语义优先。
        return FlowError::cancelled(message.unwrap_or_else(|| "run cancelled".into()));
    }
    FlowError::script(message.unwrap_or_else(|| "script exception".into()))
}

/// 从异常值提取 message：优先 Error 实例的 `message`，其次对象的同名属性。
fn exception_message(value: &Value<'_>) -> Option<String> {
    if let Some(message) = Exception::from_value(value.clone())
        .ok()
        .and_then(|exception| exception.message())
    {
        return Some(message);
    }
    value
        .as_object()
        .and_then(|object| object.get::<_, Option<String>>("message").ok())
        .flatten()
}
