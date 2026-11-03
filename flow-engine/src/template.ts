/**
 * 参数模板引擎（M4-T4）。
 *
 * ROADMAP §4 节点数据流约定：上游节点输出聚合为 input，节点参数（URL / headers /
 * body）中的 `{{ ... }}` 表达式在发起重放请求前渲染：
 *   - `{{ node.<nodeId>.<path> }}` → 取某上游节点 output 的路径值；
 *   - `{{ input.<path> }}`         → 取聚合 input 的路径值；
 *   - `{{ <path> }}`（裸路径）      → `input.<path>` 的简写：节点配置里直接写
 *     入参路径即可（如 `{{ headers.x-token }}` / `{{ body.user.id }}`）。
 *     配置面板里的模板引用几乎都是「取当前节点入参」，不必反复输入 input. 前缀；
 *   - `{{ var.<name>.<path> }}`    → 取运行期变量的路径值（M7-T2 变量系统：
 *     流程级 / 项目级 / 全局级三层合并后的变量表，经 RenderContext.var 注入；
 *     裸 `{{ var }}`（缺变量名）不算合法引用，按未知引用告警）；
 *   - `{{ env.<key>.<path> }}`     → 取环境变量的路径值（M10-T4 环境变量集：
 *     当前激活环境集合的键值快照，经 RenderContext.env 注入；独立命名空间，
 *     与 var 并存不冲突；无激活环境 / 键不存在 → 空串 + 专属告警）。
 *
 * 裸路径的判定：内容不以 node / input / $json / var / env 这些保留根开头、且
 * 形如点分路径（标识符段，允许 - 与 $，用于请求头名）时按入参路径解析；其余
 * 形态（含空表达式）仍按未知引用处理并告警。保留根优先——入参里恰好有名为
 * var / env 的字段时需要写 `input.var...` 消歧。
 *
 * 本模块为纯函数、零依赖（不依赖 React / 存储 / 网络），供三处消费：
 *   - M5 执行器：发请求前对 URL / headers / body 做 renderTemplate / renderValueDeep；
 *   - 表达式提示组件（M4-T4）：extractReferences 展示模板已引用的数据；
 *   - 调试 / 校验场景：parseTemplate 切分 token 检查语法。
 *
 * M12-T3 增量：`$json.<path>` 作为 `input.<path>` 的别名（n8n 习惯写法，
 * 节点内部用模板从入参取字段时更直观；解析结果统一为 kind:'input'，
 * 渲染 / 引用清单 / 提示组件对两种写法一视同仁）。
 *
 * 错误策略：渲染永不因缺数据失败——未知引用 / 缺失路径 / null·undefined 值一律
 * 替换为空串并记录 warning，由调用方（M5-T2 执行器 / M5-T4 失败策略）决定是否
 * 展示或中断，本层绝不 throw。
 *
 * 注意：本文件不通过 src/engine/index.ts 桶文件再导出（M4-T4 只新增本文件，
 * 不改动既有 engine 文件），调用方按路径 `@/engine/template` 直接引入。
 */

/** 模板引用：`{{ ... }}` 内的取数描述（供提示组件与校验展示） */
export interface TemplateRef {
  /**
   * 引用根：'node' 指某上游节点的 output；'input' 指聚合入参（裸路径简写同样
   * 解析为 'input'）；'var' 指运行期变量表（M7-T2：流程级 / 项目级 / 全局级
   * 合并后的变量）；'env' 指环境变量集（M10-T4：当前激活环境的键值快照，
   * 独立命名空间——与 var 前缀选型说明：env 与 node / input / var 四根互不
   * 冲突，环境值不并入 var 命名空间，避免与流程 / 项目 / 全局变量同名键
   * 产生优先级歧义）
   */
  kind: "node" | "input" | "var" | "env";
  /** kind === 'node' 时的目标节点 id（'input' / 'var' / 'env' 引用没有该字段） */
  nodeId?: string;
  /** kind === 'var' / 'env' 时的变量名 / 环境键名（'node' / 'input' 引用没有该字段） */
  name?: string;
  /** 点分路径（如 'output.token'、'user.0.id'）；空串表示引用根值本身 */
  path: string;
}

/** 静态文本 token（表达式中断处的原样文本，或未闭合 `{{` 的兜底字面量） */
export interface TemplateTextToken {
  kind: "text";
  value: string;
  /** 仅当这段文本由未闭合的 `{{` 兜底而来时携带解析警告（renderTemplate 会透出） */
  warning?: string;
}

/** 表达式 token：一对 `{{ ... }}`（内部内容已 trim） */
export interface TemplateExpressionToken {
  kind: "expression";
  /** 花括号内 trim 后的内容（如 'node.n2.output.token'），拼警告时原样回显 */
  raw: string;
  /** 解析出的引用；内容不符合两种引用语法时为 null（渲染为空串 + 警告） */
  ref: TemplateRef | null;
}

/** 模板切分结果：静态文本与表达式的有序序列 */
export type TemplateToken = TemplateTextToken | TemplateExpressionToken;

/** 渲染上下文：node 按节点 id 索引上游数据（执行时通常取各节点 NodeRun.output） */
export interface RenderContext {
  /** 按节点 id 索引的上游节点数据 */
  node: Record<string, unknown>;
  /** 上游输出聚合成的入参 */
  input: unknown;
  /**
   * 运行期变量表（M7-T2，可选）：流程级 / 项目级 / 全局级三层合并后的变量，
   * `{{ var.<name>.<path> }}` 由此取值。缺省（undefined / 非对象）时 var 引用
   * 一律按「变量不存在」告警，渲染不抛错。
   */
  var?: Record<string, unknown>;
  /**
   * 环境变量表（M10-T4，可选）：当前激活环境集合的键值快照（运行开始时
   * 定格，运行中切换环境不影响进行中的运行），`{{ env.<key>.<path> }}` 由此
   * 取值。缺省（undefined / 非对象，含「无激活环境」场景）时 env 引用一律
   * 按「环境变量不存在」告警并渲染为空串——与 var 的缺省值约定一致
   * （渲染永不因缺数据失败），不做单独的「环境未激活」分支。
   */
  env?: Record<string, unknown>;
}

/** 解析警告：未闭合的 `{{` 按字面量处理（挂在对应文本 token 上，渲染时透出） */
export const UNCLOSED_BRACE_WARNING = '未闭合的 "{{" 已按字面量处理';

/** 表达式起始序列（当前不支持 `{{{` 三花笔等变体，最左 `{{` 即开启表达式） */
const OPEN_SEQUENCE = "{{";

/**
 * 裸路径（= 入参路径简写）的形态：点分标识符段，段内允许 `$` 与 `-`（请求头名
 * 常见形态，如 `headers.x-request-id`）。不符合该形态的内容不做简写解析，
 * 仍按未知引用告警，避免把随手写的文字误当路径。
 */
const BARE_PATH_PATTERN = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;

/** 数组下标段的形式：不允许前导零（'01'）与负数，避免与对象键产生歧义 */
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * 解析表达式内容为引用。
 *
 * 语法：`input.<path>`、`node.<nodeId>.<path>`（nodeId 自身不含点）、
 * `var.<name>.<path>`（M7-T2，变量名自身不含点）或 `env.<key>.<path>`（M10-T4）；
 * `$json.<path>` 是 `input.<path>` 的别名（n8n 习惯，M12-T3，方便从入参取字段）。
 * 裸点分路径（如 `headers.x-token`）是 `input.<path>` 的简写——节点配置内的
 * 模板引用绝大多数就是取当前节点入参，省略前缀可少输一长串。
 * path 允许为空串（引用根值本身，如 `{{ node.n2 }}` / `{{ input }}` /
 * `{{ $json }}` / `{{ var.token }}`）；其余不符合语法的内容（空表达式、未知根、
 * 缺 nodeId / 变量名等，含裸 `{{ var }}`）返回 null。
 */
function parseRef(content: string): TemplateRef | null {
  const dotIndex = content.indexOf(".");
  const root = dotIndex === -1 ? content : content.slice(0, dotIndex);
  const rest = dotIndex === -1 ? "" : content.slice(dotIndex + 1);

  if (root === "input" || root === "$json") {
    // $json 是 input 的别名（n8n 习惯写法）：引用同一份聚合入参
    return { kind: "input", path: rest };
  }
  if (root === "node") {
    // 「node」后必须显式给出节点 id：'node' 单独出现或 'node..path' 均视为未知引用
    if (rest === "") return null;
    const secondDot = rest.indexOf(".");
    if (secondDot === -1) return { kind: "node", nodeId: rest, path: "" };
    const nodeId = rest.slice(0, secondDot);
    if (nodeId === "") return null;
    return { kind: "node", nodeId, path: rest.slice(secondDot + 1) };
  }
  if (root === "var") {
    // 「var」后必须显式给出变量名：'var' 单独出现或 'var..path' 均视为未知引用
    if (rest === "") return null;
    const secondDot = rest.indexOf(".");
    if (secondDot === -1) return { kind: "var", name: rest, path: "" };
    const name = rest.slice(0, secondDot);
    if (name === "") return null;
    return { kind: "var", name, path: rest.slice(secondDot + 1) };
  }
  if (root === "env") {
    // M10-T4：「env」后必须显式给出键名，语法与 var 完全同形
    // （'env' 单独出现或 'env..path' 均视为未知引用）
    if (rest === "") return null;
    const secondDot = rest.indexOf(".");
    if (secondDot === -1) return { kind: "env", name: rest, path: "" };
    const name = rest.slice(0, secondDot);
    if (name === "") return null;
    return { kind: "env", name, path: rest.slice(secondDot + 1) };
  }
  // 裸路径 = 入参路径简写（保留根已在上方优先匹配）：非点分路径形态的内容
  // （含空白 / 括号等）仍判为未知引用，保留原有的语法告警
  if (BARE_PATH_PATTERN.test(content)) {
    return { kind: "input", path: content };
  }
  return null;
}

/**
 * 把模板字符串切分为静态文本与表达式 token 序列。
 *
 * 规则：
 *   - 从左到右扫描，最左的 `{{` 开启表达式，到最近的 `}}` 结束（内容 trim）；
 *   - 未闭合的 `{{`（其后找不到 `}}`）：从该处到串尾整体按字面量文本处理，
 *     并在对应文本 token 上记录 UNCLOSED_BRACE_WARNING（若与已有文本相邻则合并）；
 *   - 独立出现的 `}}` / 单个 `{` 只是普通文本，不产生警告。
 *
 * @param raw 模板原文（空串返回 []）
 * @returns token 序列（保序，可能为空数组）
 */
export function parseTemplate(raw: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const open = raw.indexOf(OPEN_SEQUENCE, cursor);
    if (open === -1) {
      tokens.push({ kind: "text", value: raw.slice(cursor) });
      break;
    }
    if (open > cursor) {
      tokens.push({ kind: "text", value: raw.slice(cursor, open) });
    }

    const close = raw.indexOf("}}", open + OPEN_SEQUENCE.length);
    if (close === -1) {
      // 未闭合：剩余整体按字面量兜底；与紧邻的前一个文本 token 合并，避免碎片化
      const literal = raw.slice(open);
      const last = tokens[tokens.length - 1];
      if (open > cursor && last && last.kind === "text") {
        last.value += literal;
        last.warning = UNCLOSED_BRACE_WARNING;
      } else {
        tokens.push({ kind: "text", value: literal, warning: UNCLOSED_BRACE_WARNING });
      }
      break;
    }

    const content = raw.slice(open + OPEN_SEQUENCE.length, close).trim();
    tokens.push({ kind: "expression", raw: content, ref: parseRef(content) });
    cursor = close + 2;
  }

  return tokens;
}

/**
 * 点分路径求值：按 `a.b.0.c` 逐段下钻（对象键 / 数组下标）。
 *
 * 规则：
 *   - path 为空串视为「引用根值本身」，返回 { found: true, value: root }；
 *   - 数组段必须是规范十进制下标（'0'、'12'，拒绝 '01' / '-1' / 非数字），
 *     且不得越界；对象段用 hasOwnProperty 精确匹配，原型链键
 *     （constructor / __proto__ / toString 等）不可引用；
 *   - 任意一段缺失（中途为 null / undefined / 原始值、键不存在、下标越界）
 *     返回 { found: false, value: undefined }，绝不抛错。
 *
 * 注意 found:true 时 value 仍可能是 undefined / null（键存在但值如此），
 * 是否告警由渲染层（renderTemplate）按「值为空」策略处理。
 */
export function resolvePath(root: unknown, path: string): { found: boolean; value: unknown } {
  if (path === "") {
    return { found: true, value: root };
  }

  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_PATTERN.test(segment)) {
        return { found: false, value: undefined };
      }
      const index = Number(segment);
      if (index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
    } else {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return { found: false, value: undefined };
      }
      current = record[segment];
    }
  }
  return { found: true, value: current };
}

/**
 * 表达式求值结果字符串化。
 *
 * 字符串原样；数字 / 布尔走 String()；对象 / 数组 JSON 序列化（拼进 body / header
 * 时保持数据可读）。JSON 之外的值（循环引用、BigInt 等）退化 String()，不抛错。
 */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 读取 node 引用的根值，并区分「节点不在上下文」与「路径缺失」两种告警 */
function getNodeRoot(ctx: RenderContext, nodeId: string): { present: boolean; value: unknown } {
  const table = ctx.node;
  if (table === null || typeof table !== "object") {
    return { present: false, value: undefined };
  }
  const record = table as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, nodeId)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record[nodeId] };
}

/** 读取 var 引用的根值，并区分「变量不存在」与「路径缺失」两种告警 */
function getVarRoot(ctx: RenderContext, name: string): { present: boolean; value: unknown } {
  const table = ctx.var;
  if (table === null || typeof table !== "object") {
    return { present: false, value: undefined };
  }
  const record = table as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, name)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record[name] };
}

/** 读取 env 引用的根值，并区分「环境变量不存在」与「路径缺失」两种告警（M10-T4） */
function getEnvRoot(ctx: RenderContext, name: string): { present: boolean; value: unknown } {
  const table = ctx.env;
  if (table === null || typeof table !== "object") {
    return { present: false, value: undefined };
  }
  const record = table as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, name)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record[name] };
}

/**
 * 渲染单个模板字符串：把全部 `{{ ... }}` 表达式求值并拼接为最终字符串。
 *
 * 行为约定（渲染永不因缺数据失败）：
 *   - 未知引用（语法不符 / 空表达式）→ 空串 + 「未知的模板引用」警告；
 *   - node 引用的节点不在 ctx.node 中 → 空串 + 「节点不在上下文」警告；
 *   - var 引用的变量不在 ctx.var 中 → 空串 + 「变量不存在」警告（M7-T2）；
 *   - env 引用的键不在 ctx.env 中（含无激活环境的表缺失场景）→ 空串 +
 *     「环境变量不存在」警告（M10-T4，缺省值约定与 var 一致）；
 *   - 路径缺失 → 空串 + 「路径不存在」警告；
 *   - 求值结果为 null / undefined → 空串 + 「值为空」警告（JSON null 亦然，
 *     与「键存在但值就是 null」的场景统一提示，便于上游排查数据链路）；
 *   - 未闭合 `{{` 的字面量兜底文本原样保留，其解析警告透出到 warnings。
 *
 * @param raw 模板原文
 * @param ctx 渲染上下文（node / input 缺字段时按「数据缺失」处理而非抛错）
 * @returns value 为拼接后的字符串；warnings 为本串产生的全部警告
 */
export function renderTemplate(
  raw: string,
  ctx: RenderContext,
): { value: string; warnings: string[] } {
  const warnings: string[] = [];
  const parts: string[] = [];

  for (const token of parseTemplate(raw)) {
    if (token.kind === "text") {
      parts.push(token.value);
      if (token.warning) warnings.push(token.warning);
      continue;
    }

    // 以下各分支出错一律「空串 + 警告」，保证渲染结果始终是完整字符串
    if (!token.ref) {
      warnings.push(`未知的模板引用：{{ ${token.raw} }}`);
      continue;
    }

    const ref = token.ref;
    let rootValue: unknown;
    if (ref.kind === "input") {
      rootValue = ctx.input;
    } else if (ref.kind === "var") {
      // M7-T2 变量引用：变量名不在 ctx.var（表缺失 / 未定义）→ 专属告警；
      // 其后的路径求值与 node / input 引用共用同一套「路径不存在 / 值为空」策略
      const varRoot = getVarRoot(ctx, ref.name ?? "");
      if (!varRoot.present) {
        warnings.push(`模板引用的变量不存在：{{ ${token.raw} }}`);
        continue;
      }
      rootValue = varRoot.value;
    } else if (ref.kind === "env") {
      // M10-T4 环境变量引用：键名不在 ctx.env（表缺失 / 未定义 / 无激活环境）
      // → 专属告警并渲染为空串（与 var 的缺省值约定一致：渲染永不因缺数据失败，
      // 「未激活环境」不单独设分支，统一按「环境变量不存在」处理）；
      // 其后的路径求值与 var / node / input 引用共用同一套策略
      const envRoot = getEnvRoot(ctx, ref.name ?? "");
      if (!envRoot.present) {
        warnings.push(`模板引用的环境变量不存在：{{ ${token.raw} }}`);
        continue;
      }
      rootValue = envRoot.value;
    } else {
      const nodeRoot = getNodeRoot(ctx, ref.nodeId ?? "");
      if (!nodeRoot.present) {
        warnings.push(`模板引用的节点不在上下文中：{{ ${token.raw} }}`);
        continue;
      }
      rootValue = nodeRoot.value;
    }

    const resolved = resolvePath(rootValue, ref.path);
    if (!resolved.found) {
      warnings.push(`模板引用路径不存在：{{ ${token.raw} }}`);
      continue;
    }
    if (resolved.value === undefined || resolved.value === null) {
      warnings.push(`模板引用的值为 null/undefined：{{ ${token.raw} }}`);
      parts.push("");
      continue;
    }
    parts.push(stringifyValue(resolved.value));
  }

  return { value: parts.join(""), warnings };
}

/**
 * 递归渲染任意 JSON 结构中的所有字符串值（headers record、body JSON 用）。
 *
 * 规则：
 *   - 字符串 → renderTemplate 渲染，警告聚合到结果 warnings；
 *   - 数组 / 对象 → 递归（对象的键不渲染——模板只应出现在值的槽位，
 *     改写键会破坏 headers 语义）；
 *   - 数字 / 布尔 / null / undefined 及 JSON 之外的类型原样保留
 *     （它们不可能包含模板表达式，保持引用不变避免意外改写数据）。
 *
 * 字符串语义保持：渲染结果永远是字符串——即使整串就是一个表达式且求值结果
 * 是数字 / 布尔（如 '{{ input.count }}' → '42'），或渲染后的文本恰好是合法
 * JSON 数字 / 布尔 / JSON 片段，也不会被 parseInt / JSON.parse 反向转换。
 * 原因：模板只出现在字符串槽位（URL / header 值 / body 原文），自动改型会让
 * headers 出现非字符串值，且同一段模板在不同槽位会得到不一致的结构；
 * 如需数字语义，由调用方（M5 执行器 / postProcess 脚本）显式转换。
 *
 * @param value 任意 JSON 结构（结构内非 JSON 类型原样保留）
 * @param ctx 渲染上下文
 * @returns value 为渲染后的同构结构；warnings 为全部叶子字符串警告的聚合
 */
export function renderValueDeep(
  value: unknown,
  ctx: RenderContext,
): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];

  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      const rendered = renderTemplate(current, ctx);
      warnings.push(...rendered.warnings);
      return rendered.value;
    }
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    if (current !== null && typeof current === "object") {
      const rendered: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        rendered[key] = walk(item);
      }
      return rendered;
    }
    return current;
  };

  return { value: walk(value), warnings };
}

/**
 * 提取模板中的引用清单（保序、不去重，供提示组件 / 校验展示）。
 *
 * 只收录能解析为合法引用的表达式（node / input / var / env 四种根，var 为
 * M7-T2 新增、env 为 M10-T4 新增）；未知引用（渲染时会告警）不在此列，
 * 若需要检查语法问题请改用 parseTemplate 查看 token.ref === null 的表达式。
 *
 * @param raw 模板原文
 * @returns 按出现顺序排列的引用列表（同一引用重复出现会重复收录）
 */
export function extractReferences(raw: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const token of parseTemplate(raw)) {
    if (token.kind === "expression" && token.ref) {
      refs.push(token.ref);
    }
  }
  return refs;
}
