/**
 * 表达式提示纯逻辑（ReqFlow 复刻计划 Task 15 薄片 A）。
 *
 * 自归档 `_archive/reqflow/src/components/expression-input/expression-suggest.ts
 * @ 485fa00` 移植形态（React 组件配套纯函数 → 本仓框架无关写法），语义契约是
 * 本仓 `flow-engine/src/template.ts`（Task 2 移植的模板引擎）：四命名空间
 * `node.<nodeId>.<path>` / `input.<path>` / `var.<name>.<path>` / `env.<key>.<path>`，
 * 裸路径是 `input.<path>` 的简写、`$json.<path>` 是其别名。
 *
 * 为 ExpressionInput 提供可单测的纯函数：
 *   - buildRootOptions / buildNodeOptions  两个提示层级的候选构造；
 *   - buildVariableOptions / buildEnvOptions 变量名 / 环境键候选构造；
 *   - filterRefs                           按输入过滤候选（大小写不敏感子串匹配）；
 *   - buildSuggestOptions                  依据当前查询串决定层级并给出候选；
 *   - detectSuggestState                   判定光标是否处于未闭合的 {{ 表达式内；
 *   - applySuggestInsert                   计算选中候选后的文本与光标位置；
 *   - buildInsertTemplatePlan              「插入引用」兜底按钮的插入计划；
 *   - buildDropInsertPlan                  拖放插入的写入计划；
 *   - matchesPathSegments                  路径段前缀匹配（供 IO 面板字段搜索复用）。
 *
 * 组件只做输入辅助（提示 / 补全），不执行模板渲染——渲染只在引擎层
 * （flow-engine/src/template.ts 的 renderTemplate）进行。
 *
 * 入参简写（与 flow-engine 模板的裸路径解析对齐）：节点配置内的模板引用绝大多数
 * 是「取当前节点入参」，因此有入参字段清单时第一级直接列出入参顶层字段（插入
 * `headers.` 这类裸片段），不再要求先选 `input.` 根；清单缺失时保留 `input.`
 * 根作为入口（此时无法给出字段候选）。
 *
 * 深路径补全：`node.<id>.` 之后的路径段补全——调用方提供各节点的样本路径清单
 * （nodePathSamples，由最近运行 output / 捕获响应体经 collectJsonPaths 预派生）
 * 时，路径段给出候选、节点 id 候选改为可下钻；未提供时路径段返回空（用户继续
 * 手输，渲染层 resolvePath 支持任意深度）。
 */

/** 上游可引用节点选项（组件 props 传入，来自画布上游节点清单） */
export interface SuggestNodeOption {
  /** 节点 id（模板引用里使用的真实 id） */
  id: string;
  /** 节点展示名（画布上的 label） */
  label: string;
}

/**
 * 单个节点的深路径候选样本：`{{ node.<id>.` 之后按该节点样本数据（最近运行
 * output / 捕获响应体投影）派生的点分路径清单。调用方（页面 / 抽屉）经
 * collectJsonPaths 预派生（深度与数量上限见 input-paths.ts），本模块只做候选
 * 构造与过滤。
 */
export interface SuggestNodePathSample {
  /** 节点 id（与模板引用 node.<id> 对应） */
  id: string;
  /** 该节点样本数据的点分路径候选（如 ['status', 'json.data.token']） */
  paths: ReadonlyArray<string>;
  /** 样本来源（浮层次要说明区分：运行输出 / 捕获响应体） */
  source: "run" | "capture";
}

/** 提示浮层的单个候选 */
export interface RefSuggestOption {
  /** 选中后写入的补全片段（替换 `{{` 之后到光标的内容） */
  insert: string;
  /** 浮层主文案（根名或节点 id） */
  label: string;
  /** 浮层次要说明（根用途或节点 label） */
  description: string;
  /**
   * 叶子选项：插入后关闭浮层（路径由用户继续输入）；非叶子选项插入后浮层
   * 推进到下一级
   */
  leaf: boolean;
  /** 参与过滤的小写文本（id 与 label 合并，供 filterRefs 子串匹配） */
  searchText: string;
}

/** 选中候选 / 插入引用后的写入计划 */
export interface InsertPlan {
  /** 插入后的完整文本（调用方据此触发 onChange） */
  text: string;
  /** 插入后光标应落的位置 */
  caret: number;
}

/** `{{` 之后到光标之前的提示状态（null 表示当前不处于表达式内） */
export interface SuggestState {
  /** 替换起点：`{{` 之后第一个字符的下标 */
  replaceStart: number;
  /** `{{` 之后到光标的原始查询（可能带空白，过滤前由 buildSuggestOptions trim） */
  query: string;
}

/** 表达式起始序列 */
const OPEN_SEQUENCE = "{{";

/**
 * 构造第一级候选：入参顶层字段（裸路径）+ 引用根（node.；var. / env. 按清单可选）。
 *
 * 入参字段清单提供时，第一级直接列出 `headers.` / `body.` 这类入参顶层字段
 * （选中后浮层推进到该字段下的完整路径），不必先写 `input.` 前缀；清单缺失
 * 时保留 `input.` 根作为入口（此时无字段可取，用户继续手输路径）。
 *
 * 传入非空 variableNames 时追加 `var.` 根（引用运行期变量，插入后浮层推进到
 * 变量名列表）；传入非空 envKeys 时追加 `env.` 根（引用环境变量集，插入后
 * 浮层推进到环境键列表）。清单缺省或为空时不出现对应根——上下文没有该命名
 * 空间时不给出无处落地的候选。
 *
 * @param variableNames 可引用的变量名清单（可选；流程 / 项目 / 全局合并后的名字集合）
 * @param inputPaths 当前节点入参字段点分路径清单（可选；用于入参简写）
 * @param envKeys 当前激活环境集合的键名清单（可选；环境变量建议）
 */
export function buildRootOptions(
  variableNames?: ReadonlyArray<string>,
  inputPaths?: ReadonlyArray<string>,
  envKeys?: ReadonlyArray<string>,
): RefSuggestOption[] {
  const fieldRoots = buildInputFieldRoots(inputPaths ?? []);
  const roots: RefSuggestOption[] =
    fieldRoots.length > 0
      ? fieldRoots
      : [
          {
            insert: "input.",
            label: "input.",
            description: "引用聚合入参 input",
            leaf: true,
            searchText: "input.",
          },
        ];
  roots.push({
    insert: "node.",
    label: "node.",
    description: "引用上游节点输出",
    leaf: false,
    searchText: "node.",
  });
  if (variableNames !== undefined && variableNames.length > 0) {
    roots.push({
      insert: "var.",
      label: "var.",
      description: "引用流程 / 项目 / 全局变量",
      leaf: false,
      searchText: "var.",
    });
  }
  if (envKeys !== undefined && envKeys.length > 0) {
    roots.push({
      insert: "env.",
      label: "env.",
      description: "引用激活环境的环境变量",
      leaf: false,
      searchText: "env.",
    });
  }
  return roots;
}

/**
 * 入参顶层字段候选（`headers.` / `body.` …）：由字段路径清单的第一段归并而来。
 *
 * 只有该字段存在更深路径时插入片段才带尾点（可继续下钻）；顶层就是叶子值
 * （如 `status`）时插入完整路径并关闭浮层。
 *
 * @param inputPaths 入参字段点分路径清单
 */
export function buildInputFieldRoots(inputPaths: ReadonlyArray<string>): RefSuggestOption[] {
  const hasChildren = new Map<string, boolean>();
  for (const path of inputPaths) {
    const dot = path.indexOf(".");
    const name = dot === -1 ? path : path.slice(0, dot);
    if (name === "") continue;
    hasChildren.set(name, (hasChildren.get(name) ?? false) || dot !== -1);
  }
  return [...hasChildren].map(([name, deeper]) => ({
    insert: deeper ? `${name}.` : name,
    label: deeper ? `${name}.` : name,
    description: "当前节点入参字段",
    leaf: !deeper,
    searchText: name.toLowerCase(),
  }));
}

/**
 * 入参路径候选（裸路径简写）：按已输入的路径前缀过滤字段清单。
 *
 * 与 `input.` 分支的差别：插入片段不带根前缀（与用户已输入的裸路径一致），
 * 过滤按前缀匹配（`body.user` 只推荐以它开头的路径，而不是任意包含它的路径），
 * 更贴近逐段输入的手感。
 *
 * @param inputPaths 入参字段点分路径清单
 * @param typed 用户已输入的裸路径片段（`{{` 之后到光标，已 trim）
 */
export function buildBareInputPathOptions(
  inputPaths: ReadonlyArray<string>,
  typed: string,
): RefSuggestOption[] {
  const keyword = typed.toLowerCase();
  return inputPaths
    .filter((path) => path.toLowerCase().startsWith(keyword))
    .map((path) => ({
      insert: path,
      label: path,
      description: "当前节点入参字段",
      leaf: true,
      searchText: path.toLowerCase(),
    }));
}

/**
 * 构造入参字段候选：`{{ input.` / `{{ $json.` 之后的路径列表。
 *
 * 路径来自调用方提供的清单（通常由最近一次运行的节点入参 JSON 派生，见
 * collectJsonPaths）。插入片段为完整 `input.<path>` / `$json.<path>`（叶子
 * 语义——插入后关闭浮层）。`$json` 是 `input` 的别名写法，候选对两种写法
 * 各自回填其前缀，与 flow-engine 模板解析一视同仁的口径一致。
 *
 * @param inputPaths 入参字段点分路径清单（如 ['body.token', 'user.0.id']）
 * @param prefix 使用的前缀（'input.' 或 '$json.'；与用户当前输入的根一致）
 */
export function buildInputPathOptions(
  inputPaths: ReadonlyArray<string>,
  prefix: "input." | "$json." = "input.",
): RefSuggestOption[] {
  return inputPaths.map((path) => ({
    insert: `${prefix}${path}`,
    label: path,
    description: "入参字段",
    leaf: true,
    searchText: path.toLowerCase(),
  }));
}

/**
 * 构造变量名候选：`{{ var.` 之后的第二级候选。
 *
 * 变量值为字符串（运行期变量约定），插入片段为完整 `var.<name>`（不带尾点、
 * 叶子语义——插入后关闭浮层；若变量值恰好是 JSON 结构需要更深路径，用户继续
 * 手输即可，渲染层 resolvePath 支持对象 / 数组下钻）。
 */
export function buildVariableOptions(variableNames: ReadonlyArray<string>): RefSuggestOption[] {
  return variableNames.map((name) => ({
    insert: `var.${name}`,
    label: name,
    description: "变量",
    leaf: true,
    searchText: name.toLowerCase(),
  }));
}

/**
 * 构造环境键候选：`{{ env.` 之后的第二级候选（环境变量集命名空间）。
 *
 * 与变量候选同形：环境值为字符串键值快照，插入片段为完整 `env.<key>`
 *（叶子语义）；键值恰为 JSON 结构需要下钻时用户继续手输，渲染层支持。
 */
export function buildEnvOptions(envKeys: ReadonlyArray<string>): RefSuggestOption[] {
  return envKeys.map((key) => ({
    insert: `env.${key}`,
    label: key,
    description: "环境变量",
    leaf: true,
    searchText: key.toLowerCase(),
  }));
}

/**
 * 构造第二级候选：上游节点 id 列表（label 作次要说明）。
 *
 * 插入片段为 `node.<id>.`，以点号收尾方便用户直接续写 output 路径。
 */
export function buildNodeOptions(nodes: ReadonlyArray<SuggestNodeOption>): RefSuggestOption[] {
  return nodes.map((node) => ({
    insert: `node.${node.id}.`,
    label: node.id,
    description: node.label,
    leaf: true,
    searchText: `${node.id}\n${node.label}`.toLowerCase(),
  }));
}

/**
 * 构造节点深路径候选：`{{ node.<id>.` 之后的路径段选项。
 *
 * 与入参路径候选（buildInputPathOptions）同机制：插入片段为完整
 * `node.<id>.<path>`（叶子语义——插入后关闭浮层，用户补 `}}` 即完成引用）。
 *
 * 过滤口径：按段前缀匹配（大小写不敏感）——已输入片段按 `.` 切分后，每段
 * 依次与候选路径的同位段做前缀比较（`json.d` → `json.data.token`）；整段
 * 输入从路径首位逐字输入（`status`）是本规则的特例。
 *
 * @param sample 节点深路径样本（id + collectJsonPaths 派生的路径清单 + 来源）
 * @param typed 用户已输入的路径片段（`node.<id>.` 之后到光标，已 trim）
 */
export function buildNodePathOptions(
  sample: SuggestNodePathSample,
  typed: string,
): RefSuggestOption[] {
  const description =
    sample.source === "capture" ? "该节点引用快照的响应体字段" : "该节点最近运行的输出字段";
  const typedSegments = typed === "" ? [] : typed.toLowerCase().split(".");
  return sample.paths
    .filter((path) => matchesPathSegments(path, typedSegments))
    .map((path) => ({
      insert: `node.${sample.id}.${path}`,
      label: path,
      description,
      leaf: true,
      searchText: path.toLowerCase(),
    }));
}

/**
 * 路径段前缀匹配：typedSegments 逐段与路径同位段做前缀比较（大小写不敏感，
 * 调用方须先把输入片段转小写再切分）。
 *
 * 既有消费者：buildNodePathOptions 的深路径候选过滤；后续 IO 面板的字段搜索
 * 复用同一口径（`json.d` → `json.data.token`），保证「提示浮层能补全的」与
 * 「IO 面板里能搜到的」语义一致。
 *
 * @param path 完整点分路径
 * @param typedSegments 已输入片段按 `.` 切分的段（空数组 = 全部匹配；
 *   尾随空段（查询以点收尾）表示「该段之后还有内容」，无该层的路径不匹配）
 */
export function matchesPathSegments(path: string, typedSegments: ReadonlyArray<string>): boolean {
  if (typedSegments.length === 0) return true;
  const pathSegments = path.toLowerCase().split(".");
  if (typedSegments.length > pathSegments.length) return false;
  return typedSegments.every((segment, index) => pathSegments[index]!.startsWith(segment));
}

/**
 * 按查询串过滤候选：大小写不敏感的子串匹配（匹配 id 与 label）。
 *
 * @param options 待过滤候选
 * @param query 用户已输入的查询（首尾空白忽略；空查询返回全部候选的浅拷贝）
 */
export function filterRefs(
  options: ReadonlyArray<RefSuggestOption>,
  query: string,
): RefSuggestOption[] {
  const keyword = query.trim().toLowerCase();
  if (keyword === "") return [...options];
  return options.filter((option) => option.searchText.includes(keyword));
}

/**
 * 依据 `{{` 之后的查询串给出当前层级的候选。
 *
 * 层级判定：
 *   - 查询以 `node.` 开头 → 第二级（节点 id 列表），按其后片段过滤；
 *     节点 id 之后已出现点号（用户在写路径）时——提供了该节点的深路径样本
 *     则给出路径候选（按已输入片段前缀过滤），并把节点 id 候选改为可下钻
 *     （插入 `node.<id>.` 后浮层推进到路径级）；未提供样本 / 该节点无候选时
 *     返回空（用户继续手输）；
 *   - 查询以 `input.` / `$json.` 开头 → 入参字段路径候选（inputPaths 提供时；
 *     清单缺省 / 为空时返回空——用户继续手输即可）；
 *   - 查询以 `var.` 开头 → 第二级（变量名列表），按其后片段过滤；若变量名
 *     之后已出现点号，返回空（变量值通常为字符串，组件不给路径建议；需要
 *     下钻 JSON 值时用户继续手输，渲染层支持）；变量清单缺省 / 为空时第二级
 *     同样返回空（无候选则浮层不弹）；
 *   - 查询以 `env.` 开头 → 第二级（环境键列表），判定与 var 分支完全同形；
 *   - 查询含点号且不在上述保留根内（入参简写）→ 入参路径候选：按已输入的
 *     裸路径前缀匹配字段清单（`headers.x` → `headers.x-token`）；清单没有
 *     匹配时返回空；
 *   - 其余（含空查询）→ 第一级（入参顶层字段 + 引用根；variableNames /
 *     envKeys 提供时根候选含 `var.` / `env.`，见 buildRootOptions）。
 *
 * @param query 用户已输入的查询串（`{{` 之后到光标）
 * @param nodes 上游可引用节点清单
 * @param variableNames 可引用变量名清单（可选）
 * @param inputPaths 入参字段点分路径清单（可选）
 * @param nodePathSamples 节点深路径样本清单（可选；深路径补全——按节点样本
 *   数据预派生，见 SuggestNodePathSample）
 * @param envKeys 当前激活环境集合的键名清单（可选；环境变量建议）
 */
export function buildSuggestOptions(
  query: string,
  nodes: ReadonlyArray<SuggestNodeOption>,
  variableNames?: ReadonlyArray<string>,
  inputPaths?: ReadonlyArray<string>,
  nodePathSamples?: ReadonlyArray<SuggestNodePathSample>,
  envKeys?: ReadonlyArray<string>,
): RefSuggestOption[] {
  const trimmed = query.trim();
  if (trimmed.startsWith("node.")) {
    const rest = trimmed.slice("node.".length);
    if (!rest.includes(".")) {
      const options = filterRefs(buildNodeOptions(nodes), rest);
      // 有深路径样本的节点从「叶子」改为「可下钻」——插入 node.<id>. 后浮层
      // 推进到路径候选级（未传样本时保持既有 leaf 语义，既有测试锁定）
      if (nodePathSamples === undefined || nodePathSamples.length === 0) return options;
      return options.map((option) => {
        const nodeId = option.insert.slice("node.".length, -1);
        const sample = nodePathSamples.find((item) => item.id === nodeId);
        return sample !== undefined && sample.paths.length > 0
          ? { ...option, leaf: false }
          : option;
      });
    }
    // node.<id>. 之后的路径段：该节点有深路径样本时按已输入片段前缀过滤
    const dotIndex = rest.indexOf(".");
    const nodeId = rest.slice(0, dotIndex);
    const typed = rest.slice(dotIndex + 1);
    const sample = nodePathSamples?.find((item) => item.id === nodeId);
    if (sample === undefined || sample.paths.length === 0) return [];
    return buildNodePathOptions(sample, typed);
  }
  if (trimmed.startsWith("input.") || trimmed.startsWith("$json.")) {
    if (inputPaths === undefined || inputPaths.length === 0) return [];
    const prefix = trimmed.startsWith("$json.") ? "$json." : "input.";
    const rest = trimmed.slice(prefix.length);
    return filterRefs(buildInputPathOptions(inputPaths, prefix), rest);
  }
  if (trimmed.startsWith("var.")) {
    const rest = trimmed.slice("var.".length);
    if (rest.includes(".")) return [];
    if (variableNames === undefined || variableNames.length === 0) return [];
    return filterRefs(buildVariableOptions(variableNames), rest);
  }
  if (trimmed.startsWith("env.")) {
    // 环境键候选：判定与 var 分支同形（键之后出现点号 → 用户手输路径）
    const rest = trimmed.slice("env.".length);
    if (rest.includes(".")) return [];
    if (envKeys === undefined || envKeys.length === 0) return [];
    return filterRefs(buildEnvOptions(envKeys), rest);
  }
  // 入参简写：已进入路径段（含点号）时只给字段路径候选，不再回落到根候选
  if (trimmed.includes(".")) {
    if (inputPaths === undefined || inputPaths.length === 0) return [];
    return buildBareInputPathOptions(inputPaths, trimmed);
  }
  return filterRefs(buildRootOptions(variableNames, inputPaths, envKeys), trimmed);
}

/**
 * 判定光标前文本是否处于未闭合的 `{{` 表达式内（决定浮层是否弹出）。
 *
 * 规则：取光标之前文本中最后一个 `{{`；若其与光标之间已出现 `}}`，
 * 视为表达式已闭合，返回 null；否则返回替换起点与原始查询。
 * 多表达式场景（如 `{{a}} {{b`）天然成立——最后一个 `{{` 即当前表达式。
 *
 * @param textBeforeCaret 光标之前的文本（不含光标后内容）
 */
export function detectSuggestState(textBeforeCaret: string): SuggestState | null {
  const open = textBeforeCaret.lastIndexOf(OPEN_SEQUENCE);
  if (open === -1) return null;
  const query = textBeforeCaret.slice(open + OPEN_SEQUENCE.length);
  if (query.includes("}}")) return null;
  return { replaceStart: open + OPEN_SEQUENCE.length, query };
}

/**
 * 计算选中候选后的写入计划：用补全片段替换 `{{` 之后到光标的内容。
 *
 * @param text 当前完整文本
 * @param caret 当前光标位置
 * @param replaceStart 替换起点（来自 detectSuggestState）
 * @param insert 候选的补全片段
 */
export function applySuggestInsert(
  text: string,
  caret: number,
  replaceStart: number,
  insert: string,
): InsertPlan {
  return {
    text: text.slice(0, replaceStart) + insert + text.slice(caret),
    caret: replaceStart + insert.length,
  };
}

/**
 * 「插入引用」兜底按钮的写入计划：在光标处插入空模板 `{{ }}`，
 * 光标落在花括号之间（触发提示浮层弹出根候选）。
 *
 * @param text 当前完整文本
 * @param caret 当前光标位置（控件未聚焦等取不到时由调用方回退为文本长度）
 */
export function buildInsertTemplatePlan(text: string, caret: number): InsertPlan {
  const snippet = "{{ }}";
  return {
    text: text.slice(0, caret) + snippet + text.slice(caret),
    caret: caret + "{{ ".length,
  };
}

/**
 * 拖放插入的写入计划：在指定位置插入完整片段，光标落在片段末尾。
 *
 * 与 buildInsertTemplatePlan 同族但语义不同：drop 载荷是完整引用文本
 * （`{{ ... }}`），不做提示替换；插入文本自带 `}}` 闭合，调用方照常以
 * detectSuggestState 重算提示状态时自然得到 null（不弹浮层），保持插入
 * 路径单一出口。
 *
 * @param text 当前完整文本
 * @param caret 插入位置（控件聚焦取光标处，未聚焦取文末——由调用方决定）
 * @param snippet 待插入的完整片段（如 `{{ node.n1.status }}`）
 */
export function buildDropInsertPlan(text: string, caret: number, snippet: string): InsertPlan {
  return {
    text: text.slice(0, caret) + snippet + text.slice(caret),
    caret: caret + snippet.length,
  };
}
