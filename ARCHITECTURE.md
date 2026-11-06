# seatwire architecture

## Decision: JavaScript on Node.js 24

Use JavaScript ESM and the built-in `node:sqlite` API.
No npm dependencies or runtime installers are required.
The pinned Nix Node runtime supplies SQLite; the package includes tmux for optional process management.

| Option | Reuse / API changes | Packaging / testing | Maintenance cost |
| --- | --- | --- | --- |
| JavaScript | Direct reuse of agmsg notification I/O | One runtime, native test runner | Lowest initial complexity; runtime pinned |
| Rust + JavaScript | Direct I/O reuse | Two build/runtime interfaces | Typed core, but IPC and two languages |
| Go + JavaScript | Direct I/O reuse | SQLite binding plus Node | Same two-language burden |
| Rust or Go only | Port protocol and cancellation logic | Single core executable | More initial work and upstream drift |
| Shell | Easy hooks | External SQLite and process tools | Transactions and structured state become fragile |

## Boundaries

`store.mjs` owns messages, read receipts, registrations and notification leases.
`identity.mjs` validates Linux process start times and boot identity.
`notify.mjs` owns retry policy and calls vendored I/O adapters.
`cli.mjs` exposes explicit CLI operations and lifecycle hook registration.
`spawn.mjs` owns launch reservations and tmux identity checks.
`registration.mjs` accepts managed hook requests and verifies them on the host.
Nix owns executable code, skills, hooks configuration fragments and the user service.
No installer modifies agent configuration.

Persistent state resides in `$XDG_STATE_HOME/seatwire`, defaulting to `~/.local/state/seatwire`.
SQLite uses WAL, busy timeout and immediate transactions.
Schema version 2 is created transactionally; version 1 is migrated additively, and unknown versions fail before journal changes.
Rollbacks never downgrade data automatically.
Directories are private, and database/token files are private to the current Unix user.
The threat model trusts other processes running as the same Unix user.

## Session and notification identity

Session IDs come only from lifecycle input or explicit agent environment, never newest-file inference.
A registration includes a process start witness and Linux boot ID.
A live different owner cannot replace a registration.
Claude sockets additionally require ownership and an unchanged inode.
Codex uses an exact thread UUID and absolute profile path.
No bridge or rollout guessing is implemented.

The durable message commit precedes notification.
Notifications contain only an inbox instruction.
Notification progress is distinct from explicit read receipts.
Transactional leases serialize workers and expire after crashes; session generations fence stale updates.
Transport completion is not proof that an agent read a message.
An ambiguous transport failure may repeat a nudge; exactly-once external delivery is not claimed.

## Upstream findings

agmsg commit `7082fc03f3a6e3f8d5375bb07bec6b39a674a79b` separates queue I/O from its channel state machines.
Its channel state machines depend on install.db, role-session files, bridge state and operation generations.
Its SessionStart scripts capture profile/thread or socket/token and refresh resumed sessions.
Its spawn implementation also depends on placement drivers, actas locks and installation state.
seatwire reuses only the two self-contained I/O modules and implements its own smaller state model.
Teams and named agents replace actas role files.
Names may be explicitly selected or derived from an authoritative SessionStart UUID.

cclens commit `14c611720a98a4fbec2b576fe878175031ef651d` uses crane, rust-overlay and bundled rusqlite.
Its core, adapters and SQLite store are separated, with inline Rust unit tests.
The initial commit defaults the CLI to a relative `cclens.db`; its plugin instructions explicitly select XDG cache.
It uses schema creation/additive column handling, not a versioned persistent-message migration contract.
seatwire adopts separation of responsibilities, but deliberately uses durable state and strict schema versioning.

## Integration scope

Skills provide the CLI workflow for both agents.
Hooks register session metadata; Home Manager manages only dedicated skill paths and a separate hook fragment by default.
Agent settings integration is opt-in through existing Home Manager options after validating the pinned module definitions.
Sandbox access to the state directory must be explicitly configured by the user.
The host notification service performs socket/queue operations outside agent sandboxes.

Internal notifications are version-dependent: local probes found Codex CLI 0.165.0 with `queue` and Claude Code 2.1.312.
Upstream reports Claude socket support from 2.1.302; no universal version compatibility is claimed.
Official Codex plugin documentation also requires trust review for unmanaged hooks: https://developers.openai.com/plugins/build/plugins.

A later local checkout update to cclens `39cadc2d22522c09a99010659155393361780695` was also inspected.
That version uses XDG state, private permissions, transactional additive schema reconciliation and rejection of newer user_version values.
The earlier cache observation applies to the initial plugin instructions; the CLI itself used a relative path.

## Managed processes

Each explicit spawn creates a dedicated tmux server at a random private socket path.
Its boot/process witness and socket inode are stored in SQLite.
Despawn verifies both before acting; normal mode requests an interrupt and reports that exit remains unconfirmed.
Force mode kills only that managed session.
Disabling Home Manager stops the notification worker but never invokes despawn.
SessionStart hook trust remains the agent's responsibility and is never bypassed.

## Revision: host-side managed registration

Spawn reserves a unique launch ID and commits before invoking tmux.
The host records both the dedicated tmux server and the pane's agent process with boot/start witnesses.
The pane command uses exec so an exited agent does not leave an idle shell falsely alive.
The SessionStart hook submits its authoritative session ID under that exact launch ID into a private SQLite request table.
It does not need to inspect host ancestors.
The host notification worker verifies the unchanged launch record, server marker, process witnesses and Claude socket ownership before publishing a notification target.
The Codex profile is captured at launch rather than guessed from the sandbox's filtered environment.
No newest-transcript inference, automatic hook trust or sandbox bypass is introduced.

Schema 2 adds the request table transactionally and preserves version 1 messages and launch records.
Version 1 binaries reject schema 2 on rollback.
The request and registration writes are fenced by launch ID; an old hook cannot claim a replacement launch.
Within one live launch, changing to a different session UUID is rejected until a new managed launch is created.
An optional wait-ready waits for host-verified registration, not proof of model consumption.

The non-managed hook and actas path still require a recognizable ancestor; arbitrary pre-existing sandboxed sessions are not attached by guessing a process.
The managed path relies on the agent's trusted SessionStart input for the session UUID and on host-owned launch metadata for process lifetime.
The launch ID is a generation marker, not a secret or a boundary against malicious code running as the same Unix user.
The database must still be writable from the hook's filesystem sandbox.
Registration errors remain visible in status; no automatic hook trust is performed.
The runtime dependency set remains Node.js and, for spawn, tmux; no helper server framework or new package dependency is introduced.

## Ordinary-session discovery

`context.mjs` resolves authoritative session metadata and delegates process identity to `identity.mjs`.
SessionStart without an assigned role registers KIND-UUID in the default team.
Commands resolve the durable mailbox using an authoritative environment UUID, falling back to a verified live ancestor only when no UUID was supplied.
An exact UUID does not require the host process to be visible from the caller namespace.
Ambiguous and unknown UUIDs fail instead of selecting the latest session.
Peers expose project, kind, name and liveness, never transport credentials.
Project matching uses canonical directories, without Git or shell dependencies.
Explicit offline identities continue to work.
Reply validates the original recipient and commits a new message without acknowledging the original.

Linux process witnesses and Unix ownership checks remain platform-specific.
The discovery layer adds no new /proc, tmux or shell dependency; native Windows still needs process, ACL and notification adapters and is not supported yet.
Runtime validation protects session metadata and received-message IDs; this revision does not claim static type checking across the existing JavaScript codebase.

The default runtime remains the pinned Node.js 24.
The additional node26 flake check runs the same suite with pinned Node.js 26.12.1.
That version predates the 26.13.0 LTS transition, so switching the default requires a newer pinned input and live adapter verification.

## Collaboration responsibilities

| Responsibility | Current implementation | Boundary |
| --- | --- | --- |
| Messaging Core | Store message, reply, receipt and lease operations | Persists mail independently of terminal processes |
| Agent Adapter | SessionStart metadata in cli/registration, vendored queue/socket I/O | Translates agent-specific identity and delivery contracts |
| Session Runtime | identity, spawn, host registration reconciliation | Verifies process lifetime; tmux is only the optional managed runtime |
| Operator Interface | status, peers, doctor, retry, spawn/despawn | Reports unread counts, retry timing and failures without exposing credentials |

These are responsibilities within the existing modules, not four new service processes.
A future runtime may replace tmux without replacing message storage or agent transports.
The current adapter registration code still lives partly in cli.mjs; extracting it is preferable to introducing a generic plugin framework when another adapter is actually needed.

Mailbox identity and process availability are separate facts.
The authoritative session UUID selects a durable mailbox even if the process has exited or is hidden by a PID namespace.
This does not authorize a notification to a dead process: the host worker still checks the full process witness and socket identity before every delivery.
New targets record their Linux PID namespace; peers/status return online=null when the caller cannot compare that namespace or the target is a shared Codex app-server, and peers retain these candidates with unknown availability.
Old registrations lacking namespace metadata retain the previous liveness behavior until refreshed by a hook.

An identical SessionStart target preserves notification progress and outstanding leases.
A changed target on resume starts a new generation, preserving messages while fencing old completion writes.
The retry operation resets notification progress only, refuses a currently leased delivery, and leaves messages and receipts unchanged.
It can repeat a notification whose external acceptance was ambiguous; exactly-once delivery is still not guaranteed.

The inspected agmsg revision remains 7082fc03f3a6e3f8d5375bb07bec6b39a674a79b.
Its Codex SessionStart adapter explicitly separates hook identity from sandboxed tool-shell identity and avoids assigning one shared daemon PID to an arbitrary seat when several candidates exist.
seatwire similarly avoids guessing a process or newest transcript, while retaining its own SQLite data and declarative Nix integration.

A live shared Codex app-server does not prove an individual thread has an attached UI or can immediately run a model turn.
The host may still queue to that exact thread UUID, but availability is reported as unknown and read receipts remain the evidence of processing.
Runtime process verification is intentionally separate from per-session availability; a future supported agent API can refine the latter without changing message semantics.

## Revision: daily use and managed sessions

Codex stores hook trust in config.toml as a definition hash under a key naming the hook source, event and indices; the entry observed for a `-c` override was `/<session-flags>/config.toml:session_start:0:0`.
Spawn therefore keeps the managed SessionStart command identical across launches and passes the launch ID, team and name only through the pane environment.
The command still names the seatwire build and the state base, so an update or another state directory needs a new review.
Managed Codex runs with `--no-daemon`, so the hook inherits that environment and the registered process is the session's own process rather than a shared app-server.
The pane environment drops the spawner's session UUIDs, Claude messaging socket and token, and Claude nesting markers, because tmux copies the spawner's environment.
No hook trust is granted or bypassed by seatwire.

Forced despawn waits a bounded time for the recorded agent process to exit.
The rule that a live process keeps its name is unchanged; the wait only makes the reported state match it.

A Claude Code process keeps one messaging socket, inode and token across /clear while the session UUID changes.
A notification addressed to the earlier session would reach the new conversation, which has no claim to that mailbox.
Registering a Claude session therefore removes the notification target of other registrations with the same process witness and socket.
Their messages and receipts remain, status records which session took over, and a later resume registers the earlier session again.

Managed Claude launches with a fixed agent name retain that mailbox's original session UUID in the launch record when a different UUID is submitted.
Revocation commits before the hook reports an error, clears the target and lease, and changes the generation so an old worker cannot advance the notification cursor.
The original UUID can submit a fresh request and pass the existing host reconciliation checks to restore delivery.
A different UUID must use a separate name; this revision does not transfer mailbox ownership.
External socket writes already in flight cannot be retracted.
See [session switching](docs/SESSION_SWITCH.md) for alternatives and verification limits.

Codex targets are not superseded this way because a queue item names its thread and a shared app-server serves several threads.

`send` and `reply` report the recipient's notification state from the sender's view: pending, none, recipient not running or failing.
These states describe whether the host will try to prompt the recipient, not whether it processed the message.
Opening the store reports the directory or database when writes are denied, instead of the generic SQLite or recursive mkdir error, and does not change sandbox settings.

`programs.seatwire.claudePlugin` installs the skill as a Claude Code skills-directory plugin whose SessionStart hook runs the same package.
This serves users whose Claude settings are not managed by Home Manager without editing `settings.json`.
Claude loads user skills-directory plugins in place without a trust prompt and rejects component symlinks that leave the plugin, so the module builds a directory of regular files.
Codex has no comparable declarative path for an unmanaged `~/.codex/hooks.json`; the README documents a manual hook and the trade-off between a store path and a stable profile path.

The agmsg revision checked during this revision was `318b082b86508dbbc422fe709b46cac2fc99e25c`.
The two vendored I/O modules are unchanged since `7082fc03f3a6e3f8d5375bb07bec6b39a674a79b`, so the vendored copies were not updated.
agmsg's per-turn Stop/PostToolUse inbox hooks provide a delivery path that does not depend on its daemon; seatwire does not adopt them in this revision.
