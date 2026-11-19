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

# Discord bot の data directory と、その設定 file（.env）
ARAYA_DATA_DIR_RESOLVED=${ARAYA_DATA_DIR:-$HOME/.araya}
DISCORD_ENV_FILE=$ARAYA_DATA_DIR_RESOLVED/.env

# .env に 1Password の参照（値が op:// で始まる行）があれば、araya discord install は op run で参照を解決して
# --auth-mode 1password で実行する。op と OP_SERVICE_ACCOUNT_TOKEN が揃わないときは、araya を入れ替える前に止める
OP_BIN=''
if [ -f "$DISCORD_ENV_FILE" ] && grep -Eq '^[[:space:]]*[A-Z][A-Z0-9_]*[[:space:]]*=[[:space:]]*op://' "$DISCORD_ENV_FILE"; then
  OP_BIN=$(command -v op || true)
  if [ -z "$OP_BIN" ]; then
    printf '%s\n' "error: $DISCORD_ENV_FILE に 1Password の参照（op://）がありますが、PATH に 1Password CLI（op）がありません。araya は入れ替えていません" >&2
    exit 1
  fi
  if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
    printf '%s\n' "error: $DISCORD_ENV_FILE に 1Password の参照（op://）があります。OP_SERVICE_ACCOUNT_TOKEN を設定してから実行してください。araya は入れ替えていません" >&2
    exit 1
  fi
fi

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
if [ ! -f "$DISCORD_ENV_FILE" ]; then
  printf '%s\n' "Discord の設定（$DISCORD_ENV_FILE）が無いため、Discord bot の unit は入れませんでした。araya discord init → araya discord install を実行してください" >&2
else
  DISCORD_PATH=$(path_without_npm_run_entries)
  discord_status=0
  if [ -n "$OP_BIN" ]; then
    # op run は参照を解決した値を環境変数で渡し、子の終了 code をそのまま返す
    retry_command="op run --env-file=$DISCORD_ENV_FILE -- araya discord install --auth-mode 1password"
    printf '%s\n' 'op run で .env の 1Password の参照を解決して、araya discord install --auth-mode 1password を実行します'
    PATH=$DISCORD_PATH "$OP_BIN" run --env-file="$DISCORD_ENV_FILE" -- "$PREFIX/bin/araya" discord install --auth-mode 1password || discord_status=$?
  else
    retry_command='araya discord install'
    printf '%s\n' 'araya discord install を実行します'
    PATH=$DISCORD_PATH "$PREFIX/bin/araya" discord install || discord_status=$?
  fi
  if [ "$discord_status" -eq 69 ]; then
    # systemd の user manager が使えないが、araya のコマンドは使える
    printf '%s\n' 'この環境では systemd の user manager を使えないため、Discord bot の unit を入れずに終わります（araya は入れました）' >&2
  elif [ "$discord_status" -ne 0 ]; then
    printf '%s\n' "error: araya は入れましたが、Discord bot の unit を入れられませんでした。上の理由を直してから、$retry_command を実行してください" >&2
    exit 1
  fi
fi
