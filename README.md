# DocGen

A desktop document editor powered by Claude Code. Create, edit, and manage professional documents with AI assistance — with full access to your filesystem, SharePoint, Outlook, Teams, Jira, and all your Claude Code MCP tools.

## What It Does

- **Chat + Document side-by-side** — Talk to Claude on the left, see your document render live on the right
- **Beautiful artifact rendering** — Documents render like Claude Desktop artifacts with full CSS styling
- **All your MCP tools work** — SharePoint file search, Outlook email sending, Jira integration — everything from your Claude Code setup
- **Save anywhere** — Save documents to your local filesystem or export as .docx / .pdf
- **Multiple sessions** — Work on multiple documents simultaneously with tabbed sessions
- **Version history** — Every edit is versioned. Undo anytime, browse full history
- **C3 AI branding toggle** — One-click to apply C3 brand styling to any document
- **Presentation mode** — Cmd+P for fullscreen document view, perfect for screen-sharing
- **Clone & adapt** — Reuse any document as a template for a new one
- **Send as email** — Draft and send documents via Outlook without leaving the app
- **SharePoint browser** — Search and open SharePoint files directly

## One-Step Install

```bash
git clone https://github.com/c3-jack/docgen.git && cd docgen && npm install && npm start
```

That's it. The app opens automatically.

## Requirements

- **Node.js** (v18+) — [Download](https://nodejs.org/)
- **Claude Code** — Must be installed and authenticated
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude  # Follow auth prompts
  ```

## Usage

### Creating Documents
Just describe what you want in the chat:
- "Create a one-page executive summary about our Cargill engagement"
- "Make a proposal document for the DOE CDM project"
- "Draft an account plan for Nike"

### Editing Documents
Chat naturally to make changes:
- "Make the KPI table bigger and add a row for cost savings"
- "Rewrite the introduction to be more concise"
- "Add a section about competitive advantages"

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| Cmd+N | New document |
| Cmd+S | Save |
| Cmd+F | Find in document |
| Cmd+P | Presentation mode |
| Cmd+Z | Undo last change |
| Cmd+W | Close tab |

### Commands
Type in the chat input:
- `/clear` — Clear chat history, keep the document

### C3 Branding
Click the **C3** button in the document toolbar to toggle C3 AI brand styling. When active, Claude will apply black/white C3 branding to the next document edit.

### SharePoint Integration
- Click the **SharePoint** chip or use the file panel's SharePoint mode to search and open files from your organization's SharePoint sites
- Ask Claude: "Pull the latest Cargill proposal from SharePoint and summarize it"

### Sending Documents
Click the ✉ (envelope) button to draft an email with the document attached, then send via Outlook.

## Building a .dmg (for distribution)

```bash
npm run build
```

Output: `dist/DocGen-1.0.0-arm64.dmg`

Note: Not code-signed. Recipients need to right-click → Open on first launch.

## Architecture

- **Electron** wrapper for native desktop experience
- **Express** server (port 3847) for API + static files
- **SQLite** (sql.js) for persistent sessions, messages, documents, and version history
- **Claude Code CLI** (`claude --print`) as the AI backend — inherits all your MCP servers and tools
- **iframe** document preview with full CSS isolation (Claude's styles don't leak)

## Development

```bash
npm run dev    # Run just the server (opens in browser at localhost:3847)
npm start      # Run as Electron app
npm run build  # Build .dmg
```
