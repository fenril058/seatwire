{
  description = "seatwire: state-separated local agent messaging";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.home-manager = {
    url = "github:nix-community/home-manager";
    inputs.nixpkgs.follows = "nixpkgs";
  };
  outputs = { self, nixpkgs, home-manager }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      each = nixpkgs.lib.genAttrs systems;
    in {
      packages = each (system: let pkgs = nixpkgs.legacyPackages.${system}; in {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "seatwire"; version = "0.1.0"; src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.nodejs_24 pkgs.tmux ];
          doCheck = true;
          checkPhase = "node --test tests/*.test.mjs";
          installPhase = ''
            mkdir -p $out/lib/seatwire $out/bin $out/share/seatwire
            cp -r src vendor $out/lib/seatwire/
            cp -r skills $out/share/seatwire/
            cp README.md ARCHITECTURE.md THIRD_PARTY.md LICENSE $out/share/seatwire/
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/seatwire \
              --add-flags $out/lib/seatwire/src/cli.mjs \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux ]}
          '';
          meta.mainProgram = "seatwire";
        };
      });
      homeManagerModules.default = import ./nix/home-manager.nix self;
      checks = each (system: {
        package = self.packages.${system}.default;
        home-manager = (home-manager.lib.homeManagerConfiguration {
          pkgs = nixpkgs.legacyPackages.${system};
          modules = [ self.homeManagerModules.default {
            home.username = "seatwire-test";
            home.homeDirectory = "/tmp/seatwire-hm-test";
            home.stateVersion = "26.05";
            programs.seatwire.enable = true;
          } ];
        }).activationPackage;
      });
      devShells = each (system: { default = nixpkgs.legacyPackages.${system}.mkShell { packages = [ nixpkgs.legacyPackages.${system}.nodejs_24 ]; }; });
    };
}
