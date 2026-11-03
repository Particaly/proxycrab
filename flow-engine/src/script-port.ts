/**
 * 脚本执行端口（M9-T2）。
 *
 * 职责：把「前置 / 后置脚本与条件表达式怎么执行」抽象为可注入端口——
 * M5-T3 / M7-T1 的引擎函数（runPreScript / runPostScript / runConditionExpression）
 * 是在调用方线程上**同步** eval 的本地实现；M9-T2 起生产链路改走沙箱通道
 * （offscreen document + sandbox iframe，见 src/background/script-sandbox-port.ts
 * 与 src/sandbox/），但执行管线（sanitize / 编译 / 软超时 / 错误分类）完全复用
 * 本目录的引擎函数，保证通道迁移前后行为逐字段一致。
 *
 * 设计约定：
 *   - 端口方法全部异步（沙箱通道本质是跨 postMessage 往返；本地实现以
 *     Promise 包一层同步结果，行为等价、仅多一个微任务时点）；
 *   - 结果一律以**结果对象**返回（ScriptRunResult / ConditionEvalResult），不抛错——
 *     通道级失败（沙箱不可用、响应无法识别）由实现方归一为
 *     ScriptError{kind:'blocked'}，调用方无须处理结果对象之外的失败形态；
 *   - jsdom / node 单测环境不拦 eval：缺省端口即本地实现（createLocalScriptPort），
 *     既有测试零改动即保持全绿；沙箱端口由 background 入口显式注入。
 *
 * 依赖方向：script-port → logic-nodes → script（单向，无环）；logic-nodes 的
 * createConditionRunner 缺省端口在本模块产出（其本地条件执行等价于
 * runConditionExpression 的 Promise 包装，见 createConditionOnlyLocalPort）。
 *
 * 本模块纯逻辑、零环境依赖（不依赖 chrome API），可单测。
 */

import type { ConditionEvalContext, ConditionEvalResult } from "./logic-nodes";
import { runConditionExpression } from "./logic-nodes";
import type {
  PostProcessResponse,
  PreScriptOverrides,
  RunScriptOptions,
  ScriptRunResult,
} from "./script";
import { runPostScript, runPreScript } from "./script";

/**
 * 脚本执行端口：前置 / 后置脚本与条件表达式的统一执行入口。
 *
 * 三个方法的结果形状与对应引擎函数完全一致（ScriptRunResult<PreScriptOverrides> /
 * ScriptRunResult<unknown> / ConditionEvalResult），调用方按引擎既有语义消费：
 * runPre 的 value 为覆盖对象 + warnings；runPost 的 value 为节点 output；
 * runCondition 的 value 为表达式返回值（truthy 判定归调用方）。
 *
 * M14-T2 / T3：env 经 RunScriptOptions.env（runPre / runPost）与
 * ConditionEvalContext.env（runCondition）随调用下发（运行派发时定格的环境
 * 快照，注入脚本的 env 形参）；脚本对 env 的写回收集在结果的 envWrites 字段
 * （成功与失败结果均携带），由调用方（run-controller 的写回通道）应用。
 */
export interface ScriptExecPort {
  /** 执行前置处理脚本：input → 请求上下文覆盖对象 */
  runPre(
    source: string,
    input: unknown,
    opts?: RunScriptOptions,
  ): Promise<ScriptRunResult<PreScriptOverrides>>;
  /** 执行后置处理脚本：response → 节点 output（未返回时引擎默认取 response.body） */
  runPost(
    source: string,
    response: PostProcessResponse,
    opts?: RunScriptOptions,
  ): Promise<ScriptRunResult<unknown>>;
  /** 执行条件表达式：{ input, vars, env? } → 表达式返回值（已净化；env 写回随 envWrites 回传） */
  runCondition(
    source: string,
    context: ConditionEvalContext,
    timeoutMs?: number,
  ): Promise<ConditionEvalResult>;
}

/**
 * 创建本地（同线程同步 eval）脚本端口：直接调用引擎函数并以 Promise 包装。
 *
 * 行为与 M5-T3 / M7-T1 既有实现完全一致（同一批引擎函数），仅多一个微任务
 * 时点；作为缺省端口保持既有测试与「沙箱不可用时」的降级路径可用。
 *
 * @returns ScriptExecPort 本地实现
 */
export function createLocalScriptPort(): ScriptExecPort {
  return {
    runPre: async (source, input, opts) => runPreScript(source, input, opts),
    runPost: async (source, response, opts) => runPostScript(source, response, opts),
    runCondition: async (source, context, timeoutMs) =>
      runConditionExpression(source, context, timeoutMs),
  };
}
