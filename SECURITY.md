# Security Policy

## Supported versions

Security fixes are currently prepared for the latest `0.2.x` source on the default branch. Older snapshots and unpublished local builds are not maintained as separate release lines.

## Report a vulnerability privately

Use [GitHub Private Vulnerability Reporting](https://github.com/mason2048/page2knowledge/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include:

- the affected version or commit;
- the smallest reproducible request or input;
- expected and observed behavior;
- impact and required preconditions;
- suggested mitigation, if known.

Use synthetic URLs, tokens, documents, and knowledge data. Do not attach real credentials, private documents, customer data, access logs, production backups, or copyrighted source content. If a secret was exposed during testing, revoke and rotate it before reporting.

The maintainer will aim to acknowledge a complete report within three business days, validate impact, coordinate a fix, and agree on disclosure timing. Please avoid public disclosure until a fix or mitigation is available.

## High-priority areas

- SSRF, redirect, DNS rebinding, Host, Origin, and proxy-boundary bypasses;
- access-token bypass, leakage, logging, or timing issues;
- arbitrary file reads/writes through local-source metadata or upload paths;
- source text crossing the reference-only fact-approval boundary;
- secret values appearing in snapshots, exports, logs, errors, or reports;
- command execution through HTML, documents, media, Whisper arguments, or imported data;
- scheduler authorization, persistence, or cross-task isolation failures;
- container privilege escalation or escape from the documented read-only boundary.

## Security boundaries that are not vulnerabilities by themselves

- Rule-based detection can have false positives and false negatives.
- Public reachability does not grant content copyright.
- The standard container does not include Whisper or a media model.
- Local JSON persistence is a single-writer design, not a multi-node database.
- Automated tests and a healthy container do not prove a production deployment is secure.

See [README.md](README.md), [the user guide](docs/USER_GUIDE.en.md), and [cloud gates](ops/CLOUD.md) for the complete operating model.

## 中文说明

安全问题请通过 [GitHub 私密漏洞报告](https://github.com/mason2048/page2knowledge/security/advisories/new) 提交，不要创建公开 Issue。只使用人工构造的复现数据，不要上传真实令牌、私有文档、客户数据、生产日志或备份；已暴露凭据应先撤销和轮换。
