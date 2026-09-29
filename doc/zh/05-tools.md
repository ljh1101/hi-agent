# 05 · 工具集（tools/*）

覆盖文件：`src/tools/registry.ts`、`index.ts`、`calculator.ts`、
`time.ts`、`filesystem.ts`、`edit.ts`、`search.ts`、`shell.ts`、`web.ts`、
`task.ts`。

工具是普通对象：name + description + JSON Schema + `execute`（+ 可选
`timeoutMs` / `concurrency` / `promptSnippet` / `promptGuidelines`）。没有
插件系统。路径边界机制见 04 篇 §1，shell 的权限链见 04 篇 §4——本篇讲
各工具自身的行为设计。

`concurrency` 决定一批 `tool_calls` 里的调度方式（见 01 篇）：`concurrent`
（默认）与批内其他调用并发；`serial` 按 `tool_calls` 原序逐个执行。改状态
的工具都是 `serial`——`write_file`、`edit`、`shell`——因为 undo 日志按执行
顺序记录（06 篇）。

审批行为存在于**每个工具内部**，而不是某个字段上：旧的 `Tool.permission`
徽标（read/write/dangerous）是循环从不读取的声明性元数据，而本代码库里
每一道真实的门禁都是按调用的（shell 看命令、web_fetch 看 URL、MCP 看
加白清单），所以字段被删除了。某个调用需要用户同意时，工具在 `execute`
里调 `ctx.approve`。

## 1. 注册表与默认工具集

`ToolRegistry`：name → Tool 的 Map。重名注册抛错（duplicate tool name）。
`definitions()` 投影出 `{ name, description, parameters }`——广告给模型的
最小集，`execute` 等运行时细节不上线。

`createDefaultTools({ rules, webSearch, getLLM })` 返回 12 个工具；`rules`
是来自项目/全局配置的持久权限规则，只喂给 shell 工具；`webSearch` 为
`web_search` 装上后端（07 篇）；`getLLM` 启用 `task` 子代理工具（其模型
按调用解析，`/model` 切换对子代理同样生效）：

| 工具 | 审批 | 默认超时 | 一句话 |
| --- | --- | --- | --- |
| `calculator` | 无 | 30s | 精确算术（递归下降解析器，无 eval） |
| `current_time` | 无 | 30s | 当前 UTC + 本地时间 |
| `list_dir` | 无 | 30s | 目录清单（[dir]/[file] + 大小） |
| `read_file` | 无 | 30s | 读文本文件或行区间 |
| `write_file` | 无（以根目录 + `/undo` 为界） | 30s | 创建/整体覆盖文件 |
| `edit` | 无（以根目录 + `/undo` 为界） | 30s | 唯一串精确替换 |
| `glob` | 无 | 30s | 按路径模式找文件 |
| `grep` | 无 | 30s | 按正则搜内容 |
| `shell` | deny → allow → 只读白名单 → approver | 305s（工具自带） | 执行 shell 命令（权限链 + 进程树管理） |
| `web_fetch` | 公网 URL 免审批；私网/回环 → approver | 20s（工具自带） | 抓取 URL，HTML 转文本（不执行 JS） |
| `web_search` | 无（调用配置好的搜索 API） | 20s（工具自带） | 经配置的后端搜索（07 篇） |
| `task` | 审批透传给父级 | 600s（工具自带） | 子代理：独立上下文 + 只读工具集 |

## 2. calculator（calculator.ts）

模型给的表达式是**不可信输入**，所以整个求值是手写递归下降解析器：

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/' | '%') unary)*
unary      := ('+' | '-') unary | power
power      := primary ('^' unary)?          ← 右结合
primary    := number | identifier | '(' expression ')'
```

- 函数白名单：`sqrt abs round floor ceil min max pow log sin cos tan`；
  常量：`pi`、`e`。标识符大小写不敏感。数字支持科学计数法。
- 显式错误而非猜测：除零、幂运算溢出到非有限值、函数结果 NaN/溢出、
  未知函数/标识符、缺括号、表达式后残留字符。
- 返回格式 `表达式 = 值`。工具层校验 `expression` 非空字符串。

这是硬约束"禁 eval"的落点：`new Function`/`eval` 一行都不许出现。

## 3. current_time（time.ts）

模型没有时钟。返回三行：ISO 8601 UTC、本地时间字符串、`UTC+HH:MM` 偏移。
无参数。

## 4. filesystem（filesystem.ts）：read_file / write_file / list_dir

除路径边界（04 篇）外的行为设计：

### read_file

- `MAX_READ_BYTES = 200_000` 约束的是**返回内容**，不是可读的文件：全量读
  超限文件会报错并指向 `offset`/`limit`（对任意大小的文件都可用）；区间读
  的行超过上限则报错要求更小的 `limit`。绝不静默截断。
- 支持行区间：`offset`（1 起）+ `limit`；区间模式下输出带行号前缀与头行
  `path (lines a-b of N, CRLF?)`。`offset` 越界优雅降级（报总行数而非崩），
  非正整数直接报错。
- 空文件返回 `(path is empty)` 占位——模型能区分"空"与"失败"。
- 模型看到的永远是 LF（行尾体系见 §5）。

### write_file

- 父目录 `mkdir -p` 递归创建。
- **行尾保留**：覆盖已有文件沿用该文件现有 EOL；新文件用 LF（§5）。
- **before 快照读的失败语义**：写前读一次旧内容，既做 EOL 检测又做 undo
  快照。这个读**只容忍 ENOENT**（视为新文件，`before: null`）；其他读
  失败（权限等）直接抛错——把真失败吞成"文件是新的"会让 undo 把已存在
  文件删除掉。
- 成功后 `recordChange({ path, before, after: payload })`，返回写入字节数。

### list_dir

条目排序，目录带 `[dir] name/`，文件带 `[file] name (N bytes)`（大小
stat 失败则省略，不整体失败）。空目录占位。

## 5. 行尾子系统（filesystem.ts 内，三工具共享）

根因：**模型只能产出 LF**——`\r` 无法在工具参数里存活，读侧又把 `\r\n`
归一掉，暴露 `\r` 只会制造模型无法复现的文本。因此工具替模型管理行尾：

- `detectLineEnding`：**纯度判定**——仅当*每一条*换行都是 `\r\n` 对才
  判 CRLF。一个游离 `\r\n` 不得把 LF 文件重分类，否则编辑一行 = 全文件
  重写 + git blame 毁掉。孤立 `\r`（经典 Mac）不视为换行，按普通文本
  透传，永不重写。
- `normalizeLineEndings`（只转 `\r\n` → `\n`，模型视角）与
  `applyLineEnding`（写回时还原文件自身 EOL）。
- `splitLines`：兼容两种换行切行，丢掉末尾换行产生的空元素。

## 6. edit（edit.ts）

精确串替换（str-replace，同 Claude Code 的 Edit / opencode / Cline）：
替换最小有意义跨度而非整文件重写，diff 最小，文件其余部分零扰动。

规则与设计：

1. `old_string` 必须在文件中**恰好出现一次**——0 次是错（没找到），>1 次
   是错（歧义），报错信息引导模型补上下文行制造唯一性。
2. `old_string === new_string` 拒绝（无变化）。
3. **LF 空间匹配**：文件与 needle 都先归一到 LF 再比对，替换后按文件
   自身 EOL 写回。模型发不出 `\r`，逐字节比对会让 CRLF 文件的多行
   `old_string` 永远匹配失败。若 old_string 含 `\r` 且文件是 CRLF，附加
   提示"用 LF"。
4. `recordChange({ path, before: raw, after: updated })`——快照是**原始
   字节**（含 CRLF），undo 能精确还原（`test/agent.test.ts` 有行尾级断言）。

## 7. search（search.ts）：glob / grep

### 目录遍历 walk（两工具共享）

- 不可读子目录跳过继续（权限竞争、目录被删），不致命；
- **符号链接目录不跟随**（isSymbolicLink 既非 file 也非 dir，直接忽略）
  ——环不会无限递归，也不会借链接读出根外内容；
- 跳过目录集合 = 内置 `DEFAULT_SKIP_DIRS`（node_modules/.git/dist/
  .next/build/.cache）∪ 根 `.gitignore` 的目录项（宽松解析：去注释/取反/
  空行，取首段路径名）；
- `ctx.signal` 中止遍历，`throwIfAborted` 把取消变成报错而不是交付看似
  完整的残缺列表。

### globToRegex（自研，无依赖）

匹配对象是 POSIX 分隔的相对路径。`**` = 任意深度（可吞斜杠）、`*` =
单段内任意、`?` = 单字符、`{a,b}` = 交替、`[...]` = 原样透传为字符类，
其余字符转义。

### glob

结果为相对路径、排序、上限 `MAX_MATCHES = 200` 截断并标注剩余数。
无匹配明确说明（区别于报错）。

### grep

- 正则非法 → 报 provider 可读的错误（带正则引擎的消息）；
- `include` glob 过滤文件（无 `/` 时按 basename 匹配）；
- **二进制跳过**：buffer 含 NUL 字节即非文本，跳过；
- 每行截断 500 字符；结果上限 200 行；
- `context: N` 输出 `file-N-line-N-内容` 上下文块（匹配行用 `:`，
  上下文行用 `-`，块间 `--`，尾部分隔符剥掉）；`context: 0` 用紧凑的
  `file:line:内容` 格式。

## 8. shell（shell.ts）

参数：`command`（必填非空）、`timeout`（秒，1–300）、`workdir`（相对根，
**经 `resolveToolPath` 校验**）。执行与安全机制见 04 篇 §4–§6，此处补
循环视角的契约：

- 权限链结束后才 spawn；链上任何拒绝都是**抛错**（agent 转成观察），
  错误文案明确指示模型"不要变着花样绕过拒绝，去问用户"——工具
  description 与 promptGuidelines 里重复了同一条纪律。
- `timeoutMs: AGENT_FALLBACK_TIMEOUT_MS`（305s）覆盖 agent 默认 30s：
  工具自己的 300s 上限（含杀进程树）先到，agent 层超时只是兜底。
- 输出 stdout+stderr 合流保尾（2000 行 / 50KB），截断标注
  `[output truncated; only the tail is shown]`。
- 非零退出码、超时、abort 都抛错并附已捕获输出——模型据此能读失败现场。

## 9. web（web.ts）：web_fetch / web_search

**web_fetch** 刻意保持客户端实现（路线图第 2 项）：与 provider 无关、
可离线测试、可审批。就是一次全局 `fetch` 的 GET：

- **上限**：20s 超时（经 `AbortSignal.any` 与 `ctx.signal` 合并）、2MB
  **增量**下载上限（流式中途放弃，绝不整体下完再量）、20,000 字符的内容
  上限加截断标记。重定向按平台默认跳数跟随；展示任何内容之前，**最终**
  URL 要重新过一遍下面的私网门禁。
- **content-type 门禁**：`text/*`、`application/json`、`application/xml`、
  `application/xhtml+xml`；其余（二进制载荷）直接拒绝。HTML 走一段最小
  转换：注释与 `script`/`style`/`noscript`/`template` 子树整块删除，块级
  标签变成换行，其余标签剥掉，命名 + 数字实体解码，空白折叠。从不渲染、
  从不执行 JavaScript。JSON 原样透传。
- **内网门禁（同意，不是遏制——04 篇）**：一个能抓 URL 的工具离用户的
  网络只有一次调用之遥。`isPrivateHost` 对主机名字面量分类——
  `localhost`/`*.localhost`/`*.local`，IPv4 `0/8`、`10/8`、`127/8`、
  `172.16/12`、`192.168/16`、`169.254/16`，IPv6 `::1`、`::`、`::ffff:`
  映射的 IPv4、`fc00::/7`、`fe80::/10`——发往其中任何一个都要过
  `ctx.approve`（没有 approver 时默认拒绝）。批准一个主机不等于批准重定向
  落到的*另一个*私网主机：对 `127.0.0.1` 的批准不覆盖 `localhost`。

**web_search** 是配置所选搜索 API 的薄客户端：`brave`（GET
`api.search.brave.com`，`x-api-key` 头）、`exa`（POST `api.exa.ai/search`）、
`perplexity`（POST `api.perplexity.ai/chat/completions`，答案 + 引用）。
后端来自配置（07 篇）；未配置时工具会把配置方法讲清楚，而不是无声失败。
结果格式化为 `[n] 标题 — url` 加摘要，上限与 `web_fetch` 一致。provider
原生的服务端 web 工具（DeepSeek / Anthropic / OpenRouter `:online`）是
另一套、更晚的机制——它依赖路线图第 3 项的按 provider 协议工作和 3.2 的
content block。

## 10. task（task.ts）：子代理

`execute` 派生一个嵌套 `Agent`——它只是一个库调用方，`agent.ts` 零改动：

- **独立上下文、独立工具集**：子代理的 history 从空开始，prompt 就是任务
  简报；默认工具是只读集（calculator、current_time、list_dir、read_file、
  glob、grep）。没有写入方、没有 shell——子代理的写操作父级 `/undo` 日志
  追踪不到，所以默认干脆不给它写的能力；要给写入工具必须显式传 `tools`，
  且其变更留在子代理自己的、用完即弃的日志里。
- **独立步数预算**（`maxSteps`，默认 12）与 600s 工具超时——默认 30s 会
  杀死真实的子运行。
- **共享取消与同意**：父级的 abort 信号就是子代理的信号；`ctx.approve`
  成为子代理的 approver，子代理逃不出同意链。
- **结果契约**：最终答案 → 观察文本；`max_steps` → RunResult 的
  "Stopped after N steps..." 文案；取消 → `Error: the task was cancelled`；
  provider 失败直接抛出，由父级转成 `Error: ...` 观察（"工具失败是数据"）。
- **无递归**（默认工具集不含 `task` 自身）、**不持久化**（v1 的子运行
  不落为会话）。
- LLM 经 `getLLM()` 闭包按调用解析——会话中途 `/model` 切换对子代理
  同样生效。

## 11. 新增工具检查单（AGENTS.md 硬性要求）

1. **审批评审**：有副作用的工具加入 `createDefaultTools()` 前先评审它的
   审批行为；某个调用需要用户同意时，`execute` 里按调用逐次检查并调
   `ctx.approve`（shell 看命令、web_fetch 看 URL、MCP 看加白清单）——
   没有静态风险字段；一个"按工具而非按调用"决定风险的工具本身就是
   形状不对。
2. **写文件必须 `ctx.recordChange`**，携带被替换内容——不参与的写入方
   使自己的变更不可 undo。
3. **碰文件系统必须 `resolveToolPath`**（禁止直接 `resolveInsideRoot`，
   它看不见链接）。
4. **喂系统提示词**：写 `promptSnippet`（何时用它）与 `promptGuidelines`
   （行为规则，会与其他工具的合并去重）。
5. **参数 schema**：`additionalProperties: false` + 精确描述；描述里写
   清何时用、何时用兄弟工具替代。
6. 若工具会让模型写 shell 命令或涉命令解析：改动 `isReadOnlyCommand`
   必须在 `test/shell.test.ts` 加双方言对抗用例。
7. 超时预算：默认 30s，长任务用 `timeoutMs` 显式声明。
