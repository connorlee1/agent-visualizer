Captured from the published `@moonshot-ai/kimi-code@0.43.1` Node CLI (wire 1.5),
using a local OpenAI-compatible mock endpoint. The model requested
`Bash({command: "printf kimi-fixture"})`, then returned a text reply.
No account credentials or external model requests were used.

The fixture retains conversation/lifecycle records and model identity. Request
traces and other bookkeeping were omitted, injected context text replaced with
a placeholder, and the temporary working directory normalized. `state.json`
uses the same normalized directory. These fixtures exercise the actual Node
format, rather than the unrelated legacy Python CLI format.
