export const DISCORD_TEST_NOW_MS = Date.UTC(2026, 10, 23, 12, 0, 0)

const DISCORD_EPOCH_MS = 1_420_070_400_000

// Discord snowflake を作る。ageMs 前に投稿された id にする。
export function messageIdAtAge(ageMs: number, nowMs: number = DISCORD_TEST_NOW_MS) {
  const timestampMs = nowMs - ageMs - DISCORD_EPOCH_MS

  return String((BigInt(timestampMs) << 22n) + 1n)
}
