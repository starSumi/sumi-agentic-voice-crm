{
  description = "Sumi Agentic Voice CRM optional reproducible development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpmPinned = pkgs.callPackage "${nixpkgs}/pkgs/development/tools/pnpm/generic.nix" {
            version = "10.33.4";
            hash = "sha256-9ocTLpPeTn5BjSB01+EO2+UlpKpdYPG2AWq14RJ8Myg=";
            nodejs = null;
            nodejs-slim = pkgs.nodejs_24;
            withNode = false;
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pnpmPinned
              pkgs.rustc
              pkgs.cargo
              pkgs.clippy
              pkgs.rustfmt
              pkgs.git
              pkgs.jq
              pkgs.openssl
              pkgs.python3
              pkgs.gnumake
              pkgs.pkg-config
              pkgs.postgresql_17
              pkgs.docker-client
              pkgs.docker-compose
            ];

            shellHook = ''
              export SUMI_NIX_SHELL=1
              node -e '
                const actual = process.versions.node.split(".").map(Number);
                const minimum = [24, 19, 0];
                const meetsMinimum = actual[0] > minimum[0]
                  || (actual[0] === minimum[0] && (actual[1] > minimum[1]
                    || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
                if (!meetsMinimum) {
                  console.error(`Sumi requires Node >=24.19.0; Nix supplied ''${process.versions.node}`);
                  process.exit(1);
                }
              '
              test "$(pnpm --version)" = "10.33.4" || {
                echo "Sumi expects pnpm 10.33.4" >&2
                return 1
              }
              echo "Sumi Nix shell: Node $(node --version), pnpm $(pnpm --version), $(rustc --version); services remain stopped."
            '';
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          repository-contract = pkgs.runCommand "sumi-nix-repository-contract" {
            nativeBuildInputs = [ pkgs.jq ];
            src = self;
          } ''
            test -f "$src/pnpm-lock.yaml"
            test -f "$src/Cargo.lock"
            test "$(sed -n 's/^channel = \"\(.*\)\"/\1/p' "$src/rust-toolchain.toml")" = "1.96.0"
            test ! -e "$src/package-lock.json"
            test "$(jq -r .packageManager "$src/package.json")" = "pnpm@10.33.4"
            test "$(jq -r .volta.node "$src/package.json")" = "24.19.0"
            touch "$out"
          '';
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt-rfc-style
      );
    };
}
