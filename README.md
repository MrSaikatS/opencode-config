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
  ⭐ If you find this project useful, consider giving it a star — it helps others discover it!
</p>

<p align="center">Personal <a href="https://opencode.ai">OpenCode</a> configuration, plugins, and MCP server setup.</p>

---

## 🧰 What's Inside

| Component            | Description                                       |
| -------------------- | ------------------------------------------------- |
| **opencode.jsonc**   | Agent parameters, MCP servers, permissions, shell |
| **Plugins**          | Custom plugins extending OpenCode's capabilities  |
| **MCP Servers**      | Local & remote tool integrations                  |

## ✅ Prerequisites

- [OpenCode](https://opencode.ai) (latest version)
- PowerShell 7+ (for local shell execution)

## 🚀 Getting Started

```bash
git clone https://github.com/MrSaikatS/opencode-config.git ~/.config/opencode
cd ~/.config/opencode
```

## ⚙️ Configuration

[`opencode.jsonc`](opencode.jsonc) defines:

- **Agent parameters** — `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` for `build` and `plan` agents
- **Permissions** — `question`, `webfetch`, `websearch` all set to `allow`
- **Shell** — defaults to `pwsh` (PowerShell 7+)
- **Small model** — `opencode/big-pickle` for lightweight tasks

### 🤖 Agent Presets

| Agent   | Temperature | Top P | Presence Penalty | Frequency Penalty |
| ------- | ----------- | ----- | ---------------- | ----------------- |
| `build` | 0.1         | 0.85  | 0.0              | 0.0               |
| `plan`  | 0.2         | 0.95  | 0.0              | 0.0               |

### 🔌 MCP Servers

| Server        | Type   | Purpose                       | Enabled |
| ------------- | ------ | ----------------------------- | ------- |
| `shadcn`      | local  | UI component management       | yes     |
| `better-auth` | remote | Authentication library docs   | yes     |
| `deepwiki`    | remote | AI-powered repo documentation | yes     |
| `bun`         | remote | Bun runtime docs              | no      |

## 🔌 Plugins

### dcp

[Dynamic Context Pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) — automatically reduces token usage by pruning stale tool outputs and conversation history. Uses a `compress` tool that the model calls on closed tasks, with two modes (`range` and `message`). Configured globally in `opencode.jsonc` under the `"plugin"` key.

### auto-title

Automatically generates and refines session titles as conversations progress.

- Generates the first title after **3 user messages**
- Re-refines every **5 additional messages**
- Format: `{Title} - DD/MM/YYYY HH:MMAM/PM`
- Uses a throwaway temp session for generation — no noise in your real session
- Handles concurrency, error recovery, and date-stripping on re-refinement

## 📐 Key Conventions

- **Agent configs** — `build` agent uses lower temperature (0.1) for deterministic output; `plan` agent uses slightly higher (0.2) for creative exploration
- **Plugins** — Each plugin is a single file in `plugins/` exporting a `Plugin` function
- **Permissions** — All discretionary tools (`question`, `webfetch`, `websearch`) are pre-allowed for faster workflow
- **MCP** — Local servers use `command` binaries; remote servers use `url` endpoints

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
  🐛 Report Bug · 💡 Suggest Feature
</p>
