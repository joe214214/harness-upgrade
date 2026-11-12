/** Copy owned by the co-canvas tab. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    coCanvas: keyof typeof zh
  }
}

/** Locale namespace. */
export const NS = 'coCanvas'

/** Simplified Chinese copy. */
export const zh = {
  title: '协同画布', description: '实时查看 agent 的浏览器，在页面上标注或接管操作',
  'tool.label': '标注方式', 'tool.box': '框选', 'tool.arrow': '箭头', 'tool.point': '点选',
  note: '下一个标注的附言（可选）',
  'control.agent': 'Agent 正在操作', 'control.paused': 'Agent 已暂停，画面已定格，可以在上面标注', 'control.human': '你正在操作，点击和键盘输入会发送到页面',
  pause: '暂停', resume: '继续', take: '接管', handBack: '交还给 agent',
  ask: 'Agent 请你标注：', answer: '发送标注作为回答',
  pending: '等待送达 agent 的标注', remove: '移除', noElement: '未找到元素',
  waiting: '正在连接浏览器…', failed: '浏览器启动失败：', view: '共享浏览器画面',
  'surface.label': '画面', 'surface.browser': '浏览器', 'surface.desktop': '桌面', desktopView: '桌面画面', waitingDesktop: '正在读取桌面…', noWindow: '桌面上的位置', markScreen: '在屏幕上框选', markScreenHint: '3 秒后冻结屏幕，在真实屏幕上标注', discuss: '先问 agent', discussHint: '想先和 agent 确认这些标注？它会回复你，不会继续操作。', discussing: '正在和 agent 讨论标注：在对话里回复它，或点“继续”',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  title: 'Co-canvas', description: 'Watch the agent\'s browser live, mark the page, or take over',
  'tool.label': 'Mark with', 'tool.box': 'Box', 'tool.arrow': 'Arrow', 'tool.point': 'Point',
  note: 'Note for your next mark (optional)',
  'control.agent': 'The agent is in control', 'control.paused': 'The agent is paused; the view is frozen for marking', 'control.human': 'You are in control; clicks and keys go to the page',
  pause: 'Pause', resume: 'Resume', take: 'Take over', handBack: 'Hand back',
  ask: 'The agent asks you to mark:', answer: 'Send marks as answer',
  pending: 'Marks waiting for the agent', remove: 'Remove', noElement: 'no element found',
  waiting: 'Connecting to the browser…', failed: 'The browser failed to start:', view: 'Shared browser view',
  'surface.label': 'View', 'surface.browser': 'Browser', 'surface.desktop': 'Desktop', desktopView: 'Desktop view', waitingDesktop: 'Reading the desktop…', noWindow: 'a place on the desktop', markScreen: 'Mark on screen', markScreenHint: 'Freezes the screen in 3 s so you can mark the real screen', discuss: 'Ask the agent first', discussHint: 'Check these marks with the agent first? It replies without acting.', discussing: 'Discussing your marks: reply in the conversation, or press Resume',
} satisfies Record<keyof typeof zh, string>

/** Japanese copy. */
export const ja = {
  title: '共同キャンバス', description: 'エージェントのブラウザをリアルタイムで見て、ページに印を付けたり操作を引き継いだりします',
  'tool.label': '印の種類', 'tool.box': '枠', 'tool.arrow': '矢印', 'tool.point': '点',
  note: '次の印へのメモ（任意）',
  'control.agent': 'エージェントが操作中', 'control.paused': 'エージェントは一時停止中。画面を固定したので印を付けられます', 'control.human': 'あなたが操作中です。クリックとキー入力はページに送られます',
  pause: '一時停止', resume: '再開', take: '引き継ぐ', handBack: 'エージェントに戻す',
  ask: 'エージェントからの依頼：', answer: '印を回答として送信',
  pending: 'エージェントへの送信待ちの印', remove: '削除', noElement: '要素が見つかりません',
  waiting: 'ブラウザに接続しています…', failed: 'ブラウザを起動できませんでした：', view: '共有ブラウザの画面',
  'surface.label': '画面', 'surface.browser': 'ブラウザ', 'surface.desktop': 'デスクトップ', desktopView: 'デスクトップの画面', waitingDesktop: 'デスクトップを読み込んでいます…', noWindow: 'デスクトップ上の位置', markScreen: '画面上で印を付ける', markScreenHint: '3 秒後に画面を固定し、実際の画面に印を付けます', discuss: '先にエージェントに聞く', discussHint: 'これらの印を先にエージェントと確認しますか？操作せずに返信します。', discussing: '印について相談中：会話で返信するか、「再開」を押してください',
} satisfies Record<keyof typeof zh, string>

/** Spanish copy. */
export const es = {
  title: 'Lienzo compartido', description: 'Mira el navegador del agente en directo, marca la página o toma el control',
  'tool.label': 'Marcar con', 'tool.box': 'Recuadro', 'tool.arrow': 'Flecha', 'tool.point': 'Punto',
  note: 'Nota para tu próxima marca (opcional)',
  'control.agent': 'El agente tiene el control', 'control.paused': 'El agente está en pausa; la vista está congelada para marcar', 'control.human': 'Tienes el control; los clics y las teclas van a la página',
  pause: 'Pausar', resume: 'Reanudar', take: 'Tomar el control', handBack: 'Devolver',
  ask: 'El agente te pide que marques:', answer: 'Enviar marcas como respuesta',
  pending: 'Marcas pendientes para el agente', remove: 'Quitar', noElement: 'ningún elemento',
  waiting: 'Conectando con el navegador…', failed: 'No se pudo iniciar el navegador:', view: 'Vista del navegador compartido',
  'surface.label': 'Vista', 'surface.browser': 'Navegador', 'surface.desktop': 'Escritorio', desktopView: 'Vista del escritorio', waitingDesktop: 'Leyendo el escritorio…', noWindow: 'un lugar del escritorio', markScreen: 'Marcar en la pantalla', markScreenHint: 'Congela la pantalla en 3 s para marcar la pantalla real', discuss: 'Preguntar primero al agente', discussHint: '¿Revisar estas marcas con el agente antes? Responde sin actuar.', discussing: 'Comentando tus marcas: responde en la conversación o pulsa Reanudar',
} satisfies Record<keyof typeof zh, string>

/** French copy. */
export const fr = {
  title: 'Canevas partagé', description: 'Suivez le navigateur de l\'agent en direct, annotez la page ou prenez la main',
  'tool.label': 'Annoter avec', 'tool.box': 'Cadre', 'tool.arrow': 'Flèche', 'tool.point': 'Point',
  note: 'Note pour votre prochaine annotation (facultatif)',
  'control.agent': 'L\'agent a la main', 'control.paused': 'L\'agent est en pause ; la vue est figée pour annoter', 'control.human': 'Vous avez la main ; les clics et les touches vont à la page',
  pause: 'Pause', resume: 'Reprendre', take: 'Prendre la main', handBack: 'Rendre la main',
  ask: 'L\'agent vous demande d\'annoter :', answer: 'Envoyer les annotations comme réponse',
  pending: 'Annotations en attente pour l\'agent', remove: 'Retirer', noElement: 'aucun élément',
  waiting: 'Connexion au navigateur…', failed: 'Le navigateur n\'a pas pu démarrer :', view: 'Vue du navigateur partagé',
  'surface.label': 'Vue', 'surface.browser': 'Navigateur', 'surface.desktop': 'Bureau', desktopView: 'Vue du bureau', waitingDesktop: 'Lecture du bureau…', noWindow: 'un endroit du bureau', markScreen: 'Marquer à l\'écran', markScreenHint: 'Fige l\'écran dans 3 s pour marquer l\'écran réel', discuss: 'Demander d\'abord à l\'agent', discussHint: 'Vérifier ces marques avec l\'agent d\'abord ? Il répond sans agir.', discussing: 'Discussion de vos marques : répondez dans la conversation ou appuyez sur Reprendre',
} satisfies Record<keyof typeof zh, string>

/** German copy. */
export const de = {
  title: 'Gemeinsame Leinwand', description: 'Den Browser des Agenten live verfolgen, die Seite markieren oder übernehmen',
  'tool.label': 'Markieren mit', 'tool.box': 'Rahmen', 'tool.arrow': 'Pfeil', 'tool.point': 'Punkt',
  note: 'Notiz zur nächsten Markierung (optional)',
  'control.agent': 'Der Agent steuert', 'control.paused': 'Der Agent ist pausiert; die Ansicht ist zum Markieren eingefroren', 'control.human': 'Sie steuern; Klicks und Tasten gehen an die Seite',
  pause: 'Pausieren', resume: 'Fortsetzen', take: 'Übernehmen', handBack: 'Zurückgeben',
  ask: 'Der Agent bittet um eine Markierung:', answer: 'Markierungen als Antwort senden',
  pending: 'Markierungen für den Agenten', remove: 'Entfernen', noElement: 'kein Element gefunden',
  waiting: 'Verbindung zum Browser…', failed: 'Der Browser konnte nicht starten:', view: 'Ansicht des gemeinsamen Browsers',
  'surface.label': 'Ansicht', 'surface.browser': 'Browser', 'surface.desktop': 'Desktop', desktopView: 'Desktop-Ansicht', waitingDesktop: 'Desktop wird gelesen…', noWindow: 'eine Stelle auf dem Desktop', markScreen: 'Auf dem Bildschirm markieren', markScreenHint: 'Friert den Bildschirm in 3 s ein, damit Sie den echten Bildschirm markieren', discuss: 'Zuerst den Agenten fragen', discussHint: 'Diese Markierungen zuerst mit dem Agenten klären? Er antwortet, ohne zu handeln.', discussing: 'Markierungen werden besprochen: im Gespräch antworten oder Fortsetzen drücken',
} satisfies Record<keyof typeof zh, string>

/** Russian copy. */
export const ru = {
  title: 'Общий холст', description: 'Смотрите браузер агента в реальном времени, отмечайте страницу или берите управление',
  'tool.label': 'Отметка', 'tool.box': 'Рамка', 'tool.arrow': 'Стрелка', 'tool.point': 'Точка',
  note: 'Комментарий к следующей отметке (необязательно)',
  'control.agent': 'Управляет агент', 'control.paused': 'Агент на паузе; изображение заморожено для отметок', 'control.human': 'Управляете вы; клики и клавиши идут на страницу',
  pause: 'Пауза', resume: 'Продолжить', take: 'Взять управление', handBack: 'Вернуть агенту',
  ask: 'Агент просит отметить:', answer: 'Отправить отметки как ответ',
  pending: 'Отметки ждут агента', remove: 'Удалить', noElement: 'элемент не найден',
  waiting: 'Подключение к браузеру…', failed: 'Не удалось запустить браузер:', view: 'Вид общего браузера',
  'surface.label': 'Вид', 'surface.browser': 'Браузер', 'surface.desktop': 'Рабочий стол', desktopView: 'Вид рабочего стола', waitingDesktop: 'Чтение рабочего стола…', noWindow: 'место на рабочем столе', markScreen: 'Отметить на экране', markScreenHint: 'Через 3 с экран замрёт, чтобы отметить реальный экран', discuss: 'Сначала спросить агента', discussHint: 'Сначала уточнить эти отметки с агентом? Он ответит, не выполняя действий.', discussing: 'Обсуждение отметок: ответьте в беседе или нажмите «Продолжить»',
} satisfies Record<keyof typeof zh, string>

/** Portuguese copy. */
export const pt = {
  title: 'Tela compartilhada', description: 'Veja o navegador do agente ao vivo, marque a página ou assuma o controle',
  'tool.label': 'Marcar com', 'tool.box': 'Caixa', 'tool.arrow': 'Seta', 'tool.point': 'Ponto',
  note: 'Nota para a próxima marca (opcional)',
  'control.agent': 'O agente está no controle', 'control.paused': 'O agente está pausado; a visualização está congelada para marcar', 'control.human': 'Você está no controle; cliques e teclas vão para a página',
  pause: 'Pausar', resume: 'Retomar', take: 'Assumir', handBack: 'Devolver',
  ask: 'O agente pede que você marque:', answer: 'Enviar marcas como resposta',
  pending: 'Marcas aguardando o agente', remove: 'Remover', noElement: 'nenhum elemento',
  waiting: 'Conectando ao navegador…', failed: 'Não foi possível iniciar o navegador:', view: 'Visão do navegador compartilhado',
  'surface.label': 'Visão', 'surface.browser': 'Navegador', 'surface.desktop': 'Área de trabalho', desktopView: 'Visão da área de trabalho', waitingDesktop: 'Lendo a área de trabalho…', noWindow: 'um lugar na área de trabalho', markScreen: 'Marcar na tela', markScreenHint: 'Congela a tela em 3 s para marcar a tela real', discuss: 'Perguntar ao agente primeiro', discussHint: 'Conferir estas marcas com o agente primeiro? Ele responde sem agir.', discussing: 'Discutindo suas marcas: responda na conversa ou clique em Retomar',
} satisfies Record<keyof typeof zh, string>
