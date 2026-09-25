# 07 · 配置与 Provider（config.ts + providers.ts）

覆盖文件：`src/config.ts`、`src/providers.ts`、`.env` 加载（cli.ts 内）。

## 1. 配置分层（config.ts）

### 双文件设计

沿用 opencode / dsh 的模式，解决"密钥不能进 git、默认值想进 git"的矛盾：

| 文件 | 内容 | 权限 | 是否提交 |
| --- | --- | --- | --- |
| 全局 `config.json` | API key + 个人默认值 | 首次写入后 `chmod 0600` | 绝不 |
| 项目 `<root>/hi-agent.json` | 无密默认值（baseURL、model、permissions、contextWindow） | 普通文件 | 随仓库共享 |

### 位置

| 平台 | 全局目录 |
| --- | --- |
| macOS | `~/Library/Application Support/hi-agent` |
| Windows | `%APPDATA%\hi-agent` |
| Linux/其他 | `$XDG_CONFIG_HOME/hi-agent`，默认 `~/.config/hi-agent` |

`HI_AGENT_CONFIG_DIR` 环境变量可整体覆盖（测试也用它隔离）。会话文件在其
下的 `sessions/`（06 篇）。

### 优先级链（高 → 低）

```
CLI flags > 环境变量 > 项目 hi-agent.json > 全局 config.json
```

环境变量内部也有序：`AGENT_*` 优先于 `OPENAI_*` / `DEEPSEEK_*`。
`firstDefined` 跳过 undefined 与空串。

### resolveConfig 细节

- **DeepSeek 默认值的精确触发条件**：仅当 `DEEPSEEK_API_KEY` 有值**且**
  `AGENT_API_KEY`、`OPENAI_API_KEY` 都没有时——即用户选了 DeepSeek 专属
  key 且没有更高优先级的 key。此时 baseURL 默认
  `https://api.deepseek.com/v1`、model 默认 `deepseek-chat`；一旦有更高
  优先级的 key 存在，即使用户也设置了 DEEPSEEK_API_KEY，也不套用 DeepSeek
  默认（防止"同时设了两个 key 时 baseURL 和 model 配错对"）。
- 各字段的完整回退链：
  - `apiKey`: override → `AGENT_API_KEY` → `OPENAI_API_KEY` →
    `DEEPSEEK_API_KEY` → project → global；
  - `baseURL`: override → `AGENT_BASE_URL` → `OPENAI_BASE_URL` → project →
    global → DeepSeek/OpenAI 默认；
  - `model`: override → `AGENT_MODEL` → `OPENAI_MODEL` → project →
    global → DeepSeek/OpenAI 默认；
  - `contextWindow`: project → global（须为正数；undefined = 自动压缩
    禁用）。只在文件层提供，CLI/env 不透传它。
- **解析即校验**：JSON 语法错、根不是对象，直接抛带文件路径的错误——
  坏配置要在启动时炸，不能运行中静默走默认。`permissions` 字段在解析时
  就过 `parseRules`（无效条目丢弃，04 篇）。
- `saveGlobalConfig(patch, dir)`：**合并语义**——读旧文件、浅合并、写回，
  不碰 patch 没给的键；目录递归创建；写后尽力 `chmod 0600`（失败容忍，
  Windows 文件权限语义不同）。

### `.env` 支持

cli.ts 的 `loadDotEnv` 调 Node 内置 `process.loadEnvFile('.env')`（可用性
探测后调用，兼容引擎差异），文件不存在静默跳过。`.env.example` 记录了
全部变量与推荐做法（推荐做法其实是零 `.env`：跑一次 setup 写全局配置）。

## 2. Provider 目录（providers.ts）

### PROVIDERS 预设

| id | label | baseURL |
| --- | --- | --- |
| openai | OpenAI | `https://api.openai.com/v1` |
| deepseek | DeepSeek | `https://api.deepseek.com/v1` |
| moonshot | Moonshot (Kimi) | `https://api.moonshot.cn/v1` |
| groq | Groq | `https://api.groq.com/openai/v1` |
| together | Together AI | `https://api.together.xyz/v1` |
| openrouter | OpenRouter | `https://openrouter.ai/api/v1` |
| ollama | Ollama (local) | `http://localhost:11434/v1` |

预设只解决 baseURL。**model 刻意不硬编码**：每个 OpenAI 兼容端点都有
`GET {baseURL}/models`，setup 与 `/model` 查询真实列表让用户挑，
`suggestedModel` 只是端点不可达时的回退提示。

### listModels(baseURL, apiKey?)

`GET /models`（带可选 Bearer），校验 `data` 是数组、抽取字符串 id、排序
返回。非 2xx 或形状不对抛错。超时 10s，`AbortSignal.timeout` 可取消。
cli.ts 的 `pickModel` 用它做实时模型发现，失败回落手输。

### lookupContextWindow(modelId) —— models.dev 社区目录

用途：自动压缩（03 篇）需要知道模型窗口大小。来源
`https://models.dev/api.json`（200+ 提供商、免费、无 key），进程内缓存
整个目录（每会话至多拉一次；**拉失败不毒化缓存**——catch 里把缓存清掉，
下次调用重试）。

匹配规则（每条都有理由）：

- **精确 id 匹配**，跨所有提供商找（目录的 provider 键与本项目预设 id
  常不一致，如 moonshotai vs moonshot；id 近乎全局唯一所以跨界安全）。
  前缀猜测会错配窗口 → 压缩时机错，不做。
- OpenRouter 式 `vendor/model` 取尾段参与匹配。
- **同 id 多提供商窗口不同时取最小**：低估安全（提前压缩），高估会撞
  provider 硬限。
- 任何失败（离线、被墙、超时 5s）→ 返回 undefined，**永不致命**：调用方
  保持已配置窗口或维持无自动压缩。

`resetModelsDevCache` 供测试清缓存。

## 3. 配置的完整生命周期

```
首次运行（无 key 且 TTY）
  → setupFirstRun: 选 provider（或手输 baseURL）→ 输 key
  → listModels 实时发现模型 → 选号（失败手输）
  → lookupContextWindow 查窗口（失败跳过，压缩不启用）
  → saveGlobalConfig({apiKey, baseURL, model, contextWindow?})  0600
后续运行
  → resolveConfig: CLI > env(.env) > project > global > 默认
  → /model 切换: setLLM（对话保留）+ saveGlobalConfig({model, contextWindow?})
```

项目配置示例（可提交）：

```json
{
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "contextWindow": 128000,
  "permissions": { "allow": ["npm run *"], "deny": ["git push *"] }
}
```

`permissions` 的语义与合并规则见 04 篇 §3；`contextWindow` 私有部署时
在此手动设定（models.dev 查不到的模型）。
