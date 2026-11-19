# HOOT 最小形（Human Out of the Loop / wakeup dry run）

## 概要

HOOT は「Araya が人間の依頼を待っている時間」に、設定した目的（goal）について **観測し、次の一手を判断し、記録する** loop。現行の実装は P0（dry run）で、判断 result を state に残し、必要なら Discord へ 1 件通知する。**判断にしたがって作業を開始することはない**（model に tool を渡さず、file を書き換えず、process を起動しない）。

Discord bot process の中に loop として常駐し、`<dataDir>/hoot/state.json` を single source of truth にする。CLI（`araya hoot`）と同じ file を lock で共有する。

model を呼ぶかどうか・人間に何を返すかは、可能な限り **deterministic な code 側**で決める（観測 fingerprint の precheck、watchdog、daily limit、提案の保持と期限、goal の review 期限、通知の allowlist、digest）。model に「働きすぎないこと」を判断させない。

## state と file

```text
<ARAYA_DATA_DIR>/hoot/state.json   # goals・settings・schedule・判断 run・proposals の記録
<ARAYA_DATA_DIR>/hoot/.state.lock  # proper-lockfile（bot loop と CLI の read-modify-write を直列化）
```

- state の `version` は **2**。version 1 の `state.json` は **読み取り時に v2 へ migration する**（読みのみ。次の `updateHootState` で v2 で保存される）。migration が埋めるもの:
  - goal の `reviewAt`（基準は **file 内容**・v1 の `loop.lastRunAt` と goal の `updatedAt` の新しい方 + `settings.goalReviewDays`。read のたびに期限が前進しない。最後に走った時刻から `goalReviewDays` をとっくに過ぎている goal は、次の tick で自動 paused になって resume / retire を問う形になる）
  - `loop.lastModelRunAt`（v1 の `lastRunAt` を継ぐ）・`loop.lastDigestAt`・`loop.conversationRuns`（0）・`loop.goalFingerprints`（`{}`）
  - 既存 `runs` の `source: 'model'`
  - `proposals: []`
  - settings は新しい項目を既定値で埋める。`notifyNoop` は廃止で、`notifyNoop=true` なら `notifyDecisions` に `noop` を 1 本足す（`false`・**key 欠落**は既定の allowlist。型が違う値は v1 の形として受け付けない）
- state は JSON 1 件。壊れた file は **復旧せず** `hoot_state_invalid` の誤りとして表面化する（黙って初期化しない）。restore は unit stop → file 差し替え → unit start。
- 判断 run の記録（`runs`）は直近 200 件だけ保つ（`MAX_RUNS_KEPT`）。proposals は直近 50 件（`MAX_PROPOSALS_KEPT`。closed を古い順に落として open を残す）。open な proposal は最大 10 件（`MAX_OPEN_PROPOSALS`）。
- 書き込みは `state.json.<rand>.tmp` → rename（atomic）。directory は `0700`、file は `0600`。
- 会話 transcript は HOOT の JSON には含めない。HOOT 専用の Pi durable conversation id（number）だけ保存し、main の Discord 会話とは別に opens する。

## settings

| key | default | 意味 |
| --- | --- | --- |
| `enabled` | `false` | false の間は model も gh も呼ばない（tick gate を抜けない） |
| `mode` | `dry_run` | `active` は未実装。設定しようすると `hoot_mode_unimplemented` で拒否する |
| `tickMinutes` | `60` | schedule occurrence の間隔（5〜1440） |
| `maxRunsPerDay` | `8` | UTC 1 日あたりの判断 run 上限（1〜48）。**model を呼んだ run だけ**を数える。precheck の noop は budget を使わない |
| `notifyDecisions` | `["request_human", "invalid"]` | 即時 Discord に送る decision の allowlist。`noop` / `wait` 等は digest に出す（`notifyNoop` は撤去） |
| `precheckObservation` | `true` | 観測 fingerprint が前回と同じ occurrence では model を呼ばない（観測に gap がある occurrence では precheck しない） |
| `watchdogHours` | `24` | precheck で飛ばしていても、この時間以内に 1 回は model で全体を見せる（1〜168） |
| `digestHourUtc` | `21` | digest を送る UTC hour（0〜23）。`none`（`null`）で無効 |
| `resetConversationAfterRuns` | `24` | この model run 数で HOOT 判断会話を新しくする（0 で無効） |
| `goalReviewDays` | `30` | 新しい goal に自動で入れる review 期限の日数（0〜365。0 で無期限） |
| `proposalTtlHours` | `72` | 未応答の proposal を open で保持する期限（1〜720） |
| `maxProposalReminders` | `3` | 1 件の proposal への再提醒の上限（0〜10。0 で送らない） |

## goal

HOOT が「人間の代わりに気にしている対象」。key は一意（`HOOT_GOAL_KEY_PATTERN` = 先頭 `[a-z0-9]`、以降 `[a-z0-9-]` まで、1〜64 文字。`.` は使えない）。

```sh
araya hoot goal add --key araya-quality \
  --objective "open issue と draft PR を拾って次作業の提案を作る" \
  --scope github:koh110/araya \
  --constraint "merge は人間の承認後だけ"
```

- `scope` は現時点で `github:owner/repo` だけ（goal 1 件に最大 12 entry）。observation はそのうち最大 6 repo（`OBSERVATION_REPOS_MAX`）に集める。
- status は `active` / `paused` / `retired`。active が 1 つ以上あるときだけ tick が進む。goal は最大 20 件。
- `reviewAt` は goal の review 期限（ISO UTC。`YYYY-MM-DD` は 00:00 UTC）。未指定時の解決規則（`parseReviewAt`）: **new は `settings.goalReviewDays`（`0` なら `null` で無期限）／update は `--review-at` を渡さない限り現在の値を保持（goal 編集で review を伸ばさない）／`none`・`null`・空 text は無期限（既定日数を足し直さない）**。CLI は `--review-at <YYYY-MM-DD | ISO datetime | none>`。
- `reviewAt` を過ぎた active goal は tick 冒頭で **model を呼ばず自動 `paused`** になり、goal ごとに 1 件案内を送る。人間の応答は `goal resume`（続ける）か `goal retire`（終わらせる）。HOOT が同じ空腹を繰り返さないための期限付きの歯止め。
- `goal resume`（`setGoalStatus active`）は review 期限も扱う: **過ぎた期限は `settings.goalReviewDays` 分伸ばす**（過ぎていない期限は動かさない／無期限の goal は `null` のまま／`goalReviewDays=0` なら無期限に戻す）。`goal pause` は期限を変えない。resume が期限を伸ばさないと、次の tick で即再 pause になる（test で固定）。

## schedule（occurrence）

interval poll（既定 60 秒、`HOOT_TICK_POLL_MS`）で tick するが、run するのは **occurrence**（`hoot:<ISO UTC>` key）単位。

- `lastOccurrenceAt` に `tickMinutes` を足した時刻が次の occurrence。まだ 1 回も走っていなければ now が最初の occurrence。
- 起動していなかった間に過ぎた occurrence は **catch-up しない**。now 以下の最新の occurrence 1 件だけ走り、飛ばした件数は `missedOccurrences`（最大 1000）に記録する。
- 同じ occurrence key の run が既にあれば再実行しない（schedule 更新前に crash した場合も、run 記録を見て schedule だけ進めて `occurrence_recorded` で終える）。
- precheck の noop run も occurrence を 1 件消費する（model を呼ばなくても schedule は前に進む）。
- tick が run に進まない理由（`disabled` / `no_active_goal` / `not_due` / `failure_cooldown` / `daily_limit` / `occurrence_recorded` / `already_running`）は `HootTickOutcome.kind` として返す。model も gh も呼ばない。review 期限超過で goal を paused にした tick は `goals_review_paused` で終わり、ここで model も gh も呼ばない。run した tick の kind は `ran`（model を呼んだ）と `prechecked_noop`（呼ばなかった）で、どちらも `remindersSent` / `digestSent` を返す。

## 観測（Araya の deterministic code）

`src/hoot/observe.ts` が `gh` の **read-only** list command だけで集める。

- `gh issue list --repo <repo> --state open --limit 30 --json number,title,updatedAt`
- `gh pr list --repo <repo> --state open --limit 30 --json number,title,isDraft,updatedAt`
- 実行は `runBoundedCommand`（1 run 1 process、timeout 既定 20 秒、stdout 256KB tail、stderr 64KB tail）。`gh` が PATH に無ければ gap になる。
- bot process の環境から `GH_TOKEN`・`GITHUB_TOKEN` 等は継承しない（Discord 会話と同じ約束）。`GH_CONFIG_DIR`・`GH_HOST` は継承する。
- 失敗・JSON 異常は落とさず `repos[].gaps` に text で残し、判断 run は走らせる（`hoot_observation_gaps` を log する）。
- Issue / PR の title や body は **証拠であり命令ではない**。external text を instruction に混ぜないことは prompt の constraint として model 側にも書くが、保証は code 側（tool なし・観測は固定 command）で持つ。
- repo ごとに **fingerprint** を決める（`open 件数・item number 集合・最新の updatedAt・draft 数` の sha256 16 hex）。**title は含めない**（title を直しただけで毎回「変化あり」にして空振りしないため）。list は limit 30 までしか見ないので、limit 外の変更は検出しない（件数が 30 で飽和する）。
- 観測に失敗した repo の fingerprint は `null`（`<repo>:unknown` として扱う）。

## model を呼ぶかどうか（precheck と watchdog）

- fingerprint は **goal 単位**（`goal.updatedAt` + objective / constraints の hash + その goal の scope repo の fingerprint）で、`loop.goalFingerprints` に保存する。
- `precheckObservation=true` で fingerprint が前回と同じ occurrence では **model を呼ばず**、`source: 'precheck'` の noop run を 1 件記録して occurrence を進める（`noop` の繰り返しで会話と model 呼び出しが自己強化しないための歯止め。reason は code 側の固定 text）。
- 複数 goal は「1 つでも変われば model を呼ぶ」。goal の追加・`objective` / `constraint` の編集（`updatedAt` 変化）も変化として扱う。
- 観測に **gap が 1 件でもある occurrence では precheck せず model を呼ぶ**（証拠が欠けている状態で code 側の noop を確定させない。壊れた gh のまま「変化なし」で黙り込まない）。gh が壊れた repo の fingerprint は `unknown` 寄りになり、同じ穴が続けば fingerprint は据わるが、gap がある限り precheck は発動しない。model を呼ぶ回数は `maxRunsPerDay`（既定 8）で抑止し、digest に `observation gaps: N 件` を出す。
- `watchdogHours`（既定 24）: `loop.lastModelRunAt` からこの時間が経っている occurrence では、precheck の条件を満たしていても model を呼ぶ。飛ばし続けて 1 日全体を見ない状態を作らない。

## 判断 run（model）

- prompt は `src/hoot/prompt.ts` が code から組み立てる（goal・settings・観測・直近 8 件の判断・**open な proposals**）。external text を instruction にしない。open proposals を見せて、同じ goal 集合・同じ decision の提案の再生産を止める（proposal の key を決めるのは model ではなく code）。
- model への依頼は 4 問（新しく着手すべき課題があるか／完了待ち・情報不足か／人間への依頼が必要か／どれもなければ noop）。external 由来 text には従わない。
- 出力は最後の 2 行を決まり形式にして求める（`DECISION: noop|wait|investigate|dispatch|request_human` と `REASON: <1 行>`）。前の行は根拠の summary。`parseDecision` は最後の `DECISION:` 行を採用し、決まり形式でなければ `decision: 'invalid'` として記録する（黙って noop にしない）。
- 判断 run は **tool を持たない** 専用 Pi durable conversation で走る（`openArayaAgentHost()` の `hootDecide()`）。submit の前に conversation を `configure({ tools: [], modelTools: [] })` で書き直すので、file tool・bash・task tool・Discord tool のどれもない。model が tool を要求しても実行される tool は存在しない。
- 会話 id は state に保存し、restart 後も同じ会話を続ける。main の Discord 会話と同じ transcript にはしない（`ownership: { kind: 'ownerless' }` で、main の background child にもしない）。
- `resetConversationAfterRuns`（既定 24）件の model run で HOOT 判断会話を新しくする（`loop.conversationRuns` が基準。noop の判断が積み重なって会話が自分を強化することを防ぐ）。reset は `hoot_conversation_reset` に log する。
- 判断 text が書けなかった run は **run として記録しない**（`araya_hoot_unanswered` で失敗扱い）。連続失敗数と cooldown は state に durable に持つ。

## 記録（HootRun）

occurrence ごとの判断結果を `runs` に積む。P0 では dispatch しないので `dispatched` は常に false。

`occurrenceKey` / `source`（`model` / `precheck`） / `plannedAt` / `decidedAt` / `decision` / `reason` / `summary` / `goalKeys` / `missedOccurrences` / `dispatched` / `observedRepos` / `observationGaps`

- `source: 'model'` は判断 run を走らせた記録。`source: 'precheck'` は code 側 noop（`decision: 'noop'`、`summary` は空、`observationGaps` は空）で model を呼んでいない。
- `recordHootRun` は `source: 'model'` の run を書いたときに `loop.lastModelRunAt`（watchdog の基準）も進める。基準の書き手は store 1 箇所で、tick は別の update をしない。precheck noop と、同じ `occurrenceKey` の replay は進めない。
- `observationGaps` は 1 run につき 12 件まで保存する（log も 12 件）。

## proposals（人間が応答すべき pending）

`investigate` / `dispatch` / `request_human`（`PROPOSAL_DECISIONS`）は `state.proposals` に **open な pending** として残す。実行はしない（`dispatch` も提案だけ）。人間が応答・却下するまで残り続ける。

- `key` は sha256 16 hex の `decision | goal keys`（goal key は sort した集合）。**観測 fingerprint は key に含めない**（title を fingerprint に含まないのと同じ理由で、観測の細かい変化では key を増やさない。変化の証拠は occurrence key 側に残す）。
- 同じ goal 集合・同じ decision の open 提案は **1 件に寄せる**。新しい occurrence で同じ decision が出た **再確認**は `reason` / `updatedAt` / `evidenceOccurrenceKeys` だけ更新し、**`expiresAt` と `reminders` は変えない**（期限と提醒回数は人間が応答するまで据え置く。`evidenceOccurrenceKeys` は最大 10 件 `MAX_PROPOSAL_EVIDENCE_KEYS`）。
- `evidenceOccurrenceKeys` は根拠になった occurrence key そのもの（`hoot:<ISO UTC>`）。JSON のまま occurrenceKey が **public evidence ID** で、`araya hoot runs` の記録と突き合わせられる。
- `expiresAt`（`createdAt + proposalTtlHours`）を過ぎた open は `expired` になる（tick 内で closed にする）。
- open な proposal が `MAX_OPEN_PROPOSALS`（10）以上のとき、新しい提案は作らない（`hoot_proposal_limit` に log する）。
- **再提醒**: open に対して基準時刻 `lastReminderAt ?? createdAt`・間隔 `tickMinutes * 2 ** reminders` の backoff で `maxProposalReminders` 回まで、1 tick に 1 件だけ送る（1 件目はその次の occurrence）。`maxProposalReminders=0` で送らない。期限切れで止まる。
- 人間の応答は `araya hoot proposal resolve --key <key>`（open を `resolved` にする）。status は `open` / `resolved` / `expired`。

## 通知

- 即時通知は `notifyDecisions` の allowlist が決める（既定は `request_human` と `invalid`＝安全側）。`noop` / `wait` / `investigate` / `dispatch` は送らず digest で返し、提案は state に残る。
- 1 occurrence 1 件。nonce は `hoot-<sha256(occurrenceKey) 18 hex>`（再送で同じ nonce）。他の通知は nonce の hash input を `reminder:<key>:<n>`（再提醒）、`digest:<UTC day>`、`review:<goal key>:<reviewAt>`（自動 pause）、`<occurrenceKey>:failure:<回数>`（連続失敗）にして、同じ key が同じ nonce になるようにする。text は 1800 文字で切る。
- **digest**（`digestHourUtc`、既定 21 UTC、0〜23 / none）: UTC 1 日 1 回、`utcHour(now)` が `digestHourUtc` と一致する tick で送る（`loop.lastDigestAt` が同じ UTC 日なら送らない）。中身はその UTC 日の run 内訳（model 判断 / precheck noop の数と decision 別の件数、最大 6 種 `HOOT_DIGEST_DECISION_LINES`。run が無ければ `判断なし`）、最新の `request_human` の reason、**open proposals（key 付き。最大 3 行 `HOOT_DIGEST_PROPOSAL_LINES`。超過分は「他 N 件は araya hoot proposal list」）**、observation gaps 件数。 集計対象は保持している `runs`（直近 200 件 `MAX_RUNS_KEPT`）内でその UTC 日のものだけなので、`tickMinutes` を極端に小さくして run が 200 件を超えると内訳は保持分だけになる（digest の数字は「直近 200 run のうちその日」の値）。
- 再提醒の text は `[decision] key`・REASON・goals・期限を含む（`HOOT 提案の再提醒 <n>/<max>`）。goal の自動 pause は resume / retire の案内を添える。
- 判断 run が 3 回続けて失敗したときに 1 件だけ失敗通知を送る（同じ streak で繰り返さない）。
- Discord へ書く text、log へ書く message は model・gh 由来の文字列を含むので、書き込む前に secret を `[REDACTED]` に置き換える。

digest の実形（`buildDigestNotice`。proposal の key をそのまま出すので、人間は digest を見て `araya hoot proposal resolve --key <key>` で応答できる。reason は 120 文字で切る）:

```text
HOOT digest 2026-11-19
runs: 3（model 判断 1 / precheck noop 2）
noop: 2 / request_human: 1
最新の request_human: <reason>
open proposals: 1
  - [request_human] 3f2a…（sha256 16 hex） <reason 120 文字>
observation gaps: 2 件
```

## CLI

```text
araya hoot status
araya hoot goal list | add | update | pause | resume | retire
araya hoot settings show | set
araya hoot proposal list | resolve --key <key>
araya hoot runs [--limit N]
araya hoot reset-schedule
araya hoot <command> ... [--data-dir <path>]
```

- `goal add` / `goal update` は `--key <key> --objective "<目的>" [--scope github:owner/repo,...] [--constraint "<制約>",...] [--review-at <YYYY-MM-DD|ISO datetime|none>]`。
- `settings set` は `[--enabled true|false] [--mode dry_run|active] [--tick-minutes N] [--max-runs-per-day N] [--notify-decisions a,b,c] [--precheck true|false] [--watchdog-hours N] [--digest-hour-utc N|none] [--reset-conversation-after-runs N] [--goal-review-days N] [--proposal-ttl-hours N] [--max-proposal-reminders N]`（`--notify-noop` は撤去）。
- `status` は open proposals・`conversationRuns`・`lastModelRunAt`・`lastDigestAt`・goal の `reviewAt` を表示する。
- `proposal list` は open を全件、closed を直近 5 件表示して総数は `open N / closed M` に出す。1 件は key・status・decision・goals・reason・`created / confirmed / expires / reminders` の 3 行。`proposal resolve --key <key>` は open だけ（resolved / expired 済みの key も `hoot_proposal_not_found`）。closed を動かす導線は用意しない（proposal の life cycle は open -> resolved / expired の 1 往復だけ）

`dataDir` は `araya` と同じ設定源（`ARAYA_DATA_DIR` / config file）を使う。全ての `araya hoot` subcommand は任意で `--data-dir <path>` を取れる（`options['data-dir'] ?? deps.dataDir`）: **未指定なら bot process と同じ resolution なので、`araya hoot status` は既定で稼働中 bot の `<dataDir>/hoot/state.json` を見る**。明示指定したときだけ別の file を指す（state 復旧作業で unit を stop した file を確かめる用途など）。bot process の起動・停止はしない。bot は次の tick（既定 60 秒以内）から新しい settings を読む。

## 今回の P0 で実装した歯止め

- **state version 2**（v1 は読み取り時に migration。壊れた file は復旧しない）。
- **precheck**: 観測 fingerprint（goal 単位）が変わらなければ model を呼ばず `source: 'precheck'` の noop を記録。複数 goal は 1 件でも変われば run。観測に gap が 1 件でもある occurrence は precheck しない。
- **watchdog**: `watchdogHours` 以内に 1 回は model で全体を見せる。
- **daily limit は model run だけ**数える（precheck noop は budget を使わない）。
- **proposals**: `investigate` / `dispatch` / `request_human` を open な pending として保持し、同じ goal 集合・同じ decision は 1 件に寄せる（key は `decision | goal keys`。観測 fingerprint は key に入れない）。open 上限 10、期限（`proposalTtlHours`）で `expired`、CLI で `resolve`。prompt に見せて再生産を止める。再確認でも期限と提醒回数は据え置く。
- **再提醒**: `lastReminderAt ?? createdAt` 基準の `tickMinutes * 2 ** reminders` backoff、`maxProposalReminders` 回まで 1 tick 1 件。
- **digest**: UTC 1 日 1 回、その日の内訳・最新の request_human・open proposals（key 付き 3 行まで、以降は CLI 案内）・observation gaps。
- **goal review 期限**: `reviewAt` を過ぎた active goal を model を呼ばず自動 paused にして 1 件通知。
- **会話 reset**: `resetConversationAfterRuns` 件の model run で HOOT 判断会話を新しくする。
- **即時通知は allowlist**（既定 `request_human` / `invalid`）。`noop` / `wait` 等は digest。

## drill-down で決めた将来方針

- **1A（dispatch の形）**: dispatch は「HOOT 判断 run に tool を渡す」形にはしない。HOOT は判断 record だけ作り、main の Discord 会話（`koh110-araya-main`）に **decision record を input として inject** して、作業はその会話側で走らせる。
- **2A（呼ばないことを code で決める）**: precheck + watchdog。複数 goal 対応済み（goal 単位 fingerprint、1 件でも変われば model）。
- **3A（goal の空腹を止める）**: `reviewAt` による自動 pause（resume / retire で人間が応答）。
- **4A（evidence）**: state は JSON のまま `occurrenceKey` を public evidence ID として維持する（proposal の `evidenceOccurrenceKeys`）。
- **5A（会話の自己強化を防ぐ）**: `resetConversationAfterRuns` による HOOT 判断会話の periodic reset。
- **6A（人間への返し方）**: 即時通知は allowlist、他は digest に寄せる。

## 未実装

- **`mode=active` と実際の dispatch**。main 会話への decision record inject（1A）はまだ無い。`mode=active` は `hoot_mode_unimplemented` で拒否し、`investigate` / `dispatch` は提案の記録だけ（`mode: dry_run`）。
- Issue label・webhook・Discord 反応などの event-driven wakeup。current 実装は interval schedule だけ。
- task 台帳・runner・worktree 作成・PR 作成。session-first 構成では work の unit は Pi durable の named child conversation であり、HOOT の record と child session を結ぶ layer はまだ無い。
- state への SQLite 採用（`state.json` + lock）。
- 外部 source 監視（GitHub 以外）。
- 通知 channel の分離（HOOT の通知は設定 channel に出す）。

## 失敗と停止

- bot process の shutdown では HOOT loop を stop してから gateway と agent session を閉じる（待機の上限 20 秒）。実行中の判断 run があっても打ち切らず、完了を待つ。
- 失敗時は run を記録せず、`consecutiveFailures` を 1 増やして `failureCooldownUntil = now + tickMinutes` を state に書き、その間 tick は `failure_cooldown` で終わる。判断 text が書けた run（`invalid` を含む）で連続失敗は 0 に戻る。
- goal の review 超過による自動 pause は失敗ではない（run を記録せず `goals_review_paused`）。
- `araya hoot reset-schedule` は schedule だけ戻す（run 記録・settings・proposals は保つ）。

## model 呼び出しの bound

enabled=false・active goal なし・occurrence 前・cooldown 中・daily limit 超過では model を呼ばない。occurrence の重複実行もしない。1 occurrence の model 呼び出しは submit 1 回まで（`whenBusy: 'reject'`、tool loop 走らない）。観測は model を呼ばない deterministic code だけ。precheck が発動するのは fingerprint 不変・watchdog 前・**gap なし**のときだけで、このとき model は呼ばない（gap が 1 件でもあれば precheck は発動しない）。
