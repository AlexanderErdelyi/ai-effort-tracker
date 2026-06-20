export type FileCategory = 'code' | 'spec' | 'config' | 'other';

const CODE_EXTS = new Set([
  'al', 'ts', 'tsx', 'js', 'jsx', 'cs', 'py', 'java', 'go', 'rs', 'cpp', 'c',
  'h', 'hpp', 'rb', 'php', 'swift', 'kt', 'dart', 'lua', 'r', 'sql', 'sh',
  'ps1', 'psm1', 'vb', 'fs', 'fsx', 'scala', 'ex', 'exs', 'elm', 'clj'
]);

const SPEC_EXTS = new Set([
  'md', 'txt', 'rst', 'adoc', 'doc', 'docx', 'pdf'
]);

const CONFIG_EXTS = new Set([
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env', 'config',
  'csproj', 'sln', 'props', 'targets', 'editorconfig', 'gitignore',
  'dockerfile', 'lock'
]);

export function getFileExt(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'unknown';
}

export function categorizeExt(ext: string): FileCategory {
  if (CODE_EXTS.has(ext)) return 'code';
  if (SPEC_EXTS.has(ext)) return 'spec';
  if (CONFIG_EXTS.has(ext)) return 'config';
  return 'other';
}

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  code: '💻 Code',
  spec: '📄 Spec/Docs',
  config: '⚙️ Config',
  other: '📦 Other'
};
