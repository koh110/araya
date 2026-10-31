# araya development

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）に隔離します。`settings.json`・`auth.json`・`models.json`・`models-store.json`・`sessions/`・Pi SDK が管理する `bin/` はここに置き、runner の model cache は既存の `<dataDir>/runner/models-store.json` を維持します。host Pi からの fallback・copy・migration・symlink は追加しません。Araya 側の TUI（`araya` または `araya pi`）で `/login` と `/model` を設定し直してください。Araya 自身の `config.json`・台帳・runner storage の配置、既存 config の model は変更しません。旧 host agentDir を保存した running 試行は、再開前に host 設定を読まず既存の `attempt_error` で失敗させます。保存済み入力は書き換えず、再設定後の新規 retry を必要とします。DB schema 変更・rewrite・migration は行いません。

Pi SDK は import 時に環境変数から agent directory を読み、`bin/` の場所を module cache に固定します。実行時 import は `loadPiSdk(agentDir)` に集約し、最初の import より前に Araya の環境を束縛してください。runner・attempt へ Pi SDK の runtime static import を追加しないでください。回帰テストは host の `PI_*` を設定した新規 child process で、SDK が解決する `bin/` の path を検証します。親 test process が SDK を先に import すると、その module cache の binding は後から修正できません。

repository の中で araya をビルド・テスト・変更する人向けの文書です。`araya` の使い方は [README.md](../README.md)、動作の詳しい定義は [docs/spec/](spec/) にあります。

## checkout とテスト

- Node.js 26.8 以上
- Pi coding-agent SDK 1.4.0 は依存 package に含まれます。引数なしの `araya` または `araya pi` に、グローバルな `pi` コマンドは不要です。

```sh
npm ci
npm test
npm run typecheck
```

テストは一時 directory を使い、実際の SQLite と Pi Durable storage を通して状態遷移を検証します。model は pi-ai の faux provider を使い、Pi の認証情報と model の API は使いません。systemd の操作は、通常は test 用の差し替えを使います。本物の systemd の user manager を使う runner の test は、`ARAYA_TEST_SYSTEMD=1` を指定したときだけ実行します（unit file は書かずに、一時的な unit を作って消します）。

```sh
ARAYA_TEST_SYSTEMD=1 node --test packages/araya/test/task-runner-systemd.test.ts
```

## source の配置と import

`packages/araya/src/` は機能ごとに分けています。

- `cli/`: 引数解析と CLI command の実行
- `config/`: 環境変数、設定ファイル、model 設定
- `development/`: SHIKI、worktree、開発結果の収集。`draft-pr/` は Draft PR delivery と snapshot
- `runner/`: 試行、台帳、runner loop
- `infrastructure/`: subprocess、秘密の置換、systemd

import は相対 path と `.ts` 拡張子を使い、必要な module を直接参照します。build 時に `.js` へ変換します。

## CI

`.github/workflows/ci.yml` は pull_request と main への push で動きます。ubuntu-26.04（Node 26）の job が2つで、`test`（typecheck と `npm test`）と `systemd`（`ARAYA_TEST_SYSTEMD=1` で task-runner-systemd.test.ts を実行。linger を有効にして user manager を起動）です。

## checkout から動かす

global install をせずに、checkout からコマンドを試すことができます。

```sh
npm run araya -- --help
npm run araya -- task create --file task.json
npm run araya -- runner install
```

`araya runner install` を実行した araya のコードで runner が動きます（unit file の `ExecStart` は Node.js を起動し、runner の entrypoint の絶対 path を引数に渡します。`npm run deploy` で入れた araya なら、entrypoint は install 先の `packages/araya/dist/bin/task-runner.js` です）。checkout で `npm run araya -- runner install` を実行すると、runner はその checkout の `packages/araya/bin/task-runner.ts` で動きます。その checkout の file を変えると runner の動作が変わり、checkout を移動・削除すると runner は起動できなくなります。

## deploy の仕組み

root で `npm run deploy`（`scripts/deploy.sh`）を実行すると、次のことが起きます。

1. root package（version `0.0.1`）に `npm pack` を実行し、一時 tarball からユーザーの global prefix（既定 `$HOME/.local`、`ARAYA_INSTALL_PREFIX` で変更可）へ araya を install します。checkout への symlink ではないため、以後のソース変更は再 deploy まで反映されず、araya の checkout を移動・削除しても、install 済みコマンドは影響を受けません。npm registry への publish は行いません。指定 prefix 内に旧 `agentctl` package があれば先に `npm uninstall --global` を実行し、`araya` の bin 競合を解消してから置き換えます。
2. 入れた araya（`<prefix>/bin/araya`）で `araya runner install` を実行し、deploy の環境の `ARAYA_DATA_DIR`（無ければ `~/.araya`）の data directory の runner を新しいコードで入れ直して起動します（「runner の仕組み」）。初めての deploy では runner を入れ、止めてあった runner も起動します。動いていた試行は一時停止の扱いで続きから進みます（新しいコードで試行の進め方が変わったときは、`attempt_error` で失敗することがあります）。
3. unit file に書く `PATH` は、`npm run` が先頭に足した entry（checkout などの `node_modules/.bin` と、npm の `node-gyp-bin`）を除いた値になります。

- 対象の runner は、deploy を実行した環境の `ARAYA_DATA_DIR` のものです。unit file の `Environment=` も、その環境の値で書き直します。`~/.araya` 以外の `ARAYA_DATA_DIR` の runner を使っているときは、deploy を実行する環境の `ARAYA_DATA_DIR` にその値を設定してください。設定しないと、`~/.araya` の runner を入れます（使っている runner は、次に起動するまで前のコードのまま動き続けます）。
- `ARAYA_INSTALL_PREFIX` で別の prefix に入れたときも、runner はその prefix に入れた araya で動きます。
- runner を止めたままにするときは、deploy の後に `systemctl --user stop araya-runner-<hash>.service` を実行してください。
- deploy は、runner が起動したことまでは確かめません。出力の `runner.state` が `running` でなければ、`<dataDir>/logs/runner.log` を確認してください。
- Linux 以外の環境と、systemd の user manager に接続できない環境（`systemctl` が無い環境を含む）では、`araya runner install` が終了 code 69 で終わります。このとき deploy は、runner を入れずに注意を出し、成功で終わります。user manager に接続できない session（`su` で切り替えた session など）から deploy すると、動いている runner は、次に起動するまで前のコードのまま動き続けます。
- それ以外の理由で `araya runner install` が失敗したときは（`PATH` に unit file に書けない文字がある、など）、deploy は araya を入れたまま、終了 code 1 で終わります。理由を直してから `araya runner install` を実行してください。

別の prefix に入れる例:

```sh
ARAYA_INSTALL_PREFIX="$HOME/.npm-global" npm run deploy
```

prefix の `bin` directory が `PATH` に含まれていることを確認してください。

## runner の仕組み

runner は、SHIKI を動かすために常駐する Araya の process です。SHIKI は、試行ごとに runner の中で新しく作られる会話です（試行は Task を1回実行することで、再実行のたびに新しい試行になります）。Task が無い間も runner は動き続けますが、SHIKI は動かず、runner も model を呼びません。差分の収集、検証の実行、結果の判定と記録は、SHIKI ではなく runner が行います。runner は2秒ごとに台帳を見て、待ちの Task を古い順に取り込みます。

- unit file は `~/.config/systemd/user/araya-runner-<hash>.service`（`XDG_CONFIG_HOME` が絶対 path ならその下）に書き、`systemctl --user daemon-reload`・`enable`・`restart` を実行します。`<hash>` は `<dataDir>` の実 path の SHA-256 の先頭12文字で、`<dataDir>` ごとに runner は1つです。
- `<dataDir>/config.json` が無い場合、Pi の `settings.json` に有効な `defaultProvider` と `defaultModel` が両方あれば、`development.model` だけを mode 0600 で初期設定します。`thinkingLevel`・認証情報は写さず、API も呼びません。設定が無い・読めない・不正なら config を作らず warning を出して runner install は続けます。既存 config（`{}` を含む）は変更しません。出力の `config.status` は `created`・`existing`・`skipped` のいずれかです。
- unit file の `Environment=` には、`araya runner install` を実行した環境の `PATH`・`LANG`・`LANGUAGE`・`TZ`・`LC_*`・`ARAYA_*`（`TOKEN`・`SECRET`・`PASSWORD`・`API_KEY`・`AUTH` などを名前に含む、秘密とみなす変数を除く）・`PI_CODING_AGENT_DIR` だけを書きます。`ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` は絶対 path にして書きます。`PI_CODING_AGENT_DIR` は継承値ではなく `<ARAYA_DATA_DIR>/pi` の絶対 path に正規化します。ほかの変数（model の API key、proxy の設定など）は runner にも SHIKI にも渡りません。model の認証は Pi の `auth.json` から読みます。
- `<dataDir>` などの path と環境変数の値に、空白・引用符・`\`・`$`・`%`・`;`・制御文字があると、unit file を書かずに `unsupported_path` で失敗します。
- 環境変数を変えたとき、`araya runner install` をやり直すまで、unit file の `Environment=` は前の値のままで、runner は前の環境で動きます。動いている runner は、起動したときに読み込んだコードで動き続けます。
- `ARAYA_DATA_DIR` を変えて `araya runner install` を実行すると、`<hash>` が変わるので別の unit（別の runner）ができ、前の runner は動き続けます。前の runner を残さないときは、先に前の `ARAYA_DATA_DIR` で `araya runner uninstall` を実行してください。
- `systemctl --user stop` は一時停止です。動いていた試行は中止されず、次に起動したときに続きから進みます。runner が落ちたときは、systemd が間隔を空けて起動し直します。
- `araya runner uninstall` は unit を止めて無効にし、unit file を消します。台帳は変えないので、動いていた試行は `running` のまま残り、入れ直すと続きから進みます。
- runner の log は `<dataDir>/logs/runner.log`（1行1件の JSON、秘密を置き換えたもの）です。runner の stdout と stderr は捨てます。
- GitHub.com の Draft PR delivery は、runner が利用する `gh` CLI と、その OS user の保存済み `gh auth` 状態を使います。GitHub token を agent・evidence・log・command arguments に渡したり記録したりしません。`gh` が無い・認証できない場合や GitHub Enterprise / 他 host の remote は、success にせず `blocked` にします。
- SHIKI の bash は command ごとに、検証 command は1件ごとに、worktree 作成と差分収集の git も実行ごとに、さらに delivery の commit/push と GitHub CLI も各 command ごとに、それぞれ別の transient な systemd scope（名前は `araya-<hash>-<taskKey>-…`）の中で動きます。runner は、差分を集める前と結果を記録する前に、その試行の名前の scope をすべて止めるので、`setsid` などで切り離した process も残りません。
- `araya task` と `araya runner` は Linux と systemd（254 以降）の user manager が必要です。Linux 以外では何もせずに `unsupported_platform` で終わります。各コマンドは JSON 1件を stdout に出します。失敗したときは理由を stderr に出し、終了 code 1 で終わります。ただし、Linux 以外（`unsupported_platform`）と、systemd の user manager に接続できないとき（`systemd_unavailable`）は、終了 code 69 で終わります。
- `araya task` の各コマンドは、結果といっしょに台帳の `runner` と `queue` を出力に含めます。`runner.state` が `running` でないときは、出力とは別に stderr へ注意を出します（登録などの処理自体は成功します）。
- `araya runner install` は linger を変えずに読むだけで、出力に `linger` を含めます。`linger` が `false` のときは stderr に注意を出します。

## Task の内部

- `<dataDir>/tasks.sqlite` は Task・試行・途中経過・runner 状態を、`<dataDir>/runner/durable.sqlite` は Pi Durable の task graph・checkpoint・SHIKI の会話と tool 記録を保持します。別々の SQLite DB で、双方をまたぐ transaction はありません。会話・台帳・状態 directory・log・worktree は自動削除しません。会話には秘密が含まれることがあり、evidence/log の redaction 対象外なので、`ARAYA_DATA_DIR` と backup のアクセス権を管理してください。
- Task の入力・CLI・状態遷移・retry/cancel・evidence の詳しい契約は [Task と SHIKI の実行仕様](spec/task-ledger-and-shiki-runner.md) を参照してください。このガイドでは仕様を重ねて記述しません。
- Task は `araya task create` から登録します。自律的な課題発見、外部 source の監視、通知連携は未実装です。
- SHIKI と検証 command は sandbox なしで利用者の権限により動き、開発 root 外の書き込み可能 file や network にアクセスできます。SHIKI への禁止指示は強制境界ではありません。Araya は検証済みの変更について commit・push・Draft PR 作成まで行いますが、merge・deploy・publish はしません（[Draft PR delivery 仕様](spec/draft-pr-delivery.md)）。

## 設定

- `ARAYA_DATA_DIR` — データの directory（既定: `~/.araya`）。この文書では `<dataDir>` と書きます。
- `ARAYA_DEV_ROOT` — 開発 root（既定: `~/dev`）。runner の SHIKI がここで repository を探し、worktree を作ります。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS` / `ARAYA_VERIFICATION_TIMEOUT_MS` — [期限と数値の扱い](spec/task-ledger-and-shiki-runner.md#期限)
- 内蔵 Pi の agent directory は絶対 path の `<ARAYA_DATA_DIR>/pi`（既定 `~/.araya/pi`）です。TUI・runner・SHIKI・runner install はこの directory を使います。継承した `PI_CODING_AGENT_DIR` と `PI_CODING_AGENT_SESSION_DIR` は保存先に使いません。Pi 専用 settings や明示 CLI 引数による通常の機能は使えます。
- `ARAYA_INSTALL_PREFIX` — deploy の install prefix（「deploy の仕組み」）
- `ARAYA_TEST_SYSTEMD` — 本物の systemd user manager を使う test を実行するかどうか（「checkout とテスト」）

### 設定ファイル

設定ファイル `<dataDir>/config.json`（既定: `~/.araya/config.json`）は、runner の SHIKI が使う model と thinking level を選びます。保存場所は `ARAYA_DATA_DIR` に従い、専用の path 環境変数はありません。`task`・`runner` command の開始時と、runner が試行を取り込むときに読み込みます。

schema、初期設定、model の選び方、エラー時の挙動は [開発 model の設定](spec/development-model-config.md) にまとめています。この文書では設定値の詳細を重ねて記述しません。

## 状態と安全境界

- `<dataDir>/tasks.sqlite` は開発 Task・試行・途中経過・runner 状態を保持し、`<dataDir>/runner/durable.sqlite` は Pi Durable の task graph、checkpoint、SHIKI の会話と tool 記録を保持します。`araya task show --full` が表示するのは evidence で、会話全文を閲覧・export する CLI はありません。
- 会話と task ledger は別の SQLite DB で、両方をまたぐ単一 transaction はありません。DB、試行の状態 directory、log、worktree と branch は自動削除しません。
- 会話には課題本文、model の応答、tool の引数と出力が含まれ得ます。会話 DB はevidence/logの redaction 対象ではないため、`ARAYA_DATA_DIR` と backup のアクセス権を管理してください。
- 自律的な課題発見、外部ソース監視、通知連携は未実装です。Task は `araya task create` から登録します。
- runner の SHIKI と検証コマンドは利用者の権限で sandbox なしに動き、開発 root 以外の書き込み可能 file にも触れます。SHIKI には自分で commit・push・PR 作成・merge・deploy・publish をしないよう指示しますが、network 制限や sandbox はなく、直接 remote を変更する可能性があります。Araya の built-in delivery は全検証成功後に commit・push・GitHub.com Draft PR 作成を行い、merge・deploy・publish はしません。詳しくは [Draft PR delivery 仕様](spec/draft-pr-delivery.md) を見てください。
