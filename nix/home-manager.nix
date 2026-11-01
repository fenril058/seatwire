self: { config, lib, pkgs, ... }:
let
  cfg = config.programs.seatwire;
  hook = kind: { matcher = "*"; hooks = [ { type = "command"; command = "${cfg.package}/bin/seatwire hook --kind ${kind}"; } ]; };
  # Claude Code loads ~/.claude/skills/<dir>/.claude-plugin as a plugin in place and rejects
  # component symlinks that leave the plugin, so every file here is a regular file.
  claudePlugin = pkgs.runCommand "seatwire-claude-plugin" {
    manifest = builtins.toJSON {
      name = "seatwire";
      version = lib.getVersion cfg.package;
      description = "Local Claude Code and Codex messaging; registers each Claude session on SessionStart.";
      author.name = "seatwire";
      license = "MIT";
    };
    hooks = builtins.toJSON { hooks.SessionStart = [ (hook "claude-code") ]; };
    passAsFile = [ "manifest" "hooks" ];
  } ''
    mkdir -p $out/.claude-plugin $out/hooks
    cp ${cfg.package}/share/seatwire/skills/seatwire/SKILL.md $out/SKILL.md
    cp "$manifestPath" $out/.claude-plugin/plugin.json
    cp "$hooksPath" $out/hooks/hooks.json
  '';
in {
  options.programs.seatwire = {
    enable = lib.mkEnableOption "seatwire local agent messaging";
    package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.default; };
    integrateClaude = lib.mkEnableOption "merge seatwire SessionStart into Home Manager Claude settings";
    integrateCodex = lib.mkEnableOption "merge seatwire SessionStart into Home Manager Codex settings";
    claudePlugin = lib.mkEnableOption "a Claude Code skills-directory plugin at ~/.claude/skills/seatwire whose SessionStart hook registers each Claude session, without changing Claude settings";
    codexExecutable = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/opt/codex/bin/codex";
      description = "Absolute path of the codex executable for the notification service (SEATWIRE_CODEX). Null searches the service PATH.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = !cfg.integrateClaude || (config.programs.claude-code.enable && !config.programs.claude-code.mutableSettings);
        message = "seatwire Claude integration requires enabled, immutable Home Manager settings."; }
      { assertion = !cfg.integrateCodex || (config.programs.codex.enable && !config.programs.codex.mutableSettings);
        message = "seatwire Codex integration requires enabled, immutable Home Manager settings."; }
      { assertion = cfg.codexExecutable == null || lib.hasPrefix "/" cfg.codexExecutable;
        message = "programs.seatwire.codexExecutable must be an absolute path."; }
      { assertion = !(cfg.claudePlugin && cfg.integrateClaude);
        message = "programs.seatwire.claudePlugin and integrateClaude both install the Claude SessionStart hook; enable only one."; }
    ];
    home.packages = [ cfg.package ];
    home.file.".claude/skills/seatwire".source = if cfg.claudePlugin then claudePlugin else "${cfg.package}/share/seatwire/skills/seatwire";
    home.file.".agents/skills/seatwire".source = "${cfg.package}/share/seatwire/skills/seatwire";
    xdg.configFile."seatwire/hooks.json".text = builtins.toJSON {
      claude = { hooks.SessionStart = [ (hook "claude-code") ]; };
      codex = { hooks.SessionStart = [ (hook "codex") ]; };
    };
    programs.claude-code.settings = lib.mkIf cfg.integrateClaude { hooks.SessionStart = [ (hook "claude-code") ]; };
    programs.codex.settings = lib.mkIf cfg.integrateCodex { hooks.SessionStart = [ (hook "codex") ]; };
    systemd.user.services.seatwire = {
      Unit.Description = "seatwire notification worker";
      Install.WantedBy = [ "default.target" ];
      Service = {
        ExecStart = "${cfg.package}/bin/seatwire daemon";
        Restart = "on-failure";
        UMask = "0077";
        Environment = [ "PATH=${config.home.profileDirectory}/bin:/usr/bin:/bin" "XDG_STATE_HOME=${config.xdg.stateHome}" ]
          ++ lib.optional (cfg.codexExecutable != null) "SEATWIRE_CODEX=${cfg.codexExecutable}";
      };
    };
  };
}
