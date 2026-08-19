# Page2Knowledge

[English](README.md) · [中文用户指南](docs/USER_GUIDE.zh-CN.md) · [English user guide](docs/USER_GUIDE.en.md)

Page2Knowledge 把公开网页、有限同源站点、本地 PDF、字幕文本和音视频转换成带逐条来源的知识包。它支持版本差异、本地检索与引用式回答，可完全运行在本机，也可通过加固后的容器自托管。

当前版本为 `0.2.1`，定位是本地/自托管发布候选，不是已经上线的托管服务。

> **信任边界：**所有自动导入内容都不会被提升为事实。未经审批的内容只能以 `reference` 导出，并携带 `untrusted-source` 与 `reference-only` 标签。没有命中提示词注入告警不代表正文可信；当前 MVP 也没有开放事实审批接口。

## 主要能力

- 从单个公开 URL 提取 Markdown、元数据、列表、链接与代码块。
- 解析 PDF、VTT、SRT、TXT，保留页码、时间码或行号定位。
- 通过用户自行安装的本机 Whisper 命令转录常见音视频。
- 在用户明确限定页数与深度后执行严格同源抓取。
- 对同一来源的两个版本展示新增、删除、修改与受影响区块。
- 使用本地稀疏索引完成确定性搜索和只依据引用的回答。
- 仅运行用户明确确认、间隔不少于 15 分钟的定时任务。
- 导出 Markdown、结构化 JSON 与 Context Package v0.1。
- 提供带 Bearer 鉴权的 HTTP API 和 Docker/Compose 基线。

## 快速开始

需要 Node.js `22.13+` 或 `24+`，以及 npm。

```bash
git clone https://github.com/mason2048/page2knowledge.git
cd page2knowledge
npm ci
npm run dev
```

打开 <http://127.0.0.1:4314>。开发界面会把 API 请求代理到 `127.0.0.1:4315`。首次使用建议点击“使用内置技术文档示例”。

停止时，在启动命令所在终端按 `Ctrl+C`，界面与本地 API 会一起结束。

网页、PDF、字幕、媒体、版本差异、知识库、抓取、导出、API、Docker、访问令牌、Whisper、数据清理与排障步骤见[中文用户指南](docs/USER_GUIDE.zh-CN.md)。

## 生产形态的本地运行

```bash
npm run build
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
NODE_ENV=production npm start
```

打开 <http://127.0.0.1:4315>，并在页面输入同一个访问令牌。生产模式监听 `0.0.0.0`，没有防火墙、HTTPS 反向代理、精确 Host/Origin 允许列表和 Bearer 鉴权时不得暴露到公网。完整门禁见 [`ops/CLOUD.md`](ops/CLOUD.md)。

## 输入与上限

| 输入 | 当前上限 | 来源定位 |
|---|---:|---|
| 公开 HTML 单页 | 2 MiB、12 秒、4 次重定向 | 最终 URL 与文档结构 |
| 同源站点抓取 | 50 页、深度 5、3 分钟 | 每页 URL 与区块定位 |
| PDF | 20 MiB、250 页 | `pdf:page=N` |
| VTT/SRT/TXT | 5 MiB | 时间码或行号 |
| 音视频 | 250 MiB | 本机 Whisper 生成的 `media:t=` |

HTML、文档、字幕和媒体派生文本始终是不可信引用。Page2Knowledge 不登录站点、不绕过付费墙、不执行来源脚本，也不替用户取得内容版权。

## 验证

```bash
npm run check
npm run benchmark:quality
npm audit
```

`npm run check` 会执行完整 Vitest 套件与生产构建。固定质量基准要求正文保留率不低于 90%、导航噪声不高于 10%、代码语言标识保留率不低于 95%，并在 60 秒内完成。测试同时覆盖多语言、OCR 断词、HTML 拆分等注入矩阵，以及独立的 reference-only 导出门禁。

这些固定测试不能证明真实公网、Whisper 识别准确率、云环境、备份恢复或真人可用性已经验收。

## Docker

```bash
docker build --tag page2knowledge:local .
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
docker compose up -d
docker compose ps
```

Compose 只发布 `127.0.0.1:4315`，以非 root 和只读根文件系统运行，数据写入 `page2knowledge-data`。保留数据停止：

```bash
docker compose down
```

除非已经备份且明确要永久删除知识库和调度数据，否则不要执行 `docker compose down --volumes`。

## 安全与隐私

- 每个 URL 与重定向都会重新执行协议、凭据、DNS、地址和 SSRF 校验。
- 本地虚拟 `file:///` 身份只是元数据，不能用来读取任意服务器文件。
- 开启鉴权后，除健康检查外的数据 API 均执行恒定时间 Bearer Token 校验。
- 访问令牌只接受 `Authorization` 请求头，并仅保存在当前浏览器 `sessionStorage` 会话。
- 页面正文、Skill 式文本和导入对象都只是数据，不会被执行。
- 疑似秘密在进入输出前会被遮蔽。
- 本地 JSON 状态采用原子替换，但生产仍是单写者模型。

安全问题请使用 [GitHub Private Vulnerability Reporting](https://github.com/mason2048/page2knowledge/security/advisories/new)，不要提交公开 Issue。详见 [SECURITY.md](SECURITY.md)。

## 文档

- [中文用户指南](docs/USER_GUIDE.zh-CN.md)
- [English user guide](docs/USER_GUIDE.en.md)
- [云运行与上线门禁](ops/CLOUD.md)
- [历史 PRD v0.1](PRD.md)
- [贡献说明](CONTRIBUTING.md)

PRD 冻结的是 v0.1/P0 首版范围；v0.2.1 新增能力以当前 README 与用户指南为准，PRD 原有“不包含”列表不再代表当前实现边界。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
