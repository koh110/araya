import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import { mainInstructions, workerInstructions } from './host.ts'

// agent の報告規約は conversation の context ではなく code 側の instructions で固定する。
// session だけの記憶にすると restart・new conversation・child session で失われる（2026-11-26 の利用者の指摘）。
test('agent instructions: GitHub の item を報告・判断に載せるときは URL 必須、という rule が code 側にある', () => {
  const main = mainInstructions('/home/testuser/dev')
  const worker = workerInstructions('/home/testuser/dev')

  // main agent session: URL を添える rule が秘密の non-disclosure と同じ developer instructions 層に載る
  assert.match(
    main,
    /GitHub の item（issue・PR・branch・commit・Action の run\/job・issue comment）を報告や判断に載せるときは、必ず URL を添えます/u
  )
  assert.match(main, /番号や key だけにはしません/u)
  assert.match(main, /URL 無しに結論だけ並べません/u)
  assert.ok(
    main.indexOf('必ず URL を添えます') > main.indexOf('応答や child への依頼文に書かない'),
    'URL rule は秘密を書かない rule の直後に置く（同じ「出力の扱い」の block として読める順）'
  )

  // named child session（task worker）の報告にも同じ rule を載せる
  assert.match(worker, /報告に GitHub の issue・PR・branch・commit・Action run\/job を書くときは URL を添えます/u)
  assert.match(worker, /番号や key だけに出さない/u)

  // devRoot は instructions に実値で入る（cwd を model に推測させない）
  assert.match(main, /cwd \/home\/testuser\/dev/u)
  assert.match(worker, /開発 root は \/home\/testuser\/dev/u)
})
