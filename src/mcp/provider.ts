import * as path from 'path';
import * as vscode from 'vscode';

export const MCP_PROVIDER_ID = 'aiEffortTracker.usageInsights';

/** Offer the usage-insights MCP server (read-only except review marks) to VS Code's MCP support (Copilot agent mode). */
export function registerUsageInsightsMcp(context: vscode.ExtensionContext): void {
  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function') return;
  const changed = new vscode.EventEmitter<void>();
  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  const storage = context.globalStorageUri.fsPath;
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiEffortTracker.mcpServer.enabled')) changed.fire();
    }),
    lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        if (!vscode.workspace.getConfiguration('aiEffortTracker').get<boolean>('mcpServer.enabled', true)) return [];
        return [new vscode.McpStdioServerDefinition(
          'AI Effort Tracker usage insights',
          process.execPath,
          [context.asAbsolutePath(path.join('out', 'mcp', 'server.js'))],
          {
            ELECTRON_RUN_AS_NODE: '1',
            AET_VERSION: version,
            AET_STORE_PATH: path.join(storage, 'effort-tracker.json'),
            AET_WORKSPACE_STORAGE: path.join(path.dirname(path.dirname(storage)), 'workspaceStorage')
          },
          version
        )];
      }
    })
  );
}
