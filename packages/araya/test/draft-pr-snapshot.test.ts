import assert from 'node:assert/strict'
import test from 'node:test'

import { hashGitDiffSnapshot, splitGitDiffSections } from '../src/draft-pr-snapshot.ts'

test('snapshot digest ignores Git patch metadata but includes file identity, modes and content', () => {
  const evidenceDiff = [
    'diff --git a/"added.txt" b/"added.txt"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/"added.txt"',
    '@@ -0,0 +1,1 @@',
    '+new-file',
    '\\ No newline at end of file',
    ''
  ].join('\n')
  const stagedDiff = [
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    'index 0000000..aabbccd',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1,1 @@',
    '+new-file',
    '\\ No newline at end of file',
    ''
  ].join('\n')
  const evidenceSections = splitGitDiffSections(evidenceDiff)
  const stagedSections = splitGitDiffSections(stagedDiff)

  assert.ok(evidenceSections)
  assert.ok(stagedSections)
  assert.equal(hashGitDiffSnapshot(['added.txt'], evidenceSections), hashGitDiffSnapshot(['added.txt'], stagedSections))
  assert.notEqual(hashGitDiffSnapshot(['added.txt'], evidenceSections), hashGitDiffSnapshot(['added.txt'], stagedSections.map((section) => {
    return section.replace('+new-file', '+other-file')
  })))
  assert.notEqual(hashGitDiffSnapshot(['added.txt'], evidenceSections), hashGitDiffSnapshot(['other.txt'], stagedSections))
  assert.notEqual(hashGitDiffSnapshot(['added.txt'], evidenceSections), hashGitDiffSnapshot(['added.txt'], stagedSections.map((section) => {
    return section.replace('@@ -0,0 +1,1 @@', '@@ -0,0 +2,1 @@')
  })))
})

test('snapshot digest retains hunk content that resembles a Git file header', () => {
  const evidenceDiff = [
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1,1 @@',
    '+++ approved content',
    ''
  ].join('\n')
  const changedDiff = evidenceDiff.replace('+++ approved content', '+++ altered content')
  const evidenceSections = splitGitDiffSections(evidenceDiff)
  const changedSections = splitGitDiffSections(changedDiff)

  assert.ok(evidenceSections)
  assert.ok(changedSections)
  assert.notEqual(hashGitDiffSnapshot(['added.txt'], evidenceSections), hashGitDiffSnapshot(['added.txt'], changedSections))
})
