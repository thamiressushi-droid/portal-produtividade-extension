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
