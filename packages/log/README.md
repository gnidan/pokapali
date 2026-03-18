# @pokapali/log

```sh
npm install @pokapali/log
```

Zero-dependency structured logging for Pokapali. Provides
a `createLogger(module)` factory that produces a `Logger`
with level-filtered `debug`, `info`, `warn`, and `error`
methods. Output is prefixed with `[pokapali:<module>]`.
Placed as a separate leaf package to avoid dependency
cycles between `@pokapali/core` and `@pokapali/sync`.

## Key Exports

- **`createLogger(module)`** — returns a `Logger`
  instance for the given module name
- **`Logger`** — interface with `debug()`, `info()`,
  `warn()`, `error()` methods
- **`LogLevel`** — `"debug"` | `"info"` | `"warn"` |
  `"error"`

## Configuration

Set the log level via environment variable:

```sh
POKAPALI_LOG_LEVEL=debug npx pokapali ...
```

Or programmatically at runtime:

```ts
import { setLogLevel } from "@pokapali/log";
setLogLevel("debug");
```

Default level is `"info"`.

## Links

- [Root README](https://github.com/gnidan/pokapali#readme)
