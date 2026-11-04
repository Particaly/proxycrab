import { describe, expect, it } from "vitest";
import { MAX_DELAY_DURATION_MS } from "../../../../flow-engine/src/logic-nodes";
import { buildDelayShard, parseDelayDuration, validateDelayDraft } from "./delay-config";

describe("parseDelayDuration", () => {
  it("留空 = 0（恒落键）；非负整数放行", () => {
    expect(parseDelayDuration("")).toEqual({ value: 0 });
    expect(parseDelayDuration("  1500 ")).toEqual({ value: 1500 });
    expect(parseDelayDuration("0")).toEqual({ value: 0 });
    expect(parseDelayDuration(String(MAX_DELAY_DURATION_MS)).value).toBe(MAX_DELAY_DURATION_MS);
  });

  it("非整数与超上限报错（文案含上限与拆分建议）", () => {
    expect(parseDelayDuration("1.5")?.error).toContain("非负整数");
    expect(parseDelayDuration("-1")?.error).toBeTruthy();
    expect(parseDelayDuration("abc")?.error).toBeTruthy();
    const over = parseDelayDuration(String(MAX_DELAY_DURATION_MS + 1));
    expect(over?.error).toContain("300000");
    expect(over?.error).toContain("拆分");
  });
});

describe("validateDelayDraft / buildDelayShard", () => {
  it("校验透传解析错误；合法草稿恒落 durationMs（留空 = 0）", () => {
    expect(validateDelayDraft("")).toBeNull();
    expect(validateDelayDraft("999999")).toContain("上限");
    expect(buildDelayShard("")).toEqual({ durationMs: 0 });
    expect(buildDelayShard(" 2500 ")).toEqual({ durationMs: 2500 });
  });

  it("非法输入不落键（保存由校验门控）；分片形状只含 durationMs", () => {
    expect(buildDelayShard("abc")).toEqual({});
    expect(Object.keys(buildDelayShard("100"))).toEqual(["durationMs"]);
  });
});
