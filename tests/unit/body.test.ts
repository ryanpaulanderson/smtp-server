import { describe, expect, it, vi } from "vitest";
import { readBoundedBody } from "../../src/http/body.js";

describe("bounded MCP request body", () => {
  it("reads a body and handles an empty request", async () => {
    expect(
      new TextDecoder().decode(
        await readBoundedBody(
          new Request("https://example.com", { method: "POST", body: "test" }),
          4,
        ),
      ),
    ).toBe("test");
    expect(await readBoundedBody(new Request("https://example.com"))).toHaveLength(0);
  });

  it("rejects both declared and streamed excess bytes", async () => {
    await expect(
      readBoundedBody(
        new Request("https://example.com", {
          method: "POST",
          body: "test",
          headers: { "Content-Length": "100" },
        }),
        4,
      ),
    ).rejects.toThrow("REQUEST_TOO_LARGE");
    await expect(
      readBoundedBody(
        new Request("https://example.com", { method: "POST", body: "test" }),
        3,
      ),
    ).rejects.toThrow("REQUEST_TOO_LARGE");
  });

  it("cancels a stalled stream after five seconds", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      // Node requires duplex for streaming bodies; the transport option is not yet in lib.dom.
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body: stream,
        duplex: "half",
      };
      const work = expect(
        readBoundedBody(new Request("https://example.com", init)),
      ).rejects.toThrow("REQUEST_TIMEOUT");
      await vi.advanceTimersByTimeAsync(5_001);
      await work;
    } finally {
      vi.useRealTimers();
    }
  });
});
