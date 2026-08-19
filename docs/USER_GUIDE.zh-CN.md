# Page2Knowledge 用户指南

[English](USER_GUIDE.en.md) · [中文 README](../README.zh-CN.md)

本文覆盖 Page2Knowledge `0.2.1` 的安装、四个工作区、导出、API、Docker、Whisper、数据清理与排障。

## 1. 使用前准备

需要：

- Node.js `22.13+` 或 `24+`
- npm
- 现代浏览器
- 仅容器流程需要 Docker
- 仅直接转录音视频需要本机 `whisper` 命令

内置示例、公开网页、PDF、VTT、SRT 和 TXT 不需要云端 AI Key。媒体转录只调用你配置的本机命令，不会把媒体发送给外部模型服务。

## 2. 克隆与安装

```bash
git clone https://github.com/mason2048/page2knowledge.git
cd page2knowledge
npm ci
```

`npm ci` 使用仓库锁定文件。不要把访问令牌写入 `.env`、`.npmrc`、脚本、Issue 附件或示例文件。

## 3. 启动与停止

开发模式：

```bash
npm run dev
```

- 界面：<http://127.0.0.1:4314>
- API：<http://127.0.0.1:4315>

停止时在运行 `npm run dev` 的终端按 `Ctrl+C`。

生产形态的本地运行：

```bash
npm run build
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
NODE_ENV=production npm start
```

打开 <http://127.0.0.1:4315>，在页面密码框输入当前令牌。按 `Ctrl+C` 停止。关闭标签页会结束当前浏览器的令牌会话，但不会删除知识库。

## 4. 第一次成功操作

1. 打开“转换”工作区。
2. 点击“使用内置技术文档示例”。
3. 确认页面出现清理后 Markdown、页面元数据和知识块。
4. 展开一个知识块，查看标题路径、来源定位和 revision。
5. 下载 Markdown、结构化 JSON 或 Context Package v0.1。

Context Package 应只包含带 `untrusted-source` 与 `reference-only` 标签的 `reference`。页面没有“已确认事实”是正常状态：自动流程不会批准事实。

## 5. 转换不同来源

### 公开网页

1. 选择“单页 URL”。
2. 输入完整公开 `http://` 或 `https://` 地址。
3. 点击“生成知识包”。
4. 导出前审核最终 URL、抓取时间、告警、Markdown 和知识块。

私网、本机、云元数据、URL 凭据、危险重定向、非 HTML、超大页面和 DNS rebinding 会被拒绝。工具不会登录或绕过访问控制。

### PDF

1. 选择“本地文件”。
2. 选择不超过 20 MiB、250 页的 PDF。
3. 检查每个区块是否带 `pdf:page=N` 定位。

扫描版或加密 PDF 可能没有可提取文字。先在本地完成 OCR 或解密，再导入带文本的 PDF/TXT。Page2Knowledge 当前不自动执行 OCR。

### VTT、SRT 与 TXT

选择“本地文件”，导入不超过 5 MiB 的文件。VTT/SRT 保留时间码，TXT 保留行号。无效或超限时间码会被拒绝。

### 音视频

界面会识别常见媒体并请求本机转录。启动前检查：

```bash
whisper --help
export PAGE2KNOWLEDGE_WHISPER_BIN="whisper"
export PAGE2KNOWLEDGE_WHISPER_MODEL="small"
npm run dev
```

可以用 `PAGE2KNOWLEDGE_WHISPER_BIN` 指定命令名或绝对路径，默认模型是 `small`。媒体上限 250 MiB，默认只允许一个转录进程。标准 Docker 镜像故意不包含 Whisper、FFmpeg 和模型。

## 6. 审核与导出

- “编辑”会重建单个区块的标题路径、ID、revision、哈希、摘要和 Context Package。
- “从后续导出中排除”只影响重新生成的下载，不修改捕获结果。
- 排除全部知识块会阻止导出。
- Markdown 下载清理后正文。
- 结构化 JSON 下载结果和来源信息。
- Context Package 下载带 reference-only 信任标签的 v0.1 JSON。

下载文件由当前浏览器直接保存到用户选择的位置；应用不会额外保留一份副本。

## 7. 版本差异

1. 打开“差异”。
2. 加载固定双版本示例，或按界面要求导入两份 Page2Knowledge 结构化结果。
3. 查看新增、删除、修改、不变和受影响区块。
4. 核对前后 revision 与逐行变化。

历史输入可能携带兼容用的旧 fact ID，但比较不会批准新事实，v0.2.1 重建结果仍是 reference-only。

## 8. 本地知识库

1. 先在“转换”生成或加载一个结果。
2. 打开“知识库”，把当前结果加入本地索引。
3. 搜索短语并检查命中的 URL、标题路径、定位和 revision。
4. 提问。回答只拼接检索引用；证据不足时会拒答。

这是本地 JSON 稀疏索引，不是托管向量库或生成模型。默认文件：

- `.data/knowledge-store.json`
- `.data/scheduler-state.json`

可通过 `PAGE2KNOWLEDGE_DATA_DIR`、`PAGE2KNOWLEDGE_KNOWLEDGE_PATH`、`PAGE2KNOWLEDGE_SCHEDULER_PATH` 覆盖。

## 9. 有限抓取与定时任务

### 站点抓取

1. 选择“站点范围”。
2. 输入起始公开 URL。
3. 设置 1–50 页、深度 0–5。
4. 开始后同时审核跳过页面与合并结果。

抓取严格同源，遵守 robots，执行去重并逐页复查 SSRF。robots、超时、大小、重定向或仅 JavaScript 渲染都可能导致失败。

### 定时抓取

1. 打开“定时”。
2. 输入公开 URL，间隔至少 15 分钟。
3. 勾选明确确认后再保存。
4. 只有确实要立即发起网络请求时才点击“立即运行”。
5. 停用任务可阻止后续请求。

调度服务不会自动启用用户任务。只有已持久化、已启用、已确认且到期的任务才会运行。创建前应审核版权、频率和 robots 政策。

## 10. HTTP API

开启鉴权后，除 `/api/health` 外都需要：

```text
Authorization: Bearer <PAGE2KNOWLEDGE_ACCESS_TOKEN>
```

不得把令牌放入 URL、查询参数或 Cookie。

健康检查：

```bash
curl --fail-with-body http://127.0.0.1:4315/api/health
```

内置示例：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  http://127.0.0.1:4315/api/example
```

提取公开页面：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://example.com/docs"}' \
  http://127.0.0.1:4315/api/extract
```

上传 PDF 或字幕：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  -F "file=@./document.pdf" \
  http://127.0.0.1:4315/api/ingest
```

媒体转录再增加 `-F "transcribe=true"`。

| 用途 | 接口 |
|---|---|
| 捕获 | `GET /api/example`、`POST /api/extract`、`POST /api/ingest`、`POST /api/crawl` |
| 差异/导出 | `GET /api/example/versions`、`POST /api/versions/compare`、`POST /api/exports/filter`、`POST /api/exports/edit-title` |
| 知识库 | `GET /api/knowledge/stats`、`POST /api/knowledge/index`、`POST /api/knowledge/search`、`POST /api/knowledge/chat` |
| 调度 | `GET/POST /api/schedules`、`POST /api/schedules/:id/run`、`DELETE /api/schedules/:id` |

若接口接收完整 Page2Knowledge 结果，也必须按不可信输入处理；服务端会独立重建导出并删除未审批事实。

## 11. Docker 与访问令牌

```bash
docker build --tag page2knowledge:local .
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
docker compose config --quiet
docker compose up -d
docker compose ps
```

令牌去除首尾空白后必须不少于 32 个 UTF-8 字节。Compose 只绑定 `127.0.0.1`。真正公网运行仍需 HTTPS 反向代理、精确允许列表、托管密钥、出站网络策略、备份、监控，并通过 [`ops/CLOUD.md`](../ops/CLOUD.md) 全部门禁。

保留数据停止：

```bash
docker compose down
```

## 12. 数据清理

处理状态前先停止全部 Page2Knowledge 进程。

- 重置本地数据时，优先把 `.data/` 重命名并移到仓库外作为带日期的备份，再启动应用；新空库会按需创建。
- 临时隔离数据可在启动前把 `PAGE2KNOWLEDGE_DATA_DIR` 指向一个绝对路径。
- 浏览器令牌只在 `sessionStorage`；关闭当前浏览器会话或清除此站点的会话存储。
- `dist/`、`dist-server/`、coverage、测试报告和 npm 缓存都是可重建且已忽略的产物，项目不会自动删除它们。
- Docker 卷属于持久数据。删除卷前必须备份；`docker compose down --volumes` 对本机命名卷不可恢复。

## 13. 常见问题

| 现象 | 检查项 |
|---|---|
| Node 版本错误 | 使用 Node 22.13+ 或 24+，再执行 `npm ci`。 |
| 页面可开但 API 失败 | 确认两个开发进程都在运行，4314/4315 未占用。 |
| `401` | 页面/API 使用完全相同的当前令牌，并去掉意外首尾空白。 |
| `403` Host/Origin | 使用文档中的回环地址，或在代理后配置精确 Host/Origin。 |
| URL 被拒绝 | 检查协议、凭据、DNS、重定向、私网/保留地址、大小和类型。 |
| PDF 没有文本 | 解密或先做本地 OCR，再导入带文本的 PDF/TXT。 |
| 媒体转录失败 | 检查 Whisper 命令、模型、解码支持、大小、权限、磁盘和内存。 |
| 抓取没有页面 | 检查 robots、同源链接、限制、JS 渲染和超时。 |
| 知识库无结果 | 先索引转换结果，再使用正文中确实存在的关键词。 |
| 定时任务不运行 | 检查 enabled、明确确认、≥15 分钟、到期时间和可写状态目录。 |

## 14. 验证与剩余边界

```bash
npm run check
npm run benchmark:quality
npm audit
```

自动化不依赖公网或 Whisper。生产宣称前还要分别验证真实站点、本机 Whisper 准确率、容器健康与鉴权、持久化、备份恢复、代理链路和目标用户流程。

Page2Knowledge 不是版权绕过工具、无限爬虫、恶意代码沙箱、真相判定器、托管向量库或自动事实审批器。
