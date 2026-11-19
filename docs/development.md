# araya development

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）に置きます。`settings.json`・`auth.json`・`models.json`・`models-store.json`・`sessions/`・Pi SDK が管理する `bin/` はここに置きます。Araya 側の TUI（`araya` または `araya pi`）で `/login` と `/model` を設定します。

Pi SDK は import 時に環境変数から agent directory を読み、`bin/` の場所を module cache に固定します。実行時 import は `loadPiSdk(agentDir)` に集約し、最初の import より前に Araya の環境を束縛してください。Pi SDK の runtime static import を他の module に追加しないでください。回帰テストは新規 child process で、SDK が解決する `bin/` の path を検証します。親 test process が SDK を先に import すると、その module cache の binding は後から修正できません。

repository の中で araya をビルド・テスト・変更する人向けの文書です。`araya` の使い方は [README.md](../README.md)、model 設定の定義は [docs/spec/agent-model-config.md](spec/agent-model-config.md)、Discord 会話の定義は [docs/spec/discord-persistent-chat.md](spec/discord-persistent-chat.md) にあります。

## checkout とテスト

- Node.js 26.8 以上
- Pi coding-agent SDK 1.5.0 は依存 package に含まれます。引数なしの `araya` または `araya pi` に、グローバルな `pi` コマンドは不要です。

```sh
npm ci
npm test
npm run typecheck
```

テストは一時 directory を使い、実際の SQLite と Pi Durable storage を通して状態遷移を検証します。model は pi-ai の faux provider を使い、Pi の認証情報と model の API は使いません。systemd の操作（`systemctl`・`loginctl`）は test 用の差し替え（`test/support/fake-systemd.ts`）を使い、本物の systemd user manager を要求する test はありません。Discord gateway も fake で差し替えます（`test/support/discord-bot-process.mjs` は bot process を実際に起動する test に使います）。

## source の配置と import

`packages/araya/src/` は機能ごとに分けています。

- `cli/`: 引数解析と CLI command（`araya discord init`・`install`・`uninstall`・`run`）の実行
- `config/`: 環境変数、設定ファイル、model 設定
- `agent/`: Discord 会話の main agent、model 解決、Pi durable session host（`openArayaAgentHost()`）
- `discord/`: Discord gateway、会話入口、bot state、env/op launcher
- `infrastructure/`: subprocess 実行、秘密の置換、systemd unit

`packages/araya/bin/` は起動 entrypoint（`cli.ts`、`discord-bot.ts`、`discord-env-runner.ts`、`discord-op-runner.ts`）です。unit file の `ExecStart` は Node.js で dist の absolute path を実行します。

import は相対 path と `.ts` 拡張子を使い、必要な module を直接参照します。build 時に `.js` へ変換します。

## CI

`.github/workflows/ci.yml` は pull_request と main への push で動きます。ubuntu-26.04（Node 26）の job は `test`（typecheck と `npm test`）1 つです。unit file を実際に書く操作は fake systemd への差し替えで検証し、CI の中で本物の systemd user manager は使いません。

## checkout から動かす

global install をせずに、checkout からコマンドを試すことができます。

```sh
npm run araya -- --help
npm run araya -- discord init
npm run araya -- discord run
```

`araya discord run` は foreground で 1 度だけ bot を動かす試験起動です。`araya discord install` を checkout から実行すると、unit file の `ExecStart` はその checkout の `packages/araya/dist/`（build 済み code）を指します。checkout を移動・削除すると unit は起動できなくなります。

## deploy の仕組み

root で `npm run deploy`（`scripts/deploy.sh`）を実行すると、次のことが起きます。

1. root package（version `0.0.1`）に `npm pack` を実行し、一時 tarball からユーザーの global prefix（既定 `$HOME/.local`、`ARAYA_INSTALL_PREFIX` で変更可）へ araya を install します。checkout への symlink ではないため、以後のソース変更は再 deploy まで反映されず、araya の checkout を移動・削除しても、install 済みコマンドは影響を受けません。npm registry への publish は行いません。指定 prefix 内に旧 `agentctl` package があれば先に `npm uninstall --global` を実行し、`araya` の bin 競合を解消してから置き換えます。
2. data directory（deploy の環境の `ARAYA_DATA_DIR`、無ければ `~/.araya`）に `.env` がある場合だけ、入れた araya（`<prefix>/bin/araya`）で `araya discord install` を実行し、その data directory の Discord bot unit を新しいコードで入れ直して起動します（「Discord bot unit の仕組み」）。`.env` が無い場合は unit を入れず、`araya discord init` への案内を出して成功で終わります。`.env` に 1Password の参照（値が `op://` で始まる行。コメント行は除く）がある場合は、`op run --env-file=<dataDir>/.env -- <prefix>/bin/araya discord install --auth-mode 1password` で実行し、参照を解決した値で検証してから unit を入れ直します。この場合、`npm pack` より前に PATH の `op` と `OP_SERVICE_ACCOUNT_TOKEN` を確かめ、どちらかが無ければ araya を入れ替えずに終了 code 1 で終わります。
3. unit file に書く `PATH` は、`npm run` が先頭に足した entry（checkout などの `node_modules/.bin` と、npm の `node-gyp-bin`）を除いた値になります。

- 対象の bot は、deploy を実行した環境の `ARAYA_DATA_DIR` のものです。unit file の `Environment=` も、その環境の値で書き直します。`~/.araya` 以外の `ARAYA_DATA_DIR` の bot を使っているときは、deploy を実行する環境の `ARAYA_DATA_DIR` にその値を設定してください。設定しないと、`~/.araya` の bot を入れます（使っている bot は、次に起動するまで前のコードのまま動き続けます）。
- `ARAYA_INSTALL_PREFIX` で別の prefix に入れたときも、bot はその prefix に入れた araya で動きます。
- Linux 以外の環境と、systemd の user manager に接続できない環境（`systemctl` が無い環境を含む）では、`araya discord install` は終了 code 69 で終わります。このとき deploy は、unit を入れずに注意を出し、成功で終わります。user manager に接続できない session（`su` で切り替えた session など）から deploy すると、動いている bot は、次に起動するまで前のコードのまま動き続けます。
- それ以外の理由で `araya discord install` が失敗したときは（`PATH` に unit file に書けない文字がある、unit の restart が失敗した、など）、deploy は araya を入れたまま、終了 code 1 で終わります。理由を直してから、表示された command（`araya discord install`、1Password の参照がある `.env` では `op run --env-file=... -- araya discord install --auth-mode 1password`）を実行してください。

別の prefix に入れる例:

```sh
ARAYA_INSTALL_PREFIX="$HOME/.npm-global" npm run deploy
```

prefix の `bin` directory が `PATH` に含まれていることを確認してください。

## Discord bot unit の仕組み

- unit file は `~/.config/systemd/user/araya-discord-<hash>.service`（`XDG_CONFIG_HOME` が絶対 path ならその下）に書き、`systemctl --user daemon-reload`・`enable`・`restart` を実行します。`<hash>` は `<dataDir>` の実 path の SHA-256 の先頭12文字で、`<dataDir>` ごとに bot は1つです。
- env-file mode の `ExecStart` は `/usr/bin/env <launcher>` で、launcher が `.env`（`EnvironmentFiles=-` の optional 指定も可）を解決して bot process を起動します。1Password mode は `OP_SERVICE_ACCOUNT_TOKEN` の値を unit file に書かず、`LoadCredentialEncrypted=` で復号した credential から 1Password CLI launcher を起動します。
- unit file の `Environment=` には、`araya discord install` を実行した環境の `PATH`・`LANG`・`LANGUAGE`・`TZ`・`LC_*`・`ARAYA_*`（`TOKEN`・`SECRET`・`PASSWORD`・`API_KEY`・`AUTH` などを名前に含む、秘密とみなす変数を除く）だけを書きます。`ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` は絶対 path にして書きます。内蔵 Pi の保存先変数 `ARAYA_CODING_AGENT_DIR` は `<ARAYA_DATA_DIR>/pi` の絶対 path に正規化します。ほかの変数（model の API key、proxy の設定など）は bot に渡りません。model の認証は Pi の `auth.json` から読みます。
- bot process の実行時環境から GitHub token 変数（`GH_TOKEN`・`GITHUB_TOKEN` 等）を除き、`GH_CONFIG_DIR`・`GH_HOST` selector だけを引き継ぎます（README「GitHub の repository へアクセスさせる」）。
- `<dataDir>` などの path と環境変数の値に、空白・引用符・`\`・`$`・`%`・`;`・制御文字があると、unit file を書かずに `unsupported_path` で失敗します。
- 環境変数を変えたとき、`araya discord install` を実行し直すまで、unit file の `Environment=` は前の値のままで、bot は前の環境で動きます。
- `ARAYA_DATA_DIR` を変えて `araya discord install` を実行すると、`<hash>` が変わるので別の unit（別の bot）ができ、前の bot は動き続けます。前の bot を残さないときは、先に前の `ARAYA_DATA_DIR` で `araya discord uninstall` を実行してください。
- install は restart 後に `<dataDir>/discord/state.json` の ready state（readyId・lastReadyAt・readyGeneration）で起動を確かめます。state に credential の値は書きません。確かめられない場合は install が失敗で終わり、service は起動したまま残ることがあります。
- bot の log は `<dataDir>/logs/discord.log`（1行1件の JSON、秘密を置き換えたもの）です。bot の stdout と stderr は捨てます。env-file launcher の失敗 note は `<dataDir>/logs/discord-launcher.log` に出ます。
- `araya discord` は Linux と systemd（254 以降）の user manager が必要です。Linux 以外では何もせずに `unsupported_platform` で終わります。失敗したときは理由を stderr に出し、終了 code 1 で終わります。Linux 以外（`unsupported_platform`）と、systemd の user manager に接続できないとき（`systemd_unavailable`）は、終了 code 69 で終わります。各 command は JSON 1件を stdout に出します。
- `araya discord install` は linger を変えずに読むだけで、出力に `linger` を含めます。`linger` が `false` のときは stderr に注意を出します。
- 古い slash command（`/araya task` 等）への interaction には、静的な「撤去されました」の ephemeral 応答を返すだけで、option の値はどこにも書きません。Discord 側の command 定義は araya からは削除しません（guild 側で削除する）。

## Discord 会話 agent（session-first）

Discord bot process は Pi durable の Harness を持ちます。許可された channel の main conversation が orchestrator で、`openArayaAgentHost()`（`src/agent/host.ts`）が model runtime・tool・child session を接続します。

- main conversation は coding tool（file 読取・編集・shell 実行。cwd は development root）を持ちます。会話と child session の graph は `<dataDir>/agent/agent.sqlite` に永続化され、再起動時は `harness.resume()` で復元します。
- main agent は Pi durable の child conversation を作成・送信・status 確認・中止でき、child 会話は main conversation の所有 background task に anchor され、main の run が終わっても動き続けます。reporter task が child へ依頼を届け、回答を待ち、followUp input として main conversation に injection します。main がそれをまとめて channel に送ります。report delivery は届くまで再送されます。
- task の作成・進捗・実行管理は Pi durable の session に任せます。araya 側の task 台帳・runner・side-effect gate・evidence 照合・worktree 強制・`/araya task` slash command は撤去済みです。Discord 側の境界は入口 allowlist と、channel に返す text の redaction のみです。
- model は `resolveAgentModel()`（`src/agent/model.ts`）が config `agent.model` → Pi settings（`<dataDir>/agent/agent-settings`）→ Pi の既定の順で解決します。
- `reset` / `stop` は Discord 入口（`src/discord/chat.ts`）で扱います。reset は main conversation を作り直し、stop は main の run・queued input・background child session へ中止を要求します。

## 設定

- `ARAYA_DATA_DIR` — データの directory（既定: `~/.araya`）。この文書では `<dataDir>` と書きます。
- `ARAYA_DEV_ROOT` — 開発 root（既定: `~/dev`）。agent の file tool・bash がここで repository を編集します。
- 内蔵 Pi の agent directory は `<ARAYA_DATA_DIR>/pi`（既定 `~/.araya/pi`）です。TUI・bot は `ARAYA_CODING_AGENT_DIR` でこの directory を使います。`ARAYA_CODING_AGENT_SESSION_DIR` は使いません（session の保存は `<dataDir>/agent/agent.sqlite`）。
- `ARAYA_INSTALL_PREFIX` — deploy の install prefix（「deploy の仕組み」）

### 設定ファイル

設定ファイル `<dataDir>/config.json`（既定: `~/.araya/config.json`）は、agent session が使う model と thinking level を選びます。保存場所は `ARAYA_DATA_DIR` に従い、専用の path 環境変数はありません。bot は起動時に 1 回読みます。

schema、model の選び方、エラー時の挙動は [agent model の設定](spec/agent-model-config.md) にまとめています。この文書では設定値の詳細を重ねて記述しません。

## 状態と安全境界

- `<dataDir>/agent/agent.sqlite` は main conversation、child session、task graph、checkpoint、tool 記録を保持します。DB・session の状態 directory・log は自動削除しません。
- 会話には課題本文、model の応答、tool の引数と出力が含まれ得ます。transcript は log の redaction 対象ではないため、`ARAYA_DATA_DIR` と backup のアクセス権を管理してください。credential を会話に投稿しないことが唯一の防御策です。
- agent（main も child も）は利用者の権限で sandbox なしに動き、開発 root 以外の書き込み可能 file にも触れ、`git`・`gh` で remote を直接変更できます。commit・push・PR 作成・merge かどうかは会話の中の依頼で決めます。araya 自体は merge・deploy・publish をしません。
- 自律的な課題発見、外部ソース監視、通知連携は未実装です。
