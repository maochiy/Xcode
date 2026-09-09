<div align="center">
  <img src="./apps/electron/resources/icon.svg" alt="Xcode icon" width="88" height="88" />
  <h1>Xcode</h1>
  <p>A local-first AI desktop workbench for Chat, Agent workflows, projects, Skills, MCP, automation, and remote bots.</p>
</div>

[中文 README](./README.md) | [Tutorial (inherited from Proma)](./tutorial/tutorial.md) | [Repository](https://github.com/maochiy/Xcode) | [Releases](https://github.com/maochiy/Xcode/releases)

> [!IMPORTANT]
> **Xcode is an independently maintained derivative based on the open-source version of [Proma](https://github.com/proma-ai/Proma).** Proma was created by **Erlich Liu** with contributions from the Proma contributors. This repository is not an official Proma release. It is also unrelated to, unaffiliated with, and not endorsed by Apple or Apple's Xcode developer tools.

## What Xcode Can Do

- **Chat mode**: multi-model conversations, attachments, image input, Markdown / Mermaid / KaTeX / code highlighting, parallel conversations, system prompts, and context controls.
- **Agent mode**: Pi-powered workspace tasks with permission modes, file operations, streaming output, plan confirmation, ask-user interactions, tool calling, and session resume.
- **Collaboration and tasks**: split complex work into traceable collaboration sessions and tasks, with calls and results shown in the message stream.
- **Skills & MCP**: manage workspace-specific Skills, MCP servers, memory, and persistent workspace files.
- **Remote bots**: connect Lark / Feishu, DingTalk, and WeChat bridges from the desktop app.
- **Local-first data**: store conversations, workspaces, attachments, settings, and Skills under `~/.proma/` as JSON / JSONL files without a local database.
- **Desktop experience**: proxy settings, file preview, global shortcuts, a quick-task window, voice input, auto-update support, and light / dark / system themes.

## Getting Started

### Download

Download Xcode from the [maochiy/Xcode Releases](https://github.com/maochiy/Xcode/releases) page. The current release line starts at **v0.0.1** and provides:

- macOS Apple Silicon (`arm64`)
- macOS Intel (`x64`)
- Windows (`x64`)

The v0.0.1 release artifacts are distributed without platform developer signing; the macOS builds are also not notarized. Verify that you downloaded them from the repository above and review any operating-system security prompt before opening them.

On macOS, the application bundle is named **`Xcode-Desktop.app`** to avoid overwriting Apple's `Xcode.app`, while the displayed product name remains Xcode.

The version sequence restarts at `0.0.1`; existing Proma installations with a higher version will not automatically downgrade to Xcode. Install manually and back up `~/.proma/` first. The data directory is shared for compatibility, not an isolated copy, so avoid using both applications against the same data at the same time.

### First Setup

1. Open Xcode and finish the environment check. Git, Bun / Node.js, and a usable shell may be required by Agent tools and project workflows.
2. Go to **Settings > Channels**, add an AI provider channel, and configure its Base URL, credentials, and model list as required by that provider.
3. Use Chat for direct conversations or switch to Agent for workspace-based tasks.
4. Agent execution uses the built-in **Pi Runtime only**. There is no Claude / Pi runtime selector and no Claude Agent SDK runtime.
5. Go to **Settings > Agent** to choose the default Agent channel, model, workspace, permissions, Skills, and MCP configuration.
6. Configure memory, web search, or remote bot bridges from their corresponding settings when needed.

## Choosing a Mode

### Use Chat For

- Everyday Q&A, explanation, translation, rewriting, and lightweight code discussion.
- Reading attachments and summarizing or comparing their content.
- One-off conversations enhanced by web search or memory tools.
- Comparing outputs from multiple models or exploring different system prompts.

### Use Agent For

- Creating, editing, or organizing local files.
- Research, report writing, and multi-step project work.
- Tasks that need MCP, Skills, Shell, Git, project files, or external context.
- Work that benefits from permissions, plan mode, background execution, collaboration sessions, or remote bot follow-up.

In short: **use Chat when you need an answer; use Agent when you need work to be done.**

## Screenshots

> [!NOTE]
> The screenshots below are **historical reference images inherited from the Proma open-source project**. They illustrate the inherited product concepts and are **not current screenshots of the Xcode-branded application**. Labels and visual details may differ from v0.0.1.

### Chat Analysis — Historical Proma Reference

Use Chat for lightweight but practical analysis: compare audience needs, generate a table, and shape first-screen README copy quickly.

![Historical Proma Chat analysis reference](./docs/assets/screenshots/proma-chat-demo.png)

### Agent Workbench — Historical Proma Reference

Agent works inside a workspace, reads project files, progresses through tasks, outputs structured findings, and keeps reusable files visible in the workspace panel.

![Historical Proma Agent workbench reference](./docs/assets/screenshots/proma-agent-demo.png)

### Skills — Historical Proma Reference

Each workspace can keep reusable Skills for repeatable workflows.

![Historical Proma workspace Skills reference](./docs/assets/screenshots/proma-skills-demo.png)

### Skills & MCP — Historical Proma Reference

A workspace can manage stdio and HTTP MCP servers, enabling or disabling external context per project.

![Historical Proma MCP settings reference](./docs/assets/screenshots/proma-mcp-demo.png)

### Streaming Voice Input — Historical Proma Reference

The inherited desktop voice-input workflow can insert recognized text into the application or the active desktop cursor, depending on the selected mode.

![Historical Proma voice input reference](./docs/assets/screenshots/proma-typeless-input.png)

## Agent Runtime and Providers

Xcode has one executable Agent runtime: **Pi**.

- The runtime adapter is implemented by `apps/electron/src/main/lib/runtime/pi-runtime-adapter.ts`, backed by `apps/electron/src/main/lib/runtime/frakio-pi-runtime-adapter.ts` for compatibility with the existing bridge implementation.
- Pi uses `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`, all pinned to **`0.80.9`**.
- `resources/pi-runtime/` contains the bundled Pi bridge, worker, thread-context implementation, and worker support modules.
- Historical Runtime IDs such as `claude`, `codex`, and `hermes` remain in some types and persisted-data migration paths only. They are normalized to Pi and are not selectable execution kernels.
- Dispatch policy can assign different task responsibilities inside Pi, but this is role routing—not runtime switching.

Pi maps configured channels to an explicit runtime API protocol:

| Channel / protocol family | Chat | Pi Agent |
| --- | --- | --- |
| Anthropic and Anthropic-compatible Messages APIs | Supported | Supported |
| OpenAI Chat Completions and compatible endpoints | Supported | Supported |
| OpenAI Responses | Supported | Supported |
| Google Generative Language | Supported | Supported |
| ChatGPT subscription through Codex OAuth | — | Supported |

Provider-specific support for tools, reasoning, context windows, and attachments can vary. Xcode makes no provider whitelist or third-party account-policy guarantee, including for Kimi plans.

## Local Data and Compatibility Names

Xcode preserves Proma's local storage format so existing data remains inspectable and compatible:

```text
~/.proma/
├── channels.json
├── conversations.json
├── conversations/
│   └── {conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/
│   └── {session-id}.jsonl
├── agent-workspaces/
│   └── {workspace-slug}/
│       ├── workspace-files/
│       ├── mcp.json
│       └── skills/
├── attachments/
├── user-profile.json
├── settings.json
└── sdk-config/
```

API keys are encrypted through Electron `safeStorage` before being written to `channels.json`. Core data uses JSON configuration and append-only JSONL logs rather than a local database.

The following Proma identifiers are intentionally retained for compatibility and do **not** indicate an incomplete product rename:

- `~/.proma/` for existing local data and configuration.
- The `@proma/*` workspace package scope used by the source code.
- The bundled `proma` CLI and related environment / file-format identifiers used by existing Skills, scripts, sessions, and backups.

Changing these compatibility identifiers would risk breaking local data, integrations, or automation without providing a functional benefit.

## Development

Xcode is a Bun workspace monorepo:

```text
.
├── packages/
│   ├── shared/        # shared types, IPC constants, config, and utilities
│   ├── session-core/  # session reading, grouping, search, and rendering
│   ├── core/          # provider adapters, SSE, and code highlighting
│   └── ui/            # shared React UI components
└── apps/
    ├── cli/           # compatible proma command-line interface
    └── electron/      # Xcode Electron desktop application
```

Current package versions:

| Package | Version | Responsibility |
| --- | --- | --- |
| `@proma/electron` | `0.0.1` | Xcode Electron desktop application |
| `@proma/cli` | `0.1.0` | compatible `proma` CLI |
| `@proma/shared` | `0.1.72` | shared types, IPC constants, config, and utilities |
| `@proma/session-core` | `0.1.6` | shared headless session logic for Electron and CLI |
| `@proma/core` | `0.2.17` | provider adapters, SSE, and Shiki highlighting |
| `@proma/ui` | `0.1.11` | shared React UI components |

Common commands:

```bash
# Get the source
git clone https://github.com/maochiy/Xcode.git
cd Xcode

# Install dependencies
bun install

# Development mode: Vite + Electron + hot reload
bun run dev

# Build the Electron application
bun run electron:build

# Build and run
bun run electron:start

# Typecheck all workspaces
bun run typecheck

# Run tests
bun test
```

Electron-specific commands:

```bash
cd apps/electron

bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run build:cli
bun run dist:fast
```

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Bun |
| Desktop | Electron 39 |
| Frontend | React 18 + TypeScript |
| State | Jotai |
| Styling | Tailwind CSS + Radix UI |
| Rich text input | TipTap |
| Markdown / diagrams / math | React Markdown + Beautiful Mermaid + KaTeX |
| Code highlighting | Shiki |
| Build | Vite + esbuild |
| Distribution | electron-builder |
| Agent runtime | Pi via `@earendil-works/pi-*` `0.80.9` |

## Architecture

The core desktop communication path is:

```text
@proma/shared types and IPC constants
  -> apps/electron/src/main/ipc.ts handlers
  -> apps/electron/src/preload/index.ts window.electronAPI bridge
  -> renderer Jotai atoms and React components
```

Key main-process components include:

- `main/lib/agent-orchestrator.ts`: Agent orchestration, channel and model routing, permissions, persistence, event streaming, and error handling.
- `main/lib/runtime/pi-runtime-adapter.ts`: public Pi adapter entry point.
- `main/lib/runtime/frakio-pi-runtime-adapter.ts`: Pi bridge integration, worker lifecycle, model routing, session restore, MCP, and tool permissions.
- `main/lib/runtime/runtime-adapters.ts`: Pi-only router that normalizes legacy runtime selections to Pi.
- `main/lib/runtime/runtime-registry.ts`: Pi-only discovery, activation, capability, and legacy configuration migration.
- `main/lib/agent-session-manager.ts`: Agent session metadata and JSONL message persistence.
- `main/lib/agent-workspace-manager.ts`: workspaces, MCP, Skills, and workspace files.
- `main/lib/chat-service.ts`: Chat streaming, provider adapters, and tool activity.
- `main/lib/conversation-manager.ts`: Chat conversation metadata and message storage.
- `main/lib/channel-manager.ts`: channel configuration, credential encryption, connection tests, and model discovery.
- `main/lib/feishu-bridge.ts`, `dingtalk-bridge.ts`, and `wechat-bridge.ts`: remote bot integrations.

Renderer state is managed with Jotai. Agent IPC listeners are mounted globally so streaming events, permission requests, and background tasks survive view changes.

## Packaging Notes

The current packaging path is built around the bundled Pi worker, its physical runtime dependencies, packaging hooks, and the compatible CLI.

- `apps/electron/resources/pi-runtime/` is copied through electron-builder `extraResources` and runs outside the ASAR as a forked Pi bridge / worker runtime.
- `@earendil-works/pi-*` and the worker's runtime dependencies are included from the Electron app's `node_modules`; `asarUnpack` keeps the physical modules available to the forked worker and native add-ons.
- `resources/pi-worker-compat.cjs` is packaged beside the runtime to patch the limited CommonJS compatibility cases required by the worker.
- `bun run build:cli` compiles `apps/cli` with `bun build --compile` into the self-contained `proma` / `proma.exe` binary under `resources/bin/`, which is then copied through `extraResources`.
- The electron-builder `afterPack` hook verifies the bundled Pi Worker and `@earendil-works/pi-coding-agent`, repairs / validates the macOS CLI signature when needed, and smoke-tests the packaged CLI. The `afterSign` hook smoke-tests the CLI again after signing.
- Release CI builds macOS `arm64`, macOS `x64`, and Windows `x64` separately and publishes artifacts to `maochiy/Xcode`.

The [Release workflow](./.github/workflows/release.yml) runs on `v*` tag pushes or manual dispatch with `release_tag`. It validates release configuration, runs type and release-flow checks, builds all targets, and verifies packages, blockmaps, and update manifests before publishing. Downloads and future auto-updates use this repository rather than the upstream Proma release channel.

When changing packaging, verify the Pi worker files, unpacked runtime dependencies, compatible `proma` CLI, hooks, and target-architecture artifacts together.

## Contributing

Bug fixes, documentation improvements, tests, UX polish, Skills, MCP configurations, and real-world Agent workflows are welcome.

Before opening a pull request:

- Use Bun scripts and do not add npm / pnpm lockfiles.
- Use Jotai for state management.
- Keep the app local-first and prefer configuration files plus JSON / JSONL storage.
- Do not use TypeScript `any`; prefer `interface` for object shapes.
- When adding IPC, update shared types, the main handler, preload bridge, and renderer calls together.
- Add focused tests where practical, especially for shared logic, IPC contracts, runtime boundaries, and persistence formats.

See [AGENTS.md](./AGENTS.md) for the repository's complete engineering conventions.

## Credits and Upstream Attribution

Xcode is derived from the open-source [Proma project](https://github.com/proma-ai/Proma), originally created by **Erlich Liu** and developed with its contributors. Existing source history, attribution, and copyright notices are retained.

Additional projects credited by the inherited codebase include:

- [Shiki](https://shiki.style/) for code highlighting.
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) for Mermaid diagram rendering.
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio) as inspiration for multi-provider desktop AI products.
- [Lobe Icons](https://github.com/lobehub/lobe-icons) for AI / LLM brand icons.
- [Craft Agents OSS](https://github.com/lukilabs/craft-agents-oss) as an Agent integration reference.

## License

This repository is distributed under the existing [GNU Affero General Public License v3.0 (AGPL-3.0)](./LICENSE). Refer to the repository's `LICENSE` file for the license terms.

This derivative retains the original attribution and copyright notices. This README does not offer a separate commercial license, promise dual licensing, or grant the project maintainers a separate right to relicense contributions. The `LICENSE` file itself has not been changed as part of the Xcode rename.
