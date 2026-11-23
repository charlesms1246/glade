/** JSON POST/GET to the BFF; throws the server's plain-English error. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`);
  return data;
}

export const errText = (e: unknown) =>
  e instanceof Error && e.name === "NotAllowedError" ? "The passkey prompt was dismissed." : e instanceof Error ? e.message : String(e);
