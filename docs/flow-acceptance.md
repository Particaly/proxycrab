# Flow 手工真机验收清单

ReqFlow 复刻（计划 `docs/superpowers/plans/2026-11-03-request-workflow-reproduction.md` Task 28 Step 3）的手工真机场景清单。每场景给出前置条件、操作步骤、可观察判定与失败排查；场景编号 `A-xx`，与上游 `_archive/reqflow/ROADMAP.md`（M0–M18）的验收口径对回关系见各节标注。

## 场景总表

| 编号 | 标题 | 覆盖能力 | 依赖 Task | 可执行性 |
|---|---|---|---|---|
| A-01 | 真实流量入库并重放 | 请求库入库、节点重放、运行编排 | 3/5/6/7/14/19/20 | 可执行 |
| A-02 | 头保真（Origin/Referer/UA 与 Cookie 快照） | headerFidelity 三项与 cookieMode 快照/自定义 | 3/14/20 | 可执行 |
| A-03 | 条件真/假走向 | 条件构建器编译为表达式与分支路由 | 16/20 | 可执行 |
| A-04 | 循环并发与取消 | 循环子运行、并发隔离、取消收敛 | 16/19/20 | 可执行 |
| A-05 | 脚本写回环境变量 | 前置/后置脚本与 env 写回链路 | 17/18/19 | 可执行 |
| A-06 | 运行中断与重启收敛 | 重启扫描孤儿 running → interrupted | 19 | 可执行 |
| A-07 | Agent 经 HTTP API 触发工作流（审批链） | POST /api/flow/runs 与权限审批 | 11/19 | 可执行 |
| A-08 | 外部 AI 经 MCP 触发工作流（档位与审批链） | POST /mcp 工具面、三档开关、审批 | 24/25/26 | 预留 |
| A-09 | 导入导出往返 | 工作流导出/导入、refId 迁移、脚本审查 | 23 | 可执行 |
| A-10 | 请求库导入三格式入库核对 | cURL/HAR/Postman 导入 | 8 | 可执行 |
| A-11 | 环境变量集激活切换与 secret 脱敏显示 | 激活切换、掩码读写、运行期冻结 | 17 | 可执行 |

通用说明：运行记录/运行画布窗口属 Task 22（未完成），当前所有运行态核对均走 `GET /api/flow/runs` / `GET /api/flow/runs/{id}`（本机回环默认 `LocalLoopback` 身份可读）；运行触发入口以 API 为主。`POST /api/flow/runs` 默认档位 `approval`，本机回环需先在 设置 > 管理接口 将该 action 调为 `allow`（或届时点审批）。

## A-01 真实流量入库并重放

对回上游 ROADMAP：请求重放（M1）＋请求中心（M2）＋运行记录（M10）主线。

- 前置条件：代理运行中、存在已抓到目标站点流量的活动 Session；工作区正常打开。
- 操作步骤：
  1. 日志表选中一条目标请求，右键「存入请求库」（或详情页入库入口）。
  2. 打开「请求库」窗口核对新条目：命名 `METHOD host+path`、来源徽标「抓包入库」、Headers/Query/Body/Response 四 tab 与原请求一致。
  3. 打开「工作流编辑器」新建流程，拖入一个「请求」节点并从请求库选中该条目，连接 开始 → 请求 → 结束，显式保存。
  4. 触发运行：`curl -X POST http://127.0.0.1:18089/api/flow/runs -H 'Content-Type: application/json' -d '{"workflowId":"<id>"}'`。
- 预期结果：
  - 返回立即给出 run id；`GET /api/flow/runs/{id}` 终态 `success`，`nodeRuns` 中请求节点有入参/返回值快照与耗时。
  - 活动 Session 新增一条 source=`ProxyCrabRequest` 的 capture，method/url 与入库条目一致。
  - 运行期间画布拦截结构性编辑（删除/连线/粘贴）并给单例提示，结束后解锁。
- 失败排查：`409 proxy_not_running` → 代理未启动，先启动代理再触发；`404` → workflowId 不存在或目标 Session 已归档，核对 ID 与 Session 状态。

## A-02 头保真（Origin/Referer/UA 与 Cookie 快照）

对回上游 ROADMAP：头保真与 Cookie 快照/自定义携带（M3）。

- 前置条件：A-01 条目已在库中且原请求携带 Origin/Referer/User-Agent/Cookie；代理运行中。
- 操作步骤：
  1. 编辑器选中该请求节点，配置抽屉展开「保真与 Cookie」：Origin/Referer/User-Agent 三项保持「捕获值」，Cookie 模式保持「快照」，保存。
  2. 触发运行（同 A-01 第 4 步）。
  3. Session 日志筛出新 capture，详情 Headers 与原请求逐项对比。
  4. 将 User-Agent 切为「自定义」填入 `flow-acceptance-agent`，再触发一次，核对新 capture。
- 预期结果：
  - 「捕获值」运行：Origin/Referer/User-Agent/Cookie 与捕获时逐字节一致（Rust 直发，无 forbidden header 删改）。
  - 「自定义」运行：新 capture 的 UA 为自定义值，其余两项仍为捕获值。
  - 节点返回值快照 status 与上游一致；4xx/5xx 不判节点失败（按 ReqFlow 语义交由断言/条件判定）。
- 失败排查：头被改写 → 检查节点「覆盖项」是否残留同名自定义头行（覆盖优先于保真）；Cookie 缺失 → 该条目入库时无 Cookie（抓包未解密成功）或 cookieMode 被切到自定义且值为空。
