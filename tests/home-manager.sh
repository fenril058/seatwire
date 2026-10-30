#!/usr/bin/env bash
set -euo pipefail
export SEATWIRE_SOURCE="$(pwd)"
test_root="$(mktemp -d /tmp/seatwire-hm.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
export SEATWIRE_TEST_HOME="$test_root/home"
mkdir -p "$SEATWIRE_TEST_HOME"
export SEATWIRE_TEST_USER="$(id -un)"
expr='let
 f = builtins.getFlake ("git+file://" + builtins.getEnv "SEATWIRE_SOURCE");
 in assert !(builtins.pathExists (f.outPath + "/.dev"));
 (f.inputs.home-manager.lib.homeManagerConfiguration {
 pkgs = f.inputs.nixpkgs.legacyPackages.x86_64-linux;
 modules = [ f.homeManagerModules.default {
 home.username = builtins.getEnv "SEATWIRE_TEST_USER";
 home.homeDirectory = builtins.getEnv "SEATWIRE_TEST_HOME";
 home.stateVersion = "26.05";
 programs.seatwire.enable = builtins.getEnv "SEATWIRE_TEST_ENABLE" == "1";
 programs.seatwire.integrateClaude = true;
 programs.seatwire.integrateCodex = true;
 programs.claude-code = { enable = true; package = null; settings.model = "sonnet"; };
 programs.codex = { enable = true; package = null; settings.model = "gpt-5"; };
 systemd.user.startServices = false;
 } ];
 }).activationPackage'
export SEATWIRE_TEST_ENABLE=1
on="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
export SEATWIRE_TEST_ENABLE=0
off="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
activate() {
  env -u DBUS_SESSION_BUS_ADDRESS HOME="$SEATWIRE_TEST_HOME" XDG_STATE_HOME="$SEATWIRE_TEST_HOME/.local/state" XDG_CONFIG_HOME="$SEATWIRE_TEST_HOME/.config" XDG_CACHE_HOME="$SEATWIRE_TEST_HOME/.cache" XDG_RUNTIME_DIR="$test_root/runtime" "$1/activate"
}
mkdir -m700 "$test_root/runtime"
activate "$on"
activate "$on"
test -L "$SEATWIRE_TEST_HOME/.claude/skills/seatwire"
test -L "$SEATWIRE_TEST_HOME/.agents/skills/seatwire"
test -f "$SEATWIRE_TEST_HOME/.config/systemd/user/seatwire.service"
grep -q SessionStart "$SEATWIRE_TEST_HOME/.claude/settings.json"
grep -q SessionStart "$SEATWIRE_TEST_HOME/.codex/config.toml"
export XDG_STATE_HOME="$SEATWIRE_TEST_HOME/.local/state"
"$on/home-path/bin/seatwire" --name alice register --kind claude-code
"$on/home-path/bin/seatwire" --name bob register --kind codex
"$on/home-path/bin/seatwire" --name alice send --to bob retained
activate "$off"
test ! -e "$SEATWIRE_TEST_HOME/.claude/skills/seatwire"
test ! -e "$SEATWIRE_TEST_HOME/.agents/skills/seatwire"
test ! -e "$SEATWIRE_TEST_HOME/.config/systemd/user/seatwire.service"
test ! -e "$SEATWIRE_TEST_HOME/.config/seatwire/hooks.json"
! grep -q SessionStart "$SEATWIRE_TEST_HOME/.claude/settings.json"
! grep -q SessionStart "$SEATWIRE_TEST_HOME/.codex/config.toml"
grep -q sonnet "$SEATWIRE_TEST_HOME/.claude/settings.json"
grep -q gpt-5 "$SEATWIRE_TEST_HOME/.codex/config.toml"
test -f "$XDG_STATE_HOME/seatwire/messages.sqlite3"
activate "$on"
"$on/home-path/bin/seatwire" --name bob inbox | grep -q retained
printf 'PASS: isolated Home Manager activation, repeat, disable, data retention, re-enable\n'
printf 'User systemd start/stop was deliberately disabled in this isolated test.\n'
