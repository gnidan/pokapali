/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ValidationWarning } from "./ValidationWarning";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

function renderWarning(error: { cid: string; message: string } | null) {
  act(() => {
    root.render(createElement(ValidationWarning, { error }));
  });
}

describe("ValidationWarning", () => {
  it("renders nothing when error is null", () => {
    renderWarning(null);
    expect(container.querySelector(".validation-warning")).toBeNull();
  });

  it("shows warning when error is present", () => {
    renderWarning({
      cid: "bafyabc123456789xyz",
      message: "Snapshot block failed validation",
    });
    const el = container.querySelector(".validation-warning");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("role")).toBe("status");
    expect(el!.textContent).toContain("received update was rejected");
  });

  it("shows truncated CID for long CIDs", () => {
    renderWarning({
      cid: "bafyabc123456789xyzlongcid",
      message: "failed",
    });
    const cidEl = container.querySelector(".validation-warning-cid");
    expect(cidEl!.textContent).toBe("bafyabc123456789…");
  });

  it("dismisses on button click", () => {
    renderWarning({
      cid: "bafyabc123456789xyz",
      message: "failed",
    });
    const btn = container.querySelector(
      ".validation-warning-dismiss",
    ) as HTMLButtonElement;
    act(() => btn.click());
    expect(container.querySelector(".validation-warning")).toBeNull();
  });

  it("reappears for a new error CID", () => {
    renderWarning({
      cid: "bafyabc1",
      message: "failed",
    });
    const btn = container.querySelector(
      ".validation-warning-dismiss",
    ) as HTMLButtonElement;
    act(() => btn.click());
    expect(container.querySelector(".validation-warning")).toBeNull();

    renderWarning({
      cid: "bafydef2",
      message: "failed again",
    });
    expect(container.querySelector(".validation-warning")).not.toBeNull();
  });

  it("stays dismissed for same CID", () => {
    const error = {
      cid: "bafyabc1",
      message: "failed",
    };
    renderWarning(error);
    const btn = container.querySelector(
      ".validation-warning-dismiss",
    ) as HTMLButtonElement;
    act(() => btn.click());

    // Re-render with same error
    renderWarning(error);
    expect(container.querySelector(".validation-warning")).toBeNull();
  });

  it("has full CID in title for debugging", () => {
    const cid = "bafyabc123456789xyzlongcid";
    renderWarning({ cid, message: "failed" });
    const el = container.querySelector(".validation-warning");
    expect(el!.getAttribute("title")).toBe(`Rejected snapshot: ${cid}`);
  });
});
