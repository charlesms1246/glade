export const MAX_BODY_BYTES = 64 * 1024;

/** Parse a JSON body no larger than `max` bytes; null when missing, oversized or malformed. */
export async function readJson<T = unknown>(req: Request, max = MAX_BODY_BYTES): Promise<T | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}
