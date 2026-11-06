# Notification status observations

The additive `notification` object in `status` and `doctor` distinguishes idle, missing target, offline, in-flight, failed, pending and accepted-unacknowledged states.
The existing sender-facing `send` and `reply` notification strings remain compatible.
Counts distinguish accepted unread messages from later unread messages still awaiting a transport attempt.
A success advances the existing notification cursor, while only explicit ack changes message read_at.

The state describes the current outstanding work, so an old transport error does not make accepted-only unread messages appear failed.
An active lease takes priority over a previous failure because a retry may already be running.
Unknown liveness stays null, and pending does not imply online, worker availability, hook trust or transport compatibility.
No live probe, trust mutation, adapter registry or additional daemon is introduced.

The new regression test failed before the implementation because the notification object was absent.
All 39 Node tests passed after implementation using isolated fixtures on the host.
Tests cover accepted-only unread, mixed accepted/new unread, claim, failure, ack, unknown liveness, offline and missing target.
The sandbox baseline timed out at 45 seconds; the unchanged host baseline passed all 37 tests.
Live transport acceptance, model consumption, hook trust and real worker status were not verified.
