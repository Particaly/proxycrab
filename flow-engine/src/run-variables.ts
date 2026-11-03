/**
 * 运行期变量机制（M7-T2 变量系统）。
 *
 * ROADMAP M7-T2：节点参数可经 `{{ var.<name>.<path> }}` 引用变量（模板层见
 * template.ts），变量来自三层作用域的合并结果，运行期还允许后续节点（M7-T1
 * 的 setVariable 类节点）写入覆盖。本模块为纯逻辑、零环境依赖（不依赖
 * React / 存储 / 网络 / chrome.*），提供两件事：
 *
 *   - mergeVariableScopes：变量作用域优先级合并纯函数——
 *     **工作流级 > 项目级 > 全局级**（同名后到者覆盖，即高优先级作用域的
 *     同名变量覆盖低优先级），各层缺省 / 非对象按空表处理，绝不抛错；
 *   - RunVariableStore：一次运行内的变量存取器——初始变量表来自
 *     mergeVariableScopes 的合并结果，get 取值（缺失返回 undefined）、
 *     set 写入（同名覆盖，值可为任意可结构化克隆的 JSON 值——字符串变量表
 *     落库时的值均为字符串，运行期写入不设此限，供 M7-T1 setVariable 使用）、
 *     has 判断存在性、snapshot 导出浅拷贝快照（供模板上下文构建 / 落库调试）。
 *     M10-T6 收尾起支持经 createOverlay() 产出「迭代作用域 overlay」（见
 *     RunVariableOverlay）——循环并发迭代据此实现变量隔离；本类自身的既有
 *     API（get / has / set / snapshot）与语义不变。
 *
 * 生命周期约定：store 由运行装配方（background/run-controller 或未来调试
 * 链路）在运行开始时创建、随运行结束丢弃——变量不跨运行持久化；执行器本身
 * 不持有 store（变量表经 ExecutorOptions.variables 注入并在每个节点的
 * templateContext.var 里可见，见 executor.ts），set / snapshot 供后续
 * M7-T1 的变量写入节点经 runner 闭包消费。
 *
 * 注意：本文件不通过 src/engine/index.ts 桶文件再导出（与 template.ts 同策
 * 略：M7-T2 只新增本文件，不改动既有 engine 桶文件），调用方按路径
 * `@/engine/run-variables` 直接引入。
 */

/** 运行期变量的取值类型：任意可结构化克隆的 JSON 值（落库的变量表值均为字符串） */
export type RunVariableValue = unknown;

/**
 * 变量作用域合并入参：三层作用域的变量表（均可缺省）。
 *
 * 各层类型约定：流程级 / 项目级 / 全局级落库形态为 Record<string, string>
 * （WorkflowVariables），运行期合并后值放宽为任意 JSON（set 覆盖可能引入
 * 非字符串值），故入参统一按 Record<string, unknown> 接收。
 */
export interface VariableScopeTables {
  /** 全局级变量表（chrome.storage.local，优先级最低） */
  global?: Record<string, unknown>;
  /** 项目级变量表（Project.variables，优先级居中） */
  project?: Record<string, unknown>;
  /** 工作流（流程）级变量表（Workflow.variables，优先级最高） */
  workflow?: Record<string, unknown>;
}

/**
 * 变量作用域优先级合并（纯函数）：工作流级 > 项目级 > 全局级，同名后到者覆盖。
 *
 * 规则：
 *   - 三层均缺省 / undefined / 非对象（null、数组等坏数据）→ 按空表跳过，
 *     绝不抛错（变量读取是旁路增强，坏表不应阻断运行）；
 *   - 合并顺序 global → project → workflow：同名键由高优先级作用域覆盖；
 *   - 返回新对象（浅合并，值保持引用），不改动任何入参表。
 *
 * @param scopes 三层作用域变量表（见 VariableScopeTables）
 * @returns 合并后的运行期初始变量表（无任何变量时为空对象）
 */
export function mergeVariableScopes(scopes: VariableScopeTables): Record<string, RunVariableValue> {
  const merged: Record<string, RunVariableValue> = {};
  // 低 → 高优先级依次展开：同名键自然被后一层覆盖
  for (const table of [scopes.global, scopes.project, scopes.workflow]) {
    if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
    Object.assign(merged, table);
  }
  return merged;
}

/**
 * 一次运行内的变量存取器。
 *
 * 初始变量表通常来自 mergeVariableScopes 的合并结果；构造时做浅拷贝，
 * 后续 set / snapshot 不影响外部表。set 同名覆盖且值不设类型限制（任意
 * JSON），供 M7-T1 的 setVariable 节点在运行期写入。
 *
 * 并发说明（M10-T6 收尾）：本类本身仍不做加锁等并发控制——共享同一 store
 * 直写的路径（顶层图节点、未隔离的串行循环）要求调用方按节点串行调度；
 * 并发写场景（循环并发迭代）经 createOverlay() 的迭代作用域隔离实现：每轮
 * 迭代写自己的 overlay、迭代结束时合并回本 store（见 RunVariableOverlay），
 * 共享直写与本轮私有缓冲两条路径互不混淆。
 */
export class RunVariableStore {
  /** 当前变量表（构造时浅拷贝初始表） */
  #values: Record<string, RunVariableValue>;

  /**
   * @param initial 初始变量表（缺省空表；浅拷贝保存，外部改动不影响本 store）
   */
  constructor(initial: Record<string, RunVariableValue> = {}) {
    this.#values = { ...initial };
  }

  /** 读取变量值；变量不存在返回 undefined（与「存在但值就是 undefined」不区分） */
  get(name: string): RunVariableValue {
    return this.#values[name];
  }

  /** 变量是否存在（hasOwnProperty 精确匹配，原型链键不算） */
  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#values, name);
  }

  /**
   * 写入变量（同名覆盖；值可为任意 JSON）。
   *
   * @param name 变量名（空串同样可写——键的合法性由调用方负责）
   * @param value 变量值（任意可结构化克隆的 JSON 值）
   * @returns 写入前的旧值（首次写入为 undefined，便于后续节点回显）
   */
  set(name: string, value: RunVariableValue): RunVariableValue {
    const previous = this.#values[name];
    this.#values[name] = value;
    return previous;
  }

  /** 导出当前变量表的浅拷贝快照（供模板上下文构建 / 调试展示，防外部误改） */
  snapshot(): Record<string, RunVariableValue> {
    return { ...this.#values };
  }

  /**
   * 创建迭代作用域 overlay（M10-T6 循环并发，见 RunVariableOverlay）：读透传
   * 本 store、写缓冲私有层，mergeBack 合并回本 store。可叠加——overlay 自身
   * 同样提供 createOverlay()（嵌套循环的内层迭代以外层迭代的 overlay 为父层）。
   */
  createOverlay(): RunVariableOverlay {
    return new RunVariableOverlay(this);
  }
}

/* ------------------------------------------------------------------ *
 * 迭代作用域 overlay（M10-T6 循环并发）
 * ------------------------------------------------------------------ */

/**
 * 支持迭代作用域 overlay 的变量存取视图（结构化接口）：RunVariableStore 与
 * RunVariableOverlay 共同实现。logic-nodes.ts 的 loop / setVariable runner 以
 * 本接口探测与解析「当前应写入的变量层」——顶层为主 store，并发迭代体内为
 * 当前迭代的 overlay（嵌套时逐层叠加）。类型引用编译期擦除，不引入运行时
 * 依赖（与既有 import type 约定一致）。
 */
export interface OverlayCapableVariableStore {
  /** 读取变量值；不存在返回 undefined（未缓冲键透传父层） */
  get(name: string): RunVariableValue;
  /** 变量是否存在（缓冲层或父层任一命中即成立） */
  has(name: string): boolean;
  /**
   * 写入变量（同名覆盖），返回写入前旧值。实现约定：overlay 实现缓冲在本层、
   * 不落父层；主 store 实现直接落表。
   */
  set(name: string, value: RunVariableValue): RunVariableValue;
  /** 导出浅拷贝快照（overlay = 父层快照被本层缓冲覆盖后的合并视图） */
  snapshot(): Record<string, RunVariableValue>;
  /** 创建以本视图为父层的子 overlay（读透传本视图、写缓冲、mergeBack 合并回本视图） */
  createOverlay(): RunVariableOverlay;
}

/**
 * 迭代作用域 overlay：RunVariableStore 的隔离视图（M10-T6 循环并发）。
 *
 * 语义：
 *   - 读透传（get / has / snapshot）：未缓冲键回退父层——迭代进行中可见
 *     「已完成迭代合并回父层的最新值」与本层刚写入的值；
 *   - 写缓冲（set）：只落本层私有缓冲，父层在合并前完全不受影响——并发迭代
 *     各持独立 overlay，写入互不覆盖；
 *   - 合并（mergeBack）：把本层缓冲按键逐个写回父层。同键冲突的胜负由调用方
 *     决定——按迭代完成顺序逐个 mergeBack 即天然 last-write-wins；返回本次
 *     合并回父层的键清单（首写序）供日志 / 调试，`exclude` 可排除保留键
 *     （如 var.loop）使其不外泄到父层；
 *   - 叠加：overlay.createOverlay() 产出以本 overlay 为父层的子 overlay——
 *     嵌套循环的内层迭代以外层迭代的 overlay 为父层，子层合并先进中间层、
 *     随中间层自身合并才落主 store；
 *   - 生命周期：单次迭代一份，mergeBack 后缓冲清空（重复合并为空操作），
 *     不应再作新写入用途。
 */
export class RunVariableOverlay implements OverlayCapableVariableStore {
  /** 父层视图（主 store 或外层迭代的 overlay） */
  readonly #parent: OverlayCapableVariableStore;
  /** 本层写缓冲（键 → 值；合并前父层不可见） */
  #buffer: Record<string, RunVariableValue> = {};
  /** 缓冲键的首写序清单（mergeBack 的合并顺序与返回清单依据） */
  #keys: string[] = [];

  /**
   * @param parent 父层视图（通常经 RunVariableStore.createOverlay() /
   *   RunVariableOverlay.createOverlay() 创建，不直接构造）
   */
  constructor(parent: OverlayCapableVariableStore) {
    this.#parent = parent;
  }

  /** 读取变量值：缓冲命中优先，否则透传父层（不存在返回 undefined） */
  get(name: string): RunVariableValue {
    if (Object.prototype.hasOwnProperty.call(this.#buffer, name)) {
      return this.#buffer[name];
    }
    return this.#parent.get(name);
  }

  /** 变量是否存在：缓冲层或父层任一命中即成立 */
  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#buffer, name) || this.#parent.has(name);
  }

  /**
   * 写入变量：缓冲到本层（父层不变），返回写入前旧值（优先取本层缓冲，
   * 首写回退父层当前值）。
   */
  set(name: string, value: RunVariableValue): RunVariableValue {
    const previous = this.get(name);
    if (!Object.prototype.hasOwnProperty.call(this.#buffer, name)) {
      this.#keys.push(name);
    }
    this.#buffer[name] = value;
    return previous;
  }

  /** 导出合并视图：父层快照被本层缓冲覆盖（同名键以本层为准） */
  snapshot(): Record<string, RunVariableValue> {
    return { ...this.#parent.snapshot(), ...this.#buffer };
  }

  /** 创建以本 overlay 为父层的子 overlay（嵌套迭代叠加，见类说明） */
  createOverlay(): RunVariableOverlay {
    return new RunVariableOverlay(this);
  }

  /**
   * 把本层缓冲合并回父层（迭代结束时的收口动作，成功 / 失败均应调用）。
   *
   * @param exclude 不参与合并的保留键（如 loop runner 的 var.loop——嵌套迭代
   *   合并时不得覆盖外层缓冲的 var.loop）。被排除的键随缓冲一并丢弃。
   * @returns 本次实际写回父层的键清单（首写序；供日志 / 调试）。缓冲已空
   *   （含重复合并）返回空数组。
   */
  mergeBack(exclude?: readonly string[]): string[] {
    if (this.#keys.length === 0) return [];
    const skip = new Set(exclude ?? []);
    const merged: string[] = [];
    for (const key of this.#keys) {
      if (skip.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(this.#buffer, key)) continue; // 防御：清单与缓冲同步维护
      this.#parent.set(key, this.#buffer[key]);
      merged.push(key);
    }
    this.#buffer = {};
    this.#keys = [];
    return merged;
  }
}
