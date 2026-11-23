// Discord bot の process lock（issue #37 対応）。
// proper-lockfile の lock は directory だけで所有者情報を残さないため、SIGKILL 後の残留 lock は
// stale（30 s）が切れるまで起動側は ELOCKED を返すだけだった。実測で異常終了後に 20〜40 s 起動できない
// 窓が再現していた（unit の SIGKILL と組み合わさると #36 の無受信窓も伸ばす）。
// ここでは dataDir に owner record（PID と /proc starttime）を書き、「holder が実在しない」かつ
// 「lock が refresh で更新されていない」場合だけ先に回収する。生存 holder の排他は従来どおり保つ。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DISCORD_LOCK_OWNER_FILE_NAME = '.discord-bot.lock-owner.json'

export type DiscordLockOwner = {
  pid: number
  starttime: string | null
  startedAt: string
  hostname: string
}

export type DiscordLockOwnerStatus = 'alive' | 'dead' | 'pid_reused'

export type DiscordLockReclaimReason =
  | 'no_lock'
  | 'no_owner_record'
  | 'owner_alive'
  | 'lock_fresh'
  | 'reclaim_failed'
  | 'reclaimed'
  | 'reclaim_race'

export type DiscordLockReclaim = {
  reason: DiscordLockReclaimReason
  reclaimed: boolean
  ownerPid: number | null
  ownerStatus: DiscordLockOwnerStatus | null
  lockAgeMs: number
}

export function discordLockPath(dataDir: string): string {
  return path.join(dataDir, '.discord-bot.lock')
}

export function discordLockOwnerPath(dataDir: string): string {
  return path.join(dataDir, DISCORD_LOCK_OWNER_FILE_NAME)
}

// /proc/<pid>/stat の starttime（通し番号 22 番目）。PID 再利用で「死んだ PID と同じ番号の別 process」を
// 生存と誤判定しないための材料にする。読めない環境では null（不明として保守的に生存扱い）
function procStarttime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)

    return fields[19] ?? null
  } catch {
    return null
  }
}

export function currentDiscordLockOwner(): DiscordLockOwner {
  return {
    pid: process.pid,
    starttime: procStarttime(process.pid),
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  }
}

export async function writeDiscordLockOwner(dataDir: string, owner: DiscordLockOwner): Promise<void> {
  try {
    await fs.promises.writeFile(discordLockOwnerPath(dataDir), `${JSON.stringify(owner)}\n`, { mode: 0o600 })
  } catch {
    // owner record を書けないだけで起動は止めない。その場合は proper-lockfile の stale 側で回復する
  }
}

export async function removeDiscordLockOwner(dataDir: string): Promise<void> {
  try {
    await fs.promises.rm(discordLockOwnerPath(dataDir), { force: true })
  } catch {
    // 後始末の失敗は終了処理の邪魔をしない
  }
}

async function readDiscordLockOwner(dataDir: string): Promise<DiscordLockOwner | null> {
  let parsed: unknown

  try {
    parsed = JSON.parse(await fs.promises.readFile(discordLockOwnerPath(dataDir), 'utf8')) as unknown
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }

  const record = parsed as Partial<DiscordLockOwner>

  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    return null
  }

  return {
    pid: record.pid,
    starttime: typeof record.starttime === 'string' ? record.starttime : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    hostname: typeof record.hostname === 'string' ? record.hostname : '',
  }
}

export function discordLockOwnerStatus(owner: DiscordLockOwner): DiscordLockOwnerStatus {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined

    // EPERM は「実在するが自分以外の user の process」。存在自体は確か
    return code === 'EPERM' ? 'alive' : 'dead'
  }

  const starttime = procStarttime(owner.pid)

  if (owner.starttime !== null && starttime !== null && starttime !== owner.starttime) {
    return 'pid_reused'
  }

  return 'alive'
}

// 残留 lock を回収できるか確かめて、できるなら削除する。
// minLockAgeMs は「refresh 周期の半分」。生きている holder は update 周期で mtime を更新するので、
// mtime が新しいうちに削除すると生存 holder の lock を奪う可能性がある（PID 判定と 2 重のガード）。
export async function reclaimDeadDiscordProcessLock(
  dataDir: string,
  deps: { nowMs: () => number; minLockAgeMs: number },
): Promise<DiscordLockReclaim> {
  const lockPath = discordLockPath(dataDir)
  let lockAgeMs = 0

  try {
    const stat = await fs.promises.stat(lockPath)
    lockAgeMs = Math.max(0, deps.nowMs() - stat.mtimeMs)
  } catch {
    return { reason: 'no_lock', reclaimed: false, ownerPid: null, ownerStatus: null, lockAgeMs: 0 }
  }

  const owner = await readDiscordLockOwner(dataDir)

  if (owner === null) {
    // owner record を書かない古い build の残留。従来どおり proper-lockfile の stale 判定に任せる
    return { reason: 'no_owner_record', reclaimed: false, ownerPid: null, ownerStatus: null, lockAgeMs }
  }

  const status = discordLockOwnerStatus(owner)

  if (status === 'alive') {
    return { reason: 'owner_alive', reclaimed: false, ownerPid: owner.pid, ownerStatus: status, lockAgeMs }
  }

  if (lockAgeMs < deps.minLockAgeMs) {
    // holder が死んでしばらく経っていない。systemd の RestartSec=1s の次の試行なら回収できるので
    // 今回は拒否する
    return { reason: 'lock_fresh', reclaimed: false, ownerPid: owner.pid, ownerStatus: status, lockAgeMs }
  }

  try {
    await fs.promises.rm(lockPath, { recursive: true, force: true })
  } catch {
    return { reason: 'reclaim_failed', reclaimed: false, ownerPid: owner.pid, ownerStatus: status, lockAgeMs }
  }

  await removeDiscordLockOwner(dataDir)

  return { reason: 'reclaimed', reclaimed: true, ownerPid: owner.pid, ownerStatus: status, lockAgeMs }
}
