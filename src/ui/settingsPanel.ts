import * as vscode from 'vscode';
import { GitHubService } from '../services/githubService';
import {
  CURRENCIES, SETTINGS_PREFIX, SETTING_GROUPS, SettingDescriptor, buildSettingDescriptors, impliedChanges, settingStates, validateSettingValue,
} from '../util/settingsModel';

/**
 * Settings tab (#148): load, validate and write the extension's settings from
 * the dashboard. Writes go to user settings; a workspace value that overrides
 * them is reported (and can be removed). The GitHub token never leaves the
 * extension host — it is entered in a password box and kept in SecretStorage.
 */

type Post = (msg: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;

let descriptors: SettingDescriptor[] | undefined;

function getDescriptors(context: vscode.ExtensionContext): SettingDescriptor[] {
  if (!descriptors) {
    const c = context.extension.packageJSON?.contributes?.configuration;
    const props = Object.assign({}, ...(Array.isArray(c) ? c : [c]).map((x: { properties?: object }) => x?.properties ?? {}));
    descriptors = buildSettingDescriptors(props);
  }
  return descriptors;
}

async function payload(context: vscode.ExtensionContext, gh: GitHubService, result?: unknown) {
  const cfg = vscode.workspace.getConfiguration('aiEffortTracker');
  return {
    type: 'settingsData',
    settings: settingStates(getDescriptors(context), id => cfg.inspect(id)),
    tokenSource: await gh.tokenSource(),
    hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
    groups: SETTING_GROUPS,
    currencies: CURRENCIES,
    ...(result ? { result } : {}),
  };
}

const SETTINGS_MESSAGES = new Set(['settings', 'setSetting', 'resetSetting', 'clearWorkspaceSetting', 'setToken', 'clearToken', 'moveTokenToSecure', 'openSettingsJson']);

/** Handle a Settings tab message. Returns false when the message is not a settings message. */
export async function handleSettingsMessage(m: Msg, context: vscode.ExtensionContext, gh: GitHubService, post: Post): Promise<boolean> {
  if (!SETTINGS_MESSAGES.has(m?.type)) return false;
  const cfg = vscode.workspace.getConfiguration('aiEffortTracker');
  const desc = typeof m.key === 'string' ? getDescriptors(context).find(d => d.id === m.key) : undefined;
  let result: { key?: string; ok: boolean; error?: string; also?: string[] } | undefined;
  try {
    switch (m.type) {
      case 'setSetting': {
        if (!desc) throw new Error('Unknown setting.');
        const v = validateSettingValue(desc, m.value);
        if (!v.ok) { result = { key: desc.id, ok: false, error: v.error }; break; }
        await cfg.update(desc.id, v.value, vscode.ConfigurationTarget.Global);
        const also = impliedChanges(desc.id, v.value);
        for (const a of also) await cfg.update(a.id, a.value, vscode.ConfigurationTarget.Global);
        result = { key: desc.id, ok: true, also: also.map(a => a.id) };
        break;
      }
      case 'resetSetting':
        if (!desc || desc.kind === 'secret') throw new Error('Unknown setting.');
        await cfg.update(desc.id, undefined, vscode.ConfigurationTarget.Global);
        result = { key: desc.id, ok: true };
        break;
      case 'clearWorkspaceSetting':
        if (!desc) throw new Error('Unknown setting.');
        await cfg.update(desc.id, undefined, vscode.ConfigurationTarget.Workspace);
        if (cfg.inspect(desc.id)?.workspaceFolderValue !== undefined) {
          await cfg.update(desc.id, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        result = { key: desc.id, ok: true };
        break;
      case 'setToken': {
        const token = await vscode.window.showInputBox({
          title: 'GitHub token',
          prompt: 'Paste a fine-grained personal access token. It is kept in VS Code secure storage, not in settings.json.',
          password: true,
          ignoreFocusOut: true,
          validateInput: v => (v.trim() && /\s/.test(v.trim()) ? 'A token has no spaces.' : null),
        });
        if (token === undefined || !token.trim()) break;
        await gh.setSecretToken(token.trim());
        result = { key: 'githubToken', ok: true };
        break;
      }
      case 'clearToken':
        await gh.setSecretToken(undefined);
        result = { key: 'githubToken', ok: true };
        break;
      case 'moveTokenToSecure': {
        const plain = cfg.inspect<string>('githubToken');
        const token = plain?.globalValue || plain?.workspaceValue || plain?.workspaceFolderValue;
        if (token) {
          await gh.setSecretToken(token);
          for (const t of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder]) {
            try { await cfg.update('githubToken', undefined, t); } catch { /* target not available */ }
          }
        }
        result = { key: 'githubToken', ok: true };
        break;
      }
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettings', typeof m.key === 'string' ? SETTINGS_PREFIX + m.key : '@ext:' + context.extension.id);
        return true;
    }
  } catch (e) {
    result = { key: desc?.id ?? m.key, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  post(await payload(context, gh, result));
  return true;
}
