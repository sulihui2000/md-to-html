# Markdown HTML Blog

Static blog publisher for Obsidian Markdown notes.

## Setup

1. Copy `blog.config.example.json` to `blog.config.json`.
2. Set `obsidianVaultRoot` to your Obsidian vault path.
3. Run `npm install`.

## Commands

```bash
npm run publish
npm run build
```

`npm run publish` publishes only top-level Markdown files in the configured drafts folder with `status: ready`.

`npm run build` regenerates `dist/` from the configured published folder.
