export type LogLevel =
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "silent";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const LEVELS: LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
  "silent",
];

function levelIndex(level: LogLevel): number {
  return LEVELS.indexOf(level);
}

function readEnvLevel(): LogLevel | undefined {
  try {
    const val =
      typeof process !== "undefined"
        ? process.env.POKAPALI_LOG_LEVEL
        : undefined;
    if (
      val === "debug"
      || val === "info"
      || val === "warn"
      || val === "error"
      || val === "silent"
    ) {
      return val;
    }
  } catch {
    // process not available (browser)
  }
  return undefined;
}

let globalLevel: LogLevel =
  readEnvLevel() ?? "info";

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

export function createLogger(
  module: string,
): Logger {
  const prefix = `[pokapali:${module}]`;

  return {
    debug(...args) {
      if (levelIndex(globalLevel) <= 0)
        console.debug(prefix, ...args);
    },
    info(...args) {
      if (levelIndex(globalLevel) <= 1)
        console.log(prefix, ...args);
    },
    warn(...args) {
      if (levelIndex(globalLevel) <= 2)
        console.warn(prefix, ...args);
    },
    error(...args) {
      if (levelIndex(globalLevel) <= 3)
        console.error(prefix, ...args);
    },
  };
}
