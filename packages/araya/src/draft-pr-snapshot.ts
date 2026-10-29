import { createHash } from 'node:crypto'

export function splitGitDiffSections(diff: string) {
  const sections: string[] = []
  let current: string[] | null = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) {
        sections.push(current.join('\n'))
      }

      current = [line]
      continue
    }

    if (current !== null) {
      current.push(line)
    } else if (line !== '') {
      return null
    }
  }

  if (current !== null) {
    sections.push(current.join('\n'))
  }

  return sections
}

export function canonicalizeGitDiffSection(section: string) {
  const lines: string[] = []
  let binaryPatch = false
  let inHunk = false

  for (const line of section.split('\n')) {
    if (binaryPatch) {
      lines.push(line)
      continue
    }

    if (line.startsWith('diff --git ')) {
      continue
    }

    if (line === 'GIT binary patch') {
      binaryPatch = true
      lines.push(line)
      continue
    }

    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index '))) {
      continue
    }

    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line)

      if (match === null) {
        return null
      }

      inHunk = true
      lines.push(`@@ -${match[1]},${match[2] ?? '1'} +${match[3]},${match[4] ?? '1'} @@${match[5]}`)
      continue
    }

    if (
      line === '' || line.startsWith('new file mode ') || line.startsWith('deleted file mode ') ||
      line.startsWith('old mode ') || line.startsWith('new mode ') ||
      line === '\\ No newline at end of file' ||
      line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
    ) {
      lines.push(line)
      continue
    }

    return null
  }

  while (lines.at(-1) === '') {
    lines.pop()
  }

  return lines.join('\n')
}

export function hashGitDiffSnapshot(paths: readonly string[], sections: readonly string[]) {
  if (paths.length !== sections.length) {
    return null
  }

  const hash = createHash('sha256')

  for (const [index, changedPath] of paths.entries()) {
    const section = sections[index]

    if (section === undefined) {
      return null
    }

    const canonical = canonicalizeGitDiffSection(section)

    if (canonical === null) {
      return null
    }

    hash.update(changedPath)
      .update('\0')
      .update(canonical)
      .update('\0')
  }

  return hash.digest('hex')
}
