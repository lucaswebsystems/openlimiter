/** Consume at most limit bytes, cancelling the producer before retaining overflow. */
export async function readBoundedResponse(
  response: Response,
  limit: number,
  controller: AbortController
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > limit - size) {
        controller.abort();
        void reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(next.value, size);
      size += next.value.byteLength;
    }
    return bytes.subarray(0, size);
  } finally {
    reader.releaseLock();
  }
}
