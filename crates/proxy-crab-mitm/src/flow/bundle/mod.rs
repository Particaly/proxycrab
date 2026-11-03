//! flow-engine JS 载荷（ReqFlow 复刻计划 Task 2 Step 4）。
//!
//! [`FLOW_ENGINE_JS`] 为 `flow-engine/`（TS 源码，见仓库根目录）经 esbuild
//! 打包的单文件产物（IIFE，target es2022，不压缩以保持可审查；构建命令
//! `pnpm flow:build`，产物提交入库——`cargo build` 不依赖 node 构建链，
//! 沿用 CLI 嵌入 dist 的先例）。运行时（[`super::runtime`]）以普通脚本 eval
//! 加载：IIFE 把引擎对外契约（`runWorkflow` / `evaluateCondition` /
//! `renderTemplate` / `validateWorkflowGraph` / `buildReplayRequest` 与
//! 条件编译、断言 / 转换 / 循环语义）挂到全局 `__flowEngine`，
//! 宿主桥为本文件所在 crate 注入的全局 `host` 对象。

/// flow-engine 构建产物（esbuild 单文件，全局导出 `__flowEngine`）。
pub const FLOW_ENGINE_JS: &str = include_str!("engine.js");

#[cfg(test)]
mod tests {
    use super::FLOW_ENGINE_JS;

    /// 载荷已随构建更新：包含对外契约全局名与全部节点类型的 runner 装配
    /// （防止 include_str! 引用被误删 / 构建产物回退为空壳）。
    #[test]
    fn payload_contains_contract_global_and_runners() {
        assert!(
            FLOW_ENGINE_JS.contains("__flowEngine"),
            "payload must expose __flowEngine"
        );
        assert!(
            FLOW_ENGINE_JS.contains("runWorkflow"),
            "payload must export runWorkflow"
        );
        assert!(
            FLOW_ENGINE_JS.contains("httpReplay"),
            "payload must assemble the httpReplay runner"
        );
    }
}
