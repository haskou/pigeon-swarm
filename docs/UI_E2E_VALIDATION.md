# UI end-to-end validation

`npm run test:ui-e2e` starts the application image, registers a network on its
node and runs the pinned UI repository's Playwright specs against the image
origin, so the browser exercises the bundled UI and the real node together.

Requirements: Docker, `PIGEON_TEST_IMAGE` (image digest, as for the other
integration tests) and `PIGEON_UI_SOURCE`, a checkout of
`haskou/pigeon-swarm-ui` at `PIGEON_SWARM_UI_SHA` with `yarn install` and
`yarn playwright install chromium firefox` already run.

Specs run: on desktop-chromium, login methods, empty members column,
direct-message sync and peer banner updates across devices, and declining a
ringing call when the callee leaves the page. On mobile-chromium and
desktop-firefox, only login methods runs, because the empty members column spec
skips itself outside desktop-chromium. The UI repository's Vite-fixture specs
(stale ICE, call recovery) stay in its own CI; the external-account specs
(visual audit, voice stability) are not run here.

After the specs, the same run registers two identities on the image's node,
sends one direct message and counts mailbox traffic only: the sender's append,
the recipient's read with envelopes, and the acknowledgement. It then clears the
recipient's saved mailbox state, sends a second message with the recipient's
legacy copy withheld, and requires that message to render from the mailbox
alone, with envelope and acknowledgement counts increasing. The specs alone
cannot show this path, because a failed mailbox append is silent while the
legacy copy still delivers. With the legacy copy still withheld, the sender
then replies to and reacts to that message, and edits and deletes its own
mailbox-only message, since the UI lets only a message's author edit or delete
it. Each action must reach the recipient from the mailbox alone, with envelope,
acknowledgement and withheld-frame counts increasing. The server's POST and PUT
responses must echo `replyToMessageId` and `targetMessageId`, so the mailbox
record is built from the ids the server recorded.

It then pairs a second device of the recipient's identity through the UI and
sends a third message. The second device's envelope reads are held until the
first device's device reader acknowledges that message, and the second device
must then render it from the mailbox alone. Every mailbox read by the second
device must use a device reader token, not the inbox root token. Acknowledgements
are logged by token class. In a passing CI run the second device made two reads,
both with device reader tokens, and two acknowledgements, one with a device reader
token and one with the inbox root token (the root mirror). The hold opened with no
read held (`heldReads` 0), so that run did not show the hold delaying any read.
The check logs counts only, never message text, ids or envelope bodies. Per-action
counts of the mailbox-only steps are logged under `mailboxActions`.

The forgotten-device spec pairs a second device of an identity through the UI,
signs that device out and signs back in with its password, and requires the
second device to list both devices. A device-proof request the second device
signed is accepted before the removal. The first device then removes the second
device's access from its manage-devices dialog and must list only itself. The
second device's fresh device-proof request, sent after the removal and inside
the node's 30 second clock-skew window, is refused with status 401 and code
401020, so only the removal can refuse it. The check logs status codes and row
counts only.

CI runs this in the `ui-e2e` job of `Validate wrapper`.
