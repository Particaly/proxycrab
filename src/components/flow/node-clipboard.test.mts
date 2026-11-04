import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../../api/types";
import {
  PASTE_OFFSET_PX,
  copySelectedNodes,
  hasNodeClipboard,
  pasteNodeClipboard,
  peekNodeClipboard,
  setNodeClipboard,
} from "./node-clipboard";
import { takenRefKeys } from "./graph-model";

/**
 * 节点复制 / 粘贴纯逻辑测试（断言基线参照归档 node-clipboard.test.ts）：
 * 复制截取选中节点与内部连线（外部连线不复制、config 深拷贝）、粘贴重生成
 * id / 短码与位置偏移、模板引用改写、剪贴板单例的跨流程存取。
 */

/** 递增 id 生成器（可预测断言重映射结果） */
function sequenceGenerateId(): () => string {
  let counter = 0;
  return () => `gen-${++counter}`;
}

function makeNode(
  id: string,
  type: WorkflowNode["type"] = "httpReplay",
  config: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id, type, position: { x: 10, y: 20 }, config, ...extra };
}

function makeEdge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target };
}

beforeEach(() => {
  setNodeClipboard(null);
});

describe("copySelectedNodes：复制选中节点", () => {
  it("只截取选中的节点；外部连线（一端未选中）不复制", () => {
    const nodes = [makeNode("n1"), makeNode("n2"), makeNode("n3", "start")];
    const edges = [
      makeEdge("e-inner", "n1", "n2"),
      makeEdge("e-outer-1", "n1", "n3"),
      makeEdge("e-outer-2", "n3", "n2"),
    ];
    const content = copySelectedNodes(nodes, edges, new Set(["n1", "n2"]));

    expect(content).not.toBeNull();
    expect(content?.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(content?.edges).toEqual([makeEdge("e-inner", "n1", "n2")]);
    expect(hasNodeClipboard()).toBe(true);
  });

  it("config 深拷贝与原图不共享嵌套引用；剪贴板保留原始 id / refId", () => {
    const config = { override: { url: "https://a.com", headers: { Authorization: "Bearer t" } } };
    const nodes = [makeNode("n1", "httpReplay", config, { refId: "abcde" })];
    const content = copySelectedNodes(nodes, [], new Set(["n1"]));

    const copied = content?.nodes[0]!;
    expect(copied.id).toBe("n1");
    expect(copied.refId).toBe("abcde");
    expect(copied.config).toEqual(config);
    expect(copied.config).not.toBe(config);
    (copied.config.override as { headers: Record<string, string> }).headers["Authorization"] = "x";
    expect(nodes[0]!.config.override).toEqual({
      url: "https://a.com",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("无选中节点：清空剪贴板并返回 null", () => {
    copySelectedNodes([makeNode("n1")], [], new Set());
    expect(copySelectedNodes([makeNode("n1")], [], new Set())).toBeNull();
    expect(hasNodeClipboard()).toBe(false);
  });
});

describe("pasteNodeClipboard：粘贴", () => {
  it("节点 / 连线 id 全部重生成，位置按粘贴序次偏移 +24", () => {
    copySelectedNodes(
      [makeNode("n1", "start"), makeNode("n2")],
      [makeEdge("e1", "n1", "n2")],
      new Set(["n1", "n2"]),
    );
    const content = peekNodeClipboard()!;

    const first = pasteNodeClipboard(content, sequenceGenerateId(), 1);
    expect(first.nodes.map((node) => node.id)).toEqual(["gen-1", "gen-2"]);
    expect(first.nodes[0]?.position).toEqual({ x: 10 + PASTE_OFFSET_PX, y: 20 + PASTE_OFFSET_PX });
    expect(first.edges).toEqual([{ id: "gen-3", source: "gen-1", target: "gen-2" }]);

    // 第 2 次粘贴：偏移叠加到 +48（连续粘贴不叠在同一点），id 继续新生成
    const second = pasteNodeClipboard(content, sequenceGenerateId(), 2);
    expect(second.nodes[0]?.position).toEqual({
      x: 10 + PASTE_OFFSET_PX * 2,
      y: 20 + PASTE_OFFSET_PX * 2,
    });
  });

  it("粘贴的 config 为独立深拷贝：两次粘贴互不影响、与剪贴板不共享", () => {
    const config = { override: { headers: { a: "1" } } };
    copySelectedNodes([makeNode("n1", "httpReplay", config)], [], new Set(["n1"]));
    const content = peekNodeClipboard()!;

    const first = pasteNodeClipboard(content, sequenceGenerateId(), 1);
    const second = pasteNodeClipboard(content, sequenceGenerateId(), 1);
    const firstConfig = first.nodes[0]!.config;
    expect(firstConfig).toEqual(config);
    expect(firstConfig).not.toBe(config);
    (firstConfig.override as { headers: Record<string, string> }).headers["a"] = "changed";
    expect(
      (second.nodes[0]!.config.override as { headers: Record<string, string> }).headers["a"],
    ).toBe("1");
  });

  it("引用短码全部重生成且互不冲突；条件分支出口随复制保留", () => {
    const nodes = [
      makeNode("c1", "condition", {}, { refId: "condi" }),
      makeNode("t1", "httpReplay", {}, { refId: "truth" }),
    ];
    copySelectedNodes(
      nodes,
      [{ id: "e1", source: "c1", target: "t1", sourceHandle: "true" }],
      new Set(["c1", "t1"]),
    );
    const pasted = pasteNodeClipboard(peekNodeClipboard()!, sequenceGenerateId(), 1);

    const refIds = pasted.nodes.map((node) => node.refId!);
    expect(refIds).toHaveLength(2);
    expect(refIds[0]).not.toBe("condi");
    expect(refIds[0]).not.toBe("truth");
    expect(refIds[0]).not.toBe(refIds[1]);
    expect(/^[A-Za-z]{5}$/.test(refIds[0]!)).toBe(true);
    // 连线重映射到新节点 id 且分支出口保留
    expect(pasted.edges[0]?.source).toBe(pasted.nodes[0]?.id);
    expect(pasted.edges[0]?.target).toBe(pasted.nodes[1]?.id);
    expect(pasted.edges[0]?.sourceHandle).toBe("true");
  });

  it("config 内模板引用改写到新短码（旧 refId / 旧节点 id 双口径，未复制节点原样保留）", () => {
    const config = {
      expression: "{{ node.condi.output.status }} == 200",
      items: "{{ node.n0.items }}",
      note: "未闭合模板 {{ node.keep.",
    };
    copySelectedNodes(
      [
        makeNode("n0", "start", {}, { refId: "startref" }),
        makeNode("c1", "condition", config, { refId: "condi" }),
      ],
      [makeEdge("e1", "n0", "c1")],
      new Set(["n0", "c1"]),
    );
    const pasted = pasteNodeClipboard(peekNodeClipboard()!, sequenceGenerateId(), 1);

    const refByOldId = new Map<string, string>([
      ["n0", pasted.nodes[0]!.refId!],
      ["c1", pasted.nodes[1]!.refId!],
    ]);
    const newConfig = pasted.nodes[1]!.config;
    expect(newConfig.expression).toBe(`{{ node.${refByOldId.get("c1")}.output.status }} == 200`);
    expect(newConfig.items).toBe(`{{ node.${refByOldId.get("n0")}.items }}`);
    expect(newConfig.note).toBe("未闭合模板 {{ node.keep.");
  });

  it("粘贴对目标画布查重：新短码不与 excludeRefKeys 冲突", () => {
    copySelectedNodes([makeNode("n1", "httpReplay", {}, { refId: "aaaab" })], [], new Set(["n1"]));
    for (let i = 0; i < 200; i += 1) {
      const pasted = pasteNodeClipboard(peekNodeClipboard()!, sequenceGenerateId(), 1, {
        excludeRefKeys: new Set(["zzzzz"]),
      });
      expect(pasted.nodes[0]?.refId).not.toBe("zzzzz");
      expect(pasted.nodes[0]?.refId).not.toBe("aaaab");
    }
  });

  it("空剪贴板节点：抛出明确错误（调用方应先用 hasNodeClipboard 判定）", () => {
    expect(() => pasteNodeClipboard({ nodes: [], edges: [] }, sequenceGenerateId(), 1)).toThrow();
  });
});

describe("节点剪贴板单例：跨流程存取", () => {
  it("复写剪贴板即替换内容（复制 A 后复制 B，粘贴取 B）", () => {
    copySelectedNodes([makeNode("a1")], [], new Set(["a1"]));
    copySelectedNodes([makeNode("b1")], [], new Set(["b1"]));
    const pasted = pasteNodeClipboard(peekNodeClipboard()!, sequenceGenerateId(), 1);
    expect(pasted.nodes).toHaveLength(1);
    // 原始 id 保留在剪贴板中（粘贴时才重映射）
    expect(peekNodeClipboard()?.nodes[0]?.id).toBe("b1");
  });
});

describe("takenRefKeys", () => {
  it("收集节点 id 与既有 refId（对齐后端占用口径）", () => {
    expect(
      takenRefKeys([
        makeNode("start", "start"),
        makeNode("n1", "httpReplay", {}, { refId: "abcde" }),
      ]),
    ).toEqual(new Set(["start", "n1", "abcde"]));
  });
});
