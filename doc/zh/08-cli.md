# 08 · CLI（cli.ts）

覆盖文件：`src/cli.ts`。职责：参数解析、配置接线、一次性模式、交互 REPL、
审批提示、事件渲染。所有业务逻辑都在下层模块，本文件只有 UI 与装配。

## 1. main() 全流程

```
loadDotEnv → parseArgs
  → --help / --list-providers → 打印退出
  → resolveConfig(options, {root})        ← 07 篇的优先级链
  → (options.setup 或 无 key 且 TTY) → setupFirstRun
  → 仍无 key → 报错退出（提示 --setup / npm run demo）
  → 加载并合并权限规则（project + global，04 篇 mergeRules）
  → --continue / --resume → 加载历史会话（见 §4）
  → new Agent({...}) + restoreHistory + setApprover
  → options.prompt 有值 → 一次性模式；否则 → repl()
```

## 2. 参数（CliOptions）

| 参数 | 作用 |
| --- | --- |
| 位置参数 | 拼接为一次性 prompt |
| `-m/--model`、`--base-url`、`--api-key` | 覆盖配置链最高层 |
| `--max-steps <n>` | 每 turn 模型往返上限（正整数校验，默认 12） |
| `--system <text>` | 整体替换系统提示词 |
| `--root <dir>` | 工作区根（默认 cwd） |
| `--setup` | 强制重跑首次配置向导 |
| `--list-providers` | 打印提供商预设 |
| `-c/--continue` | 恢复最近一个交互会话 |
| `--resume <id>` | 按 id 恢复（精确匹配或前缀匹配，不区分大小写） |
| `--yes` | 自动批准一切（只该用于可信容器/CI） |
| `-s/--stream`、`--no-stream` | 流式开关（默认开） |
| `-v/--verbose` | 显示模型叙述、完整工具输出、step/context 行 |
| `-h/--help` | 帮助 |

## 3. setupFirstRun（首次配置向导）

仅 TTY 下运行。流程：打印 provider 预设 → 选号或 `0` 手输 baseURL →
输 key → `pickModel`（`listModels` 实时发现；失败回落手输，默认
suggestedModel）→ `lookupContextWindow` 查窗口（失败跳过，打印提示或不打）
→ `saveGlobalConfig`。任何必答项为空都取消并说明。

## 4. 会话恢复（--continue / --resume）

`listSessions` 后按 id（精确 → 前缀）或取最新一个；`loadSession` 拿
history → `agent.restoreHistory`。交互 REPL 的 `store.id` 指向原文件，
**后续 turn 继续追加到原会话文件**。找不到匹配/无可恢复会话 → 报错退出
码 1。

## 5. 一次性模式（hi-agent "prompt"）

- approver 只在 `stdin.isTTY && !options.yes` 时接线——管道/CI 场景没有
  人回答审批，危险命令走"无 approver 默认拒绝"（04 篇）。
- SIGINT → `AbortController.abort`：turn 干净地以 aborted 收尾（shell 工具
  杀进程树、观察补齐、history 可回放），而不是栈回溯杀进程。
- `stopReason !== 'final'` → 退出码 1。

## 6. 交互 REPL

### 持久化接线

- `ensureSession`：第一条 turn 前懒创建会话文件（`newSessionId` +
  header）；resume 会话回读 header 补 createdAt。
- `agent.setPersistenceHooks`：`onAppend` → `appendMessage`、`onReplace`
  → `appendCompaction`（06 篇）。两者 **fire-and-forget**（循环不等写盘），
  但 rejection 必须接住——unhandled rejection 在新版 Node 会拖垮进程：
  `reportWriteError` 打印红字，会话继续可用。
- 退出 finally 里 `flushSessions()`：在飞的 append 全部落盘才退出。

### SIGINT 双语义

`inFlight` 记录当前 turn 的 AbortController：

- turn 进行中第一次 Ctrl+C → abort 该 turn（"interrupting... press Ctrl+C
  again to quit"），**不退进程**；取消后对话保留已做的部分（提示
  `/undo` 可还原文件）。
- 第二次（或在提示符处）→ `rl.close()`：挂起的 `question` promise reject，
  for 循环 break，finally 落盘退出。

监听同时挂在 `rl.on('SIGINT')` 与 `process.on('SIGINT')`。

### 斜杠命令

| 命令 | 行为 |
| --- | --- |
| `/reset` | `agent.reset()`（清对话留系统提示词；触发快照落盘，06 篇） |
| `/session` | 列会话（新→旧，标当前，带 title） |
| `/session new` | 新会话（旧文件留盘；`store.id = undefined` 下条 turn 懒建） |
| `/session <n或id>` | 按序号或 id（精确→前缀）切换；`loadSession` → `restoreHistory` |
| `/model` | `listModels` 实时列模型 → 选号 → `setLLM`（**对话保留**）→ 查窗口 → `saveGlobalConfig` |
| `/model <id>` | 直接切到指定模型 |
| `/compact` | 手动压缩；成功/失败文案区分 |
| `/undo` | 撤销上一 turn（三种输出见 06 篇 §3） |
| `exit`/`quit`/`:q` | 退出 |

### 审批提示 makeApprover

```
[approval] Run shell command: <command> (in <workdir>)
Allow? [y]es / [a]lways this session / [n]o:
```

- 非 TTY → 返回 false（拒绝默认）。
- **会话记忆**：命令的每个子命令都匹配 `remembered` 集合中某前缀规则 →
  直接放行不再问。回答 `a` → `derivePrefixRule`（04 篇：`git commit *`
  式两词前缀）入集合。
- `y`/`yes` 放行本次；其余拒绝。

## 7. 事件渲染 renderEvent

| 事件 | 非 verbose | verbose |
| --- | --- | --- |
| step | 隐藏 | `[step N]` |
| context_usage | 隐藏 | `[context ~12k tokens]` |
| compaction | 恒显示（成功灰 / 失败红） | 同 |
| assistant | 隐藏 | `[model] ...` |
| tool_call | `-> name(args 首行 120 字符)`（青色箭头） | 同 |
| tool_result | `ok/!! 首行 (耗时)` | `ok/!! 全文 (耗时)` |
| token | 原样续写 stdout | 同 |
| final | 换行收束 | 同 |
| max_steps | 红色提示 | 同 |

`streamed` 标志：本 step 出现过 token 就置位，`final` 只补一个换行不重打
全文；无流式时 final 才打印完整答案。颜色经 `color()` 包装，非 TTY 自动
去码。

## 8. 错误呈现 printError

`LLMError` 按 status 给 hint：401/403 → key 被拒，查 `AGENT_API_KEY`；
404 → 查 `AGENT_BASE_URL` 版本段与 `AGENT_MODEL`；429 → 限流稍后重试。
其余错误原样 message。

## 9. 退出码约定

| 情形 | exitCode |
| --- | --- |
| 最终答案 | 0 |
| 一次性模式 stopReason ≠ final（aborted/max_steps/异常） | 1 |
| 参数错、无 key、resume 找不到会话 | 1 |
