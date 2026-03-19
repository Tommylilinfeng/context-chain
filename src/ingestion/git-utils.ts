/**
 * git-utils.ts
 *
 * Git utilities for change detection.
 * All operations run in the target repo directory, not the CKG directory.
 */

import { execSync } from 'child_process'

/**
 * Get the current HEAD commit hash of a repo.
 */
export function getHeadCommit(repoPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim()
}

/**
 * Get list of files changed between two commits (or since a commit to HEAD).
 * Returns relative paths.
 */
export function getChangedFiles(repoPath: string, sinceCommit: string): string[] {
  try {
    const output = execSync(
      `git diff --name-only ${sinceCommit} HEAD`,
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim()
    return output ? output.split('\n') : []
  } catch {
    // If sinceCommit doesn't exist (e.g. first run), treat everything as changed
    return ['__ALL__']
  }
}

/**
 * Get list of staged files (git add'd but not committed).
 * These are the files the user has explicitly marked as ready.
 */
export function getStagedFiles(repoPath: string): string[] {
  try {
    const output = execSync(
      'git diff --cached --name-only',
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim()
    return output ? output.split('\n') : []
  } catch {
    return []
  }
}

/**
 * Check if a specific file has changed since a given commit.
 */
export function hasFileChanged(repoPath: string, sinceCommit: string, filePath: string): boolean {
  try {
    const output = execSync(
      `git diff --name-only ${sinceCommit} HEAD -- ${filePath}`,
      { cwd: repoPath, encoding: 'utf-8' }
    ).trim()
    return output.length > 0
  } catch {
    return true  // assume changed if we can't tell
  }
}
