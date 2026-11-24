// #36: stop signal を 1 回だけ受け取る想定（process.once）だと、2 回目以降の signal は node の default
// 動作で process が即 terminate する。systemd は unit の control group 全体へ SIGTERM を送り、runner は
// 自分の child へ SIGTERM を forward するので、bot process には同じ signal が 2 回届くのが normal である。
// 2 回目も無視して bot 自身の shutdown budget に drain を終わらせるために、listener を張り続ける。

export type ShutdownSignalTarget = {
  on: (signal: NodeJS.Signals, handler: () => void) => unknown
}

export function installShutdownSignals(target: ShutdownSignalTarget, abort: () => void) {
  let requested = false

  function requestStop() {
    // 2 回目以降の SIGTERM / SIGINT は無視する（drain の途中で default 動作で死なない）
    if (requested) {
      return
    }

    requested = true
    abort()
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    target.on(signal, requestStop)
  }

  return {
    stopRequested: () => {
      return requested
    },
  }
}
