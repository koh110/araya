# Draft PR まで届ける仕様

## 状態

これは Task runner に組み込まれた Draft PR delivery の動作仕様です。登録検証が全て成功した変更は Araya が commit・fast-forward push・Draft PR 作成まで行い、人が差分を review して merge を判断します。CI 完了待ち、merge、deploy、publish は行いません。

## 目的

Araya の開発 Task は、実装と登録済み検証が成功した変更を draft PR まで届けます。人が差分を review し、必要なら修正して merge を判断します。Araya は merge・deploy・publish を行いません。

## 実行条件と認可

- Task の作成は、その Task の検証成功後に、変更した対象 repository で Araya が commit・push・draft PR 作成する明示的な依頼とする。別の per-task confirmation は挟まない。
- `permissions` は SHIKI へ渡す Task の制約情報であり、GitHub への認証情報や、merge・deploy 等の固定禁止を解除する機能ではない。
- 実行対象は Task の作業で SHIKI が選択し、Araya が worktree として記録した repository に限る。`origin` の取得先と `git remote get-url --push --all origin` が返す唯一の push URL が同じ `github.com` repository であることを確認し、その検証済み URL を指定して push する。push では `--recurse-submodules=no` を明示し、利用者の `push.recurseSubmodules` 設定による未検証 submodule への push を禁止する。複数 push URL、検証済み push URL に適用される `url.*.insteadOf` または `url.*.pushInsteadOf` の書き換え、ほかの host へ送る設定は拒否する。GitHub Enterprise はこの版の対象外。
- 利用者と同じ OS user の GitHub CLI (`gh`) を使う。実行前に CLI と `gh auth status --hostname github.com` による認証状態を確認する。認証 token を Task、evidence、log、command argument に記録しない。資格情報は既存の `gh` の保存先から読み、Araya が別途保存・表示しない。
- SHIKI には自身で commit・push・PR 作成・merge・deploy・publish をしないよう指示するが、sandbox と network 制限はなく、prompt-only の禁止は強制されない。SHIKI が `bash` から直接 remote を変更する可能性がある。Araya が行う組み込み delivery の commit・push・PR 作成は全検証の後に限定する。

## 処理順

1. SHIKI が終了した後、Araya が全 worktree の差分を収集する。
2. 差分のある各 worktree について、登録されたすべての検証を実行する。どれかが失敗・timeout・未登録なら、どの repository でも commit・push・PR 作成を行わない。
3. 差分がなくても成功 PR は作らず、現行MVP同様 `no_changes` とする。
4. 検証がすべて終わった後、初期差分の有無にかかわらず、すべての記録済み worktree の snapshot を再収集して検証前と一致することを確認する。すべての snapshot/staged/committed `git diff` で `--ignore-submodules=none` を明示し、`diff.ignoreSubmodules=all` などの利用者設定で gitlink の変更が隠れないようにする。GitHub preflight の後と、全 commit 準備後・最初の remote write 直前にも全 worktree を再照合する。いずれかの worktree が検証中に変わった、差分を完全に取得できない、commit の直前に同じ状態を確認できない、staging 後または commit 後の tree が検証済み snapshot と一致しない場合は、commit・push・PR 作成を行わない。SHIKI の会話終了後に worktree を変更する subprocess が残っていないことも確認し、repository の local `user.name` と `user.email` を使って commit する。global Git 設定は変更しない。
5. commit 後、`origin` の GitHub repository へ、検証済みの commit SHA を source に指定して attempt 固有 branch（現行規則 `araya/<taskKey>`）を fast-forward push する。push 時に `HEAD` が変わっても別の commit を送らない。force push はしない。
6. GitHub の既定 base branch を使い、変更のある各 repository に Draft PR を1件作る。複数 repository に変更があれば、repository ごとに独立した PR を作成する。CI の完了待ちは行わない。
7. すべて成功した後に Task を `completed` とする。evidence に repository、branch、commit SHA、base branch、Draft PR URL を記録する。

## PR の内容

- title は Task の `title` を使い、既存 redactor を適用する。
- body は Araya が固定形式で生成し、Task の `goal`、constraints、SHIKI の自由記述 summary、diff、検証出力を含めない。Task ID、検証が成功したこと、登録検証数のみを記録する。
- `gh pr create --draft --repo ... --head ... --title ... --body-file -` を非対話で使い、body は標準入力で渡す。`gh pr create --dry-run` は push する可能性があるため使わない。
- PR title、commit message、body、失敗 detail は上限を設け、保存前に既知の secret redaction を適用する。source diff 自体の汎用 secret scan はこの版では追加しない。PR の差分は利用者が指定した Task の成果として repository に公開されるため、Task の対象・権限を確認してから登録する。

## 再実行・部分失敗

- 同じ attempt の再開では、commit message trailer `Araya-Task: <taskKey>` を使って既存 commit を照合する。既存 commit があれば重ねて commit しない。
- push は fast-forward のみ。PR 作成前に `gh pr list --repo ... --head <branch>` で同じ head branch の PR を照合し、`headRepository.nameWithOwner` と base branch が対象と一致する既存 draft PR があれば URL を再利用する。既存 PR が別 repository の branch を指す、draft でない、closed、または remote branch が競合している場合は、変更せず失敗として記録する。
- push 後に PR 作成が失敗した場合、remote branch は削除・force push せず、Task を成功扱いしない。どの repository で commit/push/PR 作成まで進んだかと既存 URL を evidence に残す。
- 複数 repository の一部だけ delivery できた場合も Task は完了にしない。作成済み PR は閉じず、証拠に残す。利用者が retry する際は、既存 CLI の `--confirm-side-effects` を要求し、前 attempt の worktree と PR URL を確認させる。retry は新しい attempt/branch なので、既存 draft PR の整理は利用者が判断する。Araya は PR を自動 close しない。
- `gh` 不在、認証不能、非 GitHub remote、Git identity 不在、push 権限不足、GitHub API error は success にフォールバックさせず、段階と理由を evidence に残す。GitHub 認証・設定が不足し、まだ remote write が起きていない場合は Task を `blocked` にし、利用者が設定後に retry できるようにする。

## 技術選択と根拠

- 外部依存は既存の Git と、利用者がインストール・認証した `gh` CLI に限定する。GitHub SDK、token の新規保存、GitHub App の導入は行わない。
- `gh repo view [<repository>]` は repository を位置引数に渡し、`gh pr list --head <branch>` は branch 名のみを渡す（`owner:branch` 形式には未対応）。PR JSON の `headRepository.nameWithOwner` も照合する。`gh pr create` の `--draft`、`--repo`、`--head`、`--title`、`--body-file -` は GitHub CLI の公式 manual とローカル help で確認した。
- 公式資料: <https://cli.github.com/manual/gh_pr_create>
- 実 API E2E は行わない。自動テストは faux `git`/`gh` command のみを使い、実 credential や GitHub API に接続しない。

## Out of scope

- GitHub Issue の作成・更新・リンク、CI の完了待ち、reviewer の自動指定、merge、deploy、publish。
- GitHub Enterprise、複数 GitHub host、GitHub App、credential の新規発行・保存。
- remote branch の自動削除、force push、失敗した draft PR の自動 close。
- 汎用 secret scanner の導入。known secret の redaction は source diff の secret scan と同等ではない。

## Acceptance criteria

1. 検証が全て成功し変更がある repository のみ、再確認した worktree snapshot が検証時と一致し、staging 後と commit 後の tree も同じ snapshot に一致する場合に限り、commit・fast-forward push・Draft PR 作成を行う。不完全な diff は自動 delivery しない。
2. 検証失敗、timeout、未登録、差分なしでは remote write を一切行わない。
3. 変更のない repository は skip し、変更のある各 GitHub repository にそれぞれ最大1件の Draft PR URL を記録する。
4. PR title/body、commit message、GitHub への remote payload に credential/token、Task goal、SHIKI summary、diff、raw verification output を含めない。delivery evidence には repository、worktree path、branch、commit SHA、base branch、配送状態、Draft PR URL、外部 write 結果の不確実性、failure reason と redacted/bounded failure detail だけを追記し、既存 local `evidence.json` は従来の redaction/access control の契約に従う。
5. `gh` 不在、未認証、非 GitHub remote、複数 push URL、Git identity 不在、push/PR failure を検出し、成功扱いしない。remote write 前の認証不足は `blocked` にする。
6. 同じ attempt を再開しても重複 commit/PR を作らない。競合・既存 non-draft/closed PR は変更せず失敗する。
7. 複数 repository の partial failure は各段階と作成済み URL を evidence に残し、Task を completed にしない。自動 close/force push をしない。
8. command timeout/abort で外部書き込み結果を確認できない場合は完了にせず、既存 `--confirm-side-effects` による明示的再実行を要求する。
9. テストは faux provider/commands だけを使う。実モデル API、GitHub API、production deploy/systemd 操作は実行しない。
10. README と開発文書に、`gh` の runtime prerequisite、Draft PR の自動作成、merge/deploy をしないこと、認証方法と失敗時の挙動を明記する。
