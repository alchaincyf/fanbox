# 08 · 微信 ClawBot 集成 —— 参考开源项目与署名

> FanBox 的「微信 ClawBot」集成（脱离 openclaw、直连腾讯官方 iLink 协议 + 驱动本机 Claude Code / Codex）在协议层面**学习、参考了以下开源项目**。在此明确署名致谢。我们参考的是这些项目公开的**协议规范与实现思路**（iLink HTTP 接口、字段结构、登录时序、ACP 驱动方式），并基于自己的架构重新实现，未直接复制其源码。

## 参考项目

| 项目 | 作者 | 我们参考了什么 | 链接 |
|------|------|----------------|------|
| `openclaw-weixin` | Tencent（官方） | iLink HTTP 协议的权威实现：请求头、7 个接口的字段结构、扫码登录时序、长轮询游标、媒体 AES-128-ECB 加解密 | https://github.com/Tencent/openclaw-weixin |
| `weixin-agent-sdk` | [@wong2](https://github.com/wong2) | 「微信 ClawBot 接入任意 Agent」的架构思路；ACP 适配器（如何用 ACP 驱动 Claude Code / Codex）；`Agent.chat()` 接口抽象 | https://github.com/wong2/weixin-agent-sdk |
| `weixin-ClawBot-API` | [@SiverKing](https://github.com/SiverKing) | 「免 openclaw 部署直接接入」的可行性验证与裸协议调用示例 | https://github.com/SiverKing/weixin-ClawBot-API |
| `openclaw-weixin`（协议文档） | [@hao-ji-xing](https://github.com/hao-ji-xing) | iLink Bot API 的接口规范文档（`weixin-bot-api.md`） | https://github.com/hao-ji-xing/openclaw-weixin |
| `codex-acp` / `claude-agent-acp` | [Agent Client Protocol](https://github.com/agentclientprotocol) / Zed | ACP（Agent Client Protocol）驱动 Codex / Claude Code 的方式（备选方案，FanBox 当前实现走 CLI 无头模式） | https://github.com/agentclientprotocol |

## 协议归属

- 微信 ClawBot 底层协议 **iLink** 及服务器 `ilinkai.weixin.qq.com` 为**腾讯所有**。FanBox 仅作为协议客户端接入，遵循腾讯官方插件的接入方式。
- Claude Code、Codex 为各自厂商（Anthropic / OpenAI）的产品，FanBox 通过其官方 CLI 的无头模式（`claude -p` / `codex exec`）在本机驱动，复用用户本机已登录的凭据。

## FanBox 自己的实现

FanBox 的实现位于 `electron/wechat/`，包含自研的 iLink HTTP 客户端、本机 CLI 驱动器、以及收发编排逻辑。架构决策见 `docs/07-微信ClawBot集成规划.md` 与团队记忆 `fanbox-wechat-ilink-architecture`。

_最后更新：2026-06-15_
