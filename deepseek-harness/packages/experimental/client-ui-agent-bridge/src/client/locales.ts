/** Copy owned by the agent-bridge tab. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    agentBridge: keyof typeof zh
  }
}

/** Locale namespace. */
export const NS = 'agentBridge'

/** Chinese copy. */
export const zh = {
  title: 'Agent 互通', description: '把当前对话和记忆同步给 Claude Code、Codex 和 Gemini CLI，也能把它们的会话打开到这里',
  'section.share': '把当前对话同步到', 'section.follows': '正在跟随的会话', 'section.sessions': '其他 Agent 的会话', 'section.memory': '记忆互通',
  'agent.all': '全部', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': '等待同步', 'status.synced': '已同步', 'status.deferred': '已暂停：对方已打开或改动过', 'status.unavailable': '未安装', 'status.error': '出错',
  'follow.following': '跟随中', 'follow.waiting': '等这个对话加载后继续', 'follow.missing': '文件已不存在',
  relayed: '已转发 {count} 条', unfollow: '停止跟随', open: '打开到当前对话', refresh: '刷新', resume: '在对方继续：', shared: '由 DeepSeek 同步',
  noSessions: '没有找到 Claude Code、Codex 或 Gemini CLI 的会话', noSession: '先打开一个对话', syncMemory: '立即同步',
  'memory.out': 'DeepSeek 的记忆写入', 'memory.in': '可读取的对方记忆', 'memory.facts': '{count} 条', 'memory.disabled': '未开启', 'memory.absent': '未安装，不写入', 'memory.none': '没有找到其他 Agent 的记忆',
  'scope.user': '用户级', 'scope.project': '当前项目', 'kind.memory': '记忆', 'kind.instructions': '指令',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  title: 'Agent bridge', description: 'Share this conversation and memory with Claude Code, Codex, and Gemini CLI, and open their sessions here',
  'section.share': 'Share this conversation with', 'section.follows': 'Followed sessions', 'section.sessions': 'Sessions of other agents', 'section.memory': 'Shared memory',
  'agent.all': 'All', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'Waiting to sync', 'status.synced': 'Synced', 'status.deferred': 'Paused: open or changed there', 'status.unavailable': 'Not installed', 'status.error': 'Error',
  'follow.following': 'Following', 'follow.waiting': 'Resumes when this conversation is loaded', 'follow.missing': 'File no longer exists',
  relayed: '{count} relayed', unfollow: 'Stop following', open: 'Open in this conversation', refresh: 'Refresh', resume: 'Continue there:', shared: 'Shared from DeepSeek',
  noSessions: 'No Claude Code, Codex, or Gemini CLI sessions found', noSession: 'Open a conversation first', syncMemory: 'Sync now',
  'memory.out': 'DeepSeek memory written to', 'memory.in': 'Their memory, readable here', 'memory.facts': '{count} facts', 'memory.disabled': 'Off', 'memory.absent': 'Not installed; nothing written', 'memory.none': 'No memory of other agents found',
  'scope.user': 'user', 'scope.project': 'this project', 'kind.memory': 'memory', 'kind.instructions': 'instructions',
} satisfies Record<keyof typeof zh, string>

/** Japanese copy. */
export const ja = {
  title: 'エージェント連携', description: 'この会話と記憶を Claude Code、Codex、Gemini CLI と共有し、それらのセッションをここで開きます',
  'section.share': 'この会話の共有先', 'section.follows': 'フォロー中のセッション', 'section.sessions': '他のエージェントのセッション', 'section.memory': '記憶の共有',
  'agent.all': 'すべて', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': '同期待ち', 'status.synced': '同期済み', 'status.deferred': '一時停止：相手側で開かれているか変更済み', 'status.unavailable': '未インストール', 'status.error': 'エラー',
  'follow.following': 'フォロー中', 'follow.waiting': 'この会話が読み込まれると再開', 'follow.missing': 'ファイルがありません',
  relayed: '{count} 件を転送', unfollow: 'フォローをやめる', open: 'この会話で開く', refresh: '更新', resume: '相手側で続ける：', shared: 'DeepSeek から共有',
  noSessions: 'Claude Code、Codex、Gemini CLI のセッションが見つかりません', noSession: '先に会話を開いてください', syncMemory: '今すぐ同期',
  'memory.out': 'DeepSeek の記憶の書き込み先', 'memory.in': 'ここで読める相手の記憶', 'memory.facts': '{count} 件', 'memory.disabled': 'オフ', 'memory.absent': '未インストールのため書き込みません', 'memory.none': '他のエージェントの記憶は見つかりません',
  'scope.user': 'ユーザー', 'scope.project': 'このプロジェクト', 'kind.memory': '記憶', 'kind.instructions': '指示',
} satisfies Record<keyof typeof zh, string>

/** Spanish copy. */
export const es = {
  title: 'Puente de agentes', description: 'Comparte esta conversación y la memoria con Claude Code, Codex y Gemini CLI, y abre sus sesiones aquí',
  'section.share': 'Compartir esta conversación con', 'section.follows': 'Sesiones seguidas', 'section.sessions': 'Sesiones de otros agentes', 'section.memory': 'Memoria compartida',
  'agent.all': 'Todas', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'Pendiente', 'status.synced': 'Sincronizada', 'status.deferred': 'En pausa: abierta o modificada allí', 'status.unavailable': 'No instalado', 'status.error': 'Error',
  'follow.following': 'Siguiendo', 'follow.waiting': 'Se reanuda al cargar esta conversación', 'follow.missing': 'El archivo ya no existe',
  relayed: '{count} reenviados', unfollow: 'Dejar de seguir', open: 'Abrir en esta conversación', refresh: 'Actualizar', resume: 'Continuar allí:', shared: 'Compartida desde DeepSeek',
  noSessions: 'No hay sesiones de Claude Code, Codex ni Gemini CLI', noSession: 'Abre primero una conversación', syncMemory: 'Sincronizar ahora',
  'memory.out': 'Memoria de DeepSeek escrita en', 'memory.in': 'Su memoria, legible aquí', 'memory.facts': '{count} datos', 'memory.disabled': 'Desactivado', 'memory.absent': 'No instalado; no se escribe nada', 'memory.none': 'No se encontró memoria de otros agentes',
  'scope.user': 'usuario', 'scope.project': 'este proyecto', 'kind.memory': 'memoria', 'kind.instructions': 'instrucciones',
} satisfies Record<keyof typeof zh, string>

/** French copy. */
export const fr = {
  title: 'Pont entre agents', description: 'Partagez cette conversation et la mémoire avec Claude Code, Codex et Gemini CLI, et ouvrez leurs sessions ici',
  'section.share': 'Partager cette conversation avec', 'section.follows': 'Sessions suivies', 'section.sessions': 'Sessions des autres agents', 'section.memory': 'Mémoire partagée',
  'agent.all': 'Toutes', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'En attente', 'status.synced': 'Synchronisée', 'status.deferred': 'En pause : ouverte ou modifiée là-bas', 'status.unavailable': 'Non installé', 'status.error': 'Erreur',
  'follow.following': 'Suivie', 'follow.waiting': 'Reprend quand cette conversation est chargée', 'follow.missing': 'Le fichier n\'existe plus',
  relayed: '{count} relayés', unfollow: 'Ne plus suivre', open: 'Ouvrir dans cette conversation', refresh: 'Actualiser', resume: 'Continuer là-bas :', shared: 'Partagée depuis DeepSeek',
  noSessions: 'Aucune session Claude Code, Codex ou Gemini CLI', noSession: 'Ouvrez d\'abord une conversation', syncMemory: 'Synchroniser',
  'memory.out': 'Mémoire DeepSeek écrite dans', 'memory.in': 'Leur mémoire, lisible ici', 'memory.facts': '{count} faits', 'memory.disabled': 'Désactivé', 'memory.absent': 'Non installé ; rien n\'est écrit', 'memory.none': 'Aucune mémoire d\'autres agents',
  'scope.user': 'utilisateur', 'scope.project': 'ce projet', 'kind.memory': 'mémoire', 'kind.instructions': 'instructions',
} satisfies Record<keyof typeof zh, string>

/** German copy. */
export const de = {
  title: 'Agenten-Brücke', description: 'Dieses Gespräch und das Gedächtnis mit Claude Code, Codex und Gemini CLI teilen und deren Sitzungen hier öffnen',
  'section.share': 'Dieses Gespräch teilen mit', 'section.follows': 'Verfolgte Sitzungen', 'section.sessions': 'Sitzungen anderer Agenten', 'section.memory': 'Geteiltes Gedächtnis',
  'agent.all': 'Alle', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'Ausstehend', 'status.synced': 'Synchronisiert', 'status.deferred': 'Pausiert: dort geöffnet oder geändert', 'status.unavailable': 'Nicht installiert', 'status.error': 'Fehler',
  'follow.following': 'Wird verfolgt', 'follow.waiting': 'Läuft weiter, sobald dieses Gespräch geladen ist', 'follow.missing': 'Datei existiert nicht mehr',
  relayed: '{count} weitergeleitet', unfollow: 'Nicht mehr verfolgen', open: 'In diesem Gespräch öffnen', refresh: 'Aktualisieren', resume: 'Dort fortsetzen:', shared: 'Von DeepSeek geteilt',
  noSessions: 'Keine Sitzungen von Claude Code, Codex oder Gemini CLI gefunden', noSession: 'Zuerst ein Gespräch öffnen', syncMemory: 'Jetzt synchronisieren',
  'memory.out': 'DeepSeek-Gedächtnis geschrieben nach', 'memory.in': 'Deren Gedächtnis, hier lesbar', 'memory.facts': '{count} Fakten', 'memory.disabled': 'Aus', 'memory.absent': 'Nicht installiert; nichts geschrieben', 'memory.none': 'Kein Gedächtnis anderer Agenten gefunden',
  'scope.user': 'Benutzer', 'scope.project': 'dieses Projekt', 'kind.memory': 'Gedächtnis', 'kind.instructions': 'Anweisungen',
} satisfies Record<keyof typeof zh, string>

/** Russian copy. */
export const ru = {
  title: 'Мост агентов', description: 'Делитесь этой беседой и памятью с Claude Code, Codex и Gemini CLI и открывайте их сессии здесь',
  'section.share': 'Поделиться беседой с', 'section.follows': 'Отслеживаемые сессии', 'section.sessions': 'Сессии других агентов', 'section.memory': 'Общая память',
  'agent.all': 'Все', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'Ожидает', 'status.synced': 'Синхронизировано', 'status.deferred': 'Пауза: открыта или изменена там', 'status.unavailable': 'Не установлен', 'status.error': 'Ошибка',
  'follow.following': 'Отслеживается', 'follow.waiting': 'Продолжится, когда беседа загрузится', 'follow.missing': 'Файл больше не существует',
  relayed: 'передано: {count}', unfollow: 'Не отслеживать', open: 'Открыть в этой беседе', refresh: 'Обновить', resume: 'Продолжить там:', shared: 'Передано из DeepSeek',
  noSessions: 'Сессии Claude Code, Codex и Gemini CLI не найдены', noSession: 'Сначала откройте беседу', syncMemory: 'Синхронизировать',
  'memory.out': 'Память DeepSeek записана в', 'memory.in': 'Их память, доступная здесь', 'memory.facts': 'фактов: {count}', 'memory.disabled': 'Выкл.', 'memory.absent': 'Не установлен; ничего не записано', 'memory.none': 'Память других агентов не найдена',
  'scope.user': 'пользователь', 'scope.project': 'этот проект', 'kind.memory': 'память', 'kind.instructions': 'инструкции',
} satisfies Record<keyof typeof zh, string>

/** Portuguese copy. */
export const pt = {
  title: 'Ponte de agentes', description: 'Compartilhe esta conversa e a memória com Claude Code, Codex e Gemini CLI e abra as sessões deles aqui',
  'section.share': 'Compartilhar esta conversa com', 'section.follows': 'Sessões acompanhadas', 'section.sessions': 'Sessões de outros agentes', 'section.memory': 'Memória compartilhada',
  'agent.all': 'Todas', 'agent.claude': 'Claude Code', 'agent.codex': 'Codex', 'agent.gemini': 'Gemini CLI',
  'status.pending': 'Pendente', 'status.synced': 'Sincronizada', 'status.deferred': 'Pausada: aberta ou alterada lá', 'status.unavailable': 'Não instalado', 'status.error': 'Erro',
  'follow.following': 'Acompanhando', 'follow.waiting': 'Retoma quando esta conversa carregar', 'follow.missing': 'O arquivo não existe mais',
  relayed: '{count} repassadas', unfollow: 'Parar de acompanhar', open: 'Abrir nesta conversa', refresh: 'Atualizar', resume: 'Continuar lá:', shared: 'Compartilhada do DeepSeek',
  noSessions: 'Nenhuma sessão do Claude Code, Codex ou Gemini CLI', noSession: 'Abra uma conversa primeiro', syncMemory: 'Sincronizar agora',
  'memory.out': 'Memória do DeepSeek gravada em', 'memory.in': 'A memória deles, legível aqui', 'memory.facts': '{count} fatos', 'memory.disabled': 'Desligado', 'memory.absent': 'Não instalado; nada é escrito', 'memory.none': 'Nenhuma memória de outros agentes',
  'scope.user': 'usuário', 'scope.project': 'este projeto', 'kind.memory': 'memória', 'kind.instructions': 'instruções',
} satisfies Record<keyof typeof zh, string>
