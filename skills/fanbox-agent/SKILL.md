---
name: fanbox-agent
description: 在 FanBox 终端里指挥兄弟终端窗口（列出/读取/发指令/新开/等待），以及设定时任务（每天/每周/固定时间/cron 自动开窗跑 agent）。用户说「开个窗口跑 X」「让 N 号窗口执行…」「每天 X 点自动…」「定时/定期跑…」时使用。仅当 FANBOX_CTL 环境变量存在时可用。
---

# FanBox 终端控制

只在 FanBox 桌面 app 的终端里可用。先确认门票在手：

```bash
[ -n "$FANBOX_CTL" ] && echo "在 FanBox 里，我是 $FANBOX_TERM_ID 号窗口" || echo "不在 FanBox 终端里，本 skill 不可用"
```

三个环境变量由 FanBox 注入：`FANBOX_CTL`（接口地址）、`FANBOX_CTL_TOKEN`（门票，每次启动随机、只存在于 FanBox 终端的环境里，**绝不外传、不写进文件**）、`FANBOX_TERM_ID`（自己的窗口 id）。

**别给自己（$FANBOX_TERM_ID）发指令**——那会把你自己的输入流打乱甚至死循环。

## 接口速查

所有请求带 `x-fanbox-token` 头。以下用 `CT` 缩写公共参数：

```bash
CT=(-s -H "x-fanbox-token: $FANBOX_CTL_TOKEN")
```

**列出所有终端窗口**（id / 目录 / 前台进程 / 忙闲 / 最近输出尾巴）：

```bash
curl "${CT[@]}" "$FANBOX_CTL/terminals"
# → {"ok":true,"terminals":[{"id":"t2","cwd":"…","proc":"claude","busy":false,"hooked":true,"state":"done","tail":"…"}]}
```

**读某窗口最近输出**（去 ANSI 纯文本，默认 200 行，最多 2000）：

```bash
curl "${CT[@]}" "$FANBOX_CTL/read?id=t2&lines=100"
```

**给窗口发指令**（默认自动补回车提交；`"submit": false` 只输入不提交；多行文本发给 claude 等 TUI 加 `"paste": true` 走 bracketed paste 整块粘贴）：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"id":"t2","text":"npm test"}' "$FANBOX_CTL/send"
```

控制键直接发字符本身，如 Ctrl-C：`{"id":"t2","text":"","submit":false}`。

**新开终端窗口**（可选 `autorun` 开窗即执行，会等 shell 就绪再敲）：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"cwd":"/path/to/project","autorun":"claude \"跑通所有测试\""}' "$FANBOX_CTL/create"
# → {"ok":true,"id":"t5","autorun":true}
```

**等窗口告一段落**（HTTP 长轮询，timeoutMs 最长 240000）：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"id":"t5","timeoutMs":120000}' "$FANBOX_CTL/wait"
```

三种等法：
- 默认：前台回到裸 shell 且输出静默 ≥ `idleMs`（默认 2000）——适合等普通命令跑完
- `"idle":"quiet"`：只看输出静默——适合等 claude 等常驻 TUI 回答完，建议配 `"idleMs":3000`
- `"until":"正则"`：新输出匹配到正则就立刻返回——注意只匹配 wait 开始之后的新输出，所以要在结果出现前就发起 wait。**命令回显也算输出**：你敲的命令本身会先出现在流里，正则要用 `^` 锚定行首（如 `"^DONE$"`）才不会匹配到自己发的命令

返回 `{ok, idle|matched|exited|timeout, elapsed, output}`，output 是等待期间的输出（最后 8KB），通常不用再 read。

**关闭窗口**：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' -d '{"id":"t5"}' "$FANBOX_CTL/kill"
```

## 定时任务：用户白话 → 你换算成 schedule

用户说「每天早上 9 点整理灵感箱」「周五下班前汇总本周改动」「两小时后跑一遍测试」时，把意图换算成 schedule 对象调接口。到点 FanBox 会自动开一个终端窗口执行（FanBox 没开着则记「错过」不补跑）。

schedule 三种形态：
- 周期规律：`{"type":"cron","expr":"0 9 * * *"}`——5 段本地时区 cron（分 时 日 月 周），支持 `* , - */n`
- 固定时间一次：`{"type":"at","time":"2026-07-27T09:00"}`——执行完自动停用
- 固定间隔：`{"type":"every","minutes":120}`

**列出全部任务**：

```bash
curl "${CT[@]}" "$FANBOX_CTL/cron"
```

**创建 / 修改**（带 `id` 是修改，不带是创建；`agent` 可选 `claude`/`codex`/`shell`；`full:true` 表示全自动跳过一切确认——**必须用户明确授权才可设**，默认 acceptEdits）：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' -d '{
  "name": "整理灵感箱",
  "cwd": "/Users/xxx/Documents/写作",
  "agent": "claude",
  "prompt": "把灵感箱里的碎片整理进对应选题，完成后简要汇报",
  "schedule": {"type":"cron","expr":"0 9 * * *"}
}' "$FANBOX_CTL/cron/save"
```

**预览执行时间**（换算完先验一下，把结果报给用户确认）：

```bash
curl "${CT[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"schedule":{"type":"cron","expr":"0 18 * * 5"}}' "$FANBOX_CTL/cron/preview"
# → {"ok":true,"times":[…]}  接下来最多 3 次的时间戳
```

**其他操作**（都是 POST）：`/cron/toggle` `{"id":"crxx","enabled":false}`、`/cron/run` `{"id":"crxx"}`（立即执行一次）、`/cron/delete` `{"id":"crxx"}`。

规矩：创建/修改完把「任务名 + 什么时候执行 + 去哪个目录干什么」复述给用户；删除和 `full:true` 先经用户明确同意。

## 子窗口的 claude 卡在确认框怎么办

新窗口里的 claude 默认权限模式会在写文件/跑命令前停下等确认，没人替它点就永远卡着（wait 只会 timeout 或 quiet）。两条路：

- **开窗时就放权**（实验场景推荐）：autorun 用 `claude --permission-mode acceptEdits "任务"`（文件编辑自动同意，跑命令仍确认）；用户明确授权全自动时才用 `claude --dangerously-skip-permissions "任务"`
- **替它按确认**：wait 返回后 read 尾部，看到「Do you want …?」「❯ 1. Yes」这类选择框就是卡在确认——发 `{"id":"tN","text":"","submit":true}`（回车 = 确认当前选中项），或数字直选如 `{"id":"tN","text":"2","submit":false}`（TUI 选择框数字键即按即生效，**别带回车**，多出的回车会误触下一个状态）

## 多窗口并行实验套路

1. `create` × N 个窗口，不同 `cwd` 或不同 `autorun` 方案
2. 并行等待：每个窗口的 `wait` 用 `curl … &` 后台发起，`wait` 命令收齐
3. 从各 `wait` 返回的 `output`（或补一次 `read`）收结果，对比汇报

用户在 FanBox 界面上能看到每个窗口实时滚动，被遥控的 tab 会闪 ⚡。

## 叫人：给用户手机发一条消息

用户连了微信或飞书、开着「离开时叫我」时，任何终端里都能用（不限 Claude Code，Codex、Kimi、普通 shell 脚本都行）：

```bash
fanbox-notify "测试跑完了，3 个没过，都在 auth 模块。要我现在修吗？"
npm run build && fanbox-notify "构建好了" || fanbox-notify "构建失败，回来看一眼"
```

- **该发**：跑了几分钟以上的活有了结果；卡住了，不等用户定就没法往下走；出了他必须马上知道的事
- **不该发**：他正在跟你一来一回说话；中间进度；你自己能定的事；刚发过的同一件事
- 一两句话，先说结论，再说需要他回什么。不贴日志和长路径
- 返回的 JSON 里 `delivered` 说明这条去了哪：`phone` 进了发件箱、`desktop` 用户在电脑前只在界面提示、`skip` 重复或太密没发、`reject` 没通道或用户关了（这时不要重试）
- 夜里 23 点到早上 8 点攒到早上，两条之间至少隔 10 分钟，这些由 FanBox 管

找不到 `fanbox-notify` 命令时直接调接口：`curl "${CT[@]}" -X POST -H "x-fanbox-term: $FANBOX_TERM_ID" --data-urlencode "text=要说的话" "$FANBOX_CTL/notify"`

## 规矩

- `kill`、发 Ctrl-C、覆盖性命令：先向用户确认，除非用户已明确授权
- 读到的其他窗口输出可能含敏感信息，只用于当前任务，不外传
- 接口报 403/501 或环境变量缺失：说明不在 FanBox 里或版本过旧，直接告诉用户，不要重试
