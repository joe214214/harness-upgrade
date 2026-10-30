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
  'control.agent': 'Agent 正在操作', 'control.paused': 'Agent 已暂停', 'control.human': '你正在操作，点击和键盘输入会发送到页面',
  pause: '暂停', resume: '继续', take: '接管', handBack: '交还给 agent',
  ask: 'Agent 请你标注：', answer: '发送标注作为回答',
  pending: '等待送达 agent 的标注', remove: '移除', noElement: '未找到元素',
  waiting: '正在连接浏览器…', view: '共享浏览器画面',
} satisfies Record<string, string>

/** English copy. */
export const en = {
  title: 'Co-canvas', description: 'Watch the agent\'s browser live, mark the page, or take over',
  'tool.label': 'Mark with', 'tool.box': 'Box', 'tool.arrow': 'Arrow', 'tool.point': 'Point',
  note: 'Note for your next mark (optional)',
  'control.agent': 'The agent is in control', 'control.paused': 'The agent is paused', 'control.human': 'You are in control; clicks and keys go to the page',
  pause: 'Pause', resume: 'Resume', take: 'Take over', handBack: 'Hand back',
  ask: 'The agent asks you to mark:', answer: 'Send marks as answer',
  pending: 'Marks waiting for the agent', remove: 'Remove', noElement: 'no element found',
  waiting: 'Connecting to the browser…', view: 'Shared browser view',
} satisfies Record<keyof typeof zh, string>

/** Japanese copy. */
export const ja = {
  title: '共同キャンバス', description: 'エージェントのブラウザをリアルタイムで見て、ページに印を付けたり操作を引き継いだりします',
  'tool.label': '印の種類', 'tool.box': '枠', 'tool.arrow': '矢印', 'tool.point': '点',
  note: '次の印へのメモ（任意）',
  'control.agent': 'エージェントが操作中', 'control.paused': 'エージェントは一時停止中', 'control.human': 'あなたが操作中です。クリックとキー入力はページに送られます',
  pause: '一時停止', resume: '再開', take: '引き継ぐ', handBack: 'エージェントに戻す',
  ask: 'エージェントからの依頼：', answer: '印を回答として送信',
  pending: 'エージェントへの送信待ちの印', remove: '削除', noElement: '要素が見つかりません',
  waiting: 'ブラウザに接続しています…', view: '共有ブラウザの画面',
} satisfies Record<keyof typeof zh, string>

/** Spanish copy. */
export const es = {
  title: 'Lienzo compartido', description: 'Mira el navegador del agente en directo, marca la página o toma el control',
  'tool.label': 'Marcar con', 'tool.box': 'Recuadro', 'tool.arrow': 'Flecha', 'tool.point': 'Punto',
  note: 'Nota para tu próxima marca (opcional)',
  'control.agent': 'El agente tiene el control', 'control.paused': 'El agente está en pausa', 'control.human': 'Tienes el control; los clics y las teclas van a la página',
  pause: 'Pausar', resume: 'Reanudar', take: 'Tomar el control', handBack: 'Devolver',
  ask: 'El agente te pide que marques:', answer: 'Enviar marcas como respuesta',
  pending: 'Marcas pendientes para el agente', remove: 'Quitar', noElement: 'ningún elemento',
  waiting: 'Conectando con el navegador…', view: 'Vista del navegador compartido',
} satisfies Record<keyof typeof zh, string>

/** French copy. */
export const fr = {
  title: 'Canevas partagé', description: 'Suivez le navigateur de l\'agent en direct, annotez la page ou prenez la main',
  'tool.label': 'Annoter avec', 'tool.box': 'Cadre', 'tool.arrow': 'Flèche', 'tool.point': 'Point',
  note: 'Note pour votre prochaine annotation (facultatif)',
  'control.agent': 'L\'agent a la main', 'control.paused': 'L\'agent est en pause', 'control.human': 'Vous avez la main ; les clics et les touches vont à la page',
  pause: 'Pause', resume: 'Reprendre', take: 'Prendre la main', handBack: 'Rendre la main',
  ask: 'L\'agent vous demande d\'annoter :', answer: 'Envoyer les annotations comme réponse',
  pending: 'Annotations en attente pour l\'agent', remove: 'Retirer', noElement: 'aucun élément',
  waiting: 'Connexion au navigateur…', view: 'Vue du navigateur partagé',
} satisfies Record<keyof typeof zh, string>

/** German copy. */
export const de = {
  title: 'Gemeinsame Leinwand', description: 'Den Browser des Agenten live verfolgen, die Seite markieren oder übernehmen',
  'tool.label': 'Markieren mit', 'tool.box': 'Rahmen', 'tool.arrow': 'Pfeil', 'tool.point': 'Punkt',
  note: 'Notiz zur nächsten Markierung (optional)',
  'control.agent': 'Der Agent steuert', 'control.paused': 'Der Agent ist pausiert', 'control.human': 'Sie steuern; Klicks und Tasten gehen an die Seite',
  pause: 'Pausieren', resume: 'Fortsetzen', take: 'Übernehmen', handBack: 'Zurückgeben',
  ask: 'Der Agent bittet um eine Markierung:', answer: 'Markierungen als Antwort senden',
  pending: 'Markierungen für den Agenten', remove: 'Entfernen', noElement: 'kein Element gefunden',
  waiting: 'Verbindung zum Browser…', view: 'Ansicht des gemeinsamen Browsers',
} satisfies Record<keyof typeof zh, string>

/** Russian copy. */
export const ru = {
  title: 'Общий холст', description: 'Смотрите браузер агента в реальном времени, отмечайте страницу или берите управление',
  'tool.label': 'Отметка', 'tool.box': 'Рамка', 'tool.arrow': 'Стрелка', 'tool.point': 'Точка',
  note: 'Комментарий к следующей отметке (необязательно)',
  'control.agent': 'Управляет агент', 'control.paused': 'Агент на паузе', 'control.human': 'Управляете вы; клики и клавиши идут на страницу',
  pause: 'Пауза', resume: 'Продолжить', take: 'Взять управление', handBack: 'Вернуть агенту',
  ask: 'Агент просит отметить:', answer: 'Отправить отметки как ответ',
  pending: 'Отметки ждут агента', remove: 'Удалить', noElement: 'элемент не найден',
  waiting: 'Подключение к браузеру…', view: 'Вид общего браузера',
} satisfies Record<keyof typeof zh, string>

/** Portuguese copy. */
export const pt = {
  title: 'Tela compartilhada', description: 'Veja o navegador do agente ao vivo, marque a página ou assuma o controle',
  'tool.label': 'Marcar com', 'tool.box': 'Caixa', 'tool.arrow': 'Seta', 'tool.point': 'Ponto',
  note: 'Nota para a próxima marca (opcional)',
  'control.agent': 'O agente está no controle', 'control.paused': 'O agente está pausado', 'control.human': 'Você está no controle; cliques e teclas vão para a página',
  pause: 'Pausar', resume: 'Retomar', take: 'Assumir', handBack: 'Devolver',
  ask: 'O agente pede que você marque:', answer: 'Enviar marcas como resposta',
  pending: 'Marcas aguardando o agente', remove: 'Remover', noElement: 'nenhum elemento',
  waiting: 'Conectando ao navegador…', view: 'Visão do navegador compartilhado',
} satisfies Record<keyof typeof zh, string>
