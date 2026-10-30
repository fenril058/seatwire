#!/usr/bin/env bash
# Uses the existing user manager, a unique runtime-only unit link, and a temporary HOME.
set -euo pipefail
systemctl --user is-active default.target >/dev/null
export SEATWIRE_SOURCE="$(pwd)"
test_root="$(mktemp -d /tmp/seatwire-systemd.XXXXXX)"
export SEATWIRE_TEST_HOME="$test_root/home"
export SEATWIRE_TEST_USER="$(id -un)"
export SEATWIRE_TEST_UNIT="seatwire-ci-$(basename "$test_root")"
unit="$SEATWIRE_TEST_UNIT.service"
mkdir -p "$SEATWIRE_TEST_HOME"
cleanup() {
  if [[ -n ${on:-} && -x $on/home-path/bin/seatwire ]]; then
    "$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --team test despawn survivor --force >/dev/null 2>&1 || true
  fi
  systemctl --user stop "$unit" >/dev/null 2>&1 || true
  systemctl --user disable --runtime "$unit" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
  systemctl --user daemon-reload
  rm -rf "$test_root"
}
trap cleanup EXIT
expr='let
 f = builtins.getFlake (builtins.getEnv "SEATWIRE_SOURCE");
 pkgs = f.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
 enabled = builtins.getEnv "SEATWIRE_TEST_ENABLE" == "1";
 common = {
   home.username = builtins.getEnv "SEATWIRE_TEST_USER";
   home.homeDirectory = builtins.getEnv "SEATWIRE_TEST_HOME";
   home.stateVersion = "26.05";
   programs.seatwire.enable = enabled;
   systemd.user.startServices = true;
 };
 base = f.inputs.home-manager.lib.homeManagerConfiguration {
   inherit pkgs; modules = [ f.homeManagerModules.default common ];
 };
 in (f.inputs.home-manager.lib.homeManagerConfiguration {
   inherit pkgs; modules = [ f.homeManagerModules.default common {
     systemd.user.services = pkgs.lib.mkForce (if enabled then {
       ${builtins.getEnv "SEATWIRE_TEST_UNIT"} = base.config.systemd.user.services.seatwire;
     } else {});
   } ];
 }).activationPackage'
export SEATWIRE_TEST_ENABLE=1
on="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
export SEATWIRE_TEST_ENABLE=0
off="$(nix build --impure --no-link --print-out-paths --expr "$expr" --log-format raw)"
# The manager uses the real login HOME. Expose only this unique test unit to it.
# Its WantedBy links and generation comparison remain owned by the temporary HM home.
cp -L "$on/home-files/.config/systemd/user/$unit" "$test_root/$unit"
systemctl --user link --runtime "$test_root/$unit"
activate() {
  env HOME="$SEATWIRE_TEST_HOME" XDG_STATE_HOME="$SEATWIRE_TEST_HOME/.local/state" \
    XDG_CONFIG_HOME="$SEATWIRE_TEST_HOME/.config" XDG_CACHE_HOME="$SEATWIRE_TEST_HOME/.cache" "$1/activate"
}
wait_active() {
  for _ in $(seq 1 50); do
    if systemctl --user is-active --quiet "$unit"; then return; fi
    sleep 0.1
  done
  systemctl --user status "$unit" --no-pager
  return 1
}
activate "$on"
wait_active
worker_pid="$(systemctl --user show "$unit" --property MainPID --value)"
test "$worker_pid" -gt 1
activate "$on"
wait_active
"$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --name alice register --kind claude-code
"$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --name bob register --kind codex
"$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --name alice send --to bob retained
printf '#!/bin/sh\nexec sleep 300\n' > "$test_root/fake-codex"
chmod 700 "$test_root/fake-codex"
SEATWIRE_CODEX="$test_root/fake-codex" "$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --team test spawn codex survivor > "$test_root/spawn.json"
activate "$off"
! systemctl --user is-active --quiet "$unit"
! kill -0 "$worker_pid" 2>/dev/null
test ! -e "$SEATWIRE_TEST_HOME/.config/systemd/user/$unit"
test -f "$SEATWIRE_TEST_HOME/.local/state/seatwire/messages.sqlite3"
"$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" status > "$test_root/status.json"
python3 - "$test_root/status.json" <<'PY'
import json,sys
assert any(x['name']=='survivor' and x['running'] for x in json.load(open(sys.argv[1]))['launches'])
PY
activate "$on"
wait_active
"$on/home-path/bin/seatwire" --state-home "$SEATWIRE_TEST_HOME/.local/state" --name bob inbox | grep -q retained
activate "$off"
! systemctl --user is-active --quiet "$unit"
printf 'PASS: Home Manager stopped the running worker, preserved DB and managed agent, and restarted on re-enable\n'
