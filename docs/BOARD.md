# Quadro do projeto

Estado de trabalho local; os issues upstream continuam no GitHub.

## 🔄 Fazendo

- **NT-006** **Suporte ao Antigravity CLI (`agy`) — MVP de status no canvas** — trazer o `agy`
  (Google Antigravity CLI, 1.2.3 instalado nesta máquina) como agente builtin. MVP definido pelo
  Fabricio: um nó Antigravity no Windows com badge RUNNING durante o turno e ocioso no fim, sem
  quebrar o `agy` que ele roda fora do nodeterm. Análise de viabilidade em
  `C:/Users/fabri/.claude/plans/qual-a-complexidade-de-velvet-sunbeam.md`; o Orca
  (`github.com/stablyai/orca`) já suporta o `agy` e é a referência das armadilhas — a pior é que
  um `PreToolUse` sem resposta no stdout é lido como **deny**. Time aberto: arquiteto (plano) e
  medidor (spike do contrato dos hooks) em paralelo. Pasta do card:
  `H:/ambiente/06-dados/rascunho/nodeterm/equipe/NT-006/`. **Plano (`02-plano.md`) e medição
  (`02-medicao.md`) entregues.** A medição refutou a premissa do Orca: no `agy` 1.2.3 silêncio +
  exit 0 no `PreToolUse` **executa**; quem nega é `{}`, `{"decision":""}`, texto não-JSON e
  exit≠0 — ou seja, o `{}` do fallback de evento desconhecido era a bomba, não o silêncio.
  Também mediu que o `Stop` sai em turno só de texto (o MVP existe), que o hook herda o env do
  pane, que `--dangerously-skip-permissions` vence o `ask` do hook, e que
  `~/.gemini/GEMINI.md` — já com blocos do nodeterm — é lido por todo `agy` desta máquina.
  Fixture de payloads reais em `src/shared/agents/__fixtures__/antigravity/`. Esperando o
  Fabricio decidiu o escopo: fatia 1 entrega **badge e NEEDS YOU juntos** (quatro eventos,
  incluindo `PreToolUse`), o que põe o hook no portão de toda ferramenta e faz da tabela de
  stdout o item crítico. **Entrega do coder (`04-entrega.md`): 1.1–1.3 prontas, 1.4 pronta
  menos a forma do comando no Windows** — a forma do plano (copiada do codex) nega toda
  ferramenta sob o `agy` real, porque o `agy` (Go) escapa aspas como `\"` e o `cmd.exe` não
  entende. Pergunta ao Fabricio sobre a forma substituta. Achado sério para a 1.5: o `npm test`
  de hoje já regrava os arquivos de hook **reais** da máquina (claude, gemini, codex, grok);
  registrado o antigravity, regravaria o `hooks.json` global do `agy` — o caminho novo já está
  imune, os antigos não. Nada commitado, nada instalado. **Fabricio escolheu a opção A**
  (caminho relativo à pasta do `hooks.json`, com guarda `if exist`; `05-fabricio.md`).
  **1.1–1.4 entregues (`07-entrega.md`):** typecheck ok, 80 testes do antigravity verdes, suíte
  completa com o mesmo conjunto de 395 falhas da linha de base, e `agy` real rodando com o
  `hooks.json` gerado pelo código final (8 eventos, ferramenta executa, bypass sem prompt). Revisor
  aberto sobre o diff inteiro (`08-tarefa-revisor.md`). **Revisão (`09-revisao.md`): achados, sem
  bloqueante.** Três importantes: o hook real custa ~520 ms por evento no Windows (não os ~103 ms
  aceitos: turno de 10 passos paga ~16 s); `lastTurnError` nunca é limpo para o antigravity, então
  um turno com erro prende os dependentes de `--after` até reiniciar o app; e um `AutoRun` do
  `cmd` que imprima algo negaria toda ferramenta em outras máquinas. Três sugestões de teste e
  documentação. Esperando o Fabricio. Falta a 1.5 (registrar instalador, validar no app,
  documentação). **Fabricio decidiu (`10-fabricio.md`):** aceitar o custo agora e registrá-lo
  como pendência (NT-007); corrigir os achados 2 e 3; sugestões 4–6 e o modo de permissão ficam
  fora. **Correções entregues (`12-entrega.md`):** `newTurn` no `PreInvocation` com
  `invocationNum === 0` (teste de sequência contra o store e a trava reais) e instalador que não
  escreve nada no Windows se houver `AutoRun` ou se o registro não puder ser lido; typecheck ok,
  107 testes do antigravity e 113 de estado/trava verdes, suíte com a base mais um estouro de
  tempo intermitente de teste anterior. **1.5 em andamento (`13-fabricio.md`):** o coder
  registra o instalador, escreve a documentação e sobe uma instância dev isolada (`NT_MULTI` +
  userData temporário) para o teste do badge, que é do Fabricio; o revisor confere em paralelo
  as correções da rodada anterior (`15-tarefa-revisor.md`). **Segunda revisão (`17-revisao.md`):
  achados 1 e 2 resolvidos; a leitura do `AutoRun` está certa, mas a recusa só impede instalação
  nova — um bundle instalado antes de o `AutoRun` aparecer continua negando ferramentas (achado A,
  importante); mais duas sugestões (`reg` pelo PATH sem `SystemRoot`; visão de 32 bits do HKLM).**
  Fabricio aprovou corrigir A, B e C depois da 1.5 (`18-fabricio.md`). **Entrega parcial da 1.5
  (`16-entrega.md`):** instalador registrado (`index.test.ts` verde, `hooks.json` real ausente),
  `docs/antigravity-agent.md` escrito, bullet no `CLAUDE.md`, regra no `CONTRIBUTING.md`. O coder
  parou antes de subir a instância dev: o session-host, o `workspace.json` e o lock ficam
  isolados, mas no boot ela regrava arquivos globais com caminhos do próprio userData — os scripts
  de `~/.nodeterm/agent-hooks` e as instruções de canvas-control que todo agente lê
  (`SKILL.md`, `GEMINI.md`, `AGENTS.md`) — virou NT-009. **Fabricio: subir mesmo assim e manter a
  pasta dev até reiniciar o app instalado (`19-fabricio.md`).** Coder aplicando A, B e C e, em
  seguida, subindo a instância dev e preparando o roteiro do teste do badge
  (`20-tarefa-coder.md`). **Entregue (`21-entrega.md`):** A, B e C corrigidos (117 testes);
  instância dev rodando (Electron PID 52660, lançador `cmd` PID 97200, dados em
  `H:/ambiente/06-dados/rascunho/nodeterm/nt-dev-1.5`); `~/.gemini/config/hooks.json` gravado
  na forma certa; um `agy` fora do nodeterm passou duas vezes pelo `PreToolUse` real e as
  ferramentas executaram. **A cota da conta do `agy` está esgotada até ~22/09 20:40** (erro 429),
  então o badge acende RUNNING mas não volta a ocioso até lá. Revisor conferindo A/B/C
  (`22-tarefa-revisor.md`) → **terceira revisão aprovada (`23-revisao.md`)**, com duas sugestões
  menores ainda não decididas (D: o aviso de retirada é escrito antes de ela acontecer, e uma
  falha é silenciosa; E: uma chave `__proto__` alheia some na regravação). Roteiro do teste em
  `21-entrega.md` §5. **Bloqueio: a cota do `agy` é da conta inteira** — sondado em 16/09 com
  `gemini-3.6-flash-low` e pedido de uma palavra, também deu 429. O teste do badge espera a
  renovação (~22/09 20:40) ou outra conta. **A equipe gastou boa parte dessa cota:** ~114
  chamadas de modelo no spike do medidor (43 só no teste de `force_continue`) e ~22 do coder,
  todas no modelo padrão `gemini-3.8-flash-high`, sem limite escrito nas tarefas.
  **Fabricio (16/09):** reinicia o app instalado no próximo reboot da máquina (provavelmente na
  noite de 16/09); enquanto isso, corrigir D e E e preparar o PR, dizendo que o teste de valor
  não foi concluído; ele vai tentar acesso a outra conta do Antigravity. Coder com
  `24-tarefa-coder.md`: D, E, rebase se limpo, commit liberado, texto do PR em `25-pr.md`.
  **Push e abertura do PR só com OK do Fabricio**, sugerido como draft. **Entregue
  (`26-entrega.md`):** D e E corrigidos (126 testes, mutações pegas); rebase sem conflito sobre
  `origin/main` `eca5ebba` (41 commits novos); três commits locais `42f7e50f`, `88b35579`,
  `3baf3f9e`, sem push; texto do PR em `25-pr.md`. Suíte completa não rodada depois do rebase
  (NT-008). **Quarta revisão (`28-revisao.md`): D, E e rebase corretos; achados no que vai a
  público.** (A) 29 linhas commitadas citam ids e arquivos internos (`NT-006`, `09-revisao.md`,
  "review 3, suggestion E"); (B) o PR diz "395, o mesmo conjunto", mas a última suíte teve 396
  (um timeout) e foi antes do rebase; (C) o PR não diz que o hook é instalado para todo usuário,
  a cada lançamento, com ou sem `agy`, e sem opção de desligar. Seis sugestões de precisão no
  texto. **Fabricio (`29-fabricio.md`):** o hook só é instalado onde o `agy` existir (sem `agy`,
  retira um bundle nosso), e todos os ajustes de texto entram. Coder com `30-tarefa-coder.md`
  (detecção sem executar o `agy`, `git grep` de referências internas como portão, commits
  reescritos com `--fixup`). **Entregue (`31-entrega.md`):** detecção do `agy` com o helper
  existente `findExecutableSync` (PATH do shell de login + caminhos do fornecedor, sem executar
  nada), silêncio quando não há `agy` nem bundle; referências internas removidas (`git grep`
  vazio); PR ajustado; 135 testes; commits `e8550dc4`, `63e0789e`, `1399ae6c`, sem push.
  **Quinta revisão (`33-revisao.md`):** A, B e S1–S6 resolvidos; **achado F (importante)**: a
  detecção roda no boot antes de a sonda do PATH do shell de login responder e nunca é repetida.
  No macOS/Linux aberto pela interface gráfica, um `agy` fora de `~/.local/bin` não é achado: o
  hook não é instalado, e um bundle gravado numa abertura pelo terminal é retirado na seguinte.
  O Windows não é afetado. Três sugestões de texto (G, H, I). **Fabricio (`34-fabricio.md`):**
  corrigir F com a segunda passada no padrão do grok (antes da sonda só instala, depois decide);
  **neutralizar todas as menções ao Orca** no que vai para o PR — conferido que nenhum código dele
  foi copiado, só usado como referência de comportamento (MIT). **Entregue (`36-entrega.md`):**
  `installAntigravityHooksWithProbe` (boot só instala; a passada final, depois de
  `resolveShellPath()`, instala ou retira; caminhos fixados antes da primeira passada), Orca fora
  do diff (grep vazio, conferido pelo coordenador), 141 testes do antigravity, 97 de menu e
  canvas-control; commits `00395c28`, `696d6f05`, `c95b05d8`, sem push. **Sexta revisão
  (`38-revisao.md`):** código aprovado (F corrigido, sem corridas em produção, Orca fora do diff,
  gates 141/1252/97 reproduzidos). Achados só de texto do PR: J (§9 → §8 — já estava §8 no
  `25-pr.md`), K (acrescentar "or fails" à sonda), L (lixo em temp no `index.test.ts`, vai para
  NT-008). **Fabricio (16/09):** ajustar K e publicar — feito: branch no fork, **PR draft
  eneskirca/nodeterm#798**. Falta o teste de valor com `agy` real (cota até ~22/09 ou outra
  conta) para tirar do draft. **CI do #798:** `quality` falhou com 11.859 testes verdes e 1 erro
  não tratado (timer de `settings.ts` depois do fim de `AgentsSection.controlConfirm.test.tsx`,
  instável, vindo da `main`). Sem permissão para reexecutar; o Fabricio escolheu corrigir o teste
  → coder (`39-tarefa-coder.md`). **Entregue (`40-entrega.md`):** commit `8bc30c14` (guard de
  `window` no callback do timer + 2 testes; o de regressão falha sem a correção), sem push.
  Revisão num revisor novo (`41-tarefa-revisor.md`). **Atenção:** os 4 commits têm como autor o
  e-mail corporativo (`git config` global), já público no fork. · `[agentes]` `[windows]` · G ·
  importante · **Revisão 7 (`42-revisao.md`): aprovada** (mutação conferida pelo revisor 2; sugestão
  opcional de encurtar o guard, não aplicada). · Etapa: Revisão (correção do CI) · Responsável:
  **E-mail (Fabricio, 16/09):** commit não pode sair com o e-mail da Unimed. Feito:
  `includeIf gitdir/i:C:/Desenv/particular/` → `~/.gitconfig-particular` (fabriciocasali@gmail.com);
  os 4 commits reescritos (`025a1c3f`, `9c1b24be`, `b4f0094c`, `fc87bfdf`, árvore idêntica);
  branch renomeada para `feat/antigravity-agent`; **PR draft novo eneskirca/nodeterm#799**; #798
  fechado ("Superseded by #799") e a branch antiga apagada do fork. Os commits antigos
  (`00395c28a887…`, `696d6f0596d5…`, `c95b05d8c2c1…`) seguem acessíveis pelo #798: sumir de vez só
  com pedido ao suporte do GitHub (do Fabricio). **16/09: CI do #799 verde; teste de valor passou; #799
  pronto para revisão.** · Etapa: Validado (aguarda revisão/merge do upstream) · Responsável:
  upstream (@eneskirca) · Grupo: NT-006 Antigravity CLI

- **NT-003** **PR: sessão ociosa morta e `targetStatusStale` permanente (Windows)** — três causas
  achadas e corrigidas localmente: (1) `live-work.ts`/`park-budget.ts` só protegiam agente
  `working`/`waiting`/`blocked` dos levers de memória (offscreen release, park); um Claude `done`
  ocioso era liberado/evictado como um terminal comum, e sem tmux por baixo isso mata o processo
  de verdade — o resume seguinte parecia "nada aconteceu" mas na prática reiniciou a prova de
  identidade. (2) `agent-status-mirror.ts`/`agent-message-decide.ts`: um `SessionStart`/`SessionEnd`
  zera `state`/`stateVerified` corretamente, mas o motivo reportado era sempre
  `targetStatusStale` ("identidade nunca provada"), mesmo para um nó que JÁ tinha se provado nesta
  execução e só cruzou um boundary de sessão — mensagem errada para quem está tentando decidir se
  vale a pena repetir. Agora esse caso responde `targetNotIdleUnknown` ("entre sessões"), e um
  `idle_prompt` verificado logo após um `SessionStart` verificado (sem nenhum turno no meio) pode
  fechar um `done` verificado — essa segunda parte **não foi confirmada na prática** (ver o
  documento). (3) `pty-manager.ts`: `write`/`sendText` para um PTY nativo direto do Windows caía no
  ramo do session-host por engano e sempre falhava; agora roteia para
  `NativeWindowsPane.sendText`. Empacotamento também corrigido — `dist:win` não rodava `host:build`
  e o instalador não levava o session-host nem o `node-pty`, então todo terminal virava PTY nativo
  sem persistência (o motivo raiz de por que "reiniciar o NodeTerm" matou tudo). Instalado e
  validado localmente (hash do ASAR bate, session-host confirmado dono da árvore de processos,
  hooks vivos pós-restart); o cenário completo (coordenador↔arquiteto↔coder trocando `send`/`reply`
  por várias entregas) não foi re-executado ponta a ponta. Motivação, diagnóstico linha a linha,
  o que foi e não foi validado: `docs/agent-messaging-idle-session-boundary-fix.md`. Diff ainda
  100% local, sem branch nem commit — pronto para virar PR. · `[agentes]` `[windows]`
  `[messaging]` · G · crítico

## 📋 A fazer

- **NT-019** **Zoom dentro dos nos web/browser do canvas** — nao da para ampliar o conteudo HTML
  de um no `web`/`browser` (caso real: os paineis do FlowForge, varios abertos ao mesmo tempo para
  acompanhar tarefa). Levantado no fonte: `WebNode.tsx` envolve o `<webview>` em
  `.editor-node__image nodrag nowheel` e `BrowserSurface.tsx` em `.browser-node__view nodrag
  nowheel`, entao o React Flow ignora a roda ali (`noWheelClassName`); e **nao existe nenhuma**
  chamada de `setZoomLevel`/`setZoomFactor`/`setVisualZoomLevelLimits` em todo o `src`, nem
  `preload` nos webviews — ou seja, nada implementa zoom de pagina, e o Ctrl+roda que o Chrome
  trata na sua propria UI nao tem quem trate aqui. A ser confirmado antes de propor: se um evento
  de roda dentro do guest chega ao DOM do host (suspeita: nao chega, por ser processo separado, o
  que tornaria inutil simplesmente tirar o `nowheel`). Sessao OpenCode aberta para levantar e
  propor: no `term-mua02dmf-f5cbc50e` ("astra - zoom no webview"), linkada ao coordenador. ·
  `[canvas]` `[webview]` · M · melhoria

- **NT-018** **Organizar o canvas por tipo de nó** — a segunda leitura de "nível" que o Fabricio
  quer depois do NT-017: faixas por categoria em vez de por linhagem — agentes numa, terminais
  simples em outra, notas/editores/web/browser na última. Mesma mecânica do NT-017 (faixas sobre
  `arrangeNodes`), trocando só a função que atribui a faixa, então o custo está quase todo em
  decidir as categorias e onde cai um nó de agente customizado. Em aberto: se vira uma terceira
  linha de menu ou um submínu "Organizar ▸" com as duas. · `[canvas]` `[layout]` · P · melhoria

- **NT-016** **Avisar quando um grupo fica ocioso** — o sinal que importa não é o contador do
  NT-015, é a transição de "algum CLI rodando" para "nenhum" dentro de um frame: é quando o time
  delegado terminou e a tarefa volta para o Fabricio. Hoje a notificação é por nó (throttle de
  5 s/nó), então um fan-out de 4 agentes dá 4 avisos e nenhum diz que o grupo acabou — o contador
  obriga a ficar olhando, o evento avisa. Precisa de: estado do grupo, a borda de transição,
  estado de lido e onde avisar (notificação do SO, badge, ou os dois). Nasceu do NT-015. ·
  `[agentes]` `[notificações]` · M · importante

- **NT-010** **Auto organizar um grupo** — opção no grupo (menu do frame) que distribui os nós
  dentro da área do próprio grupo, sem sair dela. Hoje já existem o "Tidy canvas" (só nós de
  nível superior, `arrangeAllNodes`) e o verbo `arrange` do canvas-control, que arruma os filhos de
  um frame e depois encolhe o frame ao redor (`fitGroupToChildren`). Nenhum dos dois preenche a
  área que o grupo já tem. Ponto de partida: `arrangeNodes` em `state/workspace.ts`. Começa
  17/09. · `[canvas]` · M · melhoria
- **NT-011** **Dashboard para acompanhar a equipe do coordenador** — no modo
  `comum-coordenar-equipe` falta uma visão do andamento: tarefas executadas, pendentes e com quem
  estão. Decisão em aberto: (a) um tipo de nó novo no canvas, com verbos para as CLIs alimentarem
  (exige node kind, canvas-control e texto da skill), ou (b) uma skill que sobe um dashboard mais
  completo que o `BOARD.md`. Hoje o coordenador já mostra uma cópia HTML do board num nó
  `show-web`, o que é um protótipo de (b). Começa 17/09. · `[canvas]` `[agentes]` · G · melhoria

- **NT-005** **Roteiro de testes do PR #760** — Frente A (sessão liberada na simulação) feita no commit `9d47507f`, já na branch do PR, ainda sem push. Frente B (`/exit` e proteção de memória) não foi feita, por falta de jeito prático de medir à mão, e ficou registrada no PR. Faltam as frentes ao vivo: Claude real depois de reiniciar e de `--resume`, Enter em `write`/renomear/ditado. Esperam o commit final do PR (rebase e CodeQL em outra sessão) para gerar o build. Roteiro em `H:/ambiente/04-planejamento/particular/nodeterm/pln-2026-008-testes-pr-760.md`. · `[agentes]` `[windows]` `[messaging]` · M · importante

- **NT-004** **Reexecutar e diagnosticar timeouts do `quality-windows` no PR #655** — a execução de 13/09 passou nos jobs gerais e de segurança, mas quatro testes expiraram: `host-routing.test.ts`, `remote-atomic-write.test.ts`, `bootstrap-windows.test.ts` e `pty-session-host.test.ts`. Reexecutar antes de concluir se há falha real ou instabilidade do runner. · `[windows]` `[CI]` · M · importante
- **NT-002** **Investigar interrupção do autosave** — isolar por que o canvas ficou sem publicação automática antes do Save manual. A comunicação agora publica as alterações antes do envio; o aceite NT-001 foi concluído, mas a causa histórica da parada do timer continua desconhecida. · `[persistência]` · M · importante

## 🗂️ Backlog

- **NT-014** **Abrir nós novos em espaço vago do canvas** — quando uma sessão abre vários nós de
  uma vez (notas, arquivos MD, páginas, subagentes etc.; às vezes 5 a 10 numa tacada), eles
  ficam empilhados um sobre o outro, e arrumar à mão leva muito tempo. Proposta: uma opção no
  projeto para posicionar automaticamente cada nó novo em uma área livre do canvas, sem sobrepor
  os que já existem nem os que foram abertos no mesmo lote. Relacionado ao NT-010 (auto organizar
  grupo). · `[canvas]` `[layout]` · M · melhoria

- **NT-013** **Uso do Antigravity no indicador de uso** — a barra inferior do canvas mostra o uso
  do Claude, do Codex e de outros provedores, mas não o do Antigravity (`agy`). Primeiro passo:
  levantar como o indicador lê cada provedor e se o `agy` expõe o uso em algum lugar (arquivo
  local, comando ou API), sem gastar a cota da conta, que está esgotada até ~22/09. Depende do
  NT-006 (#799). · `[agentes]` `[uso]` · M · melhoria

- **NT-012** **Opção de foco por clique no terminal** — hoje o terminal perde o foco do teclado
  quando o mouse sai da área dele (`onBodyLeave` → `blur()`, `TerminalNode.tsx:4824`), mesmo sem
  clique. Por isso quem digita de fora, como o Matraca, perde o texto se o mouse estiver no fundo
  do canvas, e um Backspace nessa hora chega ao atalho de apagar nós. Proposta: opção em Settings →
  Behavior para o terminal manter o foco ao sair; ele só perderia o foco com um clique no fundo do
  canvas, em outro nó ou em um painel. A camada de proteção e a roda do mouse continuam como estão,
  e desligada a opção mantém o comportamento atual. Fabricio vai pensar e talvez abrir uma issue
  upstream para ouvir a opinião dos mantenedores antes de implementar. · `[canvas]` `[foco]` · M ·
  melhoria

- **NT-007** **Custo do hook do Antigravity no Windows (~520 ms por evento)** — a revisão do NT-006
  mediu que o hook gerenciado responde em ~100 ms, mas o processo só termina em ~520 ms dentro do
  nodeterm (p90 542 ms; ~800 ms quando o token precisa dos caminhos alternativos), porque token,
  `mkdir`, `uname` e `cygpath` rodam em primeiro plano sob o `sh` do Git, a ~55 ms por fork. O
  `agy` espera a saída do processo, e um passo de ferramenta dispara 3 eventos: um turno de 10
  passos paga ~16 s. Aceito pelo Fabricio no MVP. Correção sugerida: só no antigravity, pôr em
  background tudo o que vem depois de `payload=$(cat)` (medido na bancada em 100–150 ms), com
  teste de ordem de chegada. Risco em aberto: ninguém mediu o que o `agy` faz quando um
  `PreToolUse` estoura o `timeout: 5` — provavelmente nega a ferramenta, e máquina carregada
  alonga cada fork. Evidência: `H:/ambiente/06-dados/rascunho/nodeterm/equipe/NT-006/09-revisao.md`
  (achado 1). · `[agentes]` `[windows]` `[desempenho]` · M · importante
- **NT-008** **`npm test` regrava os arquivos de hook reais da máquina** — achado pelo coder do
  NT-006: `src/core/agents/hooks/index.test.ts` espiona `os.homedir`, mas os instaladores dos outros
  agentes importam `homedir` nomeado, que o spy não alcança. Resultado: cada `npm test` reescreve
  `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/.codex/hooks.json`, o hook do grok e
  `~/.nodeterm/agent-hooks/*.sh` reais (conferido pelo `LastWriteTime`). O antigravity já foi
  corrigido no NT-006; os outros seguem assim. Anterior ao card. Evidência:
  `H:/ambiente/06-dados/rascunho/nodeterm/equipe/NT-006/04-entrega.md` §6 e `07-entrega.md` §5.
  Efeito já visível: depois do `index.test.ts` de 16/09 10:11, os scripts em
  `~/.nodeterm/agent-hooks` carregam um `nt_codex_root` num diretório temporário apagado — sem
  impacto hoje (não há nó Codex de app-server compartilhado), e o próximo boot do app instalado
  regrava. · `[testes]` `[agentes]` · M · importante
- **NT-009** **Instaladores globais gravam caminhos do userData de quem rodou por último** — achado
  pelo coder do NT-006 ao preparar uma instância `NT_MULTI`: os scripts de
  `~/.nodeterm/agent-hooks` (`nt_codex_root`) e as instruções de canvas-control e context-link
  (`~/.claude/skills/…/SKILL.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`, blocos do opencode e
  do copilot) levam o caminho do `userData` da instância que os escreveu. Com duas instâncias na
  máquina, vence a última, e apagar o userData dela quebra o controle de canvas de todos os agentes
  até a outra reiniciar. O próprio repositório trata `NT_MULTI` como sandbox que não pode afetar o
  app real (`CLAUDE.md` § Window chrome; `src/main/index.ts:304-305`). Evidência:
  `H:/ambiente/06-dados/rascunho/nodeterm/equipe/NT-006/16-entrega.md` §3. · `[agentes]`
  `[dev]` · M · importante

## ✅ Concluído

- **NT-020** **Spawn de sessões em projetos fora de tela** — resolvido pelo upstream na issue
  #925, lançada no v0.4.0 e trazida para `local/dev-build` no merge `a7c75bbe` (30/09): `open-*
  --run-now` (a flag por último na linha) inicia a sessão headless no core sem o projeto na tela,
  e `run --node <id>` dispara um nó que já está na fila. Sem a flag o nó continua na fila até o
  projeto ser visto. O coordenador (`transporte-nodeterm.md`) passou a abrir com `--run-now`.
  `--run-now` não se combina com `--after`, e SSH e `spawn-team` continuam fora do headless.
  Nenhum código local foi escrito. · `[canvas-control]` `[agentes]`

## ⏸️ Pausado

## Estado atual

### Equipe

- **Coordenador:** Claude Code · nó `term-mubbbzc1-5ee6ea79` · sem `/loop`.
- **Time NT-020** — sem trabalho: o card foi resolvido pelo upstream (#925). Se os nós
  arquiteto `term-mubh9mlr-90694a31`, coder `term-mubh9n7q-e0eb937c` e revisor
  `term-mubh9ntp-95a8a9cf` (grupo `group-mubha98d-b05546bb`) ainda estiverem no canvas, podem ser
  fechados.
- Time do NT-006 fechado em 16/09 (branch `feat/antigravity-agent`, PR #799 esperando o upstream).
- **Limpeza pós-teste (16/09):** app instalado reiniciado pelo Fabricio; skill de canvas-control,
  blocos de instrução e scripts de hook regravados sem `nt-dev-1.5`. Só
  `~/.nodeterm/agent-hooks/antigravity.sh` ainda cita a pasta (`nt_codex_root`, caminho opcional
  de identidade do Codex; o app instalado não conhece o Antigravity e não o regrava). A pasta
  `nt-dev-1.5` e o log foram apagados. `~/.gemini/config/hooks.json` continua com o bundle
  `nodeterm-status` (inofensivo; sem badge até o app instalado ter esta versão).
- Nó "BOARD nodeterm" (`show-web --file` de `scratchpad/board-html.mjs`): cópia HTML deste
  arquivo, regenerada pelo coordenador quando o board muda.
- **Mensageria entre agentes:** ligada.
- **Fila de recurso exclusivo:** nenhuma

## Versao local instalada

- **Gerado e ainda não instalado (30/09):** `0.4.0-v040-cp1252-20260930-143347-bf8fbaeffef7-dirty`
  — o anterior mais a correção do acento no canvas-control (`fa4c4367`, branch
  `fix/control-form-cp1252`, sem PR ainda).
  `build/local-windows/0.4.0-v040-cp1252-20260930-143347-bf8fbaeffef7-dirty/nodeterm-Setup-0.4.0.exe`.
  Instalador SHA-256 `1D7AFD780DD375D17446E459C1515A913717BD5F842938C4F334EFC1F0C2E27B`;
  ASAR `3907AF2D12D262C7EB569D56BA764AAEDDBBA184E9E541BCC93DB35E6116D4EA`.
- **Instalado (30/09):** `0.4.0-v040-run-now-20260930-141436-a7c75bbe4b44-dirty` — v0.4.0 do
  upstream com o `--run-now` (NT-020), validado com subagente real fora da tela. ASAR
  `455695FF2FD533D5447F7CFB902DBB6B090D06829B7C33BD083F1D7D66E458C3`. Bug: prompt com acento
  falha sem mensagem (corrigido no build acima).

- **Commitado em `local/dev-build`, sem push e sem PR:** `3c1382bc` (badges de status por grupo na
  sidebar) e `9c9eb7fa` (organizar o canvas por linhagem). Validados pelo Fabricio no build
  `0.3.7-group-lineage.1` (instalador SHA-256 `C763C040...05AE`, ASAR `E1C03472...557A`). Para
  virarem PR upstream precisam de branches proprias a partir de `origin/main` — `local/dev-build`
  carrega merges de outras frentes.

- **Gerado e ainda não instalado:** `0.3.6-windows-messaging.2`, do commit `9d47507f` (cabeça do PR #760),
  `C:/Desenv/particular/nodeterm/dist/nodeterm-Setup-0.3.6-windows-messaging.2.exe`.
  Instalador SHA-256 `A1953B9E8C4C1D3BDEAF1DF72EBAABE695C297F1A79E37AF00F666AAAE4E7566`;
  ASAR `70E022C363833B8A2E4C13597F4385C9343F9D1F3EB9590D3D8DD3C42197D544`;
  `host.cjs` `2894F904DE3A8F56A29F53B8CFBE5812A4FCB07946213B686DED56ADE44FA5C8`.
  É o build das frentes B, C e D do NT-005.

- `0.3.5` (build local com o fix NT-003 + session-host empacotado):
  `C:/Desenv/particular/nodeterm/dist/nodeterm-Setup-0.3.5.exe`.
- SHA-256 do instalador: `57D2C1BC22B2175F1081B7D1878C58B0E14FA440CA6901A85EE88A69994825CA`.
- SHA-256 do ASAR instalado e conferido: `2C1B636651AA903DCBB2155ACE18B1EEB62708D22D8ABBEB53A98279F1F45407`.
- SHA-256 do `resources\session-host\host.cjs` empacotado:
  `641CA13BD45BC4CA79BC3D99EC5CA9F1ECFD91D011236C84655DDE5BD438071C`.
- Motivação/diagnóstico/o que falta para o PR: `docs/agent-messaging-idle-session-boundary-fix.md`.
- Build anterior (`0.3.5-windows-messaging.2`, sem o fix NT-003, sem session-host empacotado):
  ASAR `201261524AD037F4CC2AF37842344900C3632CD360366919279617FCB04CC550`.
- Aceite real e limite por backend: `C:/Desenv/particular/nodeterm/docs/windows-session-host.md`.
