# Validation record

## Environment

The current test host is Ubuntu 24.04.5 LTS on WSL2, with kernel `6.18.54.1-microsoft-standard-WSL2`.
This was confirmed from `/etc/os-release` and `/proc/sys/kernel/osrelease` after the ordinary-session revision.
The recorded tool versions are Node.js 24.18.0, Nix 2.34.8, Codex CLI 0.165.0 and Claude Code 2.1.312.
Nix inputs are pinned in flake.lock.
The ordinary-session revision tests ran on x86_64-linux under WSL2.
Aarch64-linux and native Windows have not been exercised.

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
The isolated activation deliberately disables systemd service starts; the separate running-service test described below covers activation-driven stop/reload.

## Managed-registration revision

The spawn lock regression failed before the fix with SQLite reporting a locked database and passed after moving tmux outside the write transaction.
The test directly observes a separate startup process writing the reserved agent row before tmux returns.
A child-state regression likewise failed with the real user state directory instead of the requested test directory, then passed after forwarding the selected state base.

Managed hook submission now records the exact SessionStart UUID without consulting ancestors.
A fixture executes the actual generated hook command, and CLI spawn --wait-ready returns ready after host verification.
Tests reject replaced launch IDs, different session IDs and replaced sockets without publishing a target or killing the unrelated server.
They also cover duplicate registration without resetting generation, readiness timeout with a surviving process, abandoned-launch cleanup and schema 1 data preservation during migration to schema 2.
These tests use stand-in agents, not live Codex or Claude sessions.

`bash tests/home-manager-systemd.sh` passed with the host's actual systemd user manager.
It uses a temporary HOME and a unique unit name with the module's generated service definition.
The harness copies the generated unit unchanged and creates a runtime-only link so the existing manager can discover the isolated configuration.
Home Manager activation itself starts and stops the worker with startServices enabled.
Assertions check repeated activation, stopped worker PID on disable, removed managed unit path, retained message data, surviving managed agent, successful re-enable/readback and a second stop.
The harness removes its runtime link and stops its stand-in agent on exit.
This records the module's service lifecycle on the test host.
It does not establish a full desktop configuration migration.

GitHub Actions now runs flake checks, isolated activation and the running-service lifecycle test on Ubuntu 24.04.
The workflow is configured locally; no successful GitHub-hosted run is claimed before it is pushed and executed.
The workflow also passes actionlint from the pinned nixpkgs input.
No live model credentials or automatic hook trust are used in CI.

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

## Ordinary-session revision (2026-10-31)

The host suite passed 24 tests on Node.js 24.18.0 after adding automatic session registration, discovery and reply.
New tests cover unnamed SessionStart in a stand-in Codex process, identity ambiguity, expired sessions, project filtering, credential omission and replies restricted to the original recipient.
The notification state-directory assertion failed against the old implementation and passed after including the explicit state base in the inbox instruction.
The assertion observes the actual Unix socket payload.

A normally launched real Claude Code print session used an invocation-only SessionStart hook and an isolated temporary database.
No seatwire spawn, team environment or assigned name was used for Claude.
Astra sent a synthetic message to the automatically derived mailbox; Claude ran peers, inbox, reply and ack without team/name flags.
The host read the reply body `seatwire-claude-received` and acknowledged it.
Both messages were retained and explicitly read.
This validates model-driven mailbox use, not an idle-session notification round trip.
The session exited after its print request.
Claude noted that peers did not show Astra; Astra was intentionally an offline mailbox, so this matched the live-only filter.
The hook introduction now mentions peers --all for this case.

Automatic approval review rejected the initial source-review experiment because it could send private code to an external model without specific data-transfer approval.
The successful experiment instead allowed only CLI access to synthetic messages and instructed Claude not to read project sources.
No persistent agent settings or hook trust decisions were changed.

The fixed nixpkgs input supplies Node.js 24.21.0 and 26.12.1.
The Node.js 26 compatibility run exposed a test-harness issue: replacing process.env with a plain object did not update the environment implicitly inherited by child processes.
A separate probe observed an empty inherited variable versus the expected value when passing env explicitly.
Tests now restore environment entries in place.
The default runtime remains Node.js 24; adopting Node.js 26 LTS requires updating the pin beyond 26.12.1.
The official release table lists Node.js 26 as LTS: https://nodejs.org/en/about/previous-releases.

The automated tests, isolated Home Manager activation and real Claude mailbox exchange in this revision ran on WSL2 Ubuntu.
Native Windows execution remains unverified.
An idle-session notification round trip remains unverified on this WSL2 host.
Non-managed registration still needs access to an authoritative lifecycle UUID and a verifiable host ancestor.
Sessions whose sandbox hides host ancestry cannot register through actas; discovery never guesses an alternative process.
Claude /clear can leave multiple same-process registrations; automatic ancestor-only lookup then requires explicit identity selection.
The new discovery layer does not remove this remaining lifecycle limitation.

The ordinary Codex exec experiment ran on Codex CLI 0.165.0 with workspace-write sandboxing.
Its actas command failed with `cannot identify agent ancestor; register from the agent lifecycle hook`.
It stopped without sending, changing permissions or guessing a session.
This confirms that the non-managed sandbox registration gap remains.

The x86_64-linux flake checks passed on Node.js 24.21.0 and 26.12.1, 24 tests each, including Home Manager generation.
The isolated Home Manager activation, disable, DB retention and re-enable test also passed.
That test revealed its absolute-path flake source included ignored .dev data in the local Nix store.
Both Home Manager harnesses now use git+file sources, and assert that .dev is excluded before building.
No source was uploaded to a remote cache by these commands.
The corrected isolated Home Manager test passed again with the source-exclusion assertion enabled.
The specific store source copied by the earlier run was deleted; the original local DB was retained.
The running-systemd harness was updated to the same source selection but was not rerun in this revision.
