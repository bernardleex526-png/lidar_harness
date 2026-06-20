// SLAM-style verification harness plugin
// 核心思想：每个阶段完成后做闭环验证 + 局部收紧，而非结束才验证
//
// ScanContext:  每阶段记录状态签名
// PGO:          检测漂移后只收紧受影响的部分
// 退化处理:      避免因中间步骤退化导致的后续步骤全部重做

import type { Plugin } from "@opencode-ai/plugin"

// ============================================================
// ScanContext — 阶段检查点标记
// ============================================================
// 模型在TodoWrite标记completed时，会自动触发ScanContext记录
// 实现方式: 注入指令让模型在每个completed时做一次自我验证

const SLAM_VERIFICATION_PROMPT = `
# SLAM Verification Protocol (阶段闭环验证)

## 工作机制
你在每个阶段完成后必须执行一次"闭环验证"（类似于SLAM中的ScanContext + PGO）。

## ScanContext（阶段检查点记录）
当你用TodoWrite将一个任务标记为completed时：
1. 用Read检查你刚刚修改过的文件
2. 确认修改内容是否符合该阶段的预期目标
3. 如果发现偏离，记录到问题列表

## PGO（局部收紧，不是全部重做）
当检测到偏离时：
- 你只需要修正当前阶段产生的错误部分
- 不要回退到任务起点
- 如果后续阶段未受偏离影响，不需要重做
- 收紧后继续下一阶段

## 示例流程
\`\`\`
Phase 1: 重构auth模块
  → completed → ScanContext检查 → 发现login函数签名改了但调用处没更新
  → PGO收紧: 只更新login的3个调用点 → 不碰其他代码
  → 继续Phase 2
\`\`\`

## 关键原则
- 如果收紧后偏离仍然存在 → 只重做当前阶段，不重做已完成阶段
- 如果验证完全通过 → 直接进入下一阶段
- 如果同一阶段连续3次收紧仍失败 → 向用户报告，请求人工干预
`

export default (async ({ client, project, directory, $ }) => {
  return {
    // 在每个对话轮次开始时注入SLAM验证指令
    "experimental.chat.system.transform": async (system) => {
      return `${system}\n\n${SLAM_VERIFICATION_PROMPT}`
    },
  }
}) satisfies Plugin
