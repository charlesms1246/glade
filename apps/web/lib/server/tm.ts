import "server-only";
import { TM_BASE_URLS } from "@glade/shared";
import { createTmClient } from "@glade/tm-client";

/** Public (unauthenticated) True Markets reads: prices, history, catalog. Always production market data. */
export function tmPublic() {
  return createTmClient({ restBase: TM_BASE_URLS.prod.rest });
}
