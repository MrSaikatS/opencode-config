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
| **opencode.json** | Shell, username, formatter, LSP, small model, MCP servers        |
| **cli.json**      | Theme, animations, session, tabs, attention, prompt, debug       |
| **AGENTS.md**     | Retrieval-led reasoning, subagents, voice and behavior rules     |
| **Plugins**       | `auto-title` V2 session title plugin                             |
| **MCP Servers**   | Local and remote tool integrations via `mcp.servers`             |

> **Note:** The `v2` working directory replaces `tui.json` with `cli.json`. See Migration below.

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
- **Small model:** `opencode/nemotron-3.5-lightning-free` for lightweight tasks
- **MCP:** `mcp.servers` with `disabled` flags, `false` means active

Current `opencode.json` has no `permission`, `share`, `compaction`, or `server` keys. Those keys exist on `main` but were removed in the `v2` working directory.

### 🔌 MCP Servers

| Server        | Type   | Purpose                       | Disabled | Active |
| ------------- | ------ | ----------------------------- | -------- | ------ |
| `shadcn`      | local  | UI component management       | `false`  | yes    |
| `better-auth` | remote | Authentication library docs   | `false`  | yes    |
| `bun`         | remote | Bun runtime docs              | `true`   | no     |
| `deepwiki`    | remote | AI-powered repo documentation | `true`   | no     |

Details:

- `shadcn` runs `bunx --bun shadcn@latest mcp`
- `better-auth` runs `https://mcp.better-auth.com/mcp`
- `bun` runs `https://bun.com/docs/mcp`
- `deepwiki` runs `https://mcp.deepwiki.com/mcp`

> **Note:** `v2` uses `disabled`, not `enabled`. Set `"disabled": true` to turn a server off.

## 🖥️ CLI UI

[`cli.json`](cli.json) defines:

- **Theme:** `name: opencode`, `mode: dark`
- **Animations:** `true`
- **Session:** `scrollbar: true`, `thinking: show`, `grouping: none`
- **Tabs:** `indicators: status`, `layout: horizontal`, `enabled: true`
- **Attention:** `notifications: true`, `sound: true`, `volume: 1`
- **Prompt:** `image_preview: true`
- **Debug:** `devtools: false`, `turn_tokens: true`

This file replaces the old `tui.json` from `main`. `main` only set `attention.enabled` and `volume`.

## 🔌 Plugins

### auto-title

V2 single file plugin at `plugins/auto-title.ts`, 684 lines, no runtime imports.

What it does:

- Titles on the 3rd assistant text response, retitles after a delta of 3 more on topic shift
- Format: `Category: Description - DD/MM/YYYY h:MMAM/PM`
- Category must be one of `Feature, Bugfix, Refactor, Docs, Test, Chore, Investigation, Question`
- Description is 4 to 10 words, specific, no timestamp in model output, timestamp is appended after validation
- Transcript uses user messages only, 6 messages for initial title, 10 for retitle, 1200 chars per message, includes opening request
- Idle logic re-arms a 30s debounce on session activity, then `session.wait` confirms idle before inference, aborts in-flight work on new activity
- Model chain is explicit option, then title agent model, then session model, then server default
- Generation has 3 tiers: one-shot text, reused worker session, transient session fallback, with 45s timeout. `opencode` provider models skip one-shot and go to worker
- Safety ignores child sessions and worker sessions, adds jitter plus fresh reread to avoid rename storms, sweeps state after 30 days or 500 entries, cleans up on `session.deleted` and unload

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
