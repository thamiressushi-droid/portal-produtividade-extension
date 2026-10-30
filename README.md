# portal-produtividade-extension
Plugin do navegador

Os intervalos de navegação são registrados como ativos enquanto houver
interação recente do usuário (mouse, teclado, rolagem ou clique). O limite de
inatividade é lido da tabela `settings`, na chave
`inactivity_threshold_minutes`, e atualizado periodicamente. Ao atingir o
limite, a extensão registra o intervalo em `web_events` e abre um evento em
`inactivity_events`; ao retornar a atividade, finaliza esse evento. O último
limite válido fica em cache local para uso temporário se o Supabase estiver
indisponível. Uma sessão pendente é recuperada sem contabilizar o período em que
o navegador esteve fechado.

No Protheus/TOTVS, a extensão identifica a rotina pela aba ativa
(`wa-tab-button[active]`) e o contexto visível pelo atributo `caption` de
`wa-text-view`, sem uma lista fixa de telas. Esses valores são enviados nos
campos `screen_name` e `screen_context` de `web_events`. A migração em
`supabase/migrations` adiciona a coluna `screen_context`. Em ferramentas de
conversa e e-mail reconhecidas (Copilot, ChatGPT, Claude, Gemini, WhatsApp,
Teams, Outlook, Gmail, Slack e Discord), os títulos são substituídos pelo nome
do aplicativo e o contexto da tela não é coletado.

Todos os `web_events` e `inactivity_events` são gravados primeiro em um outbox
persistente do IndexedDB da extensão. A sincronização envia um evento por vez,
na ordem de captura, e só o remove após uma resposta de sucesso. Falhas de rede,
indisponibilidade do Supabase ou ausência de identidade mantêm os eventos na
fila para novas tentativas. O alarme periódico retoma o envio após reiniciar o
navegador; IDs idempotentes e a migration
`20261030140000_add_client_event_ids.sql` evitam duplicações no servidor.

A identidade autenticada é persistida em `chrome.storage.local` e recuperada
após reiniciar o navegador. Se ela ainda não estiver salva, o background
consulta as abas abertas do portal; a ausência de uma sessão numa aba não apaga
uma identidade já persistida. Um logout explícito remove a identidade. Eventos
já enfileirados mantêm a identidade que tinham no momento da captura. O popup
mostra a contagem de eventos pendentes, o último envio bem-sucedido e o último
erro.

O bridge também lê o `access_token` da sessão Supabase do portal e o persiste
em `chrome.storage.local`. As gravações em `web_events` enviam esse JWT no
cabeçalho `Authorization: Bearer` e só são feitas quando ele declara a role
`authenticated` e corresponde ao `user_id` do evento; sem isso, a requisição é
mantida no outbox em vez de usar a role `anon`. A role usada ou o motivo do
bloqueio aparece nos logs da extensão e no status do popup. As demais chamadas
Supabase permanecem inalteradas.

As gravações e atualizações de `inactivity_events` também usam o JWT autenticado.
A migration `20261030193200_reconcile_inactivity_event_permissions.sql`
concede os privilégios de tabela necessários à role `authenticated`, substitui
as policies anteriores por regras próprias para `SELECT`, `INSERT` e `UPDATE`,
e limita o acesso às linhas cujo `user_id` corresponde a `auth.uid()`. A role,
o método, o `user_id` enviado e a correspondência com o `sub` do JWT aparecem
nos logs; a role ou o motivo do bloqueio aparece separadamente no popup.
