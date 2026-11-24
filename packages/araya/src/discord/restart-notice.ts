// Issue #36: デプロイ再起動で message を受信できていなかった期間（実測 ~67 秒）をユーザーに可視化する通知。
// 通知は停止と復旧の合図であり、その間に届いたメッセージの保持・再取得は行わない（backfill は別途）。
// 投稿失敗は restart も bot 稼働も止めない。本文に token や会話 content を含めない。

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10'
const NOTICE_TIMEOUT_MS = 5000

export const RESTART_STOPPING_TEXT =
  '再起動します。完了までの間に投稿されたメッセージは届かないことがあります。'
export const RESTART_STARTED_TEXT = '再起動しました。'
export const BOT_STARTED_TEXT = '起動しました。'

// 前回 ready の記録（state.json の lastReadyAt）があれば再起動、無ければ初めての起動
export function discordRestartStartedText(previousLastReadyAt: string | null) {
  return previousLastReadyAt === null ? BOT_STARTED_TEXT : RESTART_STARTED_TEXT
}

export type RestartNoticeFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean }>

export type DiscordRestartNoticeDeps = {
  botToken: string
  channelId: string
  text: string
  // test 用。既定は global fetch
  fetchImpl?: RestartNoticeFetch
}

// 指定 channel に通知を 1 件投稿する。成否だけを返し、誤りは throw しない
export async function postDiscordRestartNotice(deps: DiscordRestartNoticeDeps): Promise<boolean> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      `${DISCORD_API_BASE_URL}/channels/${deps.channelId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${deps.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: deps.text }),
        signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
      },
    )

    return response.ok
  } catch {
    return false
  }
}
