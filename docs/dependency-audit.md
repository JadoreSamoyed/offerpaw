# Dependency audit — 2026-10-30

This source preview does not claim a clean dependency audit. GitHub Actions reports `npm audit --omit=dev` separately from the blocking installation, type, test, demo and build checks. The advisory-report step is informational while the documented upstream tooling findings remain unresolved; inspect its output even when CI succeeds.

## What was checked and changed

- An initial successful `npm audit --omit=dev` across both workspaces reported 12 affected package entries (5 low, 3 moderate, 4 high; no critical). Counts include dependency-chain propagation and are not counts of distinct vulnerabilities.
- Compatible updates now lock `node-forge` to 1.4.2 and `@expo/config-plugins` to 58.0.11, with `xcode` 4.0.0. This removes the earlier `node-forge` 1.4.0 and `xcode`/`uuid` 7 dependency path. See the [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- The server declares Zod >=4.6.7 within major 4 and locks 4.6.7, above the 4.6.6 fix listed in the [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- The post-update local audit requests failed with registry connection/TLS errors, so no post-update zero-vulnerability count is asserted. The CI audit output provides a separate fresh report when the registry is reachable.
- The first [Linux CI audit](https://github.com/JadoreSamoyed/offerpaw/actions/runs/40999576571) subsequently reached the registry and reported 8 affected package entries (5 low, 3 high), all from the remaining Expo tooling paths below. This reduced the initial report but did not eliminate it.

## Known remaining development-tool dependencies

- Expo CLI 58.1.13 depends on Zod 3.25.76 for DevTools/MCP plugin schemas. The advisory flags versions below 4.6.6. Forcing this dependency to major 4 would violate Expo's declared range and has not been validated.
- `@expo/config` uses `deepmerge` 4.3.1 to merge project configuration. The [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) listed no patched version at review time.

These paths belong to the Expo development/build tooling; the application's Node server resolves its own Zod 4.6.7. This distinction is not a blanket assertion that the tooling findings cannot be exploited. The Web development command binds to localhost; use trusted project configuration and development plugins. Local binding reduces exposure but does not fix these dependencies.

Model weights and installed dependency folders are not included in the source archive. Native builds, live ASR/LLM operation and production deployment remain outside this preview's validation scope.
