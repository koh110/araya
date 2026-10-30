# 人が投入する開発課題を処理する自動ループ

> 注記: この文書は旧 worker / inbox 経路の設計記録です。worker の実行と Task 台帳は [Task の台帳と SHIKI の実行](task-ledger-and-shiki-runner.md) に置き換え、検証後の commit・push・Draft PR 作成は [Draft PR delivery](draft-pr-delivery.md) が定義します。以下の worktree・検証の詳細は参考ですが、終了後の処理・完了条件・安全境界のうち current Task runner の説明と矛盾する箇所は新しい仕様が優先します。

## 概要

Araya の利用者が `araya task create` で登録した開発課題が実行開始の依頼になる。runner は対象 repository ごとに worktree を用意し、SHIKI に実装と検証登録を委ねる。SHIKI 終了後、Araya は差分と全検証結果を記録し、差分がある全 repository の検証が成功した場合は Araya が commit・fast-forward push・Draft PR 作成まで行う。merge は人が判断する。旧 JSONL inbox 経路は実行せず `blocked` にする。

Araya は sandbox による隔離を行わない。agent と検証コマンドは、Araya を起動した利用者の権限・環境変数・network で動く。

## 利用者の決定

- 開発は `~/dev` 配下に repository を clone し、その中で worktree を切る。開発の作業を進める root は `~/dev`。
- 課題は複数の repository にまたがり得る。どの repository を変更するかは agent が自律的に判断する。
- 隔離は考えない。読み取り専用などの制限はかけない。
- `.worktree` が ignore されていない repository では、exclude に `.worktree` を加える。

## 入力契約

```json
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"...具体的な作業と期待結果..."}}
```

- `risk: "workspace"` は、Araya が開発 root 配下の repository を変更してよいことを意味する。
- `payload` は `task` だけを持つ。`task` は空白以外の文字を含む 20,000 文字以内の文字列で、NUL を含まない。
- `payload` に `task` 以外の key（旧形式の `verifyCommand` を含む）がある課題は、intake で拒否して理由を記録する。executor でも同じ検証をもう一度行う。
- 開発以外の候補（`read-only` / `external`）の挙動は変えない。`external` 候補は従来どおり人間の承認を要求する。

## 設定

- `ARAYA_DEV_ROOT`: 開発 root。既定は `<home>/dev`。課題の開始時に `realpath` で解決し、実体が directory でなければ `dev_root_missing` で失敗する。symlink の root は解決先を使う。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS`: agent 1回の上限。既定 20分、範囲 1秒〜60分。
- `ARAYA_VERIFICATION_TIMEOUT_MS`: 検証コマンド1件ごとの上限。既定 5分、範囲 1秒〜60分。
- 内蔵 Pi の agent directory は `<ARAYA_DATA_DIR>/pi`（既定 `<home>/.araya/pi`）。継承した `PI_CODING_AGENT_DIR`・`PI_CODING_AGENT_SESSION_DIR` は保存先として採用しない。
- `ARAYA_PROJECT_DIR` と `ARAYA_WORKTREE_DIR` は廃止する。環境変数は既存どおり `config/environment.ts` だけで読む。
- 開発 agent の model と thinking level は、設定ファイル `<dataDir>/config.json` で指定する。仕様は [設定ファイルによる開発 agent の model 指定](development-model-config.md) を参照する。

## 課題の識別子と状態 directory

- `taskKey` は、`development-` の後に opportunity id の SHA-256 の先頭20桁（16進）を付けたもの。
- 課題ごとの状態 directory は `<dataDir>/development/<taskKey>/`（mode 0700）で、agent の起動前に作る。既に存在する場合は `task_state_already_exists` で失敗し、以前の worktree や branch を再利用しない。
- 状態 directory には、`worktrees.jsonl`（作った worktree の記録）、`verifications.jsonl`（登録された検証コマンド）、Pi の model store file を置く。JSONL は1行1件で追記する。

## agent の実行

- Pi coding-agent SDK 1.4 の AgentSession を、Araya の development worker（別 process）で non-interactive に動かす。worker の cwd は開発 root で、環境変数は Araya の process から引き継ぐ。bubblewrap などの sandbox は使わない。
- worker への入力は stdin の JSON 1件で、title、task、timeout、開発 root、状態 directory、taskKey、Pi agent directory を渡す。worker の出力は stdout の JSON 1件で、`completed` と summary、または `failed` と error 名・error message（500文字まで）のどちらか。
- tool は Pi 標準の `read`・`bash`・`edit`・`write`・`grep`・`find`・`ls` と、Araya の `araya_create_worktree`・`araya_register_verification` の9種類。session が公開する tool と呼び出せる tool の集合が、どちらもこの9種類と一致しなければ、agent を動かさずに失敗する。
- MCP、Pi extension、skill、prompt template、context file は読み込まない。session は in-memory とし、Pi の通常の session directory に会話履歴を保存しない。Pi の project settings は使わない。
- system prompt と課題 prompt は日本語で書き、agent に次を指示する。これらは指示であり、Araya が強制する境界ではない。
  1. 課題に必要な repository を判断する。複数でもよい。repository は開発 root 配下の clone を使う。必要な repository が無ければ、開発 root 配下に clone してよい。
  2. 既存の clone の作業 tree（main checkout）は編集しない。変更する repository ごとに `araya_create_worktree` で worktree を作り、その中だけを編集する。git コマンドで直接 worktree を作らない。
  3. worktree の base には、通常は remote の既定 branch を fetch して、その ref を指定する（例: `origin/main`）。
  4. repository に AGENTS.md や CLAUDE.md などの開発ガイドがあれば読んで従う。
  5. commit、push、PR 作成、merge、deploy、publish はしない。変更は worktree に未 commit のまま残す。
  6. 作業中の test は bash で実行してよい。終了前に、変更した worktree ごとに、最終状態で通るべき検証コマンドを `araya_register_verification` で登録する。Araya は agent の終了後にそれを実行し、すべて通ったときだけ課題を完了とする。
  7. 認証情報や秘密情報を読み出したり出力したりしない。
  8. 最後に、repository ごとの変更内容と、作業中に実行した確認を日本語で簡潔にまとめて返す。
- timeout になったら、Araya は worker の process group に SIGTERM を送る。worker は SIGTERM を受けたら Pi session を abort して終了する（abort により bash tool が起動した子 process も止まる）。10秒待っても終わらなければ process group に SIGKILL を送る。

## `araya_create_worktree`

入力例: `{"repository":"araya","base":"origin/main"}`。`base` は省略でき、既定は `HEAD`。

- `repository` は開発 root からの相対 path。空、絶対 path、`..` の segment、NUL を含むもの、200文字を超えるものは拒否する。
- `<開発 root>/<repository>` の realpath が開発 root の内側にあり、Git の main working tree の root であること。`git rev-parse --show-toplevel` が同じ path を返し、`--absolute-git-dir` と `--git-common-dir` の解決先が一致することで確かめる。linked worktree と、`.worktree` という segment を path に含むものは拒否する。
- `base` は、空、`-` で始まる、NUL や改行を含む、200文字を超えるものを拒否する。`git rev-parse --verify --quiet <base>^{commit}` で commit に解決できなければ拒否する。解決した SHA を base SHA とする。
- `.worktree` 配下に tracked file がある repository（`git ls-files -- .worktree` が空でない）は拒否する。
- `<repository root>/.worktree` が無ければ作る。既にあるものが symlink や directory 以外なら拒否する。
- ignore: `git check-ignore -q .worktree/<worktree名>` で ignore されているか確かめる。されていなければ、`git rev-parse --git-path info/exclude` が示す file の末尾に `/.worktree/` を1行追記する。file や親 directory が無ければ作り、既存の内容の末尾が改行でなければ改行を補う。既存の行は書き換えない。追記後も ignore されなければ `worktree_directory_not_ignored` で拒否する。既に ignore されている repository の exclude は変更しない。
- worktree 名は `araya-<taskKey>`、path は `<repository root>/.worktree/araya-<taskKey>`、branch は `araya/<taskKey>`。`git worktree add -b <branch> <path> <base SHA>` で作る。
- worktree の作成と ignore の確認に使う git は、利用者の通常の環境（global config、global excludes、LFS filter など）で動かす。対話 prompt は無効にする（`GIT_TERMINAL_PROMPT=0`）。
- 同じ課題で同じ repository に対して再度呼ばれたら、記録済みの worktree をそのまま返す。記録に無いのに path または branch が既に存在する場合は拒否し、再利用しない。
- 1課題で作れる worktree は 16 個まで。
- 成功したら `worktrees.jsonl` に `{repository, repositoryRoot, worktreePath, branch, base, baseSha, excludeAdded, createdAt}` を追記し、agent に `worktreePath`・`branch`・`baseSha`・`excludeAdded` を返す。
- 失敗は tool error として理由を agent に返す。tool の失敗だけでは課題全体を止めない。

## `araya_register_verification`

入力例: `{"repository":"araya","command":["npm","test"],"cwd":"packages/araya"}`。`cwd` は省略できる。

- `repository` は、この課題で `araya_create_worktree` が作った worktree のものに限る。
- `command` は 1〜64 要素の文字列配列。各要素は NUL を含まず、合計 32,768 文字以内。shell を通さず argv として実行する。
- `cwd` は worktree root からの相対 path。絶対 path、`..` の segment、NUL を含むものは拒否する。
- `verifications.jsonl` に `{repository, command, cwd, registeredAt}` を追記する。同じ repository に複数登録でき、登録順に実行する。repository・cwd・command が同じ登録は1件として扱う。
- 1課題で登録できる検証コマンドは合計 32 件まで。

## agent 終了後の処理

1. worker の終了を確認できない場合（SIGKILL の後も確認できない等）は、差分を集めず、検証も実行せずに `termination_unconfirmed` で失敗にする。
2. 状態 directory の記録を読み、構造を検証し直す。worktree の path が `<repository root>/.worktree/araya-<taskKey>` で開発 root の内側にあること、branch が `araya/<taskKey>` であること、検証の repository が記録済みの worktree のものであることを確かめる。記録された repository root と worktree の path は、realpath が記録と一致すること（symlink を経由して別の場所を指していないこと）も確かめる。存在しない path は、存在する最も近い祖先が symlink を経由しない実体の directory であるときだけ「消えた」とみなし、ここでは扱わず手順3で扱う。壊れた symlink や symlink の下にある path など、それ以外で解決できない path は不正な記録とする。不正な記録があれば、差分も検証も行わず `task_state_invalid` で失敗にする。
3. 記録された worktree ごとに差分を集める。agent が失敗・timeout したときも、利用者が確認できるように差分は集める。差分は base SHA と現在の作業 tree の差で、commit 済み・未 commit・untracked の変更を含む。HEAD が base SHA から動いていれば `headMoved: true` を記録する。差分の収集に失敗したら、検証を行わず `evidence_collection_failed` で失敗にする。差分を集める直前にも worktree の realpath が記録と一致することを確かめ、一致しなければ差分の収集の失敗とする。差分の収集に使う git の終了を確認できない場合も `evidence_collection_failed` とする。差分の収集に使う git は、worktree の作成と同じく利用者の環境（global excludes や LFS filter を含む）で動かし、`--no-ext-diff`・`--no-textconv`・`--no-color` を付けて外部の diff driver や色に左右されないようにする（hook は `core.hooksPath=/dev/null` で無効にする）。
4. agent が成功し、差分のある worktree が1つ以上あるとき、差分のある worktree ごとに、登録された検証コマンドを登録順に実行する。検証が登録されていない worktree があっても、ほかの worktree の検証は実行する。cwd は worktree root（`cwd` 指定時はその下）。sandbox は使わず、環境変数は Araya の process から引き継ぐ。1件ごとに timeout を設ける。出力が多くても検証を止めず、stdout と stderr それぞれの末尾 8 KiB を残す。不正な UTF-8 は置換文字にする。cwd が存在しない場合、その検証は失敗とする。cwd の realpath が worktree の外にある場合（symlink など）は、その検証を実行せずに失敗とする（理由 `cwd_outside_worktree`）。検証コマンドの終了を確認できなかった場合は、残りの検証を実行しない。
5. 実行しなかった検証は `not_run` とし、理由を記録する（差分なしは `no_changes`、agent の失敗は `agent_failed`、agent の timeout は `agent_timeout`、先行する検証の終了が確認できないときは `previous_termination_unconfirmed`）。
6. 結果の判定:
   - `completed`: agent が成功し、差分のある worktree が1つ以上あり、そのすべてに検証の登録があり、実行した検証がすべて exit 0 で、その後の Draft PR delivery が成功。
   - `failed`: agent・検証または Draft PR delivery が失敗した。`failureReason` は「Task 台帳と SHIKI の実行」「Draft PR delivery」の仕様に従う。
     - `invalid_task`: 課題の入力が不正
     - `dev_root_missing`: 開発 root が無い
     - `task_state_already_exists`: 状態 directory が既にある
     - `termination_unconfirmed`: worker または検証コマンドの終了を確認できない
     - `task_state_invalid`: 状態 directory の記録が不正
     - `evidence_collection_failed`: 差分の収集に失敗した
     - `agent_timeout`: agent の timeout（終了は確認できた）
     - `agent_failed`: worker の起動失敗、異常終了、`failed` の応答、tool 集合の不一致。最後の assistant の応答が model の error か abort で終わった場合は、途中まで text があっても agent の失敗とする
     - `no_changes`: 差分のある worktree が1つもない
     - `verification_missing`: 差分があるのに検証が登録されていない worktree がある
     - `verification_failed`: 実行した検証に exit 0 以外・timeout・起動失敗がある
7. worktree と branch は成功・失敗にかかわらず残す。SHIKI 自身は commit/push/PR 作成をしない。Araya は全検証後に commit・fast-forward push・Draft PR 作成を行い、merge・deploy・publish は行わない。retry は自動で行わない。
8. 各 tick で実行する workspace task は最大1件。複数の task を並列に実行しない。

## 証拠（opportunity evidence）

- 課題全体: `taskKey`、開発 root、`outcome`、agent の summary（4,000文字まで）、または error 名と error message、`failureReason`。agent 以外の理由（`invalid_task`、`dev_root_missing`、`task_state_already_exists`、`task_state_invalid`、`evidence_collection_failed`）で失敗したときは、原因を `failureDetail`（500文字まで）に記録する。
- worktree ごと: `repository`、`worktreePath`、`branch`、`base`、`baseSha`、`headSha`、`headMoved`、`excludeAdded`、変更 file 一覧、diff stat、diff、`diffTruncated`、検証の一覧。
- 検証ごと: `command`、`cwd`、`status`（`passed` / `failed` / `timeout` / `not_run`）、exit code、stdout と stderr の末尾それぞれ 8 KiB まで、理由。
- diff は全 worktree の合計で 256 KiB まで（切り詰めの印を含む）。上限を超えた worktree は `diffTruncated: true` とする。

## 削除するもの

- Pi worker と検証コマンドの bubblewrap sandbox、および Linux の `bwrap` を必須とする前提
- Araya 独自の workspace 限定 file tools（`araya_read` など6種類）
- `ARAYA_PROJECT_DIR`、`ARAYA_WORKTREE_DIR`、`payload.verifyCommand`
- 対象 repository の clean 要求、custom checkout filter の拒否、worktree 保存先の所有者・mode の検査

## 技術調査結果

- Pi coding-agent 1.4.0 の `createAgentSession` は、`tools`（allowlist）、`noTools`、`customTools`、`resourceLoader`、`sessionManager` を受け取る。標準 tool 名は `read`・`bash`・`edit`・`write`・`grep`・`find`・`ls`（と `powershell`）。
- Pi の bash tool は子 process を別の process group（`detached`）で起動し、abort 時に process tree を止める。worker を SIGKILL すると子 process が残り得るため、timeout では先に SIGTERM で session を abort させる。
- Pi 1.4 の AgentSession は、使える model が無くても placeholder の model（`unknown/unknown`）を持つ。model の有無は `session.model` の有無ではなく、その provider の認証が設定済みか（`ModelRuntime.hasConfiguredAuth` か `getAvailableSnapshot`）で判定する。
- Pi 1.4 の `ModelRuntime.create({ refreshOnCreate: false })` は、使える model の一覧（availability snapshot）を空のまま返すため、`auth.json` があっても model を選べない。worker は作成後に `refresh({ allowNetwork: false })` を呼び、network を使わずに auth から一覧を作り直す。
- Pi 1.4 の SQLite Durable migration は別の DB に適用される。Araya control-plane schema migration は専用の scratch DB だけで検証し、既存の利用者 DB では試さない。

## 既知の制限

- agent の権限は制限しない。commit・push・main checkout の編集などの禁止は prompt での指示だけで、強制も検知もしない。
- agent が `setsid` や `nohup` などで切り離した process は、timeout 後も残ることがある。
- 検証コマンドは agent が登録する。課題の作者が検証コマンドを指定する方法はない。

## Out of scope

- Araya 自身による課題の発見・優先順位付け、GitHub Issue 同期
- worktree・branch の自動削除
- 複数 task の並列実行、自動 retry
- 実モデル・実 Pi auth を使った E2E 試験

## Acceptance Criteria

- [ ] intake は `payload` が `task` だけの開発課題を受理し、`verifyCommand` など他の key を持つ課題を理由付きで拒否する。
- [ ] `ARAYA_DEV_ROOT`（既定 `<home>/dev`）で開発 root を設定でき、旧 `ARAYA_PROJECT_DIR`・`ARAYA_WORKTREE_DIR` は使われない。
- [ ] `araya_create_worktree` は `<repository>/.worktree/araya-<taskKey>` と branch `araya/<taskKey>` を指定した base から作る。`.worktree` が ignore されていない repository では `info/exclude` に `/.worktree/` を追記し、`.gitignore`・`info/exclude`・global excludes のいずれかで ignore 済みの repository では exclude を変更しない。
- [ ] `araya_create_worktree` は、絶対 path、`..`、開発 root の外、repository root ではない path、linked worktree、`.worktree` を含む path、`.worktree` 配下の tracked file、`-` で始まる base、解決できない base、記録外の既存 path や branch を拒否し、同じ repository への再呼び出しには記録済みの worktree を返す。
- [ ] 2つの repository にまたがる課題で、両方の worktree の差分と検証結果が evidence に記録される。
- [ ] 検証は agent の終了後に Araya が最終状態で実行し、差分のある worktree すべてで登録済みの検証が exit 0 のときだけ Draft PR delivery に進む。全 repository の delivery が成功したときだけ Task は `completed` になる。
- [ ] 差分なし、検証の未登録、検証の失敗、agent の失敗、timeout、不正な状態記録が、それぞれ定義した `failureReason` で `failed` になり、worktree と branch は残る。
- [ ] Pi session の tool 集合が9種類の allowlist と一致しなければ agent を実行しない。
- [ ] worker は sandbox なしで起動でき、build 済み package からも起動できる。timeout 時は SIGTERM で session を abort して終了する。
- [ ] 外部の Pi auth や model API を使わずに unit・integration test が通る。
- [ ] faux `git`・`gh` で検証後の commit/push/Draft PR 作成、既存 Draft PR の再利用、URL の evidence 記録を検証する。検証失敗と GitHub 認証失敗では commit・push・PR 作成をしない。
- [ ] 外部 side effect が既知または不確実な失敗からの retry は `--confirm-side-effects` を要求する。
- [ ] README とこの仕様が新しい動作を説明している。

## Assumptions（利用者の決定から導いた判断）

- agent に bash を渡す。複数の repository の判断、clone、fetch、test を agent が自分で行うため。
- 課題ごとの固定の検証コマンド（`verifyCommand`）は、どの repository で実行するか決められないため廃止し、agent が repository ごとに登録する方式にする。
- 検証は agent の作業中ではなく、終了後に Araya が実行する。完了と判定した状態と、検証した状態を一致させるため。
- worktree の base の既定は `HEAD`。remote の最新を使うかは agent が `base` で指定する。
- agent が git で直接作った worktree は記録の対象にしない（prompt で禁止する）。
