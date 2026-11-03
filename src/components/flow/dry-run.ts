/**
 * 流程 pre/post 脚本试跑（计划 Task 18）。
 *
 * 职责：脚本编辑器（ScriptEditor.vue）的纯逻辑支撑——错误分类文案、上下文
 * 提示文档、骨架脚本、样例默认值与 JSON 规整；实际执行经 Backend 能力位
 * `flowScriptDryRun` 调用服务端 `POST /api/flow/script/dry-run`（一次性 flow
 * VM + 引擎载荷，与执行链路同一套错误分类，不落库不广播）。能力位未实现时
 * UI 不展示「试跑」入口，本模块的 runScriptDryRun 也会拒绝执行。
 *
 * 本模块纯逻辑、零 Vue 依赖，可单测。
 */

import type { Backend } from "../../api/backend";
import type {
  FlowScriptDryRunErrorKind,
  FlowScriptDryRunResult,
  FlowScriptSide,
} from "../../api/types";

/** 错误分类的中文标签（UI 徽标用；message 为服务端产出的完整可读文案） */
const ERROR_KIND_LABELS: Record<FlowScriptDryRunErrorKind, string> = {
  syntax: "语法错误",
  blocked: "执行被拒绝",
  runtime: "运行时错误",
  timeout: "执行超时",
  "invalid-return": "返回值非法",
};

/**
 * 错误分类 → 中文标签；未知分类按运行时错误兜底。
 */
export function errorKindLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind as FlowScriptDryRunErrorKind] ?? ERROR_KIND_LABELS.runtime;
}

/** 上下文提示中的一个字段条目（入参主对象或返回对象的字段） */
export interface ScriptDocField {
  name: string;
  type: string;
  description: string;
}

/** 单个侧别的上下文提示内容（与引擎 runPreScript / runPostScript 契约对齐） */
export interface ScriptDocContent {
  /** 徽标文案（前置处理 / 后置处理） */
  badge: string;
  /** 数据形参名（pre 为 input，post 为 response） */
  paramName: string;
  /** 数据形参总体说明 */
  paramDescription: string;
  /** 数据形参字段列表 */
  paramFields: ScriptDocField[];
  /** 返回值总体说明 */
  returnDescription: string;
  /** 返回对象字段列表（post 返回任意 JSON 值，为空数组） */
  returnFields: ScriptDocField[];
}

const PRE_DOC: ScriptDocContent = {
  badge: "前置处理",
  paramName: "input",
  paramDescription: "上游节点输出聚合对象",
  paramFields: [
    {
      name: "node",
      type: "Record<refId, 节点输出>",
      description: '按节点引用码聚合的上游输出，如 input.node["abC12"].output.token',
    },
  ],
  returnDescription: "请求上下文覆盖对象（返回非对象视为不修改请求）",
  returnFields: [
    { name: "url", type: "string", description: "覆盖本次请求的 URL" },
    { name: "headers", type: "Record<string, string>", description: "覆盖本次请求的请求头" },
    { name: "body", type: "string | object", description: "覆盖本次请求的请求体" },
    { name: "timeoutMs", type: "number", description: "覆盖本次请求的超时毫秒数" },
  ],
};

const POST_DOC: ScriptDocContent = {
  badge: "后置处理",
  paramName: "response",
  paramDescription: "原始响应对象",
  paramFields: [
    { name: "status", type: "number", description: "HTTP 状态码，如 200" },
    { name: "headers", type: "Record<string, string>", description: "响应头" },
    {
      name: "body",
      type: "string",
      description: "响应体原文文本；JSON.parse(response.body) 写法继续可用",
    },
    {
      name: "json",
      type: "any（可选）",
      description: "响应体的解析值：body 为合法 JSON 时存在，可直接取字段",
    },
    { name: "bodyType", type: "'json' | 'text' | 'empty'", description: "响应体自动类型判断" },
    { name: "durationMs", type: "number", description: "请求耗时（毫秒）" },
  ],
  returnDescription: "本节点 output（任意 JSON 值；不返回则默认 response.body）",
  returnFields: [],
};

/** 按侧别索引的上下文提示常量（ScriptEditor 与测试共用） */
export const SCRIPT_DOC: Record<FlowScriptSide, ScriptDocContent> = {
  pre: PRE_DOC,
  post: POST_DOC,
};

/** env 形参说明（两个侧别一致；试跑中为空表，写回不持久化） */
export const ENV_PARAM_HINT =
  "env：环境变量快照（第二数据形参），可直接赋值写回；试跑中为空表，写回不持久化";

/** 按侧别的骨架脚本（函数体，用 return 返回结果） */
export const SCRIPT_SKELETON: Record<FlowScriptSide, string> = {
  pre: [
    '// input：上游节点输出聚合对象（input.node["<refId>"].output.<path>）',
    "// env：环境变量快照（试跑中为空表）",
    "// 返回覆盖对象（url / headers / body / timeoutMs）；返回非对象视为不修改请求",
    "return {",
    '  headers: { authorization: "Bearer " + env.token },',
    "};",
  ].join("\n"),
  post: [
    "// response：原始响应（status / headers / body / json / durationMs）",
    "// 返回本节点 output（任意 JSON 值；不返回则默认 response.body）",
    "return response.json;",
  ].join("\n"),
};

/** 按侧别的默认样例 JSON 文本（试跑入口的初始值） */
export const DEFAULT_SAMPLE_JSON: Record<FlowScriptSide, string> = {
  pre: "{}",
  post: JSON.stringify(
    {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      json: { ok: true },
      durationMs: 12,
    },
    null,
    2,
  ),
};

/**
 * 解析样例 JSON 文本。
 *
 * @param sampleJson 样例文本（pre 为 input 的形状，post 为 response 的形状）
 * @returns { ok: true, value }（空白串 → null，便于试跑 return undefined 场景）
 *   或 { ok: false, error: 解析失败文案 }
 */
export function parseSampleJson(
  sampleJson: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = sampleJson.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (error) {
    return { ok: false, error: `样例 JSON 解析失败：${toErrorMessage(error)}` };
  }
}

/**
 * 把任意抛出值规整为可读错误文本（Error 取 name: message，其余 String() 兜底）。
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 把试跑返回值序列化为可展示文本。
 *
 * @param value 试跑成功时的 value（null/undefined → 'undefined'）
 * @returns 2 空格美化 JSON；序列化失败回退 String(value)
 */
export function stringifyDryRunValue(value: unknown): string {
  if (value === undefined || value === null) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 执行一次脚本试跑：样例 JSON 解析失败抛可展示文案；服务端失败经 Backend
 * 错误通道抛出（message 已本地化）。脚本自身的失败不在客户端抛——它们以
 * `{ok:false, error:{kind,message}}` 结果对象返回，交由 UI 展示。
 *
 * @param backend Backend 实例（能力位 `flowScriptDryRun` 必须存在）
 * @param request 试跑请求（侧别 / 脚本 / 样例）
 * @returns 服务端试跑结果（成功带 value/warnings，失败带分类错误）
 * @throws 样例 JSON 解析失败或能力位缺失时抛错（error 为可展示文案）
 */
export async function runScriptDryRun(
  backend: Backend,
  request: {
    side: FlowScriptSide;
    script: string;
    sampleJson: string;
  },
): Promise<FlowScriptDryRunResult> {
  if (typeof backend.flowScriptDryRun !== "function") {
    throw new Error("当前环境不支持脚本试跑");
  }
  const sample = parseSampleJson(request.sampleJson);
  if (!sample.ok) throw new Error(sample.error);
  const payload = {
    side: request.side,
    script: request.script,
    ...(request.side === "pre" ? { sampleInput: sample.value } : { sampleResponse: sample.value }),
  };
  return backend.flowScriptDryRun(payload);
}
