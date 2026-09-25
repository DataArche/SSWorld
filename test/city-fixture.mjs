// Shared by the city tests only: where the synthetic dataset lives.
import { existsSync } from "node:fs";
import path from "node:path";

/** The city fixture, in whichever layout this copy is running from: the repository tree
 *  (src/ssdl/mcp/test -> src/ssdl/fixtures) or the packed package (package/test -> package/fixtures). */
export function cityFixture(here) {
  const candidates = [path.resolve(here, "../../fixtures/city/synthetic-riverside"),
    path.resolve(here, "../fixtures/city/synthetic-riverside")];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "dataset.json")));
  if (!found) throw new Error(`city fixture not found; looked in ${candidates.join(", ")}`);
  return found;
}
