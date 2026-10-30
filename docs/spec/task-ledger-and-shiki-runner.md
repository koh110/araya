# Task の台帳と SHIKI の実行

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）に隔離します。`settings.json`・`auth.json`・`models.json`・`models-store.json`・`sessions/`・Pi SDK が管理する `bin/` はここに置き、runner の model cache は既存の `<dataDir>/runner/models-store.json` を維持します。host Pi からの fallback・copy・migration・symlink は追加しません。Araya 側の TUI（`araya` または `araya pi`）で `/login` と `/model` を設定し直してください。Araya 自身の `config.json`・台帳・runner storage の配置、既存 config の model は変更しません。旧 host agentDir を保存した running 試行は、再開前に host 設定を読まず既存の `attempt_error` で失敗させます。保存済み入力は書き換えず、再設定後の新規 retry を必要とします。DB schema 変更・rewrite・migration は行いません。

## 位置づけ

PR #7 に書いた進め方の手順1。Issue #1 のチェックリストのうち、C（Task ごとに SHIKI を起動し、結果と失敗を台帳に回収できる）と D（重複起動・孤児実行・再実行を安全に扱える）を満たし、B（Pi セッションを越えて Task の一覧と状態を取得できる）の土台を作る。

この手順の入口は CLI（`araya task`）にする。手順2 の Pi Extension は、同じ処理を tool と command から呼ぶ。

Task は、常駐する runner（systemd の user service）が動かす。runner は台帳の待ちを数秒ごとに見て、Task を受け取ると SHIKI を pi-durable（`@earendil-works/pi-durable`。araya が既に依存している）の会話として動かし、落ちても止めても次の起動で続きから進める。会話と tool の記録、落ちた後の再開、途中で止まった tool の扱い、中止は pi-durable に、process の後始末と runner の二重起動の防止は systemd に任せ、araya では作らない（「Assumptions」）。

この手順で、旧経路の worker（JSONL inbox の development の課題を、Pi の SDK の session で動かす process）も撤去する。撤去は runner より先に行い、SHIKI を動かすのは runner だけになる（利用者の選択。「旧経路との関係」）。

この仕様は Task runner と SHIKI 委任の動作を定義する。検証済みの変更は、実装仕様 [Draft PR delivery](draft-pr-delivery.md) に従い commit・push・Draft PR まで届ける。CI の完了待ち、merge、deploy は行わない。

## 概要

- 利用者が Task を登録すると、台帳（`<dataDir>/tasks.sqlite`）に `queued` で記録される。登録した process は runner を起動せず、試行の終了も待たない。
- runner（`araya-runner-<dataDir の hash>.service`）は常駐し、2 秒ごとに台帳を見る。実行枠（MVP の上限は 1）に空きがあれば、待ちの試行を古い順に `running` にし、pi-durable の task（「試行の task」）として動かす。Task が無い間は model を呼ばない。
- runner は pi-durable の storage を1つ持ち、SHIKI は Task ごとに独立した会話として runner の中で動く。会話と tool の記録は storage に残る。
- runner が落ちると、systemd が間隔を空けて何度でも起動し直し、会話は続きから進む。runner を止めるのは一時停止で、次に起動すると続きから進む。Task をやめるときは、Task ごとに中止する（`araya task cancel`）。
- SHIKI の作業と完了の判定は [人が投入する開発課題を処理する自動ループ](human-authored-development-loop.md) と同じ。開発 root（既定 `~/dev`）で必要な repository を判断し、課題用の worktree で実装し、SHIKI が終わった後に Araya が登録された検証を実行する。検証が通らなければ完了にしない。
- SHIKI の bash、`araya_create_worktree` と差分の収集の git、検証のコマンドは、試行ごとの systemd の scope（「試行の scope」）の中で動く。runner は、差分を集める前、試行の結果を記録する前、runner を止めるとき、起動したとき（会話を再開する前）に scope を止め、SHIKI の bash や git の hook が `setsid` などで切り離した process も残さない。
- 結果（状態、報告、使った model、差分と検証の evidence、失敗の理由）と途中経過は台帳に残る。どの process（別の Pi セッションを含む）からでも同じ内容を読める。runner が動いているかどうかも台帳で分かる。
- `failed` と `blocked` の Task は、利用者が明示的に再実行できる。
- 旧経路（JSONL inbox と `tick`/`run`）は development の課題を実行しなくなる。取り込んだ development の課題は、実行せずに `blocked` にする（「旧経路との関係」）。

## 決まっている方針

PR #7 で決めた方針:

- SHIKI は同時に1件まで動かす。ほかの Task は `queued` で待つ。
- MVP で扱う Task は開発の Task だけ。
- 旧経路（JSONL inbox、`tick`/`run`、goal・scout・observation・opportunity、承認・outbox、旧経路の Pi Durable（`pi-durable.sqlite` と WorkTask））は、新しい経路が動いた後に手順4で撤去する。それまでは動作を変えない（旧経路の worker だけは、利用者の選択でこの手順で runner より先に撤去し、旧経路は development の課題を実行しなくなる）。

利用者の選択:

- 手順1 の最初の PR（worker を撤去する PR）で、コードと文書に残る旧名を `araya` に直す（「名前の統一」）。
- 将来は並列数を上げられるようにする。MVP の上限は 1 のまま（「並列数を上げるとき」）。
- SHIKI は pi-durable で動かす。既にある依存の機能を使わずに自前で作ることはしない。
- 厳密な起動数の管理より、dots のように動き続けて作業を続けられる仕組みにする。このため、試行ごとに process を起動せず、常駐する runner（systemd の user service）が Task を動かし続ける。`araya task` は Linux と systemd の user manager を前提にする。
- runner を止めるのは一時停止として扱い、Task をやめるときは Task ごとに中止する。
- 旧経路の worker は、この手順で、runner より先に撤去する（「旧経路との関係」）。SHIKI を動かすのは runner だけにし、旧経路と runner を同時に使っても SHIKI が同時に2つ動かないようにする。前の版では、worker を残して runner と実行枠を共有せず、SHIKI が同時に2つ動くことを手順4 までの既知の制限にしていた（その前の版では、旧経路の worker も同じ枠で数えていた）。
- araya はまだ運用していないので、動いている旧経路からの入れ替え（後方互換性）は考えない。worker を撤去してから runner ができるまでは、development の課題を動かす経路が無くてよい。
- worker の撤去（名前の統一を含む）は、この仕様を追加する PR（#8）に含める。この PR を「worker を撤去する PR」と呼ぶ。前の版では、別の PR にしていた。
- `npm run deploy` は、araya を入れた後に runner も入れ直し、止めてある runner も起動する（「`npm run deploy`」）。前の版では、deploy の後に利用者が `araya runner install` を実行していた。

## 用語

- **Task**: 利用者が依頼した仕事。目的・制約・作業対象の手がかり・許可を持つ。ID は台帳の中で増える整数。
- **試行**: Task を SHIKI で1回実行すること。Task を作ると1回目の試行ができ、再実行のたびに次の試行ができる。Task ID と試行番号の組で識別する。
- **taskKey**: 試行ごとの名前。Issue #1 の「実行ID」にあたる。状態 directory、worktree、branch、試行の scope の名前に使う。
- **runner**: 台帳の Task を取り込み、試行ごとに SHIKI を動かす常駐の process。SHIKI が終わった後の差分の収集、検証、結果の判定と記録も行う（「結果の判定と記録」）。systemd の user service（「unit の名前と file」）として動き、pi-durable の storage を1つ持つ。
- **SHIKI**: runner の中の、試行ごとの pi-durable の会話（model と tool）。
- **試行の task**: runner が試行ごとに pi-durable の Harness に作る task（`defineTask`）。SHIKI の会話、差分の収集と検証、中止を、phase に分けて持つ（「試行の task」）。
- **試行の scope**: 新しい経路が試行のために起動する subprocess（SHIKI の bash、git、検証のコマンド）を入れる systemd の scope（「試行の scope」）。
- **実行枠**: runner が同時に動かせる試行の数。MVP の上限は 1。
- **一時停止**: runner を止めること。動いていた試行は中止されず、次に runner が起動したときに続きから進む。
- **中止**: 1つの試行をやめること（利用者の `araya task cancel`、期限、pi-durable が止めた試行など。「中止」）。
- **既存の〜**: この仕様を書いた時点の main（PR #7 を merge した `d206782`）の実装。手順1 で撤去するもの（「旧経路との関係」）も、判定・文言・evidence の形・探し方の基準としては、その時点の実装を指す。

## 入力

### `araya task create`

UTF-8 の JSON 1件を file で渡す（`--file <path>`。stdin から読むときは `--file -`）。256 KiB を超える入力は拒否する。

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

- 許す key はこの6つだけ。ほかの key があれば拒否する。
- `title`: 必須。空白以外の文字を含む 200 文字以内の文字列。改行を含まない。
- `goal`: 必須。Task の目的と期待する結果。空白以外の文字を含む 20,000 文字以内の文字列。
- `constraints`: 省略すると `[]`。32 件まで、合計 10,000 文字まで。各要素は空白以外の文字を含む文字列。
- `targets`: 省略すると `[]`。16 件まで、各 200 文字まで。各要素は空白以外の文字を含む文字列。作業対象の手がかり（開発 root からの repository の相対 path など）で、制限ではない。
- `permissions`: 省略すると `[]`。16 件まで、合計 5,000 文字まで。各要素は空白以外の文字を含む文字列。この Task で許すこと。固定の禁止事項は解除しない（「Assumptions」）。
- `idempotencyKey`: 省略できる。1〜200 文字。同じ key の Task が既にあれば、新しく作らずにその Task を返す（`created: false`）。key が同じで、ほかの5つの値（省略したものは既定値で比べる）が1つでも違えば `idempotency_conflict` で拒否する。手順2 の Extension が、tool 呼び出しの再試行で Task を重複させないために使う。
- 文字列はすべて NUL を含まない。文字数は JavaScript の string の `length` で数える。
- 入力が不正なら Task を作らず、理由を stderr に出して終了 code 1 で終わる。

### `araya task retry`

- `--note <text>` か `--note-file <path>`（stdin から読むときは `-`）で追加の指示を渡せる。省略できる。10,000 文字まで、NUL を含まない。`blocked` の Task では、質問への答えをここに書く。
- `--confirm-side-effects`: 途中で止まった試行の後で再実行するときに必須（「再実行」を参照）。

## 台帳

### file と接続

- `<dataDir>/tasks.sqlite`（既定 `~/.araya/tasks.sqlite`）。旧経路の `araya.sqlite`・`pi-durable.sqlite` とは別の file にする。
- `node:sqlite` の `DatabaseSync` を使う（既存の control plane と同じ。依存は増やさない）。
- 接続ごとに `busy_timeout = 5000`、`journal_mode = WAL`、`foreign_keys = ON` をこの順に設定する（`busy_timeout` を先にして、ほかの process が書き込んでいる間に WAL への切り替えが `SQLITE_BUSY` で失敗しないようにする）。
- 書き込みはすべて `BEGIN IMMEDIATE` の transaction で行う。transaction の中では、signal の送信、待機、process の起動（`systemctl` と `systemd-run` を含む）、pi-durable の呼び出しをしない。
- `PRAGMA user_version` で schema の version を持つ。開いたときに、`BEGIN IMMEDIATE` の中で `user_version` と table の有無を確かめ、`user_version` が 0 で table が1つもなければ、同じ transaction で version 1 の schema を作って 1 にする。1 ならそのまま使う。それ以外（未知の version、または 0 なのに table がある）は、何も変更せずに失敗する（schema、`user_version`、行を変えない。journal mode は、上の接続の設定で、確かめる前に WAL になる）。複数の process が同時に初めて開いても、schema を作るのは1つだけになる。
- `<dataDir>` と `<dataDir>/logs` が無ければ mode 0700 で作る。
- 台帳の file が無ければ、開く前に mode 0600 の空の file として作る（SQLite は WAL と共有メモリの file を、台帳の file と同じ mode で作る）。既にある file の mode は変えない。

### schema（version 1）

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind = 'development'),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
  current_attempt INTEGER NOT NULL CHECK (current_attempt >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  task_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
  note TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  agent_finished_at TEXT,
  finished_at TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  cancel_requested_at TEXT,
  stop_reason TEXT CHECK (stop_reason IN ('agent_timeout', 'cancelled', 'restart_limit', 'attempt_error')),
  stop_detail TEXT,
  settings_json TEXT,
  state_dir TEXT,
  model_json TEXT,
  summary TEXT,
  decision_question TEXT,
  failure_reason TEXT,
  failure_detail TEXT,
  evidence_json TEXT,
  PRIMARY KEY (task_id, attempt)
);

CREATE INDEX idx_runs_status ON runs (status, queued_at);

CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  attempt INTEGER,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX idx_task_events_task ON task_events (task_id, seq);

CREATE TABLE runner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  unit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
  invocation_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT
);
```

- 時刻は UTC の ISO 8601（`Date.prototype.toISOString`）。
- `tasks.status` は、`tasks.current_attempt` の試行の `runs.status` と常に同じにする。両方を同じ transaction で更新する。
- `runs.started_at` は runner が試行を取り込んだ時刻、`runs.agent_finished_at` は SHIKI の会話の終わりを記録した時刻（「期限」）。
- `runs.active_ms` は、runner がその試行を動かしていた時間のうち、台帳に足した（精算した）分の合計（「期限」）。
- `runs.cancel_requested_at` は利用者が中止を求めた時刻、`runs.stop_reason` と `runs.stop_detail` は runner が中止を始めた理由と詳細（「中止」）。
- `runs.settings_json` は、取り込みのときに決めた試行の設定（「取り込み」）。`running` の間は変えない。
- `runner` は1行だけで、runner が書く（「起動」「loop」「止めるとき」）。CLI はこれを読んで runner の状態を出す（「CLI」）。
- `task_events.data_json` は event ごとの追加情報（JSON object）。

### event の種類

- `task.created`: `{}`
- `task.retried`: `{"hasNote": true | false, "confirmedSideEffects": true | false}`
- `task.cancel_requested`: `{"while": "queued" | "running"}`
- `run.started`: `{"taskKey": "..."}`（runner が試行を取り込んだ）
- `run.resumed`: `{}`（runner が起動し直し、動いていた試行を続きから始めた）
- `run.stopping`: `{"reason": "agent_timeout" | "cancelled" | "restart_limit" | "attempt_error"}`（runner が試行の中止を始めた）
- `tool.started`、`tool.finished`、`events.truncated`: 「途中経過」を参照
- `run.finished`: `{"status": "...", "failureReason": "..." | null}`

## 状態

試行の状態（`runs.status`）:

```text
queued ─(runner が取り込む)→ running ─→ completed / failed / blocked
  │
  └─(中止)→ failed（cancelled）
```

- `running`: runner が試行を動かしているか、runner が止まっている・起動し直すのを待っている（次に runner が起動すると続きから進む）。
- `completed`: SHIKI が成功し、差分のある worktree すべてで登録済みの検証が通った（既存の判定と同じ）。ただし、利用者が中止を求めた試行は、これに当たっても `failed`（`cancelled`）になる（「結果の判定と記録」）。
- `failed`: それ以外。理由は `runs.failure_reason`。
- `blocked`: 人の判断や対応が無いと進めない。SHIKI が人の判断を求めて終わった（「判断の依頼」。質問は `runs.decision_question`）か、pi-durable が試行を止めた（`runs.failure_reason` が `restart_limit`。「落ちたとき」）。

Task の状態（`tasks.status`）は最新の試行の状態と同じ。`failed` と `blocked` の Task だけが、再実行で次の試行（`queued`）を持てる。`completed` の Task は再実行できない。

## 実行枠

- 使っている枠の数は、`running` の試行の数。枠を取るのは runner の取り込み（「取り込み」）だけ。
- 試行は、`running` になってから結果を記録するまで（差分の収集と検証、試行の scope の後始末を含む）枠を使う。runner が止まっている間や、落ちて起動し直すのを待つ間も、枠を使い続ける（その試行は続きから進むため）。
- 結果は、その試行の scope が残っていないことを確かめてから記録する（「結果の判定と記録」）。このため、前の試行が残した process と次の試行は重ならない。

## runner

### unit の名前と file

unit 名は `araya-runner-<h>.service`。`<h>` は dataDir の実 path（`realpath`）を UTF-8 にした byte 列の SHA-256 の16進表記の先頭12文字。dataDir ごとに runner は1つで、同じ名前の unit は systemd が1つしか動かさない。test などで別の dataDir を使えば、名前も分かれる。

`araya runner install`（「CLI」）が、次の unit file を `<XDG_CONFIG_HOME>/systemd/user/araya-runner-<h>.service`（`XDG_CONFIG_HOME` が絶対 path でなければ `~/.config`）に mode 0600 で書く。

```ini
[Unit]
Description=araya runner <dataDir>
StartLimitIntervalSec=0

[Service]
Type=exec
ExecStart=<node の実行ファイル> <runner の entrypoint> --data-dir <dataDir>
ExecStopPost=-<systemctl> --user stop araya-<h>-*.scope
WorkingDirectory=<dataDir>
Environment=<名前>=<値>
KillMode=control-group
Restart=always
RestartSec=1s
RestartSteps=5
RestartMaxDelaySec=1min
TimeoutStopSec=60
StandardInput=null
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
```

- `<node の実行ファイル>` は、`araya runner install` を実行した process の `process.execPath`。entrypoint は `packages/araya/bin/task-runner.ts`（build 後は `dist/bin/task-runner.js`）で、既存の development worker と同じ方法（package root の `bin/` から、実行中の module と同じ拡張子で探す）で場所を解決する。`<systemctl>` は PATH から探した `systemctl` の絶対 path。`<dataDir>` は dataDir の実 path。
- `Environment=` は1変数に1行。`araya runner install` を実行した process の環境変数のうち、次だけを書く。値は unit file と `systemctl --user show` に出るため、秘密を書かない（「秘密情報の扱い」）。
  - `PATH`、`LANG`、`LANGUAGE`、`TZ`、名前が `LC_` で始まるもの
  - 名前が `ARAYA_` で始まり、秘密とみなす名前（「秘密情報の扱い」）に当たらないもの。ただし `ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` は、`loadConfig` で解決した絶対 path にして書く（環境変数に無くても書く）。`loadConfig` は相対 path を process の cwd を基準に解決するため、そのまま書くと、cwd の違う runner が別の台帳や開発 root を使ってしまう。
  - `PI_CODING_AGENT_DIR`（常に `<dataDir>/pi` の絶対 path に正規化し、host の指定は継承しない）
  - これ以外（`HOME`、`XDG_RUNTIME_DIR` など）は、systemd の user manager の環境になる。
- unit file では、`%` が specifier として、`ExecStart` などの `$` が変数として展開され、空白や引用符にも意味がある。escape の処理を作らないため、unit file に書く値（node の実行ファイル、entrypoint、dataDir、systemctl の path、`Environment=` の値）のどれかが、ASCII の制御文字、空白、`"`、`'`、`\`、`$`、`%`、`;` を含むときは、unit file を書かずに `unsupported_path` で失敗する（stderr にどの値かを出す）。環境変数は、名前が `^[A-Za-z_][A-Za-z0-9_]*$` に当たるものだけを書く。
- `StartLimitIntervalSec=0` で、systemd は起動し直す回数を制限しない。`RestartSteps` と `RestartMaxDelaySec` で、起動し直すまでの間隔を 1 秒から 1 分まで伸ばす。くり返し落ちる試行は、systemd ではなく pi-durable の restartLimit で止める（「落ちたとき」）。
- `RestartSteps`・`RestartMaxDelaySec` と、試行の scope に使う `systemd-run` の `--expand-environment` は、systemd 254 で入った（「技術調査結果」）。

### 起動

runner は次の順に進む。起動してすぐ、SIGTERM と SIGINT の handler（「止めるとき」）と、`uncaughtException`・`unhandledRejection` の handler（log に書いて終了 code 1 で終わる）を設定する。

1. Linux であること、環境変数 `INVOCATION_ID` があること、`/proc/self/cgroup` の `0::` で始まる行（cgroup v2）の path の最後の要素が、引数の dataDir から作った unit 名と同じことを確かめる。違えば、台帳も storage も開かずに終了 code 1 で終わる。pi-durable の storage を2つの process が開かないようにするため（storage は1つの process だけが開く前提で、process をまたぐ lock が無い）。
2. `loadConfig` で設定を読む。失敗したら終了 code 1 で終わる。設定ファイルはここでは読まない（「取り込み」で読む）。
3. 台帳を開く（無ければ作る。「file と接続」）。開けなければ終了 code 1 で終わる。`BEGIN IMMEDIATE` の中で `runner` の行を、`state` を `running`、`unit`・`invocation_id`（`INVOCATION_ID`）・`pid`・`started_at`・`heartbeat_at` を自分のものに、`stopped_at` を空にして書く。
4. dataDir の試行の scope（`araya-<h>-*.scope`）をすべて止める（「試行の scope」）。止められなければ、Harness を開かずに終了 code 1 で終わる（systemd が間隔を空けて起動し直す）。前の process が残した scope の中の process が、再開した会話や次の試行と重ならないようにするため。
5. pi-durable の storage（`<dataDir>/runner/durable.sqlite`。directory は mode 0700）を開き、Harness を開く。
   - `models`: Pi の `ModelRuntime`。既存の SHIKI と同じく、`authPath` を `<agentDir>/auth.json`、`modelsPath` を `<agentDir>/models.json`、`modelsStorePath` を `<dataDir>/runner/models-store.json`、`allowModelNetwork` と `refreshOnCreate` を `false` にして作り、`refresh({ allowNetwork: false })` する。`agentDir` は Araya 専用の `<dataDir>/pi`。host の Pi directory に fallback しない。
   - `registry`: SHIKI の extension（tool と途中経過の hook。「SHIKI」「途中経過」）と、試行の task を入れる。
   - `env`: pi-durable の `NodeExecutionEnv`（cwd は会話の cwd）。
   - `settings.restartLimit` は既定（5）のまま。
   - `onReport`: 種類と、秘密を置き換えた message を log に書く。
   - 開いた直後に `subscribeClose` で listener を登録し、Harness が閉じ始めたら印を付ける（listener は印を付けるだけで、Harness の API を呼ばない）。runner が `close()` を呼んでいないのに閉じ始めたら（storage の誤り）、「Harness が失敗で閉じたとき」に移る。
6. 開き直したときの確認を行う（次の節）。
7. `resume()` し、`running` の試行ごとに `waitForTask` で試行の task の終わりを待ち始めて、loop（「loop」）に入る。`resume()` を呼んだときの monotonic な時計の値を、`running` の試行すべての稼働時間の起点にする（「期限」）。

### 開き直したときの確認（`resume()` の前）

pi-durable は `resume()`（と `waitForTask()` など）で task を動かし始める。動かし始めると、落ちたときの phase が最初からやり直され、tool や検証のコマンドが中止の確認より先に動くことがある。このため、`resume()` の前に次を行う。ここでは `waitForTask` を呼ばない。

1. 台帳で `running` の試行ごとに、session の document（`araya.attempts`。taskKey と試行の task の id、会話の id と taskKey の対応を持つ）で試行の task を探す。無ければ（台帳で取り込んだ後、task を作る前に落ちた）、ここで作る（「取り込み」の手順 3）。有れば、`BEGIN IMMEDIATE` の中で `run.resumed` event を追加する。
2. `inspect()` で終わっていない task を見る。試行の task（document の id）と、試行の会話の中の task（record の `conversationId` が試行の会話）を、その試行のものとして扱う。
   - `blocked`（理由 `restart_limit`）: その試行を中止する（理由 `restart_limit`。「中止を始める」）。
   - `blocked`（ほかの理由。定義が無い、定義が古い、migrate に失敗した）: その試行を中止する（理由 `attempt_error`。詳細は blocked の理由）。
   - 台帳で `running` でない試行の task（document に有るが、台帳で終わっているか、台帳に無い）: `abortTask` で中止する。台帳には何も書かない。
3. 台帳で `running` の試行のうち、次に当たるものを中止する（上から順に、最初に当たったもの。「中止を始める」）。
   - `stop_reason` が書かれている（前の process が中止を始めた後に落ちた）: `abortTask` だけをもう一度呼ぶ。
   - `cancel_requested_at` がある: 理由 `cancelled`。
   - 期限を過ぎている（`agent_finished_at` が空で、`active_ms` が `settings_json.timeoutMs` 以上）: 理由 `agent_timeout`。

`abortTask` は `resume()` の前でも中止を記録でき、`resume()` の後に試行の task の `abort` が動く（「技術調査結果」）。

### loop

runner は、止めるように求められるまで、次を 2 秒ごとに（待っている試行の task が終わったときはすぐに）くり返す。

1. heartbeat: 前の heartbeat から 10 秒以上たっていれば、`BEGIN IMMEDIATE` の中で、`runner.heartbeat_at` を今の時刻にし、動かしている試行すべての稼働時間を精算する（「期限」）。
2. 期限: 期限を過ぎた試行を中止する（理由 `agent_timeout`。「期限」）。
3. 中止の求め: `cancel_requested_at` があり、`stop_reason` が空の `running` の試行を中止する（理由 `cancelled`）。
4. task の作り直し: 台帳で `running` なのに、この process がまだ試行の task を待っていない試行（前の loop で task を作れなかった）の task を作り、待ち始める（「取り込み」の手順 3・4）。
5. 取り込み（「取り込み」）。
6. 終わった試行の task の結果を記録する（「結果の判定と記録」）。

試行の task がまだ無い試行は、2 と 3 では、4 で task を作った後に中止する。Task が無い間、runner は台帳を読むだけで、model を呼ばない。

### 取り込み

1. 設定ファイルを読み、`loadConfig` の値と合わせて試行の設定（下）を作る。設定ファイルが不正なら、取り込みを行わない（内容が変わるまで、log に1回だけ書く）。`ModelRuntime` を `refresh({ allowNetwork: false })` する。
2. `BEGIN IMMEDIATE` の中で、`running` の試行の数が上限（「並列数を上げるとき」）より少なく、`queued` の試行があれば、`queued_at` が最も古いもの（同じなら Task ID と試行番号が小さいもの）を `running` にし、`started_at` を今の時刻に、`settings_json` を試行の設定にして、`tasks.status` を `running` にし、`run.started` event を追加する。同じ transaction で、試行の task の input（「試行の task」）に入れる Task の値と前回の試行を読む。commit した後の monotonic な時計の値を、その試行の稼働時間の起点にする（「期限」。待っていた時間は数えない）。
3. transaction の外で、pi-durable の root の会話の1つの commit の中で、試行の task を作り（`createTask`、`background: true`）、session の document（`araya.attempts`）に taskKey と task の id を書く。document に既に id があれば作らない。task を作れなければ log に書き、次の loop で作り直す（「loop」の 4。Harness が失敗で閉じたときは「Harness が失敗で閉じたとき」）。
4. `waitForTask` で試行の task の終わりを待ち始める。
5. 空きか待ちが無くなるまで 2 からくり返す。

試行の設定（`settings_json`）:

```json
{
  "devRoot": "/home/user/dev",
  "agentDir": "/home/user/.araya/pi",
  "model": { "provider": "anthropic", "id": "example-model", "thinkingLevel": "high" },
  "timeoutMs": 1200000,
  "verificationTimeoutMs": 300000
}
```

- 値は、既存の development executor に渡すものと同じ。`devRoot` は `ARAYA_DEV_ROOT`（既定 `~/dev`）の実 path（無ければ `loadConfig` の絶対 path）、`agentDir` は runner の `ModelRuntime` と同じ Pi の agent directory、`timeoutMs` は `ARAYA_DEVELOPMENT_TIMEOUT_MS`、`verificationTimeoutMs` は `ARAYA_VERIFICATION_TIMEOUT_MS`、`model` は設定ファイルの開発用の model（設定が無ければ `null`、thinking level の設定が無ければ `thinkingLevel` は `null`）。path はすべて絶対 path。
- 環境変数は、runner の unit file に書いた値（「unit の名前と file」）。変えるときは `araya runner install` をやり直す。設定ファイルは取り込みのたびに読むので、変えると次に取り込む試行から使われる。`running` の試行には反映されない。

### 中止を始める

runner が試行を中止するときは、次を行う。

1. `BEGIN IMMEDIATE` の中で、試行がまだ `running` で `stop_reason` が空のとき（理由が `agent_timeout` のときは、さらに `agent_finished_at` が空のとき）だけ、`stop_reason` に理由を、`stop_detail` に詳細（`attempt_error` のとき。秘密を置き換えた先頭 2,000 文字）を書き、`run.stopping` event を追加する。当たらなければ何もしない（ほかの理由で既に中止を始めた、SHIKI の終わりが既に記録された）。
2. transaction の外で、`abortTask` で試行の task を中止する。pi-durable は、動いている tool の process group を止めてから、試行の task の `abort` を動かす（「試行の task」）。試行の task が既に終わっていれば、`abortTask` は `terminal` を返して何も動かさない。そのときの結果は「結果の判定と記録」で決まる（中止の求めがあれば `cancelled`）。`abortTask` が失敗したら（Harness が閉じ始めた後は「Harness が失敗で閉じたとき」）、log に書き、`close()` で Harness を閉じ（30 秒まで待つ）、dataDir の試行の scope をすべて止め、`BEGIN IMMEDIATE` の中で動かしていた試行すべての稼働時間を今の時点まで精算して（`runner` の行は変えない）、終了 code 1 で終わる。`stop_reason` は書かれているので、loop は `abortTask` を呼び直さず、試行の task の `agent` の phase は中止を待つ（「試行の task」）。起動し直した runner が、開き直したときの確認で `abortTask` をもう一度呼ぶ。

落ちて起動し直した runner は、`stop_reason` がある `running` の試行の `abortTask` をもう一度呼ぶ（「開き直したときの確認」）。

### 止めるとき（一時停止）

- SIGTERM か SIGINT を受けたら、runner は試行を中止せずに止まる。
  1. loop の今の手順を終え、それ以降の取り込みと中止をしない。
  2. `close()` で Harness を閉じる（30 秒まで待つ）。pi-durable は、動いている phase の signal を止め、phase が返るまで待つ。動いている tool は途中で切られる。閉じた後の commit は記録されず、restartLimit にも数えられない（「技術調査結果」）。
  3. dataDir の試行の scope をすべて止める。Harness を閉じた後に止めるのは、先に止めると bash が終了 code 付きで終わり、会話がそれを tool の結果として記録しうるため。
  4. `BEGIN IMMEDIATE` の中で、動かしていた試行すべての稼働時間を、止めるように求められた時点まで精算し（「期限」）、`runner` の行が自分の invocation のものなら、`state` を `stopped`、`stopped_at` を今の時刻にする。終了 code 0 で終わる。
- 30 秒で閉じ終わらないか、3 で scope を止められなければ、log に書き、（閉じ終わらないときは 3 を飛ばして）4 を行い、終了 code 1 で終わる。process が終われば記録されることは無く、`ExecStopPost` が scope を止める。
- 試行は `running` のまま残り、次に runner が起動したときに続きから進む。途中だった tool は、落ちたときと同じく `interrupted` として model に返る（「落ちたとき」）。止まっている間に登録された Task も、次の起動で取り込む。
- 利用者の `systemctl --user stop`、host の停止、logout による user manager の停止（linger が無効のとき）は、どれもこの扱いになる。
- 60 秒（`TimeoutStopSec`）で終わらなければ systemd が SIGKILL を送り、落ちたときと同じ扱いになる。

### 落ちたとき

- runner が落ちると（SIGKILL、OOM、終了 code 1 など）、systemd は service に残った process を止め、`ExecStopPost` で dataDir の試行の scope を止めてから、間隔（1 秒から 1 分）を空けて起動し直す（`Restart=always`）。起動し直す回数は制限しない。
- 起動し直した runner は、同じ storage を開いて `resume()` し、会話を続きから進める。実行中だった tool は、model に誤り（「Tool bash was interrupted and may have partially run」。diagnostics の code は `interrupted`）として返る。完了していた tool は再実行されない。同じ `requestId` の submit は、前の process が受け付けた submission を返す。
- 状態を進めずに落ち続ける task は、pi-durable が `restartLimit`（5 回）で止める（parked。close は数えない）。runner は、起動し直したときにそれを見つけて（「開き直したときの確認」）、その試行を中止し、`blocked`（`restart_limit`）にする。ほかの試行は動き続ける。
- Harness を開く前に落ち続ける場合（設定の誤りなど）は、試行は進まず、systemd が最大 1 分の間隔で起動し直し続ける。理由は log に残る。
- runner が台帳の `heartbeat_at` を更新しなくなるので、CLI はそれを `not_responding` と出す（「CLI」）。

### Harness が失敗で閉じたとき

pi-durable は、storage の誤り（`commit()` の失敗など）が起きると Harness を自分で閉じる。誤りに当たった呼び出しは元の誤りで失敗し、それ以後の呼び出しと待っている `waitForTask` は `SessionFailed` で失敗する。同じ Harness では回復せず、開き直す必要がある。開き直すと、commit 済みの状態から続きを進める（「技術調査結果」）。runner は終了して、systemd に起動し直させる。

1. runner が `close()` を呼んでいないのに Harness が閉じ始めたら（「起動」の手順 5 の印）、loop をやめ、取り込み、中止、結果の記録を新しく始めない。Harness が閉じ始めた後に失敗した Harness の呼び出しと、`SessionFailed` で失敗した呼び出しは、その呼び出しの失敗として扱わない（取り込みの task の作成の失敗にも、試行の `attempt_error` にもしない）。誤りに当たった呼び出しは `SessionFailed` ではなく元の誤りで失敗するので、閉じ始めた印で見分ける（probe18 では、その呼び出しが失敗を返す前に listener が呼ばれた。待っている `waitForTask` は `SessionFailed` で失敗した。「技術調査結果」）。
2. `harness.closed` が決まるのを 30 秒まで待つ。pi-durable は、動いている task に中止の signal を送り、task のコードが返るのを待ってから閉じる。30 秒で決まらなくても 3 へ進む（失敗した Harness は commit できないので、scope を止めても会話に記録されない）。
3. dataDir の試行の scope をすべて止める（「試行の scope」）。
4. `BEGIN IMMEDIATE` の中で、動かしていた試行すべての稼働時間を、Harness が閉じ始めた時点まで精算する（「期限」）。`runner` の行は変えない。
5. log に書き（error の message は秘密を置き換える）、終了 code 1 で終わる。3 か 4 が失敗しても、log に書いて終了 code 1 で終わる。

- systemd は、落ちたときと同じく、間隔を空けて runner を起動し直す。試行は `running` のまま残り、次の起動で続きから進む。取り込みの transaction の後で task の作成が失敗した試行は、task が作られていないので（commit は atomic）、開き直したときの確認で作る（その手順 1）。
- 失敗で閉じたときに動いていた試行の task は、`restarts` が1つ増える（`close()` では増えない。「技術調査結果」）。同じ試行の途中で storage の誤りが restartLimit（5 回）の回数くり返されると、その試行は `blocked`（`restart_limit`）になる（「落ちたとき」と同じ）。
- storage の誤りが続く間は、Harness を開く前に落ち続ける場合と同じく、systemd が最大 1 分の間隔で起動し直し続ける。その間、試行は進まず、中止も行われない（理由は log に残る）。

### 終了 code

- 0: 止められて、Harness を閉じ、scope を止めた。
- 1: 予期しない誤り、起動の確認や後始末の失敗、閉じ終わらなかった、Harness が失敗で閉じた、`abortTask` が失敗した。systemd は、止めている最中（stop の job）でなければ起動し直す。

### log

- `<dataDir>/logs/runner.log`（mode 0600）に、1行1件の JSON で追記する。起動と停止、開き直したときの確認の結果、取り込み、中止とその理由、結果、`onReport` の内容、Harness が失敗で閉じたこと、設定ファイルの誤り、scope を止められなかったこと、予期しない例外（message と stack）だけを書き、秘密を置き換える（「秘密情報の扱い」）。試行に関するものには taskKey を入れる。prompt、環境変数、tool の引数と出力、model の応答は書かない。
- stdout と stderr は捨てる（`StandardOutput=null`・`StandardError=null`）。journal に秘密が残らないようにするため。runner が log を書く前に Node が止まったときは、journal に終了の状態だけが残る。

## 試行の scope

新しい経路が試行のために起動する subprocess は次の4つで、どれも試行ごとの systemd の scope の中で動かす。

- SHIKI の bash
- `araya_create_worktree` が起動する git（repository の確認と worktree の作成）
- 差分の収集が起動する git
- 検証のコマンド

ほかの tool（`read`・`edit`・`write`・`araya_register_verification`・`araya_request_decision`）と model の呼び出しは、runner の process の中で動き、subprocess を起動しない。runner が scope を止めて確かめるために使う `systemctl` は、試行のものではない。git も scope に入れるのは、git の hook などが切り離した process が runner の cgroup に残ると、runner が動き続ける限り止まらず、次の試行と重なるため。scope は runner の cgroup の外にできるので、runner の `KillMode` では止まらず、runner が止めるか、`ExecStopPost` が止める。scope の外で git と検証のコマンドを起動する経路は残さない（旧経路の executor は撤去する。「旧経路との関係」）。

- bash: SHIKI の bash は pi-durable の `createBashTool({ prepare })` で作る。`prepare` は、session の document（`araya.attempts`）で `api.conversationId` から taskKey を引き、command を次に置き換える（実際は1行）。taskKey が引けなければ、例外を投げて bash を失敗にする。

  ```text
  exec <systemd-run> --user --scope --quiet --collect --expand-environment=no
    --unit=araya-<h>-<taskKey>-<c>.scope -p KillMode=control-group
    -p TimeoutStopSec=10s -- <bash> -c '<元の command>'
  ```

  - `<c>` は、tool の呼び出しの id（`api.callId`）の SHA-256 の16進表記の先頭12文字。`<systemd-run>` と `<bash>` は、runner の起動時に PATH から探した絶対 path。`<元の command>` は、`'` を `'\''` にして単引用符で囲む。
  - `--expand-environment=no` は、`systemd-run` が command の中の `$` と `${名前}` を展開しないようにするため（既定では展開する）。
  - `TimeoutStopSec=10s` は、scope を止めるときに SIGTERM で止まらない process を 10 秒後に SIGKILL で止めるため。scope の既定は 90 秒で、下の「scope を止めるとき」の打ち切り（30 秒）を超える（「技術調査結果」）。
- 検証のコマンド: 既存と同じ `runBoundedCommand`（timeout、出力の上限、process group の停止）で、`<systemd-run> --user --scope --quiet --collect --expand-environment=no --unit=araya-<h>-<taskKey>-verify-<n>.scope -p KillMode=control-group -p TimeoutStopSec=10s -- <登録された command の各要素>` を実行する。`<n>` は登録の順番（0 から）。phase の signal が中止されたら（Harness を閉じたとき、試行を中止したとき）、timeout と同じ手順でコマンドを止める。コマンドが終わったら、その scope を止める。止められなければ、その検証の `terminationConfirmed` を `false`（`reason` は `termination_unconfirmed`）にする。
- git: `araya_create_worktree` と差分の収集は、git を `<systemd-run> --user --scope --quiet --collect --expand-environment=no --unit=araya-<h>-<taskKey>-git-<r>.scope -p KillMode=control-group -p TimeoutStopSec=10s -- <git> <引数>` で起動する。`<r>` は `a-z2-7` の 12 文字で、暗号学的乱数で選ぶ。git の path（既存と同じく、決まった候補から選んだ絶対 path）、引数、環境変数、timeout、出力の上限は既存と同じ（`araya_create_worktree` の git は hook を無効にせず、差分の収集の git は `core.hooksPath=/dev/null` を付ける）。git が終わって scope に process が残っていなければ、systemd が scope を消す（`--collect`）。hook などが process を残すと scope が残り、次にその試行の scope を止めるときに止まる。
- scope を止めるときは、`systemctl --user stop '<pattern>'` を実行してから、`systemctl --user list-units --all --plain --no-legend '<pattern>'` で残っていないことを確かめる（それぞれ 30 秒で打ち切る）。どちらかが失敗するか、残っていれば、止められなかったとする。ただし、`stop` の失敗のうち、unit が読み込まれていないための失敗は除く。`<pattern>` が1つの scope の名前（検証のコマンドの scope）で、その scope が既に消えていると、`stop` はこの失敗になる（glob なら、当たる unit が無くても成功する。「技術調査結果」）。
- 止める時期:
  - 試行の task の `evidence` の phase の始めと、`abort` の始め: その試行の scope（`araya-<h>-<taskKey>-*.scope`）。SHIKI の bash と `araya_create_worktree` の git が切り離した process が、差分の収集と検証の間に worktree を変えないようにするため。
  - 試行の結果を台帳に記録する前（「結果の判定と記録」）: その試行の scope。止められなければ結果を記録せず、枠も空かない。
  - runner の起動時（`resume()` の前）、止めるとき（Harness を閉じた後）、Harness が失敗で閉じたとき: dataDir の scope（`araya-<h>-*.scope`）。
  - runner の process が終わった後: `ExecStopPost` が dataDir の scope を止める。

## 試行の task

pi-durable の task（`defineTask`。名前は `araya.attempt`）。input は、taskKey、Task の title、課題の本文、`settings_json` の値、前回の試行の情報（再実行のとき）。phase が途中で落ちたとき（と Harness を閉じたとき）は、pi-durable が最後の checkpoint の phase を最初からやり直す。

試行の task は、outcome の result に試行の結果（状態、失敗の理由と詳細、summary、質問、model、台帳に入れる evidence）を入れて終わる。phase から終わるときの outcome は `completed`、`abort` から終わるときは `aborted`。

phase は次のとおり。

- `start`:
  1. 状態 directory `<dataDir>/development/<taskKey>/` を用意する。`attempt.json` は、同じ directory の一時 file に書いてから rename する。
     - 無ければ mode 0700 で作り、`attempt.json`（`{"taskKey": ..., "dataDir": ...}`）を書き、`BEGIN IMMEDIATE` の中で `runs.state_dir` に path を記録する。
     - あれば、`attempt.json` が自分の taskKey と dataDir を持つことを確かめ、`runs.state_dir` が空なら記録する。`attempt.json` が無く directory が空なら（作った直後に落ちた）、`attempt.json` を書いて続ける。それ以外で `attempt.json` が無いか、読めないか、違えば、`failed`（`task_state_already_exists`。worktree だけの evidence。ただし、その directory はこの試行のものと確かめられないので、状態 directory の path は `null`、worktree は空にする）で終わる。
  2. `settings_json.devRoot` が directory でなければ `failed`（`dev_root_missing`）、課題の本文が 80,000 文字を超えれば `failed`（`invalid_task`）で終わる。どちらも差分の収集と検証は行わない。
  3. model を決める（「SHIKI」の model）。決まらなければ、SHIKI の終わりを記録して（`agent` の手順 2 と同じ）、agent の失敗（`model_unavailable`）として `evidence` へ進む。
  4. 1つの commit の中で、試行の task が持つ会話（`ownership: task`）を作り、`configure` で model と thinking level、SHIKI の extension、tool、instructions、cwd（`settings_json.devRoot`）を設定し、session の document に会話の id と taskKey の対応を書き、会話の id を checkpoint に入れて `agent` へ進む（phase が途中で落ちてやり直しても、会話が2つできないようにするため）。
- `agent`:
  1. 既存の SHIKI と同じ課題の prompt（`development-agent.ts` の `buildTaskPrompt`。開発 root、taskKey、worktree の場所、題名に Task の title、`<task>` の中に課題の本文、進め方）を、`requestId` を taskKey にして会話に submit し、submission が終わるのを待つ。
  2. 終わったら、`BEGIN IMMEDIATE` の中で、試行がまだ `running` で、`agent_finished_at` と `stop_reason` が空のときだけ、`agent_finished_at` を今の時刻にする（SHIKI の終わりの記録。これより後は期限が効かない。「期限」）。当たらなかったときは、`stop_reason` が書かれていれば（runner が中止を始めた）、`evidence` へ進まずに、phase の signal が中止されるまで待つ（間もなく `abort` に移る）。`agent_finished_at` が既に書かれていれば（phase のやり直し）、続ける。
  3. submission が `done` なら、同じ commit の中で回答の entry（submission の `answer`）を読み、最後の assistant の message の text を報告として、agent の成功で `evidence` へ進む。それ以外（`unanswered` など）は、agent の失敗として `evidence` へ進む。理由は submission の `reason`（`model_error` など）、詳細は `detail`。
- `evidence`:
  1. その試行の scope を止める（「試行の scope」）。止められなければ、差分の収集と検証を行わずに `failed`（`termination_unconfirmed`。worktree だけの evidence）で終わる。
  2. 既存の development executor と同じ判定で、状態 directory の記録を読み、差分を集め、検証を実行し（「試行の scope」）、結果を決める（「結果の判定と記録」）。
  3. `evidence.json` を書き（「秘密情報の扱い」）、台帳に入れる evidence を result に入れて終わる。
- `abort`（中止）: 始めにその試行の scope を止め、台帳の `stop_reason` で結果を決める。
  - `agent_timeout`: scope を止められれば、差分を集め、登録された検証は実行せずに `not_run`（`reason` は `agent_timeout`）にして、`failed`（`agent_timeout`）にする（既存の timeout と同じ）。止められなければ `failed`（`termination_unconfirmed`。worktree だけの evidence）。
  - `cancelled`: `failed`（`cancelled`）。worktree だけの evidence。
  - `restart_limit`: `blocked`（`restart_limit`）。worktree だけの evidence。
  - `attempt_error`、または理由が無い: `failed`（`attempt_error`。`failure_detail` に `stop_detail`）。worktree だけの evidence。

「worktree だけの evidence」は、差分の収集と検証を行わずに作る evidence。`taskKey`、状態 directory の path（無ければ `null`）と、その `worktrees.jsonl` に記録された worktree の path と branch を残し、`bodiesStored` を `false` にする（`worktrees.jsonl` が無ければ worktree を空にし、読めなければ worktree を空にしてその旨を `failure_detail` に書く）。

## 期限

- SHIKI の会話（`start` と `agent` の phase）には、`settings_json.timeoutMs` の期限がある。期限は、試行の稼働時間（runner がその試行を動かしていた時間）で数える。待ちの間、runner が止まっていた間、落ちてから起動し直すまでの間は数えない（一時停止しても期限は減らない）。
- 稼働時間の数え方:
  - runner は、動かしている試行ごとに、起点（monotonic な時計の値）を memory に持つ。起点は、この process がその試行を取り込んだ時点（「取り込み」の手順 2 の commit の後）か、起動して `resume()` を呼んだ時点（「起動」の手順 7）。
  - 試行の稼働時間は、`runs.active_ms` と、未加算の時間（今の monotonic な時計の値と起点の差）の和。
  - 精算: `BEGIN IMMEDIATE` の中で未加算の時間を `active_ms` に足し、起点を、その時間を測った時点の値に進める。runner は、heartbeat（「loop」の 1）と結果の記録（「結果の判定と記録」の手順 3）では今の時点まで、止めるとき（「止めるとき」の 4）は止めるように求められた時点まで、Harness が失敗で閉じたとき（その手順 4）は閉じ始めた時点まで、`abortTask` が失敗して終わるとき（「中止を始める」の 2）は今の時点まで精算する。heartbeat の間に終わった試行や、短い一時停止をくり返した試行の時間も、これで数えられる。
  - 時計は monotonic なもの（`process.hrtime.bigint()` など）を使い、test では差し替えられるようにする。
- runner は loop ごとに、`agent_finished_at` と `stop_reason` が空の `running` の試行について、稼働時間が `timeoutMs` 以上なら、理由 `agent_timeout` で中止する（「中止を始める」）。起動したときは、`resume()` の前に `active_ms` だけで判定する（「開き直したときの確認」）。
- SHIKI の終わりの記録（`agent_finished_at`）と、期限による中止（`stop_reason`）は、どちらも台帳の `BEGIN IMMEDIATE` の中で、もう一方が空のときだけ書く。先に書かれた方だけが効く。SHIKI が期限の直前に終わったときは検証まで進み、期限が先なら `agent_timeout` になる（`agent` の phase は、`stop_reason` が先に書かれていれば `evidence` へ進まない。「試行の task」）。
- SHIKI の終わりが記録された後（`evidence` の phase）は、期限は使わない（検証のコマンドには既存の `verificationTimeoutMs` の timeout がある）。
- runner が落ちると、最後に精算してからの時間（heartbeat の間隔の 10 秒まで）は数えられない。

## 中止

- runner が試行を中止する理由は、利用者の中止（`cancelled`）、期限（`agent_timeout`）、pi-durable が試行を止めた（`restart_limit`）、試行の task を動かせない（`attempt_error`）。手順は「中止を始める」、結果は「試行の task」の `abort`。
- `araya task cancel <taskId>`（「CLI」）:
  - 最新の試行が `queued`: `BEGIN IMMEDIATE` の中で、試行を `failed`（`cancelled`）にし、`cancel_requested_at` と `finished_at` を今の時刻にして、`tasks.status` を `failed` にし、`task.cancel_requested`（`while: queued`）と `run.finished` event を追加する。その試行は動かない。
  - 最新の試行が `running`: `BEGIN IMMEDIATE` の中で、`cancel_requested_at` が空なら今の時刻にし、`task.cancel_requested`（`while: running`）event を追加する。既に求められていれば何もしない。runner は次の loop（2 秒以内）で中止を始める。runner が止まっていれば、次に起動したときに `resume()` の前に中止する。試行の task が既に終わっていても、その試行は `failed`（`cancelled`）で記録される（「結果の判定と記録」の「利用者の中止を優先する」）。
  - それ以外（`completed`・`failed`・`blocked`）: `task_not_cancellable` で拒否する。
- runner が中止した試行の task では、差分の収集と検証を行わない（「試行の task」の `abort`）。試行の task が中止の前に終わっていたときは、その evidence（差分と検証の結果）を残す。どちらも worktree と branch は残す。
- 中止は、それまでの作業（worktree の変更、実行した検証、外部への変更）を元に戻さない。

## SHIKI

### model

- `settings_json.model` があれば、その provider・id・thinking level を使う。
- `null` なら、Pi の設定（`SettingsManager`。既存の SHIKI と同じく `agentDir` と状態 directory で作る）の既定の provider と model（`getDefaultProvider`・`getDefaultModel`）を使う。
- thinking level は、`settings_json.model.thinkingLevel`（あれば）、Pi の設定の model ごとの値（`getModelThinkingLevel`）、Pi の設定の既定（`getDefaultThinkingLevel`）、`medium` の順で決め、model の対応範囲に丸める（pi-ai の `clampThinkingLevel`）。既存の SHIKI（Pi の SDK の session）と同じ決め方にするため（[開発 model の設定](development-model-config.md)）。pi-durable の既定（`off`）は使わない。
- model が決まらないとき（`null` で Pi の既定も無い、`ModelRuntime` に無い、認証が無い）は `model_unavailable`。message は既存の SHIKI と同じ（「configured model … is not in the Pi model list」「… has no Pi authentication」など）。
- 使った model は、`runs.model_json` と、SHIKI の終わりが決まった試行の evidence の `agent.model`（「結果の判定と記録」）に、`source`（`araya-config` か `pi-settings`）付きで残す（既存と同じ）。`evidence` の phase の前に中止された試行（worktree だけの evidence）では、`runs.model_json` にだけ残る。runner が試行の task の結果を得られずに `attempt_error` にした試行（「結果の判定と記録」の手順 1）では、どちらにも残らない（`null`）。
- 認証は Pi の `auth.json`（runner の `ModelRuntime`）から読む。環境変数の API key は runner に渡らない（「unit の名前と file」「既知の制限」）。

### tool

7種類。

- `read`・`edit`・`write`・`bash`: pi-durable の `createReadTool`・`createEditTool`・`createWriteTool`・`createBashTool`。bash は試行の scope の中で動かす（「試行の scope」）。
- `araya_create_worktree`・`araya_register_verification`: 既存の tool を pi-durable の `defineTool` で作り直したもの。入力、検証、状態 directory に書く file（`worktrees.jsonl`・`verifications.jsonl`）、結果の内容は既存と同じ。状態 directory は、会話の id から session の document で引いた taskKey のもの。
- `araya_request_decision`: 「判断の依頼」。
- 既存の SHIKI が持つ Pi 標準の `grep`・`find`・`ls` は、pi-durable に無いので持たない。必要なら bash で行う。
- subagent、codemode、tool-search など、ほかの extension は使わない（「Out of scope」）。

### instructions

既存の system prompt（`development-agent.ts`）を `instructions` に使い、次の2文を足す。

- 「人の判断が無いと進められないときは、推測で進めずに araya_request_decision で質問し、作業を終えてください」
- 「grep・find・ls の tool はありません。必要なら bash で実行してください」

### 課題の本文

日本語で、次の順に組み立てる。値が無い項目は見出しごと省く。

```text
目的:
<goal>

制約:
- <constraints の各要素>

作業対象の手がかり（必要な repository は自分で判断してよい）:
- <targets の各要素>

この Task で SHIKI に許可されていること（SHIKI 自身は commit・push・PR 作成・merge・deploy・publish をしない。Araya は全検証成功後に commit・push・Draft PR を行い、merge・deploy・publish は行わない）:
- <permissions の各要素>

前回の試行（<試行番号>回目）の結果:
- 結果: <status>（<failureReason>）
- 報告: <summary>
- 人への質問: <decisionQuestion>
- 前回の worktree（編集しない。必要なら読んでよい）:
  - <worktreePath>（branch <branch>）

追加の指示:
<note>
```

- 取り込みのときに runner が組み立て、試行の task の input に入れる。
- 「前回の試行」は再実行のときだけ付け、直前の試行1つだけを書く。報告は先頭 4,000 文字まで。worktree は前回の evidence の `worktrees` に記録されたものをすべて書く。
- 入力の上限から、組み立てた本文は通常 80,000 文字に収まる。超えた場合は、試行を `failed`（`invalid_task`）にする（「試行の task」の `start`）。

### 判断の依頼（`araya_request_decision`）

- 入力: `{"question": "..."}`。question は空白以外の文字を含む 2,000 文字以内の文字列で、NUL を含まない。
- 状態 directory の `decision.json` に `{"question": ..., "requestedAt": ...}` を書く。2回目以降の呼び出しは tool の誤りを返し、最初の質問を残す。
- tool の結果として「質問を記録しました。ここで作業を終え、ここまでの内容を報告してください」を返す。

## 途中経過

- SHIKI の extension の hook（`beforeTool`・`afterTool`）で、runner が台帳の `task_events` に直接書く（`tool.started`・`tool.finished`）。hook の `api.conversationId` から、session の document で試行を引く。hook は tool の引数も結果も変えない。
- `data_json` は `{"tool": <tool の名前>}` に、次の key だけを足したもの。
  - `read`・`edit`・`write`: 引数の `path` が文字列なら `path`（先頭 300 文字）
  - `araya_create_worktree`: 引数の `repository` と `base`（文字列なら、それぞれ先頭 300 文字）
  - `araya_register_verification`: 引数の `repository` と `cwd`（同上）
  - `tool.finished` のとき: `isError`（結果の `isError` が `true` なら `true`、それ以外は `false`）
- bash のコマンド、tool の結果、model の応答は書かない。台帳と log に秘密を写さないため。
- 1件は `data_json` の UTF-8 で 2 KiB まで（超える値は短くする）。1試行で 2,000 件まで。超えたら `events.truncated` を1件書き、それ以降は書かない。件数は台帳の event の数で数える（runner が起動し直しても続きから数える）。
- 台帳に書けなかったときは、log に書いて、tool はそのまま進める。
- 再開した会話では、途中で止まった tool の `tool.finished` は書かれない。

## 結果の判定と記録

- 判定は既存の development executor と同じで、次を加える。
  - agent が成功し（timeout や agent の失敗ではない）、状態 directory の記録が正しく、`decision.json` があれば `blocked`。差分は集めて evidence に残し、登録された検証は実行せずに `not_run`（`reason` は `decision_requested`）とする。差分が無いことや検証が無いことは失敗にしない。
  - agent が timeout（`agent_timeout`）や失敗で終わった場合は、`decision.json` があっても `failed`（既存の理由）にする。質問は `decision_question` と evidence に残す。
  - `decision.json` の形式が不正なら `failed`（`task_state_invalid`）。
  - 失敗の理由に `cancelled`（利用者が中止した）と `attempt_error`（試行の task を動かせない、または想定外の状態で終わった）を、`blocked` の理由に `restart_limit`（pi-durable が試行を止めた）を加える。どれも差分の収集と検証を行わない。
- 試行の task は、outcome を記録する commit の前に `evidence.json` を書く（「秘密情報の扱い」）。
- 試行の task が終わったら（`waitForTask` が返したら）、runner が次を行う。runner が止めている最中か、Harness が閉じ始めた後に `waitForTask` が返ったとき（`SessionFailed` で失敗したときを含む）は、何もしない（次の起動で待ち直す。「Harness が失敗で閉じたとき」）。
  1. outcome の result から試行の結果を取る。outcome が `completed` か `aborted` で result に試行の結果があるもの以外（`failed`・`orphaned`・`faulted`、result が無い、`waitForTask` が例外で終わった）は、`failed`（`attempt_error`。`failure_detail` に outcome の status と error の message（秘密を置き換えた先頭 2,000 文字））にする（worktree だけの evidence）。
  2. その試行の scope を止める（「試行の scope」）。止められなければ、結果を記録せずに次の loop でやり直す。その間、枠は空かない。止め終えた後（手順 3 の transaction を始める前）に、runner が止めている最中か、Harness が閉じ始めていれば、結果を記録せずに次の起動に持ち越す（試行は `running` のままで、稼働時間は「止めるとき」の 4 か「Harness が失敗で閉じたとき」の 4 で精算する）。
  3. `BEGIN IMMEDIATE` の中で、試行がまだ `running` のときだけ、試行の稼働時間を精算し（「期限」）、`runs` の `status`・`finished_at`・`summary`（4,000 文字まで）・`model_json`・`decision_question`・`failure_reason`・`failure_detail`・`evidence_json` と、`tasks` の `status`・`updated_at` を更新し、`run.finished` event を追加する。同じ transaction で `cancel_requested_at` を読み、書かれていれば、次の「利用者の中止を優先する」に従う。
- 利用者の中止を優先する: 手順 3 の transaction で、試行の `cancel_requested_at` が書かれていて、手順 1 の結果が `failed`（`cancelled`）でなければ、試行の task の結果にかかわらず（試行の task が中止の前に終わっていた場合や、ほかの理由で中止されていた場合を含む）、`failed`（`cancelled`）として記録する。
  - `failure_detail` は空にする。summary、model、質問、evidence（差分と検証の結果、`bodiesStored`、`bodiesSha256`）は、試行の task の結果のまま残す。
  - 台帳の evidence の `outcome` と `failureReason` を `failed` と `cancelled` にし、試行の task の結果を `resultBeforeCancel`（`{"status": ..., "failureReason": ..., "failureDetail": ...}`）として足す（`evidence.json` には入らない）。
  - CLI の中止（「中止」）と手順 3 は、どちらも `BEGIN IMMEDIATE` の中で試行が `running` かを確かめるので、順番が1つに決まる。中止が先なら結果は `failed`（`cancelled`）になり、記録が先なら CLI は `task_not_cancellable` を返す。`araya task cancel` が `requested` か `already_requested` を返した試行は、必ず `failed`（`cancelled`）で終わる。
  - pi-durable は、終わった試行の task への `abortTask` では何もしない（`terminal` を返し、`abort` は動かない。「技術調査結果」）。このため、中止の求めは、`abortTask` の結果ではなく、この transaction で確かめる。
- evidence は既存の形（`taskKey`、`devRoot`、`outcome`、`summary`、`worktrees`（worktree ごとの差分と検証）、`failureReason` など）を、次のように変えたもの。台帳には、ここから本文を除いたものを入れる（「秘密情報の扱い」）。
  - `agent`: SHIKI の終わり方（SHIKI の終わりが決まった試行だけ）。既存の evidence が top level に持つ `model`・`agentError`・`workerErrorName`・`workerErrorMessage` は、この object にまとめ、top level には置かない。`model` は使った model（決まらなかったときは無い）。失敗のときは、`error`（既存の `agentError` に当たるもの。`agent_timeout`、`model_unavailable`、submission の `reason` など）と `errorMessage`（model が決まらないときはその message、submission のときは `detail`（文字列でなければ JSON にしたもの）。秘密を置き換えた先頭 2,000 文字。無ければ省く）を入れる。
  - `timeoutMs` と `tools`（SHIKI に渡した tool の名前）: 実行環境を明示するため
  - `decisionQuestion`
  - `redactions`、`bodiesStored`、`bodiesSha256`（「秘密情報の扱い」）
  - `previousAttempt`（再実行のとき、前回の試行番号と、前回の `worktrees` の path と branch）
  - `resumes`（その試行の `run.resumed` event の数）と `activeMs`（手順 3 で精算した後の `runs.active_ms`）: runner が台帳に記録するときに足す（`evidence.json` には入らない）

## 秘密情報の扱い

Issue #1 の「Secrets を通常ログや Task 台帳に複製しない」のために、次を行う。

- 差分の本文（各 worktree の `diff`）と検証の出力（各検証の `stdout` と `stderr`）は台帳に入れない。試行の task は、差分を集めた試行では、それらを含む evidence 全体を状態 directory の `evidence.json`（mode 0600）に書き、台帳に入れる evidence からはそれらの key を除く。evidence の `bodiesStored`（boolean）は、`evidence.json` を書けたときだけ `true` にし、そのときは書いた内容（byte 列）の SHA-256 を `bodiesSha256` に入れる（この2つは書いた後に決まるので、`evidence.json` には含めない）。書けなかった本文は捨てる。差分を集めなかった試行では `evidence.json` を書かず、`bodiesStored` を `false` にする。
- `evidence.json` は outcome を記録する commit の前に書くので、書いた後、commit の前に runner が落ちると、phase がやり直されて `evidence.json` が書き直される。台帳に入る `bodiesSha256` は、最後に記録された outcome のもの。`evidence.json` を台帳の試行の結果として扱うのは、台帳の evidence の `bodiesStored` が `true` で、file の SHA-256 が `bodiesSha256` と一致するときだけにする（「CLI」の `--full`）。
- 台帳、`evidence.json`、log に文字列を書く前に、次を `[REDACTED]` に置き換える。
  - 秘密とみなす環境変数の値。runner と CLI が、起動時に自分の環境変数から集める。名前を大文字にしたときに `TOKEN`・`SECRET`・`PASSWORD`・`PASSWD`・`API_KEY`・`APIKEY`・`PRIVATE_KEY`・`CREDENTIAL`・`AUTH` のどれかを含み、値が 8 文字以上のもの（`SSH_AUTH_SOCK` は socket の path なので除く）。長い値から順に置き換える。
  - URL の userinfo（`<scheme>://<userinfo>@` の `<userinfo>`）。git の誤りの message などに、remote の URL に埋め込まれた token が含まれることがあるため。
- 元の文字列の先頭か末尾だけを持つ文字列（上限で切って読んだ差分と検証の出力など）は、上の置き換えの前に、切った境界に接する部分も置き換える。秘密の値や URL の userinfo の一部が、境界をまたいで残らないようにするため。
  - 末尾を切った文字列: 末尾が秘密の値の先頭の部分と一致すれば、その部分を置き換える。末尾が `<scheme>://` の後に空白・`/`・`@` の無い文字列で終わっていれば、`://` より後を置き換える。
  - 先頭を切った文字列: 先頭が秘密の値の末尾の部分と一致すれば、その部分を置き換える。先頭から最初の `@` までに空白と `/` が無ければ、その `@` より前を置き換える。
- 置き換える対象は、`runs` の `summary`・`decision_question`・`failure_detail`・`stop_detail`、evidence の中のすべての文字列（JSON にする前に置き換える）、`task_events.data_json` の中のすべての文字列、log のメッセージ、CLI が stderr に出す `systemctl` の誤り。置き換えた回数の合計を evidence の `redactions` に残す（値は残さない）。
- 利用者が書いた Task の入力（`title`、`goal`、`constraints`、`targets`、`permissions`）と `note` は置き換えない。
- runner の unit file に書く環境変数は「unit の名前と file」の一覧だけにする。systemd は値を unit の定義として持ち、`systemctl --user show` で表示する（「技術調査結果」）。unit file の mode は 0600 にする。
- pi-durable の storage（`<dataDir>/runner/durable.sqlite`）には、すべての試行の会話（課題の本文、model の応答、tool の引数と出力）が残る。mode 0700 の directory の中に置くので、利用者以外は読めない。台帳を読む command は、この file を開かない。runner の umask は変えない（SHIKI が worktree に作る file の mode を、利用者の通常の作業と同じにするため）。
- 途中経過には bash のコマンドと tool の結果を書かない（「途中経過」）。
- SHIKI には、既存の system prompt の規則（「認証情報や秘密情報（token、鍵、.env、auth.json など）を読み出したり、出力したりしないでください」）をそのまま与える。

## 再実行

- `araya task retry <taskId>`。対象は `failed` と `blocked` の Task だけ。ほかは `task_not_retryable` で拒否する。
- 「確認が必要な試行」とは、取り込まれた試行のうち、(a) runner や agent が途中で止まったため外部への変更が済んだか分からないもの、または (b) Draft PR 配送 evidence が remote branch/PR の作成・更新済み、もしくは push 結果未確認を示すものをいう。中断理由と `model_unavailable` の例外は従来どおりである。
  - 最新の試行がこれに当たるときは、`--confirm-side-effects` が無ければ `side_effects_unconfirmed` で拒否し、試行を作らない。stderr には「前回の試行では外部の branch や Draft PR が作成・更新された可能性がある、または結果を確認できません。前回の worktree と GitHub の状態を確かめてから、--confirm-side-effects を付けて再実行してください」と、前回の worktree の path を出す。
  - `--confirm-side-effects` を付けたときは、`task.retried` event の `confirmedSideEffects` を `true` にする。
  - 課題の本文の「前回の試行」に、確認が必要なときは次の注意を足す: 「- 注意: 前回の試行では外部の branch や Draft PR が作成・更新された可能性がある、または結果を確認できません。同じ操作をくり返す前に、前回の worktree と GitHub の状態を確かめてください。」
- `BEGIN IMMEDIATE` の中で Task の状態を確かめ、次の試行（`current_attempt + 1`、`queued`、新しい taskKey、追加の指示）を作り、`tasks.current_attempt` と `tasks.status` を更新し、`task.retried` event を追加する。runner が次の loop で取り込む。
- 新しい試行は、新しい taskKey・状態 directory・試行の task と会話・worktree・branch を使う。前回の worktree と branch は残し、課題の本文と evidence で場所を示す。前回の変更を自動で持ち込まない。
- 自動の再実行はしない。

## 試行の入力

- taskKey: `task-<Task ID>-<試行番号>-<suffix>`。suffix は `a-z2-7` の6文字で、暗号学的乱数で選ぶ（例: `task-12-1-k3m7qz`）。台帳を作り直して Task ID が 1 から始まっても、残っている worktree・branch・scope と名前が重ならないように乱数を付ける。試行を `queued` で作るときに決めて `runs.task_key` に入れる。
- worktree と branch: 既存と同じ規則で `<repository root>/.worktree/araya-<taskKey>` と `araya/<taskKey>`。taskKey を検証する箇所（`development/worktrees.ts` など）は、この形式だけを受け付ける。旧形式（`development-` と16進20桁）の taskKey は旧経路の executor だけが作り（`computeTaskKey`）、この手順で撤去する。
- title: Task の title。
- 課題の本文: Task から組み立てる（「課題の本文」）。

## CLI

- Linux 以外では、`araya task` と `araya runner` のどの command も何もせずに `unsupported_platform` で終わる。
- 各 command は起動時に設定ファイルを読み、不正なら何もせずに終わる（既存の command と同じ）。
- 出力は JSON 1件を stdout に出す（既存の `araya status` と同じ）。誤りは stderr にメッセージを出し、終了 code 1 で終わる。ただし、この環境では使えないことを表す誤り（`unsupported_platform`、`systemd_unavailable`）では、終了 code 69（sysexits.h の EX_UNAVAILABLE）で終わる（`npm run deploy` は、この終了 code で見分ける。「`npm run deploy`」）。code のある誤り（`unsupported_platform`、`systemd_unavailable`、`task_not_found` など）のメッセージは、`<code>: <説明>` の形にする。
- `<taskId>` は 1 以上の10進の整数。存在しない Task ID は `task_not_found`。
- `araya task` の command は台帳だけを読み書きし、runner を起動しない。止めてある runner を、Task の登録で勝手に動かさないため。出力の `runner.state` が `running` でなければ、stderr に「runner が動いていません（<state>）。araya runner install で入れるか、systemctl --user start <unit> で起動してください」と出す（終了 code は変えない）。

command:

- `araya task create --file <path|->`
  - 出力: `{"created": boolean, "task": TaskView, "runner": RunnerView, "queue": QueueView}`
- `araya task list [--status <状態>] [--limit <1〜200>]`
  - 既定は全状態、Task ID の大きい順に 50 件。
  - 出力: `{"runner": RunnerView, "queue": QueueView, "tasks": [TaskSummary]}`
- `araya task show <taskId> [--events <0〜500>] [--full]`
  - `events` は seq の新しいものから既定 50 件を取り、seq の昇順で並べる。
  - 既定では、台帳の evidence（本文を除いたもの）を出す。`--full` のときは、台帳の evidence の `bodiesStored` が `true` の試行について、状態 directory の `evidence.json` を読み、その SHA-256 が台帳の evidence の `bodiesSha256` と一致すれば、台帳の evidence の `worktrees` を `evidence.json` の `worktrees`（本文を含む）に置き換えたものを出す（本文は `worktrees` の中にだけある。台帳の evidence にだけある `resumes`・`activeMs`・`resultBeforeCancel` などと、runner が記録のときに変えた `outcome`・`failureReason` は、台帳のものになる）。それ以外の試行では台帳の evidence を出し、AttemptView の `fullEvidenceError` に理由（`not_stored`: `bodiesStored` が `true` でない、`missing`: file が無い、`unreadable`: 読めない、`digest_mismatch`: SHA-256 が一致しない）を出す。試行の状態、失敗の理由、summary などは、`--full` でも台帳のものを出す。
  - 出力: `{"task": TaskView, "attempts": [AttemptView], "events": [EventView], "runner": RunnerView, "queue": QueueView}`。`attempts` は試行番号の昇順。
- `araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]`
  - 出力: `{"task": TaskView, "runner": RunnerView, "queue": QueueView}`
- `araya task cancel <taskId>`（「中止」）
  - 出力: `{"task": TaskView, "cancel": "cancelled" | "requested" | "already_requested", "runner": RunnerView, "queue": QueueView}`。`cancelled` は待ちの試行をその場で中止した、`requested` は動いている試行の中止を求めた、`already_requested` は既に求められていた。`requested` と `already_requested` の試行は、必ず `failed`（`cancelled`）で終わる（「結果の判定と記録」）。
- `araya runner install`
  1. systemd の user manager に接続できることを確かめる。`systemctl --user is-system-running` を 10 秒で打ち切って実行し、stdout の1行目が `initializing`・`starting`・`running`・`degraded`・`maintenance`・`stopping` のどれかなら接続できたとする（終了 code は見ない）。接続できなければ `systemd_unavailable` で失敗する。
  2. dataDir と `<dataDir>/logs` を用意し（無ければ mode 0700 で作る）、unit file の内容を作る（「unit の名前と file」）。`unsupported_path` なら何も書かずに失敗する。
  3. unit file を、同じ directory の一時 file（mode 0600）に書いてから rename する。directory が無ければ mode 0700 で作る。
  4. `systemctl --user daemon-reload` を実行し、`systemctl --user show --property=FragmentPath --value <unit>` が書いた file の path と同じことを確かめる。違えば `unit_not_loaded` で失敗する（user manager が別の directory を見ている）。
  5. `systemctl --user enable <unit>` と `systemctl --user restart <unit>` を実行する。restart は、動いている runner を一時停止してから、新しい unit file と、入れ直した araya のコードで起動し直す。
  6. 台帳の `runner` の行が新しい invocation の `running` になるのを 10 秒まで待つ（待てなければ、そのときの値を出す）。
  7. `linger` を、`loginctl show-user <uid> --property=Linger --value` が `yes` なら `true`、`no` なら `false`、取れなければ（`loginctl` が失敗したときを含む）`null` にする。`false` なら、stderr に「logout すると runner が止まります。logout の後も動かすには、loginctl enable-linger で linger を有効にしてください」と出す。araya は linger を変えない。
  - `systemctl` と `loginctl` は、それぞれ 30 秒（restart は 90 秒）で打ち切る。`systemctl` が失敗したら、その stderr の先頭 500 文字（秘密を置き換えたもの）を stderr に出して、終了 code 1 で終わる（`loginctl` の失敗は、上の 7 のとおり `null` にして続ける）。
  - 出力: `{"unit": "...", "unitPath": "...", "linger": true | false | null, "runner": RunnerView}`
- `araya runner uninstall`
  - `systemctl --user disable --now <unit>`（90 秒で打ち切る）、unit file の削除、`systemctl --user daemon-reload` を行う。`disable --now` の失敗のうち、unit が無いための失敗だけを無視する。そのときは、unit file が無くても unit が読み込まれたまま動いていることがある（unit file を消した後など）ので、続けて `systemctl --user stop <unit>`（90 秒で打ち切る）を行い、unit が読み込まれていないための失敗だけを無視する。それ以外の失敗は、`install` と同じく扱う（終了 code 1）。台帳は変えない。動いていた試行は `running` のまま残り、runner を入れ直すと続きから進む。
  - 出力: `{"unit": "...", "removed": boolean}`（`removed` は unit file を消したかどうか）

出力の形:

- TaskSummary: `id`、`title`、`status`、`attempt`、`failureReason`、`decisionQuestion`、`createdAt`、`updatedAt`（`failureReason` と `decisionQuestion` は最新の試行のもの）
- TaskView: TaskSummary に `goal`、`constraints`、`targets`、`permissions`、`summary`（最新の試行のもの）、`cancelRequested`（最新の試行が `running` で `cancel_requested_at` があれば `true`）を足したもの
- AttemptView: `attempt`、`status`、`taskKey`、`note`、`queuedAt`、`startedAt`、`agentFinishedAt`、`finishedAt`、`activeMs`、`cancelRequestedAt`、`stopReason`、`model`、`summary`、`decisionQuestion`、`failureReason`、`failureDetail`、`stateDir`、`evidence`（`--full` で `evidence.json` を使えなかったときは `fullEvidenceError` も）
- EventView: `seq`、`attempt`、`at`、`type`、`data`
- RunnerView: `{"unit": ..., "state": "running" | "stopped" | "not_responding" | "not_started", "pid": ..., "startedAt": ..., "heartbeatAt": ..., "stoppedAt": ...}`
  - `not_started`: `runner` の行が無い（`unit` は dataDir から作った名前、ほかは `null`）。
  - `not_responding`: 行の `state` が `running` で、`heartbeat_at` が 60 秒より前（落ちて起動し直すのを待っている、など）。
- QueueView: `{"limit": <実行枠の上限>, "running": <running の試行の数>, "queued": <queued の試行の数>}`

`araya --help` に `task` と `runner` の command を加える。

## `npm run deploy`

`npm run deploy`（`scripts/deploy.sh`）は、araya を build して prefix に入れた後（docs/development.md の「deploy の仕組み」）、入れた araya（`<prefix>/bin/araya`）で `araya runner install` を実行する。初めての deploy では runner を入れ、動いている runner も止めてある runner も、書き直した unit file と入れたコードで起動し直す（restart）。動いていた試行は一時停止の扱いになり、続きから進む（「止めるとき（一時停止）」）。runner install は runner を起動する前に Araya config が無い場合だけ Pi の明示的な `defaultProvider`・`defaultModel` から `development.model` を一度だけ初期設定する。既存 file は変更せず、Pi の認証や model API は使わない。詳細は「開発 model の設定」を参照する。

- 対象の runner は、deploy を実行した環境の `ARAYA_DATA_DIR`（無ければ `~/.araya`）のもの。unit file の `Environment=` も、その環境の値で書き直す。
- `PATH` は、`npm run` が先頭に足した entry を外して `araya runner install` に渡す（unit file の `PATH` になる）。`PATH` の先頭から、`/node_modules/.bin` か `/node-gyp-bin` で終わる entry が続く間を見て、その中の最後の `/node-gyp-bin` までを外す（「技術調査結果」の npm）。`/node-gyp-bin` が無ければ（`npm run` を通さずに実行したとき）、`PATH` を変えない。外さないと、checkout の `node_modules/.bin`（araya の開発用の道具）と npm の内部の directory が runner の `PATH` に入り、SHIKI の bash と検証のコマンドがそれを使う。checkout を移動・削除しても、入れた araya は影響を受けないという前提も崩れる。
- `araya runner install` の stdout と stderr は、そのまま出す。
- `araya runner install` が終了 code 69 で終わったとき（`unsupported_platform` か `systemd_unavailable`。「CLI」）は、「この環境では runner を使えないため、runner を入れずに終わります（araya は入れました）」と stderr に出し、終了 code 0 で終わる。stderr の文では見分けない（設定ファイルの key など、誤りのメッセージに入る利用者の値によっては、`<code>: ` で始まる行ができることがあるため）。
- それ以外の終了 code で終わったとき（`unsupported_path`、`unit_not_loaded`、`systemctl` の失敗、設定ファイルの誤りなど）は、araya を入れたまま、「error: araya は入れましたが、runner を入れられませんでした。上の理由を直してから、araya runner install を実行してください」と stderr に出し、終了 code 1 で終わる。
- npm の pack と install が失敗したときは、`araya runner install` を実行しない。
- deploy は、runner が起動したことまでは確かめない（`araya runner install` は起動を 10 秒まで待ち、待てなくても成功で終わる。「CLI」）。

## 旧経路との関係

利用者の選択で、旧経路の worker をこの手順で撤去する。SHIKI を動かすのは runner だけになり、旧経路と runner を同時に使っても、SHIKI が同時に2つ動くことは無い。araya はまだ運用していないので、撤去は runner より先に行い、この仕様を追加する PR（#8。worker を撤去する PR）に含める（利用者の判断）。worker を撤去してから runner ができるまでは、development の課題を動かす経路が無い。旧経路と runner の両方で development の課題を動かせる版は作らない。動いている旧経路からの入れ替え（実行中の worker、旧経路が実行を始めた課題、旧形式の taskKey の worktree と branch）は扱わない。

### 撤去するもの

- worker の entrypoint（`bin/development-worker.ts`）
- worker を起動して応答を読む処理（`development-process.ts` の `runPiWorker`・`parsePiWorkerResult`・`PiWorkerInput` と、worker の path の解決、応答の検証、worker 用の上限の定数）
- Pi の SDK の session（`createAgentSession`）で SHIKI を動かす処理（`development-agent.ts` の `runDevelopmentAgent`、Pi の SDK 用の tool の定義（tool の説明の文は `shiki.ts` に移す）、`DEVELOPMENT_TOOL_NAMES`・`hasUsableModel`・`findAssistantFailure`）
- 旧経路の development executor（`development.ts` の `createDevelopmentExecutor`・`DevelopmentExecution`・`DevelopmentTaskRunner`・`DevelopmentExecutorOptions`）のうち、SHIKI が終わる前の部分（opportunity から課題を作る、開発 root を確かめる、状態 directory を作る、worker を起動する）。SHIKI が終わった後の部分は、新しい経路に移す（下）。
- 旧形式の taskKey を作る `computeTaskKey`（`development/worktrees.ts`）
- executor を渡す引数（`openArayaRuntime`・`tickAraya`・`createArayaTasks`・`createWorkTask`）、`runtime.ts` での executor の作成、WorkTask の executor の呼び出しと、そのための `claimWorkspaceOpportunity`（`control-plane.ts`）
- 撤去したものだけを確かめる test（`development-built.test.ts`、`development-agent.test.ts`、`development-process.test.ts` の `runPiWorker`・`parsePiWorkerResult`・development worker の test、`development.test.ts` のうち SHIKI が終わる前の部分（課題の検証、開発 root、状態 directory の作成）と、worker に渡す model、worker が報告した model と誤りの記録だけを確かめるもの、`development-worktrees.test.ts` の `computeTaskKey` の test）。新しい経路の同じ確かめは、「Acceptance Criteria」の test で行う。残す test で taskKey を作るのに `computeTaskKey` を使っている箇所は、新しい形式の taskKey に置き換える。`araya.test.ts` の、`tickAraya` に executor を渡して development の課題を実行する test は、「撤去した後の旧経路」の動作を確かめる test に直す。

### 新しい経路に移して使うもの

worker を撤去する PR で残し（関数への切り出しと file の移動を含む）、runner の版で使う。

- executor の、SHIKI が終わった後の部分（状態 directory の記録を読み、差分を集め、検証を実行し、結果を決める）。関数に切り出し、試行の task の `evidence` の phase で使う（「実装の置き場所」）。`development.test.ts` のうち、この部分を確かめるもの（差分、検証、失敗の理由、状態 directory の記録の検証、symlink の扱い、diff の上限など）は、切り出した関数を直接呼ぶ test に直して残す。
- 検証のコマンドの実行（`development-process.ts` の `runBoundedCommand`・`runVerificationCommand`）と、その test
- `araya_create_worktree`・`araya_register_verification` の処理（`development/worktrees.ts`）と、その test
- 課題の prompt、system prompt、model が使えないときの message、tool の説明の文（`development-agent.ts` から `shiki.ts` へ）
- 設定ファイルと model の指定（`config-file.ts`・`development-model.ts`）と、その test

### 撤去した後の旧経路

- 旧経路は development の課題を実行しない。inbox の `development` の行の取り込み（形の検証を含む）は変えない。WorkTask は、課題の形（`kind` と `risk` の組）と状態の確認を今のまま行い、`discovered` の development の課題を、SHIKI を動かさずに `blocked` にして（evidence は `{"type": "development_executor_unavailable", "opportunityId": ...}`）、`no_executor` で終わる。既存の、executor が渡されていないときの動作と同じ。
- それ以外の旧経路（JSONL inbox、`tick`/`run`、goal・scout・observation・opportunity、承認・outbox、旧経路の Pi Durable）の動作、schema、evidence の形は、手順4 で撤去するまで変えない。旧経路は台帳と runner を使わない。
- worker を撤去する PR では、README と `araya --help` から、worker で development の課題を動かす説明を除き、inbox に development の課題を書いても実行されず `blocked` になること、Task の台帳と runner を実装中であることを書く。runner の版で、development の課題を `araya task create` で登録し、runner が動かす説明にする。
- `docs/spec/human-authored-development-loop.md` と `docs/spec/development-model-config.md` の冒頭に、worker で課題を動かす部分はこの手順で撤去し、この仕様に置き換えたことを書く。SHIKI の作業と完了の判定、設定ファイルの形は、それぞれの文書を基準のままにする。

## 並列数を上げるとき

MVP の上限は 1。将来上げられるように、次のように作る。

- 上限は1か所の定数（`MAX_CONCURRENT_ATTEMPTS`）で持つ。runner の取り込みと CLI の出力（`queue.limit`）は、この値を使う。
- runner は上限を引数で受け取る。test では上限 2 でも動かし、複数の試行を同時に動かす経路を確かめる（「Acceptance Criteria」）。
- 試行ごとに、試行の task と会話、状態 directory、worktree、branch、scope、evidence が分かれているので、上限を上げても仕組みは変えない。

上限を上げる前に、次を確かめる（この手順では行わない）。

- 同じ repository に複数の SHIKI が同時に worktree を作っても、git の lock（`index.lock`、`config.lock` など）で失敗しないか。失敗するなら、repository ごとに worktree の作成を直列にする。
- 1つの `ModelRuntime` を複数の会話が同時に使い、Pi の認証情報（`auth.json`）の OAuth token を更新しても壊れないか。
- 検証コマンドが同時に動いても、固定の port や共有の cache で干渉しないか。
- model の API の rate limit と費用、host の CPU とメモリ。
- runner が落ちると、動いているすべての試行の task が restartLimit に数えられる。1つの試行が runner を落とし続けると、ほかの試行も止められる（parked）ことがある。
- 上限を設定ファイルで変えられるようにするか。

## 名前の統一

worker を撤去する PR で、旧名（`agentctl`）を次の箇所で `araya` に直す。

- docs/development.md の inbox の例（`payload.task` の文）
- `docs/spec/human-authored-development-loop.md` の `araya_create_worktree` と `araya_register_verification` の入力例
- `araya_create_worktree` の `repository` の説明にある例（`development-agent.ts` の tool の定義。`shiki.ts` に移すもの）
- test の入力値（`development-intake.test.ts`。`development-process.test.ts` の該当箇所は worker の入力の test で、撤去する）

`scripts/deploy.sh` の旧 package の uninstall と、それを説明する docs/development.md の文は残す。

## 実装の置き場所（目安）

- 台帳: `packages/araya/src/runner/ledger.ts`
- runner の本体（起動、開き直したときの確認、loop、取り込み、中止、結果の記録、止めるとき）: `packages/araya/src/runner/runner.ts`
- 試行の task と SHIKI の extension（hook と session の document）: `packages/araya/src/runner/attempt.ts`
- SHIKI の tool（pi-durable 版）と instructions: `packages/araya/src/development/shiki.ts`。`araya_create_worktree` は、`createWorktreeService`（`development/worktrees.ts`）に git を起動する関数を渡して使う（必須の引数にし、`execFile` で直接起動する経路は残さない）
- systemd の操作（`systemctl`・`systemd-run`・`loginctl` の呼び出し、scope の command、unit file の内容。test で差し替える）: `packages/araya/src/infrastructure/systemd.ts`
- 差分の収集、検証、判定: executor の、SHIKI が終わった後の部分を `development/result.ts` の中で関数に切り出す（executor のほかの部分は撤去する。「旧経路との関係」）。git と検証のコマンドを起動する関数を必須の引数で受け取り、runner は scope の中で起動する関数を渡す。検証のコマンドの実行（`runBoundedCommand`）に、中止の signal を受け取る引数を足す
- 旧経路の worker の撤去（worker を撤去する PR。runner より先）: 「旧経路との関係」の「撤去するもの」と「新しい経路に移して使うもの」
- runner の entrypoint: `packages/araya/bin/task-runner.ts`
- CLI: `packages/araya/src/cli/main.ts` に `task` と `runner` を加える。誤りの終了 code は `exitCodeOf`（`packages/araya/bin/cli.ts` が使う）
- deploy: `scripts/deploy.sh`（test は `packages/araya/test/deploy.test.ts`。npm と、npm が入れる araya を偽物にする）

## 既知の制限

- `araya task` と runner は、Linux と systemd（254 以降）の user manager が必要。logout した後も runner を動かすには、利用者が linger（`loginctl enable-linger`）を有効にする。araya は linger を変えない。linger が無効だと、logout で runner は止まり（一時停止）、次に user manager が起動したときに続きから進む。
- worker を撤去した版から runner の版までは、development の課題を実行できない（利用者の判断。「旧経路との関係」）。
- runner の環境変数は、unit file に書いた一覧のものと user manager の環境だけ。model の認証を環境変数だけで行っている場合は、SHIKI は model を使えず `agent_failed`（`model_unavailable`）になる。SHIKI の bash、git、検証のコマンドにも、ほかの環境変数（token、proxy の設定など）は渡らない。環境変数を変えたら `araya runner install` をやり直す。
- `npm run deploy` が起動し直すのは、deploy を実行した環境の `ARAYA_DATA_DIR` の runner だけ。ほかの `ARAYA_DATA_DIR` の runner と、deploy が runner を入れなかったとき（user manager に接続できない session から deploy したときなど）の runner は、`araya runner install`（か `systemctl --user restart <unit>`）をやり直すまで、前に読み込んだコードで動き続ける（次に起動したときからは、入れたコードで動く）。入れ直しで試行の task の定義が変わると、動いていた試行が `attempt_error` になることがある。
- `npm run deploy` は、止めてある runner も起動する。止めたままにするときは、deploy の後に `systemctl --user stop <unit>` を実行する。
- unit file に書く path と値に、ASCII の制御文字、空白、引用符、`\`、`$`、`%`、`;` を使えない（`unsupported_path`）。
- SHIKI の tool に `grep`・`find`・`ls` は無い（bash で代用する）。model を設定しないときは Pi の設定の既定だけを使い、既存の SHIKI のように「認証のある最初の model」へは切り替えない。
- 再開した会話（一時停止の後と、落ちた後）では、途中で止まった tool が一部だけ実行されていることがある。model が同じ操作をやり直し、外部への変更をくり返すことがある。evidence の `resumes` で、再開があったかどうかが分かる。
- 期限は runner が動いていた時間で数えるので、一時停止を挟んだ試行は、壁時計では `timeoutMs` より長くかかる。runner が落ちると、最後に精算してからの時間（10 秒まで）が数えられない。
- pi-durable の storage の誤りでは、runner が終了して起動し直す（「Harness が失敗で閉じたとき」）。誤りが続く間は試行が進まず、中止もできない。同じ試行の途中で restartLimit の回数くり返されると、その試行は `blocked`（`restart_limit`）になる。
- pi-durable の storage には、すべての試行の会話が残り、SHIKI が読んだ秘密が含まれることがある。自動では消さず、大きくなり続ける。`runner.log` も自動では消さない。
- 置き換えられるのは、秘密とみなす環境変数の値と URL の userinfo だけ。それ以外の秘密（file の中身など）を SHIKI が報告に書けば台帳の `summary` に、test が出力すれば `evidence.json`（検証の stdout と stderr の末尾 8 KiB ずつ）に残る。
- pi-durable は experimental で、release の間で API が変わる。version を上げたら、「技術調査結果」の確認と test をやり直す。

## Out of scope

- Pi Extension（手順2）、実 model での E2E（手順3）、旧経路の worker 以外の撤去（手順4）
- Task の終了の通知、自動の再実行
- 実行枠の上限を 2 以上にすること（「並列数を上げるとき」）
- 開発以外の Task。頼まれなくても自分で仕事を見つける動き（dots の proactive research）
- Linux 以外と、systemd の user manager が無い環境での実行。linger の管理
- worktree・branch・状態 directory・pi-durable の storage・log・台帳の古い記録の自動削除
- SHIKI での subagent・codemode・tool-search・skill の利用（pi-durable は対応している。後の段階で検討する）
- runner に渡す環境変数を設定で増やすこと

## Acceptance Criteria

test は実際の Pi auth や model API を使わない。model は pi-ai の faux provider を `ModelRuntime` に登録して使う（`registerNativeProvider`）。systemd の操作（`systemctl`・`systemd-run`・`loginctl`）は差し替えられるようにし、通常の test では偽物を使う（偽物は scope を作らずに command を直接実行し、起動した command とその scope の名前、止めた scope と止められなかった scope を記録する）。runner の本体は関数として実装し（monotonic な時計と、pi-durable の storage を開く関数を引数で受け取る）、同じ process の中で test できるようにする。process をまたぐ test（runner の SIGKILL・SIGTERM と再開）には、faux の model を使い、unit の確認を飛ばす test 用の entrypoint を test の directory に置く（build と package には含めない）。本物の systemd を使う test は、環境変数（`ARAYA_TEST_SYSTEMD=1`）を付けたときだけ実行し、unit file は書かずに、unit file と同じ property の transient unit（`systemd-run --user`）で runner を動かす。test は利用者の `~/.config/systemd/user` と実際の dataDir に書かない。

- [ ] `araya task create` は正しい入力で Task と1回目の試行を `queued` で作り、runner を起動しない。不正な入力（未知の key、長さや件数の超過、256 KiB 超、NUL、空白だけの値）は、Task を作らずに終了 code 1 で拒否する。
- [ ] 同じ `idempotencyKey` での2回目の作成は、同じ Task を `created: false` で返し、試行を増やさない。ほかの値が違えば `idempotency_conflict` で拒否する。
- [ ] 動いている runner は、登録された試行を次の loop で取り込み（`run.started`）、試行の task として動かす。Task が無い間は model を呼ばず、`heartbeat_at` を更新し続ける。
- [ ] 上限 1 では、2件の Task を続けて登録しても、`running` の試行が同時に2つになることがない。2件目は1件目の結果が記録された後に取り込まれる。
- [ ] 上限を 2 にした test では、3件の Task のうち古い2件が同時に `running` になり、3件目はどちらかの結果が記録された後に取り込まれる。
- [ ] 取り込みの transaction の後、試行の task を作る前に runner が落ちると（test で再現）、起動し直した runner が試行の task を1つだけ作り、試行は終わる。
- [ ] runner（faux の model）は、SHIKI に worktree を作らせ、編集させ、検証を登録させ、検証が通ると試行を `completed` にする。summary は SHIKI の最後の回答、model と evidence（`timeoutMs`、`tools` の7つの名前、`resumes` が 0、`activeMs`）が台帳に記録され、別の process から `araya task show` で同じ内容を読める。
- [ ] runner は、`INVOCATION_ID` が無いとき、または `/proc/self/cgroup` の unit 名が dataDir から作った名前と違うとき、台帳と storage を開かずに終了 code 1 で終わる。
- [ ] SHIKI の bash の実行中に runner を SIGKILL し、同じ引数で起動し直すと（test 用の entrypoint）、会話が続きから進んで試行が終わる。途中だった bash は model に `interrupted` の誤りとして返り、完了していた tool は再実行されない。`run.resumed` event が1件残り、evidence の `resumes` が 1 になる。
- [ ] SHIKI の bash の実行中に runner に SIGTERM を送ると、runner は試行を中止せずに終了 code 0 で終わり、試行は `running` のまま、`runner.state` は `stopped` になる。起動し直すと会話が続きから進んで試行が終わり、試行の task の `restarts`（`inspect()`）は増えない。止まっている間に登録した Task と求めた中止は、起動し直した後に行われる（中止は `resume()` の前）。
- [ ] 検証のコマンドの実行中に runner に SIGTERM を送ると、検証のコマンドは止まり、runner は 30 秒以内に終わる。起動し直すと `evidence` の phase がやり直され、試行は終わる。
- [ ] SHIKI が、runner が動いている時間で `timeoutMs` を過ぎても終わらないと、試行は `failed`（`agent_timeout`）になり、差分が集められ、登録された検証は `not_run` になる。実行中だった bash の process group は止まる。runner を `timeoutMs` より長く止めてから起動し直しても、それだけでは期限で中止されない。`active_ms` が `timeoutMs` 以上の試行がある状態で runner を起動すると、`resume()` の前に中止を始め、その試行の model は呼ばれない。
- [ ] SHIKI の終わりの記録と期限による中止が重なったとき（test で順番を固定する）、先に台帳に書かれた方だけが効く。SHIKI の終わりが先なら検証まで進み、期限が先なら `agent_timeout` になる。どちらでも `run.finished` は1件。
- [ ] 試行の稼働時間は、その試行を取り込んだ時点から数える（時計を差し替えた test）。heartbeat の 8 秒後に `timeoutMs` 5,000 の試行を取り込んでも、取り込んでから 5 秒たつまでは期限で中止されない。heartbeat の間に終わった試行の `activeMs` は、取り込みから記録までの時間になる。heartbeat の間隔（10 秒）より短い間隔で runner の一時停止と起動をくり返しても、稼働時間は足され続け、`timeoutMs` に達すると `agent_timeout` で中止される。
- [ ] 試行の task が pi-durable の `restartLimit` で止められると（test では `restartLimit` を小さくする）、試行は `blocked`（`restart_limit`）になり、待っていた次の試行が取り込まれる。試行の task が想定外の outcome（phase が例外を投げた `faulted` など。pi-durable 1.4.0 では、phase の例外は `faulted` になる）で終わったときは `failed`（`attempt_error`）になり、`failure_detail` に outcome の status が入る。
- [ ] pi-durable の storage の commit を1回だけ失敗させると（storage を包んだ test。試行の task の phase の commit と、取り込みの後の `createTask` の commit のそれぞれ）、runner は取り込みと結果の記録をやめ、scope を止めて、終了 code 1 で終わる。試行は `running` のままで、`attempt_error` にならない。同じ dataDir で起動し直すと、試行の task が続きから進み（`createTask` が失敗したときは、試行の task が1つだけ作られ）、試行は終わる。
- [ ] `araya task cancel` は、`queued` の試行をその場で `failed`（`cancelled`）にし、その試行は取り込まれない。`running` の試行には中止を求め、runner は次の loop で中止を始め、試行は `failed`（`cancelled`）になる。実行中だった bash は止まり、差分の収集と検証は行われない。`completed`・`failed`・`blocked` の Task は `task_not_cancellable` で拒否する。
- [ ] 試行の task が outcome を commit した後、台帳に結果を記録する前に `araya task cancel` を実行すると（test で順番を固定する）、CLI は `requested` を返し、runner の `abortTask` は `terminal` を返し、試行は `failed`（`cancelled`）になる。evidence には試行の task が集めた差分と検証の結果が残り、`resultBeforeCancel` に試行の task の結果が入る。runner の loop が中止の求めを確かめた後、結果を記録する前に中止を求めた場合も（test で順番を固定する）、`failed`（`cancelled`）になる。結果を記録した後の `araya task cancel` は `task_not_cancellable` で拒否される。どの場合も `run.finished` は1件。
- [ ] SHIKI の bash が `setsid` で切り離した process は、`evidence` の phase の始めに止まる（SHIKI が終わった後に worktree を変える process を残し、その変更が差分に入らないことを確かめる）。試行の結果が記録された時点で、その試行の scope は残っていない。次の試行の開始時に、前の試行が残した process は 0 件。
- [ ] 新しい経路の git（`araya_create_worktree` と差分の収集）と検証のコマンドは、その試行の scope の名前（`araya-<h>-<taskKey>-git-<r>.scope`・`araya-<h>-<taskKey>-verify-<n>.scope`）で起動される（偽物の systemd の記録）。
- [ ] 試行の結果を記録する前に scope を止められないと（`systemctl` を差し替えた test）、結果は記録されず、試行は `running` のまま枠を使い続け、次の試行は取り込まれない。止められるようになると、結果が記録される。`evidence` の phase の始めに止められないと、差分の収集と検証は行われずに `failed`（`termination_unconfirmed`）になる。
- [ ] runner の起動時に、前の process が残した scope を止められないと（`systemctl` を差し替えた test）、Harness を開かずに終了 code 1 で終わる。
- [ ] model が誤りを返すと（faux の `stopReason: 'error'`）、試行は `failed`（`agent_failed`）になり、evidence の `agent.error` が `model_error`、`agent.errorMessage` が秘密を置き換えた message になる。model が決まらない（Pi の既定が無い、`ModelRuntime` に無い、認証が無い）ときは `agent_failed` で、`agent.error` が `model_unavailable` になる。
- [ ] SHIKI が `araya_request_decision` を呼んで成功で終わると、試行が `blocked` になって質問が記録され、検証は実行されない。timeout で終わった場合は `failed` になる。
- [ ] `settings_json.devRoot` が directory でなければ `failed`（`dev_root_missing`）、課題の本文が 80,000 文字を超えれば `failed`（`invalid_task`）になり、どちらも会話を作らない。状態 directory の `attempt.json` が別の taskKey のものなら `failed`（`task_state_already_exists`）になる。
- [ ] `failed` と `blocked` の Task だけを再実行できる。新しい試行は新しい taskKey・状態 directory・試行の task と会話・worktree・branch を使い、前回の worktree は残る。追加の指示、前回の結果、前回の worktree の場所が課題の本文に入る。
- [ ] 最新の試行が「途中で止まった試行」（取り込まれた後に `cancelled`・`restart_limit`・`attempt_error`・`termination_unconfirmed`・`agent_timeout`・`agent_failed`（`agent.error` が `model_unavailable` のものを除く）で終わった）なら、`--confirm-side-effects` の無い再実行は `side_effects_unconfirmed` で拒否され、試行は増えない。付けると再実行でき、`task.retried` event の `confirmedSideEffects` が `true` になり、課題の本文に注意の1行が入る。`model_unavailable` の試行と、取り込まれる前に中止した試行は、`--confirm-side-effects` なしで再実行できる。
- [ ] 途中経過（tool の開始と終了）が `task_events` に記録され、`data_json` には「途中経過」の key だけがある。SHIKI の bash のコマンドと tool の結果に含めた秘密の文字列が、`task_events` にも log にも現れない。2,000 件を超えると `events.truncated` が1件記録され、それ以降は記録されない。
- [ ] 秘密とみなす環境変数の値と userinfo 付きの URL を、検証コマンドが stdout と stderr に出し、SHIKI が報告にも書いても、台帳のどの table にも、`evidence.json` にも、log にもその値が現れず、`redactions` に置き換えた回数が残る。台帳の evidence には差分と検証の出力の本文が無く、`araya task show --full` のときだけ `evidence.json` から出る。
- [ ] 試行の task が `evidence.json` を書いた後、outcome の commit の前に runner が落ちると（test で再現）、起動し直した runner で `evidence` の phase がやり直され、結果が1回だけ記録され（`run.finished` は1件）、`araya task show --full` は、記録された `bodiesSha256` と一致する `evidence.json` の本文（`worktrees`）を、台帳の evidence に入れて出す。`evidence.json` の中身を変えた試行では `digest_mismatch` を出す。
- [ ] `araya runner install` は、「unit の名前と file」の内容（`ExecStart`、`ExecStopPost`、`Environment=` の一覧、property）で unit file を mode 0600 で書き、`daemon-reload`・`enable`・`restart` を実行する（`systemctl` を差し替えた test）。`ARAYA_DATA_DIR` と `ARAYA_DEV_ROOT` に相対 path を設定し、dataDir と違う cwd から実行しても、unit file の dataDir と `Environment=` は絶対 path になる。秘密とみなす名前の変数（`OPENAI_API_KEY`、`ARAYA_TEST_TOKEN` など）や一覧に無い変数は書かれない。dataDir に空白・`$`・`%` などがあれば、unit file を書かずに `unsupported_path` で失敗する。`FragmentPath` が書いた file と違えば `unit_not_loaded` で失敗する。
- [ ] `araya runner install` は Araya config が無く、Pi の `settings.json` に有効な明示的 `defaultProvider` と `defaultModel` がある場合だけ、`development.model` を mode 0600 で初期設定する。`thinkingLevel` と認証情報は写さず、Pi auth/API は使わない。既存 config は変更せず、default が不足・不正なら warning を出して作成せず続ける。並行する初期化も既存 file を上書きしない。
- [ ] `araya runner uninstall` は unit を止めて無効にし、unit file を消す。台帳の試行は変わらない。
- [ ] `araya task` の出力の `runner.state` は、runner の行が無ければ `not_started`、`stopped` なら `stopped`、`heartbeat_at` が 60 秒より前なら `not_responding` になり、どれも stderr に注意が出る。
- [ ] 台帳の接続で `busy_timeout` が 5000 になっている。複数の process から同時に書いても `SQLITE_BUSY` で失敗しない。
- [ ] 台帳の `user_version` が未知の値なら、台帳を変更せずに失敗する。
- [ ] Linux 以外では `araya task` と `araya runner` が `unsupported_platform` で失敗する（判定を差し替えた test）。
- [ ] 旧経路の `araya tick` は、inbox の `development` の課題を、worker も model も起動せずに `blocked`（evidence の `type` が `development_executor_unavailable`）にする（`araya.test.ts` の、executor を渡して development の課題を実行する test を、これを確かめる test に直す）。それ以外の旧経路の既存の test は、変えずに通る。worker を撤去する PR で満たす。
- [ ] `git grep -n -E 'development-worker|runPiWorker|parsePiWorkerResult|PiWorkerInput|runDevelopmentAgent|createAgentSession|createDevelopmentExecutor|DevelopmentTaskRunner|computeTaskKey|claimWorkspaceOpportunity' -- packages` が何も返さない。worker を撤去する PR で満たす。
- [ ] build 済みの package（`dist`）の module で作った unit file の `ExecStart` の entrypoint は、`dist/bin/task-runner.js` の絶対 path で、その file は通常の file として存在する（撤去する `development-built.test.ts` の代わり。`npm test` は build してから実行する）。
- [ ] 本物の systemd の test（`ARAYA_TEST_SYSTEMD=1`）: runner の main process を SIGKILL すると、`ExecStopPost` が試行の scope（`setsid` した process を含む）を止めてから、systemd が runner を起動し直し、試行が終わる。`systemctl --user stop` では起動し直さず、試行の scope も止まり、次の起動で続きから進む。restartLimit（test では小さくする）で止まるまで落ち続けても、systemd は起動し直すのをやめない。同じ unit 名で2つ目の runner は起動しない。`araya_create_worktree` の git の hook（`post-checkout`）が `setsid` で切り離して残した process は、試行の結果が記録された時点で止まっている。test の後に `araya-` で始まる unit と、test が作った process が残っていない。
- [ ] `git grep -i agentctl -- ':!docs/spec/task-ledger-and-shiki-runner.md'` が `scripts/deploy.sh` の1行と `docs/development.md` の1行だけを返す。worker を撤去する PR で満たす。
- [ ] `npm run deploy`（`scripts/deploy.sh`）は、npm の install の後に、入れた `<prefix>/bin/araya` で `araya runner install` を実行する。そのときの `PATH` は、`npm run` が足した entry（入れ子の `npm run` で重ねて足したものを含む）を外したもので、元の `PATH` にあった `node_modules/.bin` は残る。`npm run` を通さないときは `PATH` を変えない（npm と araya を偽物にした test。本物の npm の `npm run deploy` でも確かめる）。`araya runner install` の stdout と stderr は deploy の出力に出る。
- [ ] `araya runner install` が終了 code 69（`unsupported_platform` か `systemd_unavailable`）で終わったときは、deploy は注意を出して終了 code 0 で終わる（本物の araya の CLI で、user manager に接続できないときと、`PATH` に `systemctl` が無いときも確かめる。どちらも unit file を書かない）。それ以外の終了 code では、stderr に `<code>: ` で始まる行があっても、araya を入れたまま終了 code 1 で終わる（本物の araya の CLI で、未知の key に改行と `systemd_unavailable: ` を含む設定ファイルでも確かめる）。npm の install が失敗したときは、`araya runner install` を実行しない。
- [ ] CLI は、`unsupported_platform` と `systemd_unavailable` では終了 code 69、ほかの誤りでは終了 code 1 で終わる（code の無い誤りは、message が `<code>: ` で始まっても 1）。
- [ ] README とこの仕様が新しい動作を説明している。

## Assumptions（方針と調査から導いた判断）

- Task ID は台帳の中で増える整数にする。会話の中で人が指しやすいため。台帳を作り直すと 1 から始まるので、worktree・branch・scope の名前には乱数を含む taskKey を使う。
- 台帳は旧経路と別の SQLite file にする。手順4 で旧経路の file を消すときに、台帳へ影響させないため。
- SHIKI の会話は pi-durable の Harness で動かす。Issue #1 は agent loop・セッション・tool 実行を Pi が担い、araya では再実装しないとしている。pi-durable は araya が既に依存しており、会話と tool の記録、落ちた後の再開、途中で止まった tool の扱い、中止を持つ。
- 常駐する runner を1つ動かし、試行ごとに process を起動しない。理由は次のとおり。
  - 利用者が、厳密な起動数の管理より、dots のように動き続けて作業を続けられる仕組みを求めた。前の版（試行ごとの transient service と dispatch）では、起動の契機、起動の確認、遅れて起動した場合の対策、再 dispatch の上限を自前で作る必要があり、review の指摘もそこに集まった。
  - 1つの runner が pi-durable の storage を1つ持てば、取り込み、実行、再開、中止を1つの process の中で行える。runner の二重起動は、unit 名の一意性（systemd）と入口の確認で防ぐ。
  - Issue #1 の「SHIKI は Task ごとの独立 Pi 実行で、常駐不要」は、「常駐する runner の中で、Task ごとに独立した会話として動く」に改める。ARAYA は窓口の Extension のままで、1つの長い会話にはしない（Issue #1 が当面作らないとしている「永遠に生き続ける1体の Agent/セッション」は対象外のまま）。
- 待ちの一覧は台帳に置き、取り込みの後の実行・再開・中止は pi-durable に任せる。CLI と Extension は別の process で、pi-durable の storage に書けない（1つの process だけが開く前提）ため。
- 新しい経路が試行のために起動する subprocess（SHIKI の bash、`araya_create_worktree` と差分の収集の git、検証のコマンド）を、試行ごとの scope に入れる。runner は長く動き続けるので、試行ごとに切り離された process を止めないと溜まり、次の試行と重なる。git も、hook などが切り離した process を残しうる。scope は runner の cgroup の外にあり、`setsid` した process も止められる。runner が落ちても `ExecStopPost` と起動時の後始末で止まる（「技術調査結果」）。試行の結果は scope が残っていないことを確かめてから記録し、それまで枠を空けない。git と検証のコマンドを起動する関数は必須の引数で受け取り、runner は scope の中で起動する関数を渡す（test では偽物の systemd を使う）。scope の外で起動する経路を残さないため。
- runner を止めるのは一時停止にする。動き続けて作業を続けるという方針に合わせ、host の再起動や runner の入れ替えで試行を失敗にしないため。やめたい試行は `araya task cancel` で中止する。前の版では、止められた試行を失敗にしていた。
- 期限は runner が動いていた時間で数える。一時停止の間に期限が過ぎて、起動し直した直後に試行が失敗しないようにするため。試行ごとに、この process が動かし始めた時点（取り込みか `resume()`）を起点にして、heartbeat、結果の記録、止めるときに精算する。runner 共通の heartbeat を起点にすると、取り込む前の待ち時間まで数え、heartbeat の間隔より短い一時停止をくり返したときの時間を数えられないため。数えた時間は台帳に書く。pi-durable の checkpoint に書くと状態の変化として扱われ、落ち続ける試行が restartLimit で止まらなくなるため（restartLimit は状態を変えずに切られた回数を数える）。
- 期限による中止は、利用者の中止と同じく `abortTask` で行う。起動したときに、`resume()` の前に判定して中止を記録できるため。phase の中から会話だけを止める方法（`ConversationHandle.abort()`）も確かめたが（「技術調査結果」）、これは task を動かし始める呼び出しなので、`resume()` の前には使えない。
- 落ち続ける試行は pi-durable の restartLimit で止め、systemd は起動し直すのをやめない（`StartLimitIntervalSec=0`）。前の版の systemd の起動回数の上限と再 dispatch の上限は、restartLimit と役割が重なり、上限どうしの大小の調整も要った。Harness を開く前に落ち続ける場合は、起動し直す間隔を 1 分まで伸ばして負荷を抑え、log に残す。
- restartLimit で止まった試行は `blocked` にする。試行が自分で失敗したのではなく、人の判断（再実行するか、やめるか）を待っているため。
- 利用者が中止を求めた試行は、試行の task が先に終わっていても `cancelled` にする（利用者の選択）。CLI が中止を受け付けたのに結果が `completed` になる場合を無くし、「受け付けた中止は必ず効く」という1つの規則にするため。pi-durable は終わった task への `abortTask` では何もしないので、台帳に結果を記録する transaction で中止の求めを確かめる。試行の task が集めた evidence は、中止の後でも何が行われたかを確かめられるように残す。
- Harness が storage の誤りで閉じたときは、runner を終了 code 1 で終わらせ、systemd に起動し直させる。pi-durable は失敗した Harness を回復せず、開き直すことを求める。runner の中で開き直すより、起動時の確認と後始末（scope の停止、開き直したときの確認）を同じ経路で通せるため。
- 旧経路の worker は、手順4 を待たずにこの手順で撤去する（利用者の選択）。worker を残すと、旧経路と runner を同時に使ったときに SHIKI が同時に2つ動く。実行枠を共有するには、旧経路の holder の生死の判定と、holder が残した子 process の後始末が要り、手順4 で撤去する旧経路のためだけの仕組みになる（前の版では、holder が消えた後に子 process が残り、空いた枠で次の試行と重なる問題があった）。撤去すれば、SHIKI を動かすのは runner だけになり、新旧を通して同時に動く SHIKI は実行枠の上限までになる。runner より先に撤去するのは、araya をまだ運用しておらず、runner ができるまで development の課題を動かせなくてもよいため（利用者の判断）。動いている旧経路からの入れ替えも扱わない。
- 撤去した後に旧経路に入った development の課題は、既存の、executor が渡されていないときの動作で `blocked` にし、intake では拒否しない。旧経路の scout は動くたびに inbox を読み直すので、intake で拒否すると、inbox に残った行が scout のたびに `inbox.read_errors` になる。手順4 で旧経路ごと撤去するので、旧経路の変更は、executor を外すことだけにする。
- worker を撤去しても、差分の収集・検証・判定、課題の prompt と instructions、`araya_create_worktree`・`araya_register_verification` の処理は、新しい経路に移して使う（「旧経路との関係」）。SHIKI の作業と完了の判定を変えないため。
- runner の unit は unit file として入れる（`araya runner install`）。transient unit は host の再起動で消え、再起動の後に runner が自動で起動しないため。CLI は runner を起動しない。止めてある runner を、Task の登録で勝手に動かさないため。
- unit file に書く値の文字を制限する。unit file の specifier（`%`）、変数（`$`）、引用の escape を作らずに済ませるため。普通の path（`/home/<user>/.araya` など）は当たらない。
- runner の環境変数を一覧に限る。systemd は unit の環境変数を `systemctl --user show` で表示するので、秘密を渡すと、その出力（agent の作業記録など）に写るおそれがあるため。model の認証は、今と同じく Pi の `auth.json` から読む。
- runner は 2 秒ごとに台帳を読む。CLI と Extension から runner を起こす仕組みを作らずに、登録から数秒で始めるため。読むだけで model は呼ばない。heartbeat の書き込みは 10 秒ごとにする。
- 途中経過は、pi-durable の hook から台帳へ直接書く。SHIKI と runner が同じ process なので、file を介して渡す必要が無いため。
- 中断した試行と、Draft PR 配送で外部 branch/PR の変更があったか確認できない試行の再実行には、利用者の明示的な確認（`--confirm-side-effects`）を求める。Issue #1 の「再試行時は未確認の副作用を慎重に扱う」に合わせ、外部への変更をくり返さないため。
- 差分の本文と検証の出力は、台帳ではなく状態 directory の `evidence.json` に残す。秘密情報が混ざりやすい本文を台帳に複製せず、別のセッションからは利用者が `--full` を付けたときだけ読めるようにするため。`evidence.json` と台帳の結果の対応は、SHA-256 で確かめる。file の書き込みと台帳の commit を1つの操作にできないため。
- `targets` は SHIKI への手がかりで、制限ではない。どの repository を変更するかは SHIKI が判断するという既存の決定に合わせるため。
- Issue #1 の初期MVPでは `permissions` を記録して SHIKI に渡すだけとし、Issue から CI 成功 PR までの自動化を必須要件にしていなかった。Issue #1 の説明では、初期目的を Software Factory から Pi Extension としての Araya の継続性・SHIKI 委任へ絞り、Issue→PR→CI 修復は将来の workflow としている。この当初のスコープが、従来のMVPが PR 作成前に止まっていた理由である。現在の Draft PR delivery は [Draft PR delivery](draft-pr-delivery.md) で定義する。
- 再実行では前回の変更を自動で持ち込まない。前回の worktree は残し、場所を SHIKI に伝える。Issue #1 の「再試行時は未確認の副作用を慎重に扱う」に合わせるため。
- pi-durable の storage は試行の後も残す。会話を後から確かめられるようにするため。古い記録の削除は worktree などと同じく後の段階で決める。
- model を設定しないときは Pi の設定の既定だけを使う。既存の SHIKI が使う Pi の「最初の model を選ぶ」処理（`findInitialModel`）は package の外に公開されておらず、ほかの model へ黙って切り替えないため。
- `npm run deploy` で runner を入れ直し、止めてある runner も起動する（利用者の選択）。1つのコマンドで、deploy した環境の runner が入れたコードで動いている状態にし、初めての deploy の後の手順を無くすため。止めてあった runner を起動しても、Task が無い間は model を呼ばない。前の版では、deploy の後に `araya runner install` を実行するまで、runner が前のコードで動き続けた。
- `unsupported_platform` と `systemd_unavailable` では deploy を失敗にしない。runner を使えない環境でも、araya のほかのコマンド（旧経路と Pi の CLI）は使えるため。それ以外の失敗（`unsupported_path` など）は、runner を使う環境で値を直せば入れられるので、deploy を失敗にして知らせる。
- deploy は、`araya runner install` の終了 code 69 で、この環境では runner を使えないことを見分ける。stderr の文で見分けると、誤りのメッセージに入る利用者の値（設定ファイルの key など）によっては `<code>: ` で始まる行ができ、ほかの失敗を成功の扱いにしてしまうことがあるため。69 は、Node.js が自分の誤りに使う終了 code（14 以下、124、128 より大きい値）と重ならない。前の版の CLI の終了 code（誤りの種類によらず 1）との互換は考えない（araya はまだ運用していない）。
- runner のコマンド（`araya runner`）と unit の名前は `runner` のままにし、`shiki` にしない（利用者の選択）。runner は SHIKI を動かす常駐の process で、SHIKI は試行ごとの会話であるため（「用語」）。`shiki` にすると、常駐する SHIKI が1体いるように読め、Issue #1 の「Task ごとに動く SHIKI」と食い違ううえ、作業する SHIKI と、結果を判定して記録する runner の分担もぼやける。README と `araya --help` には、runner が SHIKI を動かす常駐の process であることを書く。

## 技術調査結果

pi-durable と Pi は 1.4.0、Node.js は v26.12.1、systemd は 259、npm は 11.20.0。model は pi-ai の faux provider だけを使い、実 API と実認証情報は使っていない。

### pi-durable

- tool の実行中に Harness を開いた process を SIGKILL し、同じ storage を別の process で開いて `resume()` すると、会話は続きから進んだ。同じ `requestId` の submit は、前の process が受け付けた submission を返した。完了していた自作の tool は再実行されなかった。
- 途中だった bash は、model に `isError: true`、本文「Tool bash was interrupted and may have partially run」（diagnostics の code は `interrupted`）で返った。
- bash の tool は、コマンドを独立した process group（`detached`）で起動し、pid を process の memory にだけ持つ。Harness を開いた process が SIGKILL されると、bash の process group は会話が終わった後も動き続けた。
- `abortTask` は、実行中の bash の process group を止め、数 ms で task を `aborted` にした。動いている runner で、CLI が台帳に中止の印を書いてから約 120 ms で runner が `abortTask` を呼び（5 ms で `marked`）、約 155 ms で台帳に結果が記録された（probe の loop は 200 ms ごと）。
- `instructions` は、model への request の system message に `<instructions>` の section として入った。tool の定義も同じ system message に入った。
- extension の hook（`hook(ToolTask, { beforeTool, afterTool })`）で、bash と自作の tool の開始と終了を受け取れた。hook の第1引数（`ToolHookCall`）は tool の呼び出しと、入れ子の呼び出しの親だけを持ち、第2引数（`HookApi`）が `conversationId` と `taskId` を持つ（型定義）。bash の `prepare` でも、`api.conversationId`・`api.callId` と session の document を使えた。
- task の phase の中で submission を待ち、同じ phase の commit の中で `tx.scanEntries({ conversationId, minEntryId: answer, maxEntryId: answer }, 1)` を読むと、回答の entry（`kind` は `pi.assistant`）が取れ、最後の message の text が最後の回答だった。
- model が誤りを返すと（faux の `stopReason: 'error'`）、submission は `unanswered`、`reason` は `model_error`、`detail` は誤りの message で終わった。
- task の phase の中で、外部のコマンドを子 process として実行できた。
- tool は `read`・`edit`・`write`・`bash`（と Windows 用の PowerShell）。`grep`・`find`・`ls` は無い。`read`・`edit`・`write` の引数の path は `path`。
- `configure` で thinking level を設定できる。
- 1つの storage の中で、試行ごとに task（とその task が持つ会話）を作って動かせた。台帳で試行を取り込んだ後、task を作る前に process を落とすと、起動し直した process が台帳と session の document を突き合わせて、task を1つだけ作り直した。
- `inspect()` の task の record は、`id`・`conversationId`・`kind`・`version`・`input`・`background`・`abortRequested`・`state`・`startedAt`・`restarts` を持つ。落ちた後は、試行の task のほかに `ready` と `waiting` の task が1つずつあった（何の task かは確かめていない）。
- 状態を進めずに落ち続ける task は、`restartLimit` の回数で止められた（`inspect()` で `blocked`、理由 `restart_limit`。`onReport` に `task_parked` が来た）。`resume()` の前に `abortTask` を呼ぶと `marked` を返し、`resume()` の後に task の `abort` が動いて `aborted` で終わった。その会話はそれ以上 bash を動かさず、待っていた次の試行が動いた。
- bash の実行中に Harness の `close()` を呼ぶと 12 ms で返った。開き直すと、その task は `ready` で `restarts` は増えておらず（型定義でも、close は restartLimit に数えないとある）、会話は続きから進み、途中だった bash は `interrupted` として model に返った。
- `close()` は、動いている phase の `runtime.signal` をすぐに止め、phase が返るまで待った。子 process に signal を渡したときは、子 process がすぐ止まり、`close()` は 17 ms で返った。渡さなかったときは、子 process が終わるまで（約 5 秒）待った。閉じた後の phase の commit は「Session is closed」で失敗し、開き直すとその phase が最初からやり直された。
- task の phase の中から、その task が持つ会話を `ConversationHandle.abort()` で止めると、7 ms で返り、submission は `unanswered`（`reason` は `aborted`）で終わった。bash の process は止まり、`setsid` した process と scope は残った。task は止まらずに次の phase へ進めた。
- 型定義: `resume()` のほかに、`Conversation.submit()`・`Conversation.compact()`・`Conversation.abort()`・`Submission.wait()`・`waitForTask()`・`Harness.waitForIdle()`・`Conversation.waitForIdle()` も task の実行を始める。`abortTask` は中止の印を commit し、動いている実行に signal を送って待ち、`abort` の実行を予約する。
- README: storage は1つの process が所有し、process をまたぐ lock は無い。`abortTask` は止められた task でも abort の handler を動かす。Settings に同時実行数の設定は無い。
- storage の `commit` を1回だけ失敗させると（probe18。storage を包んで誤りを投げた）、`subscribeClose` の listener が呼ばれ、`onReport` に `session_failed` が1回来て、動いている task の signal が止まり、待っていた `waitForTask` が `SessionFailed`（`cause` が元の誤り）で失敗した。誤りに当たった呼び出し（phase の commit、`createTask` の commit）は、その後に元の誤りで失敗した（`SessionFailed` ではない）。
- そのとき `closed` は `{ reason: "failed" }` で決まったが、signal を無視して動く phase があると、それが返るまで（約 1.3 秒）決まらなかった。その後の `abortTask`・`commit`・`inspect` は `SessionFailed` で失敗し、`close()` は誤り無く返った。
- 同じ storage を開き直すと、task は commit 済みの checkpoint の phase からやり直して終わった。失敗で閉じたときに動いていた task は、閉じるたびに `restarts` が1つ増えた（2回の失敗で 2）。`close()` では増えない（上）。`createTask` の commit が失敗したときは、開き直すと task は無く、作り直すと終わった。
- 終わった task に `abortTask` を呼ぶと `"terminal"` を返し、task の `abort` は動かず、outcome は `completed` のままだった（probe18。実装（`dist/harness/scheduler.js`）でも、task が `terminal` なら何もせずに `"terminal"` を返す）。
- 型定義: `Harness` は `Session` を継承し、`closed`（閉じ終わると `{ reason: "closed" }` か `{ reason: "failed", error }` で決まる）と `subscribeClose`（閉じ始めたとき、storage の誤りで閉じるときも、同期で呼ばれる。listener は block せず、Session の API を呼ばない）を持つ。README: `commit()` と `mintId()` の誤りはすべて Harness を終わらせ、再試行はしない。回復するには開き直す（commit は atomic なので storage は一貫している）。

### Pi coding-agent

- `ModelRuntime` は pi-ai の `Models` を実装している。既存の SHIKI と同じ options で作り、faux provider を `registerNativeProvider` で登録したものを Harness の `models` に渡すと、会話は bash を実行して `done` で終わった。
- `findInitialModel`（model を選ぶ処理）は `core/model-resolver` にあるが、package の exports（`.` と `./rpc-entry`）に含まれない。`SettingsManager` には `getDefaultProvider`・`getDefaultModel`・`getDefaultThinkingLevel` がある。
- 既存の SHIKI の tool は `DEVELOPMENT_TOOL_NAMES`（Pi 標準の `read`・`bash`・`edit`・`write`・`grep`・`find`・`ls` と、Araya の `araya_create_worktree`・`araya_register_verification`）。Araya の tool は状態 directory の `worktrees.jsonl` と `verifications.jsonl` に書く。

### systemd（user manager）

- `systemd-run --user --collect -p KillMode=control-group` で起動した service の main process を SIGKILL すると、bash の process group も、bash の中で `setsid` した process も 5 秒以内に止まり、unit は inactive になった。main process が終了 code 0 で終わったときも、`setsid` した process は止まった。
- 同じ unit 名で2回目の `systemd-run` をすると、「Unit … was already loaded or has a fragment file.」で終了 code 1 になり、2つ目は起動しなかった。
- service の中から `systemd-run --user --scope` で command を動かせた。scope は service の cgroup の外にでき、service の main process を SIGKILL すると、`ExecStopPost=-<systemctl> --user stop <prefix>-*.scope` が、起動し直す前（0.5 秒以内）に scope と、その中で `setsid` した process を止めた。
- transient unit に `Restart=always`・`RestartSec=200ms`・`RestartSteps=3`・`RestartMaxDelaySec=2s`・`StartLimitIntervalSec=0` を指定し、main process を毎回 SIGKILL させると、systemd は6回起動し（`NRestarts` 5）、起動の間隔は約 0.75 秒から 2.5 秒へ伸び、unit は `active/running` のままだった。`systemctl --user stop` では起動し直さなかった（bash の実行中の stop は 90 ms で終わり、unit は `not-found`、scope と残った process は 0 件）。
- `-E`・`--setenv` で渡した環境変数の値は、transient unit の定義（`/run/user/<uid>/systemd/transient/<unit>.service`、mode 0644。`/run/user/<uid>` は 0700）と、`systemctl --user show -p Environment` と、process の `/proc/<pid>/environ` に出た。
- `systemd-run` の command の引数では、`$$` が `$` になり、`${HOME}` は語の中でも展開された。`--expand-environment=no` を付けると、scope の中の bash に `$` を含む command がそのまま渡った。
- scope の `TimeoutStopSec` の既定は 90 秒（`1min 30s`）だった。`-p TimeoutStopSec=3s` を付けた scope に、SIGTERM を無視する process と、`setsid` して SIGTERM を無視する子 process を置いて `systemctl --user stop` すると、約 3.3 秒で両方が止まり、unit は残らなかった。
- 当たる unit の無い glob の `systemctl --user stop '<glob>'` は、終了 code 0 だった。読み込まれていない unit を名前で `systemctl --user stop` すると、終了 code 5 で「Unit … not loaded.」になった。無い unit の `systemctl --user disable --now` は、終了 code 1 で「Unit … does not exist」になった。
- service の環境には、user manager の環境（`HOME`、`XDG_RUNTIME_DIR`、デスクトップのセッションの変数など）と、service ごとの `INVOCATION_ID` があった。
- man page（systemd 259）: `systemd-run` の `--expand-environment` と、`RestartSteps=`・`RestartMaxDelaySec=` は version 254 で入った。`StartLimitIntervalSec=0` は起動の回数の制限を無くす。unit file では `%` の specifier が展開される。

### npm

- `npm run` は、script の `PATH` の先頭に、package の directory（`package.json` のある directory。その下の directory から実行しても同じ）から `/` までの各 directory の `node_modules/.bin` を近い順に足し、続けて npm の `node_modules/@npmcli/run-script/lib/node-gyp-bin` を足した。元の `PATH` はその後に続いた。node の directory は足さなかった。
- `npm run` の script の中で `npm run` を実行すると、同じまとまりを、もう1つ先頭に足した（2つ重なった）。

### 既存のコード

- 既存の `loadConfig`（`config/environment.ts`）は、`ARAYA_DATA_DIR`・`ARAYA_DEV_ROOT` などを `path.resolve` で絶対 path にするため、相対 path は process の cwd を基準に解決される。内蔵 Pi の agent directory は `<dataDir>/pi` の絶対 path に固定し、継承した `PI_CODING_AGENT_DIR`・`PI_CODING_AGENT_SESSION_DIR` は保存先として採用しない。
- 既存の development executor（`development.ts`）は、worker を `runPiWorker` で起動し、その後に状態 directory の記録を読み、git で差分を集め、検証のコマンドを `runBoundedCommand`（`development-process.ts`）で実行して、失敗の理由（`invalid_task`・`dev_root_missing`・`task_state_already_exists`・`termination_unconfirmed`・`task_state_invalid`・`evidence_collection_failed`・`agent_timeout`・`agent_failed`・`no_changes`・`verification_missing`・`verification_failed`）を決める。
- `runBoundedCommand` は、コマンドを独立した process group（`detached`）で起動し、timeout と出力の上限で process group を止め、終わったことを確かめる。中止の signal は受け取らない。
- `araya_create_worktree`（`development/worktrees.ts`）は、git を `execFile` で起動し（決まった候補から選んだ絶対 path。timeout は 60 秒、`git worktree add` は 10 分、出力は 2 MiB まで、timeout のときは SIGKILL）、hook を無効にしない。差分の収集（`development.ts`）の git は `runBoundedCommand` で起動し、`core.hooksPath=/dev/null` を付ける。`araya_register_verification` は subprocess を起動しない（path の確認と file の追記だけ）。
- 既存の SHIKI（`development-agent.ts`）は、model が設定されていなければ Pi の SDK（`createAgentSession`）に model を選ばせ、設定されていれば `ModelRuntime` に無いときと認証が無いときに `model_unavailable` の誤りにする。
- 既存の development worker の entrypoint は、`development-process.ts` の module の1つ上の directory を package root とし、その `bin/` から、module と同じ拡張子で探す（build 前は `.ts`、build 後は `.js`）。通常の file でなければ起動しない。build 済みの package でこれを確かめる test（`development-built.test.ts`）がある。
- 既存の WorkTask は、executor が渡されていないとき、kind と risk の組が正しく `discovered` の development の課題を `blocked`（evidence は `{"type": "development_executor_unavailable", "opportunityId": ...}`）にし、`no_executor` で終わる。この経路の test は無い。
- 既存の scout は、動くたびに inbox を読み直し、不正な行があれば `inbox.read_errors` の event を追加する。
- 既存のコードで、`computeTaskKey` を使うのは旧経路の executor（`development.ts`）だけ、`claimWorkspaceOpportunity` を使うのは WorkTask の executor の呼び出しの前だけ、`hasUsableModel`・`findAssistantFailure`・`DEVELOPMENT_TOOL_NAMES` を使うのは `development-agent.ts` だけ（どれも、ほかに使っているのは test だけ）。
- 既存の control plane は `node:sqlite` の `DatabaseSync` を使い、`busy_timeout` を設定していない。台帳では接続ごとに設定する。

## 未決事項

なし。
