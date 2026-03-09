# @pokapali/log

> **This package is not published to npm.** It is under
> active development and not yet ready for production use.

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

Set the log level via environment variable or
`localStorage`:

```sh
# Node.js
POKAPALI_LOG_LEVEL=debug npx pokapali ...

# Browser (in DevTools console)
localStorage.setItem("POKAPALI_LOG_LEVEL", "debug")
```

Default level is `"info"`.

## Links

- [Root README](../../README.md)
