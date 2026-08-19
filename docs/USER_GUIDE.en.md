# Page2Knowledge User Guide

[中文版本](USER_GUIDE.zh-CN.md) · [README](../README.md)

This guide covers installation, the four workspaces, exports, the API, Docker, Whisper, cleanup, and troubleshooting for Page2Knowledge `0.2.1`.

## 1. Before you start

You need:

- Node.js `22.13+` or `24+`
- npm
- A modern browser
- Docker only for the container workflow
- A local `whisper` executable only for direct audio/video transcription

Page2Knowledge can process built-in examples, public webpages, PDF, VTT, SRT, and TXT without a cloud AI key. Media transcription invokes the local command you configure; it never sends media to an external model service.

## 2. Clone and install

```bash
git clone https://github.com/mason2048/page2knowledge.git
cd page2knowledge
npm ci
```

`npm ci` uses the committed lockfile. Do not place access tokens in `.env`, `.npmrc`, shell scripts, issue attachments, or committed examples.

## 3. Start and stop

Development mode:

```bash
npm run dev
```

- UI: <http://127.0.0.1:4314>
- API: <http://127.0.0.1:4315>

Stop both processes with `Ctrl+C` in the terminal that ran `npm run dev`.

Production-style local mode:

```bash
npm run build
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
NODE_ENV=production npm start
```

Open <http://127.0.0.1:4315>, then enter the current token in the password field. Stop with `Ctrl+C`. Closing the tab clears the token from that browser session; it does not remove the knowledge store.

## 4. First successful operation

1. Open the **Convert** workspace.
2. Select **Use built-in technical document example**.
3. Confirm that cleaned Markdown, page metadata, and source-aware chunks appear.
4. Open a chunk and inspect its title path, locator, and revision.
5. Download Markdown, structured JSON, or Context Package v0.1.

The Context Package should contain `reference` items tagged `untrusted-source` and `reference-only`. An empty “confirmed facts” area is expected: the automatic pipeline does not approve facts.

## 5. Convert sources

### Public webpage

1. Choose **Single-page URL**.
2. Enter a complete public `http://` or `https://` URL.
3. Select **Generate knowledge package**.
4. Review the final URL, fetch time, warnings, Markdown, and chunks before export.

Private addresses, localhost, cloud metadata, URL credentials, dangerous redirects, non-HTML responses, oversized pages, and DNS rebinding are rejected. The tool does not sign in or bypass access controls.

### PDF

1. Choose **Local file**.
2. Select a PDF up to 20 MiB and 250 pages.
3. Review the result. Each chunk should use a `pdf:page=N` locator.

Image-only or encrypted PDFs may have no extractable text. Run OCR locally first, save a text-bearing PDF or TXT file, and import that result. Page2Knowledge does not run OCR automatically.

### VTT, SRT, and TXT

Choose **Local file** and select a file up to 5 MiB. VTT/SRT chunks retain timestamps; TXT chunks retain line-based locators. Subtitle timing must be valid and within the parser limits.

### Audio and video

The UI detects common media types and requests local transcription. Before use:

```bash
whisper --help
export PAGE2KNOWLEDGE_WHISPER_BIN="whisper"
export PAGE2KNOWLEDGE_WHISPER_MODEL="small"
npm run dev
```

The executable name or absolute path can be changed with `PAGE2KNOWLEDGE_WHISPER_BIN`. The model defaults to `small`. Media is limited to 250 MiB and the default transcription concurrency is one process. The standard Docker image intentionally does not include Whisper, FFmpeg, or a model.

## 6. Review and export

- **Edit** changes one chunk title and rebuilds its title path, ID, revision, hashes, summary, and Context Package.
- **Exclude from later exports** removes a chunk only from the rebuilt download; it does not mutate the captured source result.
- Excluding every chunk blocks export.
- **Markdown** downloads cleaned content.
- **Structured JSON** downloads the rebuilt result and provenance.
- **Context Package** downloads Context Package v0.1 with reference-only trust labels.

Downloads are created by the current browser and saved to the browser's chosen download location. Page2Knowledge does not keep an extra copy of a download.

## 7. Compare versions

1. Open **Versions**.
2. Load the built-in two-version example, or paste/import the two structured Page2Knowledge results requested by the UI.
3. Review added, removed, modified, unchanged, and affected chunks.
4. Confirm the before/after revisions and line-level changes.

Historical inputs can contain legacy fact IDs for compatibility. Comparing them does not authorize new facts, and rebuilt v0.2.1 output remains reference-only.

## 8. Local knowledge base

1. Produce or load a result in **Convert**.
2. Open **Knowledge** and add the current result to the local index.
3. Search for a phrase and inspect each hit's URL, title path, locator, and revision.
4. Ask a question. The answer is assembled only from retrieved citations; weak evidence produces a refusal.

The store is a local JSON sparse index, not a hosted vector database or a generative model. Default files are:

- `.data/knowledge-store.json`
- `.data/scheduler-state.json`

Override them with `PAGE2KNOWLEDGE_DATA_DIR`, `PAGE2KNOWLEDGE_KNOWLEDGE_PATH`, and `PAGE2KNOWLEDGE_SCHEDULER_PATH`.

## 9. Bounded crawling and schedules

### Site crawl

1. Choose **Site scope**.
2. Enter the starting public URL.
3. Set 1–50 pages and depth 0–5.
4. Start the crawl and review skipped pages as well as the combined result.

The crawler stays on the same origin, applies robots rules, deduplicates pages, and re-runs SSRF checks. A crawl can still fail because of robots rules, timeouts, content limits, redirects, or a site that requires JavaScript rendering.

### Scheduled fetch

1. Open **Schedule**.
2. Enter a public URL and an interval of at least 15 minutes.
3. Check the explicit confirmation control before saving.
4. Use **Run now** only when an immediate network request is intended.
5. Disable a task to stop future requests.

Creating the scheduler service does not silently enable a task. Only persisted, enabled, confirmed, and due tasks run. Review copyright, rate limits, and robots policy before scheduling.

## 10. HTTP API

When authentication is enabled, all endpoints except `/api/health` require the header below:

```text
Authorization: Bearer <PAGE2KNOWLEDGE_ACCESS_TOKEN>
```

Never put the token in a URL, query string, or Cookie.

Health check:

```bash
curl --fail-with-body http://127.0.0.1:4315/api/health
```

Built-in example:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  http://127.0.0.1:4315/api/example
```

Extract a public page:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://example.com/docs"}' \
  http://127.0.0.1:4315/api/extract
```

Upload a PDF or transcript:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PAGE2KNOWLEDGE_ACCESS_TOKEN}" \
  -F "file=@./document.pdf" \
  http://127.0.0.1:4315/api/ingest
```

Upload media for local transcription by adding `-F "transcribe=true"`.

Main API groups:

| Purpose | Endpoints |
|---|---|
| Capture | `GET /api/example`, `POST /api/extract`, `POST /api/ingest`, `POST /api/crawl` |
| Versions/exports | `GET /api/example/versions`, `POST /api/versions/compare`, `POST /api/exports/filter`, `POST /api/exports/edit-title` |
| Knowledge | `GET /api/knowledge/stats`, `POST /api/knowledge/index`, `POST /api/knowledge/search`, `POST /api/knowledge/chat` |
| Schedules | `GET/POST /api/schedules`, `POST /api/schedules/:id/run`, `DELETE /api/schedules/:id` |

The API accepts structured Page2Knowledge results in several routes. Treat those objects as untrusted input; the server independently rebuilds exports and removes unapproved facts.

## 11. Docker and access tokens

```bash
docker build --tag page2knowledge:local .
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
docker compose config --quiet
docker compose up -d
docker compose ps
```

The token must contain at least 32 UTF-8 bytes after trimming. Compose binds the host port to `127.0.0.1`; production internet access still requires an HTTPS reverse proxy, exact allowlists, a managed secret, outbound network policy, backups, monitoring, and every gate in [`ops/CLOUD.md`](../ops/CLOUD.md).

Stop while preserving data:

```bash
docker compose down
```

## 12. Data cleanup

Stop all Page2Knowledge processes before touching state.

- To reset a local checkout safely, first rename `.data/` to a dated backup outside the repository, then start the app. A new empty store is created on demand.
- To use an isolated disposable state directory, set `PAGE2KNOWLEDGE_DATA_DIR` to an absolute path before starting.
- Browser access tokens live only in `sessionStorage`; close the tab/browser session or clear this site's session storage.
- `dist/`, `dist-server/`, coverage, test reports, and npm caches are generated artifacts. They can be regenerated and are ignored by Git, but this project never deletes them automatically.
- The Docker volume contains durable data. Back it up before any volume removal. `docker compose down --volumes` is irreversible for the local named volume.

## 13. Troubleshooting

| Symptom | What to check |
|---|---|
| Node engine error | Use Node 22.13+ or 24+, then rerun `npm ci`. |
| UI opens but API fails | Confirm both dev processes are running and ports 4314/4315 are free. |
| `401` | Enter/send the exact current Bearer token; trim accidental leading/trailing whitespace. |
| `403` Host/Origin error | Use the documented loopback URL or configure exact allowed Host and Origin values behind the proxy. |
| Public URL rejected | Check protocol, credentials, DNS result, redirects, private/reserved addresses, size, and content type. |
| PDF has no text | Decrypt it or run local OCR, then import a text-bearing PDF/TXT. |
| Media transcription fails | Confirm the Whisper command, model, decoder support, file size, permissions, and available disk/memory. |
| Crawl returns no pages | Check robots rules, same-origin links, limits, JS-only rendering, and timeouts. |
| Knowledge result is empty | Index a converted result first; then use terms present in the source. |
| Schedule does not run | Confirm `enabled`, explicit confirmation, interval ≥15 minutes, due time, and persistent writable state. |

## 14. Verification and known limits

```bash
npm run check
npm run benchmark:quality
npm audit
```

Automated checks are deterministic and do not require Whisper or the public internet. Separately validate real sites, local Whisper accuracy, container health/authentication, persistence, backup recovery, proxy behavior, and target-user workflows before claiming production readiness.

Page2Knowledge is not a copyright bypass, crawler-as-a-service, malware sandbox, truth engine, hosted vector database, or autonomous fact approver.
