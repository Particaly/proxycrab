import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  LOOP_HARD_MAX_ITERATIONS,
  LOOP_MAX_CONCURRENCY,
} from "../../../../flow-engine/src/logic-nodes";
import {
  buildLoopShard,
  loopItemsText,
  parseLoopConcurrency,
  parseLoopCsvDelimiter,
  parseLoopIntervalMs,
  parseLoopItemsText,
  parseLoopMaxIterations,
  validateLoopDraft,
  type LoopConfigShard,
} from "./loop-config";

describe("迭代上限（parseLoopMaxIterations）", () => {
  it("留空取引擎缺省 100（恒落键）；合法整数放行", () => {
    expect(parseLoopMaxIterations("")).toEqual({ value: DEFAULT_LOOP_MAX_ITERATIONS });
    expect(parseLoopMaxIterations("  50 ")).toEqual({ value: 50 });
    expect(parseLoopMaxIterations("0")).toEqual({ value: 0 });
    expect(parseLoopMaxIterations(String(LOOP_HARD_MAX_ITERATIONS)).value).toBe(
      LOOP_HARD_MAX_ITERATIONS,
    );
  });

  it("非整数与超硬上限报错", () => {
    expect(parseLoopMaxIterations("1.5")?.error).toBeTruthy();
    expect(parseLoopMaxIterations("-1")?.error).toBeTruthy();
    expect(parseLoopMaxIterations("abc")?.error).toBeTruthy();
    expect(parseLoopMaxIterations(String(LOOP_HARD_MAX_ITERATIONS + 1))?.error).toContain("1000");
  });
});

describe("并发数（parseLoopConcurrency）", () => {
  it("留空 = 1（不落键）；1~16 放行", () => {
    expect(parseLoopConcurrency("")).toEqual({ value: 1 });
    expect(parseLoopConcurrency("1")).toEqual({ value: 1 });
    expect(parseLoopConcurrency(String(LOOP_MAX_CONCURRENCY)).value).toBe(LOOP_MAX_CONCURRENCY);
  });

  it("越界与非法报错（文案含上限 16）", () => {
    expect(parseLoopConcurrency("0")?.error).toContain("1~16");
    expect(parseLoopConcurrency(String(LOOP_MAX_CONCURRENCY + 1))?.error).toContain("1~16");
    expect(parseLoopConcurrency("2.5")?.error).toBeTruthy();
    expect(parseLoopConcurrency("x")?.error).toBeTruthy();
  });
});

describe("迭代间隔（parseLoopIntervalMs）", () => {
  it("留空 = 0（不落键）；0~60000 放行", () => {
    expect(parseLoopIntervalMs("")).toEqual({ value: 0 });
    expect(parseLoopIntervalMs("0")).toEqual({ value: 0 });
    expect(parseLoopIntervalMs("60000")).toEqual({ value: 60000 });
  });

  it("越界与非法报错", () => {
    expect(parseLoopIntervalMs("60001")?.error).toBeTruthy();
    expect(parseLoopIntervalMs("-5")?.error).toBeTruthy();
    expect(parseLoopIntervalMs("abc")?.error).toBeTruthy();
  });
});

describe("数据源（parseLoopItemsText）", () => {
  it("留空不落键；纯字面量即时校验 JSON 数组；含 {{ 模板留待运行期", () => {
    expect(parseLoopItemsText("")).toEqual({});
    expect(parseLoopItemsText(' ["a","b"] ')).toEqual({ value: '["a","b"]' });
    expect(parseLoopItemsText("{{ node.n1.json.ids }}")).toEqual({
      value: "{{ node.n1.json.ids }}",
    });
  });

  it("非数组 JSON 与非法 JSON 报错", () => {
    expect(parseLoopItemsText('{"a":1}')?.error).toContain("JSON 数组");
    expect(parseLoopItemsText('"text"')?.error).toContain("JSON 数组");
    expect(parseLoopItemsText("{bad json}")?.error).toContain("不是合法 JSON");
  });
});

describe("CSV 分隔符（parseLoopCsvDelimiter）", () => {
  it("合法值放行；非法值回退逗号（与 Rust 读入口径一致）", () => {
    expect(parseLoopCsvDelimiter(",")).toBe(",");
    expect(parseLoopCsvDelimiter(";")).toBe(";");
    expect(parseLoopCsvDelimiter("\t")).toBe("\t");
    expect(parseLoopCsvDelimiter("x")).toBe(",");
    expect(parseLoopCsvDelimiter(undefined)).toBe(",");
  });
});

describe("整体校验（validateLoopDraft）", () => {
  it("全合法返回 null；逐字段返回首条错误", () => {
    expect(
      validateLoopDraft({
        itemsText: '["a"]',
        maxIterationsText: "100",
        concurrencyText: "4",
        intervalText: "200",
      }),
    ).toBeNull();
    expect(
      validateLoopDraft({
        itemsText: "not json",
        maxIterationsText: "abc",
        concurrencyText: "0",
        intervalText: "99999",
      }),
    ).toContain("不是合法 JSON");
    expect(
      validateLoopDraft({
        itemsText: "",
        maxIterationsText: "abc",
        concurrencyText: "0",
        intervalText: "99999",
      }),
    ).toContain("迭代上限");
  });
});

describe("落库分片（buildLoopShard 缺省不落键惯例）", () => {
  it("缺省表单只落 maxIterations=100；并发/间隔在缺省值（1/0）时不落键", () => {
    const shard = buildLoopShard({
      itemsText: "",
      maxIterationsText: "",
      csvText: "",
      csvDelimiter: ",",
      concurrencyText: "",
      intervalText: "",
    });
    expect(shard).toEqual({ maxIterations: DEFAULT_LOOP_MAX_ITERATIONS });
  });

  it("全量草稿按惯例落键：items 原文、并发 > 1、间隔 > 0、CSV 非逗号分隔符", () => {
    const shard = buildLoopShard({
      itemsText: ' ["a","b"] ',
      maxIterationsText: "50",
      csvText: " id,name ",
      csvDelimiter: ";",
      concurrencyText: "4",
      intervalText: "200",
    });
    expect(shard).toEqual({
      items: '["a","b"]',
      maxIterations: 50,
      csvText: "id,name",
      csvDelimiter: ";",
      concurrency: 4,
      intervalMs: 200,
    });
  });

  it("并发 1 / 间隔 0 / 逗号分隔符 / 空 CSV 不落键；非法输入对应键不落（保存由校验门控）", () => {
    const shard = buildLoopShard({
      itemsText: "",
      maxIterationsText: "10",
      csvText: "  ",
      csvDelimiter: ",",
      concurrencyText: "1",
      intervalText: "0",
    });
    expect(shard).toEqual({ maxIterations: 10 });
    const broken = buildLoopShard({
      itemsText: "{bad",
      maxIterationsText: "-3",
      csvText: "",
      csvDelimiter: "\t",
      concurrencyText: "99",
      intervalText: "-1",
    });
    expect(broken).toEqual({ csvDelimiter: "\t" });
  });
});

describe("回填（loopItemsText）", () => {
  it("模板字符串原样；数组字面量还原为两空格缩进 JSON；脏数据为空串", () => {
    expect(loopItemsText({ items: "{{ var.rows }}" })).toBe("{{ var.rows }}");
    expect(loopItemsText({ items: [1, 2] })).toBe("[\n  1,\n  2\n]");
    expect(loopItemsText({ items: 42 })).toBe("");
    expect(loopItemsText({})).toBe("");
  });

  it("分片类型兼容 config 形状（循环表单只消费六键）", () => {
    const shard: LoopConfigShard = buildLoopShard({
      itemsText: "",
      maxIterationsText: "",
      csvText: "",
      csvDelimiter: ",",
      concurrencyText: "",
      intervalText: "",
    });
    expect(Object.keys(shard)).toEqual(["maxIterations"]);
  });
});
