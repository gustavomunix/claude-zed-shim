# Claude Zed Shim v2 — Execution Index

**Spec:** `docs/superpowers/specs/2026-11-09-claude-zed-shim-v2-design.md`

## Ordem

| Fase | Plano | Entrega | Gate |
|---|---|---|---|
| 1 | `2026-11-09-claude-zed-shim-foundation.md` | Storage atômico, Node/CI, snippets Zed/OpenCode, LaunchAgent por porta, docs | `npm run verify`; `install-mac.sh` dry-run com duas portas |
| 2 | `2026-11-09-claude-zed-shim-session-engine.md` | Resume, rewind, fork, transcript ausente, bridge cleanup | Testes de sessão + teste HTTP com fake SDK |
| 3 | `2026-11-09-claude-zed-shim-protocol-and-tools.md` | Usage, finish_reason, narração, annotations, coerção, CLAUDE.md, meta requests | Testes de protocolo + opções capturadas |
| 4 | `2026-11-09-claude-zed-shim-hardening.md` | Debug log, porta, turno interrompido, verificação real, release 0.2.0 | Matrix `docs/verification.md` + `npm run verify` |

## Dependências

- Fase 2 depende da Fase 1 apenas para `json-file.ts`.
- Fase 3 depende da Fase 2 para o seam de query e testes HTTP.
- Fase 4 depende de todas.

## Fora de ordem

Não iniciar Fase 2 antes de a Fase 1 ter `npm run verify` verde. O port de sessão usa `writeJsonFileAtomic`; sem isso, os testes de crash não têm base.

## Critério de pronto

- Duas contas no Zed com providers 8124/8125.
- OpenCode nativo + provider do shim; snippet `--format opencode` válido.
- `sessions.json` separado por conta e escrita atômica.
- Resume/rewind/fork com testes.
- Usage/finish no chunk final SSE.
- Ferramentas read-only paralelas, coerção e descrições completas.
- `CLAUDE.md` carregado.
- Title/summary/commit sem sessão persistente.
- Debug log, CI, lockfile, release 0.2.0.
