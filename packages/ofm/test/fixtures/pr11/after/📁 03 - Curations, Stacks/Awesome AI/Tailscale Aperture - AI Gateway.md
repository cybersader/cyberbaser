## Key facts

- **Hosted, tailnet-only.** Only devices on your tailnet can reach it. A self-hosted option isn't confirmed.
- **Content visibility.** Tailscale's privacy policy names Aperture as the exception to "Tailscale can't see your traffic". Zero-retention settings stop storage, not processing.
- **Protocols:** Anthropic Messages, OpenAI Chat and Responses, Gemini, Bedrock. It doesn't translate between them.
- **Upstreams:** provider APIs, OpenRouter, or private endpoints on your tailnet.
- **Verified clients** include Claude Code and Codex.
- **Features:**
  - identity from your tailnet login
  - per-user usage tracking and dollar quotas
  - full request/response capture
  - deny-by-default model and connector grants, plus policy hooks
  - MCP connectors that inject credentials, so users never hold the key
  - Aperture Chat, a browser chat and agent interface
- **Subscription passthrough** forwards each client's own login. It doesn't pool accounts.
- **Usage display** shows cost estimates, not remaining subscription allowance.
- **Personal plan** covers up to 6 people.
