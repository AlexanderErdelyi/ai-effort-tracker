import * as fs from 'fs';
import * as path from 'path';
import type { TrackingMode } from '../trackers/timeTracker';
import type { FileCategory } from '../util/fileTypes';

export interface LineStats {
  added: number;
  deleted: number;
}

export interface ExtStats {
  human: LineStats;
  ai: LineStats;
}

export interface BranchSummary {
  branch: string;
  workItemId: string | null;
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  idleMs: number;
  // Aggregated line totals
  linesHumanAdded: number;
  linesHumanDeleted: number;
  linesAiAdded: number;
  linesAiDeleted: number;
  copilotAcceptances: number;
  estimatedCostUsd: number;
  // Breakdown by file extension: { "al": { human: {...}, ai: {...} }, ... }
  byExt: Record<string, ExtStats>;
  // Breakdown by category (code/spec/config/other)
  byCategory: Record<FileCategory, { human: LineStats; ai: LineStats }>;
}

interface BranchData {
  workItemId: string | null;
  time: Record<TrackingMode, number>;
  copilotAcceptances: number;
  // line changes keyed by ext → source → { added, deleted }
  lineChanges: Record<string, { human: LineStats; ai: LineStats }>;
}

type Store = Record<string, BranchData>;

const COST_PER_AI_LINE_USD = 0.00003;

export class Database {
  private filePath: string;
  private store: Store;

  constructor(storagePath: string) {
    fs.mkdirSync(storagePath, { recursive: true });
    this.filePath = path.join(storagePath, 'effort-tracker.json');
    this.store = this.load();
  }

  private load(): Store {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  private save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  private ensureBranch(branch: string): BranchData {
    if (!this.store[branch]) {
      this.store[branch] = {
        workItemId: null,
        time: { humanCoding: 0, aiGenerating: 0, reviewing: 0, idle: 0 },
        copilotAcceptances: 0,
        lineChanges: {}
      };
    }
    // Migrate old records missing lineChanges
    if (!this.store[branch].lineChanges) {
      this.store[branch].lineChanges = {};
    }
    return this.store[branch];
  }

  recordTime(branch: string, mode: TrackingMode, durationMs: number) {
    const data = this.ensureBranch(branch);
    data.time[mode] = (data.time[mode] ?? 0) + durationMs;
    this.save();
  }

  recordLineChange(
    branch: string,
    ext: string,
    source: 'human' | 'ai',
    linesAdded: number,
    linesDeleted: number
  ) {
    const data = this.ensureBranch(branch);
    if (!data.lineChanges[ext]) {
      data.lineChanges[ext] = { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } };
    }
    data.lineChanges[ext][source].added += linesAdded;
    data.lineChanges[ext][source].deleted += linesDeleted;

    if (source === 'ai') {
      data.copilotAcceptances += 1;
    }
    this.save();
  }

  setWorkItemForBranch(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    data.workItemId = workItemId;
    this.save();
  }

  getSummaryForBranch(branch: string): BranchSummary {
    const data = this.ensureBranch(branch);
    const { categorizeExt } = require('../util/fileTypes');

    let linesHumanAdded = 0, linesHumanDeleted = 0;
    let linesAiAdded = 0, linesAiDeleted = 0;
    const byCategory: Record<FileCategory, { human: LineStats; ai: LineStats }> = {
      code: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      spec: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      config: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } },
      other: { human: { added: 0, deleted: 0 }, ai: { added: 0, deleted: 0 } }
    };

    for (const [ext, stats] of Object.entries(data.lineChanges)) {
      linesHumanAdded += stats.human.added;
      linesHumanDeleted += stats.human.deleted;
      linesAiAdded += stats.ai.added;
      linesAiDeleted += stats.ai.deleted;

      const cat: FileCategory = categorizeExt(ext);
      byCategory[cat].human.added += stats.human.added;
      byCategory[cat].human.deleted += stats.human.deleted;
      byCategory[cat].ai.added += stats.ai.added;
      byCategory[cat].ai.deleted += stats.ai.deleted;
    }

    return {
      branch,
      workItemId: data.workItemId,
      humanCodingMs: data.time.humanCoding ?? 0,
      aiGeneratingMs: data.time.aiGenerating ?? 0,
      reviewingMs: data.time.reviewing ?? 0,
      idleMs: data.time.idle ?? 0,
      linesHumanAdded,
      linesHumanDeleted,
      linesAiAdded,
      linesAiDeleted,
      copilotAcceptances: data.copilotAcceptances,
      estimatedCostUsd: linesAiAdded * COST_PER_AI_LINE_USD,
      byExt: data.lineChanges,
      byCategory
    };
  }

  getAllBranches(): string[] {
    return Object.keys(this.store).sort();
  }

  getAllBranchesSummaries(): BranchSummary[] {
    return this.getAllBranches().map(b => this.getSummaryForBranch(b));
  }
}
