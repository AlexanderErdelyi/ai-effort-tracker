import * as vscode from 'vscode';
import { categorizeExtWith, categorizeWith, sanitizeRules, type CategoryRules, type FileCategory } from './categoryRules';

export * from './categoryRules';

/** Read user-configured rules from settings (best effort). */
export function readUserRules(legacyDefaults = false): CategoryRules {
  try {
    const cfg = vscode.workspace.getConfiguration('aiEffortTracker');
    return sanitizeRules({
      extensions: cfg.get<Record<string, string>>('categoryRules.extensions') ?? {},
      folders: cfg.get<Record<string, string>>('categoryRules.folders') ?? {}
    }, legacyDefaults);
  } catch {
    return { extensions: {}, folders: {} };
  }
}

/** Categorize by extension only (built-in defaults + user extension rules). */
export function categorizeExt(ext: string): FileCategory {
  return categorizeExtWith(ext, readUserRules());
}

/**
 * Path-aware categorization. Folder rules take precedence over extension rules,
 * and user rules take precedence over built-in defaults.
 * legacyDefaults reproduces pre-translation classification for stored counters
 * that predate per-file category attribution.
 */
export function categorize(filePath: string, legacyDefaults = false): FileCategory {
  return categorizeWith(filePath, readUserRules(legacyDefaults), legacyDefaults);
}
