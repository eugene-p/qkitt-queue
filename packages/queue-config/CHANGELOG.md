# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `engines.node` is now `>=20` (aligned with core and CI)

## [0.2.2] — 2026-07-19

### Docs

- Quick start: minimal single-queue worker first, then persist + router
- Build rules: same stack mnemonic as core (persist inside, worker outside)

## [0.2.1] — 2026-07-19

### Added

- `PersistConfig.autoSaveDebounceMs` (snapshot stores only) — passed through to `withSnapshotPersist`; safe integer ≥ 0

### Docs

- README: document `autoSaveDebounceMs` on persist config

## [0.2.0] — 2026-07-19

### Added

- `ConfigValidationError` with stable `code` field (`ConfigErrorCode`) for programmatic handling of validation / build failures
- Internal built-in adapter factory map (add adapters without shotgun edits to resolve logic)
- Integration contract tests that exercise the `@qkitt/queue` surface wired by this package (queue / persist / worker / router / all built-in adapters)
- Coverage for `sessionStorage` happy path and deep-frozen nested config

### Fixed

- `freezeConfig` now freezes nested plain data (`persist`, router bindings, builtin store defs); previously only top-level queue/store keys were frozen
- `isPlainObject` no longer accepts `Date`, `Map`, `Set`, `RegExp`, and similar built-ins

### Changed

- `validateJsConfig` / `defineConfig` validate **in place** and return the same object reference (extra properties and identity preserved). JSON path (`validateSystemConfig` / `parseSystemConfig`) still returns a cleaned reconstructed config
- Config snapshot docs: nested plain data is frozen; worker functions and store `impl` instances stay live
- Store shape guards share one canonical method-shape check between parse and resolve
- Lifecycle `hydrateAll` / `flushAll` share a single `runOnQueues` helper
- Removed deprecated `expectPositiveFinite` alias (use integer validation only; public API was never the alias)

### Migration

```ts
import {
  buildFromConfig,
  ConfigValidationError,
  type ConfigErrorCode,
} from '@qkitt/queue-config'

try {
  await buildFromConfig(config)
} catch (e) {
  if (e instanceof ConfigValidationError) {
    // e.code — e.g. 'STORE_NOT_FOUND' | 'KEY_REQUIRED' | …
    // e.path — optional config path
  }
}
```

Error **messages** are unchanged in spirit; prefer `instanceof ConfigValidationError` + `code` over regex on `message`.

[0.2.2]: https://github.com/eugene-p/qkitt-queue/releases/tag/queue-config-v0.2.2
[0.2.1]: https://github.com/eugene-p/qkitt-queue/releases/tag/queue-config-v0.2.1
[0.2.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/queue-config-v0.2.0

## [0.1.0] — 2026-07-16

### Added

- Initial extract of declarative config from `@qkitt/queue` into `@qkitt/queue-config`
- `defineConfig`, `buildFromConfig`, `buildFromJson`, `parseSystemConfig`, `validateJsConfig`, `validateSystemConfig`, and related types
- Peer dependency on `@qkitt/queue` `^0.5.0` (config package version is independent of core)

### Migration

```ts
// before (≤ 0.4.x)
import { buildFromConfig, defineConfig } from '@qkitt/queue'
// or from '@qkitt/queue/config'

// after
import { buildFromConfig, defineConfig } from '@qkitt/queue-config'
```

[0.1.0]: https://github.com/eugene-p/qkitt-queue/releases/tag/v0.5.0
