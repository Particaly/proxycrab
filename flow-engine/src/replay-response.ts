/**
 * 重放响应体的自动类型判断（M12-T3）。
 *
 * 背景：重放（浏览器 fetch 路径与重放桥路径）此前把响应体一律按文本返回，
 * 下游（后置脚本 / 断言 / transform / 模板引用）拿到 JSON 响应时只能是整段
 * 字符串；要取字段就得自己写 `JSON.parse(response.body)`（推断依赖生成的
 * 脚本正是这一形态）。本模块提供纯函数的类型判断：识别响应体是否为 JSON，
 * 是则额外给出**解析后的值**，并统一打上 `bodyType` 标记（'json' / 'text' /
 * 'empty'），供节点输出、UI 展示（类型徽章）与下游引用（`{{ node.x.json.* }}`、
 * 断言 `$.json.*`）使用。
 *
 * 兼容性设计（重要）：`body` 字段**保持原文文本不变**——既有用户脚本
 * `return JSON.parse(response.body)`（含推断依赖生成的脚本）继续可用；解析
 * 结果放在新增的 `json` 字段（仅 JSON 响应存在）。这样「自动类型判断」是
 * 增量能力而非行为破坏：不写脚本也能用 `{{ node.<id>.json.<path> }}` 取字段。
 *
 * 判定规则（宽松，n8n 同类工具的惯例）：
 *   - 空串 → 'empty'（不产出 json）；
 *   - content-type 含 'json'，或（content-type 缺失 / 非 JSON 时）body 原文
 *     trim 后以 `{` / `[` 开头 → 尝试 JSON.parse，成功即 'json'（json = 解析值）；
 *   - 其余（含解析失败——截断的 JSON、HTML、表单文本等）→ 'text'（无 json）。
 *
 * 宽松判定的理由：不少接口把 JSON 标成 text/plain 或省略 content-type，
 * 而「拿到了合法 JSON 就能按 JSON 用」是重放场景的高频预期。
 *
 * 本模块纯函数、零依赖（不依赖存储 / 网络 / chrome API），node 可直接单测；
 * 浏览器 fetch 路径（background/replay-executor.ts）与重放桥路径
 * （background/replay-bridge.ts）共用同一判定，两条传输路径的输出形状一致。
 */

/** 响应体类型判断结果（节点 output.bodyType） */
export type ReplayBodyType = "json" | "text" | "empty";

/** 类型判断产物：类型标记 +（JSON 响应时的）解析值 */
export interface ReplayBodyDetection {
  /** 类型标记（供下游按类型分支 / UI 展示） */
  bodyType: ReplayBodyType;
  /** 解析后的 JSON 值（bodyType === 'json' 时存在；其余类型为 undefined） */
  json?: unknown;
}

/**
 * 响应头大小写不敏感取值（fetch Headers / 桥回传 Record 通用）。
 *
 * @param headers 响应头（键大小写不定）
 * @param name 目标头名（比较前转小写）
 * @returns 头值；缺失返回 undefined
 */
export function readResponseHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

/**
 * 响应体自动类型判断（纯函数，见模块头；body 文本本身由调用方保留）。
 *
 * @param bodyText 响应体原文（截断后文本亦可——解析失败按文本处理）
 * @param headers 响应头（content-type 判定 JSON 用；缺省 / 无 content-type 时按内容嗅探）
 * @returns bodyType 与（JSON 响应时的）解析值 json
 */
export function detectResponseBody(
  bodyText: string,
  headers: Record<string, string> = {},
): ReplayBodyDetection {
  if (bodyText === "") return { bodyType: "empty" };

  const contentType = readResponseHeader(headers, "content-type")?.toLowerCase() ?? "";
  const trimmed = bodyText.trim();
  const contentTypeSaysJson = contentType.includes("json");
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!contentTypeSaysJson && !looksLikeJson) {
    return { bodyType: "text" };
  }

  try {
    return { bodyType: "json", json: JSON.parse(bodyText) as unknown };
  } catch {
    // 解析失败（截断 JSON / 伪 JSON 文本等）：按文本处理（不产出 json）
    return { bodyType: "text" };
  }
}
