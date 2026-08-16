# Provider fixtures

All provider fixtures are offline, sanitized, and safe to commit. No automated test launches an
installed provider executable.

- `captured/` contains reduced, version-labelled shapes from the two discovery invocations made
  before implementation. Session IDs, paths, timestamps, content, and usage values are fake.
- `synthetic/` contains explicitly synthetic schema variants needed for defensive parser coverage.
- `mock-provider.js` is the deterministic executable used by process and adapter tests.

The literal IDs beginning with `fixture-`, the `X:\fixture\workspace` path, and small usage counts
are placeholders rather than observed account or workspace data.
