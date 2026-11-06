# Managed Claude conversation switching

A fixed agent name identifies a mailbox and role, while a session UUID identifies a conversation.
Messages remain addressed to team/name; this change does not migrate messages or change their owner.

When a managed Claude launch submits a UUID different from its registered conversation, the registration transaction records the original UUID on the launch, clears its target and lease, and changes its generation.
The hook reports an error only after this transaction commits.
Subsequent attempts with another UUID remain rejected, including when the old target is already absent.
The original UUID can submit a fresh request and restore delivery through normal host process, launch and socket validation.
Duplicate SessionStart for the current target preserves notification progress.

Automatic transfer of the fixed name would expose old unread messages to the new conversation.
Allocating a new automatic mailbox would require defining how the fixed launch environment, sender addressing and role selection follow it.
Those ownership and identity changes are deferred rather than inferred from process liveness.
Users can resume the original UUID or start a separate managed launch with another name.
Explicit team/name remains an operator override within the same Unix user's state, not an access-control boundary.

The transaction fences worker completion and future claims; it cannot retract external I/O already in flight.
SessionStart is the observation point, so the interval between a runtime switch and hook submission is not covered.
No exactly-once or model-consumption guarantee is added.
Ordinary automatically named Claude sessions keep their existing supersession behavior.
Explicitly named unmanaged sessions and transfer across separate launches need a broader mailbox-ownership design and are outside this fix.

Regression tests first failed on the retained target before the fix.
After the fix, all 39 Node tests passed on the host with isolated databases, Unix sockets, tmux servers and substitute executables.
Tests directly check the unread message ID, target removal, generation change, stale completion fencing, duplicate registration, and original UUID restoration through host reconciliation.
The sandbox baseline timed out after 45 seconds; the unchanged host baseline passed all 37 tests.
Live Claude clear/resume, real notification acceptance, power-loss durability and systemd lifecycle were not tested in this task.
