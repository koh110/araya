// 秘密とみなす環境変数の値と URL の userinfo を置き換える。台帳、evidence.json、log、CLI の stderr に書く前に使う

export const REDACTED = '[REDACTED]'

const SECRET_NAME_PARTS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'CREDENTIAL', 'AUTH']
const MIN_SECRET_VALUE_CHARS = 8
// <scheme>://<userinfo>@ の <userinfo>。scheme の規則は RFC 3986。<userinfo> は空白・/・?・# の手前までの最後の @ まで
const URL_SEPARATOR = '://'
const USERINFO_END_PATTERN = /[\s/?#]/u
// 先頭を切った文字列の、先頭から最初の @ まで（空白と / を含まない）
const CUT_START_USERINFO_PATTERN = /^([^\s/@]+)@/u
// 末尾を切った文字列の、最後の :// の後（空白・/・@ を含まない）と、その前の scheme
const CUT_END_FORBIDDEN_PATTERN = /[\s/@]/u
const SCHEME_CHAR_PATTERN = /[A-Za-z0-9+.-]/u
const SCHEME_LETTER_PATTERN = /[A-Za-z]/u
// 先頭の文字の途中で切った byte 列を decode したときの置換文字
const REPLACEMENT_CHAR = '\uFFFD'
const MAX_UTF8_CONTINUATION_BYTES = 3

// 元の文字列のどちら側を切ったか。start は先頭を切った（末尾だけを持つ）、end は末尾を切った（先頭だけを持つ）
export type CutSide = 'start' | 'end'

// 名前を大文字にしたときに決まった語を含めば秘密とみなす。SSH_AUTH_SOCK は socket の path なので除く
export function isSecretEnvName(name: string) {
  const upper = name.toUpperCase()

  if (upper === 'SSH_AUTH_SOCK') {
    return false
  }

  return SECRET_NAME_PARTS.some((part) => {
    return upper.includes(part)
  })
}

// 秘密とみなす環境変数の値を、重複を除いて長い順に返す。短い値は普通の語と重なりやすいので置き換えない
export function collectSecretValues(env: Readonly<Record<string, string | undefined>>) {
  const values = new Set<string>()

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_VALUE_CHARS && isSecretEnvName(name)) {
      values.add(value)
    }
  }

  return [...values].sort((left, right) => {
    return right.length - left.length
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 末尾を切った文字列の末尾の、秘密の値の先頭の部分（1 文字以上）に当たる最も長い長さ
function longestSecretPrefixAtEnd(text: string, values: readonly string[]) {
  let longest = 0

  for (const value of values) {
    for (let length = Math.min(value.length, text.length); length > longest; length -= 1) {
      if (text.endsWith(value.slice(0, length))) {
        longest = length
        break
      }
    }
  }

  return longest
}

// 先頭を切った文字列の先頭の、秘密の値の末尾の部分（1 文字以上）に当たる最も長い長さ
function longestSecretSuffixAtStart(text: string, values: readonly string[]) {
  let longest = 0

  for (const value of values) {
    for (let length = Math.min(value.length, text.length); length > longest; length -= 1) {
      if (text.startsWith(value.slice(value.length - length))) {
        longest = length
        break
      }
    }
  }

  return longest
}

// 末尾が <scheme>:// の後に空白・/・@ の無い文字列で終わっていれば、:// の後の位置を返す。
// 正規表現の後方の探索は長い英数字の並びで遅くなるので、最後の :// から確かめる
function cutUrlStartAtEnd(text: string) {
  const separator = text.lastIndexOf('://')

  if (separator === -1) {
    return -1
  }

  const after = text.slice(separator + 3)

  if (after === '' || after === REDACTED || CUT_END_FORBIDDEN_PATTERN.test(after)) {
    return -1
  }

  let schemeStart = separator

  while (schemeStart > 0 && SCHEME_CHAR_PATTERN.test(text.charAt(schemeStart - 1))) {
    schemeStart -= 1
  }

  return SCHEME_LETTER_PATTERN.test(text.slice(schemeStart, separator)) ? separator + 3 : -1
}

// :// の前の scheme の始まりを返す。前へ scheme の文字が続く限り戻り、そこから最初の英字までを飛ばす。英字が無ければ -1
function schemeStartBefore(text: string, separator: number) {
  let start = separator

  while (start > 0 && SCHEME_CHAR_PATTERN.test(text.charAt(start - 1))) {
    start -= 1
  }

  while (start < separator && !SCHEME_LETTER_PATTERN.test(text.charAt(start))) {
    start += 1
  }

  return start < separator ? start : -1
}

// :// の後の <userinfo> の後の @ の位置を返す。空白・/・?・# の手前（または末尾）までの最後の @ で、<userinfo> が空なら -1
function userinfoEndAfter(text: string, separator: number) {
  const start = separator + URL_SEPARATOR.length
  let at = -1

  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index)

    if (USERINFO_END_PATTERN.test(char)) {
      break
    }

    if (char === '@') {
      at = index
    }
  }

  return at > start ? at : -1
}

export type Redactor = ReturnType<typeof createRedactor>

// 置き換えた回数を数える。値は長い順に置き換え、最後に URL の userinfo を置き換える
export function createRedactor(secretValues: readonly string[]) {
  const values = [...secretValues].sort((left, right) => {
    return right.length - left.length
  })
  let count = 0

  function redact(text: string) {
    let result = text

    for (const value of values) {
      if (value === '') {
        continue
      }

      const parts = result.split(value)

      if (parts.length > 1) {
        count += parts.length - 1
        result = parts.join(REDACTED)
      }
    }

    return redactUrlUserinfo(result)
  }

  // 正規表現は区切りの無い長い文字列で開始位置ごとに末尾まで読み直すので、:// を探して前後を一度ずつ読む
  function redactUrlUserinfo(text: string) {
    let result = ''
    let copied = 0
    let separator = text.indexOf(URL_SEPARATOR)

    while (separator !== -1) {
      const at = schemeStartBefore(text, separator) === -1 ? -1 : userinfoEndAfter(text, separator)

      if (at === -1) {
        separator = text.indexOf(URL_SEPARATOR, separator + 1)
        continue
      }

      const userinfoStart = separator + URL_SEPARATOR.length

      if (text.slice(userinfoStart, at) !== REDACTED) {
        count += 1
        result += `${text.slice(copied, userinfoStart)}${REDACTED}`
        copied = at
      }

      separator = text.indexOf(URL_SEPARATOR, at + 1)
    }

    return copied === 0 ? text : `${result}${text.slice(copied)}`
  }

  // 末尾を切った文字列: 末尾の秘密の値の先頭の部分と、末尾の <scheme>:// の後を置き換える
  function redactCutEnd(text: string) {
    let result = text
    const secretLength = longestSecretPrefixAtEnd(result, values)

    if (secretLength > 0) {
      count += 1
      result = `${result.slice(0, result.length - secretLength)}${REDACTED}`
    }

    const urlStart = cutUrlStartAtEnd(result)

    if (urlStart !== -1) {
      count += 1
      result = `${result.slice(0, urlStart)}${REDACTED}`
    }

    return result
  }

  // 先頭を切った文字列: 先頭の秘密の値の末尾の部分と、先頭から最初の @ までを置き換える。
  // 先頭の文字の途中で切って置換文字になった部分は、境界の一部として扱う
  function redactCutStart(text: string) {
    let lead = 0

    while (lead < MAX_UTF8_CONTINUATION_BYTES && text.charAt(lead) === REPLACEMENT_CHAR) {
      lead += 1
    }

    let result = text
    const secretLength = longestSecretSuffixAtStart(result.slice(lead), values)

    if (secretLength > 0) {
      count += 1
      result = `${REDACTED}${result.slice(lead + secretLength)}`
    }

    const userinfo = CUT_START_USERINFO_PATTERN.exec(result)

    if (userinfo !== null && userinfo[1] !== REDACTED) {
      count += 1
      result = `${REDACTED}${result.slice(userinfo[0].length - 1)}`
    }

    return result
  }

  // 元の文字列の先頭か末尾だけを持つ文字列（上限で切って読んだ本文）を置き換える。切った境界に接する部分を、
  // 通常の置き換えより先に置き換える（後にすると、短い秘密の値が長い秘密の値の一部を先に置き換え、残りの断片が境界に当たらなくなる）
  function redactTruncated(text: string, cut: CutSide) {
    return redact(cut === 'start' ? redactCutStart(text) : redactCutEnd(text))
  }

  // JSON に入る値のすべての文字列を置き換える。object の key は変えない
  function redactDeep(value: unknown): unknown {
    if (typeof value === 'string') {
      return redact(value)
    }

    if (Array.isArray(value)) {
      return value.map((item) => {
        return redactDeep(item)
      })
    }

    if (isPlainObject(value)) {
      return redactRecord(value)
    }

    return value
  }

  function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      return [key, redactDeep(item)]
    }))
  }

  return {
    redact,
    redactTruncated,
    redactDeep,
    redactRecord,
    get count() {
      return count
    }
  }
}
