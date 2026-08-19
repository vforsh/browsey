# TODO

> All items must be numbered (e.g. `## 1. Title`) for easy referencing.

## 1. Copy button for absolute path in info modal

In the file/folder info modal, add a copy-to-clipboard icon button next to the absolute path text.

## 2. Delete and rename buttons in info modal

Add delete and rename buttons to the info modal footer for both files and folders. The buttons should be visible but disabled when the server is running in read-only mode.

## 3. Threads launched from the phone briefly error in the Codex iOS app

Known issue, deliberately not fixed. For as long as the launched turn is running, the Codex iOS app shows `Error loading messages: Codex server returned an error` on the new thread. It clears itself once the turn finishes.

Cause: every launch creates the thread in its own short-lived `codex app-server` (`startCodexThread`). That process owns the session, has remote control disabled, and does not register the rollout path in the shared state database while it holds it — Codex logs `state db missing rollout path for thread <id>`. The host actually serving the iOS app over remote control is a different process (the daemon or ChatGPT Desktop), so it has neither a live handle nor a resolvable path, and errors until our process exits.

The real fix is to create threads through the shared daemon instead, which would also drop the per-launch cold start. Blocked on version skew: `codex app-server daemon version` reports `appServerVersion 0.146.0` against `cliVersion 0.148.0`, and on 0.146.0 `codex app-server proxy` never answers `initialize` and the control socket closes on the handshake. Retry after a `codex app-server daemon restart` brings the daemon up to date.

Not viable: `remoteControl/enable` on our own process. It is accepted with `capabilities.experimentalApi`, then goes `connecting` → `errored`, because the host identity is already claimed by Desktop/the daemon.
