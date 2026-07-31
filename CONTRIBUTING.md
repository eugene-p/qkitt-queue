# Contributing to qkitt-queue

Thanks for your interest in contributing! This document covers everything you need to get started.

The project stays small by design: the core is an ESM-only, dependency-free in-process queue, while optional configuration and benchmarks live alongside it. Before changing behavior, identify which layer owns the concern and read the corresponding user guide so the API, examples, and docs keep telling the same story.

## Development setup

```bash
git clone https://github.com/eugene-p/qkitt-queue.git
cd qkitt-queue
npm install
```

Requires Node.js >= 20 (`engines`). CI tests on Node 20, 22, 24, and 26. The repo is an npm workspaces monorepo with three packages under `packages/`.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm test` | Run all tests (queue, then build, then config) |
| `npm run typecheck` | Type-check all packages |
| `npm run build` | Build queue, then config |
| `npm run bench` | Default payload, durable, and workload regression suites |
| `npm run bench:worker` | Optional scheduler-drain diagnostic |
| `npm run examples` | Run all runnable examples |
| `npm run release:check` | Full pre-release gate: typecheck + test + build + pack |

Tests live alongside source as `src/**/*.test.ts` and use Vitest with globals enabled.

## Benchmarks and performance work

Benchmarks guard **workload regressions** and **retained-memory** invariants. They are not a ranking exercise against unrelated libraries.

When changing performance-sensitive code, follow this priority order:

1. **Persistence / correctness** — durable contracts, restart safety, at-least-once delivery
2. **Retained memory** — heap growth under realistic payloads and backlog
3. **Throughput** — only after the above hold

Ranking-driven micro-optimizations against peer scoreboards are not goals. A new optimization should name the **user workload** or **invariant** it protects (for example: “hydrate + drain under 5k durable rows stays within X heap” or “full-queue enqueue remains O(1) in the common path”).

Worker drain remains a **supported lifecycle contract** (examples and docs cover `whenIdle`, graceful stop, and concurrent drain). Drain is something applications rely on — not a competitive ranking target. Default `npm run bench` covers payload, durable, and workload suites; use `npm run bench:worker` only when you need the optional scheduler-drain diagnostic.

## Project structure

```
packages/
  queue/          @qkitt/queue — core library
  queue-config/   @qkitt/queue-config — declarative config builder
  bench/          @qkitt/queue-bench — private benchmark harness
examples/         Runnable use-case demos
```

## Code style

- ESM-only, zero runtime dependencies on core.
- Strict TypeScript (`strict: true`).
- Match existing comment style — TSDoc on public API surfaces.
- Prefer small, focused diffs. One concern per PR.
- No `any` in public API types; internal utilities may use narrow casts with a comment.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Add or update tests for any behavior change.
3. Make sure `npm run release:check` passes.
4. Keep the diff tight — avoid unrelated refactors in the same PR.
5. Write a clear PR title and description explaining the *why*.

## Reporting bugs

Use the [bug report template](https://github.com/eugene-p/qkitt-queue/issues/new?template=bug_report.yml). Include a minimal reproduction if possible — a short snippet or a link to a StackBlitz/CodeSandbox helps enormously.

## Feature requests

Use the [feature request template](https://github.com/eugene-p/qkitt-queue/issues/new?template=feature_request.yml). Describe the use case and the API shape you'd expect. Not every request will be accepted — the library intentionally stays small — but every request gets read.

## Questions

For "how do I…" questions, prefer [GitHub Discussions](https://github.com/eugene-p/qkitt-queue/discussions) over issues. It keeps the issue tracker focused on actionable work and helps other users find answers.

## License

By contributing, you agree that your contributions will be licensed under the ISC License.
