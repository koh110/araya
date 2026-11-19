# 設定ファイルによる agent session の model 指定

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）に置きます。`settings.json`・`auth.json`・`models.json`・`models-store.json`・`sessions/`・Pi SDK が管理する `bin/` はここに置きます。Araya 側の TUI（`araya` または `araya pi`）で `/login` と `/model` を設定します。

## 概要

Discord 会話の agent session（main も child も）が使う model と thinking level を、Araya の設定ファイルで指定します。指定した model が使えないときは別の model に切り替えず、会話 session を開始しません。

## 設定ファイル

- 場所は `<dataDir>/config.json`（既定 `~/.araya/config.json`）。`dataDir` は `ARAYA_DATA_DIR` で変わります。
- 形式は UTF-8 の JSON object で、64 KiB までです。top-level key は `agent` だけです。`agent` 自体は省略できますが、指定する場合は object でなければならず、`model` は必須、`thinkingLevel` は省略可能です。したがって `{}` は設定なしとして有効ですが、`{"agent":{}}` と `{"agent":{"thinkingLevel":"high"}}` は不正です。
- `agent.model` は `<provider>/<model id>` 形式です。最初の `/` で分けるため、model id に `/` を含められます（例: `openrouter/moonshotai/kimi-k2.6`）。provider と model id は空にできず、空白・制御文字を含めず、合計200文字までです。
- `agent.thinkingLevel` は省略可能で、`off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれかです。
- 知らない key、型の違う値、`null` は拒否します（例: `unknown key(s) in agent: fallbackModels`）。ファイルが存在するのに読めない、壊れた symlink、通常 file でない、64 KiB 超、UTF-8/JSON/schema が不正な場合、`invalid Araya config file <path>: <理由>` で失敗します。
- `araya`（引数なし）、`araya pi`、`araya --help` はこの設定を読みません。Discord bot は agent host を開くとき（起動時）に 1 回読みます。設定を変えたら bot を再起動するまで反映されません。

例:

```json
{
  "agent": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
```

## Pi settings からの初期設定はしない

TUI の `/model` が Pi の `<dataDir>/pi/settings.json` に保存した default provider/model を、araya が `config.json` へ自動で写すことはありません。`config.json` が無いときは、実行時に Pi の default provider/model を使います（下の「model の選び方」）。araya 用の設定を明示したいときは利用者が `config.json` を書きます。

## model の選び方

- `agent.model` があれば、その provider と model id を Pi の model runtime から検索します。
- `agent.model` が無い（config 無い・`agent` 省略）なら、Pi の `SettingsManager` が持つ default provider/model を使います。
- provider・model id が決まらない、model が Pi の一覧に無い、認証が設定されていない場合は、会話 session を開始せず、理由を channel に伝えます（例: `model が設定されていません。araya pi で /login と /model を実行してください`）。別 model への fallback はしません。
- thinking level は、設定ファイルの値 → Pi の model ごとの設定 → Pi の default → `medium` の順で決め、選ばれた model の対応範囲に丸めます。設定が `off` のときは Pi 側の最小の thinking に写像します。
- 設定ファイルの model 指定が無いことを `null` として扱い、source は `araya-config`・`pi-settings` のいずれかとして保持します。

## 責務の分担

- `loadConfig(env)` は環境変数と data directory を解決します。`loadConfigFile(configPath)` は設定ファイルを読み、model の値を検証します。
- `resolveAgentModel(models, configured, piSettings)`（`src/agent/model.ts`）が config の model 指定と Pi の既定から model を決め、使えないときは `{ ok: false, message }` を返します。host は失敗を `araya_agent_model_unavailable` に変えて会話 session を開きません。
- `agentModel` は `{ provider, id, thinkingLevel } | null` です。`null` は設定ファイルに model 指定が無いことを表します。

## 今回の対象外

- 利用上限に達したときの fallback model と自動 retry
- 会話ごとの model 指定
- 設定ファイルの hot reload
- model 利用可否を事前表示する独立 command
- YAML・TOML・コメント付き JSON

## Assumptions

- JSON を使い、Node.js 標準機能で読みます。依存を増やさず、Pi の settings と同じ形式で扱うためです。
- Araya config は data directory に置き、Pi の状態と同様に `ARAYA_DATA_DIR` で切り替えます。
- 不正な設定のまま会話を開始しません。bot は起動を続け、会話 session を開かないことで会話機能を利用不可にします（channel への応答と `discord_chat_unavailable` log）。
- thinking level を省略した場合は Pi の設定に従います。
