import { describe, it, expect } from "vitest";
import { statusLabel, saveLabel } from "./doc-status.js";

describe("statusLabel", () => {
  it("maps every DocStatus to a string", () => {
    expect(statusLabel("synced")).toBe("Live");
    expect(statusLabel("receiving")).toBe("Subscribed");
    expect(statusLabel("connecting")).toBe("Connecting");
    expect(statusLabel("offline")).toBe("Offline");
  });
});

describe("saveLabel", () => {
  it("maps every SaveState to a string", () => {
    expect(saveLabel("saved")).toBe("Published");
    expect(saveLabel("unpublished")).toBe("Publish now");
    expect(saveLabel("saving")).toBe("Saving\u2026");
    expect(saveLabel("dirty")).toBe("Publish changes");
    expect(saveLabel("save-error")).toBe("Save failed");
  });
});
