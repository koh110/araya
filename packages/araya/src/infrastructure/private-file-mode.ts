// log file の mode を docs の約束（file 0600 / 親 directory 0700）に実側で整える helper。
// fs.appendFileSync も systemd の StandardError=append: も、file を新規作成するとき process の umask を
// 引いた mode を使うだけで既存 file の mode は変えない（実測 0664）。「mode 0600」を名前の約束でなく
// 実側の値にするには、作成時と既存の両方で mode を確かめて chmod する必要がある（here の ensurePrivateLogFile）。
// 失敗を throw せず outcome で返す: log が整えられないことは bot の起動・install の続行を止める理由にしない

import fs from 'node:fs/promises'
import path from 'node:path'

export const PRIVATE_LOG_DIRECTORY_MODE = 0o700
export const PRIVATE_LOG_FILE_MODE = 0o600

export type PrivateLogFileOutcome =
  | { ok: true; filePath: string }
  | { ok: false; filePath: string; message: string }

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function failure(filePath: string, error: unknown, context: string): PrivateLogFileOutcome {
  const message = error instanceof Error ? error.message : String(error)

  return { ok: false, filePath, message: `${context}: ${message}` }
}

// mode は permission bit だけ見る（setuid 等はこの約束の外）
async function modeOf(filePath: string) {
  const stat = await fs.stat(filePath)

  return stat.mode & 0o777
}

// directory を 0700 で用意する。mkdir の mode は umask で絞られ、既存 directory はそのまま残るので
// 違った mode（0755 など）は chmod で整える
async function ensurePrivateDirectory(directory: string): Promise<PrivateLogFileOutcome> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_LOG_DIRECTORY_MODE })

    if ((await modeOf(directory)) !== PRIVATE_LOG_DIRECTORY_MODE) {
      await fs.chmod(directory, PRIVATE_LOG_DIRECTORY_MODE)
    }
  } catch (error) {
    return failure(directory, error, 'logs directory を 0700 にできない')
  }

  return { ok: true, filePath: directory }
}

// filePath の親 directory を 0700 で作り、file が無ければ 0600 で作り、既存 file の mode が 0600 でなければ
// 0600 に変える。本文は読まない・空にしない
export async function ensurePrivateLogFile(filePath: string): Promise<PrivateLogFileOutcome> {
  const directory = path.dirname(filePath)
  const directoryOutcome = await ensurePrivateDirectory(directory)

  if (!directoryOutcome.ok) {
    return directoryOutcome
  }

  try {
    try {
      // wx で新規作成（既存 file を空にしない）。同時に作られたら EEXIST を拾って下の mode 確認に進む
      const handle = await fs.open(filePath, 'wx', PRIVATE_LOG_FILE_MODE)

      await handle.close()
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }

    const stat = await fs.stat(filePath)

    if (!stat.isFile()) {
      throw new Error(`${filePath} は regular file ではありません`)
    }

    // 新規 file も umask で 0600 未満になりうるし、既存 file の mode は作成時の値がそのまま残る
    // （systemd の append: が作った 0664 など）。両方 here で 0600 にする
    if ((stat.mode & 0o777) !== PRIVATE_LOG_FILE_MODE) {
      await fs.chmod(filePath, PRIVATE_LOG_FILE_MODE)
    }
  } catch (error) {
    return failure(filePath, error, 'log file を 0600 にできない')
  }

  return { ok: true, filePath }
}
