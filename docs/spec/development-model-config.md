# 設定ファイルによる開発 agent の model 指定

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）に隔離します。`settings.json`・`auth.json`・`models.json`・`models-store.json`・`sessions/`・Pi SDK が管理する `bin/` はここに置き、runner の model cache は `<dataDir>/runner/models-store.json` に置きます。host Pi からの fallback・copy・migration・symlink は追加しません。Araya 側の TUI（`araya` または `araya pi`）で `/login` と `/model` を設定してください。

## 概要

開発 Task を処理する SHIKI の model と thinking level を、Araya の設定ファイルで指定します。指定した model が使えないときは別の model に切り替えず、試行を失敗にします。使用した model と設定元は台帳と evidence に記録します。

## 設定ファイル

- 場所は `<dataDir>/config.json`（既定 `~/.araya/config.json`）。`dataDir` は `ARAYA_DATA_DIR` で変わります。
- 形式は UTF-8 の JSON object で、64 KiB までです。top-level key は `development` だけです。`development` 自体は省略できますが、指定する場合は object でなければならず、`model` は必須、`thinkingLevel` は省略可能です。したがって `{}` は設定なしとして有効ですが、`{"development":{}}` と `{"development":{"thinkingLevel":"high"}}` は不正です。
- `development.model` は `<provider>/<model id>` 形式です。最初の `/` で分けるため、model id に `/` を含められます（例: `openrouter/moonshotai/kimi-k2.6`）。provider と model id は空にできず、空白・制御文字を含めず、合計200文字までです。
- `development.thinkingLevel` は省略可能で、`off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれかです。
- 知らない key、型の違う値、`null` は拒否します。ファイルが存在するのに読めない、壊れた symlink、通常 file でない、64 KiB 超、UTF-8/JSON/schema が不正な場合、`task`・`runner` は何も処理せず `invalid Araya config file <path>: <理由>` で失敗します。
- `araya`（引数なし）、`araya pi`、`araya --help` はこの設定を読みません。`task`・`runner` command は開始時に読み、常駐 runner は試行を取り込むたびに再読込します。

例:

```json
{
  "development": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
```

## runner install 時の初期設定

- `araya runner install`（`npm run deploy` を含む）は、`<dataDir>/config.json` が無い場合に限り、Araya 専用の `<dataDir>/pi/settings.json` から `defaultProvider` と `defaultModel` を読み、両方が有効なら `development.model` を一度だけ mode 0600 で作成します。
- `thinkingLevel` は書きません。Pi の認証情報や他の settings を複製せず、`auth.json` を読まず、model API も呼びません。
- 既存 config は `{}` を含めて変更しません。Pi settings が無い・読めない・不正、または有効な default model が無い場合は config を作らず warning を出して install を続けます。
- 初期設定後に Pi の default model を変更しても Araya config は更新されません。Araya の model を切り替える場合は利用者が `config.json` を変更します。

## model の選び方

- `development.model` があれば、その provider と model id を Pi の model runtime から検索します。model が一覧に無い場合、認証が設定されていない場合は会話を開始せず、`agent.error: model_unavailable` と `failureReason: agent_failed` で試行を失敗にします。別 model への fallback はしません。
- model が未指定なら、Pi の `SettingsManager` が持つ default provider/model を使います。Pi の model runtime に利用可能な model が無ければ試行を失敗にします。
- thinking level は、設定ファイルの値 → Pi の model ごとの設定 → Pi の default → `medium` の順で決め、選ばれた model の対応範囲に丸めます。
- 使用した provider、model id、thinking level、設定元は `runs.model_json` と試行 evidence の `agent.model` に記録します。`source` は設定ファイル由来なら `araya-config`、Pi 設定由来なら `pi-settings` です。
- model 一覧の更新は `allowNetwork: false` で行います。model API 呼び出しは SHIKI が Task を実行するときだけ発生します。

## 責務の分担

- `loadConfig(env)` は環境変数と data directory を解決します。`loadConfigFile(configPath)` は設定ファイルを読み、model の値を検証します。
- CLI は `task`・`runner` command の開始前に設定を読みます。runner は試行を取り込む直前に読み、取得した値をその試行に固定します。不正な設定では試行を取り込みません。
- `developmentModel` は `{ provider, id, thinkingLevel } | null` です。`null` は設定ファイルに model 指定が無いことを表します。

## 今回の対象外

- 利用上限に達したときの fallback model と自動 retry
- Task ごとの model 指定
- 設定ファイルの hot reload
- model 利用可否を事前表示する独立 command
- YAML・TOML・コメント付き JSON

## Assumptions

- JSON を使い、Node.js 標準機能で読みます。依存を増やさず、Pi の settings と同じ形式で扱うためです。
- Araya config は data directory に置き、Pi の状態と同様に `ARAYA_DATA_DIR` で切り替えます。
- 不正な設定のまま Task を処理しないよう、task・runner command は設定エラーで失敗させます。
- thinking level を省略した場合は Pi の設定に従い、実際に使った値を evidence に残します。
