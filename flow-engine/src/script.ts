/**
 * 【限制声明（务必先读）】前置 / 后置处理脚本在本模块内于宿主主线程上**同步**执行：
 * 同步脚本体无法被强制中断（MV3 service worker 不能创建子 Worker），因此这里的
 * "超时"是**软超时**——脚本完整跑完后按实际耗时判定，超限结果被改判为
 * ScriptError{kind:'timeout'}，脚本执行期间已产生的副作用（网络、存储、全局改动等）
 * **无法回滚**。真正的能力隔离与硬超时按 ROADMAP DD-4 / R4 规划，M7 用
 * offscreen document 落地。当前阶段的缓解手段：脚本作者可在长循环里主动调用
 * 沙箱注入的 `__checkDeadline()`（超过截止时间即抛出、循环被真正中断），这是
 * 现阶段唯一能及时终止长循环的途径。
 *
 * M5-T3 脚本处理执行引擎。数据流约定（ROADMAP §4，与 M4-T5 script-doc 文案一致）：
 *
 *   上游节点输出聚合为 input
 *     → runPreScript(input) → 请求上下文覆盖对象（url / headers / body / timeoutMs）
 *     → 发起重放 → 原始响应 response = { status, headers, body, durationMs }
 *     → runPostScript(response) → 本节点 output（任意 JSON 值，缺省为 response.body）
 *
 * 受限沙箱策略（本阶段边界，诚实声明）：
 *   - 脚本以 `"use strict"` 前缀 + 函数体执行（未声明变量赋值直接抛 ReferenceError）；
 *   - 不注入任何宿主能力对象：只注入数据形参（pre 为 input / post 为 response，
 *     参数名固定）与两个纯沙箱 helper（`__deadline` 数字常量、`__checkDeadline()`
 *     函数，均为函数形参而非 globalThis 上的全局，脚本无法覆盖声明——重复声明会在
 *     编译期报语法错误）。M14-T2 起追加第二数据形参 `env`（本次运行派发时定格的
 *     环境快照；M14-T3 起以可写代理呈现，写回经结果通道代理到 storage 层，
 *     见 createEnvScriptParam）；
 *   - 进入脚本的数据与脚本返回值一律先经 sanitizeJson 做结构克隆（剔除
 *     __proto__ / constructor / prototype 污染键，循环引用报 invalid-return），
 *     保证引擎内外交换的都是纯 JSON 数据；
 *   - 注意：脚本体仍运行在同一 JS realm，理论上可触达 globalThis 上的既有全局
 *     （fetch 等）——本阶段不做能力隔离，这不是安全边界，只防数据污染与误用。
 *
 * 错误分类（ScriptError.kind）：
 *   - 'syntax'         编译失败（new Function 阶段的 SyntaxError）；
 *   - 'blocked'        编译被运行环境拒绝（M9-T2）：MV3 扩展上下文的默认 CSP
 *                      （script-src 'self' …，无 unsafe-eval）会让 `new Function`
 *                      抛 EvalError——jsdom / node 单测环境不拦 eval，该错误只在
 *                      真机出现。它不是脚本的语法问题，单列一类避免误导排查
 *                      （M9-T1 结论：此前被误报为 'syntax'「语法错误」）。生产链路
 *                      中脚本经沙箱通道（offscreen + sandbox iframe，见
 *                      src/sandbox/）执行，沙箱页面的 CSP 允许 eval 系求值，
 *                      本分类仅在旁路 / 降级场景出现；
 *   - 'runtime'        执行期异常（含未定义变量 ReferenceError、null/undefined 属性
 *                      访问 TypeError 等；脚本自行 throw 的错误也归此类——只有
 *                      __checkDeadline() 抛出的内部哨兵按 'timeout' 归类）；
 *   - 'timeout'        软超时（跑完后耗时超限）或 __checkDeadline() 配合中断；
 *                      沙箱通道的硬超时（销毁 iframe）由通道层产出同 kind 错误；
 *   - 'invalid-return' 返回值不是可安全交换的 JSON（循环引用 / 函数 / 循环外的
 *                      非 JSON 对象类型等）。
 *
 * 本模块纯逻辑、零依赖（不依赖 React / 存储 / chrome API），node 环境可直接单测；
 * 通过 src/engine/index.ts 桶文件再导出，供 M5 执行器与 UI 引用。M9-T2 起
 * 本模块同时被沙箱执行页（src/sandbox/exec-main.ts）复用——沙箱里跑的就是
 * 这套 runPreScript / runPostScript，保证通道迁移前后行为逐字段一致。
 */

/**
 * 请求上下文覆盖对象：前置脚本返回值中允许生效的部分
 * （键集与 script-doc 的 returnFields 对齐；值的具体合法性由 M5 执行器校验）。
 */
export interface PreScriptOverrides {
  /** 覆盖本次请求的 URL */
  url?: string;
  /** 覆盖本次请求的请求头 */
  headers?: Record<string, string>;
  /** 覆盖本次请求的请求体（string 或对象，模板渲染前允许两种形态） */
  body?: unknown;
  /** 覆盖本次请求的超时毫秒数 */
  timeoutMs?: number;
}

/** 脚本模式：pre = 前置处理（请求前），post = 后置处理（响应后） */
export type ScriptMode = "pre" | "post";

/** 按 mode 固定的数据形参名：pre 收 input，post 收 response（与 script-doc 文案一致） */
export const SCRIPT_PARAM_NAME: Record<ScriptMode, string> = {
  pre: "input",
  post: "response",
};

/** 沙箱注入的截止时间常量名（形参，非全局；数值为 Date.now() 毫秒时间戳） */
export const SANDBOX_DEADLINE_PARAM = "__deadline";

/** 沙箱注入的主动检查函数名（形参，非全局；超截止时间即抛出内部哨兵中断脚本） */
export const SANDBOX_CHECK_PARAM = "__checkDeadline";

/**
 * 环境变量形参名（M14-T2）：pre / post 脚本与条件表达式的第二数据形参。
 * 形参与 __deadline / __checkDeadline 同机制在编译期声明，脚本无法覆盖声明
 * （严格模式下重复声明在编译期报 syntax）；值为本次运行派发时定格的环境快照
 * （与模板 `{{ env.<key> }}` 渲染同源，保持 M10-T4「运行中切换不影响进行中
 * run」语义）。M14-T3 起该形参以可写代理呈现——脚本内赋值经写回通道生效
 * （见 createEnvScriptParam 与 RunScriptOptions.env）。
 */
export const SCRIPT_ENV_PARAM_NAME = "env";

/** 一次脚本执行收集到的 env 写回表：键 → 净化后的写回值（键为首写序，同键取最后一次赋值） */
export type EnvWritesTable = Record<string, unknown>;

/** env 写回的消费者签名（M14-T3）：运行装配方经此把写回应用到运行快照与落库 */
export type EnvWriteHandler = (writes: EnvWritesTable) => void;

/** 默认脚本软超时上限（毫秒）：调用方未传 opts.timeoutMs（或传了非法值）时使用 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;

/** 前置脚本返回对象允许的覆盖键（与 script-doc 的 returnFields 对齐） */
export const PRE_OVERRIDE_KEYS = ["url", "headers", "body", "timeoutMs"] as const;

/** 按 mode 的可读标签（拼进错误 message，便于定位是哪类脚本出错） */
const MODE_LABEL: Record<ScriptMode, string> = {
  pre: "前置处理脚本",
  post: "后置处理脚本",
};

/**
 * 脚本处理错误。message 面向用户可读（含脚本类别与底层错误文本）；
 * cause 携带底层抛出值（runtime 类为原始 Error，其余类可缺省）。
 *
 * kind 取值见文件头「错误分类」；'blocked' 为 M9-T2 新增（CSP 拦截 eval 系
 * 求值），跨通道传输时仅 kind + message 可靠（cause 为 Error 对象，不经
 * postMessage / chrome 消息传递，沙箱通道回包一律剥除）。
 */
export interface ScriptError {
  kind: "syntax" | "blocked" | "runtime" | "timeout" | "invalid-return";
  message: string;
  cause?: unknown;
}

/** 沙箱运行时：执行一次脚本时注入的截止时间与主动检查函数 */
export interface ScriptSandbox {
  /** 截止时间戳（Date.now() 毫秒）；脚本可直接读取 `__deadline` 比较 */
  deadline: number;
  /** 超过截止时间则抛出内部哨兵，真正中断长循环；脚本通过 `__checkDeadline()` 调用 */
  checkDeadline: () => void;
}

/**
 * 编译产物函数：传入数据形参、沙箱运行时与 env 形参执行一次脚本。
 *
 * 内部形参顺序为（__deadline, __checkDeadline, 数据形参, env），本类型已把
 * 沙箱参数收拢为单一 sandbox 对象，调用方无须关心注入顺序；env 缺省时以
 * undefined 传入（引擎入口恒以空表兜底，见 createEnvScriptParam）。
 */
export type CompiledScriptFn = (
  param: unknown,
  sandbox: ScriptSandbox,
  env?: Record<string, unknown>,
) => unknown;

/** compileScript 结果：成功带可执行函数，失败带语法错误 */
export type CompileScriptResult =
  { ok: true; fn: CompiledScriptFn } | { ok: false; error: ScriptError };

/** 脚本执行选项 */
export interface RunScriptOptions {
  /**
   * 软超时上限（毫秒）。缺省 / 非有限数字 / 负数 → DEFAULT_SCRIPT_TIMEOUT_MS；
   * 0 表示不允许任何耗时（跑完后只要耗时 > 0 即判超时）。
   * 注意这是软超时：无法阻止脚本先跑完，详见文件头【限制声明】。
   */
  timeoutMs?: number;
  /**
   * 环境变量快照（M14-T2，可选）：本次运行派发时定格的激活环境键值表（与模板
   * `{{ env.<key> }}` 渲染同源）。注入脚本的 `env` 形参；缺省按空表注入（脚本
   * 仍可读取 env，缺键取值为 undefined）。M14-T3：注入的是**可写代理**——脚本
   * 内对 env 的赋值（含动态新键）被记录并随执行结果回传（ScriptRunResult 的
   * envWrites 字段），由运行装配方双写（运行快照立即更新 + 激活集合落库）。
   */
  env?: Record<string, unknown>;
}

/** 后置脚本入参：重放得到的原始响应（形状与 script-doc 的 paramFields 一致） */
export interface PostProcessResponse {
  /** HTTP 状态码，如 200 */
  status: number;
  /** 响应头 */
  headers: Record<string, string>;
  /**
   * 响应体（重放链路给出的是原文文本——超 1MB 时为截断结果；任意 JSON 值
   * 由调用方自定，故类型放宽为 unknown）。要取 JSON 字段可用下方 json，
   * 或既有写法 JSON.parse(response.body)（两者等价，脚本零迁移）。
   */
  body: unknown;
  /**
   * 响应体的解析值（M12-T3 自动类型判断：body 为合法 JSON 时存在，否则缺省；
   * 见 engine/replay-response.ts）。免 parse 直接取字段：response.json.data.token。
   */
  json?: unknown;
  /** 响应体类型判断结果（M12-T3，'json' / 'text' / 'empty'；历史快照形态可能缺失） */
  bodyType?: string;
  /** 请求耗时（毫秒） */
  durationMs: number;
}

/**
 * 脚本执行结果：成功带返回值与警告列表，失败带分类错误。
 *
 * M14-T3：两 variants 均可携带 envWrites（脚本对 env 形参的写回收集表）——
 * **失败结果同样携带**：脚本执行中断（runtime / timeout / invalid-return）前
 * 已发生的赋值属于已提交副作用（与文件头【限制声明】「副作用无法回滚」同一
 * 姿态），由调用方照常应用、不因脚本失败丢弃。无写回时字段缺省（不携带空表，
 * 便于调用方以 undefined 判定）。
 */
export type ScriptRunResult<T> =
  | { ok: true; value: T; warnings: string[]; envWrites?: EnvWritesTable }
  | { ok: false; error: ScriptError; envWrites?: EnvWritesTable };

/** sanitizeJson 结果：成功带净化后的 JSON 安全值，失败带原因文本 */
export type SanitizeResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * `__checkDeadline()` 超过截止时间时抛出的内部哨兵。
 *
 * 用对象身份（而非错误类型 / message）判定，脚本不可能伪造出同一引用；
 * 脚本若捕获后吞掉哨兵，则退化为软超时兜底（跑完后再判耗时）。
 */
const DEADLINE_EXCEEDED: unknown = Object.freeze({ __reqflowDeadlineExceeded: true });

/** 原型污染键：结构克隆时一律剔除，防止 __proto__ / constructor 注入 */
const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 脚本 env 形参（M14-T2 / M14-T3）：注入脚本的 env 对象 + 写回收集器。
 *
 * value 是以快照为初值的**可写代理**——脚本赋值（含动态新键）记录到写回表并
 * 同步落到代理内层状态（同脚本内后续读取立即可见，Postman pm.environment.set
 * 的直觉语义）。写回经 takeWrites() 随执行结果回传，由运行装配方双写（运行
 * 快照 + 激活集合落库）；代理本身不触任何存储（沙箱内无 chrome.storage 访问权，
 * 写回经结果通道代理到宿主 / SW 侧的 storage 层）。
 */
export interface EnvScriptParam {
  /** 注入脚本的 env 形参值（可写代理） */
  readonly value: Record<string, unknown>;
  /**
   * 取走已收集的写回（取走后清空）。无写回返回 undefined（结果对象不携带空表，
   * 便于调用方以 undefined 判定「本次无写回」）。
   */
  takeWrites(): EnvWritesTable | undefined;
}

/**
 * 创建脚本 env 形参（可写代理 + 写回收集）。
 *
 * 行为细则（注释即契约）：
 *   - 快照在创建时**浅拷贝**为代理内层状态：脚本对 env 的任何改动都不影响调用方
 *     传入的快照对象（快照定格语义，调用方表保持原样）；快照缺省 / 非对象按空表
 *     处理（脚本仍拿到可用对象，缺键读取为 undefined）；
 *   - 赋值先经 sanitizeJson 净化（剔除原型污染键、拒绝函数 / 循环引用等非 JSON
 *     值——非法赋值**抛错**中断脚本并以 runtime 分类暴露，而非静默丢弃，避免
 *     非净化值流入 postMessage / chrome 消息通道引发结构克隆失败）；
 *   - 污染键（__proto__ / constructor / prototype）赋值抛错；`delete env.x` 与
 *     原型改写一律拒绝（写回仅支持赋值，语义见 script-doc）；
 *   - 赋值 undefined 不记录写回（落库的环境表为字符串键值，undefined 无落库
 *     形态；同脚本内读取为 undefined），两条执行通道（本地 / 沙箱）行为一致；
 *   - 同键多次赋值取最后一次（写回表按键聚合，后写覆盖先写）；
 *   - symbol 键赋值不记录写回（环境表为 string 键值表）。
 *
 * @param snapshot 注入快照（运行派发时定格的环境键值表；可缺省）
 * @returns EnvScriptParam（value 供注入，takeWrites 供结果回传前收集）
 */
export function createEnvScriptParam(snapshot?: Record<string, unknown>): EnvScriptParam {
  // 快照浅拷贝为内层状态（快照定格；调用方表不受脚本写影响）；原型污染键剔除
  const state: Record<string, unknown> = { ...(snapshot ?? {}) };
  for (const key of POLLUTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, key)) delete state[key];
  }
  /** 已收集的写回（键首写序插入，值取最后一次赋值） */
  const writes = new Map<string, unknown>();

  const env = new Proxy(state, {
    set(target, prop, newValue): boolean {
      if (typeof prop !== "string") {
        // symbol 键：环境表为 string 键值表，不做写回记录（仅落内层状态）
        return Reflect.set(target, prop, newValue);
      }
      if (POLLUTING_KEYS.has(prop)) {
        throw new Error(`env 不允许赋值保留键「${prop}」（原型污染防护）`);
      }
      const cleaned = sanitizeJson(newValue);
      if (!cleaned.ok) {
        throw new Error(`env 赋值必须是可安全传递的 JSON 数据：${cleaned.reason}`);
      }
      if (cleaned.value === undefined) {
        // undefined 赋值：不产生写回（无落库形态），内层状态置 undefined 即「读不到」
        target[prop] = undefined;
        return true;
      }
      writes.set(prop, cleaned.value);
      target[prop] = cleaned.value;
      return true;
    },
    deleteProperty(): boolean {
      // 抛错而非返回 false：严格模式下返回 false 会被包装成含混的 TypeError，
      // 显式抛出可读性更好（脚本以 runtime 分类看到明确文案）
      throw new Error("env 不支持 delete 操作（写回仅支持赋值；如需清除请在管理页编辑环境集合）");
    },
    setPrototypeOf(): boolean {
      return false; // 严格模式下抛 TypeError：阻止脚本改写 env 原型
    },
  });

  return {
    value: env,
    takeWrites(): EnvWritesTable | undefined {
      if (writes.size === 0) return undefined;
      const table: EnvWritesTable = {};
      for (const [key, value] of writes) table[key] = value;
      writes.clear();
      return table;
    },
  };
}

/**
 * 把任意抛出值规整为可读错误文本（Error 取 name: message，其余 String() 兜底）。
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 判断编译期抛出值是否为「CSP 拦截 eval 系求值」的 EvalError（M9-T2）。
 *
 * MV3 扩展上下文默认 CSP（script-src 'self'，无 unsafe-eval）下 `new Function`
 * 抛 EvalError（M9-T1 真机结论）；真实语法错误是 SyntaxError，二者可靠区分。
 * 按 name 判定（而非 instanceof），避免跨 realm（沙箱 iframe）原型不一致漏判。
 */
function isCspEvalError(error: unknown): boolean {
  return error instanceof Error && error.name === "EvalError";
}

/**
 * 解析超时选项：缺省 / 非有限数字 / 负数回退默认值（0 合法，表示立即软超时）。
 *
 * M9-T2 起导出为 resolveScriptTimeoutMs：沙箱通道的发送方（offscreen port /
 * 编辑器 dry-run）需要与沙箱执行页**各自独立地**算出同一个有效超时值来挂
 * 硬超时看门狗，故解析规则必须单一出处。
 */
export function resolveScriptTimeoutMs(opts?: RunScriptOptions): number {
  const raw = opts?.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_SCRIPT_TIMEOUT_MS;
  }
  return raw;
}

/**
 * 编译脚本文本为可执行函数（不执行）。
 *
 * 实现即 ROADMAP DD-4 的最小可用方案：`new Function` 构造函数体为
 * `"use strict";\n` + source 的函数，形参依次为 `__deadline`、`__checkDeadline`、
 * 数据形参（按 mode 固定为 input / response）与 `env`（M14-T2 环境变量形参，
 * 第二数据形参）。构造阶段抛出的 SyntaxError 归一化为
 * ScriptError{kind:'syntax'}；被运行环境 CSP 拒绝的 EvalError 单独归为
 * ScriptError{kind:'blocked'}（M9-T2：真机 MV3 CSP 拦截 eval 系，不是脚本的
 * 语法问题，不得误报「语法错误」——M9-T1 结论）。脚本重复声明 `__deadline` /
 * `__checkDeadline` / 数据形参 / `env` 同样在编译期报 'syntax'（严格模式形参
 * 不可被 let/const 重声明）。
 *
 * @param source 用户脚本文本（函数体，用 return 返回结果）
 * @param mode 决定数据形参名与错误文案类别，缺省 'pre'
 * @returns { ok: true, fn } 或 { ok: false, error: ScriptError{kind:'syntax'|'blocked'} }
 */
export function compileScript(source: string, mode: ScriptMode = "pre"): CompileScriptResult {
  const label = MODE_LABEL[mode];
  let factory: (deadline: number, check: () => void, param: unknown, env: unknown) => unknown;
  try {
    factory = new Function(
      SANDBOX_DEADLINE_PARAM,
      SANDBOX_CHECK_PARAM,
      SCRIPT_PARAM_NAME[mode],
      SCRIPT_ENV_PARAM_NAME,
      `"use strict";\n${source}`,
    ) as (deadline: number, check: () => void, param: unknown, env: unknown) => unknown;
  } catch (error) {
    if (isCspEvalError(error)) {
      return {
        ok: false,
        error: {
          kind: "blocked",
          message:
            `${label}被内容安全策略（CSP）拦截，无法编译执行：${toErrorMessage(error)}。` +
            "当前上下文禁止 eval 系脚本求值；M9-T2 起脚本经沙箱通道（offscreen + sandbox iframe）执行，" +
            "若看到此错误说明该次执行未走沙箱通道，请检查扩展的沙箱配置。",
          cause: error,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "syntax",
        message: `${label}语法错误：${toErrorMessage(error)}`,
        cause: error,
      },
    };
  }
  return {
    ok: true,
    fn: (param, sandbox, env) => factory(sandbox.deadline, sandbox.checkDeadline, param, env),
  };
}

/**
 * 执行已编译脚本：注入沙箱运行时与 env 形参，软超时兜底，异常归类。
 *
 * 时序：
 *   1. 记 start，deadline = start + timeoutMs，构造 __checkDeadline 闭包并执行；
 *   2. 抛出 DEADLINE_EXCEEDED 哨兵 → 'timeout'（__checkDeadline 主动中断，
 *      循环被真正终止，副作用止于哨兵抛出前的部分）；
 *   3. 抛出其他任何值 → 'runtime'（原始 Error 挂在 cause 上）；
 *   4. 正常返回但实际耗时 > timeoutMs → 结果改判 'timeout'（软超时：脚本已完整
 *      跑完，期间副作用无法回滚——这正是文件头【限制声明】的体现）；
 *      脚本抛错且耗时超限时仍按 'runtime' 报告（真实报错信息更有诊断价值）。
 */
function executeCompiled(
  fn: CompiledScriptFn,
  param: unknown,
  timeoutMs: number,
  label: string,
  env?: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; error: ScriptError } {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const checkDeadline = (): void => {
    if (Date.now() > deadline) throw DEADLINE_EXCEEDED;
  };

  let value: unknown;
  try {
    value = fn(param, { deadline, checkDeadline }, env);
  } catch (error) {
    if (error === DEADLINE_EXCEEDED) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message:
            `${label}通过 ${SANDBOX_CHECK_PARAM}() 主动中断：已超过截止时间（上限 ${timeoutMs}ms）。` +
            "脚本在哨兵抛出前产生的副作用无法回滚。",
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `${label}运行时错误：${toErrorMessage(error)}`,
        cause: error,
      },
    };
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed > timeoutMs) {
    return {
      ok: false,
      error: {
        kind: "timeout",
        message:
          `${label}执行软超时：实际耗时 ${elapsed}ms 超过上限 ${timeoutMs}ms。` +
          "同步脚本无法被强制中断，脚本已完整跑完、期间的副作用无法回滚；" +
          `建议在长循环内调用 ${SANDBOX_CHECK_PARAM}() 主动中断。`,
      },
    };
  }
  return { ok: true, value };
}

/**
 * 结构克隆等价的 JSON 净化（原型链防护核心）。
 *
 * 规则（对齐 JSON 语义，确定性优先）：
 *   - string / number / boolean / null 原样保留（NaN / Infinity 也按 number 保留，
 *     采用结构克隆语义而非严格 JSON 文本语义，避免静默改写数值）；
 *   - 普通对象 / 数组递归克隆；对象属性值为 undefined → 丢弃该键，数组槽位为
 *     undefined → 置 null（均与 JSON.stringify 语义一致）；
 *   - 键名为 __proto__ / constructor / prototype 的一律剔除（即便脚本用
 *     JSON.parse / 计算键造出了 own property，也不允许原样出站）；
 *   - 循环引用 → { ok:false, reason:'循环引用' }；共享引用（DAG）不受影响；
 *   - function / symbol / bigint → 失败（非 JSON 值）；原型不是 Object.prototype
 *     / null 的对象（Date / Map / class 实例等）→ 失败，提示脚本作者先转 JSON。
 *
 * 引擎约定：进入脚本的数据（input / response）与脚本返回值都先经本函数，
 * 出入两端拿到的都是"干净"的纯 JSON 数据（幂等：sanitize(sanitize(x)) 深等于
 * sanitize(x)）。
 *
 * @param value 任意值
 * @returns { ok, value } 或 { ok:false, reason }
 */
export function sanitizeJson(value: unknown): SanitizeResult {
  try {
    return sanitizeWalk(value, new WeakSet<object>());
  } catch (error) {
    // 防御：getter 抛错等读取期异常统一归为净化失败，不向外泄漏异常
    return { ok: false, reason: `读取数据失败：${toErrorMessage(error)}` };
  }
}

/** sanitizeJson 的递归实现：seen 记录递归栈上的容器，回溯时移除（共享引用合法） */
function sanitizeWalk(value: unknown, seen: WeakSet<object>): SanitizeResult {
  if (value === null) return { ok: true, value: null };
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return { ok: true, value };
  }
  if (kind === "undefined") {
    // 容器层决定丢弃（对象）/ 置 null（数组）；顶层 undefined 由调用方按语义处理
    return { ok: true, value: undefined };
  }
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    return { ok: false, reason: `非 JSON 类型：${kind}` };
  }

  const source = value as object;
  if (seen.has(source)) {
    return { ok: false, reason: "循环引用" };
  }

  if (Array.isArray(source)) {
    seen.add(source);
    const out: unknown[] = [];
    for (const item of source) {
      const walked = sanitizeWalk(item, seen);
      if (!walked.ok) return walked;
      out.push(walked.value === undefined ? null : walked.value);
    }
    seen.delete(source);
    return { ok: true, value: out };
  }

  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) {
    let name = "object";
    try {
      name = String((source as { constructor?: { name?: unknown } }).constructor?.name ?? "object");
    } catch {
      // constructor 取不到时用兜底名即可，不影响分类
    }
    return { ok: false, reason: `非 JSON 对象类型：${name}（请先转换为普通对象 / 数组）` };
  }

  seen.add(source);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source as Record<string, unknown>)) {
    if (POLLUTING_KEYS.has(key)) continue; // 原型污染键一律剔除
    const walked = sanitizeWalk(item, seen);
    if (!walked.ok) return walked;
    if (walked.value === undefined) continue; // 对齐 JSON.stringify：undefined 属性丢弃
    out[key] = walked.value;
  }
  seen.delete(source);
  return { ok: true, value: out };
}

/**
 * 把净化后的前置脚本返回值校验为请求上下文覆盖对象。
 *
 * 形状策略（文档化选择，与 script-doc「返回非对象视为不修改请求」文案对齐）：
 *   - undefined / null → 合法的「不修改请求」：空覆盖、无警告（无 return 的脚本
 *     属常见用法，不制造噪音）；
 *   - 其他非对象（数字 / 字符串 / 布尔 / 数组 / 净化后的非对象值）→ 丢弃并记
 *     **warning**（不中断：前置脚本只负责覆盖请求，形状不符按「不修改」降级）；
 *   - 对象含未知键 → 只保留 PRE_OVERRIDE_KEYS 内的键，每个未知键记一条 warning
 *     （部分有效的覆盖仍值得保留，不整体丢弃）；
 *   - 已保留键的值不再做类型校验（如 url 是否为 string），交由 M5 执行器在
 *     应用覆盖时校验——本层只负责形状归类与数据净化。
 */
function toPreOverrides(value: unknown): { overrides: PreScriptOverrides; warnings: string[] } {
  const warnings: string[] = [];
  if (value === undefined || value === null) {
    return { overrides: {}, warnings };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`前置脚本返回值不是对象（${typeof value}），已按「不修改请求」丢弃`);
    return { overrides: {}, warnings };
  }

  const overrides: PreScriptOverrides = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!(PRE_OVERRIDE_KEYS as readonly string[]).includes(key)) {
      warnings.push(`忽略前置脚本返回的未知覆盖键：${key}`);
      continue;
    }
    (overrides as Record<string, unknown>)[key] = item;
  }
  return { overrides, warnings };
}

/**
 * 执行前置处理脚本：input → 请求上下文覆盖对象。
 *
 * 管线：compile → sanitize(input) → 执行（软超时 / 错误归类）→ sanitize(返回值)
 * → 形状校验（策略见 toPreOverrides）。
 *
 * M14-T2 / T3：opts.env（派发时定格的环境快照）注入 env 形参（缺省空表）；脚本
 * 对 env 的赋值经可写代理收集为 envWrites 随结果回传（成功与失败结果均携带——
 * 已提交的写回不因脚本失败丢弃），由运行装配方双写应用。
 *
 * @param source 前置脚本文本（函数体，数据形参名固定为 input，环境形参名为 env）
 * @param input 上游节点输出聚合成的入参（引擎会先净化，循环引用等坏数据在
 *   进入脚本前即报 'runtime'，正常链路中上游 output 均为已净化 JSON，不会触发）
 * @param opts 超时与环境快照等选项
 * @returns 成功：value 为覆盖对象（只含 PRE_OVERRIDE_KEYS 中出现的键）、warnings
 *   为形状降级说明、envWrites 为 env 写回（无写回时缺省）；失败：syntax /
 *   runtime / timeout / invalid-return 分类错误（envWrites 语义同上）
 */
export function runPreScript(
  source: string,
  input: unknown,
  opts?: RunScriptOptions,
): ScriptRunResult<PreScriptOverrides> {
  const timeoutMs = resolveScriptTimeoutMs(opts);
  const compiled = compileScript(source, "pre");
  if (!compiled.ok) return compiled;

  const envParam = createEnvScriptParam(opts?.env);

  const safeInput = sanitizeJson(input);
  if (!safeInput.ok) {
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `前置脚本入参（input）不是可安全传递的 JSON 数据：${safeInput.reason}`,
      },
    };
  }

  const executed = executeCompiled(
    compiled.fn,
    safeInput.value,
    timeoutMs,
    MODE_LABEL.pre,
    envParam.value,
  );
  // 写回在脚本实际执行后即收集（失败结果同样携带——已提交副作用不回滚）
  const envWrites = envParam.takeWrites();
  if (!executed.ok) {
    return {
      ok: false,
      error: executed.error,
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  const safeReturn = sanitizeJson(executed.value);
  if (!safeReturn.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid-return",
        message: `前置脚本返回值不是合法 JSON：${safeReturn.reason}`,
      },
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  const { overrides, warnings } = toPreOverrides(safeReturn.value);
  return {
    ok: true,
    value: overrides,
    warnings,
    ...(envWrites !== undefined ? { envWrites } : {}),
  };
}

/**
 * 执行后置处理脚本：response → 本节点 output（任意 JSON 值）。
 *
 * 管线：compile → sanitize(response) → 执行（软超时 / 错误归类）→ 返回值处理：
 *   - 脚本未返回（undefined）→ output 默认取 response.body（script-doc 约定；
 *     显式 `return null` 输出 null，不触发默认值）；
 *   - 其余返回值净化后原样作为 output；净化失败（循环引用 / 函数等）报
 *     'invalid-return'。
 *
 * M14-T2 / T3：opts.env 注入 env 形参（缺省空表）；env 写回收集与回传语义与
 * runPreScript 一致（成功与失败结果均携带）。
 *
 * @param source 后置脚本文本（函数体，数据形参名固定为 response，环境形参名为 env）
 * @param response 原始响应 { status, headers, body, durationMs }（引擎会先净化）
 * @param opts 超时与环境快照等选项
 * @returns 成功：value 为节点 output（JSON 安全值，warnings 恒为空数组）、
 *   envWrites 为 env 写回（无写回时缺省）；失败：分类错误（envWrites 语义同上）
 */
export function runPostScript(
  source: string,
  response: PostProcessResponse,
  opts?: RunScriptOptions,
): ScriptRunResult<unknown> {
  const timeoutMs = resolveScriptTimeoutMs(opts);
  const compiled = compileScript(source, "post");
  if (!compiled.ok) return compiled;

  const envParam = createEnvScriptParam(opts?.env);

  const safeResponse = sanitizeJson(response);
  if (!safeResponse.ok) {
    return {
      ok: false,
      error: {
        kind: "runtime",
        message: `后置脚本入参（response）不是可安全传递的 JSON 数据：${safeResponse.reason}`,
      },
    };
  }

  const executed = executeCompiled(
    compiled.fn,
    safeResponse.value,
    timeoutMs,
    MODE_LABEL.post,
    envParam.value,
  );
  // 写回在脚本实际执行后即收集（失败结果同样携带——已提交副作用不回滚）
  const envWrites = envParam.takeWrites();
  if (!executed.ok) {
    return {
      ok: false,
      error: executed.error,
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  if (executed.value === undefined) {
    // 未返回 → 默认 output = response.body（此时已是净化后的纯 JSON）
    const body = (safeResponse.value as PostProcessResponse | undefined)?.body;
    return {
      ok: true,
      value: body === undefined ? null : body,
      warnings: [],
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }

  const safeReturn = sanitizeJson(executed.value);
  if (!safeReturn.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid-return",
        message: `后置脚本返回值不是合法 JSON：${safeReturn.reason}`,
      },
      ...(envWrites !== undefined ? { envWrites } : {}),
    };
  }
  return {
    ok: true,
    value: safeReturn.value,
    warnings: [],
    ...(envWrites !== undefined ? { envWrites } : {}),
  };
}
