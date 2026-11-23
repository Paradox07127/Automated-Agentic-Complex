import { act as flush, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge } from "../../src/bridge/fake";
import type { AgenticComplexBridge, StackPayload } from "../../src/bridge/protocol";
import { BubbleRoot } from "../../src/surfaces/desktop/BubbleRoot";
import { stubMatchMedia } from "./mediaStub";

// A due reminder in the bubble: read once shown, with no button to answer it.

stubMatchMedia();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
  window.location.hash = "";
});

const NOW = 1_800_000_000_000;
const CARD = {
  id: "announce-7",
  kind: "notice",
  variant: "reminder",
  at: NOW,
  title: "提醒你：交报销单",
  commitment_id: "c-42",
} as const;

/** The bubble on the fake bridge with `card` pushed as the one due reminder. */
async function mountWith(card: typeof CARD) {
  const bridge: AgenticComplexBridge = createFakeBridge({ surface: "stack", still: true });
  window.agenticComplex = bridge;
  window.location.hash = "#/bubble?still=1";
  let push: ((p: StackPayload) => void) | undefined;
  vi.spyOn(bridge.stack, "onCards").mockImplementation((cb) => {
    push = cb;
    return () => {};
  });
  render(<BubbleRoot />);
  await flush(async () => push?.({ now: NOW, cards: [card], history: [] }));
  screen.getByText(card.title);
  return bridge;
}

describe("reminder in the bubble", () => {
  it("shows the reminder with its time and posts it read, asking agentd nothing else", async () => {
    const bridge = createFakeBridge({ surface: "stack", still: true });
    const request = vi.spyOn(bridge.agentd, "request").mockResolvedValue({ status: 200, body: {} });
    window.agenticComplex = bridge;
    window.location.hash = "#/bubble?still=1";
    let push: ((p: StackPayload) => void) | undefined;
    vi.spyOn(bridge.stack, "onCards").mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    render(<BubbleRoot />);
    await flush(async () => push?.({ now: NOW, cards: [CARD], history: [] }));
    screen.getByText(CARD.title);
    expect(screen.getByText("提醒").closest("[data-bubble]")).not.toBeNull();
    expect(screen.queryAllByRole("button").filter((b) => /知道了|稍后/.test(b.textContent ?? ""))).toHaveLength(0);
    expect(request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(["POST /commitments/c-42/seen"]);
  });

  it("stays while the bubble is held still", async () => {
    await mountWith(CARD);
    screen.getByText(CARD.title);
  });
});
