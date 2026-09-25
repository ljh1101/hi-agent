# hi-agent 架构文档

本目录完整拆解 hi-agent 工程。读完这些文档，应当能回答：每一行代码为什么存在、
每条安全边界如何被强制、每个设计决策放弃了什么 alternative。

文档以源码为准，引用的是函数名与文件名（而非行号，行号会漂移）。

## 这是什么

hi-agent 是一个 TypeScript 写的通用工具调用 agent：一个 LLM 驱动的循环，
调用工具、读结果、继续，直到能回答为止。运行于裸 `node`（>= 22.18，内置
type stripping），无 bundler、无 `tsx`、无运行时依赖（dev 依赖只有
typescript 和 @types/node）。

四条硬约束（违反任何一条即回归，见 `AGENTS.md`）：

1. **禁 `eval`。** 模型给的表达式一律走 `src/tools/calculator.ts` 的递归下降
   解析器。
2. **文件系统边界。** 每个文件工具必须经 `resolveToolPath` 解析路径并拒绝
   逃出工作区根。边界在*文件工具*上，不在 shell 上：只读 shell 命令可以读
   用户能读的任何路径（见 04 篇的"同意 vs 遏制"）。
3. **无 bundler、无 `tsx`。** 源码直接跑在 Node 的 strip-only 模式上，
   import 必须带真实 `.ts` 扩展名，只允许 erasable 语法（无 enum、
   namespace、参数属性）。
4. **Shell 审批链。** 持久 deny 规则 → 显式 allow 规则 → 只读白名单 →
   审批器。deny 先于白名单评估：白名单只是便利启发式，用户写
   `deny: ["cat *"]` 必须能关掉它开的洞。

## 架构总览

```
                     ┌──────────────────────────────────────┐
                     │ cli.ts  参数解析 / REPL / 审批 UI / 渲染 │
                     └───────┬──────────────────┬───────────┘
                             │                  │
              配置/会话/规则  │                  │ 事件流 (AgentEvent)
                             ▼                  ▼
   ┌──────────┐      ┌────────────────────────────────┐
   │ config.ts│      │        agent.ts (循环)          │
   │providers │─────▶│  history / 工具执行 / 压缩 / 撤销 │
   └──────────┘      └───┬──────────┬──────────┬──────┘
                         │          │          │
              ┌──────────▼──┐  ┌────▼─────┐  ┌─▼──────────────┐
              │   llm.ts    │  │context.ts│  │ tools/*        │
              │ OpenAI 兼容  │  │ 投影/记账 │  │ 9 个工具对象    │
              │ 重试/SSE 流  │  │ /LLM 压缩 │  │ (registry 索引) │
              └─────────────┘  └──────────┘  └────────────────┘
                                         支撑层：
              session.ts (JSONL 持久化)   changes.ts (撤销日志)
              permissions.ts (前缀规则)   command-parse.ts (命令切分)
              prompts/system.ts (系统提示词组装)
```

一次 `agent.run("问题")` 的完整数据流：

1. CLI 或库调用方把输入交给 `Agent.run()`。
2. 循环把 user 消息追加进 `history`（全量真相），触发持久化 hook。
3. 每一步：`context.ts` 从 history 投影出"请求视图"（老工具结果被剪枝，
   history 本身不动）→ 若估算超阈值先 LLM 压缩 → `llm.ts` 发请求
   （优先 SSE 流式）。
4. 模型回复带 `tool_calls` 时，逐个执行工具，把一切结果（含错误、超时、
   取消）变成文本观察追加回 history，回到第 3 步。
5. 模型回复不带 `tool_calls` 即最终答案；或触发 `maxSteps`、被取消。

## 模块地图

| 文件 | 职责 | 详文档 |
| --- | --- | --- |
| `src/types.ts` | 全部核心契约：ChatMessage / LLM / Tool / 事件 / 撤销 | [01](01-agent-loop.md) |
| `src/agent.ts` | 循环、history、工具执行与错误归一、取消、undo | [01](01-agent-loop.md) |
| `src/prompts/system.ts` | 系统提示词组装（身份 / 工具段 / 规则） | [01](01-agent-loop.md) |
| `src/llm.ts` | OpenAI 兼容客户端 + 重试退避 + SSE 流式 | [02](02-llm-client.md) |
| `src/context.ts` | 请求投影、token 记账、LLM 压缩 | [03](03-context-management.md) |
| `src/permissions.ts` | shell 前缀规则（allow/deny，deny 胜出） | [04](04-safety-and-permissions.md) |
| `src/command-parse.ts` | shell 命令切分 + 首词提取（方言感知） | [04](04-safety-and-permissions.md) |
| `src/tools/*` | 工具注册表与 9 个工具 | [05](05-tools.md) |
| `src/session.ts` | JSONL 会话持久化（含写队列串行化） | [06](06-session-and-undo.md) |
| `src/changes.ts` | 撤销日志：每 turn 写了什么、怎么放回去 | [06](06-session-and-undo.md) |
| `src/config.ts` | 配置分层（CLI > env > project > global）、密钥解析 | [07](07-config-and-providers.md) |
| `src/providers.ts` | 提供商预设、/models 发现、models.dev 窗口查询 | [07](07-config-and-providers.md) |
| `src/cli.ts` | 入口：参数、一次性模式、交互 REPL、审批提示 | [08](08-cli.md) |
| `src/index.ts` | 库的公共出口（纯 re-export） | — |
| `test/*` | 测试体系（单进程 runner、假 LLM、假 provider） | [09](09-testing.md) |

## 目录结构

```
src/
  types.ts             契约层：消息、模型接口、工具接口、事件
  agent.ts             循环本体（唯一的核心）
  llm.ts               唯一知道 OpenAI wire 格式的文件
  context.ts           模型看什么（投影）与窗口管理（压缩）
  session.ts           磁盘上的会话文件
  changes.ts           磁盘上发生了什么、如何回退
  config.ts            密钥与默认值从哪里来
  providers.ts         有哪些提供商、模型窗口多大
  permissions.ts       哪些命令不用问
  command-parse.ts     shell 命令怎么切成子命令
  prompts/system.ts    模型被告知自己是谁
  tools/               模型能做什么
  cli.ts               人怎么用
test/                  全部离线：假 LLM + 本地假 provider
examples/demo.ts       无 key 的离线演示（npm run demo）
```

## 核心设计原则

这四条是项目的灵魂，做任何改动前先读一遍：

1. **工具失败是数据，不是崩溃。** 坏 JSON、未知工具、抛错、超时、用户拒绝
   —— 全部变成 `Error: ...` 观察文本喂回模型，让它自己纠正。循环只在
   *provider* 失败（认证、HTTP、网络）时抛出，因为那没有本地恢复的余地。
2. **模型只是接口。** `LLM` 就是一个 `chat` 加可选 `stream`。换提供商只改
   `src/llm.ts`，循环一行不动。测试换成一个脚本化的假模型。
3. **工具只是对象。** 名字 + 描述 + JSON Schema + `execute`，外加喂系统
   提示词的 `promptSnippet`/`promptGuidelines`。没有插件系统。
4. **History 是真相，请求是投影。** `agent.history` 保持全量保真（持久化与
   回放的基底），模型看到的永远是 `projectHistory` 的产物。唯一的例外是
   `compact()`：它有意用细节损失换取"能继续"，失败时必须让 history
   字节不动。

## 术语表

| 术语 | 含义 |
| --- | --- |
| turn | 一次 `agent.run()`：从用户输入到最终答案 |
| step | turn 内的一次模型往返（请求 + 回复 + 工具执行） |
| observation | 工具执行结果变成的 `role: "tool"` 消息文本 |
| projection / 请求视图 | history 经剪枝规则变换后真正发给模型的消息列表 |
| compaction / 压缩 | 用 LLM 把老 history 摘要成一条 system 消息并替换 |
| prune / 剪枝 | 投影层把老的长工具结果截成头尾 + 省略标记（不动 history） |
| dialect | shell 方言（`posix` / `powershell`），解析器按它选转义规则 |

## 阅读路径

- **只想理解核心**：01 → 02 → 05。这三个文件（`types.ts`、`agent.ts`、
  `llm.ts`、`tools/registry.ts`）加起来不到两千行，是全部骨架。
- **要做安全审查**：04（安全边界与权限）必读，再读 05 的 shell 工具与
  09 的对抗测试要求。
- **要加功能**：05 有新增工具的检查单；07 讲配置如何接进来；09 讲测试
  怎么写。
- **要排查线上问题**：06（会话文件格式与写队列）、02（重试与超时语义）、
  08（CLI 行为与退出码）。
