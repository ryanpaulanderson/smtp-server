/** Bounded request consumption before handing JSON to the MCP transport. */
import { MailError } from "../mail/contracts";

/** Read at most limit bytes within five seconds; cancel oversized or stalled streams. */
export async function readBoundedBody(
  request: Request,
  limit = 128 * 1024,
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new MailError("REQUEST_TOO_LARGE");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 5_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) throw new MailError("REQUEST_TIMEOUT");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MailError("REQUEST_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
