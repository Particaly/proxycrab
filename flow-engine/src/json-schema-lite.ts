/**
 * JSON Schema 常用子集校验（M10-T3，自实现、零依赖）。
 *
 * ROADMAP M10-T3：断言节点的 Schema 规则要求「不引入依赖，实现常用子集，
 * 够回归用并在注释披露边界」。本模块支持的关键字：
 *
 *   - type          期望类型：字符串或字符串数组（满足其一即可）。
 *                   取值 'object' / 'array' / 'string' / 'number' / 'integer'
 *                   / 'boolean' / 'null'（'integer' 为便利扩展：整数即通过）。
 *   - required      对象必填属性名列表（目标不是对象时本关键字跳过）。
 *   - properties    属性名 → 子 schema；只校验**实际存在**的属性（缺省属性不做
 *                   additionalProperties 约束——该关键字不支持，见下方边界）。
 *   - items         数组元素 schema，逐元素校验（目标不是数组时跳过）。
 *   - enum          枚举值列表：目标值须与其中之一 deep equal（相等语义与
 *                   engine/json-equal 的 jsonDeepEqual 一致：NaN 不等、对象按键）。
 *
 * ─── 边界披露（刻意不支持，够回归用即可）─────────────────────────────
 *
 *   不支持：additionalProperties / min* / max* / pattern / format / oneOf /
 *   anyOf / allOf / not / $ref / $defs / 递归 schema、自定义元数据校验。
 *   未知关键字**静默忽略**（向前兼容，不会因写了不认识的关键字而报错）。
 *   Schema 形状非法（type 拼错 / required 非字符串数组 / properties 值非对象、
 *   enum 非数组等）按校验失败处理并给出中文说明——配置错误显式暴露而非静默放行。
 *
 * 本文件为纯函数、零环境依赖，node 可直接单测；不通过 src/engine/index.ts
 * 桶文件再导出，调用方按路径 `@/engine/json-schema-lite` 直接引入。
 */

import { jsonDeepEqual } from "./json-equal";

/** Schema 关键字支持的类型名清单 */
const SUPPORTED_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

/** 校验结果：通过 / 失败（errors 为逐条中文说明，含目标路径） */
export type JsonSchemaLiteResult = { ok: true } | { ok: false; errors: string[] };

/** 判断值是否为普通对象（排除 null 与数组，与 storage/validate 同款判定） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 单个值是否满足类型名（'integer' 为便利扩展：整数即通过） */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

/**
 * 以 JSON Schema 常用子集校验一个值（递归，纯函数）。
 *
 * @param schema schema 定义（容忍任意脏形状：非法形状产出「schema 配置非法」
 *   类错误而不是抛异常，断言层按校验失败处理）
 * @param value 待校验值
 * @param path 错误信息里的目标路径展示文本（根调用传 '$'，递归下钻拼点分 / 下标）
 * @returns ok=true 校验通过；ok=false 时 errors 为全部失败项（一次收集全部，
 *   便于回归报告一次看清所有差异）
 */
export function validateJsonSchemaLite(
  schema: unknown,
  value: unknown,
  path = "$",
): JsonSchemaLiteResult {
  const errors: string[] = [];

  // schema 非对象（含 null / 数组）：无法表达任何约束，按配置错误处理
  if (!isPlainObject(schema)) {
    return {
      ok: false,
      errors: [`${path} 的 schema 配置非法：需为对象（得到 ${describeType(schema)}）`],
    };
  }

  /* ---- type：字符串或字符串数组，满足其一 ---- */
  const rawType = schema["type"];
  if (rawType !== undefined) {
    const types = Array.isArray(rawType) ? rawType : [rawType];
    const invalid = types.find(
      (entry) =>
        typeof entry !== "string" || !(SUPPORTED_TYPES as readonly string[]).includes(entry),
    );
    if (types.length === 0 || invalid !== undefined) {
      errors.push(
        `${path} 的 schema 配置非法：type 需为 ${SUPPORTED_TYPES.join(" / ")} 或其数组（得到 ${JSON.stringify(rawType) ?? String(rawType)}）`,
      );
    } else if (!types.some((type) => matchesType(value, type as string))) {
      errors.push(`${path} 的类型不符：期望 ${types.join(" | ")}，实际 ${describeType(value)}`);
    }
  }

  /* ---- enum：与枚举值之一 deep equal ---- */
  const rawEnum = schema["enum"];
  if (rawEnum !== undefined) {
    if (!Array.isArray(rawEnum) || rawEnum.length === 0) {
      errors.push(
        `${path} 的 schema 配置非法：enum 需为非空数组（得到 ${JSON.stringify(rawEnum) ?? String(rawEnum)}）`,
      );
    } else if (!rawEnum.some((candidate) => jsonDeepEqual(candidate, value))) {
      errors.push(
        `${path} 不在枚举范围内：期望 ${JSON.stringify(rawEnum) ?? String(rawEnum)} 之一，实际 ${JSON.stringify(value) ?? String(value)}`,
      );
    }
  }

  /* ---- properties / required：仅对对象生效（数组 / 标量跳过这两个关键字） ---- */
  const rawProperties = schema["properties"];
  if (rawProperties !== undefined && !isPlainObject(rawProperties)) {
    errors.push(`${path} 的 schema 配置非法：properties 需为对象`);
  }
  const rawRequired = schema["required"];
  if (
    rawRequired !== undefined &&
    (!Array.isArray(rawRequired) || !rawRequired.every((entry) => typeof entry === "string"))
  ) {
    errors.push(
      `${path} 的 schema 配置非法：required 需为字符串数组（得到 ${JSON.stringify(rawRequired) ?? String(rawRequired)}）`,
    );
  }

  if (isPlainObject(value)) {
    // required：先查缺失（缺失项不再递归 properties，避免错误重复）
    if (Array.isArray(rawRequired)) {
      for (const key of rawRequired as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${path} 缺少必填属性 "${key}"`);
        }
      }
    }
    // properties：只校验实际存在的属性（缺失属性由 required 负责）
    if (isPlainObject(rawProperties)) {
      for (const [key, childSchema] of Object.entries(rawProperties)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const child = validateJsonSchemaLite(childSchema, value[key], `${path}.${key}`);
        if (!child.ok) errors.push(...child.errors);
      }
    }
  }

  /* ---- items：仅对数组生效，逐元素递归 ---- */
  const rawItems = schema["items"];
  if (rawItems !== undefined && Array.isArray(value)) {
    if (!isPlainObject(rawItems)) {
      errors.push(`${path} 的 schema 配置非法：items 需为对象形式的 schema`);
    } else {
      for (let index = 0; index < value.length; index++) {
        const child = validateJsonSchemaLite(rawItems, value[index], `${path}[${index}]`);
        if (!child.ok) errors.push(...child.errors);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** 值的类型中文描述（错误信息用；区分普通对象与数组） */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    default:
      return typeof value;
  }
}
