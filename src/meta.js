// What each AI CLI is, without running it: labels, static model suggestions and the reasoning efforts it accepts.
// No Node APIs, so the cloud can import it too: a bridged lane (bridge/) is validated against these.
export const CLI_META = {
  claude: {
    label: 'Claude (Claude Code CLI)',
    models: ['', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: { label: 'Codex (OpenAI Codex CLI)', models: [''], efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  copilot: { label: 'Copilot (GitHub Copilot CLI)', models: ['', 'auto'], efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  gemini: { label: 'Gemini (Google Gemini CLI)', models: [''], efforts: [] },
};
