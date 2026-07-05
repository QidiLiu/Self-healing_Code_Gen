# opencode SDK 完全教程：从入门到实战

本文将带你从零开始掌握 opencode JS/TS SDK，通过丰富的代码案例学会如何编程式地控制 opencode 服务器。

---

## 一、什么是 opencode SDK？

opencode JS/TS SDK 是一个类型安全的客户端，用于与 opencode 服务器进行交互。你可以用它来构建集成方案，并以编程方式控制 opencode。简单来说，它让你能够**用代码调用 AI 编程助手的能力**，而不仅仅是使用终端 TUI。

**适用场景**：
- 自动化代码审查或文档生成
- 将 AI 编程能力集成到自己的工具或平台中
- 批量处理多个会话
- 构建 CI/CD 流水线中的 AI 辅助步骤

---

## 二、安装与环境准备

### 1. 安装 SDK

```bash
npm install @opencode-ai/sdk
```

### 2. 安装 opencode CLI（可选但推荐）

```bash
curl -fsSL https://opencode.ai/install | bash
```

### 3. 配置 API 密钥

opencode 支持 75+ 个 LLM 提供商。以 Anthropic 为例：

```bash
export ANTHROPIC_API_KEY=your_api_key_here
```

以 OpenAI 为例：

```bash
export OPENAI_API_KEY=your_api_key_here
```

你也可以在 `opencode.json` 配置文件中统一管理密钥。

---

## 三、创建客户端

### 方式一：自动启动服务器（全自动模式）

这种方式会**同时启动服务器和客户端**：

```typescript
import { createOpencode } from "@opencode-ai/sdk"

const { client, server } = await createOpencode()

console.log(`服务器运行在: ${server.url}`)

// 使用完毕后关闭服务器
server.close()
```

### 方式二：带配置启动

你可以传入配置对象，覆盖 `opencode.json` 中的设置：

```typescript
import { createOpencode } from "@opencode-ai/sdk"

const { client, server } = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022",
  },
})

console.log(`服务器运行在: ${server.url}`)
server.close()
```

### 方式三：仅客户端模式（连接已有服务器）

如果你已经有一个正在运行的 opencode 实例，可以直接连接：

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
})
```

**配置选项说明**：

| 选项 | 类型 | 描述 | 默认值 |
|------|------|------|--------|
| `hostname` | string | 服务器主机名 | 127.0.0.1 |
| `port` | number | 服务器端口 | 4096 |
| `signal` | AbortSignal | 取消操作的中止信号 | undefined |
| `timeout` | number | 服务器启动超时（毫秒） | 5000 |
| `config` | Config | 配置对象 | {} |
| `baseUrl` | string | 已有服务器的 URL | http://localhost:4096 |

---

## 四、基础 API 调用

### 1. 检查服务器健康状态

```typescript
const health = await client.global.health()
console.log(health.data)
// 输出: { healthy: true, version: "x.x.x" }
```

### 2. 获取配置信息

```typescript
const config = await client.config.get()
console.log("当前配置:", config.data)

const providers = await client.config.providers()
console.log("可用提供商:", providers.data.providers)
console.log("默认模型:", providers.data.default)
```

### 3. 列出可用的 Agent

```typescript
const agents = await client.app.agents()
console.log("可用 Agent:", agents.data)
```

### 4. 写入日志

```typescript
await client.app.log({
  body: {
    service: "my-app",
    level: "info",
    message: "操作完成",
  },
})
```

---

## 五、会话管理（核心功能）

### 1. 创建会话

```typescript
const session = await client.session.create({
  body: { title: "我的第一个 AI 会话" },
})

console.log("会话 ID:", session.data.id)
```

### 2. 列出所有会话

```typescript
const sessions = await client.session.list()
console.log("所有会话:", sessions.data)
```

### 3. 获取会话详情

```typescript
const sessionDetail = await client.session.get({
  path: { id: sessionId },
})
console.log("会话详情:", sessionDetail.data)
```

### 4. 发送提示词（最常用）

向会话发送提示词，获取 AI 回复：

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "用 TypeScript 写一个快速排序函数" }],
  },
})

console.log("AI 回复:", result.data)
```

### 5. 指定模型发送提示词

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    model: {
      providerID: "anthropic",
      modelID: "claude-3-5-sonnet-20241022",
    },
    parts: [{ type: "text", text: "解释什么是闭包" }],
  },
})
```

### 6. 仅注入上下文（不触发 AI 回复）

当 `noReply: true` 时，仅将内容作为上下文注入，适合插件场景：

```typescript
await client.session.prompt({
  path: { id: sessionId },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "你是一个资深的 Python 专家" }],
  },
})
```

### 7. 执行 Shell 命令

```typescript
const result = await client.session.shell({
  path: { id: sessionId },
  body: { command: "ls -la" },
})
console.log("命令输出:", result.data)
```

### 8. 中止正在运行的会话

```typescript
await client.session.abort({
  path: { id: sessionId },
})
```

### 9. 删除会话

```typescript
await client.session.delete({
  path: { id: sessionId },
})
```

---

## 六、文件操作

### 1. 读取文件

```typescript
const content = await client.file.read({
  query: { path: "src/index.ts" },
})
console.log("文件内容:", content.data.content)
```

### 2. 搜索文件中的文本

```typescript
const results = await client.find.text({
  query: { pattern: "function.*opencode" },
})
console.log("搜索结果:", results.data)
// 返回包含 path、lines、line_number 等信息的匹配数组
```

### 3. 按名称查找文件

```typescript
// 查找所有 TypeScript 文件
const files = await client.find.files({
  query: { query: "*.ts", type: "file" },
})
console.log("找到的文件:", files.data)

// 查找目录
const directories = await client.find.files({
  query: { query: "packages", type: "directory", limit: 20 },
})
console.log("找到的目录:", directories.data)
```

### 4. 查找工作区符号

```typescript
const symbols = await client.find.symbols({
  query: { query: "main" },
})
console.log("符号:", symbols.data)
```

### 5. 获取文件状态

```typescript
const status = await client.file.status()
console.log("文件状态:", status.data)
```

---

## 七、结构化输出（JSON Schema）

这是 SDK 最强大的功能之一——让 AI 返回符合指定 JSON Schema 的**结构化数据**。

### 基本用法

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [
      {
        type: "text",
        text: "研究 Anthropic 公司并提供公司信息",
      },
    ],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "公司名称",
          },
          founded: {
            type: "number",
            description: "成立年份",
          },
          products: {
            type: "array",
            items: { type: "string" },
            description: "主要产品",
          },
          ceo: {
            type: "string",
            description: "CEO 姓名",
          },
        },
        required: ["company", "founded", "products"],
      },
      retryCount: 3, // 验证重试次数，默认 2
    },
  },
})

// 访问结构化输出
console.log(result.data.info.structured_output)
// {
//   company: "Anthropic",
//   founded: 2021,
//   products: ["Claude", "Claude API"],
//   ceo: "Dario Amodei"
// }
```

### 错误处理

如果模型在所有重试后仍无法生成有效的结构化输出，响应中会包含错误信息：

```typescript
if (result.data.info.error?.name === "StructuredOutputError") {
  console.error("结构化输出失败:", result.data.info.error.message)
  console.error("重试次数:", result.data.info.error.retries)
}
```

### 最佳实践

1. 在 Schema 属性中提供**清晰的描述**，帮助模型理解需要提取的数据
2. 使用 `required` 指定哪些字段**必须存在**
3. 保持 Schema **简洁** — 复杂的嵌套 Schema 可能让模型难以正确填充
4. 设置合适的 `retryCount` — 复杂 Schema 可增加重试次数

---

## 八、TUI 控制

你可以通过 SDK 远程控制 opencode 的终端界面：

```typescript
// 向提示词追加文本
await client.tui.appendPrompt({
  body: { text: "请帮我审查这段代码" },
})

// 提交当前提示词
await client.tui.submitPrompt()

// 清空提示词
await client.tui.clearPrompt()

// 显示 Toast 通知
await client.tui.showToast({
  body: {
    message: "任务已完成",
    variant: "success",
  },
})

// 打开各种选择器
await client.tui.openHelp()
await client.tui.openSessions()
await client.tui.openModels()
```

---

## 九、实时事件订阅

订阅服务器发送的事件流，实现实时监听：

```typescript
const events = await client.event.subscribe()

for await (const event of events.stream) {
  console.log("事件类型:", event.type)
  console.log("事件数据:", event.properties)
}
```

---

## 十、错误处理

SDK 可能会抛出错误，建议使用 try-catch 统一处理：

```typescript
try {
  const session = await client.session.get({
    path: { id: "invalid-id" },
  })
} catch (error) {
  console.error("获取会话失败:", (error as Error).message)
}
```

---

## 十一、完整实战案例

### 案例：自动化代码审查工具

这个案例展示如何用 SDK 构建一个自动化的代码审查工具：

```typescript
import { createOpencode } from "@opencode-ai/sdk"
import fs from "fs"

async function codeReview(filePath: string) {
  // 1. 启动客户端
  const { client, server } = await createOpencode({
    config: {
      model: "anthropic/claude-3-5-sonnet-20241022",
    },
  })

  try {
    // 2. 读取目标文件
    const fileContent = await client.file.read({
      query: { path: filePath },
    })

    // 3. 创建会话
    const session = await client.session.create({
      body: { title: `代码审查: ${filePath}` },
    })
    const sessionId = session.data.id

    // 4. 发送审查请求（结构化输出）
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: `请审查以下代码，找出潜在的问题、性能瓶颈和安全隐患：

\`\`\`typescript
${fileContent.data.content}
\`\`\`

请以 JSON 格式返回审查结果。`,
          },
        ],
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              issues: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    severity: {
                      type: "string",
                      enum: ["critical", "high", "medium", "low"],
                      description: "问题严重程度",
                    },
                    line: { type: "number", description: "问题所在行号" },
                    description: { type: "string", description: "问题描述" },
                    suggestion: { type: "string", description: "修复建议" },
                  },
                  required: ["severity", "description", "suggestion"],
                },
              },
              summary: { type: "string", description: "总体评价" },
              score: {
                type: "number",
                minimum: 0,
                maximum: 100,
                description: "代码质量评分",
              },
            },
            required: ["issues", "summary", "score"],
          },
          retryCount: 3,
        },
      },
    })

    // 5. 输出审查结果
    const review = result.data.info.structured_output
    console.log("📊 代码质量评分:", review.score)
    console.log("📝 总体评价:", review.summary)
    console.log("🐛 发现的问题:")

    review.issues.forEach((issue: any, index: number) => {
      const emoji =
        issue.severity === "critical"
          ? "🔴"
          : issue.severity === "high"
            ? "🟠"
            : issue.severity === "medium"
              ? "🟡"
              : "🟢"
      console.log(`  ${index + 1}. ${emoji} [${issue.severity}] ${issue.description}`)
      if (issue.line) console.log(`     行 ${issue.line}`)
      console.log(`     建议: ${issue.suggestion}`)
    })

    // 6. 保存审查报告
    const report = {
      file: filePath,
      reviewedAt: new Date().toISOString(),
      score: review.score,
      summary: review.summary,
      issues: review.issues,
    }
    fs.writeFileSync(
      `review-${Date.now()}.json`,
      JSON.stringify(report, null, 2),
    )
    console.log("📄 审查报告已保存")

    return report
  } catch (error) {
    console.error("审查失败:", (error as Error).message)
  } finally {
    server.close()
  }
}

// 运行审查
codeReview("src/index.ts").catch(console.error)
```

### 案例：批量文档生成器

```typescript
import { createOpencode } from "@opencode-ai/sdk"

async function generateDocsForFiles(filePaths: string[]) {
  const { client, server } = await createOpencode()

  try {
    const session = await client.session.create({
      body: { title: "批量文档生成" },
    })
    const sessionId = session.data.id

    for (const filePath of filePaths) {
      console.log(`📄 正在处理: ${filePath}`)

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: "text",
              text: `为以下代码文件生成详细的 API 文档（包括函数说明、参数、返回值、使用示例）：

文件路径: ${filePath}
请用 Markdown 格式输出。`,
            },
          ],
        },
      })

      // 获取 AI 生成的文档
      const doc = result.data.info.text
      console.log(`✅ 文档生成完成: ${filePath}`)

      // 这里可以保存文档到文件
      // fs.writeFileSync(`${filePath}.md`, doc)
    }

    console.log("🎉 所有文档生成完成！")
  } finally {
    server.close()
  }
}

generateDocsForFiles(["src/utils.ts", "src/api.ts", "src/models.ts"])
```

---

## 十二、总结

| 功能模块 | 核心方法 | 用途 |
|----------|----------|------|
| **健康检查** | `global.health()` | 检查服务器状态 |
| **会话管理** | `session.create()`, `session.prompt()` | 创建会话、发送提示词 |
| **文件操作** | `file.read()`, `find.text()` | 读取文件、搜索内容 |
| **结构化输出** | `format: { type: "json_schema" }` | 让 AI 返回结构化 JSON |
| **实时事件** | `event.subscribe()` | 监听服务器事件流 |
| **TUI 控制** | `tui.*` | 远程控制终端界面 |

opencode SDK 将强大的 AI 编程能力封装为类型安全的 API，让你可以**用代码驱动 AI 完成各种编程任务**——从代码审查、文档生成到自动化重构，想象空间无限。

