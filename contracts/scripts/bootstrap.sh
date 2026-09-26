#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib
fetch() {
  local repo="$1" path="$2" revision="$3"
  if [ ! -d "$path/.git" ]; then
    git init "$path"
    git -C "$path" remote add origin "$repo"
  fi
  git -C "$path" fetch origin "$revision" --depth 1
  git -C "$path" checkout --detach "$revision"
  test "$(git -C "$path" rev-parse HEAD)" = "$revision"
}
fetch https://github.com/1inch/aqua.git lib/aqua ef24220ed9647555727b06867bf509cd6959d84b
fetch https://github.com/1inch/swap-vm.git lib/swap-vm feb16411738331f7d05ae71d4a664154068018fc
fetch https://github.com/foundry-rs/forge-std.git lib/forge-std 8e40513d678f392f398620b3ef2b418648b33e89
fetch https://github.com/1inch/solidity-utils.git lib/solidity-utils 2d91bb67665467afc06907a69513b0fa66c46f0d
fetch https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts c64a1edb67b6e3f4a15cca8909c9482ad33a02b0
forge build
