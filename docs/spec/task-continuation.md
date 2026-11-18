# Task continue 仕様

## 概要

失敗または判断待ちで終了した Task の作業を、前回の変更を引き継いで続ける `continue` 操作を追加する。既存の `retry` は新しい worktree と branch で始める操作として維持し、両者の意味を混同しない。

`continue` は実行試行と agent session を新しく作るが、直近の試行が使った worktree と branch を再利用する。worktree の reset、clean、削除は行わない。

## 入力・出力

- CLI: `araya task continue <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]`
- Discord: `/araya task continue task:<id> [note] [confirm_side_effects]`
- 対象は最新の Task 状態が `failed` または `blocked` の場合に限る。
- 成功時は新しい attempt を queue し、通常の Task summary を返す。
- `--note` は既存の retry と同じ制約・redaction を適用する。

## データと workspace identity

- attempt ごとの `taskKey` は実行・Pi session・systemd scope の識別子として引き続き一意にする。
- `workspaceTaskKey` は worktree directory と branch の識別子として分離する。通常の初回実行と `retry` では当該 attempt の `taskKey` を使う。
- 旧形式の persisted attempt input のうち、`previousAttempt` が設定されていて `workspaceTaskKey` / `workspaceStateTaskKey` を持たないものは、この runner で後方互換処理しない。新 runner の起動前に現行形式へデータ移行する。移行できない Task は `continue` せず、必要なら fresh-worktree の `retry` を選ぶ。この機能は実データの自動 migration を行わない。
- `continue` は最新 attempt の `workspaceTaskKey` を引き継ぐ。最新 run に `task.continued` event がなければ、その run の `taskKey` を使う。過去の `continue` run なら同 event に保存した値を再利用する。
- `task.continued` event は新 attempt の queue と同じ ledger transaction で記録し、`workspaceTaskKey`、note の有無、外部副作用確認の有無を保持する。schema migration は追加しない。
- 新 attempt は新しい state directory を持つ。最新 attempt の `worktrees.jsonl` の検証済み record だけを引き継ぎ、`verifications.jsonl` や decision file は引き継がない。前 attempt の検証は新しい変更を検証する証拠にはならないため、continue attempt でも検証コマンドを再登録させる。
- 各 attempt の evidence はその attempt の収集時点の差分・HEAD・検証結果を保存する。共有 worktree の後続変更で過去 evidence を書き換えない。

## Worktree と agent の挙動

- worktree path は `<repository>/.worktree/araya-<workspaceTaskKey>`、branch は `araya/<workspaceTaskKey>` とする。
- `continue` 開始前に、Task 全試行の systemd scope を停止・確認し、state record、repository root、worktree path、branch、Git worktree registration、登録が prunable でないことを検証する。実際の checkout が記録 repository の共通 Git directory と管理 record に結び付いていることも確認する。
- source の `worktrees.jsonl` は ledger evidence の repository／path／branch／base／base SHA／exclude 設定と全件・順序まで一致しなければならない。欠落、追加、改変、または必要な identity 情報を欠く過去 evidence は fail-closed とし、必要なら利用者は `retry` を選ぶ。全 worktree が一致・検証できた場合のみ record を新 attempt の state directory に引き継ぐ。
- scope 停止または path・branch・repository identity・registration の検証ができなければ agent を起動しない。新しい worktree を暗黙に作って continue と見せかけない。既存 worktree は削除・reset・clean しない。
- runner を再起動して persisted continuation を再開するときは、durable scheduler を有効にする前に agent/evidence phase の workspace 全件と ledger snapshot を再検証する。失敗時は会話の queued input と descendant task を中止してから scheduler を有効にし、中止を確かめられない場合は scheduler を起動しない。
- evidence phase では、差分収集の前、登録した各検証コマンドの実行前後、最終 snapshot の収集前、Draft PR 配送の開始前に、現在の worktree identity と ledger snapshot を再検証する。Draft PR 配送中も snapshot guard、commit、push、PR 作成の各境界で再検証する。追加 repository の欠落や同一 path/branch の worktree 再作成を成功扱いにせず、失敗後に次の検証・配送へ進まない。
- restart preflight は、再開中の run に最終 evidence がまだ無いことを workspace identity の不一致と取り違えない。履歴上の検証済み record source を解決し、再開中 run の現在 record 一覧はその run 自身の ledger snapshot と照合する。
- Continue 用 prompt は前回の worktree を読み取り専用とせず、編集を続ける workspace として明示する。`araya_create_worktree` は引き継いだ repository について同じ record を返し、まだ選ばれていない repository は同じ `workspaceTaskKey` の下に作る。
- `continue` attempt が完了して Draft PR 配送を行う場合、同じ branch と open Draft PR が存在すれば既存の配送規則に従う。前回 attempt が中断された、または外部 branch／PR の変更結果が不確かな場合は、既存の `--confirm-side-effects` gate を適用する。

## 失敗時の扱い

- `continue` は worktree が一件も記録されていない Task、または source record が durable evidence と一致しない Task には適用できない。エラーにし、利用者が必要なら `retry` を選べるようにする。
- filesystem/Git validation が runner 側で失敗した場合、新 attempt は `continuation_workspace_invalid` で終了し、SHIKI、検証、commit、push、PR 操作を始めない。
- 既存の未commit/untracked ファイルは workspace 引き継ぎの対象であり、自動削除しない。
- mutation idempotency は `retry` と同様に扱い、Discord interaction は interaction ID を idempotency key にする。

## 対象外

- 以前の Pi 会話 transcript/session 自体を再開すること。`continue` は新しい会話を作り、前回の要約・判断依頼・worktree 状態を入力に加える。
- completed、queued、running の Task を continue すること。
- `retry` の fresh-worktree semantics の変更。
- この機能に伴う worktree、branch、Draft PR、evidence、log、ledger の削除。

## 受け入れ条件

1. CLI と Discord に `task continue` が追加され、入力検証、note redaction、idempotency、side-effect confirmation が確認される。
2. Continue attempt は新しい `taskKey` を持ちながら、同じ repository について前 attempt と同じ worktree path／branch を使用する。
3. 連続した複数の continue でも最初に選ばれた workspace identity が維持され、新たな同一 repository worktree を作らない。
4. 現 attempt の検証登録は空から始まり、前 attempt の検証結果を再利用しない。
5. continue 受付時または再起動時に worktree/state/registration の不一致があれば fail-closed とし、scheduler がその workspace の model/tool descendant を実行しない。SHIKI・検証・外部配送を起動せず、既存ファイルを変更しない。
6. `retry` は従来どおり新しい path／branch を使う。
7. 過去 attempt の evidence は保持され、Discord/CLI の help と README/spec は continue と retry の違いを説明する。
8. identity が不変の persisted continuation は runner restart 後に preflight を通過し、model generation を再開できる。検証中に identity が変わった場合は後続検証・commit・push・PR 作成に進まない。

## 前提・保留

- ユーザーの「引き継いで進める」は worktree と branch の継続を指し、Pi 会話 transcript の継続を要求しないものとして扱う。
- 以前に選ばれた fresh retry の worktree retention policy は別の変更として扱う。continue は削除をしない。今回の実装では古い worktree の実削除を行わない。
