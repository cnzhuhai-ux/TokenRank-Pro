# TokenRank 前端功能与接口复刻说明

## 1. 使用目标与基线

- 用途：交给其他软件、AI 或工程师，用新的 UI 重建前端，继续使用原有接口和业务逻辑。
- 整理日期：2026-11-17；分析基线：本工作区提交 `b68907a`，以源码实际行为为准。
- 核心范围：排行榜、我的、时间筛选、工具／模型分析、统计趋势、电脑绑定与同步状态。
- 扩展范围：群榜、日报、日历、周报、分享及个人设置；订阅、提醒、成就列出接入边界。
- 允许更换布局、主题、图表形式、组件库和前端框架；不得更改接口路径、字段语义、统计及权限规则。

### 1.1 截图与当前实现的差异

| 截图元素 | 当前源码依据及新 UI 对应方式 |
| --- | --- |
| 顶部“排行榜” | 对应广场全站榜，也可另设“群榜”入口；两种范围必须明确区分 |
| “我的” | 个人资料、同步状态、用量汇总、工具模型分析及历史统计 |
| 今日／近7天／近30天／累计 | 当前个人页还有“上月”；个人默认累计，榜单默认今日 |
| “组织排名” | 当前没有组织、部门接口；使用全站排名或指定群榜排名，并明确名称 |
| “技术支持”等职位 | 当前用户响应没有职位／部门字段；不能假设后台存在此数据 |
| “刷新设备” | 重查个人／接入状态；没有浏览器远程触发电脑采集的接口 |
| 同步器版本 | 来自 `sync_health.client_version`；不能写死截图中的版本 |
| 输入／输出／缓存 | 缓存可合并展示，也可拆分缓存读／写；总 Token 使用服务端 `tokens` |

| 路径（相对仓库根目录） | 角色 |
| --- | --- |
| `server/public/app/index.html`、`app.js` | 网页入口、页面结构、请求和交互编排 |
| `server/public/app/model.js` | 路由参数、周期、分页合并、账号缓存、日期及金额展示 |
| `server/public/app/app.css`、`assets/` | 旧样式和图片资源；新 UI 可重新设计 |
| `server/public/app/share.js`、`poster.js` | 分享快照、链接、图片导出与撤销 |
| `server/src/worker.js`、`feishu-web.js` | HTTP 路由、会话、用户资料、接入、榜单与个人汇总 |
| `server/src/usage.js`、`rankings.js` | 用量窗口、汇总、活跃天数和我的群排名 |
| `server/src/analytics.js`、`analytics-bundle.js`、`tool-models.js` | 工具／模型分析及下钻 |
| `server/src/history.js`、`trends.js` | 日报、日历、自然周报告与公开趋势比较 |
| `server/src/group-insights.js`、`group-pk.js` | 群聚合统计与群内临时 PK |
| `server/src/sync-health.js`、`costs.js`、`credits.js` | 设备心跳、API 等值金额、积分口径 |

## 2. 页面与功能结构

```text
应用
├─ 排行榜：全站／群榜 → Token／Credits → 周期 → 分页、我的排名
│  ├─ 工具／模型分析 → 占比／趋势／明细 → 工具下模型 → 常用用户
│  └─ 公开趋势榜 → 人数／Token → 本期与上期变化
├─ 我的：资料、同步状态 → 汇总／分析／日历／日报／周走势
│  └─ 设置：修改资料、排名可见性、退出登录、注销账号
├─ 绑定设备／帮助：安装命令、接入码、同步健康、重置凭证、操作说明
└─ 扩展：分享、成就、订阅与充值、消息提醒、邮箱登记
```

旧网页使用 `/app/#/...`：`groups`、`group/:id`、`group-analysis/:id`、`square`、`me`。
新前端可以重新设计路由，但筛选、日期和深链接应可恢复；返回时保留上一级统计上下文。

## 3. 接口调用总约定

1. 以下路径均相对服务端根地址；JSON 成功响应直接返回对象，没有统一的 `data` 外壳。
2. 登录接口返回 `{token,user}`；私有请求使用 `Authorization: Bearer <会话token>`。
3. JSON 写请求设置 `Content-Type: application/json`；头像上传用 `FormData`，浏览器生成边界。
4. 会话 token 与电脑接入码是两种凭证，禁止混用；电脑上报使用接入码，前端查询使用会话。
5. 原网页同源调用，`credentials: 'omit'`、`cache: 'no-store'`，只允许请求 `/api/` 路径。
6. 新软件跨域直连需由服务端配置允许的 `CORS_ORIGIN`；正式部署地址由接入环境提供，不写死。
7. 日期统一北京时间 `Asia/Shanghai`；日期字符串 `YYYY-MM-DD`，时间戳为毫秒。
8. 错误通常为 `{error,code?}`，使用 HTTP 状态码判断；展示服务端错误，不能将失败处理成零数据。

### 3.1 登录与资料

| 方法与路径 | 入参 | 响应／操作 |
| --- | --- | --- |
| GET `/api/feishu/session` | 无 | `app_id,redirect_uri,authorize_url`，用于飞书授权跳转 |
| POST `/api/feishu/session` | `{code}` | `{token,user}`，会话有效期 30 天 |
| POST `/api/wx/session` | `{code}` | 微信小程序登录入口；普通网页不能用假 code 替代登录 |
| GET `/api/me` | Bearer | 当前用户资料与同步状态 |
| POST `/api/profile` | `nickname`、可选 `avatar` | 更新资料，返回当前用户；网页使用 multipart |
| POST `/api/profile/ranking` | `{hidden:boolean}` | 全局隐藏／恢复排名，返回当前用户；不删除个人用量 |
| DELETE `/api/account` | `{confirm:"DELETE_ACCOUNT"}` | 注销；成功 `{deleted:true}`，清除本地会话 |

飞书流程：获取授权配置 → 随机生成 `state` 并在会话存储保存 → 跳转授权 → 校验并消费回跳 state。
随后用 code 换本项目 token，移除 URL 中的授权参数，恢复原页面；应用密钥不能放到前端。
自定义昵称登录后应保留，不能每次用飞书昵称覆盖；退出登录目前只清理前端会话，无专用退出接口。
昵称为 1～16 字且通过服务端内容校验；头像限 PNG／JPG／WebP、非空、不超过 256 KB，校验真实格式。
全局排名隐藏与“只在某群隐藏”独立；隐藏后仍可查看自己的私有统计。

用户字段：`user_id,nickname,avatar_url,profile_complete,connected,last_report_at,rank_hidden,sync_health`。

## 4. 时间与指标口径（必须保持）

| 参数 | 含义 | 以北京时间 2026-11-17 为例 |
| --- | --- | --- |
| `period=day` | 今日 | 11-17 当日 |
| `period=week` | 含今天的连续 7 天 | 11-11～11-17；不是自然周 |
| `period=month` | 含今天的连续 30 天 | 10-19～11-17；不是本自然月 |
| `period=last_month` | 上个完整自然月 | 10-01～10-31 |
| `period=all` | 累计 | 汇总历史；个人趋势仅最近 30 天 |

个人路由默认 `all`，其他主页面默认 `day`；现有网页只在个人页展示累计。
服务端榜单和分析支持 `all`，群数据分析仅支持 day／week／month／last_month。
今日汇总接口附带最近 7 天趋势，不能将该趋势求和当今日总量；上月趋势覆盖上月全部日期。

| 展示项 | 字段／计算 | 约束 |
| --- | --- | --- |
| 总 Token | `summary.tokens`／榜单行 `tokens` | 原版总量口径，含缓存；不在前端重算 |
| 输入／输出 | `input_tokens`／`output_tokens` | 独立展示服务端值 |
| 缓存 | `cache_read + cache_write` | 榜单行提供合并后的 `cache` |
| 调用次数 | `requests` | 不是会话数、工具数或活跃天数 |
| API 等值金额 | `cost.usd_micros / 1000000` | USD 估算，非实际支付；不能与订阅支出混同 |
| Credits | `credits.total`／榜单行 `credits` | 工具自报积分，独立于 Token 和金额，不相加／兑换 |
| 汇总活跃天数 | `summary.active_days` | 所选期内 Token>0 或请求>0 的天数 |
| 历史活跃与连续记录 | `activity` | 历史 Token、请求或 Credits 任一>0；不是所选周期天数 |

数字原值保留；万／亿缩写只用于显示，可提供完整值。金额缺失、积分未上报、未同步均不等于零。

## 5. 排行榜与群榜

### 5.1 接口合同

| 方法与路径 | 入参／响应 |
| --- | --- |
| GET `/api/leaderboard` | `scope=global/group,period,metric=tokens/credits`；group 必须带 `id` |
| GET `/api/my/rankings` | `period`；返回 `period,groups,global,updated_at` |
| GET `/api/my/groups-overview` | `period`；返回 `{user,rankings}`，群榜列表首屏优先使用 |
| GET `/api/groups/:id/page` | `period`；返回 `user,group,board,insights,insights_error?` |
| GET `/api/groups/:id` | 群基本信息、成员数、加入状态及改名权限 |
| GET `/api/groups/mine` | `{groups:[{id,name,my_hidden,members}]}` |
| POST `/api/groups/:id/rename` | `{name}`；1～100 字及内容校验；遵守 `can_rename` |
| POST `/api/groups/:id/visibility` | `{hidden:boolean}`；返回 `{id,my_hidden}`，只影响本群 |
| POST `/api/groups/:id/leave` | 无业务字段；返回 `{ok:true}`，退出后个人用量保留 |
| GET `/api/groups/:id/insights` | `period`；群总量、费用、活跃人数及 tools／models 分析 |
| POST `/api/groups/:id/compare` | `{period,rank,snapshot}`；群内临时 PK，只用于 Token 榜 |

榜单响应：`scope,period,metric,day,group,entries,me,total,snapshot,has_more,next_offset,updated_at`。
群榜额外有 `members`；`total` 是当前榜单人数，不能替代全部入群人数 `members`。
行字段：`rank,nickname,avatar_url,tokens,credits,requests,cache,top_model,top_tool,global_rank`。
`me` 为独立排名摘要（无昵称头像、无 cache），不受当前分页限制；用当前用户资料补头像昵称。
群信息字段：`id,name,members,created_at,joined,owner_id,named,can_rename,my_hidden`；群榜 rank 为群内名次。
群排名摘要字段：`my_rank,my_tokens,my_credits,rank_hidden,group_hidden,profile_required,global_rank`。

### 5.2 排序、权限与分页

- Token 榜按 Token 降序，Credits 榜按积分降序；同值按内部用户 ID 升序，前端不得重新排名。
- 全站榜允许匿名读取；传会话才有本人 `me`；当前网页入口仍要求登录。
- 全站榜包含零用量成员：已有码或加入过群榜的公开账号也可能上榜。
- 群榜要求登录、已入群、昵称头像完整；仅所选指标大于零的公开成员参与。
- 全局隐藏、停用账号不参与公开统计；群隐藏还会排除本群统计，但不影响其他群。
- 每页 50 条，首屏 offset=0；续页携带 `offset=next_offset&snapshot=首屏快照`。
- 续页 409 表示数据变化：清空旧页、提示刷新；不能拼接新旧快照或自行递增 offset。
- 每行名次使用接口 `rank`；分页合并按 rank 去重；筛选 scope／period／metric／群 ID 时重置分页。
- 群榜 `global_rank`、我的排名汇总按正用量人群计算；全站零用量名次以 leaderboard 的 me 为准。
- 创建／加入群不是任意填 ID：网页通过飞书群机器人“加入”；微信依赖群身份校验及明确确认。
- 群创建人可随时改名；默认名未改时成员可命名一次；不能仅靠按钮隐藏替代服务端权限。
- PK 通过 `rank+snapshot` 定位目标，禁止对自己 PK；409 重新选人，422 表示本期没有自己的记录。
- 群内 PK 返回 `transient:true`，只显示双方摘要；不能生成公开链接、导出或持久保存对方信息。

## 6. 我的：汇总、分项与排名

首屏请求 GET `/api/my/overview?period=week`，返回 `{user,usage}`；也可单独 GET `/api/my/usage`。
概览允许局部成功：`usage:null` 时读取 `usage_error.error/statusCode`，仍显示正常用户资料。
周期变化重新读取汇总和分析；点击查看排行榜带同周期，个人累计跳现有群榜入口时回退今日。

| usage 字段 | 类型及语义 |
| --- | --- |
| `period,from,to,timezone,token_basis` | 实际范围和口径，`token_basis=upstream_total` |
| `summary` | tokens、input_tokens、output_tokens、requests、cache_read、cache_write、active_days |
| `tools,models` | `[{name,tokens,percent,unclassified?}]`，总量分布，可包含“其他 / 未分类” |
| `daily,trend_days` | `[{day,tokens,requests}]`；旧汇总趋势缺日会补零，不含 reported 标志 |
| `cost` | `status,currency,usd_micros,models,unpriced_models,unpriced_tokens,missing_days,basis` |
| `credits` | `status,total,tools`；可选 models、tool_models；原始分项为数组元组 |
| `standing` | `{rank,participants,hidden}`，正 Token 公开人群排名，可能 rank=null |
| `activity` | `active_days,first_day,last_day,current_streak,streak_as_of,longest_streak` |
| `has_history` | 历史是否存在活跃记录，不是“当前周期一定有记录” |
| `reported_days` | 当前范围确实存在的上报日数量；包括已上报零值日 |
| `first_day,lifetime_tokens,lifetime_credits,last_report_at,updated_at` | 历史摘要及更新时间 |

`cost.status`、汇总 `credits.status` 为 unavailable／partial／complete；partial 必须显示覆盖不完整。
费用按整数微美元返回，真实已计价零金额可以显示 0；unavailable 显示暂无费用，不能强制补零。
`activity` 今天尚未活跃但昨天有记录时不立即断签；最长连续天数按北京时间自然日连续计算。
若要严格区分缺日和真实零值，使用日报／日历／分析响应，不从旧汇总 daily 的零值猜测。

## 7. 工具、模型与统计维度

| 方法与路径 | 查询参数与用途 |
| --- | --- |
| GET `/api/my/analysis` | 个人分析；`period,dimension=tools/models`，要求会话 |
| GET `/api/insights` | 全站公开分析；同上参数，匿名可读，仅公开样本 |
| 上述接口加 `bundle=1` | 无 tool 时返回 `{tools:分析对象,models:分析对象}`，减少首屏请求 |
| 上述接口加 `tool=工具名` | 仅 dimension=models 合法；模型在指定工具内的真实关联分布 |
| GET `/api/insights/users` | `period,dimension,name,tool?`；常用用户列表，支持 offset／snapshot |
| GET `/api/insights/trends` | `period,dimension,metric=users/tokens,end?,offset?,snapshot?` |

分析对象：`scope,dimension,period,from,to,timezone,token_basis,summary,items,daily,credits`，
以及 `trend_days,updated_at,preference_basis,has_overlap`；公开分析额外返回 `access`。
items 行：`name,key,tokens,percent,users,preferred_users,preferred_percent,unclassified,credits?`。
daily 行：`day,tokens,requests,credits,reported,reported_users,parts:[{name,tokens,credits?}]`。

- 占比／趋势／明细属于展示切换；工具／模型、时间周期和工具下钻改变查询；分类选择过滤日分项。
- `users` 是周期内使用过该项的去重人数，一人可用多个工具／模型，人数之和可超过总人数。
- `preferred_users` 是该项为个人主要偏好的人数；常用人数占比使用 `preferred_percent`。
- 服务端按最大已上报份额（含未分类）判定偏好；未分类占主导时不能推断具体工具。
- 纯 Credits 用户可按积分分项确定偏好；“用过人数”不能直接标成“常用人数”。
- Token 占比用接口 percent；分项重叠时 `has_overlap=true`，不能强行将分项加总等同 headline。
- 常用人数只有周期汇总，日趋势仍是 Token；不得据此生成不存在的每日常用人数曲线。
- 模型分析合并提供方前缀、大小写及空白差异；工具名精确匹配，前端不自行合并别名。
- 工具下钻必须依赖显式工具×模型关联；缺失显示“未关联模型”，不能按独立总量比例推算。
- 下钻返回 `association.linked_tokens/unlinked_tokens/percent`、逐日 `details_complete`。
- 下钻的请求、输入、输出、缓存等字段为 null；当前下钻不提供积分关联分析，不能补造。
- 分析 credits 使用 `{scope,total}`；scope 为 tools／models／unavailable，不是汇总 status 协议。
- 缺 Credits 分项时 items 不返回 credits；未覆盖模型不能展示成“积分为零”。
- 常用用户响应含 entries、total、快照分页与 access；与全站榜一样每页最多 50 条。
- 常用用户当前查询还要求该用户周期 Token>0，纯积分偏好人数不保证等于可展开名单人数。
- 群分析返回 summary、tools、models、cost、coverage、snapshot；当前不接入群 Credits 分项分析。

公开趋势只支持 week／month／last_month；默认截至昨日，不接受今天或未来日期。
week／month 对比连续相邻 7／30 天；last_month 对比两个完整自然月，end 必须是月末。
当前网页在“今日→趋势”时实际查询 week；新 UI 应显示真实范围，避免将 7 天趋势标成今日。
趋势按 metric 主排序、另一指标次排序、名称最终排序；此处 users 是用过人数。
行含 `previous_rank,previous_users,previous_tokens,rank_change,value_change` 和可选积分字段。
`rank_change=上期名次-本期名次`；null 表示新上榜，不显示成零变化；同时保留两期 summary 样本数。

## 8. 日历、日报与周走势

| 接口（GET，均需会话） | 参数／响应重点 | 必须保持的行为 |
| --- | --- | --- |
| `/api/my/calendar` | `month=YYYY-MM`；daily、heatmap、summary、snapshot | 默认当前月，禁止未来月份 |
| `/api/my/daily` | `day=YYYY-MM-DD`；summary、tools、models、cost、snapshot | 默认昨日，只接受已结束日期 |
| `/api/my/weekly` | `week=周一日期`；daily、weekly、groups、snapshot | 默认上个完整自然周，可查看本周进行中 |

日历有本月与近 13 周两种视图；heatmap.daily 为 91 格，含 outside／future／reported 及 details。
日期格区分：范围外、未来、未同步、已同步零值、已同步非零；范围外及未来不可点击。
点击有效日期显示 Token，可选设备系统／主力模型／金额；设备表示当前选定设备，不是逐日精确归属。
保存设备／模型／费用展示偏好；公开日历金额默认关闭，只有显式选择才带 `show_amount:true`。
日报缺记录时 `has_history=false`、summary 指标为 null，不能画成真实零用量。
日历／日报／周报分别用响应 previous_month/day/week 与 next_month/day/week 决定翻页禁用。
周报为北京时间周一至周日，不等同近 7 天；weekly 包含峰值、主力模型、上期及上报天数。
`comparison_status`：ongoing=进行中；incomplete=任一期不足7个上报日；zero_base=上期零值；
comparable=两期完整且上期非零，只有此时展示 change_percent；不能对缺失／零基数计算增长率。

## 9. 电脑绑定与同步健康

GET `/api/connect/token` 返回 `token,connected,user_id,last_report_at,sync_health` 及两种 install_command。
connected 仅表示有接入码，不代表在线或上传成功；安装命令使用服务端返回版本，凭证仅本人显示及复制。
POST 同一路径重置凭证，返回新 token 与命令；先确认，旧码立刻失效，所有电脑需重新接入。
重置同时清理旧心跳并取消相关预约；不要把普通“刷新设备”绑定到重置接口。
`sync_health` 主状态取最近联系设备；`agents` 最多20台，`devices` 为参与汇总的有效设备数。
字段包括 state、result、client_version、collector_version、latest_client、update_available、
last_seen_at、last_check_at、check_started_at、source_day、error_code；时间可能为空。
状态：online=在线；checking=检查中；error=检查异常；stopped=已停止；
unreachable=超过15分钟未联系；unknown=无心跳依据。不能仅凭最近上传时间判断是否停用。
多设备同一天用量由服务端相加；单设备重报替换自身日桶；新 UI 不再叠加或去重日桶。
网页只查询状态，不调用采集端 `/report`、`/agent/heartbeat`，不模拟电脑上报或控制本机进程。

## 10. 分享与外围入口

- POST `/api/shares`：个人 usage／tools／receipt 等传 style、period；日／周／日历另带对应日期。
- daily 带 day_snapshot，weekly 带 week_snapshot，calendar 带 calendar_snapshot，使用用户已查看的快照。
- milestone 带 badge_id、achievement_snapshot；群分享 POST `/api/groups/:id/insights/share` 带 period、snapshot。
- GET `/api/shares/:id` 匿名读公开快照；POST `/:id/revoke` 仅作者撤销；POST `/:id/compare` 做同期公开 PK。
- 分享返回 id、style、created_at、expires_at 及 user／usage 或 report；有效期最长90天，以返回值为准。
- 分享是固定日期摘要，非实时个人主页；过期、撤销、账号删除或依赖失效后不得继续展示旧缓存。
- 复制链接、原生分享、下载 PNG 前重新校验；409 让用户刷新后确认，不能静默替换已查看的快照。
- 成就接口为 GET `/api/my/achievements` 和 POST 同路径的 prepare／confirm／release／claim。
- 成就动画通过 prepare 获取 claim_id，实际展示后 confirm，未展示或离开 release；详见 achievements-api.md。
- 订阅：GET／POST `/api/subscriptions`，POST／DELETE `/api/subscriptions/:id`；金额入参 price 为元。
- 充值：POST `/api/topups`，POST／DELETE `/api/topups/:id`；入参 vendor、kind、amount、day、currency、notes。
- 账本金额响应为整数分；币种 CNY/USD/EUR/GBP/HKD/JPY，手工实付与 Token API 等值分开展示。
- 订阅字段：name、plan、price、currency、cycle、custom_days、start_day、status、ended_day、api_key、notes。
- 消息提醒 GET `/api/reminders`，POST／DELETE `/api/reminders/:kind`；按 kinds 和权限显示预约入口。
- 预约提交 request_id，取消提交 id；每次仅预约一次，不能标成永久订阅；详见 reminders.md。
- 邮箱 GET／POST／DELETE `/api/email-registration`；保存 email、consent、consent_version、expected_revision。
- 邮箱删除带 expected_revision；仅登记意向，尚未验证及发信；详见 email-registration.md。

## 11. 新前端状态与异常处理

| 状态／输入 | 初始值与更新 | 下游影响 |
| --- | --- | --- |
| sessionToken／user | 本地会话／登录或资料响应 | 请求鉴权、本人标识、权限 |
| scope／groupId／metric／period | 默认全站／空／tokens／day；个人默认 all | 重查数据并重置分页 |
| view／dimension／tool／category | sum／tools／空／空 | 选择统计页面、维度、下钻及图表分项 |
| day／month／week／end | 昨日／本月／上周周一／昨日 | 历史与趋势查询；读取服务端实际范围 |
| entries／snapshot／nextOffset | 空／空／0；接口响应更新 | 同一筛选和快照下续页 |
| loading／error／requestVersion | 空闲／空／递增标记 | 禁止重复操作、错误重试、防旧请求覆盖 |

缓存按账号＋北京时间日期＋规范化请求参数隔离；原实现 TTL 5分钟，最多100项并合并并发相同查询。
退出、换账号、跨北京时间日期和写操作前后清缓存；手动刷新绕过缓存；旧请求不能覆盖新筛选结果。
凭证、提醒状态、公开分享不使用普通读缓存；切页时清理监听、定时器及未确认的成就展示租约。
加载、空态、失败、部分成功、待升级同步器分别展示；写操作防重复点击，失败后恢复控件。
401 清会话并登录；403 提示权限／停用；404 资源失效；409 快照变化、冲突或需升级同步器。
410 账号已删除；422 本期无可比较数据；428 需完善资料；429 按 Retry-After 等待；500 提供重试。
注销必须明确确认，成功后不自动重新登录；网络失败不能断言已注销，需核实后再处理会话。

## 12. 复刻检查清单

- [ ] 排行榜／我的／绑定入口可用；截图中的职位和组织维度没有被虚构成现有接口。
- [ ] 今日、近7天、近30天、上月、累计及自然周含义准确，统计总量与趋势范围分开。
- [ ] Token 含缓存；费用／积分缺失不补零；输入输出、缓存读写、请求字段对应正确。
- [ ] 全站／群榜、Token／Credits、同值排序、我的排名和50条快照分页与原接口一致。
- [ ] 全局隐藏、群隐藏、资料完整度及入群校验生效，个人私有用量保留。
- [ ] 工具／模型、用过／常用人数、占比／趋势／明细、未关联和未分类均按真实数据展示。
- [ ] 日历未同步与零值、日报结束日期、周报可比性及趋势两期样本数没有混淆。
- [ ] 绑定与刷新不会重置凭证；同步健康不以最近上传时间替代；多设备用服务端聚合。
- [ ] 账号隔离、快速切筛选、局部失败、重试、登录过期及快照冲突均有明确处理。
- [ ] 分享快照、撤销、金额授权和临时 PK 的公开边界保持一致；使用合成数据验收。
