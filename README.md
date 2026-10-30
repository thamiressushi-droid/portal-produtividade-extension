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

A última identidade autenticada permanece em `chrome.storage.local` quando o
portal está fechado ou não consegue informar uma sessão; eventos já enfileirados
mantêm a identidade que tinham no momento da captura. O popup mostra a contagem
de eventos pendentes, o último envio bem-sucedido e o último erro.
