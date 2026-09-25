# 09 · 测试体系（test/*）

覆盖目录：`test/`。原则（AGENTS.md 硬性要求）：**测试永不调用真实
provider**——无网络、无真实 key，用 `test/helpers.ts` 的假模型与假端点。

## 1. 运行方式

```bash
npm test               # 全部套件导入单进程（test/run.ts）
npm run test:isolated  # 标准 node --test，每文件一个子进程
npm run typecheck      # tsc --noEmit
```

**单进程策略的原因**：`node --test` 默认每文件 spawn 一个子进程，部分
沙箱环境禁止子进程开管道。`test/run.ts` 直接 `import` 各套件进一个进程，
`npm test` 因此在任何环境都能跑。写新测试文件时记得在 `run.ts` 里补一行
import，否则 `npm test` 不会跑到它。

改代码后（非文档）：必须 `npm run typecheck` + `npm test` 全绿才能提交。
新建/修改的测试文件要单独跑并迭代到通过。

临时目录一律用 `.tmp-*` 前缀（gitignored）。

## 2. 测试基建（helpers.ts）

| 工具 | 用途 |
| --- | --- |
| `ScriptedLLM` | 确定性假模型：按脚本回放 `LLMResponse`，记录每次请求（messages + tools 深拷贝），断言"模型实际收到了什么" |
| `toolCall(name, args, id?)` / `reply(content, ...calls)` | 构造脚本用的便捷函数 |
| `StreamingLLM` + `streamText(text)` | 只实现 `stream()` 的假模型；`streamText` 把字符串拆成逐字符 delta + done |
| `serveFakeProvider(responder, run)` | 起一个本地 HTTP 服务冒充 OpenAI 兼容端点：捕获每个请求（url/method/headers/body），按 responder 回应（可指定 status/payload/raw/delay/headers）。**wire 格式验证不联网**的根基 |
| `completion(message, usage?)` | chat-completions 回复体的快捷构造 |

ScriptedLLM 没实现 `stream`，所以天然覆盖"无流式回退 chat"路径；
StreamingLLM 的 `chat` 会抛错，防止意外走错分支。

## 3. 套件地图（14 个文件，约 230 用例）

| 文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `shell.test.ts` | 45 | **安全敏感核心**：执行/退出码/超时杀进程/输出截尾/workdir 边界；只读分类的对抗矩阵（见 §4）；PowerShell 编码、解析顺序、null 设备；双方言断言 |
| `agent.test.ts` | 40 | 循环全语义：观察回喂、未知工具/坏 JSON/抛错恢复、maxSteps、事件顺序、系统提示词组装、流式 token/工具调用收齐/中途 abort、审批注入与拒绝成观察、投影与 history 保真、usage 锚定、压缩（替换不堆积/失败不动/应急投影）、取消（per-run signal、取消后观察补齐）、undo（还原字节含行尾、删除新建文件） |
| `llm.test.ts` | 26 | wire 格式、history 序列化、id 合成、错误分类（error payload/坏 JSON/无 choices）、总超时、重试（429/5xx/不重试 401/Retry-After/退避边界/退避可中断）、空闲超时（慢流不断、静默断）、SSE 重组、usage |
| `context.test.ts` | 24 | 剪枝规则（头尾+标记、短结果不剪、**history 不被修改**、透传、身份保留）、保护窗口、天花板与年龄规则顺序、应急投影、chars/4、usage 锚点、阈值比例、切点（不拆 call/result）、摘要转写（单条截断/总量丢旧） |
| `config.test.ts` | 17 | 分层优先级、DeepSeek 触发条件、坏配置抛错、0600、provider 预设、listModels、窗口查询（精确匹配/失败吞掉） |
| `search.test.ts` | 16 | glob 语法、grep 行格式/include/二进制跳过/context、根边界、.gitignore、符号链接不跟随、遍历中目录消失 |
| `tools.test.ts` | 11 | 读写回环、list_dir、越界拒绝（含**根内链接逃逸**）、空文件/目录占位、行区间与校验 |
| `session.test.ts` | 11 | 回环、撕裂尾行、快照回放（旧行留盘）、**乱序 append 仍有序 + flush**、二次快照取代、列表元数据、id 唯一可排序、agent hook 触发 |
| `edit.test.ts` | 10 | 唯一匹配、0/多次拒绝、文件其余不动、根边界、CRLF 文件多行匹配、EOL 保留、尾换行与 mismatch 提示 |
| `permissions.test.ts` | 9 | 前缀匹配、deny 胜 allow、全子命令过才 allow、裸 & 切分、宽容解析、前缀派生、shell 工具与规则的接线（allow 免问、**deny 压过审批器**、复合命令走私不了） |
| `calculator.test.ts` | 7 | 优先级、一元/右结合幂、函数常量、大小写与空白、畸形输入拒绝、工具层校验 |
| `eol.test.ts` | 6 | CRLF 读侧 LF 化、写侧 EOL 保留、新文件 LF、纯度判定、CRLF 往返稳定 |
| `prompts.test.ts` | 4 | 工具段生成（去重合并）、无工具为空、默认组装、无工具常量 |
| `integration.test.ts` | 2 | 多步端到端（真写盘）、provider 失败穿透循环 |

## 4. 安全相关变更的测试纪律（AGENTS.md 要求）

`isReadOnlyCommand` / `splitSubcommands` / `evaluate` 的**任何**修改，必须
在 `test/shell.test.ts` 补对抗用例，且：

- 用例类型：复合命令（`&&`/`||`/`;`/`|`/`|&`/裸 `&`/换行）、管道、
  重定向（文件 / `2>&1` / null 设备）、命令替换（`$(...)`/反引号）、
  PowerShell 特有（脚本块 `{}`、splat `@`、子表达式 `()`）；
- **双方言都显式断言**（`'posix'` 与 `'powershell'` 各一遍），不许依赖
  宿主平台默认——宿主推导的方言只能在宿主上测到，PowerShell 转义 bug
  （`\;` 使隐藏命令搭上只读放行、未审批删根外文件）正是因为没人测
  Windows 方言才长期隐身。

## 5. 典型模式示例

验证循环语义（ScriptedLLM）：

```ts
const llm = new ScriptedLLM([
  reply(null, toolCall('write_file', { path: 'a.txt', content: 'hi' })),
  reply('done'),
])
const agent = new Agent({ llm, tools: createDefaultTools(), root: tmp })
await agent.run('write a.txt')
assert.equal(llm.requests[1].messages.at(-1).content, 'hi')  // 模型看到了观察
```

验证 wire 格式（serveFakeProvider）：

```ts
await serveFakeProvider(
  (body, i) => (i === 0 ? { status: 429 } : { payload: completion({ content: 'ok' }) }),
  async (baseURL, captured) => {
    const llm = new OpenAICompatibleLLM({ apiKey: 'k', baseURL, model: 'm', maxRetries: 1 })
    assert.equal((await llm.chat([], [])).content, 'ok')
    assert.equal(captured.length, 2)   // 重试确实发生了第二次请求
  },
)
```
