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

| Component         | Description                                       |
| ----------------- | ------------------------------------------------- |
| **opencode.json** | Agent parameters, MCP servers, permissions, shell |
| **AGENTS.md**     | Agent instructions and conventions                |
| **Plugins**       | Custom plugins extending OpenCode's capabilities  |
| **MCP Servers**   | Local & remote tool integrations                  |

## ✅ Prerequisites

- [OpenCode](https://opencode.ai) (latest version)
- [Bun](https://bun.sh)
- PowerShell 7+ (for local shell execution)

## 🚀 Getting Started

1. **Clone the repo** — Replace your OpenCode config directory:

   ```bash
   git clone https://github.com/MrSaikatS/opencode-config.git ~/.config/opencode
   ```

2. **Find cheapest or free models** — Run `opencode models` to list available models, then update both:
   - `small_model` in `opencode.json`
   - `TITLE_MODEL` in `plugins/auto-title.ts`
   - See [Models CLI docs](https://opencode.ai/docs/cli/#models) for details.

## ⚙️ Configuration

[`opencode.json`](opencode.json) defines:

- **Agent parameters** — `temperature`, `top_p`, `presence_penalty`, `frequency_penalty` for `build` and `plan` agents
- **Permissions** — `question`, `webfetch`, `websearch` all set to `allow`
- **Shell** — defaults to `pwsh` (PowerShell 7+)
- **Small model** — `opencode/nemotron-3-ultra-free` for lightweight tasks
- **LSP** — enabled for language server integration
- **Formatter** — enabled for code formatting

### 🤖 Agent Presets

| Agent   | Temperature | Top P | Presence Penalty | Frequency Penalty |
| ------- | ----------- | ----- | ---------------- | ----------------- |
| `build` | 0.2         | 0.9   | 0.0              | 0.0               |
| `plan`  | 0.4         | 0.95  | 0.0              | 0.0               |

### 🔌 MCP Servers

| Server        | Type   | Purpose                       | Enabled |
| ------------- | ------ | ----------------------------- | ------- |
| `shadcn`      | local  | UI component management       | yes     |
| `better-auth` | remote | Authentication library docs   | yes     |
| `deepwiki`    | remote | AI-powered repo documentation | no      |
| `bun`         | remote | Bun runtime docs              | no      |

## 🔌 Plugins

### [dcp](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)

Reduces token usage by pruning stale tool outputs and conversation history.

- Uses `compress` tool with two modes: `range` and `message`
- Configured globally in `opencode.json` under `"plugin"` key

### auto-title

Generates and refines session titles as conversations progress.

- First title after **3 user messages**, re-refines every **5 more**
- Format: `{Title} - DD/MM/YYYY HH:MMAM/PM`
- Uses throwaway temp session — no noise in real session
- Handles concurrency, error recovery, date-stripping on re-refinement

### [caveman](https://github.com/opencode-caveman/opencode-caveman)

Ultra-compressed communication mode. Cuts token usage ~75% while keeping full technical accuracy.

- Intensity levels: `lite`, `full` (default), `ultra`, `wenyan-lite`, `wenyan-full`, `wenyan-ultra`
- Auto-triggers on token efficiency request or `/caveman`

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
