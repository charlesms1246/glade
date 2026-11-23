import { json, withUser } from "@/lib/server/api";
import { floorView } from "@/lib/server/floor";

export async function GET() {
  return withUser(async (uid) => json(await floorView(uid)));
}
