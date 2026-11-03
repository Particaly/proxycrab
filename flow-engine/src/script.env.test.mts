import { describe, expect, it } from "vitest";
import { compileScript, createEnvScriptParam, runPostScript, runPreScript } from "./script";

/**
 * M14-T2 / M14-T3 引擎层 env 形参测试（既有 script.test.ts 锁定的编译 / 净化 /
 * 超时行为不在此重复）：
 *   - T2 可读：compileScript 声明第二数据形参 env（pre / post / 重声明防护），
 *     runPreScript / runPostScript 注入派发时定格的环境快照；
 *   - T3 可写：脚本对 env 的赋值（含动态新键）经可写代理收集为 envWrites 随
 *     结果回传（成功与失败结果均携带——已提交写回不回滚）；非法赋值报错、
 *     快照定格不被脚本污染、undefined 赋值不产生写回。
 */

/** 构造 post 模式的响应入参（与 script.test.ts 同款夹具） */
function makeResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { token: "abc", userId: 7 },
    durationMs: 123,
    ...overrides,
  };
}

describe("compileScript：env 形参声明（M14-T2）", () => {
  it("pre / post 编译的脚本均可读取 env 形参（第三形参按位注入）", () => {
    const pre = compileScript("return env.baseUrl", "pre");
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const sandbox = { deadline: Date.now() + 1000, checkDeadline: () => {} };
      expect(pre.fn("in", sandbox, { baseUrl: "http://dev" })).toBe("http://dev");
    }
    const post = compileScript("return env.apiToken", "post");
    expect(post.ok).toBe(true);
    if (post.ok) {
      const sandbox = { deadline: Date.now() + 1000, checkDeadline: () => {} };
      expect(post.fn(makeResponse(), sandbox, { apiToken: "t-1" })).toBe("t-1");
    }
  });

  it("env 形参同样不可被脚本重声明（严格模式 let/const → 编译期 syntax）", () => {
    for (const source of ["let env; return 1", "const env = 1; return env"]) {
      const result = compileScript(source);
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("syntax");
    }
  });
});

describe("runPreScript / runPostScript：env 读取（M14-T2）", () => {
  it("pre 脚本读取派发时定格的环境快照", () => {
    const result = runPreScript('return { url: env.baseUrl + "/login" }', null, {
      env: { baseUrl: "http://dev" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ url: "http://dev/login" });
      expect(result.envWrites).toBeUndefined();
    }
  });

  it("post 脚本读取环境快照并可与响应组合", () => {
    const result = runPostScript(
      "return { token: response.json.token, prefix: env.prefix }",
      makeResponse({
        body: JSON.stringify({ token: "abc" }),
        json: { token: "abc" },
      }) as never,
      { env: { prefix: "Bearer" } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ token: "abc", prefix: "Bearer" });
  });

  it("未传 env → 脚本 env 恒可用（空表；缺键读取为 undefined）", () => {
    // post 返回任意 JSON 值（pre 的返回值是覆盖对象，未知键会被剔除——不适用）
    const post = runPostScript(
      "return { isObject: typeof env, missing: String(env.nope) }",
      makeResponse() as never,
    );
    expect(post.ok).toBe(true);
    if (post.ok) expect(post.value).toEqual({ isObject: "object", missing: "undefined" });
  });
});

describe("createEnvScriptParam：可写代理与写回收集（M14-T3）", () => {
  it("快照定格：脚本写不污染调用方快照表，代理内层状态同脚本可见", () => {
    const snapshot = { baseUrl: "http://dev", count: 1 };
    const param = createEnvScriptParam(snapshot);
    const writes = param.takeWrites();
    // 无写回 → undefined（结果对象不携带空表）
    expect(writes).toBeUndefined();
    // 模拟脚本赋值：写回记录 + 内层状态同步（同脚本内读取可见）
    const env = param.value as Record<string, unknown>;
    void env; // 仅验证代理对象可用；赋值经 runPreScript 全链路覆盖（见下方 describe）
    expect(snapshot).toEqual({ baseUrl: "http://dev", count: 1 });
  });

  it("takeWrites 取走后清空（重复取返回 undefined）", () => {
    const param = createEnvScriptParam({});
    (param.value as Record<string, unknown>).a = 1;
    expect(param.takeWrites()).toEqual({ a: 1 });
    expect(param.takeWrites()).toBeUndefined();
  });
});

describe("runPreScript / runPostScript：env 写回（M14-T3）", () => {
  it("pre 脚本赋值（含动态新键）→ envWrites 随成功结果回传", () => {
    const snapshot = { baseUrl: "http://dev" };
    const result = runPreScript(
      'env.baseUrl = "http://prod"; env.newKey = { a: 1 }; return {}',
      null,
      { env: snapshot },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envWrites).toEqual({ baseUrl: "http://prod", newKey: { a: 1 } });
    // 快照定格：调用方表不被脚本写污染
    expect(snapshot).toEqual({ baseUrl: "http://dev" });
  });

  it("post 脚本从响应提取写回（登录存 token 场景）", () => {
    const result = runPostScript(
      "env.token = response.json.token; return null",
      makeResponse({
        body: JSON.stringify({ token: "tok-9" }),
        json: { token: "tok-9" },
      }) as never,
      { env: {} },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envWrites).toEqual({ token: "tok-9" });
  });

  it("同键多次赋值取最后一次（键首写序保留）", () => {
    const result = runPreScript('env.k = 1; env.other = true; env.k = "final"; return {}', null, {
      env: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envWrites).toEqual({ k: "final", other: true });
  });

  it("脚本内写回后同脚本读取可见新值", () => {
    // post 返回任意 JSON 值（pre 的返回值是覆盖对象——不适用）
    const result = runPostScript(
      'env.token = "t"; return { seen: env.token }',
      makeResponse() as never,
      { env: {} },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ seen: "t" });
      expect(result.envWrites).toEqual({ token: "t" });
    }
  });

  it("脚本失败（runtime / invalid-return）→ 失败结果同样携带已提交写回（不回滚）", () => {
    const runtime = runPreScript('env.committed = "yes"; throw new Error("boom")', null, {
      env: {},
    });
    expect(runtime.ok).toBe(false);
    if (!runtime.ok) {
      expect(runtime.error.kind).toBe("runtime");
      expect(runtime.envWrites).toEqual({ committed: "yes" });
    }
    const invalid = runPostScript(
      'env.committed = "yes"; return () => {}',
      makeResponse() as never,
      { env: {} },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.kind).toBe("invalid-return");
      expect(invalid.envWrites).toEqual({ committed: "yes" });
    }
  });

  it("软超时改判 timeout → 已完整跑完的写回照常携带（副作用不回滚）", () => {
    // timeoutMs = 0：只要实际耗时 > 0 即改判（短暂忙等保证耗时非零）
    const result = runPreScript(
      'env.side = "effect"; var __start = Date.now(); while (Date.now() - __start < 5); return {}',
      null,
      { env: {}, timeoutMs: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
      expect(result.envWrites).toEqual({ side: "effect" });
    }
  });

  it("非法赋值抛错中断脚本（runtime 分类，写回止于抛错前）", () => {
    const result = runPreScript('env.okKey = 1; env.bad = () => "fn"; return {}', null, {
      env: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("runtime");
      expect(result.error.message).toContain("env 赋值");
      expect(result.envWrites).toEqual({ okKey: 1 });
    }
  });

  it("原型污染键赋值抛错（__proto__ / constructor / prototype）", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const result = runPreScript(`env[${JSON.stringify(key)}] = 1; return {}`, null, { env: {} });
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("原型污染防护");
    }
  });

  it("delete env.x 与原型改写被拒绝（写回仅支持赋值）", () => {
    const del = runPreScript("delete env.k; return {}", null, { env: { k: "v" } });
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error.message).toContain("delete");
    const proto = runPreScript("Object.setPrototypeOf(env, null); return {}", null, { env: {} });
    expect(proto.ok).toBe(false);
  });

  it("undefined 赋值不产生写回（同脚本内读取为 undefined）", () => {
    const result = runPreScript("env.k = undefined; return { seen: env.k }", null, {
      env: { k: "v" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ seen: undefined });
      expect(result.envWrites).toBeUndefined();
    }
  });

  it("脚本未触 env → 结果不携带 envWrites 字段", () => {
    const result = runPreScript("return {}", null, { env: { baseUrl: "http://dev" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect("envWrites" in result).toBe(false);
  });
});
