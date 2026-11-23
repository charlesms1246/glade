/** A True Markets API error, mapped from the `Error` schema ({type, code, message, request_id}). */
export class TmApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly body: unknown;

  constructor(status: number, body: unknown, method: string, path: string) {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "unknown";
    const code = typeof b.code === "string" ? b.code : undefined;
    const msg = typeof b.message === "string" ? b.message : "";
    const requestId = typeof b.request_id === "string" ? b.request_id : undefined;
    super(`${method} ${path} → ${status} ${type}${code ? `/${code}` : ""}: ${msg} (request_id=${requestId ?? "-"})`);
    this.name = "TmApiError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }

  get isQuoteStale(): boolean {
    return this.status === 422 && this.code === "quote_stale";
  }
  get isAlreadySubmitted(): boolean {
    return this.status === 409 && this.code === "already_submitted";
  }
}
