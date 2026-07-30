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
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            clang
            llvmPackages.llvm
            lldb
            gnumake
            cmake
            ninja
            pkg-config
            ccls
            bear
            glib
            zlib
            openssl
            darwin.apple_sdk.frameworks.CoreFoundation
            darwin.apple_sdk.frameworks.CoreServices
          ];

          shellHook = ''
            export SDKROOT=$(xcrun --show-sdk-path)
            export CPATH="$SDKROOT/usr/include:$CPATH"
            export LIBRARY_PATH="$SDKROOT/usr/lib:$LIBRARY_PATH"
            export NIX_LDFLAGS="-F$SDKROOT/System/Library/Frameworks -L$SDKROOT/usr/lib $NIX_LDFLAGS"
            echo "C/C++ macOS ARM64 environment ready"
            echo "  clang: $(clang --version | head -1)"
            echo "  SDK:   $SDKROOT"
          '';
        };
      });
}
