import { DEFAULT_RELAY_PI_ENV_FILE, SUPPORTED_API_KEYS } from "./shared.js";

/**
 * How many trailing user-turn exchanges to render when resuming a session.
 * Each exchange is the user prompt plus the assistant reply (text, reasoning,
 * and tool blocks) that followed it; assistant blocks before the first user
 * message in the kept window are dropped along with everything older.
 */
export const DEFAULT_RESUME_HISTORY_MESSAGES = 5;

export function printRunHelp(): void {
  console.log(`
relay-pi — An opinionated full-stack agent runner (CLI: relay-pi)

USAGE
  relay-pi [options] [prompt]
  relay-pi connect [--status [--json] | --disconnect <provider>]
  relay-pi env [--env-file <path>] [--import [path]|--keys]
  relay-pi skills [--workdir <path>]
  relay-pi memory [--db <path>] [--json] [filters]
  relay-pi upgrade [--manager npm|bun|pnpm|yarn]
  echo "prompt" | relay-pi

COMMANDS
  connect                  Show or remove connected ChatGPT and GitHub Copilot subscriptions
  env                      Manually create or update the shared Relay Pi env file with provider API keys
  skills                   List installed skills + collisions as JSON
  memory                   Browse memories in a TUI, or query them with --json/filters (alias: memories)
  route                    Probe the live virtual-model classifier (relay-pi route "<prompt>")
  config export            Write the built-in routing table to .relay-pi/models.json for tweaking
  upgrade                  Upgrade the global installation (disabled until relay-pi is published)

OPTIONS
  -m, --model <name>       Virtual tier (frontier|balanced) or concrete model pin
  --memory-model <name>    Observational memory model (default inferred from provider env)
  --provider <name>        Pin the provider and use its catalog default model.
                            Accepts: openrouter.
                            Mutually exclusive with --model / --memory-model.
  -i, --incognito          Keep memory in-process; do not read or write durable memory
  --db <path>              Memory database path (default: ~/.relay-pi/memory.db); ignored under --incognito
  -w, --workdir <path>     Working directory (default: cwd)
  -r, --resume <id>        Resume a saved session
  --resume-history-messages <n>
                            Replay the last n user-turn exchanges from the prior session in the TUI (default: ${DEFAULT_RESUME_HISTORY_MESSAGES})
  --system-prompt <text>   Additional system instructions for the runner
  --system-prompt-file <path>
                            Load a file into the system prompt; repeatable
  --no-system-prompt-files Disable default AGENTS.md system prompt loading
  --env-file <path>        Shared env file to load after <workdir>/.env (default: ${DEFAULT_RELAY_PI_ENV_FILE})
  --no-auto-upgrade         No-op; auto-upgrade is disabled until relay-pi is published
  --rpc                     Bare turn-runner control surface. Reads newline-delimited RpcRunnerCommand
                            JSON from stdin and writes RpcEvent JSON to stdout. Prompt, answer, and wake
                            commands require requestId and emit command_accepted after runner delivery.
                            The first command must be "start"; the process exits after the single turn
                            reaches its terminal event. Bypasses session persistence entirely.
  --session <id>            (--rpc only) Attribute memory written during the process to this caller-owned
                            session id. One RPC process is one logical session; omit to write with no id.
  -v, --version            Print the installed relay-pi version and exit
  -h, --help               Show this help

INTERACTIVE
  In a TTY, relay-pi keeps one local session open after terminal events.
  Type /exit or /quit to end the conversation. Type @ followed by a
  filename to insert a repo-relative path into the prompt.

MODELS
  The default is the routed frontier tier. Use frontier or balanced
  to select a routing policy, or a concrete shorthand to bypass routing and pin.
  Concrete names include opus, sonnet, haiku, and sol (versionless families), or versioned forms like sonnet-4.6.
  They resolve through OpenRouter, or through a connected ChatGPT/Copilot plan
  when one covers the model.
  Full provider:modelId syntax is also supported, e.g. openrouter:z-ai/glm-5.3.
  --provider pins the router's concrete default; the memory model remains concrete.

EXAMPLES
  relay-pi "build a REST API with Express and TypeScript"
  relay-pi -m sol "analyze the performance of our test suite"
  relay-pi --memory-model sonnet-4.6 "summarize this repo"
  relay-pi --provider openrouter "explain this codebase"
  relay-pi -m opus-5.5 "refactor the auth module"
  relay-pi --system-prompt "Prefer concise answers." "review this repo"
  relay-pi --system-prompt-file TEAM.md "review this repo"
  relay-pi --env-file ~/.config/relay-pi/env "review this repo"
  relay-pi --workdir ./my-project "refactor the auth module"
  relay-pi --resume session_abc123 --workdir ./my-project
  relay-pi env
  relay-pi memory
  relay-pi train ./docs/my-project
  relay-pi upgrade
`);
}

export function printConnectHelp(): void {
  console.log(`
relay-pi connect — Manage connected model-provider subscriptions

USAGE
  relay-pi connect <chatgpt|copilot> [--device-code] [--no-browser] [--json]
  relay-pi connect --status [--json]
  relay-pi connect --disconnect <chatgpt|copilot> [--json]

OPTIONS
  --device-code            Force device-code login (the only VM-valid mode)
  --no-browser             Do not open the verification URI automatically
  --status                 List connected providers
  --json                   Stream login/disconnect events as NDJSON; status stays an envelope
  --disconnect <provider>  Remove stored credentials for chatgpt or copilot
  -h, --help               Show this help
`);
}

export function printEnvHelp(): void {
  console.log(`
relay-pi env — Create or update a shared Relay Pi env file

USAGE
  relay-pi env [--env-file <path>] [--import [path]|--keys]

Use \`relay-pi env\` to control which provider API keys land in the shared env file.

By default, env only prints this help. Choose --import to copy
provider keys from cwd .env or a provided env file, or --keys to paste keys interactively.

OPTIONS
  --env-file <path>        Env file to write (default: ${DEFAULT_RELAY_PI_ENV_FILE})
  -i, --import [path]      Import cwd .env, or import the provided env file
  --keys                   Prompt for supported provider API keys
  -h, --help               Show this help

SUPPORTED KEYS
  ${SUPPORTED_API_KEYS.join(", ")}
`);
}

export function printSkillsHelp(): void {
  console.log(`
relay-pi skills — List installed skills as JSON

USAGE
  relay-pi skills [--workdir <path>]

OPTIONS
  -w, --workdir <path>     Working directory for project-local skills (default: cwd)
  -h, --help               Show this help

OUTPUT
  Prints a JSON object with two keys:
    skills       Array of installed skills. Each entry has:
                   name         Skill name
                   description  Skill description (from frontmatter)
                   path         Absolute path to the skill directory
                   scope        "user", "project", "temporary", or "builtin"
    collisions   Array of name conflicts resolved during discovery.
                 Each entry has: name, winnerPath, loserPath.
`);
}

export function printMemoryHelp(): void {
  console.log(`
relay-pi memory — Browse, query, edit, and delete observational memories

USAGE
  relay-pi memory [--db <path>] [--wait <seconds>]
  relay-pi memory [--json] [--type <kind>] [--priority <level>] [--source <origin>]
              [--session <id>] [--from <date>] [--to <date>]
  relay-pi memory reflect [options]

ALIASES
  relay-pi memories

DESCRIPTION
  Bare \`relay-pi memory\` opens an interactive TUI to browse, edit, and delete
  durable observations. Passing --json or any filter flag instead runs a
  non-TUI, scriptable query: it prints a flat, chronological list (newest
  createdAt first) of the matching observations. In table mode each row shows
  a computed \`score\` matching the runner's global-pack ranking; --json emits
  a machine-readable array of canonical memory objects (ISO timestamps, flat
  \`source\` string, echoed \`sessionId\`, and that score as \`packScore\`).

  Examples:
    relay-pi memory
    relay-pi memory --json --type reflection --from 2026-06-26
    relay-pi memory --json --from "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)"

SUBCOMMANDS
  add                      Write a single user-added note memory
                           (run \`relay-pi memory add --help\` for add-specific options)
  recall <query>           Hybrid semantic + keyword search over durable memory,
                           the same pipeline the runner's recall_memory tool uses
                           (run \`relay-pi memory recall --help\` for recall-specific options)
  reflect                  Condense old global observations into reflection rows
                           (run \`relay-pi memory reflect --help\` for reflect-specific options)

QUERY OPTIONS
  --json                   Emit a JSON array instead of a table (also enables query mode)
  --type <kind>            Filter by kind: observation | reflection | note | manual
  --kind <kind>            Alias for --type
  --priority <level>       Filter by priority: high | medium | low
  --source <origin>        Filter by source: user | agent | system | api | import
  --session <id>           Filter to rows authored by this session id
  --from <date>            Inclusive lower bound on createdAt. Accepts
                           YYYY-MM-DD (start of day UTC) or YYYY-MM-DDTHH:MM:SS (UTC)
  --to <date>              Inclusive upper bound on createdAt. Accepts
                           YYYY-MM-DD (end of day UTC) or YYYY-MM-DDTHH:MM:SS (UTC)

OPTIONS
  --db <path>              Memory database path (default: ~/.relay-pi/memory.db)
  --wait <seconds>         Seconds to wait for the cross-process open-lock when a peer
                           relay-pi process is holding it (default: 30; 0 fails immediately)
  -h, --help               Show this help

KEYS (TUI)
  ↑ / ↓                    Move selection
  e                        Edit selected memory in $EDITOR
  d                        Delete selected memory
  q / Esc                  Quit
`);
}

export function printMemoryAddHelp(): void {
  console.log(`
relay-pi memory add — Write a single user-added note memory

USAGE
  relay-pi memory add [options] [--store <folder> | --db <file>] <content>
  echo "<content>" | relay-pi memory add [options] [--store <folder> | --db <file>]

DESCRIPTION
  Stores a note in exactly one backend. With no backend flag, the note is
  written to the nearest ancestor .agents/memories directory (created on
  demand). --store writes a markdown memory file; --db retains the legacy
  observational-row behavior. Passing more than one backend is a usage error.

  Content comes from the positional arguments, or from stdin when none are
  given so longer memories can be piped in.

OPTIONS
  --priority <level>       high, medium, or low (default: medium)
  --source <origin>        user, agent, system, api, or import (default: user)
  --session <id>           Stamp the row's authoring session; omit to leave it
                           global/unattributed
  --tag <tag>              Attach a label; repeat to add several
  --store <folder>         Memory-file directory to write
  --db <file>              PGlite file to write instead of a memory store
  --json                   Emit the stored memory as JSON instead of the
                           confirmation line (DB rows include packScore;
                           file rows include slug + store provenance)
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
`);
}

export function printMemoryRecallHelp(): void {
  console.log(`
relay-pi memory recall — Hybrid semantic + keyword search over durable memory

USAGE
  relay-pi memory recall [options] [--query <q> | <query...>]

DESCRIPTION
  Searches ~/.relay-pi/memory.db with the exact pipeline the runner's
  recall_memory tool uses: vector (embedding) search and keyword search run
  in parallel and merge via Reciprocal Rank Fusion, so fuzzy paraphrases and
  exact tokens (proper nouns, IDs, code symbols) both match. Results print
  best-match first.

  Embeddings use OpenRouter (OPENROUTER_API_KEY). When it is unavailable the
  vector path is skipped and recall falls back to keyword-only, flagged in the
  output. --expand adds model-generated paraphrases before fusion for vague
  queries, at the cost of an extra model call.

  Examples:
    relay-pi memory recall wire byte budget cap
    relay-pi memory recall --expand "how does the gateway race resolve"
    relay-pi memory recall --scope global --session <id> --json qwiklabs

OPTIONS
  --query <q>              Search text (alternative to positional <query>;
                           both are accepted and combine)
  --scope <scope>          session | global | all (default: all).
                           session/global require --session <id>
  --session <id>           Session id to compare against for --scope session/global
  --limit <n>              Maximum fused results to return (default: 8)
  --expand                 Also run model-generated paraphrases before fusion
  --model <name>           Model used for --expand paraphrases (default: cheap CLI memory model)
  --json                   Emit a bare JSON array of canonical memory objects
                           (best-first) with packScore + relevanceScore
  --db <path>              Memory database path (default: ~/.relay-pi/memory.db)
                           This command is DB-only; --store is rejected because
                           store memories are already loaded into agent context
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
`);
}

export function printMemoryReflectHelp(): void {
  console.log(`
relay-pi memory reflect — Condense old global observations into reflection rows

USAGE
  relay-pi memory reflect [--db <path>] [--dry-run] [--min-age-days <n>]
                      [--target-tokens <n>] [--model <name>]
                      [--effective-context <tokens>] [--wait <seconds>]

DESCRIPTION
  Walks the durable memory store and folds older content into atomic
  global reflection rows that downstream recall can rank, decay, and
  refresh independently.

  Eligible input includes raw observations AND single-blob local
  reflections (the per-session reflections written automatically when a
  session crosses its local memory budget). Global reflection rows from
  prior \`relay-pi memory reflect\` runs are preserved verbatim — re-reflecting
  them would only collapse them into vaguer text. Fresh rows younger
  than --min-age-days (default 3) are also preserved so resumed sessions
  keep their recent local memory intact.

  Batches are packed up to one reflection trigger's worth of tokens and
  sequenced chronologically across sessions for cross-session dedup. Use
  --dry-run to preview without writing.

OPTIONS
  --db <path>              Memory database path (default: ~/.relay-pi/memory.db)
  --dry-run                Print the reflected log without writing it back
  --min-age-days <n>       Skip observations newer than this many days
                           (default: 3)
  --target-tokens <n>      Override the reflected log token budget per batch
  --model <name>           Memory model used for reflection (default: env / CLI default)
  --effective-context <n>  Effective context window used to derive memory budgets
                           (default: 200000)
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help
`);
}

export function printTrainHelp(): void {
  console.log(`
relay-pi train — Ingest a project corpus into one durable memory observation

USAGE
  relay-pi train <folder> [--slug <name>] [--model <name>]
             [--store <folder> | --db <file>] [--wait <seconds>]
  relay-pi train list [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  relay-pi train show <slug> [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  relay-pi train update <slug> --content-file <path>
             [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]
  relay-pi train delete <slug> [--store <folder>]... [--db <file>]... [--json] [--wait <seconds>]

DESCRIPTION
  Launches a relay-pi agent with the corpus folder as its working directory.
  The agent reads the corpus using its native file-reading tools (any
  format the relay-pi agent normally reads — markdown, plain text, CSVs, PDFs,
  spreadsheets, source code) and writes a single handoff file at the
  corpus root:

    .relay-pi-train.json  — structured handoff with headline + observation.

  'train' then persists the synthesis into exactly one backend and archives
  the corpus under ~/.relay-pi/train/<memory-id>/. With no backend flag it writes
  a markdown file under the nearest ancestor .agents/memories directory,
  creating that directory when needed. --db retains the legacy manual-row
  behavior. Passing more than one backend to create is a usage error.

  Reads accept repeatable --store and --db flags. Any explicit backend flags
  replace discovery; stores are consulted in flag order before DBs. Without
  flags, reads union inherited stores from cwd toward the filesystem root,
  then ~/.relay-pi/memory.db. Duplicate slugs resolve to the first source, while
  surviving entries are listed newest-first. show/update/delete use that same
  first-source precedence.

  The management subcommands all key on the user-facing <slug> (resolved
  to the underlying row internally):
    list    — every visible store entry or DB training (one row per slug),
              joined to its archive
              manifest to show slug, headline, model, file count, date,
              and memory id.
    show    — the same metadata plus the full synthesized observation text
              and (with --json) the archived files' absolute paths.
    update  — replace just the observation text from --content-file, in
              place; the corpus archive is preserved untouched. Use this to
              hand-correct a memory without re-running synthesis (re-running
              'relay-pi train <folder> --slug <slug>' is the re-synthesis path).
    delete  — permanently remove the row and its corpus archive.
  Pass --json to any of them for machine-readable output.

  Subsequent runs against the same slug replace the prior target entry, so
  the memory pool does not bloat. On --db, the legacy manual row keeps its
  ranking boost and reflection exemption. Note: train loads the corpus
  folder's .env (for provider credentials), so check folders you did not
  author before training.

OPTIONS
  --slug <name>            Override the corpus slug (default: sanitized folder basename)
  --model <name>           Model used by the synthesis sub-agent (default: same resolution as 'relay-pi run')
  --store <folder>         Memory-file directory; repeat on read/manage commands
  --db <file>              PGlite path; repeat on read/manage commands
  --wait <seconds>         Seconds to wait for the cross-process open-lock
                           (default: 30; 0 fails immediately)
  -h, --help               Show this help

EXAMPLES
  relay-pi train ./docs/my-project
  relay-pi train ./research --slug acme-research --model sonnet-4.6
  relay-pi train list
  relay-pi train list --json
  relay-pi train show acme-research
  relay-pi train update acme-research --content-file ./edited.md
  relay-pi train delete acme-research
`);
}

export function printUpgradeHelp(): void {
  console.log(`
relay-pi upgrade — Upgrade the global installation (disabled until relay-pi is published)

USAGE
  relay-pi upgrade [--manager npm|bun|pnpm|yarn] [--version <version>] [--force]

OPTIONS
  --manager <name>         Package manager to use (default: detected, fallback: npm)
  --version <version>      Install an exact version instead of npm's latest dist-tag
  --dry-run                Print the upgrade command without running it
  --force                  Upgrade even if another relay-pi CLI is using the memory db
                           (risks corrupting the db while npm rewrites node_modules)
  -h, --help               Show this help
`);
}
