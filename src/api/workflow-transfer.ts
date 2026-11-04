/**
 * 工作流导入导出的信封面（ReqFlow 复刻 Task 23 薄片 C；对齐
 * crates/proxy-crab-mitm/src/flow/transfer.rs 的信封与 confirm-scripts 口径）。
 *
 * - 信封预览摘要：导入页「选择文件 → 解析预览」的数据源，校验口径与服务端
 *   parse_workflow_import 一致（format 标识 / version 上限 / 非空流程数组）；
 * - 脚本审查清单：按 流程下标 → 节点下标 → pre/post/expression 固定顺序收集，
 *   键口径 `workflowIndex:nodeIndex:kind` 与后端确认集合完全一致；
 * - 下载胶水：导出信封经既有 backend.saveFile 通路落盘（与请求库导出一致）。
 */

import type { Backend } from "./backend";
import { saveBytesFile } from "./save-file";
import type { Workflow, WorkflowExportEnvelope, WorkflowNode } from "./types";

/** 导出信封的 format 标识（服务端 WORKFLOW_EXPORT_FORMAT）。 */
export const WORKFLOW_EXPORT_FORMAT = "reqflow-workflow";
/** 当前支持的最高信封版本（低版本按当前 schema 迁移读取，故只有上限）。 */
export const WORKFLOW_EXPORT_VERSION = 1;
/** 导出下载的默认文件名（与服务端 Content-Disposition 一致）。 */
export const WORKFLOW_EXPORT_FILENAME = "reqflow-workflows.json";

/** 可执行脚本种类：preProcess（httpReplay 前置）/ postProcess（后置）/ expression（condition 条件表达式）。 */
export type ImportedScriptKind = "preProcess" | "postProcess" | "expression";

/** 单节点内的脚本收集顺序：pre → post → expression（清单稳定可复现）。 */
const SCRIPT_KINDS: ImportedScriptKind[] = ["preProcess", "postProcess", "expression"];

/** 脚本种类中文标签（审查清单展示用）。 */
export const SCRIPT_KIND_LABELS: Record<ImportedScriptKind, string> = {
  preProcess: "前置脚本",
  postProcess: "后置脚本",
  expression: "条件表达式",
};

/** 审查清单里的一条可执行脚本。 */
export interface ImportedScriptRef {
  /** 审查项唯一键（confirmedScripts 的组成单元）。 */
  key: string;
  workflowIndex: number;
  nodeIndex: number;
  /** 节点 id（信封原文，导入时会被服务端重映射）。 */
  nodeId: string;
  nodeType: string;
  kind: ImportedScriptKind;
  /** 脚本原文（审查展示用）。 */
  source: string;
}

/** 脚本审查项唯一键：`流程下标:节点下标:脚本种类`（对齐后端 imported_script_key）。 */
export function importedScriptKey(
  workflowIndex: number,
  nodeIndex: number,
  kind: ImportedScriptKind,
): string {
  return `${workflowIndex}:${nodeIndex}:${kind}`;
}

/** 读取一个脚本种类的字段值；缺失或空串视为未配置（对齐后端 config_script）。 */
function readConfigScript(
  config: Record<string, unknown>,
  kind: ImportedScriptKind,
): string | null {
  const value = config[kind];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 收集信封中的全部可执行脚本（导入页「脚本逐条确认清单」的数据源，顺序稳定）。 */
export function collectImportedScripts(workflows: Workflow[]): ImportedScriptRef[] {
  const scripts: ImportedScriptRef[] = [];
  workflows.forEach((workflow, workflowIndex) => {
    (workflow.nodes ?? []).forEach((node: WorkflowNode, nodeIndex) => {
      for (const kind of SCRIPT_KINDS) {
        const source = readConfigScript(node.config ?? {}, kind);
        if (source !== null) {
          scripts.push({
            key: importedScriptKey(workflowIndex, nodeIndex, kind),
            workflowIndex,
            nodeIndex,
            nodeId: node.id,
            nodeType: node.type,
            kind,
            source,
          });
        }
      }
    });
  });
  return scripts;
}

/** 从勾选集合构造请求体 confirmedScripts：排序保证请求体确定性。 */
export function confirmedScriptKeys(checked: ReadonlySet<string>): string[] {
  return [...checked].sort();
}

/** 信封预览摘要（导入页顶部信息条 + 脚本清单的数据源）。 */
export interface WorkflowEnvelopeSummary {
  version: number;
  exportedAt: number;
  workflowCount: number;
  scriptCount: number;
  requestCount: number;
  envSetCount: number;
  /** 按信封顺序的流程名（空名回落「未命名流程」，对齐服务端 UNNAMED_WORKFLOW_NAME）。 */
  workflowNames: string[];
  scripts: ImportedScriptRef[];
}

/** 解析信封并产出预览摘要；校验失败返回中文原因（导入页错误态文案）。 */
export function inspectWorkflowEnvelope(
  value: unknown,
): { ok: true; summary: WorkflowEnvelopeSummary } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "导出文件结构不符：顶层必须是 JSON 对象" };
  }
  const envelope = value as Partial<WorkflowExportEnvelope>;
  if (envelope.format !== WORKFLOW_EXPORT_FORMAT) {
    return {
      ok: false,
      reason: `不是 ReqFlow 流程导出文件（format 标识缺失或不符，期望 "${WORKFLOW_EXPORT_FORMAT}"）`,
    };
  }
  if (typeof envelope.version !== "number") {
    return { ok: false, reason: "导出文件缺少有效的 version 版本号" };
  }
  if (envelope.version > WORKFLOW_EXPORT_VERSION) {
    return {
      ok: false,
      reason: `导出文件版本 v${envelope.version} 高于当前支持的最高版本 v${WORKFLOW_EXPORT_VERSION}，请升级程序后再导入`,
    };
  }
  if (!Array.isArray(envelope.workflows) || envelope.workflows.length === 0) {
    return { ok: false, reason: "导出文件中没有流程数据" };
  }
  const workflows = envelope.workflows;
  const scripts = collectImportedScripts(workflows);
  return {
    ok: true,
    summary: {
      version: envelope.version,
      exportedAt: typeof envelope.exportedAt === "number" ? envelope.exportedAt : 0,
      workflowCount: workflows.length,
      scriptCount: scripts.length,
      requestCount: Array.isArray(envelope.requests) ? envelope.requests.length : 0,
      envSetCount: Array.isArray(envelope.envSets) ? envelope.envSets.length : 0,
      workflowNames: workflows.map((workflow, index) => workflow?.name || `未命名流程 ${index}`),
      scripts,
    },
  };
}

/**
 * 把导出信封经既有 saveFile 通路落盘（Tauri 弹保存对话框；浏览器触发下载）。
 *
 * @param backend 提供 saveFile 能力的后端
 * @param envelope 服务端导出信封（原始文档）
 * @returns true = 已发起保存；false = 用户取消（saveFile 返回 null）
 */
export async function downloadWorkflowExport(
  backend: Pick<Backend, "saveFile">,
  envelope: WorkflowExportEnvelope,
): Promise<boolean> {
  const content = JSON.stringify(envelope, null, 2);
  return saveBytesFile(backend, WORKFLOW_EXPORT_FILENAME, new TextEncoder().encode(content));
}
