# araya

**実験用 MVP**。開発の課題は `araya task create` で Task の台帳に登録し、`araya runner install` で入れた runner（systemd の user service）が SHIKI（開発の agent）を動かします（仕様: [docs/spec/task-ledger-and-shiki-runner.md](docs/spec/task-ledger-and-shiki-runner.md)）。SHIKI は開発 root（既定 `~/dev`）の repository に課題用の worktree を作って実装し、Araya が SHIKI の登録した検証コマンドを実行して、結果を台帳に残します。Araya は commit・push・PR・merge・deploy を行いません。SHIKI にもしないよう指示しますが、強制はしません（「状態と安全境界」）。JSONL inbox に書いた `development` 課題は、inbox と `tick` / `run` の経路（旧経路）では実行せず、次のdue tickで `blocked` にします。自律的な課題発見、Goal / 探索対象の設定、外部ソース監視、read-only/external候補のexecutor、Native Broker、Discord/Hermes連携、Outbox配信、旧経路（`tick` / `run`）の常駐化は未実装です。`run`を起動しても、新しい課題を自律的に発見するわけではありません。引数なしの `araya` と `araya pi` は `@earendil-works/pi-coding-agent` のCLI entry pointを同じNode.jsプロセス内で実行し、その動作・権限・副作用はPi側の設定に従います。別途 `pi` CLIをインストールする必要はありません。

## 必要環境

- Node.js 24 以上
- Pi coding-agent SDK 1.4.0 は依存関係として含まれます。引数なしの `araya` または `araya pi` に、グローバルな `pi` コマンドは不要です。

```sh
npm ci
npm test
npm run typecheck
```

## 試す

```sh
export ARAYA_DATA_DIR="$HOME/.local/state/araya-demo"
npm run araya -- init
npm run araya -- tick
npm run araya -- status
```

`init` は初期状態と `inbox/seed.jsonl` を作ります。seed が既にあれば上書きしません。`tick` は due goal を一度処理し、`status` は保留中の Pi Durable の task を再開せずに control plane と Pi Durable の状態を表示します。データは既定で `~/.araya` に置かれます。

継続起動を手動で試す場合は `npm run araya -- run` を使い、ARAYA_INTERVAL_MS ごとに tick が回り、Ctrl+C で止めます。引数なしの `araya` は Pi の interactive TUI を同じ Node.js プロセス内で起動しますが、Araya の `tick` は自動実行しません。制御 plane を明示的に起動する場合は `araya tick`、ヘルプ表示は `araya --help` を使います。`araya pi [arguments...]` は指定した引数を Pi coding-agent SDK の CLI entry point に渡します。`run` は前景プロセスの loop であり、OS 起動時の自動起動・監視・再起動を設定しません。次回起床時刻は control plane DB に保存されますが、長期停止後の復旧・重複実行を含む採用条件はまだ検証完了していません。

初期 seed を処理したときの状態遷移は次のとおりです。

- executor がない `read-only` 候補: `blocked` (`no_read_only_executor`)
- `external` 候補: `approval_requested`
- `approve <opportunityId>` 後: 次の処理で `blocked` (`no_external_executor`)
- 承認通知用 outbox: `pending` のまま。送信処理はありません。

`tick` の `due` は「処理時刻が来て tick を実行した」という意味で、候補が実行・完了した保証ではありません。

## 開発の Task（`araya task` と runner）

開発の課題は Task として台帳（`<dataDir>/tasks.sqlite`）に登録します。常駐する runner が2秒ごとに台帳を見て、待ちの Task を古い順に取り込み、SHIKI を [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) の会話として動かします。SHIKI が終わると、Araya が worktree ごとの差分を集め、SHIKI が登録した検証コマンドを実行し、結果を台帳に記録します。1つの runner（`<dataDir>`）で同時に動く SHIKI は1件までで、ほかの Task は `queued` で待ちます。

`araya task` と `araya runner` は、`npm run deploy` で入れた `araya` で実行します（「グローバルインストール」）。runner は、`araya runner install` を実行した araya のコードで動きます（unit file の `ExecStart` は Node.js を起動し、runner の entrypoint の絶対 path を引数に渡します。`npm run deploy` で入れた araya なら、entrypoint は install 先の `packages/araya/dist/bin/task-runner.js` です）。checkout で `npm run araya -- runner install` を実行すると、runner はその checkout の `packages/araya/bin/task-runner.ts` で動きます。その checkout の file を変えると runner の動作が変わり、checkout を移動・削除すると runner は起動できなくなります。

`araya task` と `araya runner` は Linux と systemd（254 以降）の user manager が必要です。Linux 以外では何もせずに `unsupported_platform` で終わります。各コマンドは JSON 1件を stdout に出します。失敗したときは理由を stderr に出し、終了 code 1 で終わります。

### runner を入れる

```sh
araya runner install
```

- `~/.config/systemd/user/araya-runner-<hash>.service`（`XDG_CONFIG_HOME` が絶対 path ならその下）に unit file を書き、`systemctl --user daemon-reload`・`enable`・`restart` を実行します。`<hash>` は `<dataDir>` の実 path の SHA-256 の先頭12文字で、`<dataDir>` ごとに runner は1つです。
- unit file の `Environment=` には、`araya runner install` を実行した環境の `PATH`・`LANG`・`LANGUAGE`・`TZ`・`LC_*`・`ARAYA_*`（`TOKEN`・`SECRET`・`PASSWORD`・`API_KEY`・`AUTH` などを名前に含む、秘密とみなす変数を除く）・`PI_CODING_AGENT_DIR` だけを書きます。`ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` は絶対 path にして書きます。ほかの変数（model の API key、proxy の設定など）は runner にも SHIKI にも渡りません。model の認証は Pi の `auth.json` から読みます。
- `<dataDir>` などの path と環境変数の値に、空白・引用符・`\`・`$`・`%`・`;`・制御文字があると、unit file を書かずに `unsupported_path` で失敗します。
- 環境変数を変えたときは、`araya runner install` をやり直してください。やり直すまで、unit file の `Environment=` は前の値のままで、runner は前の環境で動きます。`npm run deploy` で araya を入れ直したときも、`araya runner install` をやり直して、runner を新しいコードで起動し直してください。動いている runner は、起動したときに読み込んだコードで動き続けます。一方、`npm run deploy` は install 先の file を置き換えるので、やり直していなくても、runner が次に起動したとき（落ちて systemd が起動し直したとき、logout や再起動の後、`systemctl --user start` のとき）からは新しいコードで動きます。
- `ARAYA_DATA_DIR` を変えて `araya runner install` を実行すると、`<hash>` が変わるので別の unit（別の runner）ができ、前の runner は動き続けます。前の runner を残さないときは、先に前の `ARAYA_DATA_DIR` で `araya runner uninstall` を実行してください。
- araya は linger を変えません。linger が無効だと、logout で runner が止まり（一時停止）、次に user manager が起動したときに続きから進みます。logout の後も動かすには、利用者が `loginctl enable-linger` を実行してください。`araya runner install` の出力の `linger` が `false` なら、stderr に注意を出します。
- runner を止める（`systemctl --user stop araya-runner-<hash>.service`）のは一時停止です。動いていた試行は中止されず、次に起動（`systemctl --user start …`）したときに続きから進みます。runner が落ちたときは、systemd が間隔を空けて起動し直します。
- `araya runner uninstall` は unit を止めて無効にし、unit file を消します。台帳は変えないので、動いていた試行は `running` のまま残り、入れ直すと続きから進みます。
- runner の log は `<dataDir>/logs/runner.log`（1行1件の JSON、秘密を置き換えたもの）です。runner の stdout と stderr は捨てます。

### Task を登録する

```json
{
  "title": "空の入力を拒否する",
  "goal": "araya の CLI で、空の値を受け取ったら理由を表示して終了するようにし、既存のテストに回帰ケースを追加する",
  "constraints": ["依存を追加しない"],
  "targets": ["araya"],
  "permissions": [],
  "idempotencyKey": "example-1"
}
```

```sh
araya task create --file task.json     # stdin から読むときは --file -
```

- `title`（200文字まで、改行なし）と `goal`（20,000文字まで）は必須です。`constraints`・`targets`・`permissions` は省略すると `[]` です。`targets` は作業対象の手がかり（開発 root からの repository の相対 path など）で、制限ではありません。`permissions` は SHIKI に渡すだけで、commit・push などの固定の禁止事項は解除しません。
- 同じ `idempotencyKey` で2回登録すると、同じ Task を `"created": false` で返します。`idempotencyKey` が同じでほかの項目の値が違う場合は、`idempotency_conflict` で拒否します。
- 知らない key、長さや件数の超過、256 KiB を超える入力、NUL、空白だけの値は拒否します。
- `araya task` は runner も SHIKI も起動しません。出力の `runner.state` が `running` でなければ（`not_started`・`stopped`・`not_responding`）、stderr に注意を出します。

### 状態を見る

```sh
araya task list [--status <状態>] [--limit <1〜200>]
araya task show <taskId> [--events <0〜500>] [--full]
```

- Task の状態は次のとおりです。
  - `queued`: 待ち
  - `running`: runner が動かしている（runner が止まっている間もこの状態）
  - `completed`: SHIKI が成功し、差分のある worktree すべてで検証が通った
  - `failed`: 失敗した、または中止された（理由は `failureReason`）
  - `blocked`: SHIKI が `araya_request_decision` で人の判断を求めた（質問は `decisionQuestion`）、または runner が落ち続けて試行が止められた（`restart_limit`）
- `<taskKey>` は試行ごとの名前で、`taskId` とは別です。新しい試行は新しい taskKey を使います。`araya task show` の出力の `attempts[].taskKey` で確かめられます。
- `show` は試行ごとの報告（`summary`）、使った model、evidence（差分の統計、検証の結果、`activeMs` など）と、途中経過（tool の開始と終了）を出します。差分と検証の出力の本文は台帳に入れず、試行の状態 directory（`<dataDir>/development/<taskKey>/`）の `evidence.json` に置きます。`--full` のときだけ、SHA-256 が台帳の記録と一致する `evidence.json` から本文を出します。
- worktree と branch は試行ごとに作ります。名前はそれぞれ `<repository>/.worktree/araya-<taskKey>` と `araya/<taskKey>` です。

### 再実行と中止

```sh
araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]
araya task cancel <taskId>
```

- 再実行できるのは `failed` と `blocked` の Task だけです。新しい試行は新しい taskKey を使うので、worktree と branch も前回とは別になります。前回の worktree は残します（前回の変更は持ち込みません）。`--note` は追加の指示です。SHIKI が判断を求めて `blocked` になった Task では、質問（`decisionQuestion`）への答えを書きます。
- 前回の試行が、取り込まれた後に途中で止まったとき（中止、`agent_timeout`、`restart_limit`、model 以外の理由の `agent_failed` など）は、外部への変更をくり返すおそれがあるので、`--confirm-side-effects` を付けないと `side_effects_unconfirmed` で拒否します。
- `cancel` は、待ちの試行をその場で `failed`（`cancelled`）にし、`running` の試行には中止を求めます（runner が動いていれば数秒以内に止め、`failed`（`cancelled`）になります。runner が止まっているときは、次に runner が起動したときに止めます）。`completed`・`failed`・`blocked` の Task は中止できません。自動の再実行はしません。

### 期限と制限

- SHIKI 1回の期限は `ARAYA_DEVELOPMENT_TIMEOUT_MS` で、runner が動いていた時間で数えます（一時停止の間は数えません）。過ぎると `failed`（`agent_timeout`）になります。検証コマンドは1件ごとに `ARAYA_VERIFICATION_TIMEOUT_MS` で打ち切ります。
- SHIKI の bash はコマンドごとに、検証コマンドは1件ごとに、worktree の作成と差分の収集の git も実行ごとに、それぞれ別の transient な systemd の scope（名前は `araya-<hash>-<taskKey>-…`）の中で動きます。runner は、差分を集める前と結果を記録する前に、その試行の名前の scope をすべて止めるので、`setsid` などで切り離した process も残りません。
- SHIKI と検証コマンドに sandbox はありません（「状態と安全境界」）。SHIKI の tool は `read`・`edit`・`write`・`bash` と Araya の tool で、`grep`・`find`・`ls` はありません（bash で代用します）。
- 秘密とみなす環境変数の値と URL の userinfo は、台帳・`evidence.json`・log に書く前に `[REDACTED]` に置き換えます。それ以外の秘密（file の中身など）を SHIKI が報告に書いたり、検証コマンドが出力したりすると残ります。Pi Durable の storage（`<dataDir>/runner/durable.sqlite`）には会話がそのまま残ります。
- 台帳、Pi Durable の storage、試行の状態 directory、log、worktree と branch は自動では消しません。

## inbox 形式

`ARAYA_INBOX_DIR` 配下の `.jsonl` ファイルを読みます。各行は JSON object です。通常候補の例:

```json
{"id":"candidate:example","kind":"investigate","title":"対象の状態を確認する","risk":"read-only","payload":{"source":"local-note"}}
```

開発課題の例:

```json
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"araya の入力で空の値を拒否し、既存のテストに回帰ケースを追加する"}}
```

`development` 行の取り込みでは形を検証します。`payload` は `task` だけを持ちます（空白以外の文字を含む20,000文字以内、NULなし）。`task` 以外のkeyを持つ課題はintakeで拒否します。

取り込んだ `development` 課題は実行しません。次のdue tickでArayaは、agentもモデルも起動せずに課題を `blocked`（evidence の `type` は `development_executor_unavailable`）にします。worktreeの作成、差分の収集、検証コマンドの実行も行いません。開発の課題は `araya task create` で登録してください（「開発の Task」）。

`risk` は `read-only`、`workspace`、`external` のいずれかです。`workspace` は `kind: "development"` 専用です。`id` は省略可能ですが、再投入時の重複防止には安定した ID を指定してください。不正行・重複 ID・読み取りエラーは `inbox.read_errors` event に記録します。不正な行は候補に含めず、同じ読み込みで有効だった行は処理対象になることがあります。そのため `tick` の `due` は入力全件が正常だった保証ではありません。inboxの内容はデータとして扱います。`development` の `payload.task` も実行されません。

## CLI

```sh
araya                                # Pi の interactive TUI を同一プロセス内で起動（tick は自動では実行しない）
araya pi [arguments...]              # 指定した引数を Pi coding-agent SDK に転送
araya --help                         # ヘルプ表示
npm run araya -- init
npm run araya -- tick
npm run araya -- status
npm run araya -- run
npm run araya -- pi [arguments...]
npm run araya -- approve <opportunityId> [note...]
npm run araya -- reject <opportunityId> [note...]
araya task create --file <path|->
araya task list [--status <状態>] [--limit <1〜200>]
araya task show <taskId> [--events <0〜500>] [--full]
araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]
araya task cancel <taskId>
araya runner install
araya runner uninstall
```

承認コマンドは判断を記録するだけで、外部操作を開始しません。

## 設定

- `ARAYA_DATA_DIR` — データの directory（既定: `~/.araya`）。この README では `<dataDir>` と書きます。
- `ARAYA_INBOX_DIR` — JSONL inbox（既定: `<dataDir>/inbox`）
- `ARAYA_STATUS_FILE` — 状態スナップショット（既定: `<dataDir>/status.json`）
- `ARAYA_CONTROL_PLANE_PATH` — Goal / Opportunity / decision / event / outbox DB
- `ARAYA_PI_DURABLE_PATH` — Pi Durable task graph DB
- `ARAYA_INTERVAL_MS` — 次回起床間隔（既定: 900000 ms）
- `ARAYA_MAX_ACTIONS` — 1 tick あたりの処理候補数上限（既定: 3）
- `ARAYA_DEV_ROOT` — 開発 root（既定: `~/dev`）。runner の SHIKI がここで repository を探し、worktree を作ります。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS` — SHIKI 1回の期限（既定: 1200000 ms、範囲: 1000〜3600000 ms）。runner が動いていた時間で数えます。範囲外の値は範囲に丸め、数でない値は既定値にします。
- `ARAYA_VERIFICATION_TIMEOUT_MS` — 検証コマンド1件ごとの期限（既定: 300000 ms、範囲: 1000〜3600000 ms）。範囲外の値は範囲に丸め、数でない値は既定値にします。
- `PI_CODING_AGENT_DIR` — Pi の agent directory。Pi と Araya の両方で同じ値を使うと、`tick` / `run` のモデルruntimeが Pi と同じ `auth.json` と `models.json` を参照します（`tick` / `run` はモデルを呼び出しません）。runner の SHIKI も同じ directory の `auth.json` と `models.json` を使います。未指定時は `~/.pi/agent` を使用します。

### 設定ファイル

設定ファイル `<dataDir>/config.json`（既定: `~/.araya/config.json`）は、runner の SHIKI の model と thinking level を選ぶための設定です。場所は `ARAYA_DATA_DIR` に従い、設定ファイルの場所だけを変える環境変数はありません。

```json
{
  "development": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
```

- 形式は UTF-8 の JSON object で、64 KiB まで。top level の key は `development`（省略可）だけです。`{}` やファイルが無い場合は、Pi の `settings.json` の `defaultProvider`・`defaultModel` で決まる model を使います。使う model が決まらない、Pi の model の一覧に無い、認証が無いときは、別の model に切り替えず、試行を `failed`（`agent_failed`、evidence の `agent.error` は `model_unavailable`）にします。
- `development.model`（必須）: `<provider>/<model id>`。最初の `/` で provider と model id に分けるため、model id には `/` を含められます（例: `openrouter/moonshotai/kimi-k2.6`）。provider と model id は空にできず、空白と制御文字を含めず、全体で200文字まで。
- `development.thinkingLevel`（省略可）: `off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれか。省略すると Pi の設定（`modelThinkingLevels["<provider>/<id>"]` → `defaultThinkingLevel` → `medium`）で決まります。Pi は model が対応しない thinking level を対応する値に丸めます。
- 知らない key、型の違う値、`null` は拒否します。ファイルが存在するのに使えない場合（JSON の誤り、schema 違反、64 KiB 超、UTF-8 でない、通常の file でない、壊れた symlink、読めない）は、`init`・`tick`・`status`・`run`・`approve`・`reject`・`task`・`runner` が何も処理せずに `invalid Araya config file <path>: <理由>` で失敗します（終了 code 1）。引数なしの `araya`・`araya pi`・`araya --help` は設定ファイルを読みません。
- 設定ファイルは subcommand の起動時に1回だけ読みます。`araya run` の実行中に書き換えた内容は、再起動するまで反映されません。runner は試行を取り込むたびに読み、取り込んだ時点の値をその試行に使います（使えないときは取り込まずに待ち、log に書きます）。
- `araya status` の出力と `status.json` の `config` に、`configPath` と `developmentModel`（`{ "model": "<provider>/<id>", "thinkingLevel": ... }`、未指定なら `null`）が入ります。status は Pi の認証を読まないため、model が実際に使えるかは表示しません。
- 利用上限に達したときの fallback model と自動 retry は未対応です。`fallbackModels` などの key は知らない key として拒否します。

詳細は [docs/spec/development-model-config.md](docs/spec/development-model-config.md) を参照してください。

## 状態と安全境界

- `tasks.sqlite` が開発の Task と試行、途中経過、runner の状態を保持します。runner の Pi Durable の storage（SHIKI の会話）は `runner/durable.sqlite` です。
- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。Pi Durable 1.4.0 で既存DBを開くと schema v2 へ自動移行されます。移行後は同じDBを Pi Durable 1.3.0 以下で開けないため、初回利用前にDBをバックアップしてください。
- これらの SQLite DB（`tasks.sqlite`・`runner/durable.sqlite`・`araya.sqlite`・`pi-durable.sqlite`）をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- `read-only` / `external` の実行executorがない候補は `completed` と偽らず、`blocked` として残します。
- Arayaの通常control-plane処理は外部書き込みや通知送信をしません。`tick` / `run` は、Pi Durable の harness を開くときに Pi のモデルruntimeを作りますが、モデルは呼び出しません。Piの認証情報は `PI_CODING_AGENT_DIR`（未指定時は `~/.pi/agent`）から読み取り、Arayaの設定やDBには複製しません。引数なしの `araya` と `araya pi` は明示的にPi coding-agent SDKのCLI entry pointを実行するため、その実行はこの節の対象外です。
- inbox の `development` 課題は実行せず `blocked` として残します（`development_executor_unavailable`）。
- runner の SHIKI と検証コマンドは、利用者の権限で sandbox なしで動きます。開発 root の repository に限らず、利用者が書き込める file を変更できます。commit・push・PR の作成・merge・deploy・publish はしないよう SHIKI に指示しますが、強制はしません。
- DB や inbox に利用者のデータを置く場合は、`ARAYA_DATA_DIR` とバックアップのアクセス権を利用者側で管理してください。

## グローバルインストール

ルートで `npm run deploy` を実行すると、`araya`（version `0.0.1`）をbuildし、一時tarballからユーザーglobal prefix（既定: `$HOME/.local`）へinstallします。checkoutへのsymlinkではないため、以後のソース変更は再deployまで反映されず、araya の checkout を移動・削除しても、install済みコマンドは影響を受けません。npm registryへのpublishは行いません。指定prefix内に旧 `agentctl` package があれば先にuninstallし、`araya` のbin競合を解消してから置き換えます。

```sh
npm run deploy
araya --help
```

別のprefixを使う場合は `ARAYA_INSTALL_PREFIX` で上書きできます。prefixの `bin` directoryが `PATH` に含まれていることを確認してください。

```sh
ARAYA_INSTALL_PREFIX="$HOME/.npm-global" npm run deploy
```

## 開発

```sh
npm test
npm run typecheck
```

テストは一時ディレクトリを使い、実際の SQLite と Pi Durable storage を通して状態遷移を検証します。model は pi-ai の faux provider を使い、Pi の認証情報と model の API は使いません。systemd の操作は、通常は test 用の差し替えを使います。本物の systemd の user manager を使う runner の test は、`ARAYA_TEST_SYSTEMD=1` を指定したときだけ実行します（unit file は書かずに、一時的な unit を作って消します）。

```sh
ARAYA_TEST_SYSTEMD=1 node --test packages/araya/test/task-runner-systemd.test.ts
```
