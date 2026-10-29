# Third-party sources

| Source | Revision | Reuse |
| --- | --- | --- |
| https://github.com/fujibee/agmsg | `7082fc03f3a6e3f8d5375bb07bec6b39a674a79b` | `scripts/daemon/channels/codex-queue-io.mjs` and `claude-code-queue-io.mjs`, copied unchanged to `vendor/agmsg/` |
| https://github.com/lambdalisue/cclens | `14c611720a98a4fbec2b576fe878175031ef651d`, subsequently `39cadc2d22522c09a99010659155393361780695` | Architecture reference only; no copied code |

The vendored agmsg modules remain unmodified, including the upstream `agmsgd` sender label in the Claude wire envelope.
seatwire supplies its own inbox notification body.
The upstream copyright is Copyright (c) 2026 fujibee.
The complete upstream MIT license is preserved in [vendor/agmsg/LICENSE](vendor/agmsg/LICENSE) and installed alongside the modules.

When updating the adapters, record the new commit, inspect protocol and validation changes, and rerun socket, queue and live-agent tests.
Do not replace the state machine with agmsg's installer-dependent channels without revisiting ARCHITECTURE.md.
