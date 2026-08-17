# Cursor 与 Grok/xAI 用量接入研究

> 核对日期：2026-08-17。仅使用 Cursor 与 xAI 官方文档、API 参考和定价页面；未读取或测试任何本机凭证。

## 结论

| 场景 | Token / 费用 | 订阅剩余额度 | 是否建议接入 | 预估工作量 |
| --- | --- | --- | --- | --- |
| Cursor Teams / Enterprise | 官方 Admin API 可取逐请求 Token、缓存 Token、模型和费用 | API 没有直接返回权威 `remaining` / `percentage` | 建议 | 中等，2–4 个开发日 |
| Cursor 个人 Pro / Pro+ / Ultra | Dashboard 可看，但没有公开、受支持的个人用量 API | 没有官方 API | 不建议通过网页 Cookie 或本地数据库逆向 | 官方方案当前不可做；非官方原型 3–7 日且维护风险高 |
| xAI API | 官方支持逐请求真实费用，也支持团队历史用量、余额和支出上限 | 预付余额和后付费上限可取；这不是 SuperGrok 周额度 | 建议 | 中等，2–3 个开发日 |
| Grok / SuperGrok 消费订阅 | 设置页可看各产品占比 | 页面显示周额度百分比、重置时间和 Extra Usage Credits，但没有公开消费者额度 API | 暂不建议自动接入 | 官方方案当前不可做 |

因此，“加 Grok”必须先确定含义：

- 如果是 **Cursor 里的 Grok 模型**，它已经属于 Cursor 用量，接 Cursor Admin API 后按 `model` 汇总即可，不能再向 xAI 重复计费。
- 如果是 **直接调用 xAI API**，官方计费接口完整，适合接入。
- 如果是 **grok.com / SuperGrok 订阅额度**，官方目前只支持在设置页查看，不存在适合本地托盘调用的公开额度 API。

## Cursor

### 官方 API 与数据粒度

Cursor Admin API 面向团队管理员，基址为 `https://api.cursor.com`。管理员在团队 Dashboard 创建组织级 Admin API Key，请求使用 HTTP Basic Auth，API Key 作为用户名、密码留空。该 Key 与普通 Cursor CLI 的 User API Key 不是同一能力，不能混用。

- `POST /teams/filtered-usage-events`：按时间、用户分页返回逐请求事件，包括时间、模型、类型、请求单位、是否按 Token 计费；`isTokenBasedCall=true` 时包含 input/output/cache read/cache write Token 和 `totalCents`。
- `POST /teams/daily-usage-data`：按用户、按日返回请求和活动汇总；单次日期范围最多 90 天。
- `POST /teams/spend`：返回当前日历月的成员支出、请求数、成员硬上限和订阅周期开始时间。

来源：[Cursor Admin API](https://docs.cursor.com/en/account/teams/admin-api)、[Cursor CLI Authentication](https://docs.cursor.com/en/cli/reference/authentication)

### 剩余额度边界

官方定价文档说明个人方案在编辑器和 Dashboard 显示用量与 Token 明细；当前用量拆成不同池，Cursor 自有模型（包括 Cursor 中的 Grok / Composer）与其他模型不能简单合成一个百分比。Admin API 当前也没有直接返回 `remaining` 或 `percentage` 的端点。

团队版可以用事件费用、当月支出和已知硬上限做“已消费 / 上限”展示，但不能把这个推导值标成 Cursor 官方剩余额度。个人版没有公开用量 API，读取网页 Cookie、调用未公开 Dashboard 接口或逆向本地数据库都属于不稳定方案。

来源：[Cursor Models & Pricing](https://cursor.com/docs/models-and-pricing)、[Cursor Pricing](https://cursor.com/pricing)、[Cursor Dashboard](https://docs.cursor.com/en/account/teams/dashboard)

### 接入本应用的成本与风险

Teams / Enterprise 的最小可靠实现约 2–4 个开发日：新增 Admin Key 配置并用 Electron `safeStorage` 保存；实现事件分页、日期范围、缓存、429/网络退避；把 Cursor 作为第三个 provider 接入快照、悬浮窗和详情页；增加脱敏与回归测试。

主要风险：

- Admin Key 是组织级凭证，能看到成员邮箱和团队用量；应用不应持久化原始邮箱或逐请求事件。
- Admin API 标注为首版，响应字段可能演进；官方页面未公布该 API 的明确限流数字。
- 并非所有事件都有 Token 明细；包含在订阅中的非 Token 事件只能按请求单位统计。
- Cursor 官方展示多个用量池，做成单一额度百分比会失真。

## Grok / xAI

### xAI API：官方接入可行

xAI 提供两种互补的计费数据：

1. **逐请求**：Chat Completions、Responses、图像和视频响应的 `usage.cost_in_usd_ticks` 是该请求实际结算费用，已经包含缓存折扣、Token 和服务端工具费用；`1 USD = 10^10 ticks`。普通推理 API 使用 `Authorization: Bearer <XAI_API_KEY>`。流式 REST 请求需启用 `stream_options.include_usage`，费用只在最终 chunk 返回。
2. **团队历史与余额**：Management API 基址为 `https://management-api.x.ai`，使用独立的 Management Key（Bearer），并需要团队权限。`POST /v1/billing/teams/{team_id}/usage` 可按时间范围和维度聚合历史 API 用量；`GET .../prepaid/balance` 返回预付余额变化和总额；后付费端点可取当月预览及 spending limits。历史用量响应可能返回 `limitReached=true`，表示高基数查询只返回子集。

对托盘应用而言，应优先用 Management API 拉取历史账单和余额。仅解析逐请求响应只能统计由本应用代理或直接发出的请求，无法覆盖其他客户端已发生的调用。

来源：[xAI Cost Tracking](https://docs.x.ai/developers/cost-tracking)、[xAI Management API Guide](https://docs.x.ai/developers/management-api-guide)、[xAI Billing Management API](https://docs.x.ai/developers/rest-api-reference/management/billing)、[xAI Usage Explorer](https://docs.x.ai/console/usage)、[xAI API Pricing](https://docs.x.ai/developers/pricing)

### SuperGrok 消费订阅：没有官方程序接口

xAI 官方 FAQ 说明，付费用户使用一个共享周额度池，设置页显示总使用百分比、按 API / Build / Chat / Imagine / Voice 的占比、周重置时间和 Extra Usage Credits。官方 FAQ 和开发者 Management API 均未提供读取个人 SuperGrok 周额度的公开端点；Management API 管理的是 xAI API 团队账单，不能等同于消费者订阅额度。

来源：[Grok Website / Apps FAQ](https://docs.x.ai/grok/faq)、[Grok Overview](https://docs.x.ai/grok/overview)、[xAI Pricing](https://x.ai/pricing)

### 接入本应用的成本与风险

xAI API 的可靠实现约 2–3 个开发日：让用户显式填写 Team ID 和 Management Key，在 xAI Console 仅启用读取账单所需的端点权限，并用 `safeStorage` 保存；轮询 usage / balance / spending limits；处理时区、聚合、`limitReached`、限流与过期凭证；增加 UI 和测试。不需要读取 Grok 或浏览器登录态。

主要风险：

- Management Key 与普通推理 Key 分离，并非每个账户都能创建；需要团队管理员授予相应权限。
- 预付余额、后付费上限、当月费用是不同概念，不能合成一个虚假的“总额度百分比”。
- 模型价格会变化；优先使用官方返回的真实费用，避免本地价格表估算。
- SuperGrok 若采用网页抓取，需要接管登录态且页面随时可能变化，不应作为正式功能。

## 建议顺序

1. 先接 **xAI API**：官方数据最完整，能显示所选日期的 Token / USD、预付余额和当月支出。
2. 有 Cursor Teams / Enterprise 管理员 Key 时再接 **Cursor Admin API**，显示逐请求 Token / 成本和团队当月支出，不伪造剩余额度百分比。
3. 暂不接 Cursor 个人订阅和 SuperGrok 周额度；等待官方公开个人用量 API。
