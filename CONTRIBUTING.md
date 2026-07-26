# Contributing

## Reporting bugs

Open an issue using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).  
Include the output of `cc-router status --json` and your OS/Node version.

## Proposing features

Open an issue using the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) before writing code — this avoids duplicate work.

## Development setup

```bash
git clone https://github.com/Timo972/cc-router.git
cd cc-router
npm install

# Run in dev mode (tsx, no build step)
npm run dev -- --help

# Build
npm run build

# Type-check only (no emit)
npm run lint

# Tests
npm test
```

## Code conventions

- **TypeScript strict mode** — no `any` except where unavoidable, no `@ts-ignore`
- **ESM throughout** — imports use `.js` extension on relative paths
- **No shell injection** — use `execFile` with argument arrays, never `exec` with string interpolation
- **Atomic file writes** — use `writeFileSync(.tmp)` + `renameSync` for anything that stores credentials
- **No global side effects on import** — only `startServer()` and similar explicit calls should do I/O

## Pull request process

1. Fork, create a branch (`fix/token-refresh-lock`, `feat/windows-service`)
2. Make your changes with tests where applicable
3. `npm run build && npm test` must pass
4. Open a PR against `main` using the PR template
5. One approving review required before merge

## Releasing (maintainers)

```bash
# Bump version in package.json, then:
git tag v0.2.0
git push origin v0.2.0
# GitHub Actions will build, test and publish to npm automatically
```
