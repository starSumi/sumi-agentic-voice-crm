// Protected GitHub workflow jobs must not checkout or execute repository code.
// Keep package-manager spellings explicit so pnpm cannot slip through a
// compact-but-incorrect character class.
export const REPOSITORY_CODE_EXECUTION = /actions\/checkout|\b(?:npm|pnpm)\s|node\s+scripts\//;

export function containsRepositoryCodeExecution(source) {
  return REPOSITORY_CODE_EXECUTION.test(source);
}
