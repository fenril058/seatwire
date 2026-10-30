# Validation record

## Environment

The test host is Linux with Node.js 24.18.0, Nix 2.34.8, Codex CLI 0.165.0 and Claude Code 2.1.312.
Nix inputs are pinned in flake.lock.
Tests ran on x86_64-linux; aarch64-linux and WSL have not been exercised.

## Automated evidence

The initial implementation passed 12 tests; the managed-registration revision passes 19 tests.
Coverage includes offline round trips, explicit read receipts, namespace isolation, 12 concurrent CLI writers, private permissions, symlink rejection, future-schema refusal, live-owner conflicts, lease recovery and generation fencing.
A real Unix socket server observed the auth line and inbox instruction without the message body, while the DB stayed unread.
The server is a test fixture, not Claude Code.
A real tmux server launched a stand-in executable; tests verified literal boot prompt and resume arguments, interrupt receipt, foreign-name refusal, socket replacement refusal and force termination.
The executable is a fixture, not Codex.
A separate subprocess test checks the queue CLI contract, mismatched thread output and timeout.

Three regression tests failed before their fixes and passed afterward: different sessions sharing a PID could replace an owner, normal despawn used an invalid pane target, and a bare `codex` argv[0] could be skipped in favor of a more distant ancestor.
The new process test directly asserts that the identified PID is the nearest Codex ancestor.

`nix build` and `nix flake check` passed.
The checks include the package tests and Home Manager activation package evaluation/build.
`bash tests/home-manager.sh` passed actual activation in a fresh temporary HOME, repeated activation, disable/removal, retained DB and re-enable/readback.
The executable used during activation lives in the read-only Nix store.
The isolated activation deliberately disables systemd service starts; actual running-unit stop/reload is not established by this test.

## Managed-registration revision

The spawn lock regression failed before the fix with SQLite reporting a locked database and passed after moving tmux outside the write transaction.
The test directly observes a separate startup process writing the reserved agent row before tmux returns.
A child-state regression likewise failed with the real user state directory instead of the requested test directory, then passed after forwarding the selected state base.

Managed hook submission now records the exact SessionStart UUID without consulting ancestors.
A fixture executes the actual generated hook command, and CLI spawn --wait-ready returns ready after host verification.
Tests reject replaced launch IDs, different session IDs and replaced sockets without publishing a target or killing the unrelated server.
They also cover duplicate registration without resetting generation, readiness timeout with a surviving process, abandoned-launch cleanup and schema 1 data preservation during migration to schema 2.
These tests use stand-in agents, not live Codex or Claude sessions.

## Live agents

Both real Codex and Claude Code were launched by `seatwire spawn` in dedicated tmux servers.
After explicit user approval, the original seatwire hook and workspace trust prompts were accepted.
Claude's SessionStart hook registered a live process and socket.
Codex sent `codex-live-hello` as message ID 1 using an explicit test XDG_STATE_HOME.
The host worker sent a native socket notification; Claude reacted without a new user prompt, read its inbox, acknowledged ID 1 and sent the reply as ID 2.
The reply remains in Codex's inbox, unread.
Sanitized DB evidence is recorded in [live-validation.json](live-validation.json).

Codex's offline mailbox existed, but live notification registration did not succeed.
Its sandboxed `actas` command could not identify a host ancestor, even after fixing the separate bare argv[0] bug.
The original SessionStart hook was shown as active and trusted, but no target was registered.
Omitting `matcher="*"` was prepared as a diagnostic comparison; it was not established to fix the failure.
Automatic approval review rejected trusting the changed definition, and the user declined that additional trust change and ended live validation.
The matcher change was reverted.
The cause of the Codex SessionStart failure remains unresolved; do not treat the matcher hypothesis as a confirmed diagnosis.
`codex queue --help` confirms the CLI capability, not live delivery.
There is no verified real-agent notification round trip, so P0 is not complete.

The notification worker also ran as the dedicated transient user systemd unit `seatwire-validation-20261029.service` and was observed active.
On cleanup, it was stopped and collected: LoadState=not-found, ActiveState=inactive.
This verifies actual service start/stop, but not a Home Manager-driven stop of a running unit.
Both managed agent sessions and the additional test worker were stopped after the user ended validation.
Test DB data is retained under the ignored `.dev/live-state/` directory; it can include session credentials and must not be published.
Previously approved trust decisions were not removed or broadened during cleanup.

## Reproduction with approved agent trust

1. Build and activate the module, enable the chosen hook integration, and review the hook in each agent's own UI.
2. Create offline mailboxes `claude` and `codex` in a test team using `register`.
3. Start the host daemon and use spawn with --wait-ready and a sufficient --ready-timeout; review each exact generated hook in the agent UI from another terminal.
   Manual launch with explicit SEATWIRE_TEAM and SEATWIRE_NAME still uses the ancestor-dependent registration path.
4. Confirm `status` shows both online without errors; do not infer registration from process startup alone.
5. In Claude, send a unique marker to Codex using the CLI.
6. Without entering another user prompt into Codex, observe whether the notification causes an inbox read, then acknowledge the exact ID and reply with a different marker.
7. Observe Claude's reaction without a new user prompt; verify both markers in history and unread counts after ack.
8. Stop the receiver, send another marker, verify offline retention, then resume with the exact UUID and verify fresh registration and delivery.
9. Repeat with simultaneous daemon invocations, a removed socket, and an unsupported Codex queue command; messages must remain readable.
10. On a disposable Linux user or VM with systemd --user, activate, disable and reactivate Home Manager; inspect `systemctl --user status seatwire` and verify no active unit remains after disable while the database remains.

Never count transport write success or fixture tests as a completed live-agent round trip.

## Remaining limitations

Claude socket wire format and Codex queue output are version-dependent internal contracts inherited from the pinned agmsg adapters.
There is no automatic fallback to terminal prompt injection.
Notification attempts are serialized with bounded leases but cannot provide exactly-once delivery across ambiguous external I/O failures.
A paused worker exceeding its lease can race a later worker; no exactly-once guarantee is made.
Non-managed registration still requires a recognizable local agent ancestor and authoritative UUID.
Managed spawn uses host-verified launch metadata instead; that revision has not yet been verified with live model sessions.
Remote/shared-server arrangements may be rejected.
Resuming and Claude permission-mode behavior need live-agent validation.
Normal despawn requests interruption, not confirmed graceful exit.
There is no agent process restart supervisor, remote messaging, or advanced role orchestration.
