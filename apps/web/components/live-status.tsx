import { currentClosure, isOpen, nextClose, nextOpen } from "@glade/calendar";
import { connection } from "next/server";
import { MarketClock } from "./market-clock";

export async function LiveStatus() {
  await connection();
  const now = new Date();
  return (
    <MarketClock
      open={isOpen(now)}
      nextOpen={nextOpen(now).toISOString()}
      nextClose={nextClose(now).toISOString()}
      kind={currentClosure(now)?.kind ?? null}
    />
  );
}
