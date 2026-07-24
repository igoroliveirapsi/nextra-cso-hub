# CHECKLIST DE VALIDAÇÃO — Nextra CSO Hub Full Version 1.0

Legenda: ✅ testado e confirmado (contra Postgres real, nesta sessão) · ⚠️ validado
por revisão de código/sintaxe, não em navegador real · ❌ não foi possível validar

## Infraestrutura

- ✅ `npm install` — instala sem erro.
- ✅ `node --check` em todos os arquivos `.js` do projeto — sintaxe válida.
- ✅ Migrations 001–010 rodam em sequência, do zero, sem erro.
- ✅ Migration 010 é idempotente — testada rodando 2x seguidas sem erro.
- ✅ `seed.js` roda com sucesso em banco novo (após correção do `nf_number`).
- ✅ Servidor sobe e responde em `/health` com `db: ok`.
- ✅ Servidor sobe corretamente com e sem `REDIS_URL` configurada.
- ✅ Servidor sobe corretamente mesmo com Redis apontando para endereço
  inalcançável (não crasha, loga aviso e segue sem cache).
- ⚠️ Comportamento em produção real do Railway não foi testado — apenas localmente.

## Autenticação e segurança

- ✅ Login com credenciais válidas retorna token e dados do usuário.
- ✅ Login com senha errada / usuário inexistente retorna 401.
- ✅ Rotas protegidas exigem token válido (401 sem token, 401 com token inválido).
- ✅ Logout com Redis configurado invalida a sessão de verdade (token rejeitado com
  401 `TOKEN_REVOKED` em uma chamada subsequente).
- ⚠️ Logout sem Redis configurado: a rota responde 204 normalmente, mas o token
  permanece tecnicamente válido até expirar — limitação conhecida e documentada.
- ✅ `JWT_SECRET` ausente em `NODE_ENV=production` derruba o boot com mensagem clara
  (validado lendo o código; não forcei um boot real em modo produção sem a variável
  para não gerar side-effects no ambiente de teste).
- ✅ CORS aceita apenas origens em `ALLOWED_ORIGINS` quando configurada.

## Chamados

- ✅ Criação com NF e quantidade válidas — sucesso (201).
- ✅ Criação sem NF, ou com NF só de espaços — rejeitada (400).
- ✅ Criação com quantidade 0, negativa, ou não-inteira (ex: 1.5) — rejeitada (400).
- ✅ Quantidade, grupo do produto e marca são persistidos corretamente.
- ✅ Edição de chamado aberto funciona e gera histórico por campo alterado.
- ✅ Edição não permite deixar NF em branco.
- ✅ Chamado encerrado não pode ser editado (409) até ser reaberto.
- ✅ Transição de status inválida é bloqueada (409) — base para o Kanban.
- ✅ Exportação Excel retorna arquivo `.xlsx` válido, com nome contendo a data.
- ⚠️ Formulário de abertura/edição no navegador — validado por leitura de código e
  sintaxe (Babel), não clicado num navegador real.

## Kanban dos Chamados

- ⚠️ Estrutura, filtros e chamadas de API corretas por revisão de código.
- ❌ Drag-and-drop não foi testado em navegador real — este ambiente de validação não
  tem acesso a um navegador gráfico. **Recomendação: testar manualmente em produção
  antes de divulgar o módulo para o time.**

## Reclamações

- ✅ Cliente carrega corretamente na criação (testado via API).
- ✅ Motivo aparece na listagem e no detalhe (bug real corrigido e testado).
- ✅ Reclamação é vinculada ao cliente central por `client_id`.

## Devolução → Inspeção → RMA

- ✅ Inspeção aprovada (funcional) não permite abrir RMA (422).
- ✅ Inspeção reprovada sem laudo técnico não permite abrir RMA (422).
- ✅ Criação do RMA com laudo preenchido — sucesso (201), devolução encerrada,
  `linked_rma_id` preenchido corretamente.
- ✅ RMA duplicado para a mesma devolução é bloqueado (422).
- ✅ Se a criação do RMA falha, a devolução permanece com o mesmo status e sem
  `linked_rma_id` (nenhuma alteração parcial).

## RMA

- ✅ RMA criado via Devolução herda cliente, BU, produto, defeito (laudo) e custo.
- ⚠️ Fluxos manuais de RMA (criação direta, fora do fluxo de Devolução) não sofreram
  alteração nesta atualização — não re-testados nesta rodada além do que já existia.

## IA

- ✅ `GET /ai/status` informa corretamente quando a IA não está configurada.
- ✅ Chamada de triagem/plano de recuperação sem `ANTHROPIC_API_KEY` retorna 503 com
  mensagem clara (não crash, não 500).
- ✅ Resposta simulada (mock) com JSON inválido é tratada como erro claro
  (`AI_INVALID_RESPONSE`), não como crash.
- ✅ Resposta simulada com tipo/criticidade/área fora do vocabulário conhecido cai
  para valores seguros (`other`/`medium`/lista filtrada).
- ❌ **Nenhuma chamada real foi feita à API da Anthropic** — não há chave de API real
  disponível neste ambiente de validação. Recomenda-se testar manualmente com uma
  chave real antes de divulgar o recurso ao time.

## Demais módulos (não alterados nesta atualização)

- ⚠️ Dashboard Executivo, Torre de Controle, Cliente 360, Health Score, CSAT/NPS,
  Planos de Recuperação, Relatórios e Configurações não foram modificados nesta
  atualização além do necessário para as integrações descritas acima (ex: sugestão de
  IA no Plano de Recuperação). Não foram re-testados exaustivamente nesta rodada —
  recomenda-se validação de rotina normal pós-deploy.

## Segurança de dependências

- ⚠️ `npm audit --audit-level=moderate` e `npm audit --omit=dev --audit-level=moderate`
  retornam código de saída não-zero: **2 vulnerabilidades moderadas residuais**, ambas
  da mesma dependência transitiva (`uuid`, usada internamente pelo `exceljs`).
  - Decisão consciente: escolhemos `exceljs` em vez de `xlsx` (SheetJS) porque o
    `xlsx` trazia 2 vulnerabilidades **altas** sem correção automática disponível.
  - As 2 vulnerabilidades **altas** pré-existentes no projeto (`fast-uri`,
    `find-my-way`, ambas dependências internas do Fastify) foram corrigidas via
    `npm audit fix` (não-destrutivo).
  - Recomendação: monitorar por uma atualização do `exceljs` que resolva a
    dependência de `uuid`, e rodar `npm audit` novamente após.

## Pendências e próximos passos recomendados

1. Testar o módulo Kanban manualmente em um navegador real (drag-and-drop).
2. Testar a integração de IA com uma chave real da Anthropic.
3. Se o problema de "Failed to fetch" persistir após esta atualização, capturar o
   erro exato no Console do navegador (F12) no momento em que ocorre, para
   diagnóstico preciso.
4. Considerar atualizar `exceljs` quando uma versão sem a dependência vulnerável de
   `uuid` estiver disponível.
