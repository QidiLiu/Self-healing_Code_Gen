# opencode SDK 完全教程：本项目实际使用的 API

本文只记录**本项目真正用到的** opencode SDK 2.x 接口，以及踩过的坑。
它替代了之前那份基于 SDK 1.x 的教程——那份里的 `createOpencode`、
`session.prompt({body:{parts}})`、`format: {type:"json_schema"}` 在当前版本都已失效。

完整踩坑记录见 [SDK_COMPAT.md](SDK_COMPAT.md)。

## 一、形态变化：进程内 host

SDK 1.x 会 spawn 一个 opencode 子进程，通过 HTTP 通信，并解析它的 stdout 判断启动成功。
2.x 完全不同：`OpenCode.create()` 在**本进程内**运行 opencode 的 HTTP 路由。

带来的直接后果：

- **没有端口**，也没有 `--server-port`（本项目已删除该参数）
- **没有子进程**，不需要重启逻辑
- **没有 stdout 解析**，不会再有「等不到 `opencode server listening` 而超时」
- Node 必须 **≥ 24**（内部用 `node:sqlite` 与 `await using`）

## 二、创建 host

```ts
import { OpenCode } from "@opencode/sdk"

const client = await OpenCode.create({
  database: { path: "~/.local/share/opencode/opencode.db" },
})
```

`database.path` 指向 opencode 的 SQLite 库。好处是**凭据、session、models.dev 目录
都在同一个库里**，所以 `opencode auth login` 存的密钥不用复制到项目里就能用。
可用环境变量 `OPENCODE_DB_PATH` 覆盖（见 `src/opencode.ts` 的 `opencodeDatabasePath`）。

关闭必须 `await`：

```ts
await client.close()
```

> 不要在 host 还在拆卸原生模块（`node:sqlite`、`tree-sitter-*`）时让进程退出，
> 会随机 `SIGSEGV`。本项目的 `gracefulShutdown` 用 `Promise.race` 给它加了 5 秒上限。

## 三、配置只能写在文件里

```ts
// 不生效：agent 和 model 都会被忽略
await OpenCode.create({ config: { model: "...", agents: { ... } } })
```

v2 从**配置文件**读 agent 定义和默认模型。本项目在启动时生成
`workspace/opencode.json`（见 `src/opencode.ts` 的 `writeAgentConfig`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-flash",
  "permission": { "edit": "allow", "bash": "allow", "webfetch": "allow" },
  "agents": {
    "planner": { "mode": "primary", "description": "...", "system": "..." },
    "generator": { "mode": "primary", "description": "...", "system": "..." },
    "evaluator": { "mode": "primary", "description": "...", "system": "..." }
  }
}
```

这让三个角色的 system prompt 有了正确的归宿：`sessions.prompt()` **没有 system 字段**，
所以角色人格不能塞在每次请求里，只能放在 agent 定义里。

## 四、provider 与凭据

凭据有三种提供方式：

```bash
# 1. CLI（推荐，落在共享 SQLite 库）
opencode auth login
opencode auth list

# 2. 环境变量
export DEEPSEEK_API_KEY=sk-xxx
```

```ts
// 3. 代码写入凭据库
await client.credential.create({
  integrationID: "deepseek",
  value: { type: "key", key: "sk-xxx" },
  label: "selfhealing",
})
```

查询可用的集成与模型：

```ts
const integrations = await client.integration.list()   // 目录，含每个集成的认证方式
const providers = await client.provider.list({ location: { directory } })
const models = await client.model.list({ location: { directory } })
```

### 关键陷阱：目录需要「水合」

进程刚起来时 `provider.list()` 与 `model.list()` 返回**空**，即使凭据已在库里。
必须触发一次连接：

```ts
await client.integration.connect.key({ integrationID: "deepseek", key: "" }).catch(() => {})
// 返回值与异常都不可信！只能靠 model.list() 是否非空来判断
```

- `connect.key()` **即使成功也会抛错/返回 `Integration not found`**，所以不能用返回值判断
- `location.reload()` 会**清空**刚水合的状态，绝对不能调用

`src/opencode.ts` 的 `ensureProvidersHydrated` 就是按这个规则实现的：轮询
`model.list()` 直到非空。

## 五、会话与提示

```ts
const session = await client.sessions.create({
  title: "Generator Session",
  location: { directory: workspacePath },
  model: { id: "deepseek-flash", providerID: "deepseek" },
  agent: "generator",
})
```

`prompt()` 是**异步投递**，`await` 它只代表用户消息入队：

```ts
await client.sessions.prompt({ sessionID: session.id, text: userPrompt })
await client.sessions.wait({ sessionID: session.id })     // 等模型跑完
const messages = await client.message.list({ sessionID: session.id })

const last = messages.data.find((m) => m.type === "assistant")
const text = (last.content ?? [])
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("")

if (last.error) {
  // { type: "provider.auth", message, status: 403 }
  throw new ProviderError(last.error.type, last.error.message, last.error.status)
}
```

失败**不会**抛异常，而是出现在 assistant message 的 `error` 字段，
或一条 `type === "idle"` 且 `outcome === "failed"` 的消息。这一点很重要：
不检查 `error` 就会把 provider 故障误判成「模型返回了空响应」，进而当成代码缺陷。

用量信息也在同一条消息上：`message.cost`、`message.tokens`。

## 六、实时 trace

v1 没有的流式接口，v2 有：

```ts
for await (const item of client.session.log({ sessionID: session.id })) {
  // item.type / item.properties
}
```

本项目用它把 Agent 的原始活动写入 `state/trace.md`（`AGENT_TRACE=1` 开启）。
这是诊断失败运行的关键：`state/log.md` 记录的是 harness 的决策，
只有 trace 记录的是 Agent 究竟调了哪些工具、写了哪些文件。

## 七、中断

所有请求接口都接受 `RequestOptions`：

```ts
await client.sessions.prompt({ sessionID, text }, { signal: abortSignal })
```

本项目把进程级的 shutdown signal 接到每个请求上（`setShutdownSignal`），
这样 Ctrl+C 能让飞行中的调用中止，而不是干等模型跑完。

> 实测：abort 能让循环较快退出，但若 10 秒内没退完，本项目会强制退出。
> 强制退出时原生模块可能还没来得及拆完。

## 八、本项目未使用但存在的接口

`worktree.*`、`pty.*`、`shell.*`、`mcp.*`、`vcs.*`、`websearch.*`、`form.*`、
`permission.*`、`integration.oauth.*`。需要时按 `location: { directory }` 的模式调用即可。
