# Reproducible local environments

Part 4 supports Node.js 24.15.0 with npm 11.12.1 and Python 3.13.7. The versions
are pinned in `.node-version`, `.nvmrc`, `.python-version`, and `package.json`.
Node packages are locked by `package-lock.json`. Python packages are locked by
`uv.lock`; uv itself is pinned to 0.12.18 and is installed inside the repository
virtual environment rather than globally.

The Python project has three groups:

- Runtime (`project.dependencies`) is empty because the current worker is the
  existing TypeScript scaffold.
- Development contains exact versions of uv, Black, mypy, Bandit, pip-audit,
  pre-commit, pytest, and SQLFluff.
- Training is empty and is not installed by setup or CI. Training dependencies
  may be added only when a later workflow part defines training code.

After installing the pinned Node and Python versions, setup is the same in
PowerShell and POSIX shells:

```console
npm run setup
```

The command validates both runtimes, installs Node packages with
`npm ci --ignore-scripts`, creates `.venv`, installs the pinned uv bootstrap in
that virtual environment, and runs `uv sync --locked` for the development group
without the training group. It does not read `.env`, start Docker, or contact a
production service.

## Command surface

| Purpose                | Command                  | Part 4 behavior                                                                      |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| Setup                  | `npm run setup`          | Installs locked Node and Python development dependencies                             |
| Full check             | `npm run check`          | Runs local quality, mock integration, configuration, container, and repository scans |
| Sample processing      | `npm run sample`         | Runs the deterministic synthetic candidate sample                                    |
| Dashboard start        | `npm run dashboard`      | Returns exit 2 with a later-part prerequisite message                                |
| Database reset         | `npm run db:reset`       | Returns exit 2 with a later-part prerequisite message                                |
| Migration              | `npm run db:migrate`     | Returns exit 2 with a later-part prerequisite message                                |
| Documentation build    | `npm run docs:build`     | Builds a deterministic Markdown hash manifest under ignored `build/`                 |
| Schema type generation | `npm run types:generate` | Returns exit 2 until database or API schemas exist in a later part                   |

The deferred commands are intentional guards. They do not invent a dashboard,
database, migration, or Part 5 schema. Windows needs no separate wrapper because
all commands are cross-platform Node scripts invoked through npm.

## Local integration and container

`npm run integration:mock` runs without Docker, network access, credentials,
coordinates, external data, or model weights. It asserts that the synthetic
result remains `uncertain`, has `pending_manual_review`, and has no coordinates.

The optional worker image is a one-shot container for the same deterministic
sample:

```console
docker compose config
docker compose build worker
docker compose run --rm worker
```

The Compose service has no network, port, background service, or restart loop.
It uses a read-only filesystem, a small temporary filesystem, no Linux
capabilities, and `no-new-privileges`. The worker is not a long-running service,
so the Dockerfile explicitly has no health check. Ordinary setup, checks, and
sample processing do not require Docker.

## Generated types

`npm run types:generate` is present so a later database or API schema can become
the single source of generated TypeScript types. No applicable schema exists in
Part 4, so the command returns an intentional prerequisite result and writes
nothing. The existing Part 3 candidate interfaces are preserved rather than
replaced with invented Part 5 contracts.
