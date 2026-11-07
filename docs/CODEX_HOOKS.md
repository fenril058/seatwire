# Declarative Codex hook ownership

The opt-in programs.seatwire.codexHooksFile option owns ~/.codex/hooks.json as a Home Manager file.
It installs a single SessionStart handler using the package's absolute store path.
It does not require programs.codex to manage config.toml and does not write runtime trust, credentials or agent state.
The module rejects integrateCodex and Home Manager inline hooks when this option is selected.
It also rejects nonempty programs.codex.hooks when programs.codex is enabled, across attribute sets, literal file/directory paths and string store paths.
Empty hooks and disabled programs.codex do not declare that file and are allowed.
This deliberately requires one declarative hook owner rather than automatically merging sources, including when Codex uses an XDG layout.
Unmanaged existing files are protected by the normal activation collision check; force replacement is not enabled.
The option owns the entire hook file and does not merge or discard other user hooks.
Users must review existing definitions and resolve a migration collision themselves.

Codex merges hook sources across user, project, session and plugin layers.
The module can reject conflicting declarative settings it can see, but cannot inspect all runtime sources or prove global uniqueness.
Review /hooks after activation and remove duplicate seatwire definitions from other sources before use.
The hook definition changes with the package store path, so an update may require a new review.
Home Manager ownership does not make the hook trusted by Codex policy.
See [official Codex Hooks](https://learn.chatgpt.com/docs/hooks) for source and trust semantics verified on 2026-11-06.

The isolated Home Manager test passed activation, repeated application, collision protection, rejection of duplicate installers, package-path update and disable.
It checks that exactly one SessionStart command is present, that the update changes the command, and that runtime config, credential fixtures and the seatwire database survive disable.
The test sets systemd.user.startServices=false and uses a temporary HOME and runtime directory.
The first test iteration failed because its derivation homeDirectory and activation HOME differed; the fixture was corrected before the successful complete run.
Live Codex hook loading/trust and notification acceptance are not exercised.
No real Home Manager switch or systemd service operation is performed.

The config-home-manager repository is unchanged.
Adoption there should be a separate PR after this option is available in its seatwire input, resolving its existing unmanaged hooks.json before activation.
That adoption must retain Codex's dynamic config and trust rather than making config.toml immutable.

The blocking-review regression uses the unchanged flake.lock Home Manager revision 095fef2f265c3c0da4fe315efba8f8a04495ab34.
Its modules/programs/codex/options.nix and default.nix define attribute-set hooks as a generated JSON source, literal files/directories as file sources, and string paths as normalized recursive directory sources.
Before the assertion fix, all five conflict forms evaluated successfully and could shadow the seatwire definition.
The regression requires evaluation to fail with the explicit ownership error for every form, and preserves empty/disabled controls.
It runs before the existing isolated activation test; no automatic hook merge or dynamic config/trust change is added.
