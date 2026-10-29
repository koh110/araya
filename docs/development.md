# araya development

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
- unit file の `Environment=` には、`araya runner install` を実行した環境の `PATH`・`LANG`・`LANGUAGE`・`TZ`・`LC_*`・`ARAYA_*`（`TOKEN`・`SECRET`・`PASSWORD`・`API_KEY`・`AUTH` などを名前に含む、秘密とみなす変数を除く）・`PI_CODING_AGENT_DIR` だけを書きます。`ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` は絶対 path にして書きます。ほかの変数（model の API key、proxy の設定など）は runner にも SHIKI にも渡りません。model の認証は Pi の `auth.json` から読みます。
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

- 台帳 `<dataDir>/tasks.sqlite` が開発の Task と試行、途中経過、runner の状態を保持します。runner の Pi Durable の storage（SHIKI の会話）は `runner/durable.sqlite` です。
- Task の入力: 知らない key、長さや件数の超過、256 KiB を超える入力、NUL、空白だけの値は拒否します。`title` は200文字まで（改行なし）、`goal` は20,000文字まで。`constraints`・`targets`・`permissions` は省略すると `[]` です。`targets` は SHIKI に作業 repository を探してもらうための手がかり（開発 root からの相対 path など）で、制限ではありません。どの repository で作業するかは SHIKI が判断します。repository は worktree の作成時に確かめ、選ばれた repository が開発 root の外なら `repository_outside_dev_root`、存在しないなら `repository_not_found` を tool error として SHIKI に返します。tool の失敗だけでは課題全体は止まらず、SHIKI は別の repository を選び直せます（[docs/spec/human-authored-development-loop.md](spec/human-authored-development-loop.md)）。`targets` は SHIKI が触れる file の制限にもなりません（「状態と安全境界」）。`permissions` は SHIKI へ渡す制約情報で、SHIKI の固定指示（commit・push・PR 作成・merge・deploy・publish をしない）を解除しません。Araya は全検証成功後に commit・push・Draft PR 作成を行います。merge・deploy・publish は行いません。登録は `idempotencyKey` で idempotent です。同じ `idempotencyKey` で2回登録すると、同じ Task を `"created": false` で返します。`idempotencyKey` が同じでほかの項目の値が違う場合は、`idempotency_conflict` で拒否します。
- CLI の引数:

```sh
araya task create --file <path|->
araya task list [--status <状態>] [--limit <1〜200>]
araya task show <taskId> [--events <0〜500>] [--full]
araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]
araya task cancel <taskId>
araya runner install
araya runner uninstall
```

- `task show` の出力の `attempts[].taskKey` で試行の taskKey が確かめられます。evidence には差分の統計、検証の結果、`activeMs` などが入ります。`--full` のときだけ、SHA-256 が台帳の記録と一致する `evidence.json` から本文を出します。
- 前回の試行が中断された、または Draft PR 配送で remote branch/PR が更新されたか確認できない場合は、`--confirm-side-effects` を付けないと `side_effects_unconfirmed` で拒否されます。
- `cancel` は、待機中の試行をその場で `failed`（`cancelled`）にし、`running` の試行には中止を求めます（runner が動いていれば数秒以内に止め、`failed`（`cancelled`）になります。runner が止まっているときは、次に runner が起動したときに止めます）。`completed`・`failed`・`blocked` の Task は中止できません。
- SHIKI 1回の期限は `ARAYA_DEVELOPMENT_TIMEOUT_MS`（既定 1200000 ms、範囲 1000〜3600000 ms。範囲外の値は範囲に丸め、数でない値は既定値にします）。過ぎると `failed`（`agent_timeout`）になります。検証コマンドは1件ごとに `ARAYA_VERIFICATION_TIMEOUT_MS`（既定 300000 ms、同じ範囲）で打ち切ります。どちらも runner が動いていた時間で数えます（一時停止の間は数えません）。
- 秘密とみなす環境変数の値と URL の userinfo は、台帳・`evidence.json`・log に書く前に `[REDACTED]` に置き換えます。それ以外の秘密（file の中身など）を SHIKI が報告に書いたり、検証コマンドが出力したりすると残ります。
- 台帳、Pi Durable の storage、試行の状態 directory、log、worktree と branch は自動では消しません。

## 設定

- `ARAYA_DATA_DIR` — データの directory（既定: `~/.araya`）。この文書では `<dataDir>` と書きます。
- `ARAYA_INBOX_DIR` — JSONL inbox（既定: `<dataDir>/inbox`）
- `ARAYA_STATUS_FILE` — 状態スナップショット（既定: `<dataDir>/status.json`）
- `ARAYA_CONTROL_PLANE_PATH` — Goal / Opportunity / decision / event / outbox DB
- `ARAYA_PI_DURABLE_PATH` — Pi Durable task graph DB
- `ARAYA_INTERVAL_MS` — 次回起床間隔（既定: 900000 ms。`run` の loop 用。runner の task 取得は2秒ごとに台帳を見ます）
- `ARAYA_MAX_ACTIONS` — 1 tick あたりの処理候補数上限（既定: 3）
- `ARAYA_DEV_ROOT` — 開発 root（既定: `~/dev`）。runner の SHIKI がここで repository を探し、worktree を作ります。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS` / `ARAYA_VERIFICATION_TIMEOUT_MS` — 「Task の内部」
- `PI_CODING_AGENT_DIR` — Pi の agent directory。Pi と Araya の両方で同じ値を使うと、`tick` / `run` のモデル runtime が Pi と同じ `auth.json` と `models.json` を参照します（`tick` / `run` はモデルを呼び出しません）。runner の SHIKI も同じ directory の `auth.json` と `models.json` を使います。未指定時は `~/.pi/agent` を使用します。
- `ARAYA_INSTALL_PREFIX` — deploy の install prefix（「deploy の仕組み」）
- `ARAYA_TEST_SYSTEMD` — 本物の systemd user manager を使う test を実行するかどうか（「checkout とテスト」）

### 設定ファイル

設定ファイル `<dataDir>/config.json`（既定: `~/.araya/config.json`）は、runner の SHIKI の model と thinking level を選ぶための設定です。場所は `ARAYA_DATA_DIR` に従い、設定ファイルの場所だけを変える環境変数はありません。利用者向けの概要は README にあります。

- 形式は UTF-8 の JSON object で、64 KiB まで。top level の key は `development`（省略可）だけです。`{}` やファイルが無い場合は、Pi の `settings.json` の `defaultProvider`・`defaultModel` で決まる model を使います。runner install（`npm run deploy` を含む）時に Araya の config が無く、両方の値が有効なら、`development.model` に `<defaultProvider>/<defaultModel>` を一度だけ保存します。既存 file は `{}` でも変更しません。Pi の設定に default が無い・読めない・不正なら file を作らず warning を出します。保存後は Pi の default model を変えても Araya の設定には追従しないため、切り替える場合は `config.json` の `development.model` を更新してください。使う model が決まらない、Pi の model の一覧に無い、認証が無いときは、別の model に切り替えず、試行を `failed`（`agent_failed`、evidence の `agent.error` は `model_unavailable`）にします。
- `development.model`（必須）: `<provider>/<model id>`。最初の `/` で provider と model id に分けるため、model id には `/` を含められます（例: `openrouter/moonshotai/kimi-k2.6`）。provider と model id は空にできず、空白と制御文字を含めず、全体で200文字まで。
- `development.thinkingLevel`（省略可）: `off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれか。省略すると Pi の設定（`modelThinkingLevels["<provider>/<id>"]` → `defaultThinkingLevel` → `medium`）で決まります。Pi は model が対応しない thinking level を対応する値に丸めます。
- 知らない key、型の違う値、`null` は拒否します。ファイルが存在するのに使えない場合（JSON の誤り、schema 違反、64 KiB 超、UTF-8 でない、通常の file でない、壊れた symlink、読めない）は、`init`・`tick`・`status`・`run`・`approve`・`reject`・`task`・`runner` が何も処理せずに `invalid Araya config file <path>: <理由>` で失敗します（終了 code 1）。引数なしの `araya`・`araya pi`・`araya --help` は設定ファイルを読みません。
- 設定ファイルは subcommand の起動時に1回だけ読みます。`araya run` の実行中に書き換えた内容は、再起動するまで反映されません。runner は試行を取り込むたびに読み、取り込んだ時点の値をその試行に使います（使えないときは取り込まずに待ち、log に書きます）。
- `araya status` の出力と `status.json` の `config` に、`configPath` と `developmentModel`（`{ "model": "<provider>/<id>", "thinkingLevel": ... }`、未指定なら `null`）が入ります。status は Pi の認証を読まないため、model が実際に使えるかは表示しません。
- 利用上限に達したときの fallback model と自動 retry は未対応です。`fallbackModels` などの key は知らない key として拒否します。

詳しい規則は [docs/spec/development-model-config.md](spec/development-model-config.md) を見てください。

## inbox 形式

`ARAYA_INBOX_DIR` 配下の `.jsonl` ファイルを読みます。各行は JSON object です。通常候補の例:

```json
{"id":"candidate:example","kind":"investigate","title":"対象の状態を確認する","risk":"read-only","payload":{"source":"local-note"}}
```

開発課題の例:

```json
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"araya の入力で空の値を拒否し、既存のテストに回帰ケースを追加する"}}
```

`development` 行の取り込みでは形を検証します。`payload` は `task` だけを持ちます（空白以外の文字を含む20,000文字以内、NULなし）。`task` 以外の key を持つ課題は intake で拒否します。

取り込んだ `development` 課題は実行しません。次の due tick で Araya は、agent もモデルも起動せずに課題を `blocked`（evidence の `type` は `development_executor_unavailable`）にします。worktree の作成、差分の収集、検証コマンドの実行も行いません。開発の課題は `araya task create` で登録してください。

`risk` は `read-only`、`workspace`、`external` のいずれかです。`workspace` は `kind: "development"` 専用です。`id` は省略可能ですが、再投入時の重複防止には安定した ID を指定してください。不正行・重複 ID・読み取りエラーは `inbox.read_errors` event に記録します。不正な行は候補に含めず、同じ読み込みで有効だった行は処理対象になることがあります。そのため `tick` の `due` は入力全件が正常だった保証ではありません。inbox の内容はデータとして扱います。`development` の `payload.task` も実行されません。

## 旧経路（`init` / `tick` / `status` / `run` / `approve` / `reject`）

開発の課題を動かすために使うものではありません。

```sh
export ARAYA_DATA_DIR="$HOME/.local/state/araya-demo"
npm run araya -- init
npm run araya -- tick
npm run araya -- status
```

`init` は初期状態と `inbox/seed.jsonl` を作ります。seed が既にあれば上書きしません。`tick` は due goal を一度処理し、`status` は保留中の Pi Durable の task を再開せずに control plane と Pi Durable の状態を表示します。

継続起動を手動で試す場合は `npm run araya -- run` を使い、`ARAYA_INTERVAL_MS` ごとに tick が回り、Ctrl+C で止めます。`run` は前景プロセスの loop であり、OS 起動時の自動起動・監視・再起動を設定しません。次回起床時刻は control plane DB に保存されますが、長期停止後の復旧・重複実行を含む採用条件はまだ検証完了していません。

引数なしの `araya` は Pi の interactive TUI を同じ Node.js プロセス内で起動しますが、Araya の `tick` は自動実行しません。`araya pi [arguments...]` は指定した引数を Pi coding-agent SDK の CLI entry point に渡します。引数なしの `araya` と `araya pi` は `@earendil-works/pi-coding-agent` の CLI entry point を同じ Node.js プロセス内で実行し、その動作・権限・副作用は Pi 側の設定に従います。

初期 seed を処理したときの状態遷移は次のとおりです。

- executor がない `read-only` 候補: `blocked`（`no_read_only_executor`）
- `external` 候補: `approval_requested`
- `approve <opportunityId>` 後: 次の処理で `blocked`（`no_external_executor`）
- 承認通知用 outbox: `pending` のまま。送信処理はありません。

`tick` の `due` は「処理時刻が来て tick を実行した」という意味で、候補が実行・完了した保証ではありません。`araya approve <opportunityId> [note…]` と `araya reject <opportunityId> [note…]` は判断（note は省略可）を記録するだけで、外部操作を開始しません。

## 状態と安全境界

- `tasks.sqlite` が開発の Task と試行、途中経過、runner の状態を保持します。runner の Pi Durable の storage（SHIKI の会話）は `runner/durable.sqlite` です。
- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。Pi Durable 1.4.0 で既存 DB を開くと schema v2 へ自動移行されます。移行後は同じ DB を Pi Durable 1.3.0 以下で開けないため、初回利用前に DB をバックアップしてください。
- これらの SQLite DB（`tasks.sqlite`・`runner/durable.sqlite`・`araya.sqlite`・`pi-durable.sqlite`）をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- `read-only` / `external` の実行 executor がない候補は `completed` と偽らず、`blocked` として残します。
- Araya の通常 control-plane 処理は外部書き込みや通知送信をしません。`tick` / `run` は、Pi Durable の harness を開くときに Pi のモデル runtime を作りますが、モデルは呼び出しません。Pi の認証情報は `PI_CODING_AGENT_DIR`（未指定時は `~/.pi/agent`）から読み取り、Araya の設定や DB には複製しません。引数なしの `araya` と `araya pi` は明示的に Pi coding-agent SDK の CLI entry point を実行するため、その実行はこの節の対象外です。
- 自律的な課題発見、Goal / 探索対象の設定、外部ソース監視、`read-only` / `external` 候補の executor、Native Broker、Discord / Hermes 連携、Outbox 配信、旧経路（`tick` / `run`）の常駐化は未実装です。`run` を起動しても、新しい課題を自律的に発見するわけではありません。
- inbox の `development` 課題は実行せず `blocked` として残します（`development_executor_unavailable`）。
- runner の SHIKI と検証コマンドは利用者の権限で sandbox なしに動き、開発 root 以外の書き込み可能 file にも触れます。SHIKI には自分で commit・push・PR 作成・merge・deploy・publish をしないよう指示しますが、network 制限や sandbox はなく、直接 remote を変更する可能性があります。Araya の built-in delivery は全検証成功後に commit・push・GitHub.com Draft PR 作成を行い、merge・deploy・publish はしません。詳しくは [Draft PR delivery 仕様](spec/draft-pr-delivery.md) を見てください。
- DB や inbox に利用者のデータを置く場合は、`ARAYA_DATA_DIR` とバックアップのアクセス権を利用者側で管理してください。
