import { describe, expect, it } from "vitest";
import {
  applySuggestInsert,
  buildDropInsertPlan,
  buildEnvOptions,
  buildFakeOptions,
  buildInsertTemplatePlan,
  buildNodeOptions,
  buildNodePathOptions,
  buildRootOptions,
  buildSuggestOptions,
  buildVariableOptions,
  detectSuggestState,
  filterRefs,
  type RefSuggestOption,
  type SuggestNodePathSample,
} from "./expression-suggest";

/**
 * 表达式提示纯逻辑测试（vitest node 环境；Task 15 薄片 A）。
 *
 * 自归档同名测试 @ 485fa00 合并移植（原 expression-suggest / .nodepaths / .var
 * 三个文件合一，覆盖不缩减），另补 env 命名空间分支：两级候选构造（根 / 节点
 * id）、深路径段候选、var / env 候选、filterRefs 过滤、buildSuggestOptions 层级
 * 判定、detectSuggestState 光标状态、补全插入与「插入引用」兜底的写入计划。
 */

/** 测试用上游节点清单：id 之外带中文 label，验证 label 也能参与过滤 */
const NODES = [
  { id: "n1", label: "登录" },
  { id: "n2", label: "下单" },
];

/** 测试用深路径样本：n2 来自运行 output，n1 来自捕获响应体（n9 无样本对照） */
const SAMPLES: SuggestNodePathSample[] = [
  { id: "n2", paths: ["status", "body", "json.data.token", "json.data.user"], source: "run" },
  { id: "n1", paths: ["headers"], source: "capture" },
];

/** 测试用变量名 / 环境键清单 */
const VARS = ["Token", "host", "env"];
const ENV_KEYS = ["BASE_URL", "apiToken"];
/** 测试用假数据生成器名清单（真实用法传 FAKE_GENERATOR_NAMES 常量，此处取子集） */
const FAKE_NAMES = ["phone", "name", "email"];

/** 取候选的 insert 片段序列，便于断言过滤结果 */
const insertsOf = (options: ReadonlyArray<RefSuggestOption>) =>
  options.map((option) => option.insert);

describe("buildRootOptions / buildNodeOptions", () => {
  it("根候选：无入参清单时以 input. 入口兜底，node. 可继续下钻", () => {
    const roots = buildRootOptions();
    expect(insertsOf(roots)).toEqual(["input.", "node."]);
    expect(roots.map((option) => option.leaf)).toEqual([true, false]);
  });

  it("根候选：有入参字段清单时第一级直接列出入参顶层字段（裸路径简写）", () => {
    const roots = buildRootOptions(undefined, ["headers", "headers.x-token", "body.id"]);
    expect(insertsOf(roots)).toEqual(["headers.", "body.", "node."]);
    // 有更深路径的字段可继续下钻；顶层即叶子的字段插入后关闭浮层
    expect(roots.map((option) => option.leaf)).toEqual([false, false, false]);
  });

  it("根候选：提供变量名 / 环境键清单时追加 var. / env. 根（排在 node. 之后）", () => {
    expect(insertsOf(buildRootOptions(VARS))).toEqual(["input.", "node.", "var."]);
    expect(insertsOf(buildRootOptions(undefined, undefined, ENV_KEYS))).toEqual([
      "input.",
      "node.",
      "env.",
    ]);
    expect(insertsOf(buildRootOptions(VARS, undefined, ENV_KEYS))).toEqual([
      "input.",
      "node.",
      "var.",
      "env.",
    ]);
    // 清单缺省 / 空数组 → 不出现对应根（上下文没有该命名空间不给无处落地的候选）
    expect(insertsOf(buildRootOptions([]))).toEqual(["input.", "node."]);
    expect(insertsOf(buildRootOptions(undefined, undefined, []))).toEqual(["input.", "node."]);
  });

  it("节点候选：插入 node.<id>. 片段，id 与 label 均参与搜索文本", () => {
    const options = buildNodeOptions(NODES);
    expect(options.map((option) => option.insert)).toEqual(["node.n1.", "node.n2."]);
    expect(options[0]).toMatchObject({ label: "n1", description: "登录", leaf: true });
    expect(options[1].searchText).toContain("下单");
  });
});

describe("buildVariableOptions / buildEnvOptions", () => {
  it("变量名映射为 var.<name> 叶子候选（insert 不带尾点）", () => {
    expect(buildVariableOptions(["token", "host"])).toEqual([
      { insert: "var.token", label: "token", description: "变量", leaf: true, searchText: "token" },
      { insert: "var.host", label: "host", description: "变量", leaf: true, searchText: "host" },
    ]);
    expect(buildVariableOptions([])).toEqual([]);
  });

  it("环境键映射为 env.<key> 叶子候选（与变量候选同形）", () => {
    expect(buildEnvOptions(["BASE_URL"])).toEqual([
      {
        insert: "env.BASE_URL",
        label: "BASE_URL",
        description: "环境变量",
        leaf: true,
        searchText: "base_url",
      },
    ]);
    expect(buildEnvOptions([])).toEqual([]);
  });
});

describe("filterRefs", () => {
  const options = [...buildRootOptions(), ...buildNodeOptions(NODES)];

  it("空查询（含纯空白）返回全部候选", () => {
    expect(filterRefs(options, "")).toHaveLength(options.length);
    expect(filterRefs(options, "   ")).toHaveLength(options.length);
  });

  it("子串匹配大小写不敏感（覆盖 id 与 label）", () => {
    expect(insertsOf(filterRefs(options, "NODE"))).toEqual(["node."]);
    expect(insertsOf(filterRefs(options, "n2"))).toEqual(["node.n2."]);
    // 中文 label 直接子串匹配
    expect(insertsOf(filterRefs(options, "下单"))).toEqual(["node.n2."]);
  });

  it("无匹配返回空数组", () => {
    expect(filterRefs(options, "zzz")).toEqual([]);
  });
});

describe("buildSuggestOptions", () => {
  it("空查询 → 第一级：入参入口 + node.", () => {
    expect(insertsOf(buildSuggestOptions("", NODES))).toEqual(["input.", "node."]);
  });

  it("非 node. 前缀的查询 → 第一级按查询过滤", () => {
    expect(insertsOf(buildSuggestOptions("in", NODES))).toEqual(["input."]);
  });

  it("node. 前缀 → 第二级：上游节点 id 列表", () => {
    expect(insertsOf(buildSuggestOptions("node.", NODES))).toEqual(["node.n1.", "node.n2."]);
  });

  it("node. 前缀 + 片段 → 第二级按片段过滤（id / label）", () => {
    expect(insertsOf(buildSuggestOptions("node.N2", NODES))).toEqual(["node.n2."]);
    expect(insertsOf(buildSuggestOptions("node.登录", NODES))).toEqual(["node.n1."]);
  });

  it("节点 id 之后已进入路径段（出现第二个点）→ 未提供样本时不再给建议", () => {
    expect(buildSuggestOptions("node.n2.output", NODES)).toEqual([]);
    expect(buildSuggestOptions("node.n2.", NODES)).toEqual([]);
  });
});

describe("buildSuggestOptions：深路径分支", () => {
  /** 深路径分支用节点清单（n9 无样本：既有叶子语义对照） */
  const NODES_WITH_ORPHAN = [...NODES, { id: "n9", label: "孤立" }];

  it("node.<id>. 之后给出该节点的路径候选", () => {
    expect(
      insertsOf(buildSuggestOptions("node.n2.", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES)),
    ).toEqual([
      "node.n2.status",
      "node.n2.body",
      "node.n2.json.data.token",
      "node.n2.json.data.user",
    ]);
  });

  it("路径段已输入片段：按段前缀过滤候选（大小写不敏感 / 跨段部分输入均命中）", () => {
    expect(insertsOf(buildNodePathOptions(SAMPLES[0]!, "json."))).toEqual([
      "node.n2.json.data.token",
      "node.n2.json.data.user",
    ]);
    expect(
      insertsOf(
        buildSuggestOptions("node.n2.json.d", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES),
      ),
    ).toEqual(["node.n2.json.data.token", "node.n2.json.data.user"]);
    expect(
      insertsOf(
        buildSuggestOptions("node.n2.JSON.D", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES),
      ),
    ).toEqual(["node.n2.json.data.token", "node.n2.json.data.user"]);
    expect(
      insertsOf(
        buildSuggestOptions("node.n2.stat", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES),
      ),
    ).toEqual(["node.n2.status"]);
  });

  it("节点无样本 / 样本为空路径：路径段返回空（与既有行为一致）", () => {
    expect(
      buildSuggestOptions("node.n9.", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES),
    ).toEqual([]);
    const empty: SuggestNodePathSample[] = [{ id: "n2", paths: [], source: "run" }];
    expect(buildSuggestOptions("node.n2.", NODES_WITH_ORPHAN, undefined, undefined, empty)).toEqual(
      [],
    );
    // 完全未传样本：既有行为——路径段不给建议
    expect(buildSuggestOptions("node.n2.output", NODES)).toEqual([]);
  });

  it("节点 id 级候选：有样本的节点改为可下钻（leaf false），无样本的保持叶子", () => {
    const options = buildSuggestOptions("node.", NODES_WITH_ORPHAN, undefined, undefined, SAMPLES);
    expect(insertsOf(options)).toEqual(["node.n1.", "node.n2.", "node.n9."]);
    expect(options.map((option) => option.leaf)).toEqual([false, false, true]);
    // 未传样本：既有 leaf 语义不变
    expect(buildSuggestOptions("node.", NODES).every((option) => option.leaf)).toBe(true);
    // 样本空路径清单的节点不改为可下钻（推进后无候选会落空）
    const empty: SuggestNodePathSample[] = [{ id: "n2", paths: [], source: "run" }];
    expect(
      buildSuggestOptions("node.", NODES_WITH_ORPHAN, undefined, undefined, empty).map(
        (o) => o.leaf,
      ),
    ).toEqual([true, true, true]);
  });

  it("节点 id 级过滤后仍按 id / label 匹配（样本只影响 leaf，不影响过滤）", () => {
    const options = buildSuggestOptions(
      "node.下单",
      NODES_WITH_ORPHAN,
      undefined,
      undefined,
      SAMPLES,
    );
    expect(insertsOf(options)).toEqual(["node.n2."]);
    expect(options[0]!.leaf).toBe(false);
  });

  it("深路径候选的来源说明区分 run / capture", () => {
    expect(buildNodePathOptions(SAMPLES[0]!, "")[0]!.description).toBe("该节点最近运行的输出字段");
    expect(buildNodePathOptions(SAMPLES[1]!, "")[0]!.description).toBe(
      "该节点引用快照的响应体字段",
    );
  });
});

describe("buildSuggestOptions：var / env 层级判定", () => {
  it("空查询且提供清单 → 入参入口 + node. + var. / env.", () => {
    expect(insertsOf(buildSuggestOptions("", NODES, VARS))).toEqual(["input.", "node.", "var."]);
    expect(
      insertsOf(buildSuggestOptions("", NODES, undefined, undefined, undefined, ENV_KEYS)),
    ).toEqual(["input.", "node.", "env."]);
  });

  it("查询以 var. 开头 → 变量名候选（大小写不敏感过滤）", () => {
    expect(buildSuggestOptions("var.", NODES, VARS).map((o) => o.insert)).toEqual([
      "var.Token",
      "var.host",
      "var.env",
    ]);
    expect(buildSuggestOptions("var.tok", NODES, VARS).map((o) => o.insert)).toEqual(["var.Token"]);
    expect(buildSuggestOptions("var.HOST", NODES, VARS).map((o) => o.insert)).toEqual(["var.host"]);
  });

  it("查询以 env. 开头 → 环境键候选（判定与 var 分支同形）", () => {
    expect(
      buildSuggestOptions("env.", NODES, undefined, undefined, undefined, ENV_KEYS).map(
        (o) => o.insert,
      ),
    ).toEqual(["env.BASE_URL", "env.apiToken"]);
    expect(
      buildSuggestOptions("env.api", NODES, undefined, undefined, undefined, ENV_KEYS).map(
        (o) => o.insert,
      ),
    ).toEqual(["env.apiToken"]);
  });

  it("变量名 / 环境键之后出现点号 → 不再给建议（路径手输，渲染层支持下钻）", () => {
    expect(buildSuggestOptions("var.env.", NODES, VARS)).toEqual([]);
    expect(buildSuggestOptions("var.env.region", NODES, VARS)).toEqual([]);
    expect(
      buildSuggestOptions("env.BASE_URL.", NODES, undefined, undefined, undefined, ENV_KEYS),
    ).toEqual([]);
  });

  it("清单缺省 / 为空：var. / env. 查询返回空候选，其余查询与既有行为一致", () => {
    expect(buildSuggestOptions("var.", NODES)).toEqual([]);
    expect(buildSuggestOptions("var.", NODES, [])).toEqual([]);
    expect(buildSuggestOptions("env.", NODES)).toEqual([]);
    expect(buildSuggestOptions("env.", NODES, undefined, undefined, undefined, [])).toEqual([]);
    expect(insertsOf(buildSuggestOptions("", NODES))).toEqual(["input.", "node."]);
    expect(insertsOf(buildSuggestOptions("in", NODES))).toEqual(["input."]);
  });

  it("node 层级不受 variableNames / envKeys 影响", () => {
    expect(
      buildSuggestOptions("node.n2", NODES, VARS, undefined, undefined, ENV_KEYS).map(
        (o) => o.insert,
      ),
    ).toEqual(["node.n2."]);
  });

  it("filterRefs 对 var / env 候选照常过滤（共享同一过滤通道）", () => {
    expect(filterRefs(buildVariableOptions(VARS), "HOST").map((o) => o.insert)).toEqual([
      "var.host",
    ]);
    expect(filterRefs(buildEnvOptions(ENV_KEYS), "base").map((o) => o.insert)).toEqual([
      "env.BASE_URL",
    ]);
  });
});

describe("buildSuggestOptions：fake 层级判定", () => {
  it("空查询且传入 fakeNames → 根候选追加 fake.（排在 env. 之后）", () => {
    expect(
      insertsOf(
        buildSuggestOptions("", NODES, undefined, undefined, undefined, undefined, FAKE_NAMES),
      ),
    ).toEqual(["input.", "node.", "fake."]);
    expect(
      insertsOf(buildSuggestOptions("", NODES, VARS, undefined, undefined, ENV_KEYS, FAKE_NAMES)),
    ).toEqual(["input.", "node.", "var.", "env.", "fake."]);
  });

  it("查询以 fake. 开头 → 生成器候选（大小写不敏感过滤）", () => {
    expect(
      buildSuggestOptions(
        "fake.",
        NODES,
        undefined,
        undefined,
        undefined,
        undefined,
        FAKE_NAMES,
      ).map((o) => o.insert),
    ).toEqual(["fake.phone", "fake.name", "fake.email"]);
    expect(
      buildSuggestOptions(
        "fake.PH",
        NODES,
        undefined,
        undefined,
        undefined,
        undefined,
        FAKE_NAMES,
      ).map((o) => o.insert),
    ).toEqual(["fake.phone"]);
  });

  it("名称之后出现点号或括号 → 不再给建议（路径 / 参数手输）", () => {
    expect(
      buildSuggestOptions(
        "fake.phone.",
        NODES,
        undefined,
        undefined,
        undefined,
        undefined,
        FAKE_NAMES,
      ),
    ).toEqual([]);
    expect(
      buildSuggestOptions("fake.number(1,100)", NODES, undefined, undefined, undefined, undefined, [
        "phone",
        "number",
      ]),
    ).toEqual([]);
  });

  it("fakeNames 缺省 / 为空：fake. 查询返回空候选，根候选不含 fake.", () => {
    expect(buildSuggestOptions("fake.", NODES)).toEqual([]);
    expect(
      buildSuggestOptions("fake.", NODES, undefined, undefined, undefined, undefined, []),
    ).toEqual([]);
    expect(
      insertsOf(buildSuggestOptions("", NODES, undefined, undefined, undefined, undefined, [])),
    ).toEqual(["input.", "node."]);
  });

  it("buildFakeOptions：插入片段叶子语义，说明来自引擎元数据表", () => {
    const options = buildFakeOptions(FAKE_NAMES);
    expect(options.map((o) => o.insert)).toEqual(["fake.phone", "fake.name", "fake.email"]);
    for (const option of options) {
      expect(option.leaf).toBe(true);
      expect(option.description).not.toBe("");
    }
    // 说明文案取自 FAKE_GENERATORS 元数据（name 命中 → 中文描述而非兜底文案）
    expect(buildFakeOptions(["phone"])[0]?.description).toContain("手机号");
    expect(buildFakeOptions(["__missing__"])[0]?.description).toBe("内置假数据生成器");
  });
});

describe("buildSuggestOptions：入参字段路径候选", () => {
  const INPUT_PATHS = ["body", "body.token", "body.items", "params.page"];
  const withPaths = (query: string) => buildSuggestOptions(query, NODES, undefined, INPUT_PATHS);

  it("第一级 → 入参顶层字段（裸路径，替代 input. 前缀）", () => {
    expect(withPaths("").map((o) => o.insert)).toEqual(["body.", "params.", "node."]);
    expect(withPaths("").map((o) => o.leaf)).toEqual([false, false, false]);
  });

  it("裸路径已进入字段内部 → 按前缀给出完整路径候选", () => {
    expect(withPaths("body.").map((o) => o.insert)).toEqual(["body.token", "body.items"]);
    expect(withPaths("body.tok").map((o) => o.insert)).toEqual(["body.token"]);
  });

  it("input. / $json. 前缀（别名写法）按完整路径插入，保持向后兼容", () => {
    expect(withPaths("input.").map((o) => o.insert)).toEqual([
      "input.body",
      "input.body.token",
      "input.body.items",
      "input.params.page",
    ]);
    expect(withPaths("$json.").map((o) => o.insert)).toEqual([
      "$json.body",
      "$json.body.token",
      "$json.body.items",
      "$json.params.page",
    ]);
  });

  it("按已输入片段过滤（大小写不敏感）", () => {
    expect(withPaths("input.tok").map((o) => o.insert)).toEqual(["input.body.token"]);
    expect(withPaths("input.BODY").map((o) => o.insert)).toEqual([
      "input.body",
      "input.body.token",
      "input.body.items",
    ]);
  });

  it("清单缺省 / 为空：input. / $json. 查询返回空候选（用户继续手输路径）", () => {
    expect(buildSuggestOptions("input.", NODES)).toEqual([]);
    expect(buildSuggestOptions("$json.", NODES, undefined, [])).toEqual([]);
  });
});

describe("detectSuggestState", () => {
  it("光标前没有 {{ → 不提示", () => {
    expect(detectSuggestState("https://api.example.com")).toBeNull();
  });

  it("刚输入 {{ → 提示开启，替换起点在 {{ 之后", () => {
    expect(detectSuggestState("url={{")).toEqual({ replaceStart: 6, query: "" });
  });

  it("{{ 之后的内容作为原始查询（含空白原样返回）", () => {
    expect(detectSuggestState("{{ in")).toEqual({ replaceStart: 2, query: " in" });
    expect(detectSuggestState("{{ ")).toEqual({ replaceStart: 2, query: " " });
  });

  it("表达式已闭合（{{ 与光标间出现 }}）→ 不提示", () => {
    expect(detectSuggestState("{{ input.a }}")).toBeNull();
  });

  it("闭合表达式之后再次输入 {{ → 以最后一个 {{ 为准", () => {
    expect(detectSuggestState("{{a}} {{b")).toEqual({ replaceStart: 8, query: "b" });
  });

  it("光标位于闭合 }} 之前 → 仍处于表达式内", () => {
    expect(detectSuggestState("{{ input.a ")).toEqual({ replaceStart: 2, query: " input.a " });
  });
});

describe("applySuggestInsert", () => {
  it("替换 {{ 之后到光标的内容，光标落在片段之后", () => {
    // 场景：url={{in，光标在末尾（replaceStart=6），选中根候选 node.
    expect(applySuggestInsert("url={{in", 8, 6, "node.")).toEqual({
      text: "url={{node.",
      caret: 11,
    });
  });

  it("光标前已输入部分查询整体被替换", () => {
    expect(applySuggestInsert("{{ node.", 8, 3, "node.n2.")).toEqual({
      text: "{{ node.n2.",
      caret: 11,
    });
  });

  it("插入后不影响表达式之外的文本（含未闭合兜底字面量前的空格）", () => {
    expect(applySuggestInsert("a {{ b", 6, 4, "input.")).toEqual({ text: "a {{input.", caret: 10 });
  });
});

describe("buildInsertTemplatePlan / buildDropInsertPlan", () => {
  it("光标处插入 {{ }}，光标落在花括号之间", () => {
    expect(buildInsertTemplatePlan("url=", 4)).toEqual({ text: "url={{ }}", caret: 7 });
  });

  it("空文本 / 中段插入均正确", () => {
    expect(buildInsertTemplatePlan("", 0)).toEqual({ text: "{{ }}", caret: 3 });
    expect(buildInsertTemplatePlan("ab", 1)).toEqual({ text: "a{{ }}b", caret: 4 });
  });

  it("插入后紧接 detectSuggestState 应命中根候选状态", () => {
    const plan = buildInsertTemplatePlan("", 0);
    expect(detectSuggestState(plan.text.slice(0, plan.caret))).toEqual({
      replaceStart: 2,
      query: " ",
    });
  });

  it("拖放插入：完整片段原样写入，光标落在片段末尾", () => {
    expect(buildDropInsertPlan("url=", 4, "{{ node.n1.status }}")).toEqual({
      text: "url={{ node.n1.status }}",
      caret: 4 + "{{ node.n1.status }}".length,
    });
    // 插入自带 }} 闭合：重算提示状态自然为 null（不弹浮层）
    const plan = buildDropInsertPlan("", 0, "{{ var.token }}");
    expect(detectSuggestState(plan.text.slice(0, plan.caret))).toBeNull();
  });
});
