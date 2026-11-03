/**
 * secret 变量脱敏（M9-T5）。
 *
 * ROADMAP M9-T5：secret 变量在模板渲染时可被节点正常使用（值进入重放请求），
 * 但其值不得以明文落入运行记录（RunRecord 的节点 input / output / error 与
 * 广播事件）。本模块是 run 落库 / 广播前的唯一脱敏防线，与 run-record.ts 的
 * 体积控制同级：纯函数、零环境依赖（不依赖 React / 存储 / 网络 / chrome.*，
 * node 可直接单测），只做数据清洗、不做体积控制（两道防线正交，先脱敏后截断）。
 *
 * 脱敏策略（子串替换）：把快照内所有字符串中出现的 secret 值整体替换为
 * SECRET_MASK_PLACEHOLDER。选择子串替换而非按键掩码的原因——secret 经模板
 * 渲染后通常**嵌入**在更大的字符串里（如 header 值 "Bearer <token>"、URL 查询
 * 参数、拼接后的 body），按变量名定位只能遮住「值恰好等于 secret」的整串；
 * 子串替换对任意嵌入形态都生效，是记录侧唯一可靠的兜底。
 *
 * 已知边界（注释即契约）：
 *   - 最短长度护栏 SECRET_MASK_MIN_LENGTH：值长度不足时不做替换——超短值
 *     （如单字符）作为子串会在快照中大面积误伤（替换掉无关文本），泄露面与
 *     误伤面相比可忽略；需要隐藏的超短值请使用者自行加长（如加固定前缀）。
 *   - 只处理字符串形态的 secret 值；运行期被 setVariable 覆写为非字符串的
 *     同名变量不参与脱敏（落库变量表值均为字符串，属罕见路径）。
 *   - 替换基于值的精确出现（区分大小写、不做 URL 解码），编码变形（如
 *     percent-encoding 后的值）不在此防线内。
 *
 * 注意：本文件不通过 src/engine/index.ts 桶文件再导出（与 template.ts /
 * run-variables.ts 同策略：只新增文件，不改动既有桶面），调用方按路径
 * `@/engine/secret-mask` 直接引入。
 */

import type { LoopIterationRecord, NodeId, NodeRun } from "./types";

/** 脱敏占位符（记录侧统一形态，读侧据此识别被脱敏的片段） */
export const SECRET_MASK_PLACEHOLDER = "******";

/**
 * 参与脱敏的 secret 值最小长度：低于该长度的值不做子串替换（见文件头
 * 「已知边界」——超短值替换会大面积误伤无关文本）。
 */
export const SECRET_MASK_MIN_LENGTH = 4;

/**
 * 把文本中出现的全部 secret 值替换为脱敏占位符（纯函数）。
 *
 * 多个 secret 依次替换（先到先得：已被前一个 secret 替换出的占位符不会被
 * 后续规则再处理，占位符自身永不参与匹配）。
 *
 * @param text 原文本（空串直接返回）
 * @param secrets secret 值清单（非字符串 / 长度不足 SECRET_MASK_MIN_LENGTH
 *        的项跳过；空清单原样返回）
 * @returns 脱敏后的文本（无命中时与入参同串）
 */
export function maskSecretsInText(text: string, secrets: readonly unknown[]): string {
  if (text === "" || secrets.length === 0) return text;
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    if (secret.length < SECRET_MASK_MIN_LENGTH) continue;
    if (secret === SECRET_MASK_PLACEHOLDER) continue;
    if (!result.includes(secret)) continue;
    // split/join 实现全量字面替换（值按普通文本处理，不做正则转义）
    result = result.split(secret).join(SECRET_MASK_PLACEHOLDER);
  }
  return result;
}

/**
 * 深度脱敏任意 JSON 结构中的字符串（纯函数）。
 *
 * 规则与 renderValueDeep 一致的结构遍历约定：字符串 → 逐串脱敏；数组 / 对象
 * → 递归（对象键不脱敏——键是结构不是数据）；数字 / 布尔 / null / undefined
 * 及 JSON 之外的值原样保留。未命中任何 secret 时字符串保持原引用（零拷贝）。
 *
 * @param value 任意 JSON 安全值（节点 input / output 等）
 * @param secrets secret 值清单（见 maskSecretsInText）
 * @returns 脱敏后的同构结构（未命中时各字符串保持原引用）
 */
export function maskSecretsDeep(value: unknown, secrets: readonly unknown[]): unknown {
  if (secrets.length === 0) return value;

  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      return maskSecretsInText(current, secrets);
    }
    if (Array.isArray(current)) {
      return current.map(walk);
    }
    if (current !== null && typeof current === "object") {
      const masked: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        masked[key] = walk(item);
      }
      return masked;
    }
    return current;
  };

  return walk(value);
}

/**
 * 脱敏单节点执行快照（纯函数，落库 / 广播前调用）。
 *
 * input / output 走 maskSecretsDeep；error 文本走 maskSecretsInText（脚本错误
 * 消息可能回显携带 secret 的输入）。M13-T9：循环节点的逐迭代明细
 * （NodeRun.iterations.records）同步脱敏——每轮的 item / output 与节点快照
 * 同口径走深度掩码（循环体内的重放响应可能回显 secret）、失败轮 error 走
 * 文本掩码。不改动入参对象，返回浅拷贝 + 替换后的字段。
 *
 * @param nodeRun 原始节点执行快照（执行器产出，不做变更）
 * @param secrets secret 值清单（见 maskSecretsInText）
 * @returns 可安全落库 / 广播的快照
 */
export function maskNodeRunForRecord(nodeRun: NodeRun, secrets: readonly unknown[]): NodeRun {
  const masked: NodeRun = {
    ...nodeRun,
    input: maskSecretsDeep(nodeRun.input, secrets),
    output: maskSecretsDeep(nodeRun.output, secrets),
  };
  if (nodeRun.error !== undefined) {
    masked.error = maskSecretsInText(nodeRun.error, secrets);
  }
  // M13-T9：逐迭代明细与节点快照同口径脱敏（循环体内回显 secret 的兜底）
  if (nodeRun.iterations !== undefined) {
    masked.iterations = {
      ...nodeRun.iterations,
      records: nodeRun.iterations.records.map((record) => {
        const maskedRecord: LoopIterationRecord = {
          ...record,
          item: maskSecretsDeep(record.item, secrets),
          output: maskSecretsDeep(record.output, secrets),
        };
        if (record.error !== undefined) {
          maskedRecord.error = maskSecretsInText(record.error, secrets);
        }
        return maskedRecord;
      }),
    };
  }
  return masked;
}

/** 可脱敏的运行摘要最小结构（RunSummary 的结构子集，避免与 executor 产生类型耦合） */
export interface MaskableRunSummary {
  /** 运行级错误摘要（可能回显 secret，如失败节点把输入拼进错误消息） */
  error?: string;
  /** 按节点 id 索引的执行快照 */
  nodeRuns: Record<NodeId, NodeRun>;
}

/**
 * 脱敏整次运行的摘要（纯函数，finishRun 定稿前调用）。
 *
 * 全部节点的 input / output / error 逐一过 maskNodeRunForRecord；run 级 error
 * 文本一并脱敏；其余字段（status / runId 等）原样保留。不改动入参。
 *
 * @param summary 运行结束摘要（executeWorkflow 返回值）
 * @param secrets secret 值清单（见 maskSecretsInText）
 * @returns 可安全落库的摘要副本
 */
export function maskRunSummaryForRecord<S extends MaskableRunSummary>(
  summary: S,
  secrets: readonly unknown[],
): S {
  const nodeRuns: Record<NodeId, NodeRun> = {};
  for (const nodeId of Object.keys(summary.nodeRuns) as NodeId[]) {
    nodeRuns[nodeId] = maskNodeRunForRecord(summary.nodeRuns[nodeId], secrets);
  }
  const masked: S = { ...summary, nodeRuns };
  if (summary.error !== undefined) {
    masked.error = maskSecretsInText(summary.error, secrets);
  }
  return masked;
}
