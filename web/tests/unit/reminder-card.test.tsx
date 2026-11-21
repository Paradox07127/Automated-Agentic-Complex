import { act as flush, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge } from "../../src/bridge/fake";
import type { AgenticComplexBridge, StackPayload } from "../../src/bridge/protocol";
import { BubbleRoot } from "../../src/surfaces/desktop/BubbleRoot";
import { stubMatchMedia } from "./mediaStub";

// A due reminder in the bubble goes straight at its commitment in agentd; a refusal keeps it and says why.

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

const ILLEGAL = { status: 409, body: { error: "illegal_transition" }, error: { code: "illegal_transition" } };

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
  it("a refused snooze keeps the reminder and says why in Chinese", async () => {
    const bridge = await mountWith(CARD);
    vi.spyOn(bridge.agentd, "request").mockResolvedValue(ILLEGAL);
    await flush(async () => fireEvent.click(screen.getByRole("button", { name: "稍后" })));
    expect(await screen.findByText(/^没能延后提醒：/)).toBeTruthy();
    screen.getByText(CARD.title);
  });

  it("知道了 on a reminder agentd already marked delivered just puts it away", async () => {
    const bridge = await mountWith(CARD);
    vi.spyOn(bridge.agentd, "request").mockResolvedValue(ILLEGAL);
    await flush(async () => fireEvent.click(screen.getByRole("button", { name: "知道了" })));
    expect(screen.queryByText(CARD.title)).toBeNull();
    expect(screen.queryByText(/^没能完成提醒：/)).toBeNull();
  });
});
