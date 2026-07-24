# Nextra CSO Hub — Atualização Full Version 1.0

## O que é este pacote

Atualização do Nextra CSO Hub cobrindo: correção da causa raiz do "Failed to fetch" no
login, campos novos em Chamados (quantidade/grupo/marca), NF obrigatória, edição de
chamados abertos com histórico por campo, exportação Excel, o novo módulo **Kanban dos
Chamados**, correções em Reclamações, o fluxo transacional **Devolução → Inspeção →
RMA**, finalização da integração de IA (triagem e plano de recuperação), reforços de
segurança e uma suíte de testes automatizados real.

**O escopo, a arquitetura, o visual e todos os módulos existentes do SRS Full Version
1.0 foram preservados integralmente.** Nada foi removido, simplificado ou substituído
por mock.

## Como aplicar esta atualização

1. **Faça backup do banco de produção antes de continuar.** Nenhuma migration anterior
   foi alterada e nenhum dado é apagado, mas backup é sempre a prática correta antes de
   qualquer deploy com migration nova.
2. Suba os arquivos deste pacote na raiz do repositório GitHub, substituindo os
   existentes.
3. O deploy no Railway (`node startup.js`) vai rodar a migration
   `010_operational_flow_enhancements.sql` automaticamente — ela é aditiva, idempotente
   e seguro rodar múltiplas vezes.
4. Confirme no log de deploy que a migration 010 aplicou com sucesso (procure por
   `✓ 010_operational_flow_enhancements.sql`).
5. Siga o `CHECKLIST_VALIDACAO_FULL_V1.md` para validar cada módulo manualmente em
   produção.

## Variáveis de ambiente novas ou relevantes

| Variável | Obrigatória? | Descrição |
|---|---|---|
| `JWT_SECRET` | **Sim, em produção** | O servidor agora recusa iniciar em produção (`NODE_ENV=production`) sem um `JWT_SECRET` próprio configurado — não usa mais o valor padrão de desenvolvimento silenciosamente. |
| `ALLOWED_ORIGINS` | Recomendado | Lista de origens permitidas por CORS, separadas por vírgula (ex: `https://seu-dominio.com`). Se não configurada, o CORS aceita qualquer origem (comportamento anterior, com aviso no log). |
| `ANTHROPIC_API_KEY` | Não | Habilita a Triagem por IA e a Sugestão de Plano de Recuperação por IA. Sem ela, os dois recursos ficam claramente desabilitados na interface, sem quebrar nada. |
| `ANTHROPIC_MODEL` | Não | Modelo da Anthropic a usar (default: `claude-sonnet-4-6`). Nunca fica hardcoded no código. |
| `AI_TIMEOUT_MS` | Não | Timeout das chamadas de IA em milissegundos (default: `15000`). |
| `REDIS_URL` | Não | Se configurada, habilita invalidação real de sessão no logout (blocklist de token). Sem ela, o logout funciona normalmente no app, mas o token tecnicamente permanece válido até expirar sozinho — limitação conhecida de JWT sem camada de blocklist. |

## O que mudou — resumo por área

Veja `CHANGELOG_FULL_V1.md` para a lista completa e detalhada. Resumo executivo:

- **Login "Failed to fetch"**: investigado a fundo — reproduzi o fluxo completo contra
  Postgres real e o login funcionou corretamente em todos os cenários testados (com e
  sem Redis, com Redis instável). Não consegui reproduzir o erro exato relatado.
  Apliquei, mesmo assim, as correções defensivas mais prováveis (listener de erro do
  Redis, tratamento de erro HTTP correto no backend, mensagem de erro amigável no
  frontend) — ver limitações abaixo.
- **Chamados**: quantidade, grupo do produto e marca em todo o ciclo de vida; NF
  obrigatória (com identificação de legado para dados antigos); edição de chamados
  abertos com histórico por campo alterado; exportação Excel; bloqueio real de
  transições de status inválidas no backend (fonte de verdade para o Kanban).
- **Kanban dos Chamados**: módulo novo, com persistência real via API, filtros e
  bloqueio de transições inválidas.
- **Reclamações**: corrigido bug real onde a Torre de Controle usava um campo que não
  existe em reclamações; motivo agora aparece na listagem; cliente agora é
  centralizado (dropdown + cadastro rápido) em vez de texto livre.
- **Devolução → Inspeção → RMA**: fluxo transacional completo e testado —
  encerramento da Devolução só ocorre após a criação bem-sucedida do RMA; RMA duplicado
  é bloqueado; falha no meio do processo mantém a Devolução aberta.
- **IA**: modelo e timeout configuráveis via variável de ambiente, validação de tipos
  retornados, indicação clara na interface quando não configurada.
- **Segurança**: `JWT_SECRET` obrigatório em produção, CORS restrito a origens
  configuradas, invalidação real de logout via Redis (quando disponível).

## Limitações conhecidas (honestas, sem inflar)

- **Não foi possível reproduzir o erro exato "Failed to fetch"** relatado — apenas as
  causas mais prováveis foram endereçadas defensivamente. Se o problema persistir após
  esta atualização, **por favor capture o erro exato no Console do navegador (F12) no
  momento em que ele ocorre** e nos envie — isso permite diagnóstico preciso.
- Testes de IA usam chamadas simuladas (mock de `fetch`) — **nenhuma chamada real foi
  feita à API da Anthropic** neste processo de validação, por não haver uma chave de
  API real disponível no ambiente de teste.
- O drag-and-drop do Kanban foi validado via revisão de código e teste de sintaxe, mas
  **não foi testado em um navegador real** — este ambiente de validação não possui
  acesso a um navegador gráfico.
- `npm audit` reporta 2 vulnerabilidades **moderadas** residuais, uma dependência
  transitiva (`uuid`) do `exceljs` (usado para a exportação Excel). Optamos por
  `exceljs` em vez de `xlsx` (SheetJS) porque este último trazia 2 vulnerabilidades
  **altas**. Ver `CHECKLIST_VALIDACAO_FULL_V1.md` para detalhes.
- Migrations, backend e testes automatizados foram validados contra uma instância
  local de PostgreSQL 16, não contra o banco de produção do Railway — o comportamento
  em produção deve ser o mesmo, mas a validação final em produção é responsabilidade
  de quem aplicar o deploy, seguindo o checklist.
