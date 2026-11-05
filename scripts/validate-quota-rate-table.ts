import { readFileSync } from "node:fs";
import { parseRateTable } from "../quota/rate-table";

/** Exit 0 when the file is a rate table the service would accept, exit 2 otherwise. Prints nothing from the file. */
try {
  parseRateTable(readFileSync(process.argv[2] ?? "", "utf8"));
} catch {
  console.error("The values file is not a rate table this service accepts.");
  process.exit(2);
}
