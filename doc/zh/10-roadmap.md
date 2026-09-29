# 10 · Roadmap（路线图）

本文把 2026-09 对照 **DeepSeek Harness**（`dsh`，一切皆插件、Web UI
优先）与 **Pi**（earendil-works，扩展优先的编码 agent）的功能盘点落成
具体计划。两个项目都做了逐项盘点；只有符合 hi-agent 定位的项才被采纳。

每一项都必须通过同样的三个测试：

- **是在同一个循环上做加法，不是重写。** 下面没有任何一项需要重构
  `agent.ts`；新能力落在新工具、新适配器文件或既有接缝上。
- **保持核心可读。** 一个功能若需要框架、运行时依赖或第二套构建系统，
  它就不属于这里（见"明确不做"）。
- **安全叙事不许注水。** 新副作用进入 `createDefaultTools()` 前必须过
  权限评审；新写文件必须走 `ctx.recordChange`；doc 05 的先读后写与
  `resolveToolPath` 规则照常适用。

条目按优先级分组，不按体量。依赖关系在条目内注明；除此之外不排顺序。

## P1 — 接下来做

### 5. 自定义 slash 命令（prompt 模板）

**问题。** slash 命令硬编码在 `cli.ts`；用户无法添加自己的可复用
提示词。（pi：注册命令 + markdown prompt 模板；dsh：命令注册表，
不经模型回合直接分发。）

**方案。** `.hi-agent/commands/<name>.md`（项目）与
`<configDir>/commands/`（全局）。文件正文是 prompt 模板；`$ARGUMENTS`
替换为命令后输入的内容；`/name args` 展开成一条用户消息。是声明式
数据，不是代码——设计原则 3（没有插件系统）不被破坏。内置命令保持
优先。

**落点。** `cli.ts`、`config.ts`、两份文档树。

### 6. Sub-agent：`task` 工具

**问题。** 所有事都挤在一个上下文里；一次大范围探索会把主线程淹没，
研究型工作也无法并行。（dsh：subagent 注册表加 send/interrupt 等
控制工具；pi：官方扩展示例。）

**方案。** 一个 `task` 工具，其 `execute` 派生一个嵌套 `Agent`：拥有
自己的 history、受限工具集（默认只读）、自己的 `maxSteps`，共享父级
的 abort signal。最终答案——或 stop reason——成为 observation；
"工具失败是数据"意味着失败的 sub-agent 是一条 `Error: …` observation，
不是崩溃。审批沿用到同一个 `ctx.approve`。v1 的子运行不落为会话。

**落点。** `src/tools/task.ts`（新增）。理想情况下 `agent.ts` 零改动：
sub-agent 就是一个库调用方，这正是 `src/index.ts` 公共出口存在的意义。

**护栏。** sub-agent 内部的写操作除非显式加白，否则 `/undo` 追踪不到
——默认只读工具集就是为此存在的。

### 7. MCP 客户端

**问题。** MCP 生态（数据库、浏览器、API）够不着，而逐个手写集成
违背极简核心。（dsh 把外部 MCP server 挂为原生工具；pi 刻意不做——
这让 MCP 成为差异点，而不是跟风。）

**方案。** 只做 stdio 传输。MCP over stdio 就是 agent 与子进程之间的
换行分隔 JSON-RPC——`shell.ts` 已经会管理这种子进程，不需要 SDK、
运行时依赖，也不触碰 AGENTS.md 禁止的动态 import。配置里的
`mcpServers` 声明 command、args 和显式 env 映射（绝不传
`process.env`——与 `childEnv()` 同一条规则）。发现的工具以
`mcp__<server>__<tool>` 经动态工具源暴露；`tools/registry.ts`（如今
是静态的）只新增一个概念：注册表也可以向"源"询问它有哪些工具。
MCP 工具的失败与其他工具一样归一化为 observation。

**落点。** `src/mcp.ts`（新增）、`tools/registry.ts`、`config.ts`。

**护栏。** MCP server 是以用户权限运行的任意第三方代码——与 shell
同一信任等级。除非在配置中加白，每次 MCP 工具调用都需要审批，文档
要把这一点写明白。

## P2 — P1 之后

### 8. 工作区指令（自动加载 `AGENTS.md`）

**问题。** 每个项目的规则都得每次用 `--system` 重复。（dsh 注入
workspace 指令；pi 在信任门后加载项目上下文文件。）

**方案。** 启动时把工作区根目录的 `AGENTS.md` 载入系统提示词的 rules
段，带字节上限；`--no-agents-md` 可关闭。v1 只读根目录文件。它是来自
仓库的、面向模型的文本——与它所描述的代码同一信任等级；文档应说明
敌意仓库的 prompt injection 属于已知边界，不在本项解决范围。

### 9. Skills（`SKILL.md` 目录）

**问题。** 可复用的流程散落在用户脑子里和粘贴历史里。（pi 实现了
agentskills.io 规范；dsh 有 skill 注册表并随包发行技能。）

**方案。** `<root>/.hi-agent/skills/<name>/SKILL.md` 加一个全局目录。
名字 + 描述走现有 `promptSnippet` 机制进入系统提示词；一个 `skill`
工具按需把完整正文作为 observation 返回。其他一切不动。

### 10. 工具输出溢出到文件

**问题。** shell 工具只留尾部（2000 行 / 50 KB），头部被无声丢弃——
模型无法找回它没看到的东西。（pi 把全量输出存临时文件，给模型截断
视图加路径；dsh 把超长结果溢出为文件并给模型定位符。）

**方案。** 工具结果超过溢出阈值时，把全文写入工作区内的 scratch 文件
（`.tmp-*` 已是 gitignore 约定），observation 携带头 + 尾 +
`[full output: <path>]`，`read_file` 即可取任意区段。`context.ts` 的
剪枝标记可以指向同一个文件。

### 11. Agent 级重试与溢出恢复

**问题。** `llm.ts` 会重试瞬态 HTTP 失败，但当 provider 因上下文过长
拒绝请求时，turn 直接死掉——尽管 `compact()` 存在且恰好能治。
（pi：agent 级自动重试 + 溢出时 compact-and-retry。）

**方案。** 在 `agent.ts` 的 step 错误处理中：若已完成重试的 provider
失败表明是上下文长度溢出，就跑一次 `compact()` 并重试该 step 一次。
压缩失败或重试仍溢出则照常抛出——循环仍然只在本地无能为力时才抛，
设计原则 1 不破。

### 12. 成本展示

**问题。** 用量已追踪并按 assistant 消息锚定（`hasUsageBasis`），但
只有 verbose 模式显示 token 数；没有任何费用呈现。（pi 每条消息带
`usage.cost.total`；dsh 有带上下文压力的 token meter。）

**方案。** `providers.ts` 本来就从 models.dev 目录取上下文窗口——
从同一条目录项读入价格、进同一个进程内缓存，CLI 按 list 价格展示
每 turn 与全会话的累计估算。要标注这是估算：缓存定价各不相同。

### 13. Todo 清单工具

**问题。** 长的多步工作没有一份模型与用户都能对齐的可见计划。
（dsh：`todo_write`，按会话持久的清单加 UI 渲染；pi：扩展。）

**方案。** 一个 `todo_write` 工具持有内存中的清单，并作为自定义
JSONL 行类型持久化进会话文件——loader 本来就跳过未知行类型，新旧
版本互通。CLI 渲染它；之后的 plan mode（dsh 式软约束 + 退出审批
工具）可以在此之上搭建。

### 14. 后台 shell

**问题。** shell 工具上限 300 秒且阻塞；dev server、长时间构建、
watch 全都够不着。`tail -f` 之所以被禁，恰恰因为没有别的方式"盯着"
一个东西。（dsh：job runtime 支撑后台 bash、PTY 与 subagent。）

**方案。** shell 工具加 `run_in_background`，立即返回 job id；
`job_output` 与 `job_kill` 管理运行中的任务；输出走环形缓冲并按第
10 项溢出到文件。进程树追踪（Windows 的 `taskkill /T`、POSIX 的负
pid 组杀）已经存在，直接复用。任务在 CLI 退出时被杀，与
`flushSessions()` 并列。

**护栏。** 审批链照旧把守启动命令——后台只改变"何时"，从不改变
"是否"。

## P3 — 延续或可选

### 15. 图片输入

依赖第 3.2 项（content block）。一个 `read_image` 工具，或 `read_file`
的图片模式；CLI 支持粘贴/拖入。循环中不存在任何视觉逻辑——图片是
载荷，不是功能。

### 16. Markdown / diff 渲染（可选）

零依赖的 ANSI markdown 渲染器，加 `edit` 结果的 diff 高亮。pi 最大的
投入是它的 TUI 框架；值得取的只有这一薄片，且以"保持小"为前提。
非 TTY 时回退纯文本。

### 17. 长期记忆（旧路线图延续项）

会话文件之外的记忆。第 7 项落地后的现实形态：一个 MCP memory
server，或一个有上限的工作区记忆文件——由 `memory_write` 工具维护、
系统提示词加载。不要造向量库。

## 一个维护决策，已定

**`Tool.permission` 曾是纯声明，没有任何代码读它**——循环从不查阅该
字段；`write_file` 与 `edit` 不经审批执行（它们的边界是工作区根目录
加 `/undo`）。在第 2、6、7、14 项带副作用的工具进来之前已定夺：
**字段被删除。** 本代码库里每一道真实的门禁都是按调用的——shell 看
命令（只读白名单 + 规则）、web_fetch 看抓取的 URL（私网地址）、MCP
看配置加白清单——静态的按工具枚举哪个都驱动不了：接进瀑布要么破坏
shell 的只读白名单，要么空转成摆设。某个调用需要用户同意时，工具在
`execute` 里调 `ctx.approve`，并把按调用检查的依据写在旁边。一个风险
可以按工具而非按调用判定的工具，本身就是形状不对。

## 明确不做

因定位而被否决——默认拒绝新增这些功能的提议：

- **Web UI、桌面壳、SDK、ACP server。** 那是 dsh 的主战场。其中任何
  一个都会终结"一个下午读完整个核心"的承诺。
- **插件系统、插件市场、agent 自我修改。** 设计原则 3 是刻意的。
  声明式配置、prompt 模板、skills 与 MCP 已覆盖正当需求。
- **OS 级沙箱**（Landlock / Seatbelt / 受限 token）。有价值且与平台
  强相关；在有人专门为之工程化之前，文档化的边界维持"同意 vs 隔离"
  （doc 04）。
- **alt-screen TUI 框架、主题、键位系统。** pi 最大的版面。朴素的
  readline REPL 本身就是特性。
- **遥测、基准、调度、i18n 框架。** 单用户 CLI 不需要这些；双语文档
  （en/zh）已覆盖真实需求。

## 已完成（从本清单移出）

- 上下文压缩——发现 `contextWindow` 后自动触发，或 `/compact`
  （doc 03）。
- 会话持久化——`--continue` / `--resume`、`/session`、JSONL
  （doc 06）。
- 撤销——经 `changes.ts` 日志的 `/undo`（doc 06）。
- 并行工具执行（第 1 项）——同一 step 的 `tool_calls` 并发执行；每个
  `Tool` 带 `concurrency` 提示（默认 `concurrent`，改状态的
  `write_file`/`edit`/`shell` 为 `serial`），observation 按 `tool_calls`
  原序追加，history 保持可回放、日志顺序等于执行顺序（doc 01）。
- Reasoning content、content block、原生 provider（第 3 项）——分阶段：
  (3.1) `reasoning_content` 捕获为 agent 本地的 `reasoning` 字段，CLI 展示、
  投影剥离、token 估算不计；(3.2) `ChatMessage.content` 在文本兼容的字符串
  之外可携带 `ContentBlock` 数组（text / image / thinking），凡只能放文本的
  场合由 `textOfContent` 展平；(3.3) 原生适配器 `llm-anthropic.ts` 与
  `llm-google.ts` 实现同一个 `LLM` 接口，由 provider 预设的 `protocol`
  字段选择（02 篇）。
- 会话 fork（第 4 项）——`/fork [n]` 写一个新会话文件（header + 一条
  全量 history 快照行，正是 compaction 已有的行格式），内容是截至第 `n`
  个 user turn 结束的对话，REPL 随后在 fork 里继续；源文件不动
  （doc 06 §6）。真正的分支树仍是之后另一个独立变更。
- Web 访问（第 2 项）——先 `web_fetch`：客户端 GET，带超时、下载/内容
  上限、content-type 门禁、最小 HTML 转文本，私网/回环目标走审批
  （05 篇 §9）。再 `web_search`：配置所选 API（Brave / Exa / Perplexity，
  07 篇）的薄客户端；provider 原生的服务端 web 工具仍要等下面的按
  provider 协议工作进入请求管线本身。
