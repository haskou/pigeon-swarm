# UI end-to-end validation

`npm run test:ui-e2e` starts the application image, registers a network on its
node and runs the pinned UI repository's Playwright specs against the image
origin, so the browser exercises the bundled UI and the real node together.

Requirements: Docker, `PIGEON_TEST_IMAGE` (image digest, as for the other
integration tests) and `PIGEON_UI_SOURCE`, a checkout of
`haskou/pigeon-swarm-ui` at `PIGEON_SWARM_UI_SHA` with `yarn install` and
`yarn playwright install chromium` already run.

Specs run (desktop Chromium): login methods, empty members column, remembered
session unlock, direct-message and profile sync between two identities, and
declining a ringing call when the callee leaves the page. The UI repository's
Vite-fixture specs (stale ICE, call recovery) stay in its own CI; the
external-account specs (visual audit, voice stability) are not run here.

CI runs this in the `ui-e2e` job of `Validate wrapper`.
