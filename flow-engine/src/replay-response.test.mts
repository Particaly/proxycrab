import { describe, expect, it } from "vitest";
import { detectResponseBody, readResponseHeader } from "./replay-response";

/**
 * 重放响应体自动类型判断测试（M12-T3）：JSON 解析 / 文本回退 / 空体，
 * 以及 content-type 与内容嗅探的判定分支。
 */

describe("readResponseHeader：大小写不敏感取值", () => {
  it("命中不同大小写的头名", () => {
    expect(readResponseHeader({ "Content-Type": "application/json" }, "content-type")).toBe(
      "application/json",
    );
    expect(readResponseHeader({ "content-type": "text/plain" }, "Content-Type")).toBe("text/plain");
  });

  it("缺失返回 undefined", () => {
    expect(readResponseHeader({}, "content-type")).toBeUndefined();
  });
});

describe("detectResponseBody：类型判断", () => {
  it("content-type 为 JSON 且解析成功 → json 类型 + 解析值", () => {
    expect(detectResponseBody('{"ok":true}', { "content-type": "application/json" })).toEqual({
      bodyType: "json",
      json: { ok: true },
    });
    expect(
      detectResponseBody("[1,2,3]", { "content-type": "application/json; charset=utf-8" }),
    ).toEqual({ bodyType: "json", json: [1, 2, 3] });
  });

  it("content-type 非 JSON 但内容像 JSON（{ / [ 开头）→ 嗅探解析", () => {
    expect(detectResponseBody('  {"a":1}', { "content-type": "text/plain" })).toEqual({
      bodyType: "json",
      json: { a: 1 },
    });
    expect(detectResponseBody("[]", {})).toEqual({ bodyType: "json", json: [] });
  });

  it("content-type 为 JSON 但解析失败（截断 / 伪 JSON）→ 文本回退（无 json）", () => {
    expect(detectResponseBody('{"a":', { "content-type": "application/json" })).toEqual({
      bodyType: "text",
    });
  });

  it("普通文本 / 表单体 → 文本类型（无 json）", () => {
    expect(detectResponseBody("token=abc", { "content-type": "text/plain" })).toEqual({
      bodyType: "text",
    });
    expect(detectResponseBody("<html></html>", { "content-type": "text/html" })).toEqual({
      bodyType: "text",
    });
  });

  it("空串 → empty（无 json）", () => {
    expect(detectResponseBody("", { "content-type": "application/json" })).toEqual({
      bodyType: "empty",
    });
  });
});
