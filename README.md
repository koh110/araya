# araya

開発課題を AI agent に依頼するための CLI です。検証済みの変更を draft PR まで届け、merge は人が判断します。常駐 runner が SHIKI（Pi で作る開発 agent）を対象 repository の worktree で動かし、登録検証がすべて通った変更を Araya が commit・GitHub.com へ push し、Draft PR を作成します。Araya は merge・deploy・publish を行いません。

実験用 MVP です。この文書では `araya` を入れてから結果を受け取るまでの手順を説明します。内部の仕組みと開発の手順は [docs/development.md](docs/development.md)、動作の詳しい定義は仕様 [docs/spec/task-ledger-and-shiki-runner.md](docs/spec/task-ledger-and-shiki-runner.md) にあります。

## 必要な環境

- Linux と systemd（254 以降）の user manager に到達する host。それ以外の host では `araya task` と `araya runner` は使えません。
- Node.js 26.8 以上
- git。作業対象の repository に worktree を作るときに使います。
- GitHub.com の repository へ Draft PR を届けるときは GitHub CLI `gh` が必要です。runner と同じ OS user で `gh auth login` を済ませてください。GitHub Enterprise は対象外です。
- 開発 root。Task で動かす repository は開発 root の中に必要です（既定 `~/dev`。`ARAYA_DEV_ROOT` で変えられます）。
- Pi で使える model へのアクセス。Pi coding-agent は araya の依存 package に含まれるので、別途 `pi` を入れる必要はありません。model の認証は Pi の `/login` で設定します（API key の環境変数は使いません）。

## インストール

```sh
git clone https://github.com/koh110/araya
cd araya
npm ci
npm run deploy
```

`npm run deploy` は、`araya` コマンドをユーザーの global prefix（既定 `~/.local`）に入れ、runner を systemd の user service として入れます。`~/.local/bin` を PATH に足してください。

```sh
export PATH="$HOME/.local/bin:$PATH"
```

これで `araya` が使えます。入れ先を変えるときは `ARAYA_INSTALL_PREFIX` を設定して deploy を実行します。deploy の内部の動作と失敗の扱いは docs/development.md を見てください。

## model を選ぶ

Task を動かす前に、SHIKI が使う model を決めます。checkout で `araya` を引数なしで動かすと（`npm run araya`）Pi の TUI が立ちます。

1. `/login` で provider に接続する
2. `/model` で model を選び、既定として保存する

この状態で `npm run deploy`（または `araya runner install`）を実行すると、araya はその既定 model を設定ファイル `<dataDir>/config.json`（既定 `~/.araya/config.json`）に保存します。保存するのは設定ファイルが無いときだけです。認証情報は写さず、API は呼ばず、既存の設定ファイルは変更しません。

設定ファイルは自分で書くこともできます。

```json
{
  "development": {
    "model": "openai/gpt-5.5"
  }
}
```

`model` は `<provider>/<model id>` です。`thinkingLevel` は省略できます（省略すると Pi の設定で決まります）。API key は設定ファイルに書かないでください（読みません）。設定ファイルが無いときは、model は Pi の設定で選ばれます。runner は試行を取り込むたびに設定ファイルを読むので、インストールした後に作っても反映されます。

注意: 保存した後は Pi の既定 model を変えても Araya の設定には追従しません。model を切り替えるときは設定ファイルの `development.model` を更新してください。使う model が決まらない、Pi の model の一覧に無い、認証が無いときは、別の model に切り替えずに試行を `failed`（`agent_failed`、`model_unavailable`）で終わらせます。設定ファイルの詳しい規則は [docs/spec/development-model-config.md](docs/spec/development-model-config.md) を見てください。

## Task を登録する

```json
{
  "title": "README の誤字を直す",
  "goal": "README.md の誤字を直し、ファイルを検索して置換を確認する検証コマンドを登録する",
  "targets": ["my-app"]
}
```

```sh
araya task create --file task.json   # stdin から読むときは --file -
```

- `title`（200 文字まで、改行なし）と `goal`（20,000 文字まで）は必須です。
- `targets` は SHIKI に作業 repository を探してもらうための手がかりです（開発 root からの相対 path など）。worktree の対象を限定するものではなく、どの repository で作業するかは SHIKI が判断します。SHIKI が触れる file の制限にもなりません（「注意」を見てください）。SHIKI が開発 root の下に存在しない repository を指定したときは、worktree の作成が失敗し、理由（`repository_not_found`）が SHIKI に返されます。SHIKI は別の repository を選び直せます（tool の失敗だけでは試行は終わりません）。`constraints` と `permissions` は省略できます。`permissions` は SHIKI に渡す制約情報で、Araya が検証後に行う commit・push・Draft PR の前提を解除したり、merge・deploy を許可したりしません。
- `araya task` は runner も SHIKI も起動しません。動いている runner が数秒以内に台帳を見て、実行枠に空きがあれば取り込みます。runner が動いていないときは注意を出します（登録自体は成功します）。
- 同じ `idempotencyKey` で同じ内容をもう一度登録すると、同じ Task を返します（`"created": false`）。入力の詳しい制限は仕様にあります。

## 進捗を見る

```sh
araya task list
araya task show <taskId>
```

Task の状態は次のとおりです。

- `queued`: 待ち
- `running`: runner が動かしている（runner が止まっている間もこの状態）
- `completed`: SHIKI が成功し、差分のある全 worktree で登録検証が通り、GitHub.com の Draft PR まで届けた（差分なしは `no_changes` で失敗）。
- `failed`: agent・検証・commit・push・PR 作成のいずれかが失敗、または中止された（理由は `failureReason`）。
- `blocked`: 人の判断、GitHub CLI 認証、GitHub repository の確認などが必要（「詰まったときは」を見てください）。

`task list` には runner の状態（`runner.state`: `running`・`stopped`・`not_responding`・`not_started`）も出ます。1つの runner で同時に動く SHIKI は1件までで、ほかの Task は `queued` で待ちます。

`task show` は試行ごとの報告（`summary`）、使った model、evidence、途中経過を出します。試行ごとに名前（`taskKey`）があり、`taskId` とは別です。差分と検証の出力の本文は台帳に入れず、試行の状態 directory（`<dataDir>/development/<taskKey>/evidence.json`）に置き、`--full` を付けたときだけ表示します。

## 結果を受け取る

SHIKI の変更は試行ごとの worktree `<repository>/.worktree/araya-<taskKey>`（branch `araya/<taskKey>`）に作られます。差分のある各 repository で全検証が通ると、Araya が変更を commit し、GitHub.com の `origin` に fast-forward push して Draft PR を作成します。PR URL は `task show` の evidence に残ります。`gh` 不在・未認証、GitHub 以外の remote、Git identity 不足などでは success にせず、設定が必要な場合は `blocked` にします。Araya は merge・deploy・publish を行いません。worktree・branch・log・台帳は自動では消えません。詳しくは [Draft PR delivery 仕様](docs/spec/draft-pr-delivery.md) を見てください。

## 詰まったときは

`blocked` は次のどちらかです。SHIKI が `araya_request_decision` で人の判断を求めた（質問は `decisionQuestion`）、または runner が落ち続けて試行が止められた（`restart_limit`）。どちらの場合も、決めてから再実行します。

```sh
araya task retry <taskId> --note "B 方案を使う"
```

- 再実行できるのは `failed` と `blocked` の Task だけです。
- 新しい試行は新しい taskKey を使い、worktree と branch も前回とは別になります。前回の worktree は残ります（前回の変更は持ち込みません）。
- SHIKI が判断を求めたときは、質問への答えを `--note` に書きます（長い文字列は `--note-file`）。
- 前回の試行が中断された場合、または Draft PR 配送で remote branch / PR が作成・更新されたか確認できない場合は、`--confirm-side-effects` が必要です。前回の worktree と GitHub の状態を確かめてから付けてください。
- `araya task cancel <taskId>` は、待機中の試行をその場で中止し、動いている試行には中止を求めます。自動の再実行はありません。

## runner を管理する

runner は systemd の user service です。`npm run deploy` で入ります。unit の名前は `araya-runner-<hash>.service`（`<hash>` は data directory から決まります。`araya runner install` の出力に載ります）。

- 止める: `systemctl --user stop araya-runner-<hash>.service`。これは一時停止で、動いていた試行は次に起動したときに続きから進みます。
- 起動・再開: `systemctl --user start araya-runner-<hash>.service`。
- 環境変数を変えたとき: `araya runner install` をやり直します。やり直すまで、runner は前の環境で動き続けます。
- 取り除く: `araya runner uninstall`。unit を止めて消すだけで、台帳は変えません。入れ直すと続きから進みます。
- 動作記録: `<dataDir>/logs/runner.log`（1行1件の JSON、秘密を置き換えたもの）。

araya は linger を変えません。linger が無効だと、logout で runner は止まり（一時停止）、次に user manager が起動したときに続きから進みます。logout の後も動かしたいときは `loginctl enable-linger` を実行してください。runner が落ちたときは、systemd が間隔を空けて起動し直します。

## araya を更新する

```sh
git pull
npm ci
npm run deploy
```

`npm run deploy` は、その環境の data directory の runner を新しいコードで入れ直して起動します。動いていた試行は一時停止の扱いで続きから進みます。

## 注意

- SHIKI と検証コマンドは sandbox 無しで、利用者の権限で動きます。開発 root の repository だけでなく、利用者が書き込める file を変更できます。
- SHIKI には main checkout を編集せず、commit・push・PR 作成をしないよう指示しますが、sandbox・network制限はなく、prompt は強制されません。SHIKI が直接 remote を変更する可能性があります。Araya の組み込み delivery が commit・push・PR を行うのは全検証後です。Task と agent の権限を確認してから登録してください。
- Araya は秘密とみなす値と URL の userinfo を、台帳・evidence・log に書く前に `[REDACTED]` に置き換えます。ただし完全ではありません。SHIKI の会話は Pi Durable の storage にそのまま残ります。Task の文字列に何を書いたかは確認してください。
- データは `~/.araya`（`ARAYA_DATA_DIR` で変わります）に置かれます。アクセス権とバックアップは利用者側で管理してください。
- SHIKI の tool は `read`・`edit`・`write`・`bash` と Araya の tool です。`grep`・`find`・`ls` はありません（bash で代用します）。
- 試行と検証の期限は、runner が動いていた時間で数えます（一時停止の間は数えません）。`ARAYA_DEVELOPMENT_TIMEOUT_MS` と `ARAYA_VERIFICATION_TIMEOUT_MS` で変えられます。
- 環境変数・設定ファイルの完全な一覧と、内部の仕組みは docs/development.md にあります。

## その他のコマンド

- 引数なしの `araya` は Pi coding agent の TUI を起動します（Araya の `tick` は自動では実行しません）。`araya pi ...` は引数を Pi にそのまま渡します。`araya --help` はヘルプです。
- 旧経路（`init`・`tick`・`status`・`run`・`approve`・`reject`）は開発の課題を動かすために使いません。JSONL inbox に書いた `development` の課題は実行されず `blocked` になります。開発の課題は `araya task create` で登録してください。旧経路については docs/development.md を見てください。
- 未実装: 自律的な課題発見、Goal / 探索対象の設定、外部ソース監視、Outbox 配信、旧経路（`tick` / `run`）の常駐化。`run` を起動しても、新しい課題を自律的に発見するわけではありません。
