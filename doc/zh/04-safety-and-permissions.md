# 04 · 安全边界与权限体系

覆盖文件：`src/permissions.ts`、`src/command-parse.ts`、`src/tools/shell.ts`
（安全相关部分）、`src/tools/filesystem.ts`（路径边界部分）。

## 0. 总纲：两种边界，性质完全不同

| 边界 | 性质 | 强制方 |
| --- | --- | --- |
| 文件工具不能逃出工作区根 | **遏制（containment）**，机械强制 | `resolveToolPath` |
| shell 命令要不要问用户 | **同意（consent）**，启发式 | 白名单 + 规则 + 审批器 |

白名单上的每个命令在任何平台都能读用户能读的任何文件——这与 Codex
（read-only 仍可读全盘）、Gemini CLI、Cursor 文档化的姿态一致。**遏制需要
OS 沙箱，本项目还没有**。文档与代码注释里反复声明这一点，防止后来者把
"同意机制"误读为"安全边界"而放宽。

## 1. 文件路径边界（filesystem.ts）

三层防线，任何文件工具与 shell 的 `workdir` 都必须走最后一层：

### resolveInsideRoot —— 词法层

`path.resolve(root, target)` 后用 `path.relative` 检查：相对结果以 `..`
开头或是绝对路径 → 拒绝。纯字符串运算，挡住 `..` 穿越与指向根外的绝对
路径。**它看不见符号链接**——AGENTS.md 明令工具禁止直接调用它。

### resolveToolPath —— 解析层（工具必须走这层）

```
absolute = resolveInsideRoot(target)
realRoot = realpath(root)；不存在 → undefined（根尚不能包含链接，放行——
           write_file 要能创建根及其父目录）
realTarget = realpathDeepestExisting(absolute)   ← 目标最深*已存在*祖先的 realpath
relative(realRoot, realTarget) 越界 → 拒绝（"resolves outside the workspace
           root through a link"）
```

为什么需要第二层：`resolveInsideRoot` 是字符串比较，根**内部**一个指向
根外的 symlink / NTFS junction 能通过检查，随后的读写沿链接走出去——实测
`<root>/link` junction 使 `read_file link/secret.txt` 返回了根外文件。

`realpathDeepestExisting`：目标不存在（正要写的文件）时逐级向上找最深的
已存在祖先——写操作实际落点的目录被检查。只容忍 `ENOENT`/`ENOTDIR`
向上走；符号链接环、权限错误等**一律失败关闭**（fail closed），因为猜测
会把不可解析的路径变成"允许"。

`displayPath`：给模型看的路径 = 相对根 + POSIX 分隔符（显示形态）。

undo 侧同样尊重边界：撤销日志还原文件前对记录的路径**重新**过
`resolveToolPath`（06 篇）——记录时安全不代表现在安全，链接可能后来才
出现，undo 不能成为唯一一个往根外写东西的路径。

## 2. shell 命令解析（command-parse.ts）

`splitSubcommands` 与 `commandLeaders` 由 shell 工具（只读分类）和权限
规则引擎（前缀匹配）共享。

### 方言感知（为什么必须存在）

两个 shell 对转义的分歧是实打实的漏洞来源：

- bash：`\` 转义下一字符——引号外与 `"…"` 内皆然；`'…'` 内无特殊字符。
- PowerShell：**反引号** `` ` `` 才是转义符（同样三个语境）；`\` 是普通
  字符——所以 `"C:\dir\"` 在 PowerShell 里是完整字符串，在 bash 里是
  被转义的引号。

解析器若相信某分隔符被转义而真 shell 不信，隐藏命令就搭上第一个子命令的
放行结论顺风车：Windows 实测，一条带 `\;` 的 `Get-Content` 行被分类为
只读，未审批删除了根外文件。因此所有方言规则**偏向切分**（更严的方向）：
多切的部分只会让整行更难过审，不会更松。

### splitSubcommands 细节

- 分隔符：`&&`、`||`、`;`、`|`、`|&`、换行、**裸 `&`**。
  裸 `&` 在两种方言里都是分隔符（POSIX 后台、PowerShell 7 背景操作符、
  早期版本调用操作符——切分对三者都取严）。漏掉它曾让
  `type a.txt & del a.txt` 只凭首词通过只读测试。
- `&` 紧邻 `>` 不算分隔符（`2>&1`、`>&2`、`&>file` 是重定向）。
- 引号内不切分；单引号内的转义符不生效（两种方言少有的共识之一）。

### commandLeaders 与环境前缀白名单

`commandLeaders` 提取 `(program, subcommand)`，前面可剥离的 `NAME=value`
前缀只限**不可能改变执行内容或读取目标的变量**：`LANG`、`TZ`、`TERM`、
`NO_COLOR`、`LC_*` 等。曾经剥离*所有*前缀是个洞：`PATH=./evil cat x` 会
运行模型投放的 `cat`，而分类器看到的还是白名单里的名字（`LD_PRELOAD`、
`GIT_EXTERNAL_DIFF` 同理，它们本身就是代码执行）。不在此列的赋值保持
原样，首词不再匹配白名单 → 落到审批器。

## 3. 前缀规则引擎（permissions.ts）

规则语法（沿用 Claude Code 模型）：命令前缀，尾随 `*` 可选——
`npm run *` 匹配 `npm run test`、`npm run build` 及裸 `npm run`；
`git status` 只精确匹配自身。

### evaluate：整行判定

```
parts = splitSubcommands(command, dialect)   ← 方言必须与实际执行的 shell 一致
任一 part 匹配 deny 规则 → 'deny'            ← 复合命令不能用一个危险片段走私
每个 part 都匹配某 allow 规则 → 'allow'      ← 与只读分类同策略：全过才放行
否则 → 'ask'
```

`dialect` 参数的意义：切分必须符合将要执行该命令的那个 shell 的语法，
否则真 shell 认得的分隔符藏在第一个子命令里继承它的 allow。空切分结果
（parts.length === 0）→ 'ask'。

`parseRules` 宽容解析配置（非字符串/空串条目丢弃）；`derivePrefixRule`
从用户刚批准的命令派生"本会话永不再问"的前缀：对 npm/git/docker 等
SUBCOMMAND_PROGRAMS 保留两词（`git commit *`），其余留程序名
（`mkdir *`）。

### mergeRules（cli.ts）：项目配置胜出

合并 global 与 project 的规则时，project 的 allow 可以"赎回" global deny
里的同名规则，project 的 deny 可以压制 global 的同名 allow——即同一条
规则冲突时项目层赢。

## 4. shell 只读白名单（shell.ts）

### 审批链（顺序即安全语义）

```
1. 持久 deny 规则        → 直接抛错（"Do not try to work around it"）
2. 持久 allow 规则       → 每个子命令都匹配才放行
3. 只读白名单            → isReadOnlyCommand 放行
4. ctx.approve 审批器    → 拒绝默认（无 approver = 拒绝，错误信息指引配置
                            approver 或 permissions.allow）
```

**deny 先于白名单评估**是硬约束：白名单是便利启发式，写
`deny: ["cat *"]` 的用户必须能关掉启发式开的洞。

### isReadOnlyCommand

每个子命令（复合命令全拆开）都必须只读；任何非只读片段 → 整行需审批。
`isReadOnlySubcommand` 的全局否决项：

- 命令替换 `$(...)` 与反引号（反引号在 bash 是替换分隔符、在 PowerShell
  是转义符，两边都危险，直接否决）；
- PowerShell 的 `(`、`@`、`{` 出现在非引号文本中（子表达式、splat、脚本块
  都是**代码**：`Write-Output (Remove-Item x)` 真的会执行 Remove-Item；
  `withoutQuotedText` 先剥引号串，`Select-String "a(b)c"` 这类正则字面量
  不受影响）；
- 文件重定向（`hasFileRedirection`）；
- 程序名带路径前缀（`/bin/rm`、`C:\tools\x.exe`、`./script`）——永不白名单。

`hasFileRedirection` 的豁免：描述符复制 `2>&1`/`>&2` 与 null 设备
（POSIX `/dev/null`；PowerShell 的 `$null` 与 `nul`，且用负向断言排除
`nul.txt` 这类普通文件名）。其余 `> file`/`>> file`/`< file`/`2> file`
都算文件重定向。

### 白名单命令集（双方言共享，取交集语义）

Windows 上 Git for Windows 环境的名字解析分裂成三类，共享集的每个名字必须
在*任一*解析方式下都只读：

1. PowerShell 别名（别名优先于 PATH 上的任何东西）：`ls`、`cat`、`type`、
   `echo`、`pwd`、`cd`、`diff`、`sort`；
2. Git 的 GNU coreutils（Windows 上同样是 GNU 旗标语义，POSIX 旗标守卫
   在两边都成立）：`head`、`tail`、`grep`、`find`、`wc`、`which`、`stat`、
   `du`、`uniq`、`printf`、`dirname`、`basename`、`realpath`；
3. `whereis` 缺席——那个名字在 Windows 上代价是一次失败调用而非一次审批。

`cd` 在集合里是刻意的：它改变行内后续命令的工作目录，但自身不能写，
`cat /etc/shadow` 这类绝对路径可达之处它不多一寸——与文档化的只读姿态
同性质，不是独立的洞。想关掉就写 deny 规则。

PowerShell 专属集（`POWERSHELL_READ_ONLY_COMMANDS`，Windows 上叠加）：
约 50 个纯读 cmdlet（`Get-ChildItem`、`Get-Content`、`Select-String`、
`ConvertTo-Json`、格式化系列……）及只读别名（`gci`、`gc`、`sls`、`ft`…）。
**危险别名故意缺席**：`rm`/`del`（=Remove-Item）、`sc`（=Set-Content）、
`set`、`ac`、`ni`、`si`、`sp`、`mv`、`cp`、`iex`（Invoke-Expression）、
`ii`、`tee`、`where`（Where-Object 是脚本块过滤器，不是命令查找）。
PowerShell 查找大小写不敏感，程序名先转小写再查。

### 写旗标守卫（白名单命令也能写文件）

| 程序 | 守卫 |
| --- | --- |
| `git` | 子命令限 `status/log/show/diff/rev-parse/ls-files/remote/blame/describe`；`branch -D/-d/--delete`、`tag -d/--delete`、`remote add|rm|rename|set-url|set-head|set-branches|prune|update`（改写 .git/config）、任何 `--output=FILE` 全部否决 |
| `sort` | `-o FILE`（含 `-ro`）与 `--output` |
| `find` | `-delete/-exec/-execdir/-ok/-okdir/-fls/-fprint/-fprint0/-fprintf` **逐字列举**——模式匹配 `-fprint*` 曾恰好漏掉 `-fls`（GNU 与 BSD 都有），`find . -fls OUT` 在只读分类下写了任意文件；`-printf` 故意不在列表（写 stdout 不写文件） |
| `tail` | `-f`/`--follow`（永不终止，只会烧超时预算） |
| PowerShell | `Get-Help -Online`（出网）、`Get-Content -Wait`（永不终止） |

## 5. 子进程环境（childEnv）

`spawn` 的 `options.env` 在 Node 里是**替换而非合并**——不传就是全量
`process.env`，包括 agent 自己的 API key；实测 `echo $env:AGENT_API_KEY`
无审批读回密钥（CWE-526）。因此子进程环境按名单**逐名拷贝**：

- 程序查找与 shell 本身：`PATH/Path/PATHEXT/SHELL/COMSPEC/SystemRoot/...`
- 家目录与临时目录：`HOME/USERPROFILE/TEMP/TMP/...`
- 区域与终端（只影响格式）：`LANG/LC_*/TERM/TZ/NO_COLOR/...`
- Windows 工具假定存在的机器事实：`APPDATA/LOCALAPPDATA/PROGRAMFILES/...`
- 出网代理：`HTTP(S)_PROXY/NO_PROXY` 大小写两套

排除的不只是密钥，还有影响执行的变量（`LD_PRELOAD`、`NODE_OPTIONS` …）。
需要别的变量的命令会失败而不是泄漏——这是刻意的取舍。扩展名单必须逐个
评审。另注：这不是遏制边界——文件里的密钥依然可读。

## 6. 进程执行与管理（runCommand）

- **shell 解析** `resolveShell()`（结果缓存）：Windows → PowerShell 7
  安装位 → PATH 上的 `pwsh.exe`（商店版只有 WindowsApps 执行别名）→
  系统自带 5.1；`cmd.exe` 被刻意不用（方言、引号、OEM 代码页全对不上模型
  写的东西）。POSIX → `/bin/bash`，否则 `sh`。`ShellConfig.dialect` 是
  分类器读的**唯一**方言来源（不直接看平台），解析器与真 shell 永不分歧。
- **PowerShell 编码前导**：`[Console]::OutputEncoding` 固定为 UTF-8——
  中文 Windows 实测两种 pwsh 都是 gb2312，收集端按 UTF-8 解码，每条
  PowerShell 报错都是乱码，模型读不了。前导压在命令第 1 行（行号不漂）。
  遗留原生生具写 OEM 代码页的部分管不了（字节不过 PowerShell 编码器）。
- **调用方式**：命令文本作为**单个** argv 元素传给 `-Command`/`-c`，
  Windows 引号由 Node 处理（PowerShell 理解 `\"`）。`windowsHide`，
  POSIX `detached: true` 让子进程自领跑进程组。
- **超时与取消**：到点或 abort 都 `killProcessTree`——POSIX 杀负 pid
  （整组），Windows `taskkill /F /T /PID`；失败回落杀直接子进程。
- **输出缓冲有界**：累积超过 `2 × 50KB` 就丢头保尾，内存对 `yes` 这种
  命令也有界。返回前 `truncateTail`：先按字节（50KB）再按行（2000 行）
  保尾，字节切点回退到 UTF-8 字符边界，行切点不切半行，截断如实标注。
- **工具自身超时**：模型可传 `timeout`（秒，1–300）；工具的
  `timeoutMs = 305s` > 最大模型超时 300s，保证先杀进程树的是工具自己的
  超时（能给出已捕获的输出），而不是 agent 层的通用超时。
- **结果语义**：非零退出码 → 抛错并附输出；超时 → 抛错附截断输出；
  abort → "Command aborted."；空输出 → `(no output)`。

工具 description 里写死方言提示（Windows 提示写 PowerShell 语法，其他
写 POSIX），让模型不浪费一轮 `ls` 在 Windows 上。

## 7. 审批链的接线（谁提供 approver）

`Agent` 构造的 `approver`（或事后 `setApprover`）→ 每次工具执行的
`ToolContext.approve` → shell 工具在链尾调用。CLI 的实现见 08 篇
（`y`/`a`/`n`，`a` 记忆前缀本会话生效；`--yes` 全自动批准；无 TTY 时
拒绝）。库用户不给 approver 时，非白名单命令一律拒绝——安全默认。

## 8. 已知边界与诚实的限制清单

1. shell 写的文件不进 undo 日志（命令字符串说明不了它要碰什么）——用 git。
2. 白名单命令可读任意用户可读路径——同意机制本义，遏制需 OS 沙箱（未实现）。
3. 白名单是按程序名 + 旗标守卫的启发式，新旗标/新别名可能开洞——所以
   `isReadOnlyCommand` 的任何修改都必须在 `test/shell.test.ts` 补对抗用例
   （复合命令、管道、重定向、命令替换、**双方言**都断言，不能只测宿主
   平台——PowerShell 转义 bug 就是这么漏掉的）。
4. `childEnv` 名单外的变量在 shell 里不可见——故意设计，扩展需评审。
