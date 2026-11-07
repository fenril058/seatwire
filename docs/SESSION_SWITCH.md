# Managed conversation switching

A fixed agent name identifies a mailbox and role, while a session UUID identifies a conversation.
Messages remain addressed to team/name; this change does not migrate messages or change their owner.

The first valid SessionStart binds its UUID in the existing managed launch JSON record, even while host validation is pending.
A different valid UUID permanently revokes automatic notification registration for that launch, for both Claude and Codex.
In one transaction, revocation clears the target, lease and pending request and changes the generation, then reports an error after commit.
The revocation flag survives database reopen and launch publication when hooks run while tmux is starting.
Invalid launch IDs, mismatched kinds and mismatched projects are rejected before this state can change.
Duplicate SessionStart for the same UUID on an unrevoked launch preserves notification progress.

Neither replaying the original UUID nor declaring source=resume can undo revocation.
SessionStart input provides no evidence that distinguishes a delayed event from a legitimate in-process resume.
The previous design that restored the original UUID inside the same launch was therefore rejected.
Recovery requires explicitly stopping the old launch, confirming its exit, and starting a new managed launch with resume of the original UUID.
The new launch has a new launch ID and must pass the existing process, tmux identity, socket and mailbox registration checks.
Unread messages and ack history are preserved throughout.
A new UUID does not automatically inherit the old mailbox.
Explicit team/name remains an operator override within one Unix user's state, not an access-control boundary.

Reconciliation reads and validates outside the write transaction, then compares the exact launch record and pending payload again inside Store.register's transaction and rejects revoked launches.
A revocation between those reads and the transaction therefore prevents target publication.
No DB schema change, extra daemon or general state machine is introduced.

Revocation fences future claims and stale worker DB completion, not external I/O.
A worker that claimed before revocation can still start or finish a socket/queue operation afterwards; already submitted notifications cannot be retracted.
The interval between a runtime conversation switch and receipt of SessionStart is also not covered.
No exactly-once or model-consumption guarantee is added.
Automatically named unmanaged Claude sessions retain their existing supersession behavior.
Explicitly named unmanaged sessions and automatic ownership transfer between conversations remain outside this fix.

Before this correction, regressions reproduced retained first pending requests and restoration by the old UUID, including a claimed resume.
Tests cover revocation before and after reconciliation reads the request, with a second DB connection injecting revocation before Store.register starts its transaction.
They directly assert target absence, pending removal, persistent revocation, unchanged unread IDs and ack history, generation/lease fencing, invalid-input isolation and duplicate handling.
An isolated tmux and substitute Claude executable exercise explicit stop, a new managed launch, rejection of an invalid process witness and successful recovery of the original mailbox.
Live Claude clear/resume, real notification acceptance, power-loss durability and real systemd lifecycle are not tested.
