import { json, withUser } from "@/lib/server/api";
import { searchStocks } from "@/lib/server/market";

export async function GET(req: Request) {
  return withUser(async () => json({ results: await searchStocks(new URL(req.url).searchParams.get("q") ?? "") }));
}
