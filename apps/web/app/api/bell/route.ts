import { getBellView } from "@/lib/server/bell";

export async function GET() {
  const view = await getBellView(new Date());
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
