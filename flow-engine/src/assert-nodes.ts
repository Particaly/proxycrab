/**
 * 断言节点执行语义（M10-T3）：状态码 / JSONPath / JSON Schema 三类断言规则的
 * 求值与 runner 装配。本模块为纯逻辑、零环境依赖（不依赖 React / 存储 / 网络 /
 * chrome.*），node 环境可直接单测；与 logic-nodes.ts 同策略，不通过
 * src/engine/index.ts 桶文件再导出，调用方按路径 `@/engine/assert-nodes` 引入。
 *
 * ─── 配置（types/model.ts 的 AssertionRule 判别联合）───────────────────
 *
 * config.assertions 为规则数组，按顺序求值、全部通过才算节点成功：
 *   - { kind: 'status', op: 'eq' | '2xx'..'5xx', value? }  对入参对象上的数字
 *     status 字段做精确 / 百位段比较（httpReplay 的响应输出形状
 *     { status, headers, body, durationMs } 天然满足）；
 *   - { kind: 'jsonPath', path, op: 'eq'|'ne'|'contains'|'regex'|'exists', value? }
 *     对入参根按 JSONPath 子集取值（engine/json-path），集合语义与消费约定：
 *     exists = 至少一个匹配；其余 = **每个匹配值都满足**，零匹配视为失败
 *     （「路径不存在」应显式暴露，不静默放行）；
 *   - { kind: 'schema', path?, schema }  先按 path（可选 JSONPath）定位目标
 *     （缺省取入参根），再以常用子集校验（engine/json-schema-lite）。
 *
 * ─── 执行语义 ──────────────────────────────────────────────────────────
 *
 *   - 全部规则通过（含未配置任何规则）→ 节点 success，output 透传 input
 *     （断言是纯校验屏障，不改变数据流；响应继续传给下游）；
 *   - 任一规则失败 / 配置非法（坏正则 / 坏路径 / schema 形状非法）→ 抛错
 *     （节点 failed），错误信息**逐条列出**：第几条规则、规则描述、期望 vs 实际，
 *     多条失败一次说全（回归时一眼看清所有差异）；之后走既有 failPolicy
 *     （stop 停图 / continue 放行下游——执行器通用语义，本层不重复实现）。
 *
 * ─── 边界披露 ──────────────────────────────────────────────────────────
 *
 *   - regex 用 new RegExp(pattern) 在扩展运行环境内执行；与前置 / 后置脚本
 *     （可执行任意用户代码）同一威胁模型（用户配置自己的流程），不做 ReDoS
 *     防护——恶意catastrophic backtracking 可能阻塞运行，与脚本能力一致地信任配置者。
 *   - eq / ne 的相等语义统一走 jsonDeepEqual（json-equal 导出）：类型敏感
 *     （1 与 '1' 不等）、对象按键、数组按位。
 *   - contains 语义：actual 为字符串 → 期望值转字符串后做子串包含；actual 为
 *     数组 → 期望值与元素 deep equal 命中其一；其余类型 → 规则失败并说明。
 */

import type {
  AssertionRule,
  JsonPathAssertionRule,
  NodeConfig,
  SchemaAssertionRule,
  StatusAssertionRule,
} from "./types";
import type { NodeRunner } from "./executor";
import { jsonDeepEqual } from "./json-equal";
import { evaluateJsonPath } from "./json-path";
import { validateJsonSchemaLite } from "./json-schema-lite";

/* ------------------------------------------------------------------ *
 * 单条规则求值
 * ------------------------------------------------------------------ */

/** 单条断言规则的求值结果：通过，或失败（label 为规则描述，message 含期望 vs 实际） */
export type AssertionOutcome =
  { ok: true; label: string } | { ok: false; label: string; message: string };

/**
 * 从断言输入中提取 HTTP 状态码（纯函数）：
 * 入参为普通对象且 status 字段为有限数字时返回该数字，否则 undefined
 * （httpReplay 响应输出 { status, ... } 天然满足；其它形状的入参在状态码
 * 断言处显式失败并说明，不猜值）。
 */
export function extractStatusValue(input: unknown): number | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const status = (input as Record<string, unknown>)["status"];
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/** 段操作符 → 状态码段下限 / 上限（含端点） */
const STATUS_RANGES: Record<
  Exclude<StatusAssertionRule["op"], "eq">,
  { min: number; max: number; label: string }
> = {
  "2xx": { min: 200, max: 299, label: "2xx（200~299）" },
  "3xx": { min: 300, max: 399, label: "3xx（300~399）" },
  "4xx": { min: 400, max: 499, label: "4xx（400~499）" },
  "5xx": { min: 500, max: 599, label: "5xx（500~599）" },
};

/** 值的简短展示（错误信息回显用；JSON 序列化 + 超长截断） */
function describeValue(value: unknown, max = 120): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 规则描述（错误信息标注「哪条规则」用；与配置抽屉的行摘要同构） */
export function describeAssertionRule(rule: AssertionRule): string {
  if (rule.kind === "status") {
    return rule.op === "eq" ? `状态码 = ${rule.value}` : `状态码 ${rule.op}`;
  }
  if (rule.kind === "jsonPath") {
    const opLabel: Record<JsonPathAssertionRule["op"], string> = {
      eq: "等于",
      ne: "不等于",
      contains: "包含",
      regex: "匹配正则",
      exists: "存在",
    };
    return opLabel[rule.op] === "存在"
      ? `${rule.path} 存在`
      : `${rule.path} ${opLabel[rule.op]} ${describeValue(rule.value)}`;
  }
  return `Schema 校验 ${rule.path && rule.path.trim() !== "" ? rule.path : "$"}`;
}

/** 求值状态码断言（纯函数） */
function evaluateStatusRule(rule: StatusAssertionRule, input: unknown): AssertionOutcome {
  const label = describeAssertionRule(rule);
  const actual = extractStatusValue(input);
  if (actual === undefined) {
    return {
      ok: false,
      label,
      message: "入参不含数字 status 字段（状态码断言的目标应是请求重放节点的响应输出）",
    };
  }
  if (rule.op === "eq") {
    const expected = rule.value;
    if (typeof expected !== "number" || !Number.isFinite(expected)) {
      return { ok: false, label, message: "规则配置非法：「等于」比较需提供整数状态码（如 200）" };
    }
    return actual === expected
      ? { ok: true, label }
      : { ok: false, label, message: `期望 ${expected}，实际 ${actual}` };
  }
  const range = STATUS_RANGES[rule.op];
  return actual >= range.min && actual <= range.max
    ? { ok: true, label }
    : { ok: false, label, message: `期望落在 ${range.label}，实际 ${actual}` };
}

/** 求值 JSONPath 断言（纯函数；集合语义见文件头） */
function evaluateJsonPathRule(rule: JsonPathAssertionRule, input: unknown): AssertionOutcome {
  const label = describeAssertionRule(rule);
  const parsed = evaluateJsonPath(rule.path, input);
  if (!parsed.ok) {
    return { ok: false, label, message: `路径语法非法：${parsed.error}` };
  }
  const { values } = parsed;

  if (rule.op === "exists") {
    return values.length > 0
      ? { ok: true, label }
      : { ok: false, label, message: `期望路径存在至少一个匹配值，实际无匹配（共 0 个）` };
  }

  if (values.length === 0) {
    return {
      ok: false,
      label,
      message: "路径无匹配值（不存在或路径写错；「存在」类检查请改用 exists）",
    };
  }

  for (const actual of values) {
    const failure = compareJsonPathValue(rule, actual);
    if (failure !== null) return { ok: false, label, message: failure };
  }
  return { ok: true, label };
}

/**
 * 单个匹配值与期望值的比较（JSONPath 规则的内层步骤）：
 * 通过返回 null；失败返回含期望 vs 实际的说明。
 */
function compareJsonPathValue(rule: JsonPathAssertionRule, actual: unknown): string | null {
  const expected = rule.value;
  const actualText = describeValue(actual);
  switch (rule.op) {
    case "eq":
      return jsonDeepEqual(expected, actual)
        ? null
        : `期望 ${describeValue(expected)}，实际 ${actualText}`;
    case "ne":
      return jsonDeepEqual(expected, actual)
        ? `期望不等于 ${describeValue(expected)}，实际恰好相等`
        : null;
    case "contains": {
      if (typeof actual === "string") {
        const needle = typeof expected === "string" ? expected : describeValue(expected);
        return actual.includes(needle)
          ? null
          : `期望包含 ${describeValue(needle)}，实际 ${actualText}`;
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => jsonDeepEqual(item, expected))
          ? null
          : `期望数组包含元素 ${describeValue(expected)}，实际 ${actualText}`;
      }
      return `「包含」只支持字符串或数组目标，实际为 ${actualText}`;
    }
    case "regex": {
      if (typeof expected !== "string" || expected.trim() === "") {
        return "规则配置非法：正则比较需提供非空的正则源文本（字符串）";
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(expected);
      } catch (error) {
        return `正则表达式非法：${error instanceof Error ? error.message : String(error)}`;
      }
      if (typeof actual !== "string") {
        return `「正则」只支持字符串目标，实际为 ${actualText}`;
      }
      return pattern.test(actual) ? null : `期望匹配 /${expected}/，实际 ${actualText}`;
    }
    case "exists":
      // 外层已处理（exists 不进入逐值比较），防御性返回通过
      return null;
  }
}

/** 求值 Schema 断言（纯函数） */
function evaluateSchemaRule(rule: SchemaAssertionRule, input: unknown): AssertionOutcome {
  const label = describeAssertionRule(rule);

  // schema 形状粗检（非对象直接失败；细节校验交 validateJsonSchemaLite 的逐关键字检查）
  if (rule.schema === null || typeof rule.schema !== "object" || Array.isArray(rule.schema)) {
    return { ok: false, label, message: '规则配置非法：schema 需为对象（如 {"type":"object"}）' };
  }

  let target = input;
  const path = typeof rule.path === "string" ? rule.path.trim() : "";
  if (path !== "") {
    const located = evaluateJsonPath(path, input);
    if (!located.ok) {
      return { ok: false, label, message: `目标路径语法非法：${located.error}` };
    }
    if (located.values.length === 0) {
      return { ok: false, label, message: `目标路径无匹配值：${path}（不存在或路径写错）` };
    }
    target = located.values[0];
  }

  const result = validateJsonSchemaLite(rule.schema, target);
  if (result.ok) return { ok: true, label };
  return {
    ok: false,
    label,
    message: `Schema 校验未通过（${result.errors.length} 处）：${result.errors.join("；")}`,
  };
}

/* ------------------------------------------------------------------ *
 * 规则列表求值与 runner
 * ------------------------------------------------------------------ */

/**
 * 求值断言规则列表（纯函数）：按数组顺序逐条求值，**一次收集全部失败**
 * （回归场景一次看清所有差异），全部通过返回空数组。
 *
 * @param rules 断言规则数组（容忍脏形状：非对象条目按「规则配置非法」失败处理）
 * @param input 断言目标（通常是上游 httpReplay 节点的响应输出）
 * @returns 失败条目列表（index 为 1 起的规则序号）
 */
export function evaluateAssertions(
  rules: readonly unknown[],
  input: unknown,
): Array<{
  index: number;
  label: string;
  message: string;
}> {
  const failures: Array<{ index: number; label: string; message: string }> = [];
  rules.forEach((rule, position) => {
    const index = position + 1;
    const outcome = evaluateSingleAssertion(rule, input);
    if (!outcome.ok) {
      failures.push({ index, label: outcome.label, message: outcome.message });
    }
  });
  return failures;
}

/** 求值单条断言规则（含脏形状防御；evaluateAssertions 的内联步骤） */
function evaluateSingleAssertion(rule: unknown, input: unknown): AssertionOutcome {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
    return {
      ok: false,
      label: "<未知规则>",
      message: "规则配置非法：需为对象（kind: status / jsonPath / schema）",
    };
  }
  const candidate = rule as Partial<AssertionRule>;
  switch (candidate.kind) {
    case "status":
      return evaluateStatusRule(candidate as StatusAssertionRule, input);
    case "jsonPath":
      return evaluateJsonPathRule(candidate as JsonPathAssertionRule, input);
    case "schema":
      return evaluateSchemaRule(candidate as SchemaAssertionRule, input);
    default:
      return {
        ok: false,
        label: "<未知规则>",
        message: `规则配置非法：kind 需为 status / jsonPath / schema 之一（得到 ${describeValue(candidate.kind)}）`,
      };
  }
}

/**
 * 把失败条目格式化为节点错误信息（多条失败一次说全）：
 * 每条一行「第 N 条规则（<规则描述>）：<期望 vs 实际>」。
 */
export function formatAssertionFailures(
  failures: ReadonlyArray<{ index: number; label: string; message: string }>,
): string {
  const lines = failures.map(
    (failure) => `第 ${failure.index} 条规则（${failure.label}）：${failure.message}`,
  );
  const head = failures.length === 1 ? "断言失败" : `断言失败（共 ${failures.length} 条不通过）`;
  return `${head}\n${lines.join("\n")}`;
}

/**
 * 解析断言规则列表（config 容错读取）：非数组 / 缺省 → 空规则（节点透传）。
 */
export function resolveAssertionRules(config: NodeConfig): readonly unknown[] {
  return Array.isArray(config.assertions) ? config.assertions : [];
}

/**
 * 创建断言节点 runner（M10-T3）：
 *   - 全部规则通过 / 未配置任何规则 → output 透传 input（响应继续传给下游）；
 *   - 任一失败 → 抛错（节点 failed，错误信息含具体哪条规则、期望 vs 实际），
 *     后续按节点既有 failPolicy 由执行器处理（本层只负责抛错）。
 */
export function createAssertRunner(): NodeRunner {
  return async (node, input) => {
    const rules = resolveAssertionRules(node.config);
    if (rules.length === 0) return input;
    const failures = evaluateAssertions(rules, input);
    if (failures.length > 0) throw new Error(formatAssertionFailures(failures));
    return input;
  };
}
