# 02 · LLM 客户端（llm.ts）

覆盖：`src/llm.ts`——OpenAI 兼容客户端、所有传输共用的重试/SSE 管道，
以及选择协议适配器的 `createLLM` 工厂。换 provider = 改这一个文件（加上
它分发的适配器文件），循环、工具、上下文层一概不动。基于 Node 18+ 的
全局 `fetch`，零依赖。

三种传输实现同一个 `LLM` 接口（路线图 3.3）：

| 文件 | 协议 | 端点风格 |
| --- | --- | --- |
| `llm.ts`（`OpenAICompatibleLLM`） | `openai`（默认） | `POST {base}/chat/completions`——OpenAI / DeepSeek / Moonshot / Groq / Ollama / vLLM / LM Studio 等 |
| `llm-anthropic.ts`（`AnthropicLLM`） | `anthropic` | `POST {base}/messages`——原生 Messages API |
| `llm-google.ts`（`GoogleLLM`） | `google` | `POST {base}/models/{model}:generateContent`（流式 `:streamGenerateContent?alt=sse`）——原生 Gemini API |

协议由 `createLLM({ protocol })` 选择；解析后的配置来自显式配置或按已知
baseURL 推断（07 篇）。适配器复用 `llm.ts` 的 `LLMError`、`isRetryable`、
`backoffDelay`、`parseRetryAfter`、`startIdleTimeout`，所以重试/退避与
超时语义在所有传输上一致。

**Reasoning content（路线图 3.1）。** 推理 provider 会在答案之外流式输出
隐藏思考。`chat` 把响应里的 `reasoning_content` 字段映射为
`LLMResponse.reasoning`；`stream` 发出 `{type:'reasoning', delta}` 事件。
agent 把它存到 assistant 消息上、CLI 里变暗展示，而投影会在之后每次请求
前剥离它——推理 provider 会拒绝回显它的请求（03 篇）。

## 1. 构造（OpenAICompatibleOptions）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 必填 | 缺失构造即抛 `LLMError('Missing API key')` |
| `baseURL` | `https://api.openai.com/v1` | 必须含版本段（`/v1`）；尾部斜杠被剥掉后拼 `/chat/completions` |
| `model` | 必填 | |
| `temperature` / `maxTokens` | 不发 | 未设置时请求体不带该字段 |
| `timeoutMs` | 120000 | chat 的总超时 / stream 的空闲超时，双语义见 §3 |
| `maxRetries` | 2 | 额外重试次数（2 = 最多 3 个请求），对齐 OpenAI SDK |
| `baseDelayMs` / `maxDelayMs` | 500 / 30000 | 指数退避的基与上限 |
| `fetch` | 全局 fetch | 测试注入点 |

## 2. LLMError

传输失败与非 2xx 的统一错误类型：`status`（HTTP 状态码）、`body`
（原始响应文本）、`retryAfterMs`（从 `Retry-After` 头解析）。CLI 靠
`status` 给出人话提示（401/403 → key 被拒；404 → 检查 baseURL 版本段与
模型名；429 → 限流）。重试逻辑靠 `retryAfterMs` 优先遵循服务器指令。

## 3. 两条超时哲学（本项目最容易理解错的地方）

- **非流式 `chat()`：总超时。** 在整个答案就绪前没有任何进度可观察，
  唯一能用的界就是总时长。`combineSignals(外部 signal, AbortSignal.timeout(timeoutMs))`
  用 `AbortSignal.any` 合并——引擎要求 >= 22.18，该 API 一直有。曾有手写
  fallback 在 `any` 缺失时只返回外部 signal，**静默丢掉超时**，让挂死的
  请求失去唯一约束，所以现在直接要求 `AbortSignal.any`。
- **流式 `stream()`：空闲超时。** 一个推理模型合法地花几分钟产一条答案，
  总超时会把它在句子中间掐死，而连接本身完全健康（实测：某 provider 每
  300ms 滴一点 body 就被当时的配置切断）。因此用 `startIdleTimeout`：
  每来一个 chunk 调 `keepAlive()` 把截止线推后，衡量的是**静默**而不是
  总时长。

`startIdleTimeout` 返回 `IdleTimeout`：`signal`（到点自动 abort）、
`controller`（调用方主动取消用）、`keepAlive()`（喂狗）、`dispose()`
（停表）、`timedOut()`（区分"模型没声音了"与"用户取消了"——前者包装成
带解释的 `LLMError`，后者原样上抛）。

外部 signal 通过 `addEventListener('abort')` 桥接进 idle 控制器，
finally 里移除监听并 dispose。

## 4. chat() 流程

```
buildBody → fetchWithRetry(总超时信号) → response.text()
  → JSON.parse 失败 → LLMError("Model returned invalid JSON: <前500字符>")
  → parsed.error?.message → LLMError（HTTP 200 但 body 里带 error 的提供商）
  → 无 choices → LLMError("Model returned no choices")
  → 归一化：content / toolCalls（缺 id 时合成 call_${index}）/ usage
```

## 5. stream() 流程

```
body.stream = true; body.stream_options = { include_usage: true }
fetchWithRetry(idle.signal, 外部signal, onAttempt = idle.keepAlive())
  ← onAttempt 让每次重试有自己全新的空闲截止线，不背上上次尝试已花的时间
for await chunk of parseSSE(response):
  idle.keepAlive()                     ← 每帧喂狗
  delta.content → 累加 + yield { type:'delta' }
  delta.tool_calls → 按 index 增量重组：id 覆盖、name 覆盖、arguments 追加
                     （跨 chunk 分片重组，这是 SSE 工具调用的事实协议）
  finish_reason / usage 记录
结束后按 index 序 yield { type:'tool_call' }，最后 yield { type:'done' }
  ← done 携带全量 content、finishReason、usage，调用方无需重组
```

错误路径：`toLLMError(error, 外部signal, idle.timedOut())` —— 外部取消
原样抛（调用方自己在查 signal）；`timedOut` → "Model stalled for Nms with
no data; giving up"；其余 body 读取阶段错误 → "Reading the model response
failed: ..."。这段归一化是必要的：response body 中途断开抛的错误不经过
`requestOnce` 的 catch，曾以裸 `DOMException`（"The operation was aborted
due to timeout"）逃到用户面前，CLI 的状态提示全不触发。

## 6. parseSSE：SSE 帧解析

wire 格式是一串 `data: {json}\n\n` 帧，终止于 `data: [DONE]`：

- `TextDecoder` 带 `stream: true` 增量解码，多字节字符（中文）跨 chunk
  不会被劈开；
- 按 `\n\n` 切帧，残尾留在 buffer；
- 每帧逐行找 `data:` 前缀，`[DONE]` 返回，坏 JSON 抛 `LLMError`
  （provider 错误，不是裸 `SyntaxError` 逃逸成无类型崩溃）；
- 流结束时 flush 没有尾随空行的最后一帧；
- `response.body` 为空 → `LLMError('Streaming response had no body')`。

## 7. 重试与退避（fetchWithRetry）

```
attempts = maxRetries + 1
每轮: onAttempt?.() → requestOnce(body, signal, cancel)
失败: isRetryable? 否 或 已是最后一轮 → 抛
      外部 cancel / bound signal 已 abort → 抛（取消不该被重试吃掉）
      delay = retryAfterMs ?? backoffDelay(attempt)
      await delayOrAbort(delay, signal)   ← 退避可被外部 signal 打断
```

`isRetryable`：只有 `LLMError` 可重试。无 status（网络错误、超时）= 可重试；
`429` 与 `5xx` = 可重试；其余 4xx（key 错、请求错）是调用方的错，重试不会
好转——不重试。

`backoffDelay(attempt, base, max)`：满抖动（full jitter）指数退避，
`floor(random() * min(max, base * 2^attempt))`。random 可注入，测试断言
确定性边界。`parseRetryAfter` 同时吃秒数与 HTTP 日期两种格式。

`requestOnce` 中 `cancel`（调用方信号）与 `signal`（超时界）保持分离：
`cancel` 触发时错误原样抛（agent 会检查自己的 signal 并转成 aborted 停止），
超时才包装为 `LLMError`。非 2xx 时读 body、携带 status 与 Retry-After 构造
`LLMError`（body 截到 500 字符）。

## 8. wire 格式转换

`toWireMessage`：构建只含 provider 认识字段的新对象（role/content/
tool_calls/tool_call_id）——`summary: true`、`reasoning` 这类本地标记因此
天然不上线。content block（路线图 3.2）经 `textOfContent` 展平：text
block 拼接（thinking 与 image block 是 agent 本地载荷，不走这个传输），
null content 出线上空串。

`toToolCall`：缺 `function.name` 抛 `LLMError`；缺 id 合成 `call_${index}`
（有些 provider 不给 id，没有稳定 id 结果就无法回链）。缺 arguments 补 `'{}'`。

`buildBody`：`tools` 非空才带 `tools`（function 定义数组）与
`tool_choice: 'auto'`——部分本地端点见到空 tools 数组会报错。

## 9. 与测试的关系

`fetch` 可注入，`backoffDelay`/`parseRetryAfter`/`startIdleTimeout`/
`isRetryable` 均导出，`test/llm.test.ts` 通过 `serveFakeProvider`（本地
HTTP 假端点，09 篇）覆盖 wire 格式、重试、超时、SSE 重组与错误分类，全程
无网络、无真实 key。原生适配器在 `test/native-llm.test.ts` 里接受同样的
对待：请求形态（system 提取、`tool_use`/`functionCall` 转换、tool 结果
合并轮）、响应解析（thinking/thought 部分映射为 `reasoning`）、流式 SSE
映射，以及 `createLLM` 工厂分发。`test/reasoning.test.ts` 覆盖 agent 层的
reasoning 生命周期与 block 内容的会话往返。
