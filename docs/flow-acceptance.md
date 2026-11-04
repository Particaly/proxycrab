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

对回上游 ROADMAP：请求重放（M1/M5）＋请求中心（M2）＋运行记录（M6/M17）主线。

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

对回上游 ROADMAP：重放头保真（M9-T3）＋Cookie 快照归一与自定义携带（M12-T3/M16-T3）。

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

## A-03 条件真/假走向

对回上游 ROADMAP：条件分支真/假双出口连线即分支（M16-T1）＋嵌套条件构建器（M16-T2，引擎侧 M7-T1）。

- 前置条件：代理运行中、活动 Session 正常；请求库内已有两条不同路径的条目（或用覆盖项改写 URL 制造差异）。
- 操作步骤：
  1. 建流程：请求 A → 条件节点；条件「真」出口连请求 B、「假」出口连请求 C，保存。
  2. 条件配置：条件构建器添加一行「左值 `{{ node.<A 的 refId>.status }}` ＋ 等于 ＋ 右值 `200`」，保存（落库为 `config.condition` 树＋编译表达式）。
  3. 先跑一次让 A 返回 200，再改右值为 `500` 跑一次（或在「覆盖项」把 A 的 URL 改成必 404 的路径）。
- 预期结果：
  - `GET /api/flow/runs/{id}`：第一次运行 B `success`、C `skipped`；第二次相反；条件节点按求值结果路由。
  - 画布上真/假出口带标签，未走分支的下游着色为跳过档。
  - `POST /api/workflows/{id}/validate` 返回空 issues；未带手柄的出边仍按「直通」语义放行（两边都执行）。
- 失败排查：两分支都执行 → 出边未挂真/假手柄（直通语义生效）；条件恒真/恒假 → 右值类型收敛（`100` 收敛为 number、文本 `'true'` 不命中布尔），布尔字段应使用「等于 true」。

## A-04 循环并发与取消

对回上游 ROADMAP：循环并发/CSV/限速（M10-T6）＋循环逐迭代调试（M13-T9）＋失败与取消（M5-T4）。

- 前置条件：代理运行中；请求库内有一条可重复打的目标（如回显类接口）；无其他运行在进行。
- 操作步骤：
  1. 建流程：循环节点 → 体内请求节点（URL 引用 `{{ var.loop }}`）→ 结束；循环 items 配 5 个不同路径片段，并发度 3，间隔 0。
  2. 触发运行；运行中调 `POST /api/flow/runs/{id}/cancel`。
  3. 再触发一次让其自然跑完（不取消）。
- 预期结果：
  - `GET /api/flow/runs/{id}`：循环节点 `iterations` 含逐轮 index/item/status/output/durationMs；并发 3 时可见多轮同时 `running`。
  - 取消后运行终态 `cancelled`（取消优先于失败），已完成轮次照常结算；再次 cancel 同一 run 返回 `404`（幂等不承诺）。
  - 自然跑完的运行终态 `success`，迭代明细与轮数一致。
- 失败排查：始终串行 → 未开启迭代变量作用域隔离时并发被门控为 1（隔离变量作用域是并发前置）；取消后仍 `running` → 当前节点为慢请求，等下一批次边界结算后再查。

## A-05 脚本写回环境变量

对回上游 ROADMAP：脚本注入 env 形参（M14-T2）＋脚本写回环境变量（M14-T3）。

- 前置条件：环境变量窗口已建集合 `dev` 并激活；代理运行中；请求库有一条返回 JSON（含 token 类字段）的条目。
- 操作步骤：
  1. 请求节点后置脚本写 `env.token = response.json.token`，保存；可先在脚本编辑器试跑（`POST /api/flow/script/dry-run`，默认 `approval`，脚本内容不进审批预览与日志）。
  2. 触发运行并等终态。
  3. `GET /api/env-sets` 查看 `dev` 集合；运行进行中把激活集合切到另一集合再观察。
- 预期结果：
  - `dev` 集合出现 `token` 键；同 run 下游节点与后续运行的 `{{ env.token }}` 都能读到新值。
  - 写回目标为派发时定格的集合：运行中切换激活集不影响本次写回去向，也不影响进行中 run 读到的快照。
  - 将 token 键加入 secret 表后重跑：节点快照与错误文本中该值显示 `******`（写回值动态并入掩码清单）。
- 失败排查：写回未出现 → 核对脚本是否真赋值（`undefined` 不产生写回）与目标集合 id 是否为派发时捕获的那个；新值未脱敏 → 动态新键默认落普通表，需手动标记 secret。

## A-06 运行中断与重启收敛

对回上游 ROADMAP：运行可恢复 checkpoint 与孤儿 `running` → `interrupted`（M9-T4）；本仓常驻进程形态下对应「管理进程重启扫描收敛」。

- 前置条件：代理运行中；已有一条可长时间挂起的流程（如延时节点 60s，或循环慢请求多轮）。
- 操作步骤：
  1. 触发运行，确认 `GET /api/flow/runs` 中该 run 为 `running` 且节点 checkpoint 陆续出现。
  2. 直接退出并重启 ProxyCrab（桌面端重开，或 CLI `run` 重启），不等运行结束。
  3. 重启完成后再次查询 `GET /api/flow/runs` 与 `GET /api/flow/runs/{id}`。
- 预期结果：
  - 该 run 终态为 `interrupted`，finish 时间被设置，错误为进程重启中断口径；停留 `running` 的节点 checkpoint 原样保留（运行详情中按中性档显示）。
  - 图快照仍随记录可读（建单时已捕获）；重放的 capture 记录不受重启改写。
  - 已知限制：引擎 `bodyBase64` 字节 body 重放按 UTF-8 文本有损处理（`ReplayBody` 无字节变体），二进制 body 场景不在本场景判定范围。
- 失败排查：重启后仍 `running` → 管理进程未真正重启（工作区未重新打开）；查询报 工作流运行记录库不可用 → `runs.db` 打开失败降级（运行功能整体不可用，查系统日志定位原因）。

## A-07 Agent 经 HTTP API 触发工作流（审批链）

对回上游 ROADMAP：MCP/Agent 操作入口的执行面（M19-T3 的 HTTP 等价物）；审批链复用既有管理接口权限体系（读 `allow`、触发/取消 `approval`，见 `docs/backend-api.md` Workflow runs 一节）。

- 前置条件：桌面端运行（审批窗可用）；已创建一个 API Key；代理运行中、活动 Session 正常。
- 操作步骤：
  1. 设置 > 管理接口 确认 `POST /api/flow/runs` 档位为 `approval`、`GET /api/flow/runs` 为 `allow`。
  2. `curl -X POST http://127.0.0.1:18089/api/flow/runs -H "Authorization: Bearer <key>" -H 'Content-Type: application/json' -d '{"workflowId":"<id>"}'`，在桌面审批窗选「仅本次允许」。
  3. 紧接着再触发一次，审批窗选「1 小时允许」；随后第三次触发（不带等待）。
  4. `curl http://127.0.0.1:18089/api/flow/runs -H "Authorization: Bearer <key>"` 查运行列表；再试 `POST /api/flow/runs/{id}/cancel`。
- 预期结果：
  - 第 2 步请求在审批窗挂起（≤30s），允许后返回 run 记录；拒绝或不决 30s 分别得到 `403 permission_denied` / `403 approval_timeout`。
  - 定时授权对同 identity+route 生效：第 3 步后的触发不再弹窗；该授权仅在内存，重启消失。
  - 列表读取直接放行；取消同样走审批档。
- 失败排查：`403 permission_denied` → 该 identity 此 action 被设为 `deny`（CLI 目标会把持久化 `approval` 判为 `deny`）；审批窗未弹 → 远端请求缺 `Authorization: Bearer` 或用了非桌面目标。

## A-08 外部 AI 经 MCP 触发工作流（档位与审批链）

> **依赖 Task 24/25 落地，当前为预留场景**（`POST /mcp` JSON-RPC 2.0 端点、策展工具面与三档开关均未实现）。以下按计划规格与上游 M19/DD-10 功能面（M19-T2 读 / T3 执行 / T4 写 / T6 档位与审计）编写；上游的宿主 MCP、桥侧工具声明、命令通道与长轮询形态不迁移。

- 前置条件（预留）：Task 24/25 已合入；管理服务运行中；MCP 客户端（或 curl 手拼 JSON-RPC）可用。
- 操作步骤（预留）：
  1. 客户端连 `POST /mcp`，完成 `initialize` 握手（协议版本协商），`tools/list` 核对工具面为策展子集（抓包读取/请求库/工作流列表·详情·保存·校验/运行触发·取消·记录查询；脚本库、权限、分享、CA、系统日志不出现）。
  2. 默认档位下（读开、写/执行关）：`tools/call` 调运行触发工具。
  3. 在设置中打开执行档后再次触发；审批窗弹出的场景下分别选「允许」与「拒绝/不决」。
  4. 关闭执行档复查：`tools/list` 不再出现执行类工具，且直接 `tools/call` 被硬拒（两层都测）。
- 预期结果（预留）：
  - 触发工具返回 run id，等价 `POST /api/flow/runs`；审批链复用既有体系（超时/被拒按 MCP `isError` 与可读原因返回，不静默降级）。
  - 档位更严者生效（与权限目录协同）；工具调用全量审计落工作区并可查。
- 失败排查（预留）：工具不可见 → 档位关闭（列表过滤层）或未鉴权；`isError` → 审批超时/被拒或越界参数，按返回原因处理。

## A-09 导入导出往返

对回上游 ROADMAP：流程导入导出（M7-T5）＋导入安全与 secret 剔除（M9-T5）。

- 前置条件：已有 A-01 流程；其中请求节点引用请求库条目；给流程加一段后置脚本与一个 secret 变量（用于审查与剔除核对）；目标项目已建。
- 操作步骤：
  1. `curl 'http://127.0.0.1:18089/api/workflows/export?ids=<wf-id>' -o export.json`（默认 `allow`），核对信封：`format:"reqflow-workflow"`、`requests` 原样携带被引用条目、secret 变量值置空、环境集整体剔除 secret 表。
  2. 不带 `confirmScripts` 导入：`POST /api/workflows/import` body `{file:export.json, projectId:"<pid>"}`。
  3. 再以 `confirmScripts:true` + `confirmedScripts:["<workflowIndex>:<nodeIndex>:postProcess"]` 重导一次。
  4. 打开导入的两条流程核对：节点 id/refId/边 id 已重生成、重名加 `(导入 N)` 后缀、请求引用解析到新入库条目；运行一次验证。
- 预期结果：
  - 第 2 步导入的副本脚本被整字段置空（节点保留不中止）；第 3 步指定键的脚本逐字保留。
  - 返回 `{imported, skipped, requests:{imported,skipped}, envSets}`；与现有条目 id 冲突的 requests/envSets 被 skip 且不覆盖现有数据。
  - 往返后的流程可运行且结果与原流程一致。
- 失败排查：`400 bad_request` → 信封形状/版本不符（勿手改导出文件关键字段）；请求引用断开 → requests 条目被 skip（id 冲突），核对返回里的 skip 原因。

## A-10 请求库导入三格式入库核对

对回上游 ROADMAP：cURL/HAR 导入（M7-T3）；Postman v2.1 解析随导入对话框落地（计划 Task 8）。

- 前置条件：代理无需运行；请求库窗口可用；准备三份源样本（一条浏览器复制的 cURL、一个 HAR 文件、一个 Postman Collection v2.1）。
- 操作步骤：
  1. 请求库窗口打开「导入」对话框，切换粘贴/文件两种输入方式。
  2. cURL：粘贴含 `-X/-H/-d/--data-urlencode/-b` 的命令，核对预览的 method/url/headers/body 后导入。
  3. HAR：选择文件导入（含多 entry），核对预览条目数；Postman：导入 Collection，核对逐请求预览。
  4. 三者统一打标签 `import-check` 后入库；在列表按标签过滤并打开详情核对四 tab。
  5. 同源重复导入一次，核对去重策略（预览提示/重名后缀）。
- 预期结果：
  - 三种格式均生成条目：来源徽标「导入」、命名 `METHOD host+path`（重名加数字后缀）、头/查询/body 与源一致。
  - HAR 大 body 按 64KB 安全截断且条目仍可用；标签过滤可命中全部三条。
- 失败排查：cURL 解析缺头 → 多行续行/引号被 shell 或剪贴板破坏，重贴原文；HAR 条目数偏少 → WebSocket/CONNECT 类条目被过滤属预期，核对源文件类型。

## A-11 环境变量集激活切换与 secret 脱敏显示

对回上游 ROADMAP：环境变量集（M10-T4）＋secret 变量全链路脱敏（M9-T5）。

- 前置条件：环境变量窗口可用（Backend 提供 `envSets` 能力位）；请求库有一条目标条目。
- 操作步骤：
  1. 建两个集合 `dev`/`prod`：各含普通变量 `baseUrl` 与 secret 变量 `apiToken`（值不同）。
  2. `GET /api/env-sets` 核对：`secretValues` 全部显示 `******`，普通值明文。
  3. 激活 `dev`；建流程：请求节点 URL 写 `{{ env.baseUrl }}/path`、头写 `{{ env.apiToken }}`，运行；再激活 `prod` 重跑一次。
  4. 再做一次运行中切换（dev 运行未结束时切到 prod）。
  5. 掩码往返：`PUT /api/env-sets/{id}` 把读到的 `******` 原样回传，另一次显式给新值。
- 预期结果：
  - 两次运行的 capture URL/host 分别命中 dev 与 prod 的值；运行中切换不影响进行中 run（派发时冻结），下一次运行才生效。
  - 掩码 `******` 回传不损坏 secret（读改写往返后 `GET` 仍掩码、重放仍用原值）；显式新值覆盖原值。
  - 删除激活集合自动清激活偏好；工作流导出信封不含 secret 表。
- 失败排查：模板渲染为空 → 未激活集合或变量名大小写不符；secret 意外变更 → 上一步误用显式新值覆盖（预期行为），重新录入即可。
