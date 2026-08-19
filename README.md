# Page2Knowledge

[中文说明](README.zh-CN.md) · [English user guide](docs/USER_GUIDE.en.md) · [中文用户指南](docs/USER_GUIDE.zh-CN.md)

Page2Knowledge turns public webpages, bounded same-origin sites, local PDFs, transcripts, and media into source-aware knowledge packages. It preserves provenance, supports version comparison and local retrieval, and can run entirely on one machine or in a hardened self-hosted container.

The current version is `0.2.1`. It is a local/self-hosted release candidate, not a hosted service.

> **Trust boundary:** automatic ingestion never promotes source text to a fact. Unapproved content is exported only as `reference` with `untrusted-source` and `reference-only` tags. A missing prompt-injection warning does not make content trusted. The current MVP exposes no public fact-approval endpoint.

## What it does

- Extracts clean Markdown, metadata, links, lists, and fenced code from one public URL.
- Parses local PDF, VTT, SRT, and TXT files with page, timestamp, or line locators.
- Transcribes common audio/video files through a user-installed local Whisper command.
- Crawls a user-bounded, same-origin site while enforcing robots and SSRF controls.
- Compares two revisions and reports added, removed, changed, and affected chunks.
- Stores a local sparse index for deterministic search and citation-only answers.
- Runs explicitly confirmed schedules with a minimum 15-minute interval.
- Exports Markdown, structured JSON, and Context Package v0.1.
- Provides an authenticated HTTP API and a hardened Docker/Compose baseline.

## Quick start

Requirements:

- Node.js `22.13+` or `24+`
- npm

```bash
git clone https://github.com/mason2048/page2knowledge.git
cd page2knowledge
npm ci
npm run dev
```

Open <http://127.0.0.1:4314>. The UI proxies its API requests to `127.0.0.1:4315` in development. Select **Use built-in technical document example** for a safe first run.

Stop both development processes with `Ctrl+C` in the terminal that started them.

For the full workflow, data cleanup, API examples, Docker, access tokens, and troubleshooting, see the [English user guide](docs/USER_GUIDE.en.md).

## Production-style local run

```bash
npm run build
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
NODE_ENV=production npm start
```

Open <http://127.0.0.1:4315> and enter the same access token in the UI. Production mode binds to `0.0.0.0`; do not expose it without a firewall, HTTPS reverse proxy, exact Host/Origin allowlists, and the Bearer-token boundary described in [ops/CLOUD.md](ops/CLOUD.md).

## Inputs and limits

| Input | Current limit | Provenance |
|---|---:|---|
| Public HTML page | 2 MiB, 12 s, 4 redirects | final URL and document structure |
| Same-origin crawl | 50 pages, depth 5, 3 min | per-page URL and chunk locator |
| PDF | 20 MiB, 250 pages | `pdf:page=N` |
| VTT/SRT/TXT | 5 MiB | timestamp or line locator |
| Audio/video | 250 MiB | `media:t=` through local Whisper |

All HTML, documents, transcripts, and media-derived text remain untrusted references. Page2Knowledge does not log in to sites, bypass paywalls, execute source scripts, or obtain copyright permission on the user's behalf.

## Verification

```bash
npm run check
npm run benchmark:quality
npm audit
```

`npm run check` runs the complete Vitest suite and production build. The deterministic benchmark requires at least 90% body retention, no more than 10% navigation noise, at least 95% code-language retention, and completion within 60 seconds. Tests cover the multilingual/OCR/HTML prompt-injection matrix and the independent reference-only export boundary.

The fixed tests do not prove public-network behavior, Whisper accuracy, cloud deployment, backup recovery, or real-user acceptance.

## Docker

```bash
docker build --tag page2knowledge:local .
export PAGE2KNOWLEDGE_ACCESS_TOKEN="$(openssl rand -base64 48)"
docker compose up -d
docker compose ps
```

Compose publishes only `127.0.0.1:4315`, runs as a non-root user with a read-only root filesystem, and stores state in `page2knowledge-data`. Stop without deleting data:

```bash
docker compose down
```

Do not use `docker compose down --volumes` unless permanent deletion of the knowledge and scheduler data is intentional and backed up.

## Security model

- Every URL and redirect is checked against protocol, credential, DNS, address, and SSRF rules.
- Local virtual `file:///` identities are metadata only and cannot read arbitrary server paths.
- Browser data requests require a constant-time Bearer-token check when authentication is enabled.
- The token is accepted only in the `Authorization` header and is kept in the current browser `sessionStorage` session.
- Source text, Skill-like instructions, and imported objects are data, never execution instructions.
- Secret-like strings are redacted before they can enter generated outputs.
- Local JSON stores use atomic replacement, but production remains a single-writer design.

Please report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/mason2048/page2knowledge/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).

## Documentation

- [English user guide](docs/USER_GUIDE.en.md)
- [中文用户指南](docs/USER_GUIDE.zh-CN.md)
- [Cloud and production gates](ops/CLOUD.md)
- [Historical PRD v0.1](PRD.md)
- [Contributing](CONTRIBUTING.md)

The PRD freezes the original v0.1/P0 scope. Features added in v0.2.1 are documented here and in the user guides; the PRD's original “not included” list is historical rather than the current release boundary.

## License

Apache License 2.0. See [LICENSE](LICENSE).
