import { describe, expect, it } from "vitest";
import type { HarEntry, HarRequest } from "./types";
import { buildReplayRequest } from "./replay";

/**
 * M9-T3 二进制 body 重建测试（顺手修复的专项回归）：
 * HAR postData.encoding='base64'（HAR 1.2 对二进制 body 的记录方式）解码为
 * 字节发送；非法 base64 退化为原文；文本 body / 覆盖 body 行为不变；
 * 二进制 body 跳过模板渲染（按原始字节透传）。
 */

/** 构造最小合法 HAR 请求（字段可覆盖） */
function makeRequest(overrides: Partial<HarRequest> = {}): HarRequest {
  return {
    method: "POST",
    url: "https://api.example.com/v1/upload",
    httpVersion: "HTTP/1.1",
    headers: [],
    queryString: [],
    headersSize: -1,
    bodySize: -1,
    ...overrides,
  };
}

/** 构造最小合法 HAR 条目（request 可覆盖） */
function makeEntry(requestOverrides: Partial<HarRequest> = {}): HarEntry {
  return {
    startedDateTime: "2026-01-01T00:00:00.000Z",
    time: 10,
    request: makeRequest(requestOverrides),
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      headers: [],
      content: { size: 2, mimeType: "application/json", text: "{}" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 2,
    },
    timings: { send: 0, wait: 10, receive: 0 },
  };
}

describe("buildReplayRequest：二进制 body（postData.encoding=base64）", () => {
  it("base64 基线解码为字节：重放 body 是原始字节而非 base64 文本", () => {
    // 0xDE 0xAD 0xBE 0xEF（非 UTF-8 安全序列，文本通道必然失真）
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const request = buildReplayRequest({
      harEntry: makeEntry({
        postData: { mimeType: "application/octet-stream", text: base64, encoding: "base64" },
      }),
    });
    expect(request.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(request.body as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("非法 base64 退化为原文透传（不抛错，与既有行为一致）", () => {
    const request = buildReplayRequest({
      harEntry: makeEntry({
        postData: {
          mimeType: "application/octet-stream",
          text: "not-base64!!!",
          encoding: "base64",
        },
      }),
    });
    expect(request.body).toBe("not-base64!!!");
  });

  it("无 encoding 标记的文本 body 行为不变（不误伤纯文本）", () => {
    const request = buildReplayRequest({
      harEntry: makeEntry({
        postData: { mimeType: "application/json", text: '{"a":1}' },
      }),
    });
    expect(request.body).toBe('{"a":1}');
  });

  it("二进制 body 跳过模板渲染（按原始字节透传）", () => {
    const bytes = new Uint8Array([0x00, 0x7b, 0x7d, 0xff]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const request = buildReplayRequest(
      {
        harEntry: makeEntry({
          postData: { mimeType: "application/octet-stream", text: base64, encoding: "base64" },
        }),
      },
      // 上下文含会把 '}' 周边文本替换掉的数据——字节必须原样保留
      { node: {}, input: { token: "tk" } },
    );
    expect(Array.from(request.body as Uint8Array)).toEqual([0x00, 0x7b, 0x7d, 0xff]);
  });

  it("override body 整体替换时按文本处理（覆盖优先于基线编码）", () => {
    const request = buildReplayRequest({
      harEntry: makeEntry({
        postData: { mimeType: "application/octet-stream", text: "AA==", encoding: "base64" },
      }),
      override: { body: '{"replaced":true}' },
    });
    expect(request.body).toBe('{"replaced":true}');
  });
});
