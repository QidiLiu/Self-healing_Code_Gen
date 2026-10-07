# opencode SDK 2.x 迁移记录

本项目从 `@opencode-ai/sdk` 1.17.13 + opencode CLI 1.x 迁移到 `@opencode/sdk` 2.0.24 + opencode CLI 2.x。
这篇记录的是**实测踩到的坑**，不是 API 文档能查到的东西。

## 为什么必须迁移

SDK 1.x 的 `createOpencode` 等待子进程 stdout 出现 `opencode server listening` 才认为启动成功，
而 CLI 2.x 打印的是 `server listening on ...`。于是启动永远超时，项目在这台机器上完全跑不起来。
这是版本错配，不是代码缺陷。

## v1 → v2 的形态变化

| 维度 | v1 | v2 |
|------|----|----|
| 进程模型 | spawn 子进程 + HTTP | 进程内 host，不开监听端口 |
| 入口 | `createOpencode({port, config})` | `OpenCode.create({ database })` |
| 会话 | `client.session.*` | `client.sessions.*`（复数） |
| 目录参数 | `query: {directory}` | `location: {directory}` |
| 发 prompt | `body: {system, parts, model}` | `{sessionID, text}` |
| **system prompt** | `body.system` 字段 | **字段不存在**，只能走 agent 定义 |
| 取回复 | `result.data.parts` | `prompt()` → `wait()` → `message.list()` |
| 错误 | `result.data.info.error` | `message.error` / `idle.outcome === "failed"` |
| 用量 | `info.cost` / `info.tokens` | `message.cost` / `message.tokens` |
| Node | ≥ 20 | **≥ 24** |
| `--server-port` | 有意义 | **无意义**，已删除 |

## 坑 1：provider 目录需要显式连接才水合

进程刚起来时 `provider.list()` 和 `model.list()` 都返回空，哪怕凭据已经在库里。
`integration.connect.key()` 是触发水合的动作。

```ts
await client.integration.connect.key({ integrationID: "deepseek", key: "" })
await sleep(2000)
const models = await client.model.list({ location: { directory: ws } })  // 现在有数据了
```

## 坑 2：`connect.key()` 会抛异常但仍然生效

传一个假 key 时它返回 `Integration not found: deepseek`（或直接 reject），
可紧接着 `model.list()` 就有了数据。

**绝不能用返回值或异常判断成败**。唯一可信的信号是 `model.list()` 是否非空：

```ts
if (models.length === 0) {
  await client.integration.connect.key({ ... }).catch(() => {})  // 故意忽略错误
  // 轮询 model.list() 直到非空
}
```

`src/opencode.ts` 的 `ensureProvidersHydrated` 就是这么做的。

## 坑 3：`location.reload()` 会清空水合状态

调用 `location.reload()` 后，刚水合出来的 provider 和 model 全部归零。
**禁止在启动流程里调用它**。

## 坑 4：凭据靠共享同一个数据库

`~/.local/share/opencode/opencode.db` 里存着凭据、session 和 models.dev 目录
（`kv` 表的 `models-dev:catalog` 键，约 6 MB）。
把 `database.path` 指向它，`opencode auth login` 存的凭据就自动可见，
不需要把密钥复制到项目里。可用 `OPENCODE_DB_PATH` 覆盖。

## 坑 5：模型选择有两层，`config.model` 会被忽略

```ts
// 这样写，agent 和 model 都不会生效
await OpenCode.create({ config: { model: "...", agents: {...} } })
```

必须写进配置文件（`workspace/opencode.json`），opencode 才会读：

```json
{
  "model": "deepseek/deepseek-flash",
  "agents": { "probe": { "mode": "primary", "system": "..." } }
}
```

之后 `sessions.create({ agent: "probe" })` 才会拿到那个 agent，
`config.model` 也才会作为默认模型生效。

另外 `sessions.create` 可以显式传 `model: { id, providerID }`，此时 `variant` 会自动填 `"default"`。

## 坑 6：`config.update()` 不可用

```ts
await client.config.update({ value: { model: "..." } })
// InvalidRequestError: Missing key at ["shell"]
```

Effect Schema 要求完整对象（要带上 `shell`、`lsp` 等所有键），没法做部分更新。
配置只能在 `opencode.json` 里写。

## 坑 7：退出时的 native 崩溃

`node:sqlite` 和 `tree-sitter-*` 都是原生模块。如果在 host 还没拆完的时候
让进程退出，会随机 `SIGSEGV`（退出码 139）。

两个必要条件：

1. `npm install` 不能跳过原生编译。用 nvm 装的 node 需要让 node-gyp 找到头文件：
   ```bash
   export npm_config_nodedir="$(dirname "$(dirname "$(which node)")")"
   npm install
   ```
   直接 `npm install` 会报 `node-gyp` 下载头文件超时。

2. `close()` 必须 await，不能 fire-and-forget。`src/main.ts` 的 `gracefulShutdown`
   用 `Promise.race` 给它加了 5 秒上限，然后 `main()` 才返回退出码。

## 坑 8：`prompt()` 是异步投递，立即返回

`await sessions.prompt({...})` 成功只代表用户消息入队，**不代表模型回完了**。
顺序必须是：

```ts
await client.sessions.prompt({ sessionID, text })
await client.sessions.wait({ sessionID })
const msgs = await client.message.list({ sessionID })
const last = msgs.data.find((m) => m.type === "assistant")
```

失败信息在 assistant message 的 `error` 字段（形如
`{ type: "provider.auth", message, status: 403 }`），
或者一条 `type === "idle"` 且 `outcome === "failed"` 的消息。

## 当前使用的 API 速查

```ts
const client = await OpenCode.create({ database: { path: dbPath } })

// 会话
const s = await client.sessions.create({
  title, location: { directory }, model: { id, providerID }, agent,
})
await client.sessions.prompt({ sessionID: s.id, text })
await client.sessions.wait({ sessionID: s.id })
const msgs = await client.message.list({ sessionID: s.id })

// provider / model
await client.integration.list()
await client.integration.connect.key({ integrationID, key })   // 返回值不可信
await client.provider.list({ location: { directory } })
await client.model.list({ location: { directory } })
await client.agent.list({ location: { directory } })
await client.credential.list()

// trace（v1 没有的能力，现在有了）
for await (const item of client.session.log({ sessionID: s.id })) { /* ... */ }
```

## 为什么默认模型是 `deepseek-flash`

该 provider 下实测可用的模型：

| 模型 | 状态 | context | output | 价格 (in/out, USD per Mtok) |
|------|------|---------|--------|------------------------------|
| `deepseek-flash` | active, enabled | 1,000,000 | 393,216 | 0.15 / 0.60 |
| `deepseek-v4-pro` | active, enabled | 1,000,000 | 393,216 | 0.66 / 1.98 |

两个都能用。选 `deepseek-flash` 是按用户要求，它约为 `deepseek-v4-pro` 的 1/4.4 价格，
对「跑很多轮、每轮都要读一遍工作区」的自愈循环来说更合适。

（早期版本把默认值写成 `deepseek-v4-pro`，那是从模板里抄来的；两个模型都真实存在，
不存在「模型 id 不存在」的问题。）

