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
Nix owns executable code, skills, hooks configuration fragments and the user service.
No installer modifies agent configuration.

Persistent state resides in `$XDG_STATE_HOME/seatwire`, defaulting to `~/.local/state/seatwire`.
SQLite uses WAL, busy timeout and immediate transactions.
Schema version 1 is created transactionally; unknown versions fail before journal changes.
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
Teams and named agents replace actas role files; a name is explicitly selected per session.

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
