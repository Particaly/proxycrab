import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "./types";
import { asNodeId } from "./types";
import {
  createAssertRunner,
  describeAssertionRule,
  evaluateAssertions,
  extractStatusValue,
  formatAssertionFailures,
  resolveAssertionRules,
} from "./assert-nodes";

/**
 * 断言节点单测（M10-T3）：extractStatusValue / evaluateAssertions 三类规则
 * 的通过与失败形态（期望 vs 实际文案）、formatAssertionFailures、runner 在
 * 执行器语义下的成功 / 失败与 output 透传。
 */

/** 构造断言节点（供 runner 测试） */
function makeAssertNode(assertions: unknown): WorkflowNode {
  return {
    id: asNodeId("a1"),
    type: "assert",
    position: { x: 0, y: 0 },
    config: { assertions: assertions as WorkflowNode["config"]["assertions"] },
  };
}

/** 典型响应输入（httpReplay 输出形状） */
const response = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: { token: "abc", items: [{ id: 1 }, { id: 2 }] },
  durationMs: 12,
};

describe("extractStatusValue（状态码提取）", () => {
  it("响应形状：取数字 status", () => {
    expect(extractStatusValue(response)).toBe(200);
    expect(extractStatusValue({ status: 404 })).toBe(404);
  });
  it("非对象 / 数组 / status 非数字 / 缺失 → undefined", () => {
    expect(extractStatusValue(null)).toBeUndefined();
    expect(extractStatusValue("text")).toBeUndefined();
    expect(extractStatusValue([1])).toBeUndefined();
    expect(extractStatusValue({ status: "200" })).toBeUndefined();
    expect(extractStatusValue({})).toBeUndefined();
    expect(extractStatusValue({ status: NaN })).toBeUndefined();
  });
});

describe("evaluateAssertions（规则列表求值）", () => {
  it("空规则 / 空数组 → 全部通过", () => {
    expect(evaluateAssertions([], response)).toEqual([]);
  });

  it("状态码：eq 精确通过；段比较通过 / 失败（期望 vs 实际）", () => {
    expect(evaluateAssertions([{ kind: "status", op: "eq", value: 200 }], response)).toEqual([]);
    expect(evaluateAssertions([{ kind: "status", op: "2xx" }], response)).toEqual([]);
    expect(evaluateAssertions([{ kind: "status", op: "5xx" }], response)).toEqual([
      {
        index: 1,
        label: "状态码 5xx",
        message: "期望落在 5xx（500~599），实际 200",
      },
    ]);
    expect(evaluateAssertions([{ kind: "status", op: "eq", value: 404 }], response)).toEqual([
      { index: 1, label: "状态码 = 404", message: "期望 404，实际 200" },
    ]);
  });

  it("状态码：入参无 status 字段 → 显式失败说明目标形状", () => {
    const failures = evaluateAssertions([{ kind: "status", op: "2xx" }], { body: "x" });
    expect(failures[0]?.message).toContain("不含数字 status 字段");
  });

  it("状态码：eq 缺 value → 配置非法", () => {
    const failures = evaluateAssertions([{ kind: "status", op: "eq" }], response);
    expect(failures[0]?.message).toContain("规则配置非法");
  });

  it("JSONPath：eq / ne / contains / regex / exists 通过与失败", () => {
    const rules = [
      { kind: "jsonPath", path: "$.body.token", op: "eq", value: "abc" },
      { kind: "jsonPath", path: "$.status", op: "ne", value: 500 },
      { kind: "jsonPath", path: "$.headers.content-type", op: "contains", value: "json" },
      { kind: "jsonPath", path: "$.body.token", op: "regex", value: "^[a-z]{3}$" },
      { kind: "jsonPath", path: "$.body.items[0].id", op: "exists" },
    ];
    expect(evaluateAssertions(rules, response)).toEqual([]);
  });

  it("JSONPath eq：零匹配显式失败（区别于 exists）；多匹配全过才过", () => {
    const failures = evaluateAssertions(
      [{ kind: "jsonPath", path: "$.body.missing", op: "eq", value: 1 }],
      response,
    );
    expect(failures[0]?.message).toContain("路径无匹配值");

    // 多匹配：$.body.items[*].id = [1, 2]
    expect(
      evaluateAssertions(
        [{ kind: "jsonPath", path: "$.body.items[*].id", op: "exists" }],
        response,
      ),
    ).toEqual([]);
    const partial = evaluateAssertions(
      [{ kind: "jsonPath", path: "$.body.items[*].id", op: "eq", value: 1 }],
      response,
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]?.message).toContain("期望 1，实际 2");
  });

  it('JSONPath：类型敏感相等（1 与 "1" 不等）与 contains 数组命中', () => {
    const failures = evaluateAssertions(
      [{ kind: "jsonPath", path: "$.body.items[0].id", op: "eq", value: "1" }],
      response,
    );
    expect(failures[0]?.message).toContain('期望 "1"，实际 1');
    expect(
      evaluateAssertions(
        [{ kind: "jsonPath", path: "$.body.items", op: "contains", value: { id: 2 } }],
        response,
      ),
    ).toEqual([]);
  });

  it("JSONPath：contains 对非字符串 / 非数组目标失败；regex 非字符串目标失败", () => {
    expect(
      evaluateAssertions(
        [{ kind: "jsonPath", path: "$.status", op: "contains", value: 20 }],
        response,
      )[0]?.message,
    ).toContain("只支持字符串或数组目标");
    expect(
      evaluateAssertions(
        [{ kind: "jsonPath", path: "$.status", op: "regex", value: "20" }],
        response,
      )[0]?.message,
    ).toContain("只支持字符串目标");
  });

  it("JSONPath：正则源非法 / path 语法非法 → 配置类失败（含原因）", () => {
    const badRegex = evaluateAssertions(
      [{ kind: "jsonPath", path: "$.body.token", op: "regex", value: "([a-z" }],
      response,
    );
    expect(badRegex[0]?.message).toContain("正则表达式非法");
    const badPath = evaluateAssertions(
      [{ kind: "jsonPath", path: "body.token", op: "exists" }],
      response,
    );
    expect(badPath[0]?.message).toContain("路径语法非法");
  });

  it("Schema：根值 / path 定位目标；校验失败错误聚合回显", () => {
    expect(
      evaluateAssertions(
        [{ kind: "schema", path: "$.body", schema: { type: "object", required: ["token"] } }],
        response,
      ),
    ).toEqual([]);
    const failures = evaluateAssertions(
      [{ kind: "schema", path: "$.body", schema: { type: "object", required: ["token", "user"] } }],
      response,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("Schema 校验未通过");
    expect(failures[0]?.message).toContain('"user"');
  });

  it("Schema：schema 形状非法 / 目标路径无匹配 → 配置类失败", () => {
    expect(
      evaluateAssertions([{ kind: "schema", schema: "object" }], response)[0]?.message,
    ).toContain("schema 需为对象");
    expect(
      evaluateAssertions(
        [{ kind: "schema", path: "$.missing", schema: { type: "object" } }],
        response,
      )[0]?.message,
    ).toContain("无匹配值");
  });

  it("多条失败一次收集（含规则序号）；未知 kind / 脏条目按规则失败处理", () => {
    const failures = evaluateAssertions(
      [
        { kind: "status", op: "eq", value: 500 },
        { kind: "jsonPath", path: "$.body.token", op: "eq", value: "wrong" },
        "not-an-object",
        { kind: "mystery" },
      ],
      response,
    );
    expect(failures.map((failure) => failure.index)).toEqual([1, 2, 3, 4]);
    expect(failures[2]?.message).toContain("规则配置非法");
    expect(failures[3]?.message).toContain("kind");
  });
});

describe("describeAssertionRule / formatAssertionFailures（错误信息形态）", () => {
  it("三类规则描述可读", () => {
    expect(describeAssertionRule({ kind: "status", op: "eq", value: 200 })).toBe("状态码 = 200");
    expect(describeAssertionRule({ kind: "status", op: "4xx" })).toBe("状态码 4xx");
    expect(describeAssertionRule({ kind: "jsonPath", path: "$.a", op: "eq", value: 1 })).toBe(
      "$.a 等于 1",
    );
    expect(describeAssertionRule({ kind: "jsonPath", path: "$.a", op: "exists" })).toBe("$.a 存在");
    expect(describeAssertionRule({ kind: "schema", path: "$.body", schema: {} })).toBe(
      "Schema 校验 $.body",
    );
    expect(describeAssertionRule({ kind: "schema", schema: {} })).toBe("Schema 校验 $");
  });

  it("格式化：单条与多条的标题形态", () => {
    const single = formatAssertionFailures([
      { index: 1, label: "状态码 = 500", message: "期望 500，实际 200" },
    ]);
    expect(single).toContain("断言失败");
    expect(single).toContain("第 1 条规则（状态码 = 500）：期望 500，实际 200");
    const multi = formatAssertionFailures([
      { index: 1, label: "a", message: "x" },
      { index: 2, label: "b", message: "y" },
    ]);
    expect(multi).toContain("共 2 条不通过");
    expect(multi.split("\n")).toHaveLength(3);
  });
});

describe("resolveAssertionRules / createAssertRunner（runner 语义）", () => {
  it("config 容错：缺省 / 非数组 → 空规则", () => {
    expect(resolveAssertionRules({})).toEqual([]);
    expect(resolveAssertionRules({ assertions: "x" as unknown as undefined })).toEqual([]);
  });

  it("runner：全部通过 → output 透传 input（响应传给下游）", async () => {
    const runner = createAssertRunner();
    const node = makeAssertNode([{ kind: "status", op: "2xx" }]);
    const output = await runner(node, response, {
      runId: "r1" as never,
      nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input: null } },
    });
    expect(output).toBe(response);
  });

  it("runner：未配置规则 → 纯透传（先拖节点后配置不失败）", async () => {
    const runner = createAssertRunner();
    const output = await runner(makeAssertNode(undefined), response, {
      runId: "r1" as never,
      nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input: null } },
    });
    expect(output).toBe(response);
  });

  it("runner：任一失败 → 抛错（错误信息含规则、期望 vs 实际）", async () => {
    const runner = createAssertRunner();
    const node = makeAssertNode([
      { kind: "status", op: "eq", value: 200 },
      { kind: "jsonPath", path: "$.body.token", op: "eq", value: "expect" },
    ]);
    await expect(
      runner(node, response, {
        runId: "r1" as never,
        nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input: null } },
      }),
    ).rejects.toThrowError(
      /第 2 条规则（\$\.body\.token 等于 "expect"）：期望 "expect"，实际 "abc"/,
    );
  });
});
