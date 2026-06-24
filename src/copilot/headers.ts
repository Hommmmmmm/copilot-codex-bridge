/**
 * 调用 Copilot API 时必须带的 headers（模拟 VS Code Copilot Chat 扩展）
 * 缺这些头 Copilot 会返 403
 */
export function copilotHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // 这些字段不能乱填，必须像真的 VS Code Copilot 扩展
    'User-Agent': 'GitHubCopilotChat/0.26.7',
    'Editor-Version': 'vscode/1.99.3',
    'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    'Copilot-Integration-Id': 'vscode-chat',
    'OpenAI-Intent': 'conversation-panel',
    'X-GitHub-Api-Version': '2025-04-01',
  }
}
