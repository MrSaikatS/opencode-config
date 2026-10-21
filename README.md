<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/opencode--config-0a0a0a?style=for-the-badge&logo=code&logoColor=white">
    <img alt="opencode-config" src="https://img.shields.io/badge/opencode--config-ffffff?style=for-the-badge&logo=code&logoColor=black">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/MrSaikatS/opencode-config/stargazers">
    <img src="https://img.shields.io/github/stars/MrSaikatS/opencode-config?style=for-the-badge&logo=github&color=gold" alt="GitHub Stars">
  </a>
  <a href="https://github.com/MrSaikatS/opencode-config/issues">
    <img src="https://img.shields.io/github/issues/MrSaikatS/opencode-config?style=for-the-badge&logo=github" alt="GitHub Issues">
  </a>
  <a href="https://github.com/MrSaikatS/opencode-config/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/MrSaikatS/opencode-config?style=for-the-badge&logo=github" alt="License">
  </a>
</p>

<p align="center">
  ⭐ If you find this project useful, consider giving it a star, it helps others discover it!
</p>

<p align="center">Personal <a href="https://opencode.ai">OpenCode</a> configuration, plugins, and MCP server setup.</p>

---

## 🧰 What's Inside

| Component         | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| **opencode.json** | Shell, username, formatter, LSP, title agent model, MCP servers |
| **cli.json**      | Theme, animations, session, tabs, attention, prompt, debug, highlights |
| **AGENTS.md**     | Retrieval-led reasoning, subagents, voice and behavior rules     |
| **Plugins**       | `auto-title` session title plugin                                 |
| **MCP Servers**   | Local and remote tool integrations via `mcp.servers`             |

## ✅ Prerequisites

- [Bun](https://bun.sh/docs/installation#windows)
- [Git](https://git-scm.com/install/windows)
- [PowerShell 7+](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6#msi)

## 🚀 Getting Started

1. **Backup or uninstall:** Run `opencode uninstall` if you have an existing installation.

2. **Install OpenCode:** Install globally via Bun:

   ```bash
   bun install -g --trust @opencode/cli
   ```

3. **Copy config files:** Copy `AGENTS.md`, `opencode.json`, `cli.json`, and `plugins/auto-title.ts` from this repo to `C:\Users\<YourUsername>\.config\opencode`:

   ```
   .config/opencode/
   ├── AGENTS.md
   ├── opencode.json
   ├── cli.json
   └── plugins/
       └── auto-title.ts
   ```

4. **Set username:** Open `opencode.json`, change `"username": "Saikat"` to own name, save.

5. **Open OpenCode:** Run `opencode` in PowerShell to launch the TUI.

   > **Note:** Wait for the TUI to fully load and the MCP status to turn green before using OpenCode.

6. **Connect and manage keys:** In the TUI, run `/connect`, select `opencode`, then visit `opencode.ai/auth` to open console. Go to `Keys`, click on Service Accounts Name, remove old keys with permission `All` if any via Revoke.

7. **Add API key:** Click `Add API Key`, set Name and Permissions to `All`, copy key, paste it into the TUI.

## ⚙️ Configuration

[`opencode.json`](opencode.json) defines:

- **Shell:** `pwsh`
- **Username:** `Saikat`
- **Formatter:** `true`
- **LSP:** `true`
- **Title agent model:** `opencode/nemotron-3.5-lightning-free` via `agents.title.model`, used by auto-title plugin
- **MCP:** `mcp.servers` with `disabled` flags, `false` means active

### 🔌 MCP Servers

| Server        | Type   | Purpose                       | Disabled | Active |
| ------------- | ------ | ----------------------------- | -------- | ------ |
| `shadcn`      | local  | UI component management       | `true`   | no     |
| `better-auth` | remote | Authentication library docs   | `false`  | yes    |
| `bun`         | remote | Bun runtime docs              | `true`   | no     |
| `deepwiki`    | remote | AI-powered repo documentation | `true`   | no     |
| `motion`      | remote | Motion animation docs         | `true`   | no     |

Details:

- `shadcn` runs `bunx --bun shadcn@latest mcp`
- `better-auth` runs `https://mcp.better-auth.com/mcp`
- `bun` runs `https://bun.com/docs/mcp`
- `deepwiki` runs `https://mcp.deepwiki.com/mcp`
- `motion` runs `https://mcp.motion.dev`

> **Note:** Uses `disabled`, not `enabled`. Set `"disabled": true` to turn a server off.

## 🖥️ CLI UI

[`cli.json`](cli.json) defines:

- **Theme:** `name: opencode`, `mode: dark`
- **Animations:** `true`
- **Session:** `scrollbar: true`, `thinking: show`, `grouping: auto`, `verbosity: high`, `new_location: launch`
- **Tabs:** `indicators: numbers`, `layout: horizontal`, `enabled: true`, `mode: on`
- **Attention:** `notifications: true`, `sound: true`, `volume: 1`
- **Prompt:** `image_preview: true`, `paste: full`
- **Debug:** `devtools: false`, `turn_tokens: true`
- **Highlights:** `true`

## 🔌 Plugins

### auto-title

Single file plugin at `plugins/auto-title.ts`, imports `Plugin` from `@opencode/plugin`.

What it does:

- Titles on the 3rd assistant text response, retitles every 5 further responses, and renames with a fresh timestamp on every successful run
- Format: `Title text - DD/MM/YYYY h:MMAM/PM`. Model outputs title text only, plugin appends timestamp after validation
- Title text is 4 to 8 words, specific to the conversation, no category, label, prefix, date, timestamp, quotes, or trailing punctuation. Legacy `Category:` prefix is stripped if present
- Transcript uses user messages only, 6 messages by default for both initial title and retitle, 1200 chars per message, includes opening request
- Runs on every session event with a direct count check, no timers and no idle wait. In-flight runs guard against floods, worker and self-generated events are ignored
- Model comes from `agents.title.model` only. No plugin option override. Skips with trace if missing, 10 minute cooldown after auth failure
- Generation creates one fresh ephemeral worker per run via the primary agent loop and removes it after reading. Single attempt only, one worker and one inference call per run, raced against a 90s timeout with no retry by design
- Safety ignores child sessions and worker sessions, uses single-flight processing map plus storage claim and filesystem lock with 120s TTL plus fresh state reread before rename to avoid storms, records each decision in a trace store capped at 100 sessions, rebases stored count after compaction, cleans up on `session.deleted` and unload

#### Options

| Option                        | Default | Description                                     |
| ----------------------------- | ------- | ----------------------------------------------- |
| `minUserMessages`             | `6`     | User messages used for initial title            |
| `maxUserMessages`             | `6`     | User messages used for retitle                  |
| `maxCharsPerMessage`          | `1200`  | Per-message transcript truncation               |
| `initialTitleAtAssistantCount` | `3`     | Assistant text responses before first title     |
| `retitleAfterAssistantDelta`   | `5`     | Further assistant responses before each retitle |
| `enableRetitle`               | `true`  | Set `false` to title once and never retitle     |
| `includeOpeningRequest`       | `true`  | Prepend first user message when outside window  |
| `enabled`                     | `true`  | Set `false` to disable the plugin               |

## 🤝 Contributing

We welcome contributions! Here's how you can help:

1. 🍴 Fork the repository
2. 🌿 Create a feature branch: `git checkout -b feat/amazing-feature`
3. 💻 Make your changes
4. 📝 Commit using [conventional commits](https://www.conventionalcommits.org/)
5. 🚀 Open a Pull Request

Check the [issues page](https://github.com/MrSaikatS/opencode-config/issues) for bugs or feature requests.

## 📄 License

MIT, see [LICENSE](LICENSE).

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/MrSaikatS">Saikat Sardar</a>
  <br>
  🐛 <a href="https://github.com/MrSaikatS/opencode-config/issues/new">Report Bug</a> · 💡 <a href="https://github.com/MrSaikatS/opencode-config/issues/new?labels=enhancement">Suggest Feature</a>
</p>
