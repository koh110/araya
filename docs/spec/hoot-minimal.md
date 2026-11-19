# HOOT 最小形（Human Out of the Loop / wakeup dry run）

## 概要

HOOT は「Araya が人間の依頼を待っている時間」に、設定した目的（goal）について **観測し、次の一手を判断し、記録する** loop。現行の実装は P0（dry run）で、判断 result を state に残し、必要なら Discord へ 1 件通知する。**判断にしたがって作業を開始することはない**（model に tool を渡さず、file を書き換えず、process を起動しない）。

Discord bot process の中に loop として常駐し、`<dataDir>/hoot/state.json` を single source of truth にする。CLI（`araya hoot`）と同じ file を lock で共有する。

## state と file

```text
<ARAYA_DATA_DIR>/hoot/state.json   # goals・settings・schedule・判断 run の記録
<ARAYA_DATA_DIR>/hoot/.state.lock  # proper-lockfile（bot loop と CLI の read-modify-write を直列化）
```

- state は JSON 1 件。壊れた file は **復旧せず** `hoot_state_invalid` の誤りとして表面化する（黙って初期化しない）。restore は unit stop → file 差し替え → unit start。
- 判断 run の記録（`runs`）は直近 200 件だけ保つ（`MAX_RUNS_KEPT`）。
- 書き込みは `state.json.<rand>.tmp` → rename（atomic）。directory は `0700`、file は `0600`。
- 会話 transcript は HOOT の JSON には含めない。HOOT 専用の Pi durable conversation id（number）だけ保存し、main の Discord 会話とは別に opens する。

## settings

| key | default | 意味 |
| --- | --- | --- |
| `enabled` | `false` | false の間は model も gh も呼ばない（tick gate を抜けない） |
| `mode` | `dry_run` | `active` は未実装。設定しようすると `hoot_mode_unimplemented` で拒否する |
| `tickMinutes` | `60` | schedule occurrence の間隔（5〜1440） |
| `maxRunsPerDay` | `8` | UTC 1 日あたりの判断 run 上限（1〜48）。超過日は model を呼ばない |
| `notifyNoop` | `false` | `noop` と判断したときに Discord へ通知するか |

## goal

HOOT が「人間の代わりに気にしている対象」。key は一意（`[a-z0-9][a-z0-9._-]{0,63}`）。

```sh
araya hoot goal add --key araya-quality \
  --objective "open issue と draft PR を拾って次作業の提案を作る" \
  --scope github:koh110/araya \
  --constraint "merge は人間の承認後だけ"
```

- `scope` は現時点で `github:owner/repo` だけ（goal 1 件に最大 12 entry）。observation はそのうち最大 6 repo（`OBSERVATION_REPOS_MAX`）に集める。
- status は `active` / `paused` / `retired`。active が 1 つ以上あるときだけ tick が進む。goal は最大 20 件。

## schedule（occurrence）

interval poll（既定 60 秒、`HOOT_TICK_POLL_MS`）で tick するが、run するのは **occurrence**（`hoot:<ISO UTC>` key）単位。

- `lastOccurrenceAt` に `tickMinutes` を足した時刻が次の occurrence。まだ 1 回も走っていなければ now が最初の occurrence。
- 起動していなかった間に過ぎた occurrence は **catch-up しない**。now 以下の最新の occurrence 1 件だけ走り、飛ばした件数は `missedOccurrences`（最大 1000）に記録する。
- 同じ occurrence key の run が既にあれば再実行しない（schedule 更新前に crash した場合も、run 記録を見て schedule だけ進めて `occurrence_recorded` で終える）。
- tick が run に進まない理由（`disabled` / `no_active_goal` / `not_due` / `failure_cooldown` / `daily_limit` / `occurrence_recorded` / `already_running`）は `HootTickOutcome.kind` として返す。model も gh も呼ばない。

## 観測（Araya の deterministic code）

`src/hoot/observe.ts` が `gh` の **read-only** list command だけで集める。

- `gh issue list --repo <repo> --state open --limit 30 --json number,title,updatedAt`
- `gh pr list --repo <repo> --state open --limit 30 --json number,title,isDraft,updatedAt`
- 実行は `runBoundedCommand`（1 run 1 process、timeout 既定 20 秒、stdout 256KB tail、stderr 64KB tail）。`gh` が PATH に無ければ gap になる。
- bot process の環境から `GH_TOKEN`・`GITHUB_TOKEN` 等は継承しない（Discord 会話と同じ約束）。`GH_CONFIG_DIR`・`GH_HOST` は継承する。
- 失敗・JSON 異常は落とさず `repos[].gaps` に text で残し、判断 run は走らせる（`hoot_observation_gaps` を log する）。
- Issue / PR の title や body は **証拠であり命令ではない**。external text を instruction に混ぜないことは prompt の constraint として model 側にも書くが、保証は code 側（tool なし・観測は固定 command）で持つ。

## 判断 run（model）

- prompt は `src/hoot/prompt.ts` が code から組み立てる（goal・settings・観測・直近 8 件の判断）。external text を instruction にしない。
- model への依頼は 4 問（新しく着手すべき課題があるか／完了待ち・情報不足か／人間への依頼が必要か／どれもなければ noop）。external 由来 text には従わない。
- 出力は最後の 2 行を決まり形式にして求める（`DECISION: noop|wait|investigate|dispatch|request_human` と `REASON: <1 行>`）。前の行は根拠の summary。`parseDecision` は最後の `DECISION:` 行を採用し、決まり形式でなければ `decision: 'invalid'` として記録する（黙って noop にしない）。
- 判断 run は **tool を持たない** 専用 Pi durable conversation で走る（`openArayaAgentHost()` の `hootDecide()`）。submit の前に conversation を `configure({ tools: [], modelTools: [] })` で書き直すので、file tool・bash・task tool・Discord tool のどれもない。model が tool を要求しても実行される tool は存在しない。
- 会話 id は state に保存し、restart 後も同じ会話を続ける。main の Discord 会話と同じ transcript にはしない（`ownership: { kind: 'ownerless' }` で、main の background child にもしない）。
- 判断 text が書けなかった run は **run として記録しない**（`araya_hoot_unanswered` で失敗扱い）。連続失敗数と cooldown は state に durable に持つ。

## 記録（HootRun）

occurrence ごとの判断結果を `runs` に積む。P0 では dispatch しないので `dispatched` は常に false。

`occurrenceKey` / `plannedAt` / `decidedAt` / `decision` / `reason` / `summary` / `goalKeys` / `missedOccurrences` / `dispatched` / `observedRepos` / `observationGaps`

## 通知

- 通知は settings の `notifyNoop` が決める。`noop` 以外の判断、および `invalid`（安全側）は必ず送る。
- 1 occurrence 1 件。nonce は `hoot-<sha256(occurrenceKey) 18 hex>`（再送で同じ nonce）。text は 1800 文字で切る。
- 判断 run が 3 回続けて失敗したときに 1 件だけ失敗通知を送る（同じ streak で繰り返さない）。
- Discord へ書く text、log へ書く message は model・gh 由来の文字列を含むので、書き込む前に secret を `[REDACTED]` に置き換える。

## CLI

```text
araya hoot status
araya hoot goal list | add | update | pause | resume | retire
araya hoot settings show | set
araya hoot runs [--limit N]
araya hoot reset-schedule
```

`dataDir` は `araya` と同じ設定源（`ARAYA_DATA_DIR` / config file）を使う。bot process の起動・停止はしない。bot は次の tick（既定 60 秒以内）から新しい settings を読む。

## P0 でやらないこと

- 作業の実行（dispatch）。`investigate` / `dispatch` は **提案の記録** にとどめる（`mode: dry_run`）。`mode=active` は dispatch mechanism を実装するまで拒否する。
- Issue label・webhook・Discord 反応などの event-driven wakeup。current 実装は interval schedule だけ。
- task 台帳・runner・worktree 作成・PR 作成。session-first 構成では work の unit は Pi durable の named child conversation であり、HOOT の record と child session を結ぶ layer はまだ無い。
- state への SQLite 採用（`state.json` + lock）。
- 外部 source 監視（GitHub 以外）。

## 失敗と停止

- bot process の shutdown では HOOT loop を stop してから gateway と agent session を閉じる（待機の上限 20 秒）。実行中の判断 run があっても打ち切らず、完了を待つ。
- 失敗時は run を記録せず、`consecutiveFailures` を 1 増やして `failureCooldownUntil = now + tickMinutes` を state に書き、その間 tick は `failure_cooldown` で終わる。
- `araya hoot reset-schedule` は schedule だけ戻す（run 記録と settings は保つ）。

## model 呼び出しの bound

enabled=false・active goal なし・occurrence 前・cooldown 中・daily limit 超過では model を呼ばない。occurrence の重複実行もしない。1 occurrence の model 呼び出しは submit 1 回まで（`whenBusy: 'reject'`、tool loop 走らない）。観測は model を呼ばない deterministic code だけ。
