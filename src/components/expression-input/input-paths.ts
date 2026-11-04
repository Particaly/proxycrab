/**
 * 入参 / 出参字段路径收集（ReqFlow 复刻计划 Task 15 薄片 A）。
 *
 * 自归档 `_archive/reqflow/src/components/expression-input/input-paths.ts
 * @ 485fa00` 移植（零依赖纯函数，形态不变）。为表达式提示（ExpressionInput
 * 的 `{{ input.` / `{{ $json.` 二级候选、节点深路径候选）与后续 IO 面板的
 * 字段清单提供点分路径：把最近一次运行的节点 input / output（任意 JSON）
 * 投影为可引用的路径列表（如 `body.data.token`、`items.0.id`）。
 *
 * 路径语义与 flow-engine/src/template.ts 的 resolvePath 对齐：对象键逐段下钻、
 * 数组用十进制下标（无前导零）——收集出的路径可直接填进 `{{ ... }}` 渲染。
 *
 * 边界（防大对象把提示撑爆 / 递归过深）：
 *   - 含 `.` 的键跳过（点分路径无法表达，与 resolvePath 的段语义冲突）；
 *   - 数组只展开前 MAX_ARRAY_SAMPLES 个元素（同一结构的重复项取前几个即可）；
 *   - 深度上限与路径总数上限（超出截断，按遍历顺序保留先遇到的）。
 *
 * 纯函数、零依赖，node 可直接单测。
 */

/** 单层数组最多展开的元素数（同一结构重复项取前几个足够提示） */
export const MAX_ARRAY_SAMPLES = 3;

/** 路径收集的默认最大深度（根的子层记为 1） */
export const DEFAULT_MAX_PATH_DEPTH = 6;

/** 路径收集的默认总数上限 */
export const DEFAULT_MAX_PATHS = 60;

/** collectJsonPaths 的可调边界 */
export interface CollectJsonPathsOptions {
  /** 最大深度（缺省 6） */
  maxDepth?: number;
  /** 路径总数上限（缺省 60） */
  maxPaths?: number;
}

/** 值是否为可继续下钻的容器（对象 / 数组） */
function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

/**
 * 收集 JSON 值的可引用字段路径（点分，详见模块头）。
 *
 * 空对象 / 空数组本身也产出路径（引用后渲染为空串，属有效引用）；
 * 原始值（string / number / boolean / null）作为叶子产出其路径。
 *
 * @param value 任意 JSON 值（最近一次运行的 input / output）
 * @param options 深度与数量上限（缺省见常量）
 * @returns 点分路径列表（保序、去重；非容器根返回空数组）
 */
export function collectJsonPaths(value: unknown, options: CollectJsonPathsOptions = {}): string[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PATH_DEPTH;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const paths: string[] = [];

  const walk = (current: unknown, path: string, depth: number): void => {
    if (paths.length >= maxPaths) return;
    if (!isContainer(current)) return;

    if (Array.isArray(current)) {
      const sampled = current.slice(0, MAX_ARRAY_SAMPLES);
      for (let index = 0; index < sampled.length; index++) {
        if (paths.length >= maxPaths) return;
        const next = `${path}${path === "" ? "" : "."}${index}`;
        paths.push(next);
        if (depth < maxDepth && isContainer(sampled[index])) walk(sampled[index], next, depth + 1);
      }
      return;
    }

    for (const [key, item] of Object.entries(current)) {
      if (paths.length >= maxPaths) return;
      if (key === "" || key.includes(".")) continue;
      const next = path === "" ? key : `${path}.${key}`;
      paths.push(next);
      if (depth < maxDepth && isContainer(item)) walk(item, next, depth + 1);
    }
  };

  walk(value, "", 1);
  return paths;
}
