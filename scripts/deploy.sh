#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
if [ -n "${ARAYA_INSTALL_PREFIX:-}" ]; then
  PREFIX=$ARAYA_INSTALL_PREFIX
else
  : "${HOME:?set HOME or ARAYA_INSTALL_PREFIX}"
  PREFIX=$HOME/.local
fi
PACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/araya-deploy.XXXXXX")

cleanup() {
  rm -rf "$PACK_DIR"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# npm run は、PATH の先頭に、package の directory から / までの各 directory の node_modules/.bin と、
# npm の node-gyp-bin を足す（npm run の中で npm run を実行すると、重ねて足す）。
# 先頭から続くこのまとまりを外した PATH を出す。npm run を通さずに実行したときは、PATH をそのまま出す
path_without_npm_run_entries() {
  rest=$PATH
  kept=$PATH
  while [ -n "$rest" ]; do
    entry=${rest%%:*}
    case $rest in
      *:*) rest=${rest#*:} ;;
      *) rest='' ;;
    esac
    case $entry in
      */node_modules/.bin) ;;
      */node-gyp-bin) kept=$rest ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$kept"
}

cd "$REPO_ROOT"
npm pack --pack-destination "$PACK_DIR"
set -- "$PACK_DIR"/*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf 'error: expected exactly one package tarball in %s\n' "$PACK_DIR" >&2
  exit 1
fi

npm uninstall --global --prefix "$PREFIX" --no-audit --no-fund agentctl
# 同名・同versionの既存symlinkをnpmがup-to-date扱いしないよう強制置換する。
npm install --global --prefix "$PREFIX" --no-audit --no-fund --force "$1"

# 入れた araya で Discord bot の unit を入れ直し、新しいコードで起動し直す（止めてあった unit も起動する）。
# unit file には PATH を書くので、npm run が足した entry（checkout の node_modules/.bin など）を外して渡す。
# araya は、この環境では Discord bot を使えないとき（Linux 以外か、systemd の user manager に接続できない）に終了 code 69 で終わる
ARAYA_DATA_DIR_RESOLVED=${ARAYA_DATA_DIR:-$HOME/.araya}
if [ ! -f "$ARAYA_DATA_DIR_RESOLVED/.env" ]; then
  printf '%s\n' "Discord の設定（$ARAYA_DATA_DIR_RESOLVED/.env）が無いため、Discord bot の unit は入れませんでした。araya discord init → araya discord install を実行してください" >&2
else
  DISCORD_PATH=$(path_without_npm_run_entries)
  printf '%s\n' 'araya discord install を実行します'
  discord_status=0
  PATH=$DISCORD_PATH "$PREFIX/bin/araya" discord install || discord_status=$?
  if [ "$discord_status" -eq 69 ]; then
    # systemd の user manager が使えないが、araya のコマンドは使える
    printf '%s\n' 'この環境では systemd の user manager を使えないため、Discord bot の unit を入れずに終わります（araya は入れました）' >&2
  elif [ "$discord_status" -ne 0 ]; then
    printf '%s\n' 'error: araya は入れましたが、Discord bot の unit を入れられませんでした。上の理由を直してから、araya discord install を実行してください' >&2
    exit 1
  fi
fi
