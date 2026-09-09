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
  ⭐ If you find this project useful, consider giving it a star - it helps others discover it!
</p>

<p align="center">Personal <a href="https://opencode.ai">OpenCode</a> configuration, plugins, and MCP server setup.</p>

---

## 🧰 What's Inside

| Component         | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| **opencode.json** | MCP servers, permissions, shell, server config              |
| **AGENTS.md**     | Agent instructions and conventions (includes uns lop rules) |
| **tui.json**      | TUI settings (attention notifications)                      |
| **Plugins**       | Custom plugins extending OpenCode's capabilities            |
| **MCP Servers**   | Local & remote tool integrations                            |

## ✅ Prerequisites

- [Bun](https://bun.sh/docs/installation#windows)
- [Git](https://git-scm.com/install/windows)
- [PowerShell 7+](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6#msi)

## 🚀 Getting Started

1. **Backup or uninstall** - Run `opencode uninstall` if you have an existing installation.

2. **Install OpenCode** - Install globally via Bun:

   ```bash
   bun i -g --trust opencode-ai@latest
   ```

3. **Copy config files** - Copy `AGENTS.md`, `opencode.json`, `tui.json`, and `plugins/auto-title.ts` from this repo to `C:\Users\<YourUsername>\.config\opencode`:

   ```
   .config/opencode/
   ├── AGENTS.md
   ├── opencode.json
   ├── tui.json
   └── plugins/
       └── auto-title.ts
   ```

4. **Open OpenCode** - Run `opencode` in PowerShell to launch the TUI.

   > **Note:** Wait for the TUI to fully load and the MCP status to turn green before using OpenCode.

5. **Connect** - In the TUI, run `/connect`, select `opencode`, then visit `opencode.ai/auth`.

6. **Authenticate** - Sign in with GitHub, go to **API Keys**, copy or create a key, and paste it into the TUI.

## ⚙️ Configuration

[`opencode.json`](opencode.json) defines:

- **Permissions** - `question`, `webfetch`, `websearch` all set to `allow`
- **Shell** - defaults to `pwsh` (PowerShell 7+)
- **Small model** - `opencode/nemotron-3.5-lightning-free` for lightweight tasks
- **LSP** - enabled for language server integration
- **Formatter** - enabled for code formatting
- **Share** - disabled
- **Compaction** - auto and prune enabled
- **Server** - binds to `0.0.0.0` with mdns discovery enabled

### 🔌 MCP Servers

| Server        | Type   | Purpose                       | Enabled |
| ------------- | ------ | ----------------------------- | ------- |
| `shadcn`      | local  | UI component management       | no      |
| `better-auth` | remote | Authentication library docs   | yes     |
| `deepwiki`    | remote | AI-powered repo documentation | no      |
| `bun`         | remote | Bun runtime docs              | no      |

> **Note:** The `shadcn` MCP server is disabled by default due to unreliability. To use it, set `"enabled": true` for `mcp.shadcn` in `opencode.json`.

## 🔌 Plugins

### auto-title

Generates and refines session titles as conversations progress.

- First title after **3 user messages**, re-refines every **5 more**
- Format: `{Title} - DD/MM/YYYY HH:MMAM/PM`
- Uses throwaway temp session - no noise in real session
- Handles concurrency, error recovery, date-stripping on re-refinement
- Feeds previous title back on refinement for continuity

## 🤝 Contributing

We welcome contributions! Here's how you can help:

1. 🍴 Fork the repository
2. 🌿 Create a feature branch: `git checkout -b feat/amazing-feature`
3. 💻 Make your changes
4. 📝 Commit using [conventional commits](https://www.conventionalcommits.org/)
5. 🚀 Open a Pull Request

Check the [issues page](https://github.com/MrSaikatS/opencode-config/issues) for bugs or feature requests.

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/MrSaikatS">Saikat Sardar</a>
  <br>
  🐛 <a href="https://github.com/MrSaikatS/opencode-config/issues/new">Report Bug</a> · 💡 <a href="https://github.com/MrSaikatS/opencode-config/issues/new?labels=enhancement">Suggest Feature</a>
</p>
