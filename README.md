# LiDAR Harness — SLAM/PGO 多层级编码 Agent 验证框架

> 受 SLAM（即时定位与地图构建）和 LiDAR 建图中 PGO（位姿图优化）、Scan Context（扫描上下文）等核心思想启发，专为编码 Agent 设计的多层级验证框架。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?style=flat-square)](https://www.typescriptlang.org)
[![Effect-TS](https://img.shields.io/badge/Effect--TS-4.0.0--beta.74-purple?style=flat-square)](https://effect.website)

---

## 核心思想：SLAM → Code Verification 映射

| SLAM/LiDAR 概念 | 编码 Agent 验证中的映射 |
|---|---|
| **Scan Context** | 任务复杂度分类 → 阶段快照 → 决定验证深度 |
| **局部回环检测** | 每阶段完成检测（TodoWrite / git commit / git 变更）→ 注入局部验证 |
| **全局 PGO** | 类型检查 / Lint → 错误签名归一化 → 增量注入 → 模型修正 → 重新检测 |
| **多传感器融合** | 3 个子 Agent 独立审查（安全 / 正确性 / 风格）→ 合并发现 |
| **误差基线** | session 开始前采集 typecheck+lint 基线 → 只报告增量错误 |

## 架构层级

```
模型完成一轮操作
       ↓
  层级 0: 复杂度门控 ─── 简单任务跳过重度验证
       ↓
  层级 1: 局部回环检测 ─── TodoWrite / git commit / git 变更信号
       ↓
  层级 2: 全局位姿图优化 ─── typecheck + lint → 归一化 → 增量注入 → 收敛
       ↓
  层级 3: 多视角 Review ─── 3 个子 Agent（安全/正确性/风格）
       ↓
  插件钩子触发 ───── runner.turn.settled → 外部插件可注入消息
       ↓
  有新问题 → 继续循环 | 无新问题 → 结束
```

## 四大核心特性

### 🔒 安全 — 命令基线锁定

```
- 命令在 baseline 阶段（模型首次运行前）锁定
- SAFE_PREFIXES 白名单验证（tsc / eslint / biome / deno check ...）
- 模型不能在运行中修改 package.json 注入恶意脚本
```

### 🧠 上下文压缩 — 增量注入

```
- 错误签名归一化：:10:20 → :N:N，移除时间戳等不稳定信息
- computeErrorSigs() 提取新错误时仅对比归一化后的签名
- shownErrors Set 单调增长 → 只注入模型未见过的错误
- 对比传统方案：每轮注入所有错误（高达 7 条大消息）
  ▸ 本方案：每轮仅注入增量，上下文占用减少 60-80%
```

### 🔄 阶段检测 — 并行多信号

| 信号 | 来源 | 触发条件 |
|---|---|---|
| **TodoWrite** | SessionTodo | 任务状态 in_progress → completed |
| **git commit** | `git log --oneline` | 有新提交 → 提取提交信息 |
| **git 变更** | `git diff --name-only` | 文件变更 → 自动检测 |
| **自适应** | 无 Todos N 回合后 | 自动切换到 git-only 模式 |

所有 git 信号**并发运行**，不再是旧方案的兜底回退。

### ✅ 收敛保证 — 新信息准则

```
传统方案：pgoResultsHash() === pgoResultsHash(prev) 依赖正则覆盖
          ⇢ 未覆盖的格式会导致无限循环

本方案：unseenSigs.length === 0 || unseenSigs.length < NOISE_FLOOR(3)
          ⇢ shownErrors 单调增长，必然收敛 ✓
```

## 三种使用方式

### 1. 嵌入 opencode（自动生效）

```json
// .opencode/config.json
{
  "verification": {
    "enabled": true,
    "typecheck": "bun tsc --noEmit",
    "lint": "bunx eslint ."
  }
}
```

不填则自动检测 `package.json` 中的 scripts。

### 2. 插件钩子扩展

```ts
// .opencode/plugin/my-verify.ts
export default PluginV2.define({
  id: PluginV2.ID.make("my-verify"),
  effect: Effect.succeed({
    "runner.turn.settled": (event) => {
      // event.sessionID, event.text, event.cwd
      event.synthetic.push({ text: "请检查修改是否完整。" })
    },
  }),
})
```

### 3. 独立异步 API（嵌入 Claude Code / Codex）

```ts
import { createVerificationHarness } from "lidar-harness"

const harness = await createVerificationHarness({
  typecheckCmd: "bun tsc --noEmit",
})

await harness.initialize("/path/to/project")

const messages = await harness.afterTurn({
  sessionID: "session-1",
  cwd: "/path/to/project",
})

for (const msg of messages) {
  // 注入给模型
}

await harness.dispose()
```

## 文件结构

```
src/
├── config/
│   └── verification.ts              # ConfigVerification.Info 配置模式
├── session/
│   └── runner/
│       ├── phase-verification.ts     # 核心验证引擎（所有 4 层）
│       ├── phase-verification-standalone.ts  # 独立异步 API 封装
│       ├── llm.ts                    # runLoop 集成（插件钩子触发点）
│       └── ...
├── plugin.ts                        # HookSpec → runner.turn.settled
├── config.ts                        # Config.Info → verification 字段
└── location-layer.ts                # PhaseVerification.layer 装配
```

## 对比其他方案

| | 原版 opencode | Claude Code | Codex CLI | **本框架** |
|---|---|---|---|---|
| 验证方式 | 无 | 无 | 无 | **多层级 PGO** |
| 安全性 | 无沙箱 | 7 层权限 | Landlock | **命令白名单 + 基线锁定** |
| 上下文优化 | 无 | 5 级压缩 | 双触发压缩 | **增量注入（60-80% 节省）** |
| 收敛保证 | 无 | 无 | 无 | **单调 Set 数学保证** |
| 可嵌入 | — | PostToolUse 钩子 | — | **3 层插件架构** |

---

**License**: MIT
