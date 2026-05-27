# Genbounty - AI Whitehat LLM Bug Bounty Assistant

**Genbounty LLM Whitehat Assistant** is an open-source toolkit for **AI bug bounty hunting**, **LLM security testing**, and **authorized whitehat assessments** of chatbots, AI agents, and LLM-backed APIs. It helps researchers and bounty hunters move from manual prompt trials to a repeatable pipeline: **generate adversarial tests**, **execute them at scale**, **triage severity**, and **export structured findings** to the [Genbounty](https://genbounty.com) platform.

Use it to hunt **prompt injection**, **jailbreaks**, **system prompt exfiltration**, **sensitive data disclosure**, **indirect injection via file uploads** (PDF, CSV, images, audio), and **agentic/tool abuse**—mapped to playbooks such as **OWASP LLM Top 10**, **OWASP Agentic**, and **MITRE ATLAS**. Tests run through **browser automation** (Playwright) or direct **HTTP API** submission, so you can assess real production UIs and backend chat endpoints the same way a user would.

Unlike static checklists or one-off ChatGPT sessions, this assistant **generates category-aligned attack suites** from security rubrics, captures **prompt/response evidence** per test case, runs **AI-assisted finding assessment** (severity + judge reasoning), and **submits reports** via Genbounty’s security assessment import API—ideal for **bug bounty programs**, **pentest deliverables**, and **ML security regression** before release.

> **Authorized testing only.** Use on targets and programs you are permitted to assess. This tool automates offensive prompts; you are responsible for scope, rate limits, and program rules.

## What it does

| Step | UI tab | Output |
|------|--------|--------|
| **Connect target** | Connect Target | `config.yaml` (selectors or API transport), optional auth |
| **Generate tests** | Generate Tests | Suite JSON under `browser-bot/sites/<host>/<component>/tests/` |
| **Build artifacts** | Payloads | Multimodal files (PDF, CSV, images, audio) via [`payloads/`](payloads/README.md) |
| **Edit suites** | Test Management | In-place edits to categories and prompts |
| **Run tests** | Run Tests | `run_log.json` → `attack_log.json` |
| **Assess findings** | Finding Assessment | `pipeline_report.json` (severity + reasoning per prompt) |
| **Submit** | Submit Findings | POST to Genbounty security assessment import API |

```
connect → generate → (payloads) → run → finding assessment → submit to Genbounty
```

**Scope:** Observable black-box behavior only (prompts, uploads, responses). Test systems you are allowed to assess.

## Who this is for

- **Bug bounty hunters** targeting AI chatbots, agents, and API-backed LLM apps on Genbounty (or similar programs).
- **Whitehats / pentesters** running structured hunts on customer staging with exportable evidence.
- **Appsec / MLsec** doing regression runs per release and comparing `category_rollup` across builds.

## Prerequisites

1. Copy [`.env.example`](.env.example) → `.env` and set `GEMINI_API_KEY` (test generation + finding assessment).
2. Register the target under `browser-bot/sites/<host>/<component>/` via **Connect Target**.
3. Optional: `playbooks/company.json` and `playbooks/component.json` (or per-site copies) for domain-grounded attack generation.
4. For **Submit Findings**: `GENBOUNTY_HOST`, `GENBOUNTY_API_KEY`, and a program `user_id` (see [api-security-export.md](api-security-export.md)).

## Requirements

- Python 3.10+
- Chromium (Playwright). On first run, `start.py` installs Playwright’s Chromium automatically.

## Quick start (web UI)

```bash
python start.py
```

Open **http://localhost:8000**. Workflow in the sidebar:

1. **Connect Target** - browser discovery or API probe; saves `config.yaml`.
2. **Generate Tests** - pick playbook + strategy; suites saved to the component `tests/` tree.
3. **Run Tests** - execute suite; live browser screenshots and results table.
4. **Finding Assessment** - judge severity (`indeterminate` … `critical`); writes `pipeline_report.json`.
5. **Submit Findings** - export one report or batch (last 1h / 4h / 24h) to Genbounty.

## Local test target

```bash
python test-target/app.py
```

Use site `localhost:3000`, component `chat` (or `main` per your setup). See [test-target/README.md](test-target/README.md).

## Security playbooks

Playbooks define categories, `exploited_if` / `mitigated_if` triggers, and assessment rubrics.

| Playbook | File | Focus |
|----------|------|--------|
| OWASP LLM | `playbooks/owasp_llm.json` | LLM01–LLM10 |
| OWASP Agent | `playbooks/owasp_agent.json` | ASI01–ASI10 |
| MITRE ATLAS | `playbooks/mitre_attack.json` | ML kill-chain tactics |
| Jailbreak Core | `playbooks/jailbreak_core.json` | DAN, encoding, injection, crescendo |
| System Prompt Exfil | `playbooks/system_prompt_exfil.json` | SPL01–SPL10 |
| Prompt Injection | `playbooks/prompt_injection.json` | PI01–PI10 |
| API Secrets / Sensitive Info | `playbooks/api_secrets_disclosure.json`, `sensitive_info_disclosure.json` | Disclosure vectors |
| Test (lab) | `playbooks/test.json` | Validation / monitoring scenarios |
| ~~Multimodal Injection~~ | `playbooks/multimodal_injection.json` | **Deprecated** - use strategy `multimodal` + a security playbook |

Generate a custom playbook from a topic (UI **+ New playbook** or CLI `playbook-generator`).

## Strategies

| Strategy | Role |
|----------|------|
| `zero_shot` | Single-message attacks (detection floor) |
| `multi_shot`, `few_shot`, `iterative`, `prompt_chaining` | Multi-turn / shaped pressure |
| `jailbreak` | Jailbreak-focused techniques |
| `multimodal` | File-upload tests (`vector_type` + payload generators) |
| `chain_of_thought`, `tree_of_thoughts`, `self_reflection`, etc. | Additional adversarial shaping |

Default playbook: **`owasp_llm`**.

## Multimodal / file-upload hunts

**Multimodal is a delivery method**, not a separate taxonomy. Use strategy `multimodal` with any security playbook. Prompts can include `vector_type`, benign `prompt`, and `payload` (`generator`, `args`).

```bash
python scripts/apply_advanced_multimodal_suite.py --playbook owasp_llm --materialize
python main.py generate --strategy multimodal --playbook owasp_llm
python main.py run generate-tests/multimodal/owasp-llm.json --site HOST --component COMPONENT --assess
```

Discovery records **file upload** (`type: file` + `path_from: payload`) and API modes **`api_document`** / **`api_multipart`**. `attack_log.json` includes `vector_type` and `artifact_path` where applicable.

## CLI (optional)

Same pipeline without the UI:

```bash
python main.py generate --strategy zero_shot --playbook owasp_llm --site localhost:3000 --component chat
python main.py run browser-bot/sites/localhost:3000/chat/tests/zero-shot/owasp-llm.json \
  --site localhost:3000 --component chat --assess
python main.py security-assess path/to/attack_log.json
python main.py export path/to/pipeline_report.json
```

Subcommands: `generate`, `discover`, `run`, `security-assess`, `export`.

## Artifacts

| File | When |
|------|------|
| Suite JSON | After generate - `playbook`, `playbook_id`, `categories[].prompts[]` |
| `run_log.json` | Raw run capture |
| `attack_log.json` | Normalized log for assessment |
| `pipeline_report.json` | After finding assessment - `adversarial_results[]`, optional `category_rollup` |

Export maps `pipeline_report.json` → Genbounty **`/api/v2/security-assessments/import`** (batched, default 25 results per POST). See [api-security-export.md](api-security-export.md) for the HTTP contract and env vars (`GENBOUNTY_*`).

## Configuration

| Source | Purpose |
|--------|---------|
| [`.env`](.env) | `GEMINI_API_KEY`, `GENBOUNTY_HOST`, `GENBOUNTY_API_KEY`, `GENBOUNTY_USER_ID`, export tuning |
| [`.config`](.config) | `GEMINI_MODEL`, `GEMINI_JUDGE` |
| `config.defaults.yaml` | Global browser-bot defaults |
| `browser-bot/sites/<site>/<component>/config.yaml` | Per-target selectors, API URL, settings overrides |

## Project layout

- `start.py` - Bootstrap venv and launch web UI
- `main.py` - CLI entrypoint
- `web/` - FastAPI backend + SPA (Genbounty-branded UI)
- `generate-tests/` - Attack generation (`core.py`, `strategies/`, `playbook_generator.py`)
- `browser-bot/` - Playwright / API test runner
- `risk-level-agent/` - Playbook experts + judge for finding assessment
- `pipeline/` - `convert_log.py`, `security_assess.py`, `export_security.py`, `response_html.py`
- `playbooks/` - Security playbooks and templates
- `payloads/` - Multimodal artifact generators
- `test-target/` - Local vulnerable assistant for lab runs

## Authorization

Use only on targets and programs you are permitted to test. This toolkit automates offensive prompts and exports findings; you are responsible for scope, rate limits, and program rules.
