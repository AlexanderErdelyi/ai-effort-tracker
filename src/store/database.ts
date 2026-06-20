import * as fs from 'fs';
import * as path from 'path';
import type { TrackingMode } from '../trackers/timeTracker';

export interface BranchSummary {
  branch: string;
  workItemId: string | null;
  humanCodingMs: number;
  aiGeneratingMs: number;
  reviewingMs: number;
  idleMs: number;
  linesHuman: number;
  linesAi: number;
  copilotAcceptances: number;
  estimatedCostUsd: number;
}

interface BranchData {
  workItemId: string | null;
  time: Record<TrackingMode, number>; // accumulated ms per mode
  linesAi: number;
  copilotAcceptances: number;
}

type Store = Record<string, BranchData>;

// Rough cost estimate: ~$0.00003 per accepted AI line (conservative Copilot proxy)
const COST_PER_AI_LINE_USD = 0.00003;
// Rough human lines estimate: ~20 lines/minute of active coding
const HUMAN_LINES_PER_MIN = 20;

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
        linesAi: 0,
        copilotAcceptances: 0
      };
    }
    return this.store[branch];
  }

  recordTime(branch: string, mode: TrackingMode, durationMs: number) {
    const data = this.ensureBranch(branch);
    data.time[mode] = (data.time[mode] ?? 0) + durationMs;
    this.save();
  }

  recordCopilotAcceptance(branch: string, linesAdded: number) {
    const data = this.ensureBranch(branch);
    data.linesAi += linesAdded;
    data.copilotAcceptances += 1;
    this.save();
  }

  setWorkItemForBranch(branch: string, workItemId: string) {
    const data = this.ensureBranch(branch);
    data.workItemId = workItemId;
    this.save();
  }

  getSummaryForBranch(branch: string): BranchSummary {
    const data = this.ensureBranch(branch);
    const humanCodingMs = data.time.humanCoding ?? 0;
    const linesHuman = Math.round((humanCodingMs / 60000) * HUMAN_LINES_PER_MIN);

    return {
      branch,
      workItemId: data.workItemId,
      humanCodingMs,
      aiGeneratingMs: data.time.aiGenerating ?? 0,
      reviewingMs: data.time.reviewing ?? 0,
      idleMs: data.time.idle ?? 0,
      linesHuman,
      linesAi: data.linesAi,
      copilotAcceptances: data.copilotAcceptances,
      estimatedCostUsd: data.linesAi * COST_PER_AI_LINE_USD
    };
  }

  getAllBranches(): string[] {
    return Object.keys(this.store).sort();
  }
}
