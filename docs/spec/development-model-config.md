# 設定ファイルによる開発 agent の model 指定

> 注記: この文書のうち、worker の入力と出力で model を受け渡す部分は、worker を撤去する手順で撤去し、[Task の台帳と SHIKI の実行](task-ledger-and-shiki-runner.md)の仕様に置き換えた。設定ファイルの形と検証は、この文書を基準のままにする。runner は、この文書の subcommand とは別に、試行を取り込むたびに設定ファイルを読む（同じ仕様の「取り込み」）。

## 概要

開発課題を実行する Pi agent の model と thinking level を、Araya の設定ファイルで指定できるようにする。指定した model が使えないときは別の model に切り替えず、課題を失敗にする。どの model を使ったかを evidence に記録する。将来、利用上限（limit）に達したときの fallback model を同じ設定ファイルへ追加できる形にする。

## 利用者の決定

- model の指定は環境変数ではなく設定ファイルで行う。
- 将来、limit に達したときに使う fallback model を設定できるようにしたい。今回は fallback を実装しない。

## 設定ファイル

- 場所は `<dataDir>/config.json`（既定 `~/.araya/config.json`）。`dataDir` は `ARAYA_DATA_DIR` で変わる。設定ファイルの場所だけを変える環境変数は設けない。
- 形式は UTF-8 の JSON object で、64 KiB まで。
- 読むのは Araya の subcommand（`init`・`tick`・`status`・`run`・`approve`・`reject`）の起動時に1回だけ。`araya`（引数なし）、`araya pi`、`araya help`、`araya --help` は読まない。`araya run` の実行中に書き換えた内容は、再起動するまで反映しない。
- path に何も存在しない（`lstat` が `ENOENT`）ときは、設定なしとして動く（従来どおり）。
- path に何かが存在するのに使えないとき、つまり壊れた symlink、通常の file でない（directory など）、読めない、64 KiB を超える、UTF-8 でない、JSON として不正、下の schema に合わない場合は、subcommand を何も処理せずに失敗させる。message は `invalid Araya config file <path>: <理由>` で、CLI の exit code は 1。symlink の先が通常の file なら読む。

例:

```json
{
  "development": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
```

### schema

- top level は object。key は `development` だけ（省略可）。`{}` は設定なしと同じ。
- `development` は object。key は `model`（必須）と `thinkingLevel`（省略可）。
- `model` は `<provider>/<model id>` の文字列。最初の `/` で provider と model id に分ける。model id には `/` を含めてよい（例: `openrouter/moonshotai/kimi-k2.6` は provider `openrouter`、model id `moonshotai/kimi-k2.6`）。provider と model id はどちらも空にできない。空白（`\s`）と制御文字を含めない。全体で200文字まで。
- `thinkingLevel` は `off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれか。
- 知らない key は無視せず拒否する。綴りの誤りを見逃さないためと、将来の版で追加する設定（fallback など）を古い Araya が黙って無視しないため。
- 型の違う値と `null` も拒否する。

## model の選び方

- `development.model` があるとき、worker は次の順に処理する。どの場合も、別の model には切り替えない。
  1. Pi の model 一覧（既存の `modelRuntime.refresh({ allowNetwork: false })` の後の `modelRuntime.getModel(provider, id)`）から、provider と model id が一致する model を探す。見つからなければ、session を作らずに `ModelUnavailableError`（message: `configured model <provider>/<id> is not in the Pi model list`）で失敗する。
  2. 見つかった model に Pi の認証が無ければ（既存の `hasUsableModel` が false なら）、session を作らずに `ModelUnavailableError`（message: `configured model <provider>/<id> has no Pi authentication`）で失敗する。
  3. 見つかった model を `createAgentSession` の `model` に渡す。`thinkingLevel` があれば `thinkingLevel` に渡す。無ければ Pi の設定（`modelThinkingLevels["<provider>/<id>"]` → `defaultThinkingLevel` → `medium`）で決まる。Pi は model が対応しない thinking level を対応する値に丸める。
  4. session を作った後、session の model が使えること（`hasModel`）と、その provider と model id が指定と一致することを確かめる。一致しなければ prompt を送らずに `ModelUnavailableError`（message: `Pi session model <provider>/<id> does not match the configured model <provider>/<id>`）で失敗する。
- `development.model` が無いとき: 従来どおり Pi の設定（`defaultProvider`・`defaultModel`、使えなければ Pi に組み込まれた provider ごとの既定）で選ぶ。
- `ModelUnavailableError` で失敗した課題の `failureReason` は `agent_failed`。evidence の `workerErrorName` は `ModelUnavailableError`、`workerErrorMessage` に指定した model と理由が入る。agent は動かないので worktree は作られない。課題は自動で再実行しないため、設定を直したら別の id で課題を入れ直す。

## 責務の分担

- `src/config.ts` の `loadConfig(env)` は、従来どおり環境変数だけを読む。返す値に `configPath`（`<dataDir>/config.json`）を加える。
- 設定ファイルの読み込みと検証は、新しい module（例: `src/config-file.ts`）に置く。CLI は subcommand を処理する前に1回だけ呼び、結果の `developmentModel` を config に入れて各処理へ渡す。
- `developmentModel` の型は `{ provider: string, id: string, thinkingLevel: ThinkingLevel | null } | null`。`null` は設定ファイルで model を指定していないことを表す。
- development executor は `developmentModel` を worker の入力へそのまま渡す。worker は設定ファイルを読まない。
- 設定ファイルの値を受け取らずに config を作る経路（test など）では `developmentModel` を `null` とする。

## worker との受け渡し

- 入力の JSON に `model` を加える。値は `null`（指定なし）か、`{ "provider": string, "id": string, "thinkingLevel": string | null }`（key はこの3つだけ）。provider・id・thinkingLevel は設定ファイルと同じ規則で検証し、違反すれば worker は agent を動かさずに `failed` を返す。
- 出力の JSON に `model` を加える。
  - 値は、session の model が決まった後なら実際の session の値 `{ "provider": string, "id": string, "thinkingLevel": string }`（thinkingLevel は丸めた後の `session.thinkingLevel`）、決まる前に失敗したなら `null`。
  - 「session の model が決まった」とは、上の手順4（指定なしのときは `hasModel` の判定）を通った時点を指す。その後に失敗した場合（tool 集合の不一致、model の error、abort など）の `failed` の出力にも `model` を入れる。
  - `completed` の出力は `model` が `null` であってはならない。
  - provider と id は1〜200文字で制御文字を含まない文字列、thinkingLevel は上の7種類のいずれか。key は3つだけ。違反する出力は `pi_worker_invalid_response` として扱う。
- 出力の key は、`completed` が `model`・`status`・`summary`、`failed` が `errorMessage`・`errorName`・`model`・`status` で、ほかの key は拒否する（従来どおり）。

## 証拠（evidence）

- worker が model を報告したとき、課題の evidence に `model: { provider, id, thinkingLevel, source }` を加える。`source` は、設定ファイルで model を指定したとき `araya-config`、指定しなかったとき `pi-settings`。
- worker が model を報告しなかったとき（session の model が決まる前の失敗、timeout、worker の異常終了、不正な出力など）は `model` を記録しない。

## status

- `araya status` の出力と `status.json` の `config` に `configPath` と `developmentModel` を加える。`developmentModel` は `{ "model": "<provider>/<id>", "thinkingLevel": string | null }`、設定が無ければ `null`。model が実際に使えるかは表示しない（status は Pi の認証を読まない）。

## 将来の拡張（今回は実装しない）

- limit に達したときの fallback: `development.fallbackModels` に `{ "model", "thinkingLevel" }` の配列を書き、主 model が利用上限や rate limit で失敗したときに順に切り替える案。各要素は `development` の `model`・`thinkingLevel` と同じ形にする。どの error を limit とみなすか、切り替えた後の会話の扱い、evidence への記録は別の仕様で決める。現在の版では `fallbackModels` を知らない key として拒否する。

## Out of scope

- fallback model、自動 retry
- 課題ごとの model 指定（inbox の `payload` は `task` だけのまま）
- 設定ファイルの hot reload
- model が使えるかの事前確認（status や tick の開始時）
- JSON 以外の形式（YAML・TOML・コメント付き JSON）
- 既存の環境変数による設定を設定ファイルへ移すこと

## Acceptance Criteria

- [ ] `<dataDir>/config.json` が無ければ、従来どおり Pi の設定で model を選び、evidence の `model.source` は `pi-settings`。
- [ ] `development.model` と `thinkingLevel` を書くと、Pi session にその model と thinking level が渡り、evidence の `model` に provider・id・thinking level と `source: araya-config` が記録される。Pi の `settings.json` の既定 model より設定ファイルが優先される。
- [ ] `thinkingLevel` を省略すると、Pi の設定の thinking level が使われ、その値が evidence に記録される。
- [ ] 指定した model が Pi の model 一覧に無い、または認証が無いときは、session を作らず、prompt を送らず、`ModelUnavailableError` で失敗する。別の model に切り替えない。
- [ ] session の model が指定と違えば、prompt を送らずに `ModelUnavailableError` で失敗する。
- [ ] 不正な設定ファイル（JSON の誤り、object 以外、知らない key、`model` の形式違い、不正な thinking level、`null`、64 KiB 超、directory、壊れた symlink、UTF-8 でない）では、Araya の subcommand が何も処理せずに失敗し、message に path が入る。`araya`（引数なし）と `araya pi` は設定ファイルを読まない。
- [ ] `araya status` が設定ファイルの path と、指定した model と thinking level を表示する。
- [ ] worker の入力と出力の `model` は厳密に検証され、不正な値は拒否される。
- [ ] 外部の Pi auth や model API を使わずに test が通る。
- [ ] README と仕様が設定ファイルを説明している。

## 技術調査結果（Pi coding-agent 1.4.0）

- `createAgentSession` は `model` と `thinkingLevel` を受け取る。`model` を渡すと、その model をそのまま使い、認証は確認しない。`model` を渡さないと `findInitialModel` が、`settings.json` の `defaultProvider`・`defaultModel`（その provider の認証があるときだけ）→ Pi に組み込まれた provider ごとの既定 model → 使える最初の model、の順で選ぶ。この切り替えは警告を出さない。
- 実測: `defaultProvider: openai`・`defaultModel` を存在しない id にした `settings.json` と、`openai`・`anthropic` の dummy 認証で session を作ると、`anthropic/claude-opus-4-8` が選ばれた（prompt を送る前に止めて確認）。
- `thinkingLevel` を渡さないと、`modelThinkingLevels["<provider>/<id>"]` → `defaultThinkingLevel` → `medium` の順で決まる。どの場合も `clampThinkingLevel` で model の対応範囲に丸められる。実測: `defaultThinkingLevel: high` と `modelThinkingLevels["openai/gpt-5.5"]: xhigh` では `xhigh` になった。
- `settings.json` の `enabledModels` は `createAgentSession` の model 選択に使われない（`findInitialModel` に空の scoped models を渡す）。
- `ModelRuntime.getModel(provider, id)` は、`refresh({ allowNetwork: false })` の後なら network なしで、組み込みの model 一覧と `models.json` から model を返す。
- Pi の `ThinkingLevel` は `off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` の7種類。

## Assumptions

- 形式は JSON にする。Node.js の標準機能で読めて依存を増やさず、Pi の `settings.json` と同じ形式だから。
- 場所は data directory にする。Pi が `~/.pi/agent` に設定と状態を置くのと同じ考え方で、`ARAYA_DATA_DIR` で状態と一緒に切り替えられるようにする。
- 設定ファイルが不正なときは、`status` も含めて失敗させる。不正な設定のまま開発課題を処理しないため。
- `thinkingLevel` を省略したときは Pi の設定に従う。model だけを固定する使い方を簡単にするため。使った値は evidence に残る。
- model が使えないときの `failureReason` は既存の `agent_failed` とし、新しい値は足さない。原因は `workerErrorName` で区別できる。
