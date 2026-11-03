/**
 * 节点引用短码（refId）纯函数（M15-T2）。
 *
 * 背景：节点出参的模板引用 `{{ node.<id>.path }}` 此前暴露 36 位内部 UUID，
 * 可读性差。M15-T2 为节点引入可选的 5 位纯字母短码 refId 作为**模板引用键**：
 * 创建 / 迁移 / 粘贴 / 导入时随机生成并对当前流程查重，用户可在配置抽屉修改；
 * 读取侧一律 `refId ?? id` 回退——存量数据与测试直构节点（无 refId）行为与
 * 既有逐字节一致。内部主键（React Flow 节点 id / RunRecord.nodeRuns 键 /
 * run-progress 事件 / 画布着色 / pinnedOutputs / rerun）不使用本字段。
 *
 * 纯字母（无数字）是为避免与模板路径中的数字段（如 `items.0`）产生视觉歧义；
 * 5 位字母约 3.8 亿组合，流程内查重重摇即可保证唯一，无需全局唯一。
 *
 * 本模块无 React / 存储 / DOM 依赖，供引擎（executor 键）、存储（迁移 /
 * 导入重映射）、画布（创建 / 粘贴查重）与配置抽屉（编辑校验）共同使用。
 */

/** 合法短码：恰好 5 位纯字母（大小写均可） */
export const REF_ID_PATTERN = /^[A-Za-z]{5}$/;

/** 短码长度（固定 5 位） */
const REF_ID_LENGTH = 5;

/** 短码字符集：52 个大小写字母 */
const REF_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 短码生成器类型（可注入以便测试确定性；exclude 为已占用 token 集合） */
export type GenerateRefId = (exclude?: ReadonlySet<string>) => string;

/**
 * 判断未知值是否为合法短码（恰好 5 位纯字母）。
 * 缺失（undefined / 空串）不算非法——读取侧回退内部 id，属合法形态。
 */
export function isValidRefId(value: unknown): value is string {
  return typeof value === "string" && REF_ID_PATTERN.test(value);
}

/** 随机取一个 5 位字母串（crypto.getRandomValues 优先，老环境回退 Math.random） */
function randomLetters(): string {
  let result = "";
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint32Array(REF_ID_LENGTH);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < REF_ID_LENGTH; i++) {
      result += REF_ID_ALPHABET[bytes[i]! % REF_ID_ALPHABET.length];
    }
    return result;
  }
  for (let i = 0; i < REF_ID_LENGTH; i++) {
    result += REF_ID_ALPHABET[Math.floor(Math.random() * REF_ID_ALPHABET.length)];
  }
  return result;
}

/**
 * 生成一个流程内未占用的随机短码：命中 exclude（已占用集合）时重摇
 * （冲突重摇，M15-T2）。exclude 缺省 / 为空时一次生成即返回。
 *
 * @param exclude 已占用 token 集合（调用方传入当前流程全部节点 refId，
 *   可顺带并入节点 id 以杜绝极端巧合）
 */
export function generateRefId(exclude?: ReadonlySet<string>): string {
  let candidate = randomLetters();
  while (exclude !== undefined && exclude.has(candidate)) {
    candidate = randomLetters();
  }
  return candidate;
}
