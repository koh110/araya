# Araya Discord bot として動かす実験用 MVP

## 必要になるもの

- Linux と systemd（254 以降）の user manager に到達する host。`araya discord` はそれ以外の host では使えません
- Node.js 26.8 以上
- git
- Discord application と bot token（Discord developer portal で作成）。`araya discord init` が要求する settings は application_id・guild_id・channel_id・bot token・allowed user ids の 5 項目です。会話の読み書きには Bot Permissions の View Channels と Send Messages、bot を channel に参加させてください。Message Content intent（Privileged Intents）も有効にしてください
- 会話が model を呼ぶための認証。Pi 側の `/login` を `npm run araya` の TUI で済ませます（`--help` には出しません。設定の場所は「model を選ぶ」に書きます）
- 会話に model が必要です。model を選んで `config.json` の `agent.model` に設定してください（「model を選ぶ」）。araya 側が model を選ぶことはありません
- 開発作業先の git repository。既定では `~/dev` にある repository を使い、agent はその repository を自分で編集します（`ARAYA_DEV_ROOT` で変えられます。「開発 root の選び方」）
- 開発作業先が GitHub.com の repository で、agent に `gh` を使わせたいときは、bot と同じ OS user で `gh auth login` を済ませてください（「GitHub の repository へアクセスさせる」）

## install する

```sh
git clone https://github.com/koh110/araya.git
cd araya
npm ci
npm run deploy
```

`npm run deploy` は、`araya` コマンドをユーザーの global prefix（既定 `~/.local`）に入れ、`~/.local/bin` を PATH に足してください。data directory（既定 `~/.araya`）に `.env` がある場合は、そのまま Discord bot を systemd の user service として入れます。`.env` が無い場合は unit を入れず、次の init を案内して成功で終わります。`.env` に 1Password の参照（値が `op://` で始まる行）がある場合は、`op run --env-file` で参照を解決してから `araya discord install --auth-mode 1password` を実行します（「1Password に保存した settings を使う」）。このとき PATH に 1Password CLI（`op`）が無いか `OP_SERVICE_ACCOUNT_TOKEN` が未設定なら、araya を入れ替える前に終了 code 1 で止まります。

```sh
araya discord init
```

`araya discord init` は `<ARAYA_DATA_DIR>/.env`（mode `0600`）を作り、設定 file への link と、Discord developer portal で application を作る手順・portal に載っている settings 名・Bot Permissions・Message Content intent の名前一覧を出します。araya が Discord へ直接問い合わせて候補を選ぶことはしません。値はすべて利用者が決めます。

`.env` を書いたら Discord bot を入れます。

```sh
araya discord install
```

`araya discord install` は unit file を書いて有効化し、起動して稼働を確かめます（「Discord bot を管理する」）。`araya discord` に Linux と systemd の user manager が必要で、Linux 以外・user manager に接続できない環境では終了 code 69 で終わります。その場合 `npm run deploy` は unit を入れずに成功で終わり、`araya discord install` 単体では 69 で終わります。`araya discord run` は unit を使わない foreground の試験起動です（Ctrl+C で止まります）。unit 経由にこだわらない運用は、この `araya discord run` を systemd などの仕組みで常駐させることもできます。

`araya discord` の失敗は理由を stderr に出し、終了 code 1 で終わります（その環境で使えない理由による失敗は 69）。`npm run deploy` は、その環境に Discord bot を入れられる host かどうかを確かめません。Linux 以外の環境でも `araya` 自体（Pi coding agent の TUI）は使えます。

## 1Password に保存した settings を使う（任意）

Discord の settings は平文の `.env` file に保存します。1Password の Desktop アプリに保存した値（`op://` の vault/item/field の参照）を使いたい場合は、unit file に入れた service が起動するたびに 1Password CLI が `.env` の `op://` 参照を解決し、値は unit file、systemd の control command、起動する process の command line に現れません。1Password を使わない利用者が install で迷わないよう、この mode は `--auth-mode 1password` を明示したときだけ使えます。unit file には `araya discord install` を実行した環境の `OP_SERVICE_ACCOUNT_TOKEN` の値は書きません。Service Account token 自体は、systemd が管理する暗号化 credential file として保存します（「1Password Service Account を systemd credential に保存する」）。

`.env` には平文の値と `op://` 参照を混ぜても、すべての項目を `op://` 参照にしても構いません（全項目が参照の `.env` を 1Password CLI 2.42.0-beta.01 の `op run --env-file` で解決できることを確認しています）。Service Account の token が読める vault に Discord settings を集約してください。

## model を選ぶ

開発作業には model が必須です。araya 側の TUI で model を選んでから、`config.json` の `agent.model` に設定します。araya 側が model を選ぶことはありません。

内蔵 Pi の設定・認証・session は `<dataDir>/pi`（既定 `~/.araya/pi`）にあります。araya 側の TUI を起動して `/login` と `/model` を設定します。

```sh
npm run araya
```

TUI の `/model` で model を選ぶと、選んだ provider と model id が Pi の default として `<dataDir>/pi/settings.json` に保存されます。araya 用に明示的に設定したいときは `<dataDir>/config.json` の `agent.model` に書きます。設定の詳しい定義は [docs/spec/agent-model-config.md](docs/spec/agent-model-config.md) にあります。

araya が実際に使う model は、1. `<dataDir>/config.json` の `agent.model`、2. Pi が保存した default provider/model の順で決まります。指定できる model が無いまま bot の起動は続きますが、その場合会話は利用できません（「会話の仕組みとできること」）。

```sh
# 例: openai/gpt-5.5 を model に選ぶ
cat > ~/.araya/config.json <<'JSON'
{
  "agent": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
JSON
```

`model` は `<provider>/<model id>` です。`thinkingLevel` は省略できます（省略すると Pi の設定で決まります）。API key は設定ファイルに書かないでください（読みません）。設定ファイルが無いときも、Pi の default model が有効ならそれを使います。bot は起動時に設定ファイルを 1 回読みます。

## 開発 root の選び方

agent が作業するのは `ARAYA_DEV_ROOT`（既定 `~/dev`）の中の repository です。agent は file tool と shell で development root の repository を自分で編集し、GitHub への commit・push・PR 作成もその shell（`git`・`gh`）で行います。araya 側が worktree を作ったり、diff を集めたり、検証して commit・push を代行したりする仕組みはありません。作業の進め方は agent への依頼文で決めます。

開発 root を切り替えるときは `araya discord install` を実行し直すまで、unit file の `Environment=` は前の値のままで、Discord bot は前の development root で動きます。`ARAYA_DEV_ROOT` を絶対 path で指定してください（`~` は unit file 内で展開されません）。unit file に書けるのは安全な文字だけで、`$()` のような command 展開の文字や制御文字を含む値は拒否されます。

GitHub の repository を対象にするとき、bot と同じ OS user の GitHub CLI `gh` が使える環境で動かしてください（「GitHub の repository へアクセスさせる」）。

## 会話で依頼する

`araya discord install` で入った常駐 service として、Discord の会話が使えます。`araya discord install` の代わりに `araya discord run` で foreground の試験起動（Ctrl+C で止まる）も使えます。

Discord developer portal で application を作成し、`araya discord init` の案内にしたがって settings を `.env` に設定してください（「install する」）。`.env` file に `op://` 参照を使って、Desktop アプリの Vault に保存した Discord settings を解決することもできます（「1Password に保存した settings を使う」）。

### 会話の仕組みとできること

- 設定 channel に発言すると、channel ごとの 1 つの Pi durable conversation（main agent session）が応答します。bot を再起動しても同じ文脈から続けます
- main agent session には file tool（read・edit・write）と bash が付いています。development root の repository を編集し、`git`・`gh` を使って commit・push・draft PR 作成まで行えます。large な作業は Pi durable の named child session（子 session）へ依頼でき、子 session は main session と同じ file tool・bash を持ちます。araya 側の task 台帳・runner・`/araya task` slash command は撤去済みで、task の作成・進捗・実行管理は Pi durable の session に任せます
- HOOT（課題発見 loop）が **承認済みの `dispatch` をこの main agent session へ inject** することがあります（人間の `araya hoot dispatch --key <proposal key>` か Discord の `/hoot dispatch key:<proposal key>`、または `mode=active` + `autoDispatch=true` で承認した分だけ）。inject は人間の message と同じ queue で直列し、「何を自動化したか」の 1 文と session の answer が channel に届きます。inject された案件も `/araya stop`・`/araya reset` で止められます（定義は [docs/spec/hoot-minimal.md](docs/spec/hoot-minimal.md)）
- bot の startup で `/araya` と `/hoot` を guild へ登録します（同じ startup での host check 失败と違い、command 登録の失败は会話機能を止めず `<dataDir>/logs/discord.log` の `discord_commands_register_failed` に残します）。古い `/araya task ...` の定義が残っている guild では、その subcommand を実行すると「撤去しました」の ephemeral 応答だけ返ります
- main agent が report delivery（channel への送信依頼）を宣言した送信は、設定 channel へ届くまで再送されます
- 送信は 1 件の message を 2000 文字ごとに分割して届けます。Discord へ出る文字列と log には既知の secret 相当の文字列を伏字（`[REDACTED]`）して書きます。channel への入力（user message・reply 待ち）も伏字します
- 会話と HOOT の操作は **Discord の slash command** に統一しています（入力した option はそのまま会話の text にはならず、model を通しません。queue の外で処理するので会話の実行中でも効き、応答は ephemeral であなただけに見えます）:
  - `/araya status`（main conversation と HOOT の状態を 1 画面） / `/araya stop`（進行中の処理と queue の依頼を中止） / `/araya reset`（会話 session を作り直す。inject 済みの文脈も切れる） / `/araya help`
  - `/hoot status` / `/hoot dispatch key:<proposal key>`（承認） / `/hoot runs` / `/hoot evidence`（delivery 前後の観測差。read-only） / `/hoot reset-schedule` / `/hoot inject list` / `/hoot goal list・add・update・pause・resume・retire` / `/hoot settings show・set` / `/hoot proposal list・history・resolve`（`araya hoot` と同じ operation。`--data-dir` は Discord からは指定できません）
  - `status`・`stop`・`reset`・`hoot ...` と channel に **text で書く**と、それは予約語ではなくそのまま会話として model に渡ります（制御は slash command だけ）
  - 会話 session の operation は CLI からも同じ名前で打てます: `araya status` / `araya stop` / `araya reset`（Discord の `/araya status`・`/araya stop`・`/araya reset` が通る bot process 内の同じ kernel を呼ぶ）。会話 session を操作できるのは稼働中の bot だけなので、CLI は要求を `<dataDir>/control/requests/` に書き、bot が次の poll（既定 1 秒）で実行して `<dataDir>/control/results/` に応答を書きます。要求 file を書ける OS user が許可の境界です
  - 応答は既定 30 秒まで待ちます（`araya status --wait-seconds <秒>`、上限 120）。bot が応答しなかった場合、`araya stop` / `araya reset` は `araya_control_unavailable` で失敗し、待った要求は取り消されます（後で bot が実行しません）。`araya status` だけは読み取りなので、HOOT の状態と「araya discord status で unit の稼働を確かめてください」の案内を返して exit 0 で終わります。bot 側の状態は bot の log（`discord_control_cli` / `discord_control_cli_failed`。command 名だけ残し option の値は書きません）で追跡します
  - 意図的に CLI だけに残す operation: `araya discord init・install・uninstall・run・status`（bot token・systemd unit・1Password credential を触る操作を Discord の command からは叩かない）と `--data-dir` の指定（Discord 側は bot process の dataDir だけを正とします）。`araya discord status` は unit file の有無・ActiveState / SubState・restart 回数・last ready を読むだけの command です
  - agent の shell からも同じ command が打てます（`araya status`・`araya stop`・`araya reset`・`araya hoot ...`）。以前 agent session の shell に限定していた gate（`araya_control_agent_session_blocked` / `hoot_agent_session_blocked`）は撤去しました。境界は「control dir と HOOT の state file を書ける OS user」と Discord の allowlist の 2 つだけで、agent に対する制限は instructions 側の約束（依頼のない HOOT の有効化・自分の proposal の自己承認をしない）で持ちます
- 会話の入力 channel は `ARAYA_DISCORD_CHANNEL_ID` に一致する専用 channel だけです。別 channel、許可されていない user、bot・webhook・system の message は無視します。Discord thread には返信しません（parent channel の reply thread には返信できます）
- 会話は at-least-once で扱います。bot が応答途中に停止した場合、Discord 側で同じ発言がもう一度届くと応答が重複することがあります
- model を解決できない場合（未設定・Pi の model 一覧に無い・認証が無い）や設定ファイルが不正な場合は、会話 session を開かず、channel への発言には「会話機能を利用できません」の応答が返ります。bot 自体は動き続け、理由は `<dataDir>/logs/discord.log`（`discord_chat_unavailable`）に記録されます

### 会話の log と保存される文字列

Pi durable の保存 transcript（`<dataDir>/agent/agent.sqlite`）に書かれた user 入力・assistant 応答・tool 呼び出しは、そのまま保存されます。transcript の文字列は secret redaction の対象ではないため、model や GitHub の credential・API token・bot token などを会話や tool 実行に投稿しないでください。araya 側の log（`<dataDir>/logs/discord.log`）は既知の secret を伏字してから書きます。

## GitHub の repository へアクセスさせる

Discord 会話の agent は development root の repository に対して `git` と GitHub CLI（`gh`）を bash から使えます。araya は GitHub token を受け取らず、agent・log・Discord の message に token を書かず、command の引数にも渡しません。bot process の実行時環境から `GH_TOKEN` などの GitHub token 変数を除き、`gh` が保存済みの認証状態（`gh auth login` の状態）だけを使うよう `GH_CONFIG_DIR` と `GH_HOST` selector を引き継ぎます。

- 対象 repository へ access できる OS user で bot を動かしてください。`npm run deploy`（`araya discord install`）を実行した user が `gh auth login` を済ませていると、その認証状態がそのまま使えます
- bot と同じ OS user で `gh auth status --hostname github.com` が成功することを確認してください
- GitHub Enterprise server は対象外です。`GH_HOST` selector に対して github.com 以外の host を指定した unit install は拒否されます
- bot process へ渡す GitHub 関連 environment は `GH_CONFIG_DIR` と `GH_HOST` selector だけです。`gh` が secret として拒否する `GITHUB_*` の変数名や、`gh` が host selector として拒否する `GH_*` の変数名は unit file に書きません。`GH_HOST` の指定がない場合は `gh` 自身の既定（github.com）が使われます
- 開発作業の commit・push・PR 作成は agent の bash が利用者の権限で実行します。araya の組み込み検証・delivery 経路は撤去済みで、agent の実行を止める sandbox はありません（「注意」）

## Discord bot を管理する

Discord bot は systemd の user service です。`araya discord install`（`npm run deploy` を含む）で入ります。unit の名前は `araya-discord-<hash>.service`（`<hash>` は data directory の実 path から決まります。`araya discord install` の出力に載ります）。

`araya discord install` の実行は bot の再起動を伴います。再起動が済んだことは state file で確かめます。unit の停止・再起動・起動失敗は `araya discord install` の失敗として終了 code 1 になり、`npm run deploy` の終了 code 1 にもなります。unit file は `~/.config/systemd/user/` に置かれ、起動失敗時は systemd が 5 秒間隔で起動し直します。

再起動の間に message を受信できないことを可視化するため、前回の起動の確かめがある install は restart の前に permission channel へ「再起動します」を投稿し、bot は起動完了後に「再起動しました」（前回の記録が無い初めての起動では「起動しました」）を投稿します。通知の投稿に失敗しても restart と bot の稼働は続け、失敗は warning と `discord_restart_notice` log（成否のみ）で追跡します。その間に届いた message は、bot が起動し直したときに channel の直近 history から取り直します（state.json の cursor より新しい物だけを古い順に会話へ流す。15 分以上古い物と 20 件を超える古い側は取り直しませんが、state.json に残した unfinishedMessageIds（受理したのに turn が終わらなかった ids）はこの 2 つの上限を見ません）。unfinished が 20 件を越えてこの round に取り直せないときは古い unfinished を取り直し候補から落とし、その id を `discord_backfill_unfinished_stuck` に出します（cursor はその id より後ろへ進まず、取り直しが進まない限り次の round も同じ fetch 範囲（history の新しい 100 件）を読み直します）。実行中に打ち切った message は cursor を進めていないので、同じ取り直しで読み直します。unfinishedMessageIds・answeredMessageIds（実応答の chunk を Discord へ送ろうとした ids。send 自体が失敗して `discord_chat_reply_failed` になった物も含む。「delivered answer」ではなく「send を試みた」の記録で、会話 input は consume 済みなので restart 後に turn を再実行しない。reply だけの再送はしない）は state.json に保存するので、process が落ちても取り直し対象から消えません（cursor は unfinished より後ろへ進みません）。live で受理した事実は取り直しを止める条件にしません（受理は処理完了ではないため、受理しただけの id を gate にすると置き去りが二度と取り直されない）。cursor が無い起動（state file を持たない初めての起動、または古い version から `lastSeenMessageId` を持ち引きしていない起動）の seed も同じ gate を通します: unfinished より後ろへ history の newest を置かず、seed できる id が無いときは cursor を null のままにして `discord_backfill_skipped` の reason `no_seedable_history`（unfinishedCount・historyCount）に出します（seed を素通りさせると cursor が unfinished を越え、その id は candidate から外れて prune で state file から消える）。backfill が live の state へ cursor をマージして保存する所も同じ gate を通し、越えそうになったら `discord_backfill_cursor_merge_blocked`（cursor・requestedCursor・unfinishedMessageIds）に出て cursor を動かしません（現在の配線では unfinished の集合を live と backfill で共有しているので backfill 側の per-message gate が先に効きます。ここは defense の gate です）。`onReady` より前に messageCreate が届いた場合は chatHandler が無いので `discord_chat_ignored` の reason `handler_not_ready` に出し、unfinished に書いて cursor は進めない（turn を走らせていない message を処理完了扱いにしない）。live と取り直しが同じ message を二重に走らせる exclusivity は live が turn を実行中にしている id だけを見て行い、`discord_backfill_ignored` の reason を `live_processing`（live 実行中）と `already_handled`（この process が処理を終えた id・前回の process で実応答を送った id）に分けて discord.log に出します。live 側も backfill が処理を始めた・終えた id を再次配信として受け取らず `discord_chat_duplicate_skipped` に記録します（reason は `already_processing`（live で turn が実行中）と `already_processed`（この process が turn を終えた・会話にしない message として破棄した）。Discord が同じ message を 2 度配信した場合（echo・再接続後の再 delivery）もこの gate で会話は 1 回だけになります）。live 側の gate が見るのはこの process の実行中・処理終了の id だけで、前回の process の answeredMessageIds は見ない（Discord が同じ message id を 同じ nonce を 1 通にまとめる過去数分のあいだを越えて再配信しない前提）。案内（終了時の「今回は処理できませんでした。」と会話機能不可の案内）だけ送った turn は answeredMessageIds に記録しません（Discord 側への送信結果は処理の完了ではない）。state.json 上で unfinished が cursor より古い側にある場合（cursor の gate 以前に書かれた state・state file を手で編集した場合）は cursor を後ろへ戻さず、その id だけ history から取り直します（`discord_unfinished_restored` の `behindCursor` に出す）。取り直しを試みられた起動（history の fetch まで辿り着いた起動）では、その後も history に現れず cursor が越えている unfinished を state file から落とし、落とした id を `discord_unfinished_pruned` に出します。history を読めなかった起動では prune せず、次の restart の取り直し対象として残します（fetch 失敗で落とすと、取り直せたはずの id を黙って捨てる）。cursor が越えた answeredMessageIds も state file から落とすので、id 集合は restart を重ねても膨れません（backfill は cursor より新しい物だけを見る）。取り直した期間の長さと置き去りにした message id は `<dataDir>/logs/discord.log` の `discord_backfill`（unreceivedMs・unfinishedRemaining・取り直し後の cursorAfter）・`discord_shutdown_unfinished`・`discord_unfinished_restored` に残ります（本文は残しません）。history の fetch 範囲（新しい 100 件）から外れた message と削除された message は取り直せる対象として history へ返らないので、`discord_backfill_unfinished_unreachable` log に id を出して取り直し対象から除きます（そのまま残すと cursor が恒久的に止まる）。history が 0 件の fetch では判定せず、live で受理して実行中の id も対象から除きません（history は fetch 時点の快照なので、その後ろに届いた message がそこに無いだけだから）。取り直しの送信は live の応答と同じ nonce を使い回すと、終了時に送った「今回は処理できませんでした」の notice と Discord 側で重複して answer が落ちるので、取り直し専用の nonce を使います（取り直しでは `backfill:<messageId>:<chunkIndex>` の namespace で、同じ message の同じ chunk index から同じ nonce を送る。Discord が同じ author + 同じ nonce を 1 通にまとめるのは過去数分のあいだだけなので、取り直しが複数回走っても同じ chunk は 1 通にまとまり、違う chunk は別の message として残る。数分以上離れた再送は別の message として channel に届くので、restart 後の再応答は answeredMessageIds で抑える）。

Discord bot の起動を確かめたことは、`<dataDir>/discord/state.json`（version 3）に state key（unit・readyId・lastReadyAt・lastSeenMessageId・unfinishedMessageIds・answeredMessageIds）として保存されます。取り直しの cursor は `lastSeenMessageId` の事で、古い version が残した `cursor`（number）や `backoff` という key 名とは無関係です。state file に既知 key 以外が残っている場合（#29 で撤去した通知配送 retry 用の `cursor`・`backoff`、rollback や手当てで書き足した key）は read で state へ引き込まず `discord_state_extra_keys`（keys）に出し、次の state 書き込みで file から消します。未知 key を理由に起動は止めません。state file に credential の値は保存しません。state file が無い・読み取れない・別の unit について記録されている場合は、起動の確かめができません。install は失敗で終わり、service 自体は起動したままになることがあります。version 1・version 2 の file は読み取り時に migration します（`lastSeenMessageId` はそのまま保持し、無い key だけを埋めるので v2 の cursor 値が null に戻る事はありません。unfinishedMessageIds・answeredMessageIds は空配列で埋めるので、version 2 以前に置き去りだった message id は復元できません）。version 3 を書いたあと version 2 を読む build へ戻すと `discord_state_invalid` で bot は起動しません（`araya discord status` は state を読めず「まだ ready になっていない」に見える）。古い build へ戻すときは state.json を退避してから unit を入れ直してください。state file が書けない状況（directory の permission 失敗など）は `discord_state_write_failed` として log に出すだけで、受理済みの会話は止めません（state の書き込み失敗は観測の問題で、会話を実行しない理由にはしない）。

- 止める: `systemctl --user stop araya-discord-<hash>.service`
- 起動・再開: `systemctl --user start araya-discord-<hash>.service`
- log を見る: `<dataDir>/logs/discord.log`（1 行 1 件の JSON、秘密を置き換えたもの）。bot の stdout と stderr は捨てます。env-file launcher を使った unit では、Discord 設定の解決に失敗したときの note が `<dataDir>/logs/discord-launcher.log` に出ます
- 削除する: `araya discord uninstall`。unit を止めて無効にし、unit file を消します。state.json と agent session の SQLite（`<dataDir>/agent/`）は残ります。uninstall は guild から slash command を消しません。削除したいときは「araya を更新する」の手順の bulk overwrite（空の一覧）を使ってください

`araya discord install` は linger を変えません。有効な host では logout 後も bot が動き続け、linger が無効な host では logout で bot が止まります。install は、linger が無効で、その host での logout が bot を止めることを `araya discord install` の warning として出します。linger を有効にするコマンド（`loginctl enable-linger`）の自動実行はしません。実行しないまま logout すると、次に login するまで bot は止まります。`araya discord install` は systemd の user manager に接続できる環境で実行してください（`su` で切り替えた session など、user manager に接続できない session からは実行できません）。

1Password mode の unit を使っている場合は、`araya discord uninstall` の後に保存された credential file（`<dataDir>/op-service-account-token.cred`）を消すかどうか確認します。unit file が入ったままの credential file を消すことはしません。

環境変数を変えたとき、`araya discord install` を実行し直すまで、unit file の `Environment=` は前の値のままで、bot は前の環境で動きます。`ARAYA_DATA_DIR` を変えて `araya discord install` を実行すると、`<hash>` が変わるので別の unit（別の bot）ができ、前の bot は動き続けます。前の bot を残さないときは、前の `ARAYA_DATA_DIR` を指定して `araya discord uninstall` を実行してください。

bot は stop signal を受けると、新しい依頼の受付を止め、すでに受理した処理と queue に並んでいた依頼を最後まで処理し、reply を届けてから Discord connection を閉じます。進行中の処理を打ち切ったり、queue を捨てたりはしません。queue に残る依頼を取り消すには、channel に「stop」と書いてください（進行中の処理にも中止を要求します）。bot process が stop した後に Discord へ送る処理は残らないため、bot process が stop した後に Discord へ届いた文字列は bot の stop 前に送信が済んでいた分だけです。

## araya を更新する

```sh
git pull
npm ci
npm run deploy
```

`npm run deploy` は、その環境の data directory の Discord bot を新しいコードで入れ直して起動します。会話 session（Pi durable の SQLite）はそのまま続くので、会話の文脈は切れません。

task 機構があった古い version からの更新: `araya discord install` が残った runner unit（`araya-runner-<hash>.service`）を止めて削除し、結果に `removedLegacyRunnerUnits` を表示します。`--auth-mode` を省略すると既存 unit の mode を保ちます。設定 file の `development` key も撤去済みで、`development.model` を使っていたときは `model` と `thinkingLevel` を `agent` へ移してください（移行しないと config 不正になり、error に案内が出ます）。

古い version が guild に登録した slash command（`/araya task` など）の定義は、bot の startup で `/araya` と `/hoot` を bulk overwrite すると置き換わります（startup での host check 失败は bot の startup 失败として surface しますが、command 登録の失败は bot を止めず `<dataDir>/logs/discord.log` の `discord_commands_register_failed` に残します）。guild の一覧を確認したいときは `GET /applications/@me/commands` ではなく、まず `/applications/{application_id}/command`（1 件も登録が無ければ `400 10041 "Application id is invalid"`）で application 自体が見えるかを確かめてください。この Discord application を作った user が token を作った人と違う場合、token にはその application を管理する権限がなく、`PUT`（bulk overwrite）も `400 10041` になります（その場合は application を管理できる user の token で流すか、Discord Developer Portal から定義を消す。araya は token を要求しません）。

```sh
data_dir="${ARAYA_DATA_DIR:-$HOME/.araya}"
node --env-file="$data_dir/.env" --input-type=module -e '
const env = process.env
const url = `https://discord.com/api/v10/applications/${env.ARAYA_DISCORD_APPLICATION_ID}/guilds/${env.ARAYA_DISCORD_GUILD_ID}/commands`
const response = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${env.ARAYA_DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
  body: "[]",
})
console.log(response.status, await response.text())
'
```

この snippet は guild に登録された command をすべて消します（成功すると `200 []`）。bot を動かしている限り次の startup で `/araya` と `/hoot` は再登録されます。

data directory に残った古い version の file（`tasks.sqlite*`、`runner/`、`runtime/`、`development/`、`discord/chat.sqlite*`、`discord/chat-settings/`、`discord/runner/`、`logs/runner.log` など）は現行の araya が読まないので、使っている process が無いことを確かめてから削除できます。`discord/state.json`、`agent/`、`pi/`、`.discord-bot.lock` は現行の araya が使うので残してください。

## 注意

- agent（main session も child session も）は sandbox 無しで、bot を動かしている OS user の権限で動きます。会話で指定した repository だけでなく、利用者が書き込める file を変更でき、`git`・`gh` で remote を直接変更することもできます。commit・push・PR 作成を agent に依頼するか、人の確認を挟むかは会話の中で決めてください
- Pi durable の保存 transcript は secret redaction の対象ではありません。credential を会話に投稿しないことが唯一の防御策です
- 送信の重複防止は期限付きの nonce で行うため、同じ依頼の応答が稀に重複することがあります（at-least-once。exactly-once ではありません）
- データは `~/.araya`（`ARAYA_DATA_DIR` で変わります）に置かれます。アクセス権とバックアップは利用者側で管理してください
- 環境変数・設定ファイルの完全な一覧と、内部の仕組みは docs/development.md にあります。

## その他のコマンド

- 引数なしの `araya` は Pi coding agent の TUI を起動します。`araya pi ...` は引数を Pi にそのまま渡し、`araya --help` はヘルプを表示します。
- 課題発見 loop と dispatch の inject（HOOT）: `araya hoot status`、`araya hoot goal add --key <key> --objective "<目的>" --scope github:owner/repo [--review-at YYYY-MM-DD|none]`、`araya hoot settings set --enabled true`、`araya hoot runs`、`araya hoot proposal list` / `araya hoot proposal history`（closed になった提案を updatedAt の新しい順に最大 5 件。read-only） / `araya hoot proposal resolve --key <key>`、`araya hoot dispatch --key <proposal key>`、`araya hoot inject list`。Discord bot process が interval で goal と schedule を見て（channel からの操作は `/hoot ...` の slash command）、tool を持たない判断 run を 1 回走らせ、判断を `<dataDir>/hoot/state.json`（version 5。version 1・version 2・version 3・version 4 は読み取り時に migration）に記録し、必要なら channel に 1 件送ります。
  観測 fingerprint（goal 単位。open 件数・item number・最新の updatedAt・draft 数で、title は含まない）が前回と同じ occurrence では model を呼ばず noop を記録し（precheck。観測に gap がある occurrence では precheck せず model を呼び、digest に gaps の件数を出します）、`watchdogHours`（既定 24）以内に 1 回は model で全体を見ます。daily limit は model を呼んだ run だけを数えます。`investigate` / `dispatch` / `request_human` は open な proposal として state に残り、backoff で最大 `maxProposalReminders` 回（既定 3）再提醒して期限（既定 72 時間）で期限切れになります。即時の Discord 通知は `notifyDecisions`（既定 `request_human` / `invalid`）だけで、他は UTC 1 日 1 回の digest（既定 21 時）にまとめます。goal には review 期限 `reviewAt`（既定 30 日）があり、過ぎた active goal は model を呼ばず自動 paused になります。digest には open な proposal の key も出るので、そのまま `araya hoot proposal resolve --key <key>` に使えます。全 `araya hoot` command は任意で `--data-dir <path>` を取ります（未指定なら稼働中 bot と同じ `<dataDir>/hoot/state.json`）。既定は `enabled=false` で、有効化しても判断の記録と通知だけで作業は始まりません。作業に繋がる導線は承認された `dispatch` の inject だけ（次項）。判断 run は goal と観測だけ見て走りますが、人間の `araya hoot settings set --conversation-read true`（Discord では `/hoot settings set conversation-read:true`。既定 false）で有効化したときだけ、判断会話に main の Discord 会話 transcript を読む読み取り専用 tool（`read_conversation`）が入ります。main 会話への送信・file 編集・child 作成はできず、読んで model に見せる量は 1 run 4 回 / 20 entry / 8,000 文字までで redact 済み、使用量は `araya hoot runs` の `reads: …` 行に出ます（詳しくは docs/spec/hoot-minimal.md の「判断会話から main 会話を読む」）。定義は [docs/spec/hoot-minimal.md](docs/spec/hoot-minimal.md)。
- 承認済みの dispatch だけ、main の Discord 会話（main agent session）へ inject して作業を進められます。request を作るのは人間の `araya hoot dispatch --key <proposal key>`（または channel からの `/hoot dispatch key:<proposal key>`。`mode` を `active` に設定していることが必要）か、`mode=active` + `autoDispatch=true`（`autoDispatch` は既定 false）だけ。`mode=active` は設定できる（`hoot_mode_unimplemented` での拒否は廃止）が、`autoDispatch` を true にしない限り自動では inject しません。bot process が poll（既定 60 秒以内）ごとに pending を 1 件だけ main 会話へ流し、人間の message と同じ queue で直列化して「何を自動化したか」の 1 文と session の answer を channel に返します。inject は `maxInjectsPerDay`（既定 2。人間の承認で作った分も数える）と `injectCooldownMinutes`（既定 60 分）で押さえ、`investigate` は inject しません（proposal のまま）。inject の dedupe key は `hoot-inject:<proposal key>:<n>`（attempt を含まない）で、poll の再試行や restart 後の再 poll でも同じ案件が main 会話を 2 度走ることがありません。`stop` で中止した inject を自動でやり直すのもありません（打ち直すのは人間の `/hoot dispatch key:<proposal key>` か `araya hoot dispatch --key <proposal key>`）。bot process が動いていないと request は pending のまま残り、`araya hoot inject list` か `/hoot inject list` で状態を見られます。失敗は 2 回（`MAX_INJECT_ATTEMPTS`）で打ち切って 1 件案内を送ります。
- 未実装: dispatch した案件の task 台帳・worktree 作成・PR 作成との接続（inject は main agent session へ 1 件の input を流すだけで、Pi durable の named child session へ自動で依頼しない）。`investigate` の実行（inject できる decision は `dispatch` だけ）と、dispatch した proposal の auto resolve（proposal は open のまま提醒が続く）。他に webhook などの event-driven wakeup、GitHub 以外の外部ソース監視、通知 channel の分離。

## 1Password Service Account を systemd credential に保存する

`araya discord install --auth-mode 1password` は、実行環境の `OP_SERVICE_ACCOUNT_TOKEN` を 1Password CLI 2.18 以降で読み、`.env` を file launcher で解決する unit を作ります。Service Account 以外の認証（1Password Connect token、`OP_SESSION`、Desktop アプリの session）はこの mode では使いません。

install を実行する環境に Service Account token を用意します。

```sh
export OP_SERVICE_ACCOUNT_TOKEN="$(op read 'op://<vault>/<item>/<field>')"
data_dir="${ARAYA_DATA_DIR:-$HOME/.araya}"
op run --env-file="$data_dir/.env" -- araya discord install --auth-mode 1password
```

通常の `araya discord install` は `.env` file launcher を選び、1Password CLI や Service Account を必要としません。`--auth-mode 1password` を使うには、install process の環境に `OP_SERVICE_ACCOUNT_TOKEN` を設定し、1Password CLI 2.18 以降と、`.env` の参照項目を読める Service Account を用意してください。1Password mode は systemd user manager v258 以降と `systemd-creds` が必要です。古い manager では平文保存へ fallback せず、install を拒否します。

install は token を `systemd-creds --user --with-key=auto encrypt` の stdin に渡し、暗号文だけを `~/.araya/op-service-account-token.cred`（file mode `0600`、directory mode `0700`）へ保存します。暗号鍵の値を `.env` や環境変数で別途与える必要はありません。`auto` では systemd が利用可能な TPM2 と永続ホスト鍵を使い、どちらも利用できない場合は暗号化に失敗して install を中止します。鍵はアプリのホーム directory には保存せず、systemd 管理下の TPM2 や root のみ読める `/var/lib/systemd/credential.secret` が使われます。したがって暗号文だけを別 host や OS 再 install 後へ移しても復号できるとは限りません。常駐 unit は `LoadCredentialEncrypted=` を使い、systemd が復号した credential を service 実行中に `$CREDENTIALS_DIRECTORY` の file として渡します。Service Account token は unit file、systemd control command の環境、bot process には渡しません。`op` CLI が `.env` を解決し、Discord 設定値だけを bot process の実行時環境へ渡します。

旧形式の平文 source（`~/.config/araya/op-service-account-token`）が見つかった場合は、新しい unit の restart 成功後に、安全性を再確認して unlink します。安全に削除できない場合は warning を出します。unlink は媒体上の secure erase を保証するものではありません。systemd の unit 定義自体は `~/.config/systemd/user/` に置かれ、実行中の credential は systemd 管理の一時領域に置かれます。

手動の `araya discord run` で `.env` の `op://` 参照を使う場合は、`op run --env-file="$data_dir/.env"` から起動してください。systemd service の 1Password credential 設定については、[Service Account と 1Password CLI](https://www.1password.dev/service-accounts/use-with-1password-cli) と [op run で secret を環境変数へ渡す](https://www.1password.dev/cli/secrets-environment-variables) を参照してください。
