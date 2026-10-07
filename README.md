# Self-healing Code Generator

基于 [opencode SDK](https://opencode.ai) 的自我调试修复自动 Agent 系统。三角色协作（Planner / Generator / Evaluator），根据需求文档自主实现功能，遇到错误自动修复，直到达成目标或明确报告卡点。

## 架构设计

遵循 [doc/LOOP_PRINCIPLES.md](doc/LOOP_PRINCIPLES.md) 的循环哲学：

```
┌─────────────────────────────────────────────────┐
│  LOAD checkpoint → 确定从哪个阶段恢复              │
│                                                   │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐  │
│  │ PLANNER  │──▶│ GENERATOR │──▶│ EVALUATOR  │  │
│  │ 分析需求  │   │ 写代码    │   │ 验证+评分   │  │
│  │ 产契约    │   │           │   │            │  │
│  └──────────┘   └───────────┘   └────────────┘  │
│       ▲               ▲               │         │
│       │               │         通过？  │         │
│       │  重新规划      │      ┌────┴────┐       │
│       ├───────────────┘      │YES │NO  │       │
│       │                      │    │    │       │
│       │                      ▼    ▼    │       │
│  ┌────┴────┐            成功报告  ┌───────────┐ │
│  │ 卡住？  │                      │ 修复循环   │ │
│  │ YES→USER│                      │ 错误回灌   │ │
│  │ NO→重试  │                      │  Generator │ │
│  └─────────┘                      └───────────┘ │
└─────────────────────────────────────────────────┘
```

### 三角色分离

| 角色 | System Prompt | 职责 | 约束 |
|------|--------------|------|------|
| **Planner** | 技术架构师 | 将模糊需求分解为可验证的契约条款 | 不动代码，只产出 contract |
| **Generator** | 代码执行者 | 按契约束编写实现 | **禁止评价自己的代码** |
| **Evaluator** | 验尸官 | 运行测试、检查边界条件 | 默认代码有 bug，证明它 |

三个角色使用三个独立的 opencode session，通过文件系统通信（`state/contract.md`、`state/evaluation.json`），不依赖上下文窗口记忆。

### 自愈合机制

1. Evaluator 返回失败 → 记录具体错误
2. 错误格式化后发给 Generator 修复（同一 session 续接）
3. 重新进入 Evaluator 验证
4. 同一错误重复 ≥maxRetries 次 → 触发 Planner 重新规划
5. 重新规划后仍失败 ≥maxReplans 次 → 判定卡住，生成用户报告

### 状态持久化

崩溃后重启可从断点继续运行。

| 文件 | 用途 |
|------|------|
| `state/checkpoint.json` | 当前阶段、session ID、重试计数 |
| `state/contract.json` | 契约的 JSON 格式 |
| `state/contract.md` | 可验证的契约检查清单 (Markdown) |
| `state/progress.md` | 当前进度摘要 |
| `state/log.md` | 追加式操作日志（`## [TIMESTAMP] ROLE \| action`） |
| `state/evaluation.json` | 最新评估结果 |
| `state/debug/` | JSON 解析失败的原始响应 |
| `state/errors.jsonl` | 非代码原因导致的失败（provider 报错、响应无法解析） |
| `state/usage.json` | 本次运行的请求数与 token / 花费累计 |
| `state/requirements.bak.md` | 回复指令改写需求前的备份 |

## 快速开始

### 前置条件

- Node.js >= 20
- [opencode CLI](https://opencode.ai) 已安装
- DeepSeek API Key（或其他 opencode 支持的提供商）

> **注意**：本项目依赖 `@opencode-ai/sdk` 1.x。请确认已安装的 opencode CLI 与之匹配；
> CLI 2.x 改变了 serve 的启动输出格式，SDK 1.x 无法解析，服务器会一直等待超时。

### 安装

```bash
git clone <repo>
cd Self-healing_Code_Gen
npm install
npm run build
```

### 配置

API Key 按以下顺序解析，命中即止：

| 顺序 | 来源 | 示例 |
|------|------|------|
| 1 | `--api-key` | `--api-key sk-xxx` |
| 2 | `--api-key-env` | `--api-key-env MY_KEY`，读指定环境变量 |
| 3 | `meta/config.ini` | `[model] api_key =` |
| 4 | 环境变量 | 由模型推导：`deepseek/x` → `DEEPSEEK_API_KEY` |
| 5 | key 文件 | `doc/DEEPSEEK_KEY.md`，可含代码围栏与注释行 |

启动时会打印实际命中的来源（不会打印 key 本身），随后执行 provider 预检：
provider 是否可用、key 是否生效、模型 id 是否存在。任何一项不通过会在几秒内失败，
而不是等规划阶段返回一段无法解析的 JSON。

### 使用

将需求写入 `requirements/current.md`，然后运行：

```bash
npm start          # 使用编译后的 JS (需先 build)
npm run dev        # 编译并直接运行
npx tsx src/main.ts  # 直接用 tsx 运行 TypeScript
```

或指定需求文件和参数：

```bash
npx tsx src/main.ts --requirements ./my-project.md --model deepseek/deepseek-v4-pro
```

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--requirements` | `requirements/current.md` | 需求文件路径 |
| `--workspace` | `workspace/` | 工作区目录（存放生成的代码） |
| `--state-dir` | `state/` | 状态持久化目录 |
| `--output-dir` | `output/` | 报告输出目录 |
| `--model` | `deepseek/deepseek-v4-pro` | 使用的模型 (`provider/model`) |
| `--api-key` | 无 | API Key |
| `--api-key-env` | 无 | 从指定环境变量读取 API Key |
| `--key-file` | `doc/DEEPSEEK_KEY.md` | API Key 文件路径 |
| `--base-url` | 无 | 自定义 API 地址 |
| `--server-port` | `4096` | opencode 服务端口（本机已跑 opencode 时需改） |
| `--max-retries` | `4` | 触发重新规划前的最大修复尝试次数 |
| `--max-replans` | `2` | 判定"卡住"前的最大重新规划次数 |
| `--max-infra-errors` | `3` | 连续 provider 故障次数，超过即判定卡住（**不计入**修复预算） |
| `--max-total-iterations` | `(retries+1)×(replans+1)+2` | 循环总迭代硬上限 |
| `--serve-port` | `4097` | 仪表盘端口（仅监听 127.0.0.1） |
| `--once` | 关 | 跑完一轮就打印报告并退出，退出码 0/1（适合 CI） |

未知参数或缺值会直接报错退出，不会被静默忽略。

## 需求文件格式

用自然语言描述需求即可。例如 `doc/REQUIREMENTS_EXAMPLE.md`：

```
有图形交互界面的专门算斐波那契数列的计算程序。

输入：第几个数
输入：确认计算的按键
输出：结果
```

## 输出

### 成功时

- `workspace/` 包含实现的所有代码文件
- `state/` 包含完整的运行日志和契约
- `output/report.md` 包含成功摘要

### 卡住时

报告包含：
- 已完成哪些
- 卡在哪个具体功能点
- 已尝试的修复方法
- 建议补充的信息

补充信息后重新运行即可从断点继续：`checkpoint.json` 会恢复阶段，
`contract.json` 与 `evaluation.json` 会一并载入，因此修复循环能从中断处继续，
而不是从头重新生成。

## Web 仪表盘

运行时默认在 `http://localhost:4097` 启动实时监控仪表盘，可在浏览器中观察 Agent 的每一步操作。可通过 `--serve-port` 自定义端口。

```bash
npx tsx src/main.ts                              # 默认 http://localhost:4097
npx tsx src/main.ts --serve-port 3000            # 自定义端口
```

仪表盘每 2 秒自动刷新，展示：

| 区域 | 内容 |
|------|------|
| 状态栏 | 当前阶段徽章、重试/重新规划计数、模型信息、本次花费与 token |
| 契约面板 | 所有契约条目及通过/失败/待验证状态、进度条 |
| 失败详情 | Evaluator 发现的每一项失败，按严重程度着色（critical/high/medium/low） |
| 活动日志 | 追加式时间线，显示 Planner/Generator/Evaluator 每一步操作 |
| 工作区 | 生成的文件列表，点击可预览内容 |
| 回复表单 | 循环终止时自动显示，可输入修改指令提交 |

![Dashboard Screenshot](doc/asset/dashboard_example.png)

仪表盘**只监听 127.0.0.1**，且 `/api/workspace/*` 会做路径归一化与越界校验，
拒绝 `../` 形式的读取。它能读取工作区文件并接收改写需求的指令，因此不应暴露到局域网。

> **注意**: 循环结束后仪表盘保持运行，按 Ctrl+C 退出。使用 `--once` 可在跑完一轮后自动退出。

## 失败分类

系统区分两类失败，只有一类会消耗修复预算：

| 类别 | 含义 | 计数 | 处理 |
|------|------|------|------|
| **代码失败** | Evaluator 判定契约项未满足 | `retries` / `replanCount` | 重试 → 重新规划 → 判定卡住 |
| **基础设施失败** | provider 鉴权/限流/网络，或响应无法解析 | `infraErrors` / `parseErrors` | 原阶段重试，**不动修复预算**；连续超限即判定卡住 |

这样"API key 填错了"不会被伪装成"代码有 bug"，也不会白白烧掉重试与重规划次数。
两类失败都写入 `state/errors.jsonl`，诊断时先看它。

### 指令格式

支持三种操作，多个指令以 `---` 分隔：

```
修改需求: <匹配关键词>
新内容: <替换后的完整内容>
---
新增需求:
<追加的新需求>
---
删除需求: <匹配关键词>
```

**示例**：
```
修改需求: 输入验证
新内容: 输入必须是 1-100 的正整数，超出范围提示错误
---
新增需求:
增加深色模式切换按钮
---
删除需求: CSV导出
```

指令作用于**段落块**，而不是整篇文本。需求文件用单独一行 `---` 分段，
`删除需求` 会删除所有包含关键词的段落，其余内容不受影响。

三条安全规则，任一触发则整批指令都不写入、文件保持原样，并打印原因：

1. `删除需求` 的关键词必须命中至少一个段落
2. `修改需求` 必须给出 `新内容`，且关键词必须唯一命中一个段落
3. 改写后的需求不得为空、且不少于 20 字符

改写前会把原文件备份到 `state/requirements.bak.md`。

### 工作流程

```
Agent Loop 运行 → 循环终止（done/stuck）
                    ↓
              终端显示输入提示
              仪表盘显示回复表单
                    ↓
          CLI / Web 收到指令
                    ↓
          解析指令 → 校验 → 修改 requirements/current.md
                    ↓
               重置状态 → 重新运行 Agent Loop
```
## 项目结构

```
Self-healing_Code_Gen/
├── src/
│   ├── main.ts              # 入口文件 (CLI、编排、退出码)
│   ├── config.ts            # 配置加载 + API Key 五级解析
│   ├── loop.ts              # 核心循环控制器 (含 decideNextPhase)
│   ├── state.ts             # 状态持久化 / 用量统计
│   ├── opencode.ts          # opencode SDK 封装 + provider 预检
│   ├── dashboard.ts         # Web 仪表盘 HTTP 服务 (仅 127.0.0.1)
│   ├── reporter.ts          # 报告生成
│   ├── reply.ts             # 回复指令解析 / 应用 / 等待
│   ├── requirements.ts      # 需求校验与段落块切分
│   ├── types.ts             # 类型定义
│   ├── json-parser.ts       # LLM JSON 解析 (多重修复策略)
│   ├── ini-parser.ts        # INI 配置解析器
│   ├── __tests__/           # 单元与集成测试
│   └── roles/
│       ├── planner.ts       # Planner 角色
│       ├── generator.ts     # Generator 角色
│       └── evaluator.ts     # Evaluator 角色
├── dashboard/
│   └── index.html           # 仪表盘前端页面
├── meta/
│   └── config.ini           # 用户配置文件 (模型、阈值、端口)
├── doc/                     # 设计原则文档 & API 文档
│   ├── CODING_PRINCIPLES.md # 编码原则 (Karpathy)
│   ├── LOOP_PRINCIPLES.md   # 循环设计原则 (Karpathy)
│   ├── DEEPSEEK_KEY.md      # API Key (gitignore)
│   ├── REQUIREMENTS_EXAMPLE.md # 示例需求
│   └── OPENCODE_API_DOC.md  # opencode SDK 文档
├── state/                   # 运行时状态目录
├── requirements/            # 用户需求文件
├── workspace/               # Agent 在此目录构建项目
├── output/                  # 最终报告输出
```

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 单元 + 集成测试 (node:test)
npm run check       # 两者都跑
```

测试覆盖状态机跃迁、回复指令的块级编辑与事务性、LLM JSON 解析、
评估结果的交叉校验、API Key 解析，以及用桩客户端驱动的完整循环。

## 设计原则

系统严格遵循了两份原则文档：

- **LOOP_PRINCIPLES.md**: 写循环而非 prompt、三角色分离、先协商契约、写磁盘不写上下文、允许重启
- **CODING_PRINCIPLES.md**: 先读后写、最小差异、手术式修改、目标驱动、验证驱动

两份原则文档在 `doc/` 目录下，运行时由系统自动读取并注入到对应角色的 system prompt 中，确保每个角色的 AI 都完整理解自己的职责和整套方法论的约束。

## License

MIT
