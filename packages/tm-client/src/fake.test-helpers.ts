export type Handler = (req: Request, url: URL) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

/** Records every request and routes by "METHOD /path". */
export function fakeServer(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; headers: Headers; body: string }[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.clone().text();
    calls.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return json(404, { type: "not_found", message: `no route ${req.method} ${url.pathname}`, request_id: "fake" });
    return h(req, url);
  };
  return { fetch: fetchFn as typeof fetch, calls };
}
