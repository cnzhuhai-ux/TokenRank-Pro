# 2026-11-02 ToCodex 用量采集

原始提示词（一字未改存档）：

> 同步 http://192.168.88.125/zhangxuelian/tokenrank 最新代码，添加ToCodex的用量采集，另外install.sh / update.sh 里的VERSION记得修改，再更新Readme，以及把提示词也存档，再推送回仓库

对应产出（0.2.28）：

- `client/sync/extra.js`：新增 ToCodex 补充采集。任务用量由自带扩展（`tocodex.tocodex`）按 Cline 系格式写在任务目录 `ui_messages.json`（`say=api_req_started` 尾带 `{tokensIn, tokensOut, cacheReads, cacheWrites}`，失败与重试中的请求无 token 字段、不重复计）。覆盖桌面端标准安装（`%APPDATA%\ToCodex Desktop`）、VS Code 便携安装（`<安装目录>\data\user-data`，含自定义盘的 Program Files）与 CLI（`~/.vscode-mock/global-storage`）；逐请求不落模型名，只记工具维度用量。
- `client/test-sync/extra.test.mjs`：新增发现、口径、失败请求跳过与多路径去重用例；真机对账（桌面端便携 + CLI）与逐条手工统计一致。
- 版本例行动作：`client/package.json`、`server/public/install.sh` / `update.sh`（含 `.ps1`）升至 0.2.28，新增 `server/public/releases/0.2.28/` 快照，小程序接入命令与「说明」页审计提示词同步更新。
- 文档：`README.md`、`client/README.md`、`miniprogram/README.md` 补充 ToCodex 数据源与口径。
