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
At that earlier stage there was no verified real-agent notification round trip.
The later ordinary-session experiments below supersede this result for their explicitly tested paths.

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
At this earlier revision an idle-session notification round trip was still unverified; see the later lifecycle experiments below.
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

## Mailbox and lifecycle revision

The current host remains WSL2 Ubuntu.
The authoritative UUID regression failed before the fix because currentIdentity required the host PID to be visible even for an exact registered UUID.
The duplicate SessionStart regression also failed before the fix: it changed generation and reset notification progress for an unchanged target.
Both passed after separating mailbox lookup from host delivery liveness and making identical registration idempotent.
Additional tests cover explicit notification retry, active-lease refusal, resumed-generation fencing, preserved receipts and unknown availability across PID namespaces.
The x86_64-linux flake checks passed with 29 tests on both pinned Node.js 24 and 26, plus Home Manager generation.
The running systemd activation harness was not rerun for this revision.

A real normally launched Codex exec process emitted its thread.started UUID.
The test harness registered that exact UUID and the process it had launched on the host, then seeded a synthetic message.
Inside workspace-write sandboxing, Codex ran whoami, peers, inbox, reply and ack without team/name flags and returned seatwire-codex-sandbox-reply.
The host observed the reply and the original message's read_at value.
This proves registered mailbox use from the sandbox, not automatic SessionStart registration.
The harness was separate from seatwire spawn and used no tmux.
Its state directory was a temporary directory under /tmp, which was also Codex's working directory (-C), so it was writable inside the sandbox.
It does not show access to the default `~/.local/state/seatwire`; see the phase 1 revision below.

A real normally launched Claude Code stream-json print process registered through an invocation-only SessionStart hook.
After the first model result, the harness kept stdin open and supplied no further user input.
The host sent a synthetic mailbox message and ran one notification worker tick.
Claude reacted to the native socket notification, replied seatwire-idle-reply and acknowledged the original message.
After ending the process, the harness resumed the exact same UUID and repeated the idle notification experiment.
Claude replied seatwire-resumed-reply and acknowledged the new message while retaining the two earlier messages.
The host read and acknowledged both replies.
These experiments used synthetic text only and did not send project source to the models.
They verify this Claude Code 2.1.314 stream-json lifecycle; interactive-terminal Claude behavior is not inferred from them.

Two Codex exec probes, with matcher="*" and with matcher omitted, produced SessionStart Completed but did not create the diagnostic hook output.
A normally launched Codex 0.165.0 interactive UI then explicitly displayed Hooks need review and stated that untrusted hooks would not run.
At that diagnostic stage no trust bypass or persisted trust change had been performed.
The current official documentation explicitly supports matcher="*" as match-all, so removing it is not treated as a fix.
See [Codex hooks](https://learn.chatgpt.com/docs/hooks) for per-definition trust and matcher semantics.
Normal-launch hook execution and tool-shell sandbox visibility must therefore be diagnosed separately.

After the user authorized continuation, the exact temporary registration/diagnostic hooks were reviewed and trusted through Codex's UI.
The temporary test directory was also trusted for its project-local hook; unrelated hooks were left unchanged.
The next launches reported Codex 0.166.0 and the current configured default model GPT-6.1-Sol.
No update command or model override was issued by this test.
The earlier GPT-6-Astra CLI attempt hit its usage limit; this was not an authentication failure.

Trusted hooks still produced no marker immediately after startup or /clear, with session flags, project hooks.json and --no-daemon.
After the first synthetic user input on 0.166.0 with --no-daemon, the project hook's entry marker and result file appeared, its seatwire exit status was zero, and the host observed the automatic mailbox registration.
The hook reported the host PID namespace.
Thus the earlier absence of an immediate marker did not prove that either source format or matcher was broken: hook execution was deferred until the first turn in this observed interactive path.
The test uses the exact lifecycle UUID, not a recent transcript inference.
The subsequent default-path resume experiment is recorded below.

After the first response, the host sent a synthetic message through seatwire and ran its notification worker once.
Codex's native queue triggered a new turn without a new terminal input, and the model read inbox, replied and acknowledged the message.
A second real Claude session in the same working directory used peers to discover this Codex and sent seatwire-pair-request.
Codex replied through seatwire, and the Claude socket notification triggered an inbox read.
In the first paired run Claude omitted ack despite reading the reply; the DB remained unread, so the harness correctly timed out.
The notification was revised to include an explicit handled-ID acknowledgement instruction, without automatically marking messages read.
The socket-payload assertion failed before this revision and passed afterward.
Repeating the paired run produced request ID 5 and reply ID 6 with non-null read_at values on both, without a new human input after the initial task.
This round trip used ordinary Codex with --no-daemon and ordinary Claude stream-json print mode; it used neither seatwire spawn nor tmux.

The Codex UI was then stopped, and message ID 7 was persisted while it was stopped.
The same UUID was resumed with the default Codex invocation, omitting --no-daemon.
After a short initial input and a host notification tick, Codex replied as ID 8 and acknowledged ID 7.
The host read and acknowledged ID 8.
Old messages and receipts were retained.
The registered process in this default path was the shared codex app-server, confirmed by reading only its executable and first subcommand.
After the UI exited the shared process remained alive, exposing a misleading online=true result.
A regression with the same process argv shape failed before the display fix and passed afterward.
Shared app-server targets now report online=null because process lifetime alone does not prove individual session availability.
The shared server was not killed, since it can serve other sessions.

Thirty host tests pass, including process, socket, queue, lease, duplicate-hook and namespace regressions.
Model notification behavior is evidence for the versions, configuration and runs described here, not a guarantee of model compliance or exactly-once handling.
Remaining unverified paths include native Windows, aarch64-linux, live managed-spawn round trips, simultaneous multiple UIs on one Codex thread, and immediate new-session startup with the shared daemon before its first turn.
Shared-server per-session active-state detection remains unavailable; status explicitly reports uncertainty.
The final x86_64-linux nix flake check passed with 30 tests on each pinned Node.js 24 and 26 runtime and successful Home Manager generation.
All test UIs and Claude print processes were closed, and the temporary project hook definition was removed.
Narrow trust records created by the authorized UI review were not manually rewritten; unrelated settings and the shared Codex server were left intact.

## Phase 1 revision (2026-11-01)

The host remains WSL2 Ubuntu with Node.js 24.18.0, Claude Code 2.1.316 and Codex CLI 0.166.0.
Claude Code had advanced from the 2.1.314 recorded above; this revision issued no update command.

### Claude session UUID

Verified on the host:

- An interactive Claude Code session ran in a dedicated tmux server, with Claude and Codex session variables removed from its launch environment.
- An invocation-only `--settings` SessionStart hook recorded its environment and input; persistent settings were not changed.
- For the startup, clear, compact and resume sources, the hook environment's `CLAUDE_CODE_SESSION_ID` equaled the input session_id.
- Bash-mode commands in that session observed `CLAUDE_CODE_SESSION_ID` as the current session before /clear, the new session after /clear, and the same session after /compact and `--resume`.
- After /clear, a model-invoked Bash tool call to `printenv CLAUDE_CODE_SESSION_ID` also returned the new UUID.
- `CLAUDE_SESSION_ID` was never set.
- With the actual seatwire SessionStart hook and a temporary state directory, `whoami` from Bash mode resolved the new session's automatic mailbox after /clear.
  The HEAD implementation (85dc36a) failed at the same point with `ambiguous session identity; select --team and --name`, because ancestor lookup matched both registrations of the same process.

Nested launches, as observed:

- A Claude Code started from this session's Bash tool inherited the parent's `CLAUDE_CODE_SESSION_ID` and a synthetic `CODEX_THREAD_ID`.
  It replaced `CLAUDE_CODE_SESSION_ID` with its own UUID in the hook and Bash environments at startup and after /clear, but passed the inherited `CODEX_THREAD_ID` through unchanged.
- A shell command run by `codex exec` started from this session's Bash tool saw its own `CODEX_THREAD_ID` and the parent's `CLAUDE_CODE_SESSION_ID`.
  `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were also present; only their presence was printed.
- `~/.codex/config.toml` contains no `shell_environment_policy` entry.
- A default interactive codex started the same way, served by the shared app-server daemon, saw its own `CODEX_THREAD_ID` and none of these Claude variables.
  The daemon process environment contains no `CLAUDE_*` names.
  Inheritance therefore depends on which process spawns the tool shell, not only on `shell_environment_policy`.

Commands now use `CLAUDE_CODE_SESSION_ID`, and still accept `CLAUDE_SESSION_ID` for compatibility.
Several distinct session UUIDs in one environment fail as ambiguous before any lookup, even when only the parent is registered.
The Claude hook path also compares `CLAUDE_CODE_SESSION_ID` with the input session_id.
Two regression tests failed before the change and passed after it.
One asserts the mailbox name resolved from `CLAUDE_CODE_SESSION_ID`, both in-process and through CLI whoami.
The other asserts the ambiguity error for an inherited parent UUID.
A naive variant that only added the variable resolved the nested case to the parent mailbox and failed the second test.
Tests and the ignored live harness now remove `CLAUDE_CODE_SESSION_ID` from child environments.

Not verified:

- Interactive `codex --no-daemon` started from Claude; it was not run because the Codex usage limit was nearly exhausted.
- Claude started from a real Codex tool shell; the inheritance of `CODEX_THREAD_ID` is inferred from the two observations above.
- The Codex hook environment.
- `actas --kind claude-code` from a real Claude Bash tool, which the hook-path change now permits when an ancestor and messaging socket are visible.
- Notification delivery to the new registration after /clear; the earlier registration of the same process also remains online.

### spawn test cleanup

The first real-tmux test registered despawn after the store cleanup hook and after an assertion.
With a temporary failure inserted, the HEAD version left one tmux server and its stand-in agent, which were then terminated by PID.
After despawn moved to the start of the single cleanup hook, temporary failures at two points left no tmux server.
The temporary failures were removed.
The other five spawn tests already ran despawn before closing the store.

### Codex executable for the notification service

`programs.seatwire.codexExecutable` accepts null or an absolute path string and sets `SEATWIRE_CODEX` for the service.
`tests/home-manager.sh` sets it and passed with an exact match for `Environment=SEATWIRE_CODEX=/opt/seatwire-test/bin/codex` in the activated unit.
With the option unset, the unit generated by the flake home-manager check equaled HEAD's except for the package store path in ExecStart.
That comparison was manual; automated content checks are tracked in issue #1.
A relative path fails the module assertion.
Running the service with a codex outside Nix, such as a Volta shim, was not tested.

### State directory and Codex sandbox

These runs used `codex sandbox` without a model, against a temporary state base under `~/.local/state`, outside every writable root.
In 0.166.0, `codex sandbox` requires `--permission-profile`; the built-in profiles are `:read-only`, `:workspace` and `:danger-full-access`.
Under `:workspace`, `~/.cache/uv` from the configured `sandbox_workspace_write.writable_roots` was not writable, and `-c sandbox_workspace_write.writable_roots=[...]` had no effect.
This command therefore does not reproduce the legacy writable roots of the user's Codex sessions.

With an existing DB, register, whoami, peers, inbox, history, send, reply, ack, retry, status and doctor all failed with `seatwire: unable to open database file`, and the DB was unchanged.
With the seatwire directory missing, they all failed with `seatwire: ENOENT: no such file or directory, mkdir '<base>/seatwire'`, whether or not the base existed.
A plain mkdir of the same path inside the sandbox reported EROFS; Node's recursive mkdirSync reports ENOENT instead.
Neither seatwire message identifies the sandbox write restriction.

A profile defined only with `-c`, extending `:workspace` and granting write on `<base>/seatwire`, made every command succeed except retry.
Retry failed with `no notification target; register the session first` because the test mailbox had no target.
The host read the messages sent from the sandbox, the acknowledgement and the new registration.
The README's TOML profile, placed in a temporary CODEX_HOME, gave the same results with both an absolute path and a `~/` path.
Without its write rule, the commands failed again.
A write rule for a missing seatwire directory did not let the sandbox create it.

Not verified: selection through `default_permissions` in a normal Codex session, and the legacy `writable_roots` method.
The temporary state base and CODEX_HOME directories were deleted, `~/.local/state/seatwire` was not created, and `~/.codex/config.toml` was not changed.

### Checks and cleanup

`node --test tests/*.test.mjs` passed 32 tests.
The x86_64-linux `nix flake check` passed with 32 tests on each pinned Node.js 24 and 26 runtime and successful Home Manager generation.
`bash tests/home-manager.sh` passed.
The running systemd activation harness was not rerun for this revision.
All test agents, tmux servers and temporary directories started by this revision were stopped or removed.
The shared Codex app-server and an unrelated Codex session were left running.
Transcripts of the test sessions remain in each agent's ordinary history.

## Daily-use revision (2026-11-02)

The host remains WSL2 Ubuntu with Node.js 24.18.0, Claude Code 2.1.316, Codex CLI 0.166.0 and tmux 3.8.
Every live run below used synthetic messages and a temporary state base, and told the model not to read, search or modify files.
The managed agents ran in this repository's directory, which both agents already trusted.

### Codex hook trust for managed spawn

Before the change, two Codex TUIs started with `-c` SessionStart definitions differing only in a marker both stopped at `Hooks need review` with `1 hook is new or changed`.
No trust was granted for these probes; they were stopped and no entry was added to `~/.codex/config.toml`.
Each spawn embedded the launch ID, team and name in its hook command, so every managed Codex launch would have needed a new review.

A regression test records the arguments and environment of four stand-in launches.
Before the change it failed on three separate assertions: the hook definitions differed, the spawner's `CLAUDE_CODE_SESSION_ID` reached the agent, and Codex lacked `--no-daemon`.
It passes after the change.

Live, after the change:

- The first managed Codex showed the review screen.
  The user reviewed the single seatwire definition in the Codex UI and trusted it.
  Codex recorded it under `/<session-flags>/config.toml:session_start:0:0`.
- That first launch was never registered.
  Codex's local log shows its boot-prompt turn at 10:05:36 and the trust write at 10:06:32, and no registration request reached the database.
  That the untrusted seatwire hook was skipped for this session is an inference; the log shows a hook started and completed at 10:05:36 without naming it, and an already trusted user hook exists.
- A second managed Codex under another name showed no review screen.
  `spawn --wait-ready` returned `ready` after host verification, and status reported `online: true`.
  The registration request carried the launch ID from the pane environment, so the `--no-daemon` hook inherited that environment.
- The host sent message 1 and ran `daemon --once`.
  Without further human input, Codex ran inbox, replied `seatwire-managed-codex-ok` as message 2 and acknowledged message 1.
- Forced despawn of both launches returned `stopped`.

The state base was under `/tmp`, which is writable in the workspace sandbox; the default `~/.local/state/seatwire` was not used.
Codex reported 1% of its weekly limit remaining, so no further Codex model turns were run.

### Managed Claude Code

- `spawn claude-code --wait-ready` returned `ready` in 0.47 s through the environment-only hook command.
- After a host notification, Claude read its inbox, replied `seatwire-managed-claude-ok` and acknowledged the message without further input.
- `despawn --force` followed immediately by `spawn --resume` of the same UUID failed with `agent name owned by live session`.
  The recorded Claude process had already exited when it was checked about a second later, and the same resume then succeeded.
- A message sent while the session was stopped reported `recipient not running` and stayed unread.
  After the resume, a notification produced the reply `seatwire-resumed-ok`, and the message was acknowledged.

The relaunch race is reproduced by a stand-in agent that exits 600 ms after SIGHUP.
An earlier version of the test passed before the fix because SIGHUP arrived before the stand-in installed its handler; it now waits for a readiness file.
The corrected test failed before the fix on both the reported state and the refused relaunch, and passes after it.
After the fix, forced despawn of the real Claude took 0.46 s and 1.06 s, returned `stopped`, and an immediate resume succeeded.

### Inherited environment

A Claude Code started inside a private tmux server from this session's Bash tool had its own `CLAUDE_CODE_SESSION_ID`, messaging socket and `CLAUDE_PID` in its SessionStart hook.
It still received a synthetic `CODEX_THREAD_ID` and an arbitrary marker variable from its parent.
The Bash tool environment of this session also contains `CLAUDECODE`, `CLAUDE_PID`, the messaging socket and the token, which tmux copies into a spawned pane.
Spawn now removes the variables listed in the README.
Whether a real Codex tool shell receives them was not observed again; the stand-in test checks the pane environment.

### Claude /clear

These runs loaded a seatwire plugin with `claude --plugin-dir`, which applies to one session and changes no settings, and used no model turn until the notification step.

- Before the change, the startup and post-/clear registrations had the same PID, socket path, socket inode and token, and peers listed both as online.
- After the change, peers listed only the post-/clear session, and status named it in the earlier registration's error.
- A synthetic notification to the post-/clear registration produced a reply and an acknowledgement.
  The previous revision listed this delivery as unverified.

A store test failed before the change on the duplicated peer and passes after it; it also checks that the earlier mailbox keeps its unread message and is notified again after re-registration.
Switching sessions with `/resume` inside a running Claude process was not exercised.

### Claude plugin through Home Manager

The plugin built by the module passed `claude plugin validate` without manifest warnings.
The same command's catalog-submission checks reported a missing README, which does not affect local loading.
`claude --plugin-dir` with the built store directory and `XDG_STATE_HOME` pointed at a temporary base registered a normally started Claude session automatically.
Loading from `~/.claude/skills/seatwire` itself was not exercised, because it would change this user's home.
That path relies on the official plugin-loading documentation; this session also lists the skills of the user's existing skills-directory plugin under its plugin namespace.

`tests/home-manager.sh` now also activates the plugin configuration, checks that its files are regular files and its hook command is executable, checks that settings.json receives no hook, rejects enabling both Claude options, and removes the plugin on disable.
It passed, and the flake checks build the plugin configuration as well.

### Other observations

- In the real `:workspace` sandbox, a missing state directory now fails with `cannot create state directory <path>` and an existing database with `cannot write state database <path>`.
  Both name the directory and state that seatwire does not change sandbox settings; the database was unchanged.
- `send` to the managed Claude reported `pending`; the managed Codex's reply to the offline host mailbox reported `none`.
- With only `HOME` and the service's minimal `PATH`, the Volta shim `~/.volta/bin/codex queue --help` exited 0.
  Running the notification service with it was not tested.
- The local agmsg checkout was compared against `318b082b86508dbbc422fe709b46cac2fc99e25c`; the vendored I/O modules are unchanged since the recorded revision.

### Checks and cleanup

`node --test tests/*.test.mjs` passed 37 tests.
The x86_64-linux `nix flake check` passed with 37 tests on each pinned Node.js 24 and 26 runtime and both Home Manager configurations.
`bash tests/home-manager.sh` and `bash tests/home-manager-systemd.sh` passed.
All agents and tmux servers started by this revision were stopped, and their socket files were removed.
Two socket files dated 2026-10-30 remain in `$XDG_RUNTIME_DIR/seatwire-tmux` with no server; they were not created by this revision.
The trust entry the user created for the test hook definition remains in `~/.codex/config.toml`.

Not verified in this revision:

- A real `home-manager switch` of this user's configuration with the module.
- A managed Codex resume, /clear in Codex, and a managed Codex whose state base is the default directory inside its sandbox.
- A Codex `shell_environment_policy` that filters the hook environment; such a filter would drop the launch ID, and the launch would stay pending.
- Whether one Codex review stays valid across a seatwire update; a changed store path is expected to need a new review.
- The systemd service delivering to real agents; these runs invoked `daemon --once` by hand.
