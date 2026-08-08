// CLI wrapper so build.sh delegates owner-origin validation to the same
// resolveOwnerOrigin() used at Quartz build time instead of duplicating the
// private-range arithmetic in shell. Prints the canonical origin or exits 2.
import { resolveOwnerOrigin } from "./components/editLink"

try {
  process.stdout.write(`${resolveOwnerOrigin(process.argv[2])}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
