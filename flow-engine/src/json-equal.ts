/**
 * JSON 深度相等（本项目各模块的统一相等语义）。
 *
 * 语义口径：NaN 不相等（JSON 无 NaN）、对象比较键集合与各键值、数组按位、
 * 其余标量按严格相等（不区分 undefined 与缺失键——与 JSON.stringify 一致）。
 * 消费方：断言节点（engine/assert-nodes 的 eq / ne / contains）与 Schema 子集
 * 校验（engine/json-schema-lite 的 enum），见各自模块头的边界披露。
 *
 * 沿革（M18-T1）：本模块原为 M10-T3 的「轻量 JSON diff」（json-diff.ts，
 * 含 diffJsonValues / formatDiffValue 与条目结构），仅供运行对比功能使用；
 * 该功能移除后 diff API 一并删除，仅保留本相等语义（断言 / Schema 仍在用），
 * 模块随之更名以名副其实。
 *
 * 本文件为纯函数、零环境依赖，node 可直接单测；不通过 src/engine/index.ts
 * 桶文件再导出，调用方按路径 `@/engine/json-equal` 直接引入。
 */

/**
 * JSON 值深度相等（纯函数，本项目各模块的统一相等语义）：
 * NaN 不相等（JSON 无 NaN）、对象比较键集合与各键值、数组按位、
 * 其余标量按严格相等（不区分 undefined 与缺失键——与 JSON.stringify 口径一致）。
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    // NaN !== NaN：JSON 数据不该有 NaN，出现即视为不等（诚实暴露）
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonDeepEqual(a[key], b[key]),
    );
  }
  return false;
}

/** 判断值是否为普通对象（排除 null 与数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
