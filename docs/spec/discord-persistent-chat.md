# Discord 継続会話

## 概要

設定された非公開の専用 Discord channel で、許可された利用者が mention なしで Araya と会話できるようにする。会話は channel 単位の1つの Pi Durable conversation に追記し、Discord bot の再起動後も同じ文脈から続ける。

会話セッションは対話と依頼の整理を担う。コードを読む・書く・検証する tool は持たせず、利用者が実装を明示的に依頼した場合だけ、会話内の要件を Task として既存 Task runner に登録する。実作業は既存の Task/worktree/verification/Draft PR flow に委ねる。

## 入出力

- 入力: `ARAYA_DISCORD_GUILD_ID` と既存の `ARAYA_DISCORD_CHANNEL_ID` が一致し、`ARAYA_DISCORD_ALLOWED_USER_IDS` に含まれる人間の Discord message。
- `ARAYA_DISCORD_CHANNEL_ID` に一致する専用 channel では、許可 user の通常 message を mention なしで会話入力として扱う。別 channel/guild、許可されていない user、bot/webhook/system message は無視する。
- bot mention が含まれていれば本文から取り除き、残った本文を投稿者の user ID とともに会話へ送る。本文が空の投稿、添付ファイル・embed・音声だけの投稿は無視し、mention だけの投稿には入力を促す。
- `reset`（または `@Araya reset`）はこの channel の会話を reset し、以後の会話を新しい文脈で始める。
- 出力: channel に通常 message として返信する。Discord の message 上限に合わせて分割し、全返信で `allowedMentions` を無効にする。

## Data Model

- Pi Durable の conversation storage は `<dataDir>/discord/chat.sqlite`。Discord bot process だけが開く。Task runner が所有する `runner/durable.sqlite` とは共有しない。
- 設定 channel は1つなので、chat storage の root conversation 1つを継続して使う。許可された複数 user の投稿も同じ channel conversation に入れ、本文へ投稿者 ID を付けて区別する。
- Discord message ID を submission `requestId` に使い、Pi Durable が同じ入力の再送を重複登録しない。Task tool の idempotency key は durable tool call ID から作る。
- chat transcript は Pi Durable に保存される。user input と Task fields は既知の秘密を保存前に redaction する。model が生成した返信は Discord へ送る前に redaction するが、生成中の assistant entry は Pi Durable に保存されるため、秘密を投稿しないよう README で注意する。
- chat storage directory は mode `0700`、SQLite file は mode `0600` とする。

## Tech Stack

- 現在の `discord.js` Gateway と `@earendil-works/pi-durable` / Pi `ModelRuntime` を使用する。既存依存の範囲で実装する。
- Discord intents は `Guilds`、`GuildMessages`、`MessageContent`。専用 channel 内の通常 message を mention なしで受け取るため、Discord Developer Portal で `Message Content` privileged intent を有効化する。intent 自体は channel 単位ではないため、アプリが見られる範囲を制限し、本文の取り出し・保存は guild/channel/user の allowlist 検証後に行う。
- chat agent は Araya の `development.model`、未設定なら Pi の既定 model を SHIKI と同じ規則で選ぶ。
- chat agent に与える model tool は `araya_submit_task` のみ。file read/write、shell、git、外部 API の tool は登録しない。

## Task 登録

- 利用者が現在のメッセージで実装・変更の実行を明示した場合だけ、agent は `araya_submit_task` を呼べる。質問、アイデア、設計相談、「できるか」の確認では登録しない。不明確なら会話で確認する。
- tool は `title`、`goal`、必要なら `constraints` / `targets` を受け、既存 `parseTaskInput` で検証し、known secrets を redaction してから `TaskLedger.createTask` を呼ぶ。
- tool から `permissions` は受け取らず、常に空配列にする。認可・実行範囲の新しい仕組みは作らない。
- Task tool の idempotency key は durable tool call ID から作る。Discord message ID は durable input の `requestId` に使い、同じ投稿イベントの再送を重複処理しない。
- agent は登録した Task ID を返信する。コード変更や検証そのものは chat agent で実行せず、runner の通知・既存 `/araya list|show|cancel|retry` で追跡する。

## Failure Handling

- chat storage/model の初期化に失敗した場合も、既存の slash command と Task 通知は継続する。chat は unavailable として log し、本文のある許可投稿には短い利用不可の返信を返す。
- 1ターンの model/Task登録失敗は秘密を含まないエラーとして log に残し、channel に短い失敗返信を送る。bot process は継続する。
- bot process 再起動時は保存済み conversation を再開する。同じ message ID の通常入力・reset の再送は重複処理しない。
- shutdown は新しい chat input の受付を止め、既に受理した会話と返信を Gateway が接続中のまま drain してから Gateway と session を閉じる。
- Discord 送信失敗は既存 bot の error logging に記録する。exactly-once の外部送信は保証しない。

## Non-functional Requirements

- channel と user の allowlist 検証を本文処理・Pi への保存より前に行う。
- chat agent に repo file / shell tool を付与しないことで、Task runner の isolation と verification 境界を保つ。
- Pi Durable storage を別 process と共有しない。
- Discord の messageCreate 処理は受信順に直列化し、1 channel の会話文脈を逆順にしない。
- ログは Discord 本文・model 出力・Task goal を含めず、既知の秘密を redaction する。

## Out of Scope

- 複数 chat channel / channel ごとの別 session、thread ごとの session。
- 添付ファイル・画像・音声入力、voice channel、DM。
- chat session からの直接 file / shell / git 操作。
- chat 履歴の共有・同期・export UI。
- 指定された guild/channel 以外の message 本文を会話入力・保存・ログへ渡すこと。

## Acceptance Criteria

- [x] 設定 channel・guild・許可 user の条件を満たす通常 message が、bot mention なしで会話に届く。
- [x] 別 channel/guild/user、bot/webhook/system message は Pi submission を作らない。本文のない投稿も無視し、mention だけの投稿には本文入力を促す。
- [x] 同一 channel の会話は同じ durable conversation に順序通り追加され、storage を再openした後にも継続する。
- [x] 同じ Discord message ID の再送では二重の会話入力・Task が作られない。Task tool の idempotency は durable tool call ID による。
- [x] `reset` または `@Araya reset` で会話 context を reset でき、同じ reset message の再送で後続の会話を消さない。
- [x] chat agent は `araya_submit_task` 以外の tool を持たず、Task tool 経由で登録された作業は既存 runner に渡される。
- [x] 会話で通常回答する場合は Task を作らず、Task tool の結果には Task ID が含まれ、agent へその ID を伝えるよう指示する。
- [x] user input と Task fields は既知の秘密を保存前に redaction し、Discord へ送る assistant reply も redaction する。bot log は本文・model 出力・Task goal を含まない。
- [x] 返信は Discord の上限以下に分割され、mention parsing を行わない。
- [x] Gateway は `MessageContent` privileged intent を要求し、README は Developer Portal の設定要件を説明し、unit test は intent と mention なしの動作を検証する。
- [x] shutdown は chat の新規受付を止め、Gateway 接続中に受理済み turn と reply を drain してから close する。

Acceptance checks は repository の unit/integration test で検証する。実 Discord app の token を使った live Gateway 接続は、認証情報と実環境で別途確認する。

## Assumptions

- ユーザーが選択した実行モデル: channel 会話は継続・復元し、コード変更は既存 Task runner に明示投入する。
- 既存 `ARAYA_DISCORD_CHANNEL_ID` を chat input と Task 通知の共通 channel とし、許可ユーザーだけが閲覧できる非公開の Araya 専用 channel にする。新しい channel 設定は追加しない。
- mention なしの会話を有効にするため、Message Content privileged intent を使う。Developer Portal 側の設定は運用者が行う。
- Task 登録の明示性は「現在のユーザーメッセージに含まれる明確な実装・変更依頼」で判定し、別の confirmation UI は追加しない。
- Chat transcript は durable storage に保存するため、`.env` の token など秘密を Discord へ投稿しないことを利用者へ案内する。

## Technical Investigation

- 変更前の既存実装: `packages/araya/src/discord/gateway.ts` は `GatewayIntentBits.Guilds` と slash command を使用し、`packages/araya/src/discord/bot.ts` は Task ledger を開いて通知と command handler を実行する。
- Pi Durable: 現行の installed declaration `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts` に `Conversation.submit()`、`Submission.wait()`、永続 storage を使う `Harness.open()` がある。既存 runner は同じ package の `Harness.open()` と `openNodeSqliteStorage()` を使用する。
- Discord Gateway: [Gateway: Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent) を使い、許可 channel の mention なし message を受け取る。intent は Developer Portal で有効化が必要で、guild/channel/user の絞り込みはアプリ側で行う。
- model resolution は `packages/araya/src/runner/attempt.ts` の `resolveShikiModel()` / `SettingsManager` の既存規則を再利用する。
