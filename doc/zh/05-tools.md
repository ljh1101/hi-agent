# 05 · 工具集（tools/*）

覆盖文件：`src/tools/registry.ts`、`index.ts`、`calculator.ts`、
`time.ts`、`filesystem.ts`、`edit.ts`、`search.ts`、`shell.ts`。

工具是普通对象：name + description + JSON Schema + `execute`（+ 可选
`timeoutMs` / `permission` / `promptSnippet` / `promptGuidelines`）。没有
插件系统。路径边界机制见 04 篇 §1，shell 的权限链见 04 篇 §4——本篇讲
各工具自身的行为设计。

## 1. 注册表与默认工具集

`ToolRegistry`：name → Tool 的 Map。重名注册抛错（duplicate tool name）。
`definitions()` 投影出 `{ name, description, parameters }`——广告给模型的
最小集，`execute` 等运行时细节不上线。

`createDefaultTools({ rules })` 返回 9 个工具；`rules` 是来自项目/全局
配置的持久权限规则，只喂给 shell 工具：

| 工具 | 权限等级 | 默认超时 | 一句话 |
| --- | --- | --- | --- |
| `calculator` | read | 30s | 精确算术（递归下降解析器，无 eval） |
| `current_time` | read | 30s | 当前 UTC + 本地时间 |
| `list_dir` | read | 30s | 目录清单（[dir]/[file] + 大小） |
| `read_file` | read | 30s | 读文本文件或行区间 |
| `write_file` | write | 30s | 创建/整体覆盖文件（免审批，退路 /undo） |
| `edit` | write（声明性） | 30s | 唯一串精确替换（免审批，退路 /undo） |
| `glob` | read | 30s | 按路径模式找文件 |
| `grep` | read | 30s | 按正则搜内容 |
| `shell` | dangerous | 305s（工具自带） | 执行 shell 命令（权限链 + 进程树管理） |

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

- `MAX_READ_BYTES = 200_000`：超限报错并建议读局部，而不是静默截断。
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

## 9. 新增工具检查单（AGENTS.md 硬性要求）

1. **权限评审**：有副作用的工具加入 `createDefaultTools()` 前先定权限
   等级；需要审批的在 `execute` 里调 `ctx.approve`（`permission` 字段
   目前是声明性元数据，循环不读，实际门禁在工具内，见 01 篇 §1）。
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
