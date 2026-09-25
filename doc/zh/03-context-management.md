# 03 · 上下文管理：投影、记账、压缩（context.ts）

覆盖文件：`src/context.ts`。

核心命题：**history 是真相，请求是投影。** agent 的 `history` 保持全量保真
（持久化与回放的基底），模型看到的永远经过 `projectHistory` 变换，history
本身从不被修改——唯一例外是 `compact()`，它有意重写 history（细节损失是
"能继续"的显式代价），失败时必须字节不动。

三级机制，由轻到重：

1. **剪枝投影**（每次请求）：老的过长工具结果截成头尾 + 省略标记。
   廉价、确定性、不调模型（对标 dsh / opencode 的 tool-result pruner）。
2. **应急投影**（仅当 1 之后仍超预算）：连最近 turn 的年龄保护也丢掉。
3. **LLM 压缩**（估算越过窗口阈值时）：把老 history 摘要成一条 system 消息。

## 1. 剪枝投影 projectHistory()

对每条 `tool` 消息（system/user/assistant 原样透传）依次测两条规则：

**规则 A（年龄规则）** —— 同时满足才触发：
- 内容长于 `pruneThresholdChars`（默认 2000）；
- 消息索引早于保护截止线：`protectedTurns`（默认 3）个最近 user turn 内
  的工具结果不剪（模型多半还要用）。

触发后截成 `pruneHeadChars`（300）+ `pruneTailChars`（300），中间换成
`\n[... N characters pruned ...]\n`。保头保尾的理由：头是输出的形态，
尾通常是命令的报错或总结行。

`protectedCutoff` 从尾向前数 user 消息定位第 N 个 turn 的起点；user turn
不足保护窗口数时保护一切。

**规则 B（天花板规则）** —— 不管年龄，单条工具结果超过
`maxToolResultChars`（默认 8000）就截成两端各一半。年龄规则回答"模型还需
不需要这条结果"，天花板回答"任何单一观察不许独占窗口"：一条 50KB 的 shell
转储恰好落在正被回答的 turn 里时受年龄规则保护，能独自把请求顶破模型上限。

**两条规则的测试顺序是 A 先 B 后，这是修过的 bug 而非品味**：若天花板先
测，老结果会以 8000 字符的"天花板尺寸"出现在请求里，比剪枝前的 600 字符
反而更大（实测一条 40k 的老结果从 600 涨到 8000）。把 `protectedTurns`
设为 0 即剪掉所有工具结果——应急投影正是靠这个开关工作。

投影用 `map` 生成新对象（`{ ...message, content }`），`tool_call_id`、
`name` 等其余字段原样保留；`test/context.test.ts` 断言投影绝不修改存储的
history。

## 2. 应急投影 projectRequestView()

```
view = projectHistory(正常预算)
if contextWindow > 0 且 contextUsage(view) > thresholdTokens:
    return projectHistory({ ...预算, protectedTurns: 0 })   ← 丢掉年龄保护
```

成功压缩后必然远低于预算（切点只保留窗口的 `retainRatio`，投影再进一步
缩小），所以走到这里说明压缩**没有**完成它的任务：摘要调用失败或不可用，
而 history 已经超限。硬发请求会被 provider 以超上下文拒绝并终结整个 turn；
丢掉年龄保护（最近工具结果原本完整保留）是用细节换答案。全程不碰 history。

## 3. token 记账

- `estimateTokens(msg)`：字符数 / 4，含 tool_calls 的 name + arguments。
  刻意保守（对多数语言偏高估），与 pi / opencode 同一启发式。
- `contextUsage(messages, usages)`：**混合策略**。从尾向前找最后一条带
  真实 usage 报告的消息作锚点（`usages` 由 agent 维护：assistant 消息索引
  → 产生它的那次请求的 usage；`totalTokens` 天然覆盖"锚点之前的全部 +
  锚点本身"），锚点之后的新消息用 chars/4 估算。没有任何 usage 时全部
  估算。返回 `{ tokens, hasUsageBasis }`，后者告诉 UI 这个数字有没有
  真实报告支撑。

## 4. LLM 压缩（CompactionOptions）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `contextWindow` | 0 | 模型总窗口（token）。0 = 自动压缩禁用。无跨提供商的可靠发现手段，由调用方提供（CLI 从 models.dev 查，07 篇；私有部署写进 `hi-agent.json`） |
| `thresholdRatio` | 0.8 | 估算超过 `window * ratio` 触发。用比例不用固定 reserve：固定 token 储备无法跨窗口缩放（16k 储备是 8k 窗口的 200%——阈值变负，压缩永不停歇） |
| `retainRatio` | 0.2 | 压缩后原样保留窗口的这个比例 |
| `reserveTokens` / `keepRecentTokens` | 无 | 显式 token 覆盖，优先于比例；"明确知道预算"时才用 |

`resolveCompactionOptions` 对派生阈值取 `Math.max(1, …)`：极小窗口也必须
能摸到阈值，否则压缩每步都触发、永无宁日。

`shouldCompact(tokens, options)`：`contextWindow > 0` 且估算值超过阈值。

### findCutPoint(messages, keepRecentTokens)

从尾向前累积 token 估算，攒够 `keepRecentTokens` 停；然后把切点向前推进到
合法边界——**tool 消息永不能与它的 call 分离**：切点只能落在 user 消息
（turn 起点）或 assistant 消息（其 tool_calls 及后续结果整体保留）上。
落在 tool 消息上就继续前移。

### serializeForSummary(messages)

把将被压掉的消息序列化成摘要器读的转写：`[User]:` / `[Assistant]:` /
`[Assistant tool call]:` / `[Tool result]:` 行；单条工具结果截 2000 字符；
总转写超 60000 字符时**从最旧开始丢行**（尾部是最近最相关的上下文），头部
放 `[... N oldest lines dropped ...]` 标记。双预算保证摘要请求自己不撑爆
窗口。

### SUMMARY_PROMPT

要求结构化检查点：`## Goal` / `## Constraints & Preferences` /
`## Progress`（Done / In progress / Blocked，要求保留确切文件路径）/
`## Key Decisions` / `## Next Steps`。明确告知摘要器"另一个 assistant
实例只靠你的摘要继续工作"。

## 5. 压缩的完整语义（与 agent.compact() 的配合）

`Agent.compact()`（01 篇有调用时机）按上述算法执行，另有三条数据语义：

1. **系统消息分两类**：用户的 system 提示词在每次压缩中幸存；
   `summary === true` 的旧摘要被新摘要**替换**而非叠加（新摘要请求会看到
   旧摘要，替换不丢信息——旧摘要捕获的内容被带进新摘要）。
2. **usages.clear()**：usage 锚点指向旧索引，压缩后索引全部失效，估算
   接管。
3. **失败不动**：`llm.chat` 抛错（provider 失败）→ emit
   `{ type:'compaction', ok:false }`，返回 false，history 字节不变。下一次
   请求可能撞 provider 的窗口限制——这比损坏对话安全。run 循环里
   `compactionFailed` 标志保证失败的 run 内不再重试。

压缩成功后触发 `onReplace(history)`：持久化层写入一条 compaction 快照行
（06 篇），旧消息行留在磁盘上可审计。

## 6. 默认值速查

| 常量 | 值 |
| --- | --- |
| pruneThresholdChars | 2000 |
| pruneHeadChars / pruneTailChars | 300 / 300 |
| protectedTurns | 3 |
| maxToolResultChars | 8000 |
| thresholdRatio | 0.8 |
| retainRatio | 0.2 |
| 摘要单条工具截断 | 2000 字符 |
| 摘要总转写上限 | 60000 字符 |
