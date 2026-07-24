# CHANGELOG — Nextra CSO Hub Full Version 1.0 (Atualização)

## 1. Login "Failed to fetch"

- Investigado a fundo: reproduzido o fluxo completo de login (frontend `API_BASE =
  '/api/v1'` relativo, correto) contra um Postgres real, com e sem Redis configurado, e
  com Redis intencionalmente inalcançável. Login funcionou em 100% dos cenários
  testados — **não foi possível reproduzir o erro exato**.
- Corrigido, mesmo assim, um risco real encontrado durante a investigação: o cliente
  Redis não tinha listener de `error` — um evento de erro assíncrono sem listener pode
  derrubar o processo Node em certas condições. Adicionado `redis.on('error', ...)` e
  uma `retryStrategy` limitada (evita flood de log e reconexão infinita).
- Corrigido o tratador de erros global do Fastify: antes, **qualquer** erro (inclusive
  erros HTTP legítimos do próprio Fastify, como JSON malformado) era convertido para
  500 genérico. Agora respeita o `statusCode` real do erro quando é 4xx, sem nunca
  vazar stack trace.

## 2. Chamados

- **Migration `010`**: colunas `quantity` (com `CHECK > 0`), `product_group`, `brand`.
- **NF obrigatória**: constraint `CHECK (btrim(nf_number) <> '')` + `NOT NULL`.
  Registros existentes sem NF receberam `LEGADO-SEM-NF-<id>` durante a migration — não
  foram apagados.
- `POST /tickets`: valida NF obrigatória e quantidade (inteiro > 0) antes de criar.
- `PATCH /tickets/:id`:
  - Bloqueia edição de chamado com `status = 'closed'` (retorna 409, exige reabertura).
  - Expandido para aceitar: `client_name`, `client_cnpj`, `product_name_snap`,
    `product_group`, `brand`, `quantity`, `serial_number_snap`, `order_number`,
    `nf_number`, `order_value`, `revenue_at_risk`, `am_user_id`, `bdm_user_id`,
    `area_responsible`, `description`, `expectation`, `previous_action`, `criticality`.
  - Gera uma linha de histórico por campo efetivamente alterado (`ticket_history`,
    com `field_changed`, `old_value`, `new_value`, usuário e data), dentro de uma
    transação.
- **Transições de status**: grafo de transições válidas movido para o backend
  (`TICKET_STATUS_TRANSITIONS`), como fonte única de verdade. `PATCH
  /tickets/:id/status` agora rejeita com 409 qualquer transição fora do grafo —
  necessário para o Kanban não aceitar movimentos inválidos.
- **Exportação Excel**: nova rota `GET /tickets/export/xlsx` (usa `exceljs`), respeita
  os mesmos filtros da listagem (status, criticidade, área, busca). Botão "Exportar
  Excel" na tela de Chamados.
- Frontend: cliente deixou de ser texto livre — agora é um dropdown ligado à tabela
  central `clients`, com opção de cadastro rápido inline (nome + CNPJ opcional).

## 3. Kanban dos Chamados (módulo novo)

- Novo item de menu "Kanban dos Chamados".
- Colunas por status, cards com cliente, ID, produto, quantidade, criticidade, SLA e AM.
- Drag-and-drop nativo (HTML5, sem biblioteca externa) com atualização otimista e
  reversão automática se o backend recusar a transição.
- Filtros por área, criticidade, AM, BDM e cliente (`GET /tickets` ganhou suporte a
  `am_user_id`, `bdm_user_id`, `client_id` como parâmetros de filtro).
- Toda movimentação chama `PATCH /tickets/:id/status` de verdade — sem persistência
  simulada.

## 4. Reclamações

- **Bug real corrigido**: a Torre de Controle usava `c.description` (campo que não
  existe na tabela `complaints`) em vez de `c.reason` — o motivo da reclamação nunca
  aparecia ali.
- Adicionada coluna "Motivo" na listagem de Reclamações (antes ausente).
- Cliente centralizado: já usava `client_id` corretamente no backend; confirmado via
  teste automatizado.

## 5. Devolução → Inspeção → RMA

- **Migration `010`**: enum `inspection_result`; colunas de inspeção em `returns`
  (`inspection_status`, `inspection_date`, `inspection_technician_user_id`,
  `inspection_third_party_company`, `inspection_physical_condition`,
  `inspection_functional_result`, `inspection_report`, `available_for_resale`,
  `linked_rma_id`); coluna `return_id` em `rma`; índice único parcial
  `uq_rma_active_per_return` (impede dois RMAs ativos para a mesma Devolução).
- `PATCH /returns/:id`: expandido para aceitar todos os campos de inspeção.
- **Nova rota transacional `POST /returns/:id/create-rma`**:
  - Exige `status = 'under_inspection'`, `inspection_status = 'rejected_defect'` e
    laudo técnico preenchido.
  - Cria o RMA herdando cliente, BU, produto, defeito (laudo), custo e responsável.
  - Encerra a Devolução **somente após** o RMA ser criado com sucesso — tudo em uma
    única transação de banco.
  - Se qualquer etapa falhar, a Devolução permanece exatamente como estava (testado).
  - Bloqueia RMA duplicado (checagem em código + constraint de banco).
- Frontend: nova aba "Inspeção" no detalhe de Devolução, com botão "Abrir RMA desta
  Devolução" quando aplicável.

## 6. IA (Triagem e Plano de Recuperação)

- Modelo (`ANTHROPIC_MODEL`) e timeout (`AI_TIMEOUT_MS`) configuráveis via variável de
  ambiente — nunca hardcoded.
- Timeout real implementado com `AbortController`.
- Validação de tipos: `occurrence_type`, `criticality` e `notify_areas` retornados pela
  IA são validados contra o vocabulário conhecido do sistema; valores fora da lista
  caem para um padrão seguro em vez de propagar para o banco.
- Resposta que não é JSON válido é tratada como erro claro (`AI_INVALID_RESPONSE`).
- Nova rota `GET /ai/status` informa ao frontend se a IA está configurada, sem expor a
  chave.
- A IA nunca grava nada automaticamente — em ambos os fluxos, o resultado é só uma
  sugestão; a gravação real exige clique explícito em "Aplicar ao Formulário".
- Sugestão de Plano de Recuperação por IA nunca estava conectada ao frontend — agora
  está, no modal de criação de Plano de Recuperação.

## 7. Migration

- `010_operational_flow_enhancements.sql`: 100% aditiva, idempotente (testada rodando
  2x seguidas), sem apagar dados.
- **Correção defensiva de sequence dessincronizada**: achado real durante os testes —
  `rma_id_seq1` estava atrasada em relação ao `MAX(id)` real, porque o `seed.js`
  sincronizava por engano a sequence órfã `rma_id_seq`, deixada pela renomeação
  histórica `rma → rma_legacy`. Isso quebraria a criação de qualquer RMA novo pela
  tela em produção. Migration 010 realinha a sequence; `seed.js` corrigido para usar
  `pg_get_serial_sequence()` dinamicamente daqui pra frente.
- `migrate.js` atualizado com a migration 010 na lista de execução.

## 8. Segurança e auditoria

- `JWT_SECRET`: o servidor recusa iniciar se `NODE_ENV=production` e a variável
  estiver ausente ou igual ao valor padrão de desenvolvimento.
- CORS: restrito a `ALLOWED_ORIGINS` quando configurada; fallback permissivo com aviso
  no log quando não configurada.
- Logout: invalidação real de sessão via blocklist no Redis quando disponível.
  Testado de ponta a ponta.
- `auditLog()`: existia mas nunca era chamado. Passou a ser chamado em
  criação/edição de Chamado e criação de RMA via Devolução.

## 9. Testes automatizados

- Suite real usando `node:test` (nativo) + `app.inject()` do Fastify, contra Postgres
  real. 51 testes, cobrindo autenticação, Chamados, Kanban, clientes/reclamações,
  Devolução→Inspeção→RMA, IA e permissões.
- **3 bugs reais encontrados e corrigidos durante a própria execução dos testes**:
  1. Sequence `rma_id_seq1` dessincronizada (detalhado acima).
  2. `parseInt()` truncava quantidades não-inteiras (`1.5` virava `1` em vez de ser
     rejeitado) — corrigido para `Number()` + `Number.isInteger()`.
  3. `seed.js` não fornecia `nf_number` para os 10 chamados de demonstração — quebrava
     em banco novo depois que a migration 010 tornou o campo obrigatório. Corrigido.
