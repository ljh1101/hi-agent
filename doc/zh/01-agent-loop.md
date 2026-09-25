# 01 · 核心契约与 Agent 循环

覆盖文件：`src/types.ts`、`src/agent.ts`、`src/prompts/system.ts`。

`types.ts` 是全项目共享的契约层，改它会波及所有地方；`agent.ts` 是循环本体；
`prompts/system.ts` 是提示词文案（文案是内容不是逻辑，所以独立于循环，
可以只改提示词不碰代码）。

## 1. 数据契约（types.ts）

### ChatMessage

镜像 OpenAI chat-completions 形状（事实标准），因此任何 OpenAI 兼容提供商
都能直接对接：

```ts
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null          // 只有 assistant 允许 null
  tool_calls?: ToolCall[]         // assistant 请求工具时
  tool_call_id?: string           // tool 消息，回链到请求
  name?: string                   // tool 消息的工具名
  summary?: true                  // 本地标记，见下
}
```

`summary: true` 是 agent 本地的标记，标记一条"生成的压缩摘要" system 消息，
而非用户真正的系统提示词。没有它，压缩时无法区分两者：用户系统提示词要在
每次压缩中幸存，而旧摘要要被新摘要**替换**。曾经没有这个标记，结果是每次
压缩都在 history 前部堆一条陈旧的 "Next Steps"，系统前缀越压越长直到再也
压不动。该标记随消息持久化（恢复的会话也能正确再压缩），且 wire 投影
（`toWireMessage`）只拷贝已知字段，它天然不会上线。

### ToolCall

```ts
interface ToolCall { id: string; name: string; arguments: string }
```

`arguments` **故意保持模型产出的原始 JSON 字符串、不预解析**。这样 agent
可以把解析失败作为观察反馈给模型（"arguments were not valid JSON (...)"）
而不是自己崩溃——这是"失败是数据"原则的第一个应用点。

### LLM 接口

```ts
interface LLM {
  readonly model: string
  chat(messages, tools, options?): Promise<LLMResponse>
  stream?(messages, tools, options?): AsyncGenerator<StreamEvent, void>
}
```

`stream` 是可选项：`AsyncGenerator` 产出归一化后的 `StreamEvent`
（`delta` / `tool_call` / `done`），`done` 事件携带累计完毕的完整 content
与 tool calls——调用方永远不需要自己解析 SSE 或重组 delta。实现了
`stream` 的模型可被流式消费；没有的自动回落 `chat`。

### Tool 与 ToolContext

```ts
interface Tool<Args> extends ToolDefinition {
  execute(args: Args, ctx: ToolContext): Promise<ToolResult> | ToolResult
  timeoutMs?: number          // 覆盖 agent 默认 30s（shell 用它声明更长预算）
  permission?: ToolPermission // 'read' | 'write' | 'dangerous'
  promptSnippet?: string      // 一行"我是干嘛的"，进系统提示词工具段
  promptGuidelines?: readonly string[]  // 行为规则，合并进系统提示词
}
```

`ToolDefinition`（name/description/parameters）是广告给模型的部分；
`execute` 及其余是运行时部分。工具抛错是**预期行为**：agent 会把错误转成
观察让模型自我修正。

`ToolContext` 是每次执行交给工具的运行时：

| 字段 | 作用 |
| --- | --- |
| `root` | 相对路径的基准目录，且不许逃出 |
| `signal` | 取消信号，贯穿到 LLM 客户端与每个工具 |
| `log` | 进度输出，只进 UI，模型看不见 |
| `approve` | 请求用户批准危险动作；仅当 agent 构造时给了 `approver` 才存在。第二参数携带原始命令，供审批器记忆前缀 |
| `recordChange` | 上报文件变更供 `/undo` 回滚。**诚实性原则**：机制只在所有写入方都参与时才成立，忘了调用的工具使自己的变更不可撤销 |

`FileChange` 的 null 有语义：`before: null` = 文件原本不存在（undo 时删除），
`after: null` = 工具删了它。`UndoResult.rewound: false` 表示对话没能回卷
（该 turn 期间被压缩过，压缩前的状态已不存在），只还原了文件。

### ToolPermission 的现状（重要）

`permission` 字段目前是**声明性元数据**，agent 循环不读取它。实际审批由
工具自己完成：shell 工具（`permission: 'dangerous'`）在自己的 `execute`
里走"deny 规则 → allow 规则 → 只读白名单 → `ctx.approve`"链（详见 04 篇）；
文件写工具（`edit` 标 `'write'`）**不经审批直接写**——这是设计决定：边界
是工作区根，不是逐文件的用户同意，退路是 `/undo`（06 篇）。新增危险工具时
应在自身 `execute` 里调用 `ctx.approve`，并按 AGENTS.md 要求评审权限等级。

### AgentEvent（10 种）

UI 和日志的全部信息源，模型永远看不到：

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `step` | step 序号 | 每个模型往返开始 |
| `assistant` | content + toolCalls | 模型回复完整到达 |
| `tool_call` | id/name/args | 工具即将执行 |
| `tool_result` | id/name/result/isError/durationMs | 工具执行完毕（含失败） |
| `final` | content | 得到最终答案 |
| `max_steps` | steps | 达到步数上限 |
| `log` | message | 工具内部的进度说明 |
| `token` | delta | 流式回复的每个文本片段 |
| `context_usage` | tokens | 每步请求前的上下文估算 |
| `compaction` | summaryTokens/keptFrom/ok | 压缩完成或失败 |

## 2. Agent 类（agent.ts）

### 构造选项（AgentOptions）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `llm` | 必填 | 实现 `LLM` 的模型客户端 |
| `tools` | `[]` | 注册进 ToolRegistry |
| `systemPrompt` | 组装默认值 | `null` 完全禁用系统提示词；字符串整体替换默认组装 |
| `maxSteps` | 12 | 每次 `run()` 的模型往返硬上限（`Math.max(1, …)` 钳制） |
| `root` | `process.cwd()` | 工具相对路径基准与边界 |
| `onEvent` | 无 | 事件汇 |
| `signal` | 无 | 中止当前 run 及在途请求 |
| `toolTimeoutMs` | 30000 | 单工具执行超时 |
| `approver` | 无 | 危险操作审批 hook |
| `stream` | true | 有 `stream` 就流式 |
| `contextOptions` | 见 03 | 投影剪枝预算 |
| `compaction` | 禁用 | 设了 `contextWindow` 才启用自动压缩 |
| `onAppend` / `onReplace` | 无 | 持久化 hook：每追加一条消息 / 整个 history 被重写时触发 |

构造时组装系统提示词（`buildDefaultSystemPrompt(registry.list())`）并作为
第一条 system 消息入 history。`history` 跨 `run()` 持续增长——这就是多轮
记忆。

### run()：一次 turn 的全流程

```
run(input, { signal })
│  signal = options.signal ?? 构造时的 signal   ← 每次运行可单独取消，不拆 agent
│  journal.beginTurn(末条消息引用)               ← undo 的回卷边界（消息引用，非索引，见 06）
│  append({ role:'user', content: input })      ← 触发 onAppend
│  definitions = registry.definitions()
│
│  for step = 1 .. maxSteps:
│    ├─ signal?.aborted → finish(lastContent, 'aborted')
│    ├─ emit step
│    ├─ 估算超阈值且上次压缩未失败 → await compact(signal)   ← 自动压缩
│    │    （失败则本 run 内不再重试： doomed 的摘要不值得每步烧一次 LLM 调用）
│    ├─ emit context_usage(估算)
│    ├─ reply = askModel(definitions, signal)   ← 流式优先，见下
│    ├─ emit assistant
│    ├─ signal?.aborted → finish('aborted')     ← 流被中途掐断是停止，不是最终答案
│    ├─ append(assistant 消息, 带 tool_calls)
│    ├─ reply.usage?.totalTokens → usages.set(末条消息索引, usage)  ← 锚定
│    ├─ reply.toolCalls 为空 → emit final; finish(content, 'final')
│    └─ for call of toolCalls:                  ← 顺序执行（并行会让模型看到的
│         observation = executeTool(call)          结果顺序不确定；Roadmap 项）
│           append({ role:'tool', content, tool_call_id, name })
│
│  emit max_steps; finish("Stopped after N steps...", 'max_steps')
```

两个关键点：

- **usage 锚定**：provider 报告的 `totalTokens` 覆盖的是"产生这条 assistant
  消息的那次请求"（此前全部消息 + 该消息），所以锚在该 assistant 消息的
  索引上；之后的新消息用 chars/4 估算（03 篇）。
- **可回放不变量**：每个 `tool_call` 必须有对应的 `tool` 消息。取消的调用
  也产生观察（"the run was cancelled before this call ran"），因为 assistant
  消息里没有结果的 `tool_calls` 会被所有 provider 在*下一次*请求时整体拒绝。

### askModel()：流式与回退

优先 `llm.stream`（构造选项 `stream !== false` 且 LLM 实现了 stream）：
逐事件累加 content、收集 tool_calls，`delta` 顺带 emit `token` 事件；流中
抛错时若 `signal.aborted` 则把已收到的部分作为回复返回（让上层判 aborted），
否则原样上抛。否则直接 `chat()`。模型从不直接看到 `history`——看到的是
`requestView()` 投影（03 篇）。

### executeTool()：一切失败皆观察

执行单个调用，把五种失败全部变成观察字符串：

| 失败 | 观察文本 |
| --- | --- |
| arguments 非法 JSON | `Error: arguments were not valid JSON (...)` |
| 工具名未知 | `Error: unknown tool "x". Available tools: ...` |
| arguments 非对象（null/数组/标量） | `Error: arguments must be a JSON object.` |
| 开始前已被取消 | `Error: the run was cancelled before this call ran.` |
| 执行中抛错/超时 | `Error: <reason>`（超时来自 `withTimeout`：`tool "x" timed out after Nms`） |

顺序有讲究：JSON 解析最先（避免为垃圾参数 emit tool_call 事件），然后 emit
`tool_call`，再查注册表。`ToolContext` 在这里组装：`recordChange` 直通
`journal.record`，`approve` 只在构造时提供了 approver 才注入。

### 取消的三层语义

1. **循环顶部检查**：进入新 step 前发现 aborted，立即按 aborted 收尾。
2. **askModel 内部**：流式中途被掐——已收到的 content/toolCalls 保留，
   按 aborted 停止而不是当作最终答案。
3. **工具层**：每个工具收到 `ctx.signal`（shell 杀整个进程树、搜索中止
   遍历）；agent 层的 `withTimeout` 与工具自身的取消共同保证调用总会以
   观察收尾。

### 状态管理方法

| 方法 | 语义 |
| --- | --- |
| `reset()` | 清对话、保留系统消息；清 usage 锚点与 undo 日志（undo 边界指向的 history 已不存在）；**触发 onReplace**——内存清了磁盘没清，下次 resume 会"复活"已清的对话，读起来像 /reset 静默失效 |
| `compact(signal?)` | 见 03 篇算法部分；此处语义：成功返回 true 并触发 onReplace；无东西可压也返回 true（emit ok 事件，UI 显示"nothing to compact"而不是误导的"compacted"）；摘要失败**不动 history** 返回 false |
| `setLLM(llm)` | 会话中途换模型，对话保留（/model 的底层） |
| `restoreHistory(history)` | 恢复会话用；不触发持久化 hook（会话层自己拥有磁盘内容）；清 usage 与 undo 日志（别的进程做的变更无法在本进程回滚） |
| `setApprover` / `setPersistenceHooks` | CLI 在构造 agent 之后才建好 readline/会话文件，所以允许事后接线 |
| `estimateContextTokens()` | 用**普通**投影估算。故意不用应急投影：这个数字驱动压缩判断与 UI 展示，若用降级视图度量，"挤压后刚好达标"会被读成"没超预算"，压缩永远不再触发，破坏性投影悄悄变成常态 |

## 3. 系统提示词（prompts/system.ts）

三段式组装，镜像 pi 的结构化提示词：

```
IDENTITY — 一段身份声明：hi-agent 是靠调用工具解题的通用 agent，
           在工作区根内操作，路径相对根且不能逃出，shell 命令从根启动。
# Tools  — buildToolsSection() 从每个工具的 promptSnippet 生成
           "- name: snippet" 列表；所有工具的 promptGuidelines 合并、
           去重（Set）、以 "- " 列表附后。无 snippet 的工具只列名字。
# Rules  — 5 条行为规则：
           1. 工具能给的事实不要猜，调工具
           2. 独立调用同 turn 批量发；有依赖的等结果
           3. 工具报错要读清楚、换路子，不要原样重试
           4. 对话回复保持简短技术化，路径与命令写准
           5. 信息够了就用纯文本给最终答案
```

`promptSnippet`/`promptGuidelines` 是"使用指引"（何时用它、与兄弟工具如何
配合），参数细节在 schema 里——两者的分工是刻意的。用户传 `systemPrompt`
字符串时整个组装被替换；传 `null` 连系统提示词都不发。

`DEFAULT_SYSTEM_PROMPT` 是无工具注册时的常量版本，供"只看系统提示词"的
展示路径与向后兼容。
