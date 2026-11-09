# portal-produtividade-extension
Plugin do navegador

Os intervalos de navegação são registrados em `web_events`, com `is_active`
distinguindo uso ativo de períodos inativos. Ao atingir o limite de inatividade,
a extensão encerra o intervalo ativo e abre um evento separado em
`inactivity_events`; ao retomar ou encerrar a sessão, registra o intervalo
inativo em `web_events` e finaliza o evento de inatividade. A inicialização
restaura sessões e eventos pendentes e reconcilia o estado atual do sistema.
Um heartbeat da extensão é registrado a cada minuto e em cada operação do
background. Uma lacuna superior a três minutos encerra a sessão no último
instante conhecido, excluindo o período em que o navegador ou a extensão
estiveram indisponíveis, como durante suspensão, hibernação ou desligamento.
Assim, apenas os intervalos com extensão conectada podem ser contabilizados
como inativos; períodos sem heartbeat são classificados como ausentes.
O limite de inatividade é lido da tabela `settings`, na chave
`inactivity_threshold_minutes`, e atualizado periodicamente. O último limite
válido fica em cache local para uso temporário se o Supabase estiver
indisponível. Uma sessão pendente é recuperada sem contabilizar o período em que
o navegador esteve fechado.

No Protheus/TOTVS, o módulo `content-protheus.js` identifica a rotina pela aba
ativa (`wa-tab-button[active]`) e o contexto visível pelo atributo `caption` de
`wa-text-view`, inclusive dentro de shadow roots, sem uma lista fixa de telas.
Ele envia esses valores para `content-activity.js`, que os inclui nos campos
`screen_name` e `screen_context` de `web_events`. A captura padrão dos demais
sites permanece inalterada. A migração em
`supabase/migrations` adiciona a coluna `screen_context`. Em ferramentas de
conversa e e-mail reconhecidas (Copilot, ChatGPT, Claude, Gemini, WhatsApp,
Teams, Outlook, Gmail, Slack e Discord), os títulos são substituídos pelo nome
do aplicativo e o contexto da tela não é coletado.

Todos os `web_events` e `inactivity_events` são gravados primeiro em um outbox
persistente do IndexedDB da extensão. A sincronização preserva a ordem de
captura dentro de cada identidade e só remove um evento após uma resposta de
sucesso. eventos de outra identidade ou sem usuário de origem continuam na fila sem
bloquear o usuário atual nem serem reatribuídos. Falhas de rede,
indisponibilidade do Supabase ou ausência de identidade mantêm os eventos na
fila para novas tentativas. O alarme periódico retoma o envio após reiniciar o
navegador; IDs idempotentes e a migration
`20261030140000_add_client_event_ids.sql` evitam duplicações no servidor.

A identidade autenticada é persistida em `chrome.storage.local` e recuperada
como espelho após reiniciar o navegador, mas nunca é usada como fonte de
autenticação. Antes de identificar ou enviar eventos, o background consulta a
sessão atual em uma aba do portal. Se não houver resposta atual do portal, a
identidade local não será usada; um logout confirmado remove a identidade
persistida. Eventos já enfileirados mantêm a identidade que tinham no momento
da captura e só são enviados quando ela ainda corresponde ao usuário da sessão
ativa. O popup mostra a contagem de eventos pendentes, o último envio
bem-sucedido e o último erro.

O bridge também lê o `access_token` da sessão Supabase do portal e o persiste
em `chrome.storage.local`. As gravações em `web_events` enviam esse JWT no
cabeçalho `Authorization: Bearer` e só são feitas quando ele declara a role
`authenticated` e o `sub` (equivalente a `auth.uid()`) corresponde ao usuário
da sessão atual do portal e ao `user_id` do evento; sem isso, a requisição é
mantida no outbox em vez de usar a role `anon`. As gravações em
`inactivity_events` aplicam a mesma validação. Os logs registram o usuário
persistido, o usuário da sessão atual, o `auth.uid()` do JWT e se o `user_id`
do evento coincide, sem registrar o token. A role usada ou o motivo do
bloqueio aparece nos logs da extensão e no status do popup. As demais chamadas
Supabase permanecem inalteradas.

As gravações e atualizações de `inactivity_events` também usam o JWT autenticado.
A migration `20261030193200_reconcile_inactivity_event_permissions.sql`
concede os privilégios de tabela necessários à role `authenticated`, substitui
as policies anteriores por regras próprias para `SELECT`, `INSERT` e `UPDATE`,
e limita o acesso às linhas cujo `user_id` corresponde a `auth.uid()`. A role,
o método, o `user_id` enviado e a correspondência com o `sub` do JWT aparecem
nos logs; a role ou o motivo do bloqueio aparece separadamente no popup.
