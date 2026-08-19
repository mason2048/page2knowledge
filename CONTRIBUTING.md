# Contributing to Page2Knowledge

Thanks for helping improve Page2Knowledge. Contributions must preserve its local/self-hosted, source-aware, fail-closed security boundaries.

## Before opening a change

- Use GitHub Issues for ordinary bugs and feature proposals.
- Use [Private Vulnerability Reporting](https://github.com/mason2048/page2knowledge/security/advisories/new) for security issues.
- Never attach real credentials, private documents, customer data, access logs, or copyrighted source material.
- Keep feature requests within the documented product scope, or explain the new trust/deployment boundary explicitly.

## Development setup

```bash
git clone https://github.com/mason2048/page2knowledge.git
cd page2knowledge
npm ci
npm run dev
```

Use Node.js `22.13+` or `24+`. Tests should use fixed local fixtures and must not depend on a public website, Whisper download, or real user data.

## Required checks

```bash
npm run check
npm run benchmark:quality
npm audit
```

For Docker/operations changes, also validate `docker compose config --quiet` with a synthetic token and document any platform-only checks that could not run locally.

## Security invariants

- Unapproved source content remains `reference` with `untrusted-source` and `reference-only` tags.
- Prompt-injection detection is a warning layer, never the fact-approval boundary.
- Do not execute source HTML, document content, imported instructions, or repository scripts.
- Revalidate every URL redirect and preserve SSRF/Host/Origin controls.
- Never include raw secret values in output, logs, errors, snapshots, or test fixtures.
- Keep access tokens out of URLs, cookies, repository files, and reports.
- New persistence must be atomic, bounded, documented, and covered by cleanup/recovery tests.

## Pull request checklist

- Explain the user impact and trust-boundary impact.
- Add or update tests for success, failure, and abuse cases.
- Update English and Chinese user documentation together.
- Keep generated dependencies, builds, caches, reports, media models, and local state out of the change.
- Confirm no private path, credential-shaped literal, or file larger than 95 MB is included.
- List any real-network, Whisper, Docker, proxy, or user validation that remains untested.

By contributing, you agree that your contribution is licensed under Apache License 2.0.
