# 06 · 会话持久化与撤销（session.ts + changes.ts）

覆盖文件：`src/session.ts`、`src/changes.ts`，以及 `agent.ts` 中
`undoLastTurn()` 的配合逻辑。

## 1. 会话文件（session.ts）

### 布局与生命周期

- 位置：`<configDir>/sessions/<id>.jsonl`；configDir 平台相关（07 篇），
  可用 `HI_AGENT_CONFIG_DIR` 覆盖。
- `<id>` = `yyyyMMdd-HHmmss-<uuid 前 8 位>`：按创建时间可排序，且唯一。
- **只有交互式运行落盘**；一次性 prompt 模式完全不创建会话文件。
- 会话的创建是**懒**的：REPL 第一条消息真正发出时才写 header（CLI 的
  `ensureSession`，08 篇）。

### 三种行（SessionLine）

```json
{"kind":"header","id":"...","createdAt":"...","model":"..."}
{"kind":"message","message":{ ...ChatMessage... }}
{"kind":"compaction","history":[ ...整份当前 history... ]}
```

- 第 1 行固定 header；其后每行一条消息，wire 顺序。
- **append-only 哲学**：常态是每消息追加一行（一次独立 writeFile），崩溃
  至多丢进行中的那个 turn。
- **重写历史 = 追加一条快照行**，而不是原地改写：compaction 与 `/reset`
  都产生 compaction 行。回放从**最后一个**快照开始，快照前的原始行留在
  磁盘上——历史可审计、可恢复。

### 写队列（writeQueues）——为什么必须有

每次 append 是独立的 `writeFile`（open/write/close），两个重叠调用可能
乱序落盘。顺序不是品味问题：如果带 `tool_calls` 的 assistant 消息晚于它
请求的 tool 结果写入，回放文件时 provider 收到"先有结果后有调用"的对话，
**整体拒绝**。

实现：每文件一个 promise 链，`enqueue(file, write)` 把新写挂到链尾；
链在单次失败后继续（一条坏写不会卡死后续所有写），调用方仍通过返回的
promise 看到本次失败。队列空了自清理。

`flushSessions()`：排空所有队列后才 resolve（排空可能揭示排队期间新入队
的写，所以循环到不再新增为止）。**进程退出路径必须调用**：交互会话退出时
若 append 还在飞，丢掉的恰好是用户刚看着发生的那个 turn。CLI 在 repl 的
finally 里调用（08 篇）。

### 读取与列举

- `loadSession`：逐行 JSON.parse，**宽容策略**：
  - 崩溃造成的撕裂尾行（parse 失败）跳过；
  - compaction 行 → `history.length = 0` 后装快照（快照取代其前的一切）；
  - **未知 kind 跳过**：更新版本的写入器可能写本构建不认识的行，若硬读
    `parsed.message` 会得到 undefined 污染 history 留洞。前向兼容靠跳过。
  - 无 header → 视为无效返回 undefined。
- `listSessions`：遍历目录取元数据。`title` = 首条 user 消息前 60 字符
  （遇到 compaction 快照后从快照里重新推导）；`messageCount` 同样感知
  快照重置；按文件 mtime（`updatedAt`）降序——最新在前。目录不存在返回
  `[]` 而非抛错。
- `deleteSession`：`force: true` 的 rm，缺文件是 no-op。

## 2. 撤销日志（changes.ts）

### 动机与范围（文件头注释原话的转述）

agent 的全部意义在于改文件，而 `write_file`/`edit` 不经逐文件审批（边界
是工作区根，见 04 篇）——写错一个 turn 曾是不可逆的，除非文件恰好在 git
里。撤销日志记录**每个 turn 换掉了什么**，`/undo` 据此还原。

范围说清楚：只覆盖**文件工具**。shell 命令写的文件不追踪（命令字符串
说明不了它会碰什么）；根外的东西不追踪。这两类的答案仍然是 git。

### 结构

```ts
interface Turn {
  boundary: ChatMessage | null   // turn 开始前的最后一条消息（引用，非索引）
  changes: FileChange[]          // 按发生顺序；undo 逆序走
}
```

- `MAX_TURNS = 20`：日志把文件内容存在内存里，深度必须有界；20 远超实际
  回卷需求，长会话的占用可预期。超限 shift 最旧。
- **boundary 为什么是消息引用而不是索引**：compaction 可能在 turn 中途
  重写 history，先记录的索引会指向末尾之外（或更糟，指错位置）——实测
  索引标记留下 44 个 history 空洞、后续每个请求都炸。压缩对保留区复用
  同一批消息对象，引用因此幸存；引用若也被换掉（边界消息被压掉），回卷
  被**拒绝**而不是猜。
- `record` 在无开放 turn 时静默忽略（run 之外的裸工具调用）。
- `clear` 在 `reset()` 与 `restoreHistory()` 时调用——history 没了，
  undo 边界失效。

### undo(root)

1. `findLastIndex` 找最近一个**有变更**的 turn（纯对话 turn 直接跳过）；
2. 截断日志到该 turn（该 turn 不可再 undo）；
3. **逆序**还原变更：同一 turn 内写了两次的文件，最终拿到的是 turn 开始
   前的内容；
   - `before: null` → `rm`（turn 创建的文件，撤销即删除）；
   - 否则 `writeFile(before)`。
4. 每条路径还原前**重新过 `resolveToolPath`**：记录时安全不代表现在安全
   ——链接可能后来才出现，undo 不能成为唯一往根外写东西的路径。

## 3. 撤销的两半（agent.undoLastTurn）

文件还原与会话回放**必须同时**做，缺一不可：

- 只还原文件不回卷对话 → 模型坚信它的编辑还在盘上；
- 只回卷对话不还原文件 → 会话描述的代码已经不存在。

```
undone = journal.undo(root)          // 无可 undo → 返回 undefined
boundaryIndex = history.indexOf(undone.boundary)
rewound = boundary 为 null（turn 前历史为空，回卷到 0）
        或 boundaryIndex >= 0（边界还在，截到它之后）
若 rewound: history.length = keep; usages.clear(); onReplace(history)
          ← 磁盘必须同步，否则下次 resume 把刚 undo 的 turn 重放回来
返回 { restored, removed, droppedMessages, rewound }
```

`rewound: false` 的场景：该 turn 期间发生过 compaction，边界消息被摘要
吞掉——文件照样还原，但对话**不**截断（截断到猜测的位置比不截更危险）。
CLI 对此有专门提示（08 篇）。

CLI `/undo` 的三种呈现：还原/删除了哪些文件 + 丢了几条消息；`rewound`
为 false 时说明"文件回来了但对话回不去（该 turn 中被压缩）"；restored
与 removed 都为空时说明"该 turn 没有经文件工具改文件——shell 副作用
不追踪"。

## 4. 持久化 hook 的接线（agent ↔ session）

Agent 提供两个注点（`onAppend` / `onReplace`），会话层注入：

- `onAppend`：循环每追加一条消息（user/assistant/tool）后触发 →
  `appendMessage`；
- `onReplace`：compaction、`reset()`、undo 回卷重写整个 history 后触发 →
  `appendCompaction`（快照行）。

CLI 里这些调用是 fire-and-forget，但拒绝不能成为 unhandled rejection
（新版 Node 会拖垮进程）：错误打到 stderr（"session write failed"），
会话继续可用（08 篇）。

## 5. 一致性小结（哪些操作会动磁盘）

| 操作 | 磁盘动作 |
| --- | --- |
| 每 append 一条消息 | 追加一行 `message` |
| `compact()` 成功 | 追加一行 `compaction`（快照） |
| `/reset`（agent.reset） | 追加一行 `compaction`（快照 = 仅系统消息） |
| `/undo` 且 rewound | 追加一行 `compaction`（快照 = 截断后 history） |
| `/undo` 且 !rewound | 无磁盘动作（对话没变，文件变更本来就未持久化追踪） |
| `/session new` / 切换 | 无（原文件保留；新 turn 懒创建新文件） |
