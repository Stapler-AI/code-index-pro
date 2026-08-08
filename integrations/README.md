# Integrations

Copy-into-target-repo templates for wiring AI agents to the code-index MCP
server. Nothing in this directory is live configuration for *this* repo —
each file is a skeleton to install in a repository you want agents to
navigate. Architecture, setup steps, and the distribution roadmap:
[docs/agent-skills.md](../docs/agent-skills.md). Skill content design and the
benchmark-measured token-gap protocol for these artifacts:
[docs/skills/](../docs/skills/).

| Artifact | Destination in target repo |
|---|---|
| [claude/mcp.json](claude/mcp.json) | `.mcp.json` |
| [claude/skills/code-index/SKILL.md](claude/skills/code-index/SKILL.md) | `.claude/skills/code-index/SKILL.md` |
| [codex/config.toml](codex/config.toml) | Merge into `~/.codex/config.toml` |
| [codex/AGENTS.md](codex/AGENTS.md) | Paste section into the repo's `AGENTS.md` |
