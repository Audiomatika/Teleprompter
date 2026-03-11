# AGENTS.md — Teleprompter (BosePark Productions)

This file provides guidance for agentic coding agents working in this repository.

---

## Project Overview

A real-time teleprompter system built with:
- **Backend**: Python 3.11+ / FastAPI + uvicorn, managed with `uv`
- **Frontend**: Vanilla HTML/CSS/JavaScript (no build step, no bundler)
- **Transport**: WebSocket (`/ws`) for real-time sync between controller and display
- **File handling**: `.docx` files parsed in-memory via `python-docx`

Two client roles:
- **Controller** (`/controller.html`): uploads scripts, controls playback/speed/font/mirror
- **Teleprompter** (`/teleprompter.html`): full-screen display, iPad-optimised

---

## Repository Layout

```
server.py              # FastAPI app — single-file backend
pyproject.toml         # Python project metadata and dependencies
uv.lock                # Locked dependency graph (do not edit manually)
public/
  index.html           # Landing page with QR code
  controller.html      # Controller UI (inline styles + external JS)
  teleprompter.html    # Display UI (inline styles + external JS)
  css/styles.css       # Shared design-system CSS custom properties
  js/controller.js     # Controller WebSocket client logic
  js/teleprompter.js   # Teleprompter WebSocket client logic
  favicon.svg
```

---

## Build / Run Commands

All Python commands use `uv`. There is **no Node.js build step** — the frontend is served as-is.

### Start the server

```bash
uv run python server.py
# or via the declared script entry-point:
uv run teleprompter
```

The server listens on **http://localhost:3000** and serves the `public/` directory as static files.

### Dependency management

```bash
# Install / sync dependencies from uv.lock
uv sync

# Add a new dependency
uv add <package>

# Update the lock file
uv lock
```

### Linting (ruff — must be installed separately as a dev tool)

Ruff is not declared as a project dependency but a `.ruff_cache/` directory is present,
indicating it is used. Install and run via:

```bash
uv tool install ruff        # one-time install
ruff check .                # lint all Python files
ruff check --fix .          # auto-fix fixable issues
ruff format .               # format (black-compatible)
ruff format --check .       # check format without writing
```

### Testing

There is currently no test suite. When adding tests:
- Use `pytest` (install with `uv add --dev pytest`)
- Run the full suite: `uv run pytest`
- Run a single test file: `uv run pytest tests/test_server.py`
- Run a single test by name: `uv run pytest tests/test_server.py::test_function_name`
- Run a single test with output: `uv run pytest -s tests/test_server.py::test_function_name`

---

## Python Code Style (server.py)

### Formatting

- Line length: default ruff/black (88 chars)
- Indentation: 4 spaces
- Strings: double quotes preferred (PEP 8 / ruff default)
- Trailing commas in multi-line collections and function signatures

### Imports

Order (enforced by ruff `isort`):
1. Standard library (`io`, `json`, `os`, `socket`, `pathlib`)
2. Third-party (`docx`, `uvicorn`, `fastapi`, `starlette`)
3. Local (none currently — add here if project grows)

Imports that are not at the top of the file (e.g. the `Request`/middleware import
mid-file in `server.py`) should be refactored to the top when touching that section.

### Type annotations

- Use built-in generics (`dict[str, str]`, `list[dict]`) — Python 3.11+ is the target
- Annotate all function parameters and return types for public functions
- `WebSocket` typed via FastAPI; use `dict` for the clients registry value
- Avoid `Any`; prefer `dict` with a comment or a `TypedDict` for structured dicts

### Naming conventions

| Construct | Convention | Example |
|---|---|---|
| Modules | `snake_case` | `server.py` |
| Functions / coroutines | `snake_case` | `safe_send`, `broadcast` |
| Variables | `snake_case` | `current_script`, `client_ip` |
| Constants | `UPPER_SNAKE_CASE` | `PORT`, `BASE_DIR` |
| Classes | `PascalCase` | `NoCacheJSMiddleware` |
| FastAPI route handlers | `snake_case` async def | `async def upload_file(...)` |

### Error handling

- Use bare `except Exception` only in fire-and-forget helpers like `safe_send` where
  swallowing errors is intentional (always add a comment explaining why)
- Re-raise or log in all other `except` blocks — never silently swallow in business logic
- WebSocket disconnect: catch `WebSocketDisconnect` explicitly; treat it as a normal event
- Always clean up resources in `finally` blocks (e.g. `clients.pop(ws, {})`)
- `print()` is used for server-side logging (no logging framework); prefix with `[WS]`
  or a relevant tag for easy grepping

### Docstrings

- Module-level docstring at top of file (triple double-quoted)
- All public functions get a one-line or multi-line docstring
- Private/helper format: one-line summary is sufficient
- Do not include type information in docstrings — use annotations instead

### Global state

- Module-level globals (`current_script`, `clients`) are acceptable for this single-file
  app. Use `global` declarations when mutating them inside functions.
- New persistent state should also live at module level unless a class is warranted.

---

## JavaScript Code Style (public/js/)

The JS files are vanilla ES2020+, loaded directly by the browser (no bundler/transpiler).

### Formatting

- 2-space indentation
- Single quotes for strings (`'register'`, `'ws:'`)
- Semicolons: present
- Arrow functions preferred for callbacks; named `function` declarations for
  top-level, reusable functions (e.g. `function connect()`, `function sendMessage()`)

### Structure

- Each JS file begins with a JSDoc file-level comment block
- Code is divided into clearly labelled `// ---` comment banner sections:
  `State`, `DOM References`, `WebSocket Connection`, `Message Handlers`,
  `Controls`, `Auto-Scroll`, `Initialise`
- Constants (`SPEED_MIN`, `SCROLL_THROTTLE_MS`) are declared at the top of the
  State section in `UPPER_SNAKE_CASE`
- Mutable state variables (`let`) are declared after constants

### WebSocket messages

All messages use the schema `{ type: string, data?: any }`.

| Prefix | Direction | Meaning |
|---|---|---|
| `control:*` | Controller → Server → Teleprompter | Playback commands |
| `status:*` | Teleprompter → Server → Controller | State updates |
| `script:*` | Server → both clients | Script content events |
| `register` | Client → Server | Role registration |

### Error handling (JS)

- Always wrap `JSON.parse()` in `try/catch`; log with `console.error`
- WebSocket `error` and `close` events must always be handled — update UI state
- Async `fetch` calls use `try/catch` with user-visible error messages
- Never `throw` inside WebSocket event listeners — catch and handle locally

### Naming conventions (JS)

| Construct | Convention | Example |
|---|---|---|
| Variables / functions | `camelCase` | `isPlaying`, `sendMessage` |
| DOM references | `camelCase`, element type implied | `btnPlayPause`, `livePreview` |
| Constants | `UPPER_SNAKE_CASE` | `SPEED_MIN`, `SCROLL_THROTTLE_MS` |
| Event handler params | descriptive | `(event)`, `(e)` for short handlers |

---

## CSS Code Style (public/css/styles.css)

- **CSS Custom Properties** for all colours, radii, and typography — defined in `:root`
- Class naming: `kebab-case` (`.btn-play`, `.status-dot`, `.upload-zone`)
- Shared design tokens live in `styles.css`; page-specific overrides go in inline
  `<style>` blocks within each HTML file
- Dark colour palette: `--bg-primary: #03423f`, accent: `--accent: #00e595`
- Mobile-first responsive with `@media (max-width: 480px)` and `(max-width: 768px)`
- Support iOS safe-area insets with `env(safe-area-inset-bottom)`
- Prefer `transition: all 0.2s ease` for interactive elements

---

## Key Architectural Rules

1. **Static file mount must be last** — all API and WebSocket routes are registered
   before `app.mount("/", StaticFiles(...))`. Never add routes after the mount.
2. **No disk writes** — file uploads are processed fully in-memory (`io.BytesIO`).
   Do not introduce temporary files.
3. **No authentication** — this is a LAN-only tool. Do not add auth complexity.
4. **Single-file backend** — keep all Python logic in `server.py` unless a meaningful
   refactor is warranted (e.g. extracting a `DocxParser` module).
5. **No frontend build tooling** — do not introduce npm, webpack, TypeScript, or any
   compile step. The frontend must remain directly browser-runnable.
6. **JS cache-busting** — `controller.js` is loaded with `?v=N`; bump the version
   query-string when deploying breaking JS changes (the `NoCacheJSMiddleware` handles
   development).
