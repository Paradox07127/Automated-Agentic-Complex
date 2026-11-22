// Run the real Pi adapter and capture the provider request without opening a socket.
import fs from "node:fs";

globalThis.fetch = async (url, options) => {
  const body = options.body;
  fs.appendFileSync("requests.jsonl", JSON.stringify({ pid: process.pid, bytes: Buffer.byteLength(body),
    request: JSON.parse(body) }) + "\n");
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "[intent:greet]早上好" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
};

await import("../../character_agent/harness/pi_runner.mjs");
