import assert from 'node:assert/strict'
import test from 'node:test'

import { collectSecretValues, createRedactor, isSecretEnvName, REDACTED } from '../src/infrastructure/redaction.ts'

test('redaction: 名前を大文字にして決まった語を含む環境変数を秘密とみなし、SSH_AUTH_SOCK は除く', () => {
  for (const name of [
    'GITHUB_TOKEN',
    'client_secret',
    'DB_PASSWORD',
    'MY_PASSWD',
    'OPENAI_API_KEY',
    'SERVICE_APIKEY',
    'SSH_PRIVATE_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'X_AUTH',
    // 仕様の規則どおり、AUTH を含む普通の名前も当たる
    'GIT_AUTHOR_NAME'
  ]) {
    assert.equal(isSecretEnvName(name), true, name)
  }

  for (const name of ['SSH_AUTH_SOCK', 'ssh_auth_sock', 'PATH', 'HOME', 'ARAYA_DATA_DIR', 'LANG']) {
    assert.equal(isSecretEnvName(name), false, name)
  }
})

test('redaction: 8 文字以上の値だけを、重複を除いて長い順に集める', () => {
  const values = collectSecretValues({
    SHORT_TOKEN: '1234567',
    A_TOKEN: '12345678',
    B_SECRET: 'abcdefghijkl',
    C_SECRET: 'abcdefghijkl',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
    PATH: '/usr/bin:/bin',
    EMPTY_TOKEN: undefined
  })

  assert.deepEqual(values, ['abcdefghijkl', '12345678'])
})

test('redaction: 値と URL の userinfo を置き換えて回数を数え、object の key は変えない', () => {
  const redactor = createRedactor(['secret-value-1', 'secret-value-123'])

  assert.equal(redactor.redact('a secret-value-123 b secret-value-1'), `a ${REDACTED} b ${REDACTED}`)
  assert.equal(redactor.count, 2)

  assert.equal(
    redactor.redact('clone https://user:pass@example.invalid/repo.git and ssh://git@example.invalid'),
    `clone https://${REDACTED}@example.invalid/repo.git and ssh://${REDACTED}@example.invalid`
  )
  assert.equal(redactor.count, 4)

  // 既に置き換えた userinfo は数え直さない
  assert.equal(redactor.redact(`https://${REDACTED}@example.invalid`), `https://${REDACTED}@example.invalid`)
  assert.equal(redactor.count, 4)

  assert.deepEqual(
    redactor.redactDeep({ 'secret-value-1': ['x secret-value-1', 3, null, { nested: 'secret-value-1' }], flag: true }),
    { 'secret-value-1': [`x ${REDACTED}`, 3, null, { nested: REDACTED }], flag: true }
  )
  assert.equal(redactor.count, 6)
})

test('redaction: 秘密の値が userinfo の中にあっても残らない', () => {
  const redactor = createRedactor(['token-abcdefgh'])
  const redacted = redactor.redact('https://x-access-token:token-abcdefgh@github.example/repo')

  assert.equal(redacted, `https://${REDACTED}@github.example/repo`)
  assert.equal(redacted.includes('token-abcdefgh'), false)
})

test('redaction: 末尾を切った文字列は、末尾の秘密の値の先頭の部分（最も長いもの）と、末尾の <scheme>:// の後を置き換え、回数を数える', () => {
  const redactor = createRedactor(['Zq8kW3mX9pL2vN7r', 'other-secret-12345'])

  assert.equal(redactor.redactTruncated('diff line Zq8kW3', 'end'), `diff line ${REDACTED}`)
  assert.equal(redactor.count, 1)
  // 1 文字でも置き換える
  assert.equal(redactor.redactTruncated('a line Z', 'end'), `a line ${REDACTED}`)
  assert.equal(redactor.count, 2)
  assert.equal(redactor.redactTruncated('clone https://user:pa', 'end'), `clone https://${REDACTED}`)
  assert.equal(redactor.count, 3)
  assert.equal(redactor.redactTruncated('clone ssh://git', 'end'), `clone ssh://${REDACTED}`)
  assert.equal(redactor.count, 4)
  // 境界に当たらなければ、通常の置き換えだけを行う
  assert.equal(
    redactor.redactTruncated('Zq8kW3mX9pL2vN7r and https://user:pass@example.invalid/repo.git and https://example.invalid/x', 'end'),
    `${REDACTED} and https://${REDACTED}@example.invalid/repo.git and https://example.invalid/x`
  )
  assert.equal(redactor.count, 6)
  assert.equal(redactor.redactTruncated('nothing here', 'end'), 'nothing here')
  assert.equal(redactor.count, 6)
})

test('redaction: 先頭を切った文字列は、先頭の秘密の値の末尾の部分（最も長いもの）と、先頭から最初の @ までを置き換え、回数を数える', () => {
  const redactor = createRedactor(['Zq8kW3mX9pL2vN7r', 'other-secret-12345'])

  assert.equal(redactor.redactTruncated('L2vN7r remains', 'start'), `${REDACTED} remains`)
  assert.equal(redactor.count, 1)
  assert.equal(redactor.redactTruncated('r remains', 'start'), `${REDACTED} remains`)
  assert.equal(redactor.count, 2)
  assert.equal(redactor.redactTruncated('er:pass@example.invalid/repo.git', 'start'), `${REDACTED}@example.invalid/repo.git`)
  assert.equal(redactor.count, 3)
  // 先頭から @ までに空白か / があれば、userinfo の一部ではない
  assert.equal(redactor.redactTruncated('see mail@example.invalid', 'start'), 'see mail@example.invalid')
  assert.equal(redactor.redactTruncated('a/b@example.invalid', 'start'), 'a/b@example.invalid')
  assert.equal(redactor.count, 3)
  // 先頭の文字の途中で切れた置換文字は、境界の一部として扱う
  assert.equal(redactor.redactTruncated('��vN7r remains', 'start'), `${REDACTED} remains`)
  assert.equal(redactor.count, 4)
})

test('redaction: 境界は通常の置き換えより先に置き換えるので、短い秘密の値が長い秘密の値の一部に当たっても断片が残らない', () => {
  const redactor = createRedactor(['abcdefgh12345678', 'abcdefgh', '12345678'])

  // 先に通常の置き換えをすると abcdefgh だけが置き換わり、1234 が残る
  assert.equal(redactor.redactTruncated('xx abcdefgh1234', 'end'), `xx ${REDACTED}`)
  assert.equal(redactor.count, 1)
  // 先に通常の置き換えをすると 12345678 だけが置き換わり、gh が残る
  assert.equal(redactor.redactTruncated('gh12345678 yy', 'start'), `${REDACTED} yy`)
  assert.equal(redactor.count, 2)
})

test('redaction: redact は切っていない文字列として扱い、境界の部分を置き換えない', () => {
  const redactor = createRedactor(['Zq8kW3mX9pL2vN7r'])

  assert.equal(redactor.redact('L2vN7r and Zq8kW3'), 'L2vN7r and Zq8kW3')
  assert.equal(redactor.redact('er:pass@example.invalid and https://user:pa'), 'er:pass@example.invalid and https://user:pa')
  assert.equal(redactor.count, 0)
})

// 比較用: 走査に置き換える前の正規表現による URL の userinfo の置き換え（短い入力なら速い）
const REGEX_URL_USERINFO_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]+)@/gu

function redactUserinfoByRegex(text: string) {
  let count = 0
  const result = text.replaceAll(REGEX_URL_USERINFO_PATTERN, (match: string, scheme: string, userinfo: string) => {
    if (userinfo === REDACTED) {
      return match
    }

    count += 1

    return `${scheme}${REDACTED}@`
  })

  return { text: result, count }
}

function redactUserinfoByRedactor(text: string) {
  const redactor = createRedactor([])
  const result = redactor.redact(text)

  return { text: result, count: redactor.count }
}

// 固定の seed の擬似乱数（mulberry32）
function createRandom(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const RANDOM_PIECES = [
  'a', 'x', 'Z', 'h', ':', '/', '@', ' ', '?', '#', '.', '+', '-', '1', '9', '\n', '\t',
  'é', 'あ', '\u3000', '😀', '://', '://', 'https://', REDACTED, `${REDACTED}@`
] as const

test('redaction: URL の userinfo の置き換えは、境界の例とランダムな文字列で、前の正規表現と同じ文字列と回数になる', () => {
  const edgeCases = [
    'https://u@h',
    'https://u@v@h/p',
    'https://u:p@h/p?q=a@b#c@d',
    '1abc://u@h',
    'a://b://c@d',
    '://u@h',
    'x://@h',
    'x://@@h',
    'x://',
    'https://',
    'https://user',
    '+-.://u@h',
    '1+a.b-c://u@h',
    'a:://u@h',
    'a://u @h',
    'a://u/@h',
    'a://u?@h',
    'a://u#@h',
    'a://u\u3000@h',
    'a://あ@h',
    'a://😀@h',
    `a://${REDACTED}@h`,
    `a://${REDACTED}@b@h`,
    'a://u@h a://v@h\nb://w@x@y',
    'a://u@b://v@h',
    'a://u@h://v@w',
    'é://u@h',
    ''
  ]

  for (const text of edgeCases) {
    assert.deepEqual(redactUserinfoByRedactor(text), redactUserinfoByRegex(text), JSON.stringify(text))
  }

  const random = createRandom(20261024)

  for (let index = 0; index < 20000; index += 1) {
    const pieces = Math.floor(random() * 30)
    let text = ''

    for (let piece = 0; piece < pieces; piece += 1) {
      text += RANDOM_PIECES[Math.floor(random() * RANDOM_PIECES.length)]
    }

    assert.deepEqual(redactUserinfoByRedactor(text), redactUserinfoByRegex(text), JSON.stringify(text))
  }
})

test('redaction: 区切りの無い長い文字列でも、URL の userinfo の置き換えは入力の長さに比例する時間で終わる', () => {
  const size = 256 * 1024
  const inputs = [
    'x'.repeat(size),
    `https://${'x'.repeat(size)}`,
    'a://'.repeat(size / 4),
    `${'x'.repeat(size)}://u@h`,
    `https://${'@'.repeat(size)}`,
    `https://${':'.repeat(size)}`
  ]

  const slow: string[] = []

  for (const text of inputs) {
    // 切った文字列の境界の置き換えも、同じ入力で確かめる
    for (const cut of [undefined, 'start', 'end'] as const) {
      const redactor = createRedactor(['Zq8kW3mX9pL2vN7r'])
      const started = performance.now()

      if (cut === undefined) {
        redactor.redact(text)
      } else {
        redactor.redactTruncated(text, cut)
      }

      const elapsed = performance.now() - started

      if (elapsed >= 2000) {
        slow.push(`${cut ?? 'redact'}: ${JSON.stringify(text.slice(0, 16))}… (${text.length} 文字) に ${Math.round(elapsed)} ms かかった`)
      }
    }
  }

  assert.deepEqual(slow, [])
})
