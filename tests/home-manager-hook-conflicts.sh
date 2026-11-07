#!/usr/bin/env bash
set -euo pipefail
export SEATWIRE_SOURCE="$(pwd)"
fixture_root="$(mktemp -d /tmp/seatwire-hook-conflicts.XXXXXX)"
trap 'rm -rf "$fixture_root"' EXIT
export SEATWIRE_HOOK_FIXTURES="$fixture_root"
mkdir "$fixture_root/bundle"
printf '{"hooks":{"Stop":[]}}\n' > "$fixture_root/hooks.json"
cp "$fixture_root/hooks.json" "$fixture_root/bundle/hooks.json"
expr='let
 f = builtins.getFlake ("git+file://" + builtins.getEnv "SEATWIRE_SOURCE");
 pkgs = f.inputs.nixpkgs.legacyPackages.x86_64-linux;
 mode = builtins.getEnv "SEATWIRE_HOOK_MODE";
 fixture = builtins.getEnv "SEATWIRE_HOOK_FIXTURES";
 hooks = if mode == "attrs" then { Stop = []; }
   else if mode == "file" then builtins.toPath (fixture + "/hooks.json")
   else if mode == "directory" then builtins.toPath (fixture + "/bundle")
   else if mode == "store-file" then "${pkgs.writeText "other-hooks.json" (builtins.readFile (fixture + "/hooks.json"))}"
   else if mode == "store-directory" then "${pkgs.runCommand "other-hooks" {} "mkdir -p $out; cp ${fixture}/hooks.json $out/hooks.json"}"
   else {};
 in (f.inputs.home-manager.lib.homeManagerConfiguration {
 inherit pkgs;
 modules = [ f.homeManagerModules.default {
 home.username = "seatwire-test";
 home.homeDirectory = "/tmp/seatwire-hook-conflict-home";
 home.stateVersion = "26.05";
 programs.seatwire = { enable = true; codexHooksFile = true; };
 programs.codex = { enable = builtins.getEnv "SEATWIRE_CODEX_DISABLED" != "1"; package = null; inherit hooks; };
 systemd.user.startServices = false;
 } ];
 }).activationPackage.drvPath'
failed=0
for mode in attrs file directory store-file store-directory; do
 export SEATWIRE_HOOK_MODE="$mode"
 if timeout 60s nix eval --impure --raw --expr "$expr" > "$fixture_root/$mode.out" 2> "$fixture_root/$mode.err"; then
  printf 'FAIL: programs.codex.hooks %s silently accepted\n' "$mode" >&2
  failed=1
 elif ! grep -q 'codexHooksFile cannot be combined with programs.codex.hooks' "$fixture_root/$mode.err"; then
  cat "$fixture_root/$mode.err" >&2
  failed=1
 fi
done
# Empty hooks and disabled Codex do not own the hook file.
export SEATWIRE_HOOK_MODE=empty
timeout 60s nix eval --impure --raw --expr "$expr" > /dev/null
export SEATWIRE_HOOK_MODE=attrs SEATWIRE_CODEX_DISABLED=1
timeout 60s nix eval --impure --raw --expr "$expr" > /dev/null
test "$failed" = 0
printf 'PASS: hooks ownership conflicts (attrs, literal/store files and directories), empty/disabled controls\n'
