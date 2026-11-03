/**
 * JSONPath 常用子集（M10-T3，自实现、零依赖）。
 *
 * ROADMAP M10-T3：断言节点需要按路径对响应 JSON 取值做比较。完整 JSONPath
 * 规范（filter / script 表达式 / slice / 多索引等）实现成本高且回归场景用不到，
 * 本模块实现「够回归测试用」的常用子集并在下方披露边界；不引入 jsonpath-plus
 * 等第三方依赖（硬性约束）。
 *
 * ─── 支持的语法 ────────────────────────────────────────────────────────
 *
 *   $.a.b              点分属性链（属性名为不含 . / [ / ] 的非空文本）
 *   $['a'] / $["a"]    引号属性（属性名可含任意字符；不支持转义引号）
 *   $[0]               数组下标（非负整数字面量；越界 = 无匹配，不报错）
 *   $[*] / $.*         通配符：取当前值（对象 / 数组）的全部子值
 *   $..name            递归下降：在当前值及全部后代中取名为 name 的属性值
 *
 * 根标识 `$` 必须存在（裸 `a.b` 不算合法路径）；`@` 当前节点表达式、过滤器
 * `[?(...)]`、slice `[1:3]`、多索引 `[0,1]`、`..*`、负下标一律不支持。
 *
 * ─── 求值语义 ──────────────────────────────────────────────────────────
 *
 * evaluateJsonPath 返回**全部匹配值**的数组（JSONPath 本是集合语义）：
 *   - 段落在非目标类型上取值（对象上用下标、数组上用属性名、null / 标量上继续
 *     下钻）= 该分支无匹配（静默丢弃，不报错）——「路径不存在」与「值为 null」
 *     由调用方区分（values 为空数组 vs 含 null 元素）；
 *   - 断言求值（engine/assert-nodes.ts）的消费约定：exists 看是否有匹配；
 *     eq / ne / contains / regex 要求**每个匹配值都满足**，零匹配视为失败。
 *
 * parseJsonPath 供配置抽屉在保存前做语法预检（与求值共用同一解析器）。
 *
 * 本文件为纯函数、零环境依赖（不依赖 React / 存储 / chrome.*），node 可直接单测；
 * 不通过 src/engine/index.ts 桶文件再导出（与 template.ts 同策略），调用方按
 * 路径 `@/engine/json-path` 直接引入。
 */

/** JSONPath 求值结果：成功带全部匹配值（可能为空数组），失败带中文错误说明 */
export type JsonPathResult = { ok: true; values: unknown[] } | { ok: false; error: string };

/** 路径段：属性名 / 下标 / 通配符 / 递归下降属性名 */
type PathSegment =
  | { type: "property"; name: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "descendant"; name: string };

/**
 * 解析 JSONPath 表达式为段列表（纯函数）。
 *
 * @param path 用户配置的路径文本（如 `$.body.items[0].name`）
 * @returns 解析结果；ok=false 时 error 为可直接展示的中文错误（含原文本）
 */
export function parseJsonPath(
  path: string,
): { ok: true; segments: PathSegment[] } | { ok: false; error: string } {
  const fail = (reason: string): { ok: false; error: string } => ({
    ok: false,
    error: `JSONPath 语法错误：${reason}（路径：${path}）`,
  });

  const text = typeof path === "string" ? path : "";
  if (!text.startsWith("$")) return fail('必须以根标识 "$" 开头');

  const segments: PathSegment[] = [];
  let i = 1; // 跳过 '$'
  while (i < text.length) {
    const ch = text[i];

    /* ---- 递归下降 `..name`（`..*` / `..[` 不支持） ---- */
    if (ch === "." && text[i + 1] === ".") {
      const name = readName(text, i + 2);
      if (name.length === 0) return fail('".." 后需紧跟属性名（"..*" / "..[" 不支持）');
      segments.push({ type: "descendant", name });
      i += 2 + name.length;
      continue;
    }

    /* ---- 点分属性 `.name` / 通配符 `.*` ---- */
    if (ch === ".") {
      if (text[i + 1] === "*") {
        segments.push({ type: "wildcard" });
        i += 2;
        continue;
      }
      const name = readName(text, i + 1);
      if (name.length === 0) return fail('"." 后需紧跟属性名（如 $.a.b）');
      segments.push({ type: "property", name });
      i += 1 + name.length;
      continue;
    }

    /* ---- 括号段 `[...]`：下标 / 通配符 / 引号属性 ---- */
    if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close === -1) return fail('缺少闭合的 "]"');
      const inner = text.slice(i + 1, close).trim();
      if (inner === "*") {
        segments.push({ type: "wildcard" });
      } else if (/^(0|[1-9]\d*)$/.test(inner)) {
        segments.push({ type: "index", index: Number.parseInt(inner, 10) });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
      ) {
        const name = inner.slice(1, -1);
        if (name.length === 0) return fail('引号属性名不能为空（如 $.["a b"]）');
        segments.push({ type: "property", name });
      } else {
        return fail(`括号段「${inner}」不支持（只允许非负整数下标 / * / 引号属性名）`);
      }
      i = close + 1;
      continue;
    }

    return fail(`出现不支持的字符「${ch}」（段之间只允许 "." / "[" 开头）`);
  }
  return { ok: true, segments };
}

/**
 * 从 text[from] 起读取一个「裸属性名」：连续的不含 `.` / `[` / `]` / `*` /
 * 空白的字符（`*` 仅作为通配符段出现，不进入属性名，`..*` 因此被拒绝）。
 * 空串表示该位置不是合法属性名起点（调用方负责报错）。
 */
function readName(text: string, from: number): string {
  let end = from;
  while (end < text.length && !" 	.[]*".includes(text[end] as string)) end++;
  return text.slice(from, end);
}

/**
 * 对一段当前值应用单个路径段，返回下一段的匹配集合（纯函数）。
 * 「类型不匹配 = 无匹配」：对象上取下标、数组上取属性名、null / 标量上继续
 * 下钻都返回空数组（不报错），与「路径不存在」同义。
 */
function applySegment(current: unknown, segment: PathSegment): unknown[] {
  switch (segment.type) {
    case "property": {
      if (current === null || typeof current !== "object") return [];
      const value = (current as Record<string, unknown>)[segment.name];
      return Object.prototype.hasOwnProperty.call(current, segment.name) ? [value] : [];
    }
    case "index": {
      if (!Array.isArray(current)) return [];
      return segment.index < current.length ? [current[segment.index] as unknown] : [];
    }
    case "wildcard": {
      if (Array.isArray(current)) return [...current];
      if (current !== null && typeof current === "object") return Object.values(current);
      return [];
    }
    case "descendant": {
      const hits: unknown[] = [];
      collectDescendant(current, segment.name, hits);
      return hits;
    }
  }
}

/** 深度优先收集「本节点及全部后代」中名为 name 的属性值（递归下降的展开步骤） */
function collectDescendant(node: unknown, name: string, hits: unknown[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectDescendant(item, name, hits);
    return;
  }
  const record = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) {
    hits.push(record[name]);
  }
  for (const value of Object.values(record)) collectDescendant(value, name, hits);
}

/**
 * 求值 JSONPath（纯函数）：返回路径在 root 上的全部匹配值。
 *
 * @param path JSONPath 表达式（语法子集见文件头）
 * @param root 求值根（断言节点传入节点 input）
 * @returns ok=true 时 values 为匹配集合（可能为空数组 = 路径无匹配）；
 *          ok=false 时 error 为可直接展示的语法错误说明
 */
export function evaluateJsonPath(path: string, root: unknown): JsonPathResult {
  const parsed = parseJsonPath(path);
  if (!parsed.ok) return parsed;
  let current: unknown[] = [root];
  for (const segment of parsed.segments) {
    const next: unknown[] = [];
    for (const value of current) next.push(...applySegment(value, segment));
    current = next;
  }
  return { ok: true, values: current };
}
