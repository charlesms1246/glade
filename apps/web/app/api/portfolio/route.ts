import { json, withUser } from "@/lib/server/api";
import { portfolioView } from "@/lib/server/portfolio";

export async function GET() {
  return withUser(async (uid) => json(await portfolioView(uid)));
}
