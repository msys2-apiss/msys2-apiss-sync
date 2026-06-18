# Agent guide: msys-uwp-sync

This repository builds cross-platform PowerShell tooling to replay upstream
MSYS2 package history into `msys2-uwp/msys2-uwp`.

## Read first

- [docs/PLAN.md](docs/PLAN.md) - architecture, triggers, phases
- [.cursor/rules/](.cursor/rules/) - coding and workflow conventions

## Key facts

- **Sources**: `msys2/MSYS2-packages` -> `ports/`, `msys2/MINGW-packages` -> `ports-mingw/`
- **Destination**: `msys2-uwp/msys2-uwp`, branch `upstream`
- **Base commit**: `6fc20894663468a04dd4986a8b1c15a9d5ae8649` (parent of first replayed commit)
- **Strategy**: deterministic date-ordered replay; same SHAs on every rebuild at same pins
- **Triggers**: GitHub Actions every 5 minutes (poll upstream SHAs) + daily reconciliation
- **Runtime**: PowerShell 7+ (`pwsh`); scripts must work on Windows, Linux, and macOS
- **State**: `.sync/state.json` tracks cursors and manifest (verify/rebuild)

## Do not

- Use `git merge` of entire upstream repos into destination (use replay instead)
- Add Windows-only APIs (`Get-WmiObject`, registry, etc.) in shared scripts
- Commit PATs or tokens; use GitHub Actions secrets only
- Modify upstream `msys2/*` repositories from this project

## Typical tasks

| Task | Location |
|------|----------|
| Sync logic | `scripts/Sync-*.ps1`, `scripts/lib/` |
| Config | `config/sync.json` |
| Replay cursors + manifest | `.sync/state.json` (this repo, committed) |
| CI | `.github/workflows/` |
| Design changes | update `docs/PLAN.md` first |
