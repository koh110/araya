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

# 入れた araya で runner を入れ直し、新しいコードで起動し直す（止めてあった runner も起動する）。
# runner の unit file には PATH を書くので、npm run が足した entry（checkout の node_modules/.bin など）を外して渡す。
# araya は、この環境では runner を使えないとき（Linux 以外か、systemd の user manager に接続できない）に終了 code 69 で終わる
RUNNER_PATH=$(path_without_npm_run_entries)
printf '%s\n' 'araya runner install を実行します'
runner_status=0
PATH=$RUNNER_PATH "$PREFIX/bin/araya" runner install || runner_status=$?
if [ "$runner_status" -eq 69 ]; then
  # runner は使えないが、araya のコマンドは使える
  printf '%s\n' 'この環境では runner を使えないため、runner を入れずに終わります（araya は入れました）' >&2
elif [ "$runner_status" -ne 0 ]; then
  printf '%s\n' 'error: araya は入れましたが、runner を入れられませんでした。上の理由を直してから、araya runner install を実行してください' >&2
  exit 1
fi
