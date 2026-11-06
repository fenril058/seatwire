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
 programs.seatwire.package = let p = f.packages.x86_64-linux.default; in
   if builtins.getEnv "SEATWIRE_TEST_UPDATE" == "1" then p.overrideAttrs (_: { pname = "seatwire-hook-update-test"; }) else p;
 programs.seatwire.enable = builtins.getEnv "SEATWIRE_TEST_ENABLE" == "1";
 programs.seatwire.integrateClaude = builtins.getEnv "SEATWIRE_TEST_PLUGIN" != "1";
 programs.seatwire.claudePlugin = builtins.getEnv "SEATWIRE_TEST_PLUGIN" != "";
 programs.seatwire.codexHooksFile = builtins.getEnv "SEATWIRE_TEST_CODEX_FILE" != "";
 programs.seatwire.integrateCodex = builtins.getEnv "SEATWIRE_TEST_CODEX_FILE" != "1";
 programs.seatwire.codexExecutable = "/opt/seatwire-test/bin/codex";
 programs.claude-code = { enable = true; package = null; settings.model = "sonnet"; };
 programs.codex = { enable = builtins.getEnv "SEATWIRE_TEST_CODEX_FILE" != "1"; package = null; settings.model = "gpt-5"; };
 systemd.user.startServices = false;
 } ];
 }).activationPackage'
export SEATWIRE_TEST_ENABLE=1
on="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
export SEATWIRE_TEST_PLUGIN=1
plugin="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
# Both Claude hook installers at once must be rejected at evaluation.
export SEATWIRE_TEST_PLUGIN=both
if nix build --impure --no-link --expr "$expr" --log-format raw 2> "$test_root/both.log"; then exit 1; fi
grep -q 'claudePlugin and integrateClaude both install' "$test_root/both.log"
export SEATWIRE_TEST_PLUGIN=
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
grep -qx 'Environment=SEATWIRE_CODEX=/opt/seatwire-test/bin/codex' "$SEATWIRE_TEST_HOME/.config/systemd/user/seatwire.service"
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
activate "$plugin"
skill_dir="$SEATWIRE_TEST_HOME/.claude/skills/seatwire"
for file in .claude-plugin/plugin.json hooks/hooks.json SKILL.md; do
  test -f "$skill_dir/$file"
  test ! -L "$skill_dir/$file"
done
python3 - "$skill_dir" <<'PY'
import json, os, sys
root = sys.argv[1]
manifest = json.load(open(os.path.join(root, ".claude-plugin/plugin.json")))
assert manifest["name"] == "seatwire", manifest
hooks = json.load(open(os.path.join(root, "hooks/hooks.json")))["hooks"]["SessionStart"]
command = hooks[0]["hooks"][0]["command"].split()
assert command[1:] == ["hook", "--kind", "claude-code"], command
assert os.access(command[0], os.X_OK), command
PY
! grep -q SessionStart "$SEATWIRE_TEST_HOME/.claude/settings.json"
grep -q SessionStart "$SEATWIRE_TEST_HOME/.codex/config.toml"
activate "$off"
test ! -e "$skill_dir"
printf 'PASS: isolated Home Manager activation, repeat, disable, data retention, re-enable, Claude plugin hook\n'
printf 'User systemd start/stop was deliberately disabled in this isolated test.\n'

# Dedicated hooks own only hooks.json, with a mutable runtime config and credentials.
export SEATWIRE_TEST_HOME="$test_root/hooks-home"
export SEATWIRE_TEST_ENABLE=1 SEATWIRE_TEST_CODEX_FILE=1
hooks="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
export SEATWIRE_TEST_CODEX_FILE=both
if nix build --impure --no-link --expr "$expr" --log-format raw 2> "$test_root/codex-both.log"; then exit 1; fi
grep -q 'codexHooksFile cannot be combined' "$test_root/codex-both.log"
export SEATWIRE_TEST_CODEX_FILE=1 SEATWIRE_TEST_ENABLE=0
hooks_off="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
export SEATWIRE_TEST_HOME="$test_root/hooks-home"
mkdir -p "$SEATWIRE_TEST_HOME/.codex"
printf 'runtime trust fixture\n' > "$SEATWIRE_TEST_HOME/.codex/config.toml"
printf 'credential fixture\n' > "$SEATWIRE_TEST_HOME/.codex/auth.json"
printf '{"hooks":{}}\n' > "$SEATWIRE_TEST_HOME/.codex/hooks.json"
# A pre-existing unmanaged hook file must not be overwritten.
if activate "$hooks" > "$test_root/collision.log" 2>&1; then exit 1; fi
grep -q 'hooks.json' "$test_root/collision.log" || { cat "$test_root/collision.log"; exit 1; }
grep -qx '{"hooks":{}}' "$SEATWIRE_TEST_HOME/.codex/hooks.json"
rm "$SEATWIRE_TEST_HOME/.codex/hooks.json"
activate "$hooks"
activate "$hooks"
python3 - "$SEATWIRE_TEST_HOME/.codex/hooks.json" <<'PYHOOK'
import json, os, sys
hooks = json.load(open(sys.argv[1]))["hooks"]["SessionStart"]
assert len(hooks) == 1 and len(hooks[0]["hooks"]) == 1
command = hooks[0]["hooks"][0]["command"].split()
assert command[1:] == ["hook", "--kind", "codex"]
assert os.access(command[0], os.X_OK)
PYHOOK
XDG_STATE_HOME="$SEATWIRE_TEST_HOME/.local/state" "$hooks/home-path/bin/seatwire" status > /dev/null
cp "$SEATWIRE_TEST_HOME/.codex/hooks.json" "$test_root/old-hooks.json"
export SEATWIRE_TEST_ENABLE=1 SEATWIRE_TEST_UPDATE=1
updated="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
activate "$updated"
! cmp -s "$test_root/old-hooks.json" "$SEATWIRE_TEST_HOME/.codex/hooks.json"
grep -qx 'runtime trust fixture' "$SEATWIRE_TEST_HOME/.codex/config.toml"
grep -qx 'credential fixture' "$SEATWIRE_TEST_HOME/.codex/auth.json"
activate "$hooks_off"
test ! -e "$SEATWIRE_TEST_HOME/.codex/hooks.json"
grep -qx 'runtime trust fixture' "$SEATWIRE_TEST_HOME/.codex/config.toml"
grep -qx 'credential fixture' "$SEATWIRE_TEST_HOME/.codex/auth.json"
test -f "$SEATWIRE_TEST_HOME/.local/state/seatwire/messages.sqlite3"
printf 'PASS: dedicated Codex hooks, collision, duplicate prevention, repeat, disable, runtime files retained\n'
