import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from "vitest";
import {
  createLogger,
  setLogLevel,
  getLogLevel,
} from "./index.js";

describe("@pokapali/log", () => {
  beforeEach(() => {
    setLogLevel("info");
    vi.restoreAllMocks();
  });

  it("logs with module prefix", () => {
    const spy = vi.spyOn(console, "log")
      .mockImplementation(() => {});
    const log = createLogger("test");
    log.info("hello");
    expect(spy).toHaveBeenCalledWith(
      "[pokapali:test]",
      "hello",
    );
  });

  it("supports multiple args", () => {
    const spy = vi.spyOn(console, "log")
      .mockImplementation(() => {});
    const log = createLogger("test");
    log.info("count:", 42, "done");
    expect(spy).toHaveBeenCalledWith(
      "[pokapali:test]",
      "count:",
      42,
      "done",
    );
  });

  it("routes levels to correct console methods", () => {
    setLogLevel("debug");
    const debugSpy = vi.spyOn(console, "debug")
      .mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log")
      .mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn")
      .mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error")
      .mockImplementation(() => {});

    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  describe("level filtering", () => {
    it("suppresses debug at info level", () => {
      const spy = vi.spyOn(console, "debug")
        .mockImplementation(() => {});
      setLogLevel("info");
      const log = createLogger("test");
      log.debug("should not appear");
      expect(spy).not.toHaveBeenCalled();
    });

    it("shows debug at debug level", () => {
      const spy = vi.spyOn(console, "debug")
        .mockImplementation(() => {});
      setLogLevel("debug");
      const log = createLogger("test");
      log.debug("should appear");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("suppresses info at warn level", () => {
      const logSpy = vi.spyOn(console, "log")
        .mockImplementation(() => {});
      setLogLevel("warn");
      const log = createLogger("test");
      log.info("should not appear");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("shows warn at warn level", () => {
      const spy = vi.spyOn(console, "warn")
        .mockImplementation(() => {});
      setLogLevel("warn");
      const log = createLogger("test");
      log.warn("should appear");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("only shows error at error level", () => {
      setLogLevel("error");
      const logSpy = vi.spyOn(console, "log")
        .mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn")
        .mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error")
        .mockImplementation(() => {});

      const log = createLogger("test");
      log.info("no");
      log.warn("no");
      log.error("yes");

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLogLevel / setLogLevel", () => {
    it("returns current level", () => {
      setLogLevel("warn");
      expect(getLogLevel()).toBe("warn");
    });

    it("defaults to info", () => {
      // Reset was done in beforeEach
      expect(getLogLevel()).toBe("info");
    });
  });

  it("level changes affect existing loggers", () => {
    const spy = vi.spyOn(console, "debug")
      .mockImplementation(() => {});
    const log = createLogger("test");

    setLogLevel("info");
    log.debug("suppressed");
    expect(spy).not.toHaveBeenCalled();

    setLogLevel("debug");
    log.debug("shown");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
