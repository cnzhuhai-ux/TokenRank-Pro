# TokenRank 独立同步器

v0.2.32 为独立只读适配器，接入原版 [luwill/token-watcher](https://github.com/luwill/token-watcher)。Node.js 22.13+，无第三方运行依赖。

更换服务器、接入码或统计库后，会重新全量上传本机保留的历史用量，包含注销后重新接入的情况。上传中断可分批续传；重复执行同一账号的接入命令不会重传未变化的日期。

```text
AI 工具日志 → 原版 token-watcher → 原版 SQLite 统计库
                                       ↓ 只读快照
                               TokenRank 独立同步器
                                       ↓ 日聚合
                               榜单服务 → 微信小程序
```

## 接入

在小程序「连接电脑」页复制一条专属接入命令，脚本按以下顺序准备环境：

1. 检测 PATH、已保存的实际入口、npm 全局目录和 macOS 服务配置中的原版包。通过包名、仓库标识和实际入口识别，不执行未知同名命令。仅有统计库不代表已安装；旧版 TokenRank fork 不算原版。
2. 已有原版则复用，不重新安装、不升级、不降级、不替换其服务。已有数据先做只读兼容性检查，结构不兼容时停止；原版已装但还没有统计库时调用其 `scan` 初始化。
3. 原版缺失时，从官方 npm registry 安装最新稳定版（不低于 1.8.3），调用原版完成首次采集。已有原版也会检查最新稳定版，有更新时沿用现有安装位置升级、备份重算并回传；已是最新版时跳过重算。原版低于 1.8.2 时暂停上传，1.8.2 的数据仍可正常上报。缺失时安装在用户目录，无须 sudo、不写全局 npm 或覆盖原有命令。
4. 新装原版自动开启采集后台，再配置 TokenRank 的独立只读同步服务、连接账号和回填历史。

原版默认统计库为 `~/.tokenmeter/tokenmeter.db`。新装包位置：macOS/Linux 为 `~/.local/share/token-watcher/node_modules/token-watcher`；Windows 为 `%USERPROFILE%/AppData/Local/TokenWatcher/node_modules/token-watcher`。首次采集可能需要几分钟。

自定义原版路径先将原版命令加入 PATH，或手动配置原版后再接入已有统计库：

```sh
node bin/tokenrank.js doctor --db /absolute/path/tokenmeter.db
node bin/tokenrank.js connect https://your-server.example <32位接入码> --db /absolute/path/tokenmeter.db
node bin/tokenrank.js install-agent
```

npm 发布后，仅注册 `tokenrank` 命令，不注册 `token-watcher` / `tokenwatcher` / `tokenmeter` 等原版命令。

## 更新统计内核并纠正已上传数据

已接入的用户在原电脑执行，无须重新输入接入码。一次完成内核和本地同步脚本升级、备份重建及本账号云端统计的完整替换；日常同步仍只读。

macOS / Linux：

```sh
curl -fsSL https://<你的域名>/update.sh | sh -s https://<你的域名>
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://<你的域名>/update.ps1'))) 'https://<你的域名>'
```

顺序：验证现有安装和后台归属 → 查询官方 npm 最新稳定版并下载 → 暂停同步与采集 → 备份统计库 → 升级原版和 `~/.tokenrank/app` 中的同步脚本 → 在副本中清除可从文件重建的事件与扫描游标 → 用原版 Scanner 从现存日志重新计算 → 校验并切换本地统计库 → 恢复采集 → 分批暂存全量数据 → 云端一次性清除本账号所有旧设备日统计及旧协议日统计、写入新结果 → 恢复每 5 分钟同步。

绑定的账号、服务器、设备 ID 与原服务配置保留。统计库通过 SQLite 快照备份，包含已提交的 WAL 数据，位于 `~/.tokenrank/backups/update-*/tokenmeter.db`；原版程序和同步脚本分别保留旧目录备份。本地重建不沿用旧扫描游标，设置、配额以及不能从本地日志重建的轮询来源（例如 Cursor）保留。重建中每 15 秒尽量输出已处理文件数和耗时。

安装和更新命令每次查询官方 npm 最新稳定版，最低目标为 1.8.3（包含采集卡住后的自恢复）。若 registry 返回更早版本，下载上游已合并的固定源码 [`7ed6f51`](https://github.com/luwill/token-watcher/commit/7ed6f51aa64a80055169a82f91d569b2b0c200bf)。不会把本机更新的稳定版降级。没有修改或拼接原版统计算法，安装脚本禁用 npm 生命周期脚本。版本查询或升级失败会报错，不显示完成；重跑命令可继续未完成的重算。日常每 5 分钟同步不会自行升级程序。

完整替换按账号隔离，包括云端有而重算结果中没有的旧日期，不依赖本机曾同步过哪些天。所有批次到齐并校验成功才通过 D1 事务切换，上传中断时继续显示原榜单；空重算结果也能明确替换为零。完成过修复的账号拒绝低于本次客户端/内核版本的回传，防止旧脚本覆盖回来。头像、昵称、群成员关系、其他账号及已发出的历史分享快照不受影响。

原始日志已删除的请求无法重新计算，其旧统计只保留在本机备份中；若已有用量但整个源目录不可用，会在切换前停止。文件解析失败也保留原库与云端数据、暂停同步；重算完成但网络回传失败则保留新本地库和 `replace_pending` 标记，后台继续完整替换重试。同设备重新执行命令可替代中断的暂存任务，其他设备不能抢占正在进行的重建。重建不会保证数字只降不升，最终以新版原版解析器的结果为准。

支持本项目一键接入生成的 macOS LaunchAgent、Windows 计划任务、Linux 用户 systemd 服务，以及配置官方 macOS 自启的原版。macOS 按实际加载的采集服务选择原版安装，兼容旧服务名 `com.tokenmeter.server` 和官方旧命令别名；保留原启动路径、参数和 plist。未加载且无法核实的历史 plist 会跳过，不删除或启动；两套原版同时加载时停止并提示用户确认。

已达到最新修复版本的源码检出或 Homebrew 安装可直接重算回传，无需替换内核程序。需要升级的源码检出、Homebrew Cellar、自定义数据库或无法核实的后台会在修改前停止，需按原管理方式处理；不申请管理员权限。Windows 和 Linux 的服务命令经过模拟测试，完整运行验收仍需对应平台。更新工具临时下载运行并永久更新本地同步脚本，无须重新登录。

## 隔离边界

- 日常同步通过 SQLite `readOnly: true` + `query_only` 打开原库，不调用原版 Store、扫描器、迁移、HTTP 控制接口或 CLI。安装准备与用户显式执行 `update-and-resync` 时调用原版采集与后台管理，维护过程与日常上传循环分离。
- 上传模块只查询事件的时间、工具、模型、Token 计数，以及显式 `migrate-config` 时的旧接入设置；它不读取 Cursor 令牌、代码、会话正文或项目路径。原版采集行为遵循原项目实现。
- TokenRank 的接入码、随机设备 ID、同步检查点、锁与日志仅写入 `~/.tokenrank/`。配置文件使用 0600 权限（Windows 继承用户目录 ACL）。
- 同步服务：macOS `com.tokenrank.sync`、Windows `TokenRankSync`、Linux `tokenrank-sync.service`。新装原版在 macOS 调用其原生 `install-agent`；Windows/Linux 分别使用独立的 `TokenWatcherForTokenRank` / `token-watcher-for-tokenrank.service` 启动未改动的原版 `serve --no-open`。已有原版沿用原有服务。
- 安装脚本先暂存并检查新包，替换前保留旧程序目录备份。不会删除原版数据目录。

## 升级旧版 TokenRank

v0.1.0 使用原版数据库和服务名。升级脚本先准备原版，再停用确认属于旧 TokenRank 的服务，随后启动新装原版的后台并接入同步。下载或首次采集失败时不会提前停用旧服务。

脚本仅在旧包名称和版本为 `tokenrank-client@0.1.0`，且服务入口确实指向该安装目录时，停用旧 TokenRank 后台；macOS 旧 plist 先备份到 `~/.tokenrank/migrations/`。指向原版安装的同名服务不会被移除。旧 `~/.tokenmeter` 数据及设置不会删除或迁移。若复用的已有原版服务此前被旧版覆盖，需要按原版说明恢复原版自启；脚本不会猜测或覆盖已有原版服务配置。

手动迁移旧接入配置可用 `tokenrank migrate-config`，它只读旧设置并写入独立配置；不自动停用任意来源的旧程序。通过 npm 安装的旧版需先确认服务入口归属再迁移，不能假定更新 npm 包能停掉旧进程。

## 同步口径与可靠性

v0.2.10 增加独立心跳：启动、检查完成及每 5 分钟报告状态。心跳仅含随机设备 ID、平台、同步器和内核版本、检查时间、最新统计日期、状态与固定错误码；无原始错误、代码、会话、路径或电脑名。`TOKENRANK_OFFLINE=1` / `TOKENMETER_OFFLINE=1` 同时关闭心跳和用量上传。`rank push --dry-run` 仅预览用量报文，本身不联网；已经运行的后台服务仍按其配置工作。

系统托管的监督进程保持心跳，单次只读同步在独立子进程中执行；15 分钟仍未结束会终止该子进程，下一周期重试。macOS KeepAlive、Linux Restart=always；Windows 保留进程退出码，异常重启并每 5 分钟检查任务是否需要启动，允许电池运行，不唤醒休眠电脑。不会停止或重启原版采集器。Windows/Linux 设置已用模拟命令验证，仍需相应系统实机验收。

心跳缓存单独写入 `~/.tokenrank/health/config.json`，不与同步子进程争写检查点。`rank status` 输出最近一次确认的心跳；这是历史状态，不保证当前正在运行。`rank off` 先在本机断开，再尽力发送关闭通知；网络不可用时服务器只能显示失联。`uninstall-agent` 和 `uninstall` 同样发送明确停止事件。小程序会分别显示最后联系、检查和上传时间，旧版无心跳时标为未知。

默认每 5 分钟读取同一个 SQLite 快照，包含已提交的 WAL 记录；扫描全部已保留历史以发现旧日期变更。北京时间日桶、主用量直接读取原版 total_tokens（含缓存），input_tokens、output_tokens、缓存读写单列。工具、模型按原版总量各保留每日用量前 8 项，服务端将未分类差额单列。补充采集（Oort 系、WorkBuddy 各版本、DevEco Code、Genspark Code、ToCodex、独立 Cline、JoyCode、QoderWork、Kiro 点数、TeleAgent、CodeArts Agent）随后并入相同日桶，同样受前 8 项工具与模型、128 组工具—模型限制；金额估算仍只基于原版可识别的模型。

历史按最多 400 天且小于 450 KiB 分批发送，无总历史天数截断；每批得到完整确认后才保存检查点。失败批次留待重试，429 按 Retry-After 等待，401 提示重新接入。超出当前计数协议范围会停止同步并提示，不裁剪源数据。原版升级后缺少必要字段时停止上报，不修改或自动升级原库。

“无损”指原版安装和统计数据不被适配器改写，不代表两个产品展示完全一致，也不承诺未来数据库结构始终兼容。服务端按设备保存来源快照，支持历史下调或已删除日期归零；同一个接入码可同时接入多台电脑，榜单按天累加各台设备的日桶，单台设备重新上报只替换它自己的数据。维度明细仍受前 8 项协议限制。

## 排查与卸载

```sh
tokenrank doctor                         # 只读兼容性检查
tokenrank rank status                    # 状态，不输出接入码
tokenrank rank push --full --dry-run     # 预览完整聚合报文，不联网
tokenrank rank push                      # 手动同步变化
tokenrank rank off                       # 断开后续上传
tokenrank uninstall-agent                # 仅停止并移除独立自启
tokenrank uninstall --purge-data         # 移除自启、清除独立配置文件
```

卸载命令保留程序、日志、备份和全部原版数据，包括安装脚本新装的原版和其采集后台。原版可独立使用；停用 macOS 原版可调用其 `uninstall-agent`，Windows 需停止并移除 `TokenWatcherForTokenRank`，Linux 使用 `systemctl --user disable --now token-watcher-for-tokenrank.service`。需要删除程序时：npm 安装用 `npm rm -g tokenrank-client`；脚本安装在停止服务后自行移除 `~/.tokenrank/app` 与脚本生成的 tokenrank 快捷命令。不会删除服务器历史。`TOKENRANK_OFFLINE=1` 或 `TOKENMETER_OFFLINE=1` 禁止上传。

## 开发与许可

`npm test` 验证独立适配器；`npm run pack:dist` 生成服务端静态分发包。包内仅包含 `sync/`、新入口、旧入口安全转接、清单、说明和 MIT LICENSE。

本目录最初从 token-watcher fork 而来，保留原版 MIT 许可和归属；早期 fork 的采集代码不在开源仓库中，采集能力来自独立安装的 token-watcher。适配器按 token-watcher 的 events 表字段读取。


安装编排命令 `prepare-upstream` / `start-upstream` 与只读上传循环分离；下载、扫描或后台启动失败会报错并停止后续接入，重跑可继续已完成的准备阶段。原版 `scan` 会按自身逻辑正常更新统计库；“同步器只读”不意味着原版采集过程中数据库不再变化。

## 金额估算（0.2.12）

日常同步调用已安装原版的 `aggregateCosts`，沿用其自定义价格、LiteLLM 本地价格缓存、汇率及峰谷规则。临时 HOME 中只放三个价格相关 JSON 副本，子进程强制离线；只读同一个 SQLite 快照，按北京时间自然日压缩到模型／工具／峰谷分组，在内存库中调用原版函数，不更改原始库或原版价格文件。金额以 USD 微元整数传输，模型金额之和等于日合计；无价格模型单列，不假定免费。

费用模块不兼容、缓存缺失或计算超时时，正常 Token 上报继续，金额显示不可用。每次检查均重新计算保留历史，价格改变后的估算会随下次同步更新；分享保留生成时的金额。缺少历史价格、订阅优惠、实际支付与套餐费用都不能由 API 等值推算。

## 重算后清理失效归档（0.2.13）

token-watcher 1.8 首次迁移 Codex 去重键时，会在统计库里留下一张 `codex_key_migration_backup` 归档表，按行号记录改动前的记录。更新重算会删除并从原始日志重扫全部 Codex 记录，行号随之改变，这张表从此对不上任何现存记录，却可能占到统计库的大部分，并被原版每日快照重复复制。0.2.13 在重算副本中删除它；更新前的完整统计库仍保存在 `~/.tokenrank/backups/update-*`。已更新过的用户再运行一次更新命令即可缩小统计库。

## 清理旧采集程序备份（0.2.14）

更新时如需升级原版，旧的 token-watcher 程序会移到安装目录旁的 `token-watcher.tokenrank-backup-<时间>`，供失败时回滚。0.2.14 起，上次更新完成后，后台每天检查一次，删除创建满 7 天的这类备份；只处理已配置安装目录旁、名称完全匹配且确为 token-watcher 包的目录，更新未完成时不动。

## 首次扫描内存上限（0.2.15）

原版 token-watcher 首次扫描会把部分来源表（如 OpenCode 的 `part`）整表读入内存，历史很多的电脑会超过 Node 默认堆上限而崩溃。0.2.15 起，接入时的首次扫描和更新时的重算都以本机内存的 3/4 作为上限（最低 4096 MB，最高 16384 MB）；已在 `NODE_OPTIONS` 中自行设置 `--max-old-space-size` 时沿用用户设置。仍然内存不足时，显示中文说明而不是原生调用栈。根本修复需要原版改为逐行读取。

## 工具下的模型分布（0.2.16）

只读按事件的工具与模型联合分组，日桶新增 `tool_models: [[工具, 模型, 含缓存总量], ...]`，最多保留 128 组。现有工具与模型各自的前八项、总用量和金额口径保持不变。超出保留范围或缺少工具／模型的用量仍计入总量，在小程序中显示为未关联模型。字段参与同步指纹，升级后的下一次正常同步会补传保留历史，不需要重算或清空云端数据。旧同步器仍可上报，缺少关联明细不会被猜测为某个模型。

## 全盘补充采集（0.2.21）

原版 token-watcher 对 WorkBuddy 只扫 `~/.WorkBuddy/projects`，也不认识 DevEco Code 与 Genspark Code。0.2.21 在同步器内增加 [`sync/extra.js`](sync/extra.js)：

- **全部磁盘发现**：Windows 遍历 C–Z 盘符，macOS 遍历 `/Volumes/*`，Linux 遍历 `/`、`/mnt/*`、`/media/*`；每盘最多向下 5 层，跳过 `Windows`、`Program Files`、`node_modules`、缓存等系统目录，再补充检查 `APPDATA`、`LOCALAPPDATA`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME` 和主目录。
- **WorkBuddy**：识别 `.WorkBuddy`、`.workbuddy-ai`、`.workbuddy-cn`、`.workbuddy-intl`、`WorkBuddy AI` 等产品目录，只读取其中的 `*.jsonl` 转录。排除原版已覆盖的 `~/.WorkBuddy/projects` 和 `~/.tokenmeter/extra-roots.json` 登记的目录，避免重复计数；同一消息 ID 只计一次。
- **DevEco Code**：读取 OpenCode 同构的 `deveco.db`，按 `message.data.tokens` 中的 input / output / cache.read / cache.write 汇总，reasoning 已包含在 output 内，不重复相加。
- **Genspark Code（0.2.27）**：Genspark Super App 内编码终端（gencode）的库 `gencode/opencode.db` 与 OpenCode 同构，按同样口径汇总；只在名为 `gencode` 的目录里找库，散落的 `opencode.db` 属于独立安装的 opencode（原版已覆盖），不会抢。Super App 其余空间（网页 agents 聊天等）用量仍在 genspark.ai 云端，本地无数据。
- **ToCodex（0.2.28）**：桌面端（标准安装与便携安装，含自定义盘的 Program Files）与 CLI 的任务记录 `tasks/<任务>/ui_messages.json`，详见下文「ToCodex 采集（0.2.28）」。
- **CodeBuddy（0.2.29）**：CodeBuddy / CodeBuddy CN 的扩展日志按 `notifyStepEnd` 逐请求分日，带工具、模型和工具—模型明细，详见下文「CodeBuddy 采集（0.2.29）」。
- **独立 Cline / Roo Code（0.2.30）**：VS Code 系变体（Code、Code - Insiders、Code - OSS、Cursor、Windsurf、VSCodium）`globalStorage` 里 claude-dev / roo-cline 扩展的任务记录，口径与 ToCodex 相同；装在 OortCloud AI Studio 里的归 Oort 系采集（`sync/oort.js`），这里不扫该产品目录，不会重复计。
- **JoyCode（0.2.30）**：京东的 VS Code 分支，`globalStorage/joycode.joycoder-editor/tasks` 的 Cline 系任务记录；逐请求不落模型名，只记工具维度。
- **QoderWork（0.2.30）**：`~/.qoderwork/projects` 的 Claude Code 风格转录，`message.usage` 为 Anthropic 四分量（input_tokens 不含缓存），带模型名，按消息 uuid 去重。Qoder 网关不下发真实 token 的安装全为零值，自动不计；Qoder（非 Work）由原版覆盖。
- **Kiro（0.2.30）**：AWS Kiro 本地只有点数没有 token——`~/.kiro/sessions` 逐会话 `messages.jsonl` 的 `usage_summary.promptTurnSummaries`（credit 单位）并入日行 credits（`{total, tools}`），不占 token 四分量。
- **TeleAgent（0.2.30）**：OpenCode 分支（super-agent-code），`~/.local/share/TeleAgent/teleagent.db` 按 OpenCode 同构口径解析（data 列声明为 BLOB，读取时 CAST 成 TEXT）；未使用过的安装表为空，静默无数据。
- **CodeArts Agent（0.2.30）**：华为的 OpenCode 分支，`~/.codeartsdoer` 各实例子目录的 `opencode.db` 同构解析，带模型名；cost 恒为 0（内部 MaaS 不计价），仅入库 token。
- **容错**：每个文件或数据库单独捕获异常，损坏项写入同步日志后跳过，不影响其他来源和正常上报。数据目录只读，不修改任何产品文件。

`TOKENRANK_OORT_DISABLE=1` 可关闭全部补充采集，`TOKENRANK_EXTRA_DISABLE=1` 只关闭 WorkBuddy / DevEco / Genspark Code / ToCodex / Cline / JoyCode / QoderWork / Kiro / TeleAgent / CodeArts 部分，`TOKENRANK_CODEBUDDY_DISABLE=1` 只关闭 CodeBuddy 部分。

**排查后明确不采的终端**（0.2.30 逐一排查本机数据后确认，结论存档于 [`../docs/prompts/`](../docs/prompts/)）：OpenCode 本体由原版覆盖；Zed 的 `threads.db` token 字段实测为空（zed.dev 云端计费）；豆包 / 豆包工作的用量在云端，本地只有编码 agent 的文件改动审计；Kimi 桌面端聊天与用量都在服务端，CLI（Kimi For Coding）由原版覆盖；OortCodex XP Edition 的会话 JSON 无 token 字段（主产品库已由 Oort 系采集）；CodeArts Space 内核同为 OpenCode，本机会话目录已被清空，待其重建后再评估；Comfy 本地是扩散模型图像生成，无 token 口径，云端用量不落本地。

## Qoder 网关口径提示（0.2.31）

Qoder（含 QoderWork）的企业网关只在 `usage.credits` 落真实消耗，token 四项恒为 0，且 `message.model` 是网关别名（本机实测 2026-10-14～11-02 共 14,457 行全部如此，别名 `qfmodel`/`dfmodel`/`qmodel_38max`，无 `qoder-custom-*` 用户模型标记）——本地不存在自定义模型的真实使用率数据，模型维度对这部分天数无可归因，不是采集或上报链路故障。0.2.31 起，读到「tokens=0 且无模型明细的纯 credits 日」时同步日志输出一行口径提示（每次同步最多一条），便于用户问询时快速定位；credits 总量与工具维度照常上报，不受影响。

## 子进程日志中继（0.2.32）

金额估算在子进程（cost-worker）里完成，stdout 只承载日桶 JSON；`readDays` 的口径提示与「超出上报协议范围」警告写在子进程 stderr，此前被父进程丢弃，用户永远看不到。0.2.32 起父进程把子进程 stderr 逐行中继给同步日志（`[tokenrank] ` 前缀剥除），诊断信息在 `rank push --dry-run` 与日常同步中均可见。

## Trae 快照采集（0.2.22）

Trae 本机没有明文用量：会话库 `ModularData/ai-agent/database.db` 是 SQLCipher 加密的。0.2.22 增加 [`sync/trae.js`](sync/trae.js)，只读 `~/.trae-cn/credits-usage.json`（schema 1，按天聚合的 token 四分量、会话行数、credits 与模型榜），把结果并入日桶；该文件由仓库内的 Trae 扩展 [`trae-extension/`](trae-extension/README.md) 调用 Trae 官方用量接口写出。未装扩展时静默无数据，快照 schema 不匹配、日行越界或 JSON 损坏都只告警跳过，不阻断同步。`TOKENRANK_TRAE_DISABLE=1` 关闭该来源。接口口径、验证数据与排障见 [`../docs/trae-collection.md`](../docs/trae-collection.md)。

同日合并支持 credits：`mergeOortDays` 现在把补充源的 credits（`{ total, tools }`）与上游同日数值相加、按工具名合并取前 8，分项之和钳回不超过 total（与服务端 1e-6 容差对齐），Trae 与 Qoder 等只上报 credits 的工具可并列。

## Trae 模型维度积分与 Auto 归因（0.2.24）

扩展 0.1.0 把快照升级为 **schema 2**（`models_full` / `credits_tools` / `credits_models*` / `credits_tool_models` / `truncated` 全量明细），并给出确定性模型归因：

- 接口行无 `model_name` 且判定为 Auto 模式（`mode` 归一匹配 `auto(mode)?`，或显式 `use_max_mode === false` 兜底）→ 上报固定名 `auto`，不再落入“未关联模型”；
- 自定义模型（BYOK）上报名 `[Provider] 模型名`（Provider 取模型清单或 `provider//模型` 前缀），内置模型保持接口原值；
- 归因与按天聚合的纯函数在 [`trae-extension/model-resolve.cjs`](trae-extension/model-resolve.cjs)，配套 [`test-sync/extension-model.test.mjs`](../test-sync/extension-model.test.mjs) 可脱离 Trae 运行。

采集器与协议同步扩为 credits 四字段（`total` / `tools` / `models` / `tool_models`，上限 8/8/8/128），`*_full` 优先、按上限截断；任一分项之和超过 `total` 时丢弃该分项并告警，不摊派。服务端 `ranked_usage` 视图与校验同步支持（迁移 `0022_credits_models.sql`），模型维度积分在榜单按去前缀+小写+空白折叠合并同名（`server/src/model-key.js`）。**上线顺序：服务端先于客户端**（旧服务端会拒绝带 `models` 字段的 credits）。

## OortCodex Desktop 采集（0.2.25）

OortCodex Desktop 用 ZCode 内核，但逐请求用量不写在 `~/.zcode`：它在
`%USERPROFILE%\OortCodexWork\cli\db\db.sqlite` 的 `model_usage` 表里按请求记录
input/output/cache_read/cache_creation 与毫秒时间戳（开发/预览版为
`OortCodexWork Dev` / `OortCodexWork Preview`）。0.2.25 起 [`sync/oort.js`](sync/oort.js)
以只读方式打开该库，按北京时间分日、展示名 `OortCodex Desktop`，并把模型明细一并带入
`models` / `tool_models`；`input_tokens` 中已含的 cache_read 会拆成新输入与缓存命中，
与 token-watcher 对 ZCode 的口径一致。同一记录 id 在多个安装线出现时只计一次；数据库缺失、
被锁或损坏时只跳过本轮，不影响其他来源。`%APPDATA%\OortCodexWork` 只是 Electron
界面缓存，不读。`TOKENRANK_OORT_DISABLE=1` 同样可关闭该来源。

## DSH 逐请求日志与 OortOffice（0.2.26）

DSH For OortCloud Work 原来只读 `session_projcache` 的会话累计值，按文件 mtime 归日：
跨零点的会话整段算到最后活跃那天，写出时间靠后会改变已上报日的数字。0.2.26 起先读会话日志
`~/.dsh-oortcloud-work/sessions/<workspace>/<session>/session.v*.jsonl.zst[d]`，取
`assistant/message` 的 `data.usage`（旧版为 `assistant/chunk` 的 `chunk.usage`），按每条记录的
`time` 精确分日，并带出 `request/header` 或 `message.source.model` 里的模型名（小写）。
日志是追加写的多帧 zstd，Node 内置解码器一次只解首帧，这里按帧魔数切开逐帧解；任一帧解不开
（文件正在追加、或 Node < 22.15 没有内置解码器）就整份作废，该会话退回 projcache 累计值，
两种来源对同一会话只取其一、不重复计数。分叉/种子会话（`isSeeded`）开头重放的父会话历史
`time` 早于 `createdAt`，按此排除，不会重复计入。

OortOffice 是 OnlyOffice 外壳 + 内置 ZCode 内核，HOME 被指到
`%LOCALAPPDATA%\OortOffice\zcode-home`，因此用量落在
`zcode-home\.zcode\cli\db\db.sqlite` 的 `model_usage`，口径与 OortCodex Desktop 相同
（展示名 `OortOffice`）。从没打开过 AI 面板的安装没有这个库，静默跳过；
`zcode-home/.zcode/v2/tasks-index.sqlite` 只有任务元数据，没有 token 明细。

## Genspark Code 采集（0.2.27）

Genspark Super App 本体是薄壳 Electron 客户端（`%APPDATA%\gensparkaio`），排查确认壳内没有
任何 token 明细；但其内的编码终端 **Genspark Code**（gencode，OpenCode 定制版，由 opencode
服务端 + `gencode.exe` 驱动）把逐请求用量写在
`~/.local/share/gencode/opencode.db`（XDG 数据目录下的 `gencode` 子目录），
schema 与 OpenCode 完全同构：`message.data` 里的 `tokens.input / output / reasoning /
cache.read / cache.write` 与 `time.created`（毫秒）、`modelID`。0.2.27 起
[`sync/extra.js`](sync/extra.js) 用与 DevEco Code 相同的读取口径采集它，展示名
`Genspark Code`，按北京时间分日，reasoning 已含在 output 内不重复相加。发现规则刻意收紧：
只在名为 `gencode` 的目录（逐盘扫描 + `XDG_DATA_HOME` / `~/.local/share` 等已知位置）找
`opencode.db`，散落在别处的 `opencode.db` 属于独立安装的 opencode（原版 token-watcher 已
覆盖），不会被重复采集。Super App 其余空间（网页 agents / genmail 等聊天）的用量仍在
genspark.ai 云端，本地无明细；credits 余额在云端账户页，客户端库里的 `cost` 字段是按
Genspark 模型定价折算的积分值，仅入库 token 数、不参与金额估算。

## ToCodex 采集（0.2.28）

ToCodex 是 VS Code 系的 AI 编程助手（桌面端 + CLI），上游 token-watcher 不认识它。其任务
用量由自带扩展（扩展 id `tocodex.tocodex`）按 Cline 系格式写在任务目录的
`ui_messages.json`：数组中 `say` 为 `api_req_started` 的消息，`text` 反序列化后带
`tokensIn / tokensOut / cacheReads / cacheWrites` 与毫秒时间戳；失败与重试中的请求只有
`streamState`、没有 token 字段，天然不重复计。0.2.28 起 [`sync/extra.js`](sync/extra.js)
按北京时间逐请求分日，展示名 `ToCodex`。发现规则：

- **桌面端标准安装**：`%APPDATA%\ToCodex Desktop\User\globalStorage\tocodex.tocodex\tasks`（逐盘扫描按产品目录名 `ToCodex` / `ToCodex Desktop` 定位 + 已知位置补查）；
- **桌面端便携安装**：VS Code 便携模式把数据放在 `<安装目录>\data\user-data`，含自定义盘的 `Program Files`（全盘遍历跳过该目录，单独按盘补查）；
- **CLI**：shim 把 globalStorage 指到 `~/.vscode-mock/global-storage`，`tasks` 直接在其下（无扩展 id 子目录）。

逐请求不落模型名（`ui_messages.json` 与 `history_item.json` 都没有），所以只记工具维度用量。
同一数据经多条路径发现时按目录规范化 + 消息键双重去重；单任务文件损坏只跳过并告警。
`TOKENRANK_EXTRA_DISABLE=1` 可关闭该来源。真机对账：两台安装（桌面端便携 + CLI）的数据
与逐条手工统计一致。

## Windows 采集任务恢复（0.2.17）

Windows 上的原版采集计划任务 `TokenWatcherForTokenRank` 被手动或清理工具删除后，启动脚本和接入状态仍在，旧版会误判为"原版后台已配置"而跳过，采集从此停止，更新命令也会因找不到任务而报错。0.2.17 起，接入和更新都会先确认该任务存在，缺失时按原方式重新注册（只针对接入脚本自己安装的原版）；更新时找不到的计划任务按"未运行"处理，不再抛出 PowerShell 原始错误。安装脚本以 UTF-8 声明下发，Windows PowerShell 5.1 不再把中文提示显示为乱码。

## 扫描失败说明与打包（0.2.18）

更新重算或回传前的扫描如有文件失败，提示按工具列出失败数量和原版给出的原因（如 `codex 2 个：EBUSY …`），文件路径一律替换为 `<路径>`，便于用户把报错直接发出来排查，不泄露项目或会话名称。打包时不再带入 macOS 的 `._*` 元数据文件，Windows 更新结束时不会再因无法删除 `._.` 而报错。

## zstd 预检（0.2.19）

原版读取 dsh 的多帧压缩会话（`.jsonl.zstd`）依赖系统 `zstd` 程序，Node 内置解码只能读第一帧。本机存在 `~/.dsh/sessions` 而找不到 `zstd` 时：更新命令在下载和停止任何服务之前就停下，给出对应系统的安装命令（Windows `winget install -e --id Meta.Zstandard` 或 `scoop install zstd`，macOS `brew install zstd`，Linux 用包管理器）；接入时只提示，不阻断安装，因为缺少 zstd 时日常采集仍可运行，只是 dsh 用量会漏算。查找顺序与原版一致。

## Windows 自动准备 zstd（0.2.20）

Windows 上存在 dsh 会话（`~/.dsh/sessions`）而找不到 `zstd` 时，接入和更新会从 TokenRank 服务器下载官方 zstd 1.5.7 Windows 版（facebook/zstd 发布的 `zstd-v1.5.7-win64.zip` 中的 `zstd.exe`，BSD 许可），按固定 SHA-256 校验后只放在 `~/.tokenrank/bin`：不需要管理员权限，不改系统 PATH，不调用 winget。原版的首次扫描、更新重算和 `TokenWatcherForTokenRank` 采集任务都把这个目录放在 PATH 最前；已接入用户的采集启动脚本会在下次接入或更新时改写并重启一次。下载失败或校验不符时不使用该文件，并给出手动安装命令。macOS 与 Linux 仍只提示 `brew install zstd` 或用包管理器安装。删除 `~/.tokenrank/bin/zstd.exe` 即可移除。


## CodeBuddy 采集（0.2.29）

同步器只读 CodeBuddy / CodeBuddy CN 的本机扩展日志，从 `notifyStepEnd` 提取逐请求用量，按北京时间日期上报工具、模型和工具—模型明细。缓存从输入 token 中拆分，重复日志与累计摘要不重复计数。支持系统标准用户数据目录，历史回填以尚未轮转删除的日志为限；不上传对话内容。

模型使用同日志的初始化记录；缺少上下文或同类 agent 出现多个模型时标为 `unknown`，避免错误归属。目前针对 IDE 日志，不包含 CLI。`TOKENRANK_CODEBUDDY_DISABLE=1` 可关闭本项采集。更新同步器后，下次同步自动补报已保留日志，无需清空云端历史。
