{
  description = "{{title}}";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib  = pkgs.lib;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.coreutils
            pkgs.git
            pkgs.direnv
          ];

          # Clear Homebrew/Nix compiler env so elan's clang is used cleanly
          DYLD_LIBRARY_PATH          = "";
          DYLD_FALLBACK_LIBRARY_PATH = "";
          LDFLAGS                    = "";
          NIX_LDFLAGS                = "";
          CFLAGS                     = "";
          CPPFLAGS                   = "";

          PATH = lib.makeBinPath [ pkgs.coreutils pkgs.git ]
            + ":${builtins.getEnv "HOME"}/.elan/bin"
            + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

          shellHook = ''
            echo "Lean 4 environment ready (elan: $(elan --version 2>/dev/null || echo not found))"
          '';
        };
      });
}
