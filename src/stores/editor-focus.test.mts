import { beforeEach, expect, test } from "vitest";
import {
  consumeEditorFocus,
  editorFocusStore,
  requestEditorFocus,
} from "./editor-focus";

/**
 * 编辑器聚焦请求接缝单测（Task 22 薄片 C）：写入→消费一次即清空、
 * 同目标重复请求递增 version（编辑器侧 watch 依赖 version 触发）。
 */

beforeEach(() => {
  editorFocusStore.pending = null;
  editorFocusStore.version = 0;
});

test("请求→消费一次拿到目标，再消费为 null（消费即清空）", () => {
  requestEditorFocus("wf-1", "n2");
  expect(editorFocusStore.version).toBe(1);
  expect(consumeEditorFocus()).toEqual({ workflowId: "wf-1", nodeId: "n2" });
  expect(consumeEditorFocus()).toBeNull();
});

test("同目标重复请求仍递增 version（watch 可再次触发）", () => {
  requestEditorFocus("wf-1", "n1");
  requestEditorFocus("wf-1", "n1");
  expect(editorFocusStore.version).toBe(2);
  expect(consumeEditorFocus()).toEqual({ workflowId: "wf-1", nodeId: "n1" });
});
