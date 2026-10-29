# Draft PR まで届ける設計方針

## 状態

製品の目標と設計上の未決事項を記録する文書です。現行MVPの実装仕様ではありません。実装を始める前に、未決事項を解消し、検証可能な acceptance criteria を含む実装仕様へ更新します。

## 目標

Araya の開発 Task は、実装と検証の結果をローカルの worktree に残すだけでなく、検証済みの変更を draft PR まで届けることを目指します。PR は人が確認・修正・承認するためのもので、Araya が merge することはありません。

## 現行MVPとの違い

現行MVPは、SHIKI が作った変更と Araya が実行した検証の結果を Task の evidence に記録します。変更は task ごとの worktree と branch に未 commit のまま残り、Araya は commit・push・PR 作成をしません。SHIKI にもこれらをしないよう指示しますが、prompt による指示であり強制ではありません。

現行MVPの操作手順と動作は [Task の台帳と SHIKI の実行](task-ledger-and-shiki-runner.md) と [README](../../README.md) に記載しています。この文書の目標を、実装済みの機能として解釈してはいけません。

## 目標とする成果物

- Task の実装後に Araya が登録済みの検証を実行し、検証済みの変更から draft PR を作成する。
- draft PR は人による review と merge 判断を待つ。自動 merge、deploy、publish はこの目標に含めない。
- Task の結果から、作業した repository、branch、commit、draft PR を確認できるようにする。
- 検証に失敗した変更や差分のない Task を、成功した draft PR として扱わない。

## 実装前に決める事項

これらは既存のMVP仕様から自動的には導けないため、実装仕様を確定する前に決めます。

1. **認可と実行条件**: Task が検証に通ったら自動で commit・push・draft PR 作成まで進めるのか、Task ごとの明示的な許可・人の承認を要件にするのか。`permissions` は現状では操作権限ではなく、認可を代替しません。
2. **GitHub 認証**: 利用者の既存 `gh` 認証、専用 GitHub App、その他のどの方式を使うか。必要な repository 権限を最小化し、秘密情報を Task・evidence・log に記録しない方式を技術調査で確認します。
3. **対象 repository と base branch**: Task の `targets` と remote の設定をどう対応づけるか、PR の base branch をどう選び、許可されていない repository への push をどう防ぐか。
4. **部分失敗と再開**: commit 後の push 失敗、push 成功後の PR 作成失敗、同じ Task の retry での branch・PR 重複をどう記録・再開・照合するか。
5. **PR 内容と情報開示**: title/body の生成、diff・検証結果・秘密情報の扱い、PR の作成先に公開される内容をどう制御するか。

## 境界

- draft PR の作成までを目標とし、merge・deploy・publish は自動化しません。
- 実装仕様が確定するまでは、現行MVPの禁止事項や実際の挙動を変更したものとして扱いません。
- GitHub への書き込み権限、認証方式、ユーザー承認の要否を未確認のまま実装・宣言しません。
