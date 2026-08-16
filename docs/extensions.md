# Extensions and provider integration

Claudex publishes a small programmatic surface for orchestration and provider integration on Node 24+.

Supported imports:

- `@jaddid911/claudex/config`
  - `createDefaultConfig(options?)`
  - `createProviderEnvironment(source?, passThrough?)`
  - `getConfigPath(options?)`
  - `getProjectConfigPath(workspace)`
  - `loadEffectiveConfig(options?)`
  - `loadConfig(options?)`
  - `loadProjectConfig(options?)`
  - `mergeProjectConfig(baseConfig, projectConfig, options?)`
  - `normalizeConfig(input?, options?)`
  - `normalizeProjectConfig(input?)`
  - `saveConfig(config, options?)`
- `@jaddid911/claudex/orchestrator`
  - `createRoomApplication(options?)`
  - `RoomApplication`
  - `isClarificationRequest(value)`
  - `parseClarificationRequest(value)`
- `@jaddid911/claudex/providers`
  - `BaseProvider`
  - `ClaudeProvider`
  - `CodexProvider`
  - `MockProvider`
  - `PROVIDER_STATUSES`
  - `createClaudeParserState()`
  - `createClaudeProvider(options?)`
  - `createCodexProvider(options?)`
  - `createMockProvider(options?)`
  - `isCapacityMessage(value)`
  - `normalizeClaudeEvent(rawEvent, state?)`
  - `normalizeCodexEvent(rawEvent)`
  - `parseCodexCapabilities(helpText, helpStatus?)`
  - `sanitizeProviderText(value, options?)`

Example:

```js
import { createRoomApplication } from '@jaddid911/claudex/orchestrator';
import { createClaudeProvider, createCodexProvider } from '@jaddid911/claudex/providers';

const app = createRoomApplication({
  workspace: process.cwd(),
  providers: {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  },
});
```

Safe limitations:

- There is no root `@jaddid911/claudex` import. Only the subpaths above are supported.
- Files under `src/` that are not re-exported through those subpaths remain internal and may change without notice.
- Provider `detect()` reports executable and capability availability plus a best-effort local CLI version/auth/trust probe. `unknown` and `not-verified` are intentionally non-authoritative; if you need a true live-session check, run a read-only `runTurn({ access: 'read' })`.
- Read-only integrations should prefer provider `runTurn(..., { access: 'read' })` to avoid workspace writes.
- The published package keeps the `claudex` CLI binary and the documented extension subpaths; tests, workflow files, OMX state, and other repo-only assets are intentionally excluded from the tarball.
