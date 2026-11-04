import { describe, expect, it } from "vitest";
import {
  IO_PATH_MIME,
  buildInputFieldSnippet,
  buildNodeFieldSnippet,
  hasIoPathPayload,
  readIoPathPayload,
  writeIoPathPayload,
} from "./template-dnd";

/**
 * IO 字段拖放协议测试（Task 15 薄片 B Step 3）：MIME 装配 / 解析往返、
 * chip 路径格式化（出参带前缀 / 入参裸路径简写）、dragover types 判定、
 * 空载荷边界。
 */

/** setData 捕获桩：记录写入并对 getData 同形回放（模拟 dataTransfer 往返） */
function createDataTransferStub(): {
  setData(type: string, data: string): void;
  getData(type: string): string;
  written: Map<string, string>;
} {
  const written = new Map<string, string>();
  return {
    written,
    setData(type, data) {
      written.set(type, data);
    },
    getData(type) {
      return written.get(type) ?? "";
    },
  };
}

describe("buildNodeFieldSnippet", () => {
  it("格式化为 node 命名空间完整引用", () => {
    expect(buildNodeFieldSnippet("n1", "status")).toBe("{{ node.n1.status }}");
    expect(buildNodeFieldSnippet("fetch", "json.data.token")).toBe(
      "{{ node.fetch.json.data.token }}",
    );
  });

  it("空路径引用整个输出；前导点剥掉", () => {
    expect(buildNodeFieldSnippet("n1", "")).toBe("{{ node.n1 }}");
    expect(buildNodeFieldSnippet("n1", ".status")).toBe("{{ node.n1.status }}");
  });
});

describe("buildInputFieldSnippet", () => {
  it("入参裸路径简写；空路径退化为 {{ input }}", () => {
    expect(buildInputFieldSnippet("headers.x-token")).toBe("{{ headers.x-token }}");
    expect(buildInputFieldSnippet(".status")).toBe("{{ status }}");
    expect(buildInputFieldSnippet("")).toBe("{{ input }}");
  });
});

describe("hasIoPathPayload", () => {
  it("types 含本 MIME 判定为携带载荷", () => {
    expect(hasIoPathPayload([IO_PATH_MIME])).toBe(true);
    expect(hasIoPathPayload(["text/plain", IO_PATH_MIME])).toBe(true);
  });

  it("types 不含本 MIME（空 / 其他协议 / 原生文本拖拽）不接管", () => {
    expect(hasIoPathPayload([])).toBe(false);
    expect(hasIoPathPayload(["text/plain"])).toBe(false);
    expect(hasIoPathPayload(["application/x-reqflow-node-type"])).toBe(false);
  });
});

describe("writeIoPathPayload / readIoPathPayload 往返", () => {
  it("写入 MIME 与 text/plain 兜底，读回同一片段", () => {
    const transfer = createDataTransferStub();
    const snippet = buildNodeFieldSnippet("n1", "json.data.token");
    writeIoPathPayload(transfer, snippet);
    expect(transfer.written.get(IO_PATH_MIME)).toBe(snippet);
    expect(transfer.written.get("text/plain")).toBe(snippet);
    expect(readIoPathPayload(transfer)).toBe(snippet);
  });

  it("未携带载荷 / 空白载荷返回 null", () => {
    const empty = createDataTransferStub();
    expect(readIoPathPayload(empty)).toBe(null);
    const blank = createDataTransferStub();
    writeIoPathPayload(blank, "   ");
    expect(readIoPathPayload(blank)).toBe(null);
  });
});
