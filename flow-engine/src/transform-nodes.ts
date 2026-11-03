/**
 * 数据处理节点执行语义（M10-T6）：对 input 按提取规则列表（JSONPath / JMESPath）
 * 提取，让多数「取字段 / 变形」场景不必写脚本。本模块为纯逻辑、零环境依赖
 * （唯一的第三方依赖 jmespath 为纯函数查询库，node / SW 均可运行）；与
 * logic-nodes / assert-nodes 同策略，不通过 src/engine/index.ts 桶文件再导出。
 *
 * ─── 配置（types/model.ts 的 TransformExtractionRule 列表）──────────────
 *
 * config.extractions 按数组顺序求值：
 *   - { name, engine: 'jsonPath', path }  JSONPath 子集取值（engine/json-path，
 *     M10-T3 同一实现——`$.body.token` 点记法 / `[*]` 通配等，见其文件头）；
 *   - { name, engine: 'jmespath', path }  JMESPath 全量查询（jmespath npm 库，
 *     投影 / 管道 / 函数表达式均可）。
 *
 * ─── 执行语义 ──────────────────────────────────────────────────────────
 *
 *   - 无规则（缺省 / 空数组）→ output 透传 input（先拖节点后配置的编排不因
 *     未配置而失败）；
 *   - 单条规则 → output 直接为该规则的提取值；
 *   - 多条规则 → output 为 { 规则名: 提取值 } 对象（键 = 规则名，按数组序）；
 *   - JSONPath 零匹配：与断言节点的「零匹配视为失败」不同，提取场景的零匹配
 *     是常见合法形态（可选字段）→ 提取值为 null（引擎 collectUpstreamOutputs
 *     语义：null 也是有效输出，下游照常聚合）；jmESPath 同理（结果 undefined
 *     归一为 null）；
 *   - 任一规则语法非法 / JMESPath 运行时错误 → 抛错（节点 failed），错误信息
 *     含规则名与表达式原文，走既有 failPolicy。
 *
 * ─── 与 setVariable 节点的分工 ─────────────────────────────────────────
 *
 * setVariable（M7-T1）把提取值写入运行期变量（旁路，input 透传）；transform
 * 则把提取结果作为 output 交给下游（数据流节点）。取字段后继续流转用
 * transform，落变量供后续任意节点引用用 setVariable，二者可叠加使用。
 */

import { search as jmespathSearch } from "jmespath";
import type { NodeConfig, TransformExtractionRule } from "./types";
import { evaluateJsonPath } from "./json-path";
import type { NodeRunner } from "./executor";

/** 把任意抛出值转成错误信息字符串 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * JSONPath 提取：零匹配 / 提取失败（类型不符等）归一为 null（可选字段的
 * 常见合法形态，见文件头「JSONPath 零匹配」说明）；路径语法非法上抛
 * （evaluateJsonPath 的 error 信息已含定位细节）。
 */
function extractByJsonPath(input: unknown, path: string): unknown {
  const evaluated = evaluateJsonPath(path, input);
  if (evaluated.ok) {
    if (evaluated.values.length === 0) return null;
    return evaluated.values.length === 1 ? evaluated.values[0] : evaluated.values;
  }
  throw new Error(`JSONPath 语法非法：${path}（${evaluated.error}）`);
}

/**
 * JMESPath 提取：jmespath.search 对语法错误抛 Error、对无匹配返回 null
 * （其内部约定），undefined（可能出自类型不匹配路径）归一为 null。
 */
function extractByJmesPath(input: unknown, path: string): unknown {
  let result: unknown;
  try {
    result = jmespathSearch(input, path);
  } catch (error) {
    throw new Error(`JMESPath 表达式非法：${path}（${toErrorMessage(error)}）`);
  }
  return result === undefined ? null : result;
}

/** 按规则提取单值（engine 分派；未知 engine 视为配置错误抛错） */
function extractByRule(rule: TransformExtractionRule, input: unknown): unknown {
  if (rule.engine === "jsonPath") {
    try {
      return extractByJsonPath(input, rule.path);
    } catch (error) {
      throw new Error(`提取规则 ${rule.name}：${toErrorMessage(error)}`);
    }
  }
  if (rule.engine === "jmespath") {
    try {
      return extractByJmesPath(input, rule.path);
    } catch (error) {
      throw new Error(`提取规则 ${rule.name}：${toErrorMessage(error)}`);
    }
  }
  throw new Error(`提取规则 ${rule.name} 的 engine 非法：${String(rule.engine)}`);
}

/**
 * 求值一组提取规则（纯函数，编辑器 dry-run 与执行链路共用）：
 * 无规则 → 透传 input；单条规则 → 提取值；多条规则 → { 规则名: 值 } 对象。
 * 任一规则抛错原样上抛（错误文案已含规则名 / 表达式）。
 *
 * @param rules 提取规则列表（脏数据容错：非对象 / 缺 name 的规则抛可读错误）
 * @param input 上游聚合的入参
 * @returns 本节点 output
 */
export function evaluateExtractions(rules: NodeConfig["extractions"], input: unknown): unknown {
  if (!Array.isArray(rules) || rules.length === 0) return input;
  const cleaned: TransformExtractionRule[] = rules.map((rule, index) => {
    if (rule === null || typeof rule !== "object") {
      throw new Error(`第 ${index + 1} 条提取规则形状非法：需为 { name, engine, path } 对象`);
    }
    const candidate = rule as Partial<TransformExtractionRule>;
    if (typeof candidate.name !== "string" || candidate.name === "") {
      throw new Error(`第 ${index + 1} 条提取规则缺少规则名（name）`);
    }
    if (typeof candidate.path !== "string") {
      throw new Error(`提取规则 ${candidate.name} 缺少查询表达式（path）`);
    }
    if (candidate.engine !== "jsonPath" && candidate.engine !== "jmespath") {
      throw new Error(`提取规则 ${candidate.name} 的 engine 非法：${String(candidate.engine)}`);
    }
    return candidate as TransformExtractionRule;
  });

  if (cleaned.length === 1) {
    const rule = cleaned[0] as TransformExtractionRule;
    return extractByRule(rule, input);
  }

  const grouped: Record<string, unknown> = {};
  for (const rule of cleaned) {
    grouped[rule.name] = extractByRule(rule, input);
  }
  return grouped;
}

/**
 * 创建 transform 节点 runner（执行语义见文件头）。纯数据求值，无脚本端口 /
 * 存储 / 网络依赖；取消无需响应（同步求值）。
 */
export function createTransformRunner(): NodeRunner {
  return async (node, input) => evaluateExtractions(node.config.extractions, input);
}
