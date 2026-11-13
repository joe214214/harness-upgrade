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
  title: '协同画布', description: '实时查看 agent 的浏览器和桌面，标注、提问、回到之前的步骤或接管操作',
  'tool.label': '标注方式', 'tool.box': '框选', 'tool.arrow': '箭头', 'tool.point': '点选',
  note: '写一句说明或问题，例如：点这个 / 这是哪个航班？',
  'control.agent': 'Agent 正在操作', 'control.paused': 'Agent 已暂停，画面已定格，可以在上面标注', 'control.human': '你正在操作，点击和键盘输入会发送到页面',
  pause: '暂停', resume: '继续', take: '接管', handBack: '交还给 agent',
  ask: 'Agent 请你标注：', answer: '发送标注作为回答',
  pending: '已发给 Agent，等它处理：', remove: '移除', noElement: '未找到元素',
  waiting: '正在连接浏览器…', failed: '浏览器启动失败：', view: '共享浏览器画面',
  'surface.label': '画面', 'surface.browser': '浏览器', 'surface.desktop': '桌面', desktopView: '桌面画面', waitingDesktop: '正在读取桌面…', noWindow: '桌面上的位置', markScreen: '在屏幕上框选', markScreenHint: '3 秒后冻结屏幕，在真实屏幕上标注',
  'brief.title': '任务背景', 'brief.where': '位置', 'brief.progress': '进展', 'brief.edit': '修改', 'brief.save': '保存', 'brief.goal': '任务目标', 'timeline.title': '时间轴', 'timeline.live': '实时', 'timeline.step': '第 {n} 步', 'timeline.irreversible': '可能无法撤销', 'timeline.hint': '在这一步的画面上标注，然后提问或让 Agent 从这里重来', 'ask.button': '问一下', rewind: '从这里错了', 'answers.title': '问答', 'answers.model': '回答模型', 'answers.pause': '问的时候暂停 Agent', 'answers.answering': '回答中…', 'answers.onStep': '第 {n} 步', 'answers.default': '默认', 'answers.image': '能看图',
  'control.idle': 'Agent 空闲', 'control.humanDesktop': '你正在操作：直接用鼠标和键盘操作电脑，完成后点“交还给 agent”', 'ask.default': '这是什么？', 'ask.send': '发给 Agent', drafts: '还没发出的标注：可以问一下，或发给 Agent 当作指令',
  'act.click': '点击', 'act.double_click': '双击', 'act.right_click': '右键', 'act.type_text': '输入', 'act.press_key': '按键', 'act.hotkey': '快捷键', 'act.scroll': '滚动', 'act.set_value': '填写', 'act.launch_app': '打开应用', 'act.drag': '拖动', 'act.browser_navigate': '打开网页', 'act.browser_click': '点击', 'act.browser_type': '输入', 'act.browser_select_option': '选择',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  title: 'Co-canvas', description: 'Watch the agent\'s browser and desktop live, mark them, ask about them, go back to an earlier step, or take over',
  'tool.label': 'Mark with', 'tool.box': 'Box', 'tool.arrow': 'Arrow', 'tool.point': 'Point',
  note: 'An instruction or a question, e.g. press this / which flight is this?',
  'control.agent': 'The agent is in control', 'control.paused': 'The agent is paused; the view is frozen for marking', 'control.human': 'You are in control; clicks and keys go to the page',
  pause: 'Pause', resume: 'Resume', take: 'Take over', handBack: 'Hand back',
  ask: 'The agent asks you to mark:', answer: 'Send marks as answer',
  pending: 'Sent to the agent, waiting for it to take them:', remove: 'Remove', noElement: 'no element found',
  waiting: 'Connecting to the browser…', failed: 'The browser failed to start:', view: 'Shared browser view',
  'surface.label': 'View', 'surface.browser': 'Browser', 'surface.desktop': 'Desktop', desktopView: 'Desktop view', waitingDesktop: 'Reading the desktop…', noWindow: 'a place on the desktop', markScreen: 'Mark on screen', markScreenHint: 'Freezes the screen in 3 s so you can mark the real screen',
  'brief.title': 'Task', 'brief.where': 'Where', 'brief.progress': 'Progress', 'brief.edit': 'Edit', 'brief.save': 'Save', 'brief.goal': 'Task goal', 'timeline.title': 'Timeline', 'timeline.live': 'Live', 'timeline.step': 'Step {n}', 'timeline.irreversible': 'may not be undoable', 'timeline.hint': 'Mark this step\'s screen, then ask about it or send the agent back here', 'ask.button': 'Ask', rewind: 'Went wrong here', 'answers.title': 'Questions', 'answers.model': 'Answering model', 'answers.pause': 'Pause the agent while answering', 'answers.answering': 'Answering…', 'answers.onStep': 'Step {n}', 'answers.default': 'Default', 'answers.image': 'sees images',
  'control.idle': 'The agent is idle', 'control.humanDesktop': 'You are in control: use your own mouse and keyboard on the computer, then press Hand back', 'ask.default': 'What is this?', 'ask.send': 'Send to agent', drafts: 'Marks not sent yet: ask about them, or send them to the agent as instructions',
  'act.click': 'click', 'act.double_click': 'double-click', 'act.right_click': 'right-click', 'act.type_text': 'type', 'act.press_key': 'key', 'act.hotkey': 'shortcut', 'act.scroll': 'scroll', 'act.set_value': 'fill in', 'act.launch_app': 'open app', 'act.drag': 'drag', 'act.browser_navigate': 'open page', 'act.browser_click': 'click', 'act.browser_type': 'type', 'act.browser_select_option': 'select',
} satisfies Record<keyof typeof zh, string>

/** Japanese copy. */
export const ja = {
  title: '共同キャンバス', description: 'エージェントのブラウザとデスクトップをリアルタイムで見て、印を付け、質問し、前のステップに戻し、操作を引き継ぎます',
  'tool.label': '印の種類', 'tool.box': '枠', 'tool.arrow': '矢印', 'tool.point': '点',
  note: '指示か質問を入力（例：これを押して／これはどの便？）',
  'control.agent': 'エージェントが操作中', 'control.paused': 'エージェントは一時停止中。画面を固定したので印を付けられます', 'control.human': 'あなたが操作中です。クリックとキー入力はページに送られます',
  pause: '一時停止', resume: '再開', take: '引き継ぐ', handBack: 'エージェントに戻す',
  ask: 'エージェントからの依頼：', answer: '印を回答として送信',
  pending: 'エージェントに送信済み。処理を待っています：', remove: '削除', noElement: '要素が見つかりません',
  waiting: 'ブラウザに接続しています…', failed: 'ブラウザを起動できませんでした：', view: '共有ブラウザの画面',
  'surface.label': '画面', 'surface.browser': 'ブラウザ', 'surface.desktop': 'デスクトップ', desktopView: 'デスクトップの画面', waitingDesktop: 'デスクトップを読み込んでいます…', noWindow: 'デスクトップ上の位置', markScreen: '画面上で印を付ける', markScreenHint: '3 秒後に画面を固定し、実際の画面に印を付けます',
  'brief.title': 'タスク', 'brief.where': '場所', 'brief.progress': '進捗', 'brief.edit': '編集', 'brief.save': '保存', 'brief.goal': 'タスクの目的', 'timeline.title': 'タイムライン', 'timeline.live': 'ライブ', 'timeline.step': 'ステップ {n}', 'timeline.irreversible': '元に戻せない可能性', 'timeline.hint': 'このステップの画面に印を付けて質問するか、ここからやり直させます', 'ask.button': '質問', rewind: 'ここで間違えた', 'answers.title': '質問と回答', 'answers.model': '回答モデル', 'answers.pause': '回答中はエージェントを一時停止', 'answers.answering': '回答中…', 'answers.onStep': 'ステップ {n}', 'answers.default': '既定', 'answers.image': '画像対応',
  'control.idle': 'エージェントは待機中', 'control.humanDesktop': 'あなたが操作中：自分のマウスとキーボードでコンピューターを操作し、終わったら「エージェントに戻す」を押してください', 'ask.default': 'これは何？', 'ask.send': 'エージェントに送る', drafts: 'まだ送っていない印：質問するか、指示としてエージェントに送ります',
  'act.click': 'クリック', 'act.double_click': 'ダブルクリック', 'act.right_click': '右クリック', 'act.type_text': '入力', 'act.press_key': 'キー', 'act.hotkey': 'ショートカット', 'act.scroll': 'スクロール', 'act.set_value': '入力', 'act.launch_app': 'アプリを開く', 'act.drag': 'ドラッグ', 'act.browser_navigate': 'ページを開く', 'act.browser_click': 'クリック', 'act.browser_type': '入力', 'act.browser_select_option': '選択',
} satisfies Record<keyof typeof zh, string>

/** Spanish copy. */
export const es = {
  title: 'Lienzo compartido', description: 'Mira el navegador y el escritorio del agente en directo, márcalos, pregunta, vuelve a un paso anterior o toma el control',
  'tool.label': 'Marcar con', 'tool.box': 'Recuadro', 'tool.arrow': 'Flecha', 'tool.point': 'Punto',
  note: 'Una instrucción o una pregunta, p. ej. pulsa esto / ¿qué vuelo es este?',
  'control.agent': 'El agente tiene el control', 'control.paused': 'El agente está en pausa; la vista está congelada para marcar', 'control.human': 'Tienes el control; los clics y las teclas van a la página',
  pause: 'Pausar', resume: 'Reanudar', take: 'Tomar el control', handBack: 'Devolver',
  ask: 'El agente te pide que marques:', answer: 'Enviar marcas como respuesta',
  pending: 'Enviadas al agente, esperando a que las atienda:', remove: 'Quitar', noElement: 'ningún elemento',
  waiting: 'Conectando con el navegador…', failed: 'No se pudo iniciar el navegador:', view: 'Vista del navegador compartido',
  'surface.label': 'Vista', 'surface.browser': 'Navegador', 'surface.desktop': 'Escritorio', desktopView: 'Vista del escritorio', waitingDesktop: 'Leyendo el escritorio…', noWindow: 'un lugar del escritorio', markScreen: 'Marcar en la pantalla', markScreenHint: 'Congela la pantalla en 3 s para marcar la pantalla real',
  'brief.title': 'Tarea', 'brief.where': 'Dónde', 'brief.progress': 'Progreso', 'brief.edit': 'Editar', 'brief.save': 'Guardar', 'brief.goal': 'Objetivo de la tarea', 'timeline.title': 'Cronología', 'timeline.live': 'En directo', 'timeline.step': 'Paso {n}', 'timeline.irreversible': 'puede no deshacerse', 'timeline.hint': 'Marca la pantalla de este paso y pregunta o haz que el agente vuelva aquí', 'ask.button': 'Preguntar', rewind: 'Aquí se equivocó', 'answers.title': 'Preguntas', 'answers.model': 'Modelo que responde', 'answers.pause': 'Pausar al agente mientras responde', 'answers.answering': 'Respondiendo…', 'answers.onStep': 'Paso {n}', 'answers.default': 'Predeterminado', 'answers.image': 've imágenes',
  'control.idle': 'El agente está inactivo', 'control.humanDesktop': 'Tienes el control: usa tu ratón y teclado en el ordenador y luego pulsa Devolver', 'ask.default': '¿Qué es esto?', 'ask.send': 'Enviar al agente', drafts: 'Marcas sin enviar: pregunta por ellas o envíalas al agente como instrucciones',
  'act.click': 'clic', 'act.double_click': 'doble clic', 'act.right_click': 'clic derecho', 'act.type_text': 'escribir', 'act.press_key': 'tecla', 'act.hotkey': 'atajo', 'act.scroll': 'desplazar', 'act.set_value': 'rellenar', 'act.launch_app': 'abrir app', 'act.drag': 'arrastrar', 'act.browser_navigate': 'abrir página', 'act.browser_click': 'clic', 'act.browser_type': 'escribir', 'act.browser_select_option': 'elegir',
} satisfies Record<keyof typeof zh, string>

/** French copy. */
export const fr = {
  title: 'Canevas partagé', description: 'Suivez le navigateur et le bureau de l\'agent en direct, annotez-les, posez des questions, revenez à une étape antérieure ou prenez la main',
  'tool.label': 'Annoter avec', 'tool.box': 'Cadre', 'tool.arrow': 'Flèche', 'tool.point': 'Point',
  note: 'Une consigne ou une question, p. ex. appuie ici / quel vol est-ce ?',
  'control.agent': 'L\'agent a la main', 'control.paused': 'L\'agent est en pause ; la vue est figée pour annoter', 'control.human': 'Vous avez la main ; les clics et les touches vont à la page',
  pause: 'Pause', resume: 'Reprendre', take: 'Prendre la main', handBack: 'Rendre la main',
  ask: 'L\'agent vous demande d\'annoter :', answer: 'Envoyer les annotations comme réponse',
  pending: 'Envoyées à l\'agent, en attente de traitement :', remove: 'Retirer', noElement: 'aucun élément',
  waiting: 'Connexion au navigateur…', failed: 'Le navigateur n\'a pas pu démarrer :', view: 'Vue du navigateur partagé',
  'surface.label': 'Vue', 'surface.browser': 'Navigateur', 'surface.desktop': 'Bureau', desktopView: 'Vue du bureau', waitingDesktop: 'Lecture du bureau…', noWindow: 'un endroit du bureau', markScreen: 'Marquer à l\'écran', markScreenHint: 'Fige l\'écran dans 3 s pour marquer l\'écran réel',
  'brief.title': 'Tâche', 'brief.where': 'Où', 'brief.progress': 'Avancement', 'brief.edit': 'Modifier', 'brief.save': 'Enregistrer', 'brief.goal': 'Objectif de la tâche', 'timeline.title': 'Chronologie', 'timeline.live': 'En direct', 'timeline.step': 'Étape {n}', 'timeline.irreversible': 'peut-être irréversible', 'timeline.hint': 'Annotez l\'écran de cette étape, puis posez une question ou renvoyez l\'agent ici', 'ask.button': 'Demander', rewind: 'Erreur à partir d\'ici', 'answers.title': 'Questions', 'answers.model': 'Modèle qui répond', 'answers.pause': 'Mettre l\'agent en pause pendant la réponse', 'answers.answering': 'Réponse en cours…', 'answers.onStep': 'Étape {n}', 'answers.default': 'Par défaut', 'answers.image': 'voit les images',
  'control.idle': 'L\'agent est inactif', 'control.humanDesktop': 'Vous avez la main : utilisez votre souris et votre clavier sur l\'ordinateur, puis cliquez sur Rendre la main', 'ask.default': 'Qu\'est-ce que c\'est ?', 'ask.send': 'Envoyer à l\'agent', drafts: 'Annotations non envoyées : posez une question ou envoyez-les à l\'agent comme consignes',
  'act.click': 'clic', 'act.double_click': 'double-clic', 'act.right_click': 'clic droit', 'act.type_text': 'saisie', 'act.press_key': 'touche', 'act.hotkey': 'raccourci', 'act.scroll': 'défilement', 'act.set_value': 'remplir', 'act.launch_app': 'ouvrir une app', 'act.drag': 'glisser', 'act.browser_navigate': 'ouvrir la page', 'act.browser_click': 'clic', 'act.browser_type': 'saisie', 'act.browser_select_option': 'choisir',
} satisfies Record<keyof typeof zh, string>

/** German copy. */
export const de = {
  title: 'Gemeinsame Leinwand', description: 'Browser und Desktop des Agenten live ansehen, markieren, Fragen stellen, zu einem früheren Schritt zurückkehren oder übernehmen',
  'tool.label': 'Markieren mit', 'tool.box': 'Rahmen', 'tool.arrow': 'Pfeil', 'tool.point': 'Punkt',
  note: 'Eine Anweisung oder eine Frage, z. B. drück hier / welcher Flug ist das?',
  'control.agent': 'Der Agent steuert', 'control.paused': 'Der Agent ist pausiert; die Ansicht ist zum Markieren eingefroren', 'control.human': 'Sie steuern; Klicks und Tasten gehen an die Seite',
  pause: 'Pausieren', resume: 'Fortsetzen', take: 'Übernehmen', handBack: 'Zurückgeben',
  ask: 'Der Agent bittet um eine Markierung:', answer: 'Markierungen als Antwort senden',
  pending: 'An den Agenten gesendet, wartet auf Bearbeitung:', remove: 'Entfernen', noElement: 'kein Element gefunden',
  waiting: 'Verbindung zum Browser…', failed: 'Der Browser konnte nicht starten:', view: 'Ansicht des gemeinsamen Browsers',
  'surface.label': 'Ansicht', 'surface.browser': 'Browser', 'surface.desktop': 'Desktop', desktopView: 'Desktop-Ansicht', waitingDesktop: 'Desktop wird gelesen…', noWindow: 'eine Stelle auf dem Desktop', markScreen: 'Auf dem Bildschirm markieren', markScreenHint: 'Friert den Bildschirm in 3 s ein, damit Sie den echten Bildschirm markieren',
  'brief.title': 'Aufgabe', 'brief.where': 'Wo', 'brief.progress': 'Fortschritt', 'brief.edit': 'Bearbeiten', 'brief.save': 'Speichern', 'brief.goal': 'Ziel der Aufgabe', 'timeline.title': 'Zeitleiste', 'timeline.live': 'Live', 'timeline.step': 'Schritt {n}', 'timeline.irreversible': 'evtl. nicht rückgängig zu machen', 'timeline.hint': 'Markieren Sie den Bildschirm dieses Schritts und fragen Sie, oder schicken Sie den Agenten hierher zurück', 'ask.button': 'Fragen', rewind: 'Hier lief es falsch', 'answers.title': 'Fragen', 'answers.model': 'Antwortendes Modell', 'answers.pause': 'Agent während der Antwort pausieren', 'answers.answering': 'Antwortet…', 'answers.onStep': 'Schritt {n}', 'answers.default': 'Standard', 'answers.image': 'sieht Bilder',
  'control.idle': 'Der Agent ist untätig', 'control.humanDesktop': 'Sie steuern: Bedienen Sie den Computer mit Ihrer eigenen Maus und Tastatur und klicken Sie dann auf Zurückgeben', 'ask.default': 'Was ist das?', 'ask.send': 'An Agenten senden', drafts: 'Noch nicht gesendete Markierungen: fragen Sie dazu oder senden Sie sie als Anweisung an den Agenten',
  'act.click': 'Klick', 'act.double_click': 'Doppelklick', 'act.right_click': 'Rechtsklick', 'act.type_text': 'Eingabe', 'act.press_key': 'Taste', 'act.hotkey': 'Tastenkürzel', 'act.scroll': 'Scrollen', 'act.set_value': 'Ausfüllen', 'act.launch_app': 'App öffnen', 'act.drag': 'Ziehen', 'act.browser_navigate': 'Seite öffnen', 'act.browser_click': 'Klick', 'act.browser_type': 'Eingabe', 'act.browser_select_option': 'Auswahl',
} satisfies Record<keyof typeof zh, string>

/** Russian copy. */
export const ru = {
  title: 'Общий холст', description: 'Смотрите браузер и рабочий стол агента в реальном времени, отмечайте, задавайте вопросы, возвращайтесь к прежнему шагу или берите управление',
  'tool.label': 'Отметка', 'tool.box': 'Рамка', 'tool.arrow': 'Стрелка', 'tool.point': 'Точка',
  note: 'Указание или вопрос, например: нажми это / какой это рейс?',
  'control.agent': 'Управляет агент', 'control.paused': 'Агент на паузе; изображение заморожено для отметок', 'control.human': 'Управляете вы; клики и клавиши идут на страницу',
  pause: 'Пауза', resume: 'Продолжить', take: 'Взять управление', handBack: 'Вернуть агенту',
  ask: 'Агент просит отметить:', answer: 'Отправить отметки как ответ',
  pending: 'Отправлено агенту, ожидает обработки:', remove: 'Удалить', noElement: 'элемент не найден',
  waiting: 'Подключение к браузеру…', failed: 'Не удалось запустить браузер:', view: 'Вид общего браузера',
  'surface.label': 'Вид', 'surface.browser': 'Браузер', 'surface.desktop': 'Рабочий стол', desktopView: 'Вид рабочего стола', waitingDesktop: 'Чтение рабочего стола…', noWindow: 'место на рабочем столе', markScreen: 'Отметить на экране', markScreenHint: 'Через 3 с экран замрёт, чтобы отметить реальный экран',
  'brief.title': 'Задача', 'brief.where': 'Где', 'brief.progress': 'Ход работы', 'brief.edit': 'Изменить', 'brief.save': 'Сохранить', 'brief.goal': 'Цель задачи', 'timeline.title': 'Хронология', 'timeline.live': 'Сейчас', 'timeline.step': 'Шаг {n}', 'timeline.irreversible': 'может быть необратимо', 'timeline.hint': 'Отметьте экран этого шага и задайте вопрос или верните агента сюда', 'ask.button': 'Спросить', rewind: 'Ошибка отсюда', 'answers.title': 'Вопросы', 'answers.model': 'Модель для ответов', 'answers.pause': 'Ставить агента на паузу во время ответа', 'answers.answering': 'Отвечает…', 'answers.onStep': 'Шаг {n}', 'answers.default': 'По умолчанию', 'answers.image': 'видит изображения',
  'control.idle': 'Агент бездействует', 'control.humanDesktop': 'Управляете вы: работайте на компьютере своей мышью и клавиатурой, затем нажмите «Вернуть»', 'ask.default': 'Что это?', 'ask.send': 'Отправить агенту', drafts: 'Неотправленные отметки: спросите о них или отправьте агенту как указание',
  'act.click': 'клик', 'act.double_click': 'двойной клик', 'act.right_click': 'правый клик', 'act.type_text': 'ввод', 'act.press_key': 'клавиша', 'act.hotkey': 'сочетание', 'act.scroll': 'прокрутка', 'act.set_value': 'заполнение', 'act.launch_app': 'запуск', 'act.drag': 'перетаскивание', 'act.browser_navigate': 'открыть страницу', 'act.browser_click': 'клик', 'act.browser_type': 'ввод', 'act.browser_select_option': 'выбор',
} satisfies Record<keyof typeof zh, string>

/** Portuguese copy. */
export const pt = {
  title: 'Tela compartilhada', description: 'Veja o navegador e a área de trabalho do agente ao vivo, marque, pergunte, volte a um passo anterior ou assuma o controle',
  'tool.label': 'Marcar com', 'tool.box': 'Caixa', 'tool.arrow': 'Seta', 'tool.point': 'Ponto',
  note: 'Uma instrução ou pergunta, ex.: clique aqui / que voo é este?',
  'control.agent': 'O agente está no controle', 'control.paused': 'O agente está pausado; a visualização está congelada para marcar', 'control.human': 'Você está no controle; cliques e teclas vão para a página',
  pause: 'Pausar', resume: 'Retomar', take: 'Assumir', handBack: 'Devolver',
  ask: 'O agente pede que você marque:', answer: 'Enviar marcas como resposta',
  pending: 'Enviadas ao agente, aguardando que ele as processe:', remove: 'Remover', noElement: 'nenhum elemento',
  waiting: 'Conectando ao navegador…', failed: 'Não foi possível iniciar o navegador:', view: 'Visão do navegador compartilhado',
  'surface.label': 'Visão', 'surface.browser': 'Navegador', 'surface.desktop': 'Área de trabalho', desktopView: 'Visão da área de trabalho', waitingDesktop: 'Lendo a área de trabalho…', noWindow: 'um lugar na área de trabalho', markScreen: 'Marcar na tela', markScreenHint: 'Congela a tela em 3 s para marcar a tela real',
  'brief.title': 'Tarefa', 'brief.where': 'Onde', 'brief.progress': 'Progresso', 'brief.edit': 'Editar', 'brief.save': 'Salvar', 'brief.goal': 'Objetivo da tarefa', 'timeline.title': 'Linha do tempo', 'timeline.live': 'Ao vivo', 'timeline.step': 'Passo {n}', 'timeline.irreversible': 'pode não ser reversível', 'timeline.hint': 'Marque a tela deste passo e pergunte, ou faça o agente voltar aqui', 'ask.button': 'Perguntar', rewind: 'Errou a partir daqui', 'answers.title': 'Perguntas', 'answers.model': 'Modelo que responde', 'answers.pause': 'Pausar o agente enquanto responde', 'answers.answering': 'Respondendo…', 'answers.onStep': 'Passo {n}', 'answers.default': 'Padrão', 'answers.image': 'vê imagens',
  'control.idle': 'O agente está ocioso', 'control.humanDesktop': 'Você está no controle: use seu mouse e teclado no computador e depois clique em Devolver', 'ask.default': 'O que é isto?', 'ask.send': 'Enviar ao agente', drafts: 'Marcas ainda não enviadas: pergunte sobre elas ou envie-as ao agente como instruções',
  'act.click': 'clique', 'act.double_click': 'clique duplo', 'act.right_click': 'clique direito', 'act.type_text': 'digitar', 'act.press_key': 'tecla', 'act.hotkey': 'atalho', 'act.scroll': 'rolar', 'act.set_value': 'preencher', 'act.launch_app': 'abrir app', 'act.drag': 'arrastar', 'act.browser_navigate': 'abrir página', 'act.browser_click': 'clique', 'act.browser_type': 'digitar', 'act.browser_select_option': 'escolher',
} satisfies Record<keyof typeof zh, string>
