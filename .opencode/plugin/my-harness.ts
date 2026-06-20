// 个人 harness 扩展插件
// 放在项目目录: .opencode/plugin/my-harness.ts
// 或全局目录: ~/.config/opencode/plugin/my-harness.ts

import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ client, project, directory, $ }) => {
  return {
    // ============================
    // 1. 修改系统提示词（每次注入前触发）
    // ============================
    "experimental.chat.system.transform": async (system) => {
      // 在默认 system prompt 前追加你的规则
      return `你所有回答必须以中文回复。遇到不确定的事情必须明确说"我不确定"。\n\n${system}`
    },

    // ============================
    // 2. 拦截工具调用（执行前检查）
    // ============================
    "tool.execute.before": async (input, output) => {
      // 示例：禁止删除 .env 文件
      if (input.name === "bash" && input.args.command.includes(".env")) {
        throw new Error("不允许操作 .env 文件")
      }
      // 示例：为所有 bash 命令添加超时
      if (input.name === "bash" && !input.args.timeout) {
        output.args.timeout = 30000
      }
    },

    // ============================
    // 3. 修改聊天参数
    // ============================
    "chat.params": async (params) => {
      // 统一设置 max_tokens，避免被切断
      params.max_tokens = 16000
    },

    // ============================
    // 4. 修改 HTTP 请求头
    // ============================
    "chat.headers": async (headers) => {
      // 注入自定义 header（如果需要）
      // headers["X-Custom-Header"] = "value"
    },

    // ============================
    // 5. 注册自定义工具（如果需要）
    // ============================
    // tool: {
    //   my_tool: {
    //     description: "我的自定义工具",
    //     parameters: { type: "object", properties: {} },
    //     execute: async (args) => "done"
    //   }
    // }
  }
}) satisfies Plugin
