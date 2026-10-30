# Validation record

Source-candidate checks run on Windows, 2026-10-29, using Node.js 24.14.0 and npm 11.9.0. These results describe this local source candidate, not a deployed service.

| Check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | Passed | Mobile and server TypeScript |
| `npm test` | Passed: 233 tests, 0 failures | 110 server tests plus 123 app/launcher/audio tests; mocked upstream services and local test servers |
| `npm run demo:smoke` | Passed | Real localhost health request and complete WebSocket preset answer; live capabilities disabled |
| `npm run build` | Passed | Expo web export and Node server compilation; public PCM worklet present |
| Demo web bundle with `EXPO_PUBLIC_DEMO_ONLY=1` | Passed | Compilation of isolated-demo client; this is not an interactive browser acceptance test |
| Optional Python offline suite | Incomplete | Bundled test runtime lacked `websockets`; 40 tests passed, one module import failed. No speech models were loaded |
| Dependency vulnerability audit | Incomplete | `npm audit --omit=dev --json` could not connect to the registry advisory endpoint before TLS establishment. No valid vulnerability result was obtained |

The normal Expo export exited successfully but reported that Expo had to force its own process to exit. The emitted HTML, JavaScript and PCM worklet exist. This warning has not been investigated as a packaging issue.

## Public preview checks — 2026-10-30

After compatible dependency updates and adding the MIT license, `npm run typecheck`, all 233 Node tests, `npm run demo:smoke` and `npm run build` passed again on Windows. The Expo export still emitted its force-exit warning after producing the output. The Web development command now binds to localhost. See [dependency audit](dependency-audit.md) for the successful initial advisory report, compatible updates, known remaining Expo tooling findings and the failed post-update local audit requests. CI's audit-report step is informational and does not make a green build a clean security audit.

Initial Linux CI runs exposed excessive memory use while the development loader loaded PDF worker code: source mode crossed the 256 MiB RSS limit during `getInfo`, while the [same run's compiled server suite passed all 14 resume tests](https://github.com/JadoreSamoyed/offerpaw/actions/runs/41000705461). PDF.js now receives a file URL for its installed, version-matched minified worker, avoiding the extra embedded base64 module URL. The parser's heap, RSS, timeout and upload limits are unchanged. Diagnostics retain only bounded memory measurements and named execution stages for direct callers; HTTP responses exclude those fields and all parser output remains discarded. Regression coverage includes an empty parser cache, compressed-document rejection, normal PDF extraction after a rejected upload, and diagnostic privacy. CI checks both source execution and the compiled server's resume suite. Use the [Actions runs](https://github.com/JadoreSamoyed/offerpaw/actions/workflows/ci-release.yml) for the actual Linux result of each commit. The release job requires its own tag's installation, type, test, demo and build checks to pass.

## OfferPaw naming update — 2026-10-29

The user selected Offer汪, written OfferPaw in English. Display text, permission copy, SVG titles, the Expo slug and both READMEs were updated. `npm run typecheck` and `npm run build -w apps/mobile` passed after this update. Earlier test results above are retained from the functional candidate checks; the test suite was not rerun for these naming changes. Native installation identifiers, the URL scheme and storage keys retain their existing values for compatibility. No new mascot asset or remote release was created.

## Demo isolation regression coverage

`apps/mobile/src/demo-storage.test.cjs` preloads fabricated data from a previous installation: remote URL, resume/JD, history, token and voice profile. On web, Android and iOS, a demo-only bundle makes no calls to those storage APIs. Save and clear operations do not mutate the original data. The demo profile and history begin empty, and server URLs stay on loopback even when supplied settings contain another address.

`assistant.test.cjs` checks that requesting live mode in a demo-only bundle still starts a preset session without microphone capture, enrollment, token or voice-profile transmission. `resume-upload.test.cjs` checks that demo resume extraction remains on loopback and omits authorization. `scripts/demo.test.mjs` covers inherited provider credentials and Windows environment-name casing.

## Export inspection

Only allowlisted source, lockfiles, generic icons, fictional examples and configuration templates were included. Existing production configuration, Git history, recordings, screenshots, deployment files and installers were excluded. A limited scan found no common credential prefixes, private-key blocks, known excluded company keywords or personal filesystem paths in the shipped source. This is a bounded inspection, not a guarantee that every possible secret pattern or dependency issue has been ruled out.

The original project source is now distributed under the root MIT LICENSE for the public preview. Existing module-level metadata is preserved. Dependencies retain their own licenses. Optional model assets are not bundled and need a separate redistribution-license inventory before any bundled distribution.

## Not validated in this export

- Interactive browser use or a clean network dependency installation on another machine.
- Android/iOS device installation, microphone permissions, native recording or interruption behavior.
- Real ASR recognition, real speaker accuracy, live LLM requests, production availability or end-to-end latency.
- Current dependency vulnerability status, model redistribution rights or a production deployment security review.

Use the preset demo and fictional data for review. These checks do not establish production readiness.
