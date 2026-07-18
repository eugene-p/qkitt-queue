# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
