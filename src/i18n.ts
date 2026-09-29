/**
 * Panel copy in the user's language.
 *
 * OpenChamber hands the guest a BCP-47 tag through `HostReadyContext.locale`
 * on every `onReady` snapshot; the panel picks the closest dictionary and
 * falls back to English. Adding a language is one block in `DICTIONARIES`.
 *
 * Manifest strings (panel name, description) cannot be localized by the
 * extension API — they stay as declared in `package.json`.
 */

export type Locale = 'en' | 'zh-cn' | 'zh-tw';

export const DEFAULT_LOCALE: Locale = 'en';

const en = {
  title: 'Makefile',
  noProject: 'No project open',
  'mode.service': 'Local service',
  'mode.off': 'Service off',
  'mode.unknown': 'Connecting',
  'count.targets': '{n} targets',
  'count.running': '{n} running',
  'count.matches': '{n} of {m} shown',
  'search.placeholder': 'Search targets…',
  'search.clear': 'Clear search',
  'search.empty.title': 'No matching target',
  'search.empty.body': 'No target matches this keyword. Clear the search to see all targets.',
  'banner.off.title': 'The local service is off',
  'banner.off.body': 'Running a target needs the extension local service. Approve it in Settings → Extensions, then reopen the panel.',
  'banner.error.title': 'Cannot reach the local service',
  'banner.error.body': 'Wait a moment or reopen the panel.',
  'empty.noProject.title': 'No project open',
  'empty.noProject.body': 'Open a project in OpenChamber to run its Makefile.',
  'empty.noTargets.title': 'No Makefile found',
  'empty.noTargets.body': 'Add a Makefile (or makefile / GNUmakefile) to this project to see its targets.',
  'target.default': 'default',
  'target.phony': 'phony',
  'target.ready': 'Not run yet',
  'target.running': 'Running…',
  'target.starting': 'Starting…',
  'target.stopping': 'Stopping…',
  'target.run': 'Run',
  'target.stop': 'Stop',
  'target.rerun': 'Run again',
  'status.success': 'Done',
  'status.failed': 'Failed',
  'status.stopped': 'Stopped',
  'status.unknown': 'Unknown',
  'log.empty': 'No output yet',
  'log.loading': 'Loading output…',
  'log.copy': 'Copy',
  'log.clear': 'Clear',
  'log.truncated': 'Earlier output was dropped',
  'log.exit': 'exit {code}',
  'log.duration': '{s}s',
  'toast.copied': 'Output copied',
  'toast.copyFailed': 'Could not copy the output',
  'toast.loadFailed': 'Could not read the Makefile',
  'toast.runFailed': 'Could not start the target',
} as const;

export type MessageKey = keyof typeof en;
type Dictionary = Record<MessageKey, string>;

const zhCn: Dictionary = {
  title: 'Makefile',
  noProject: '未打开项目',
  'mode.service': '本地服务',
  'mode.off': '服务未启用',
  'mode.unknown': '连接中',
  'count.targets': '{n} 个任务',
  'count.running': '{n} 个运行中',
  'count.matches': '显示 {n} / {m}',
  'search.placeholder': '搜索任务…',
  'search.clear': '清除搜索',
  'search.empty.title': '没有匹配的任务',
  'search.empty.body': '没有任务匹配该关键词。清除搜索即可查看全部任务。',
  'banner.off.title': '本地服务未启用',
  'banner.off.body': '运行任务需要扩展的本地服务。请在「设置 → 扩展」中批准后重新打开面板。',
  'banner.error.title': '无法连接本地服务',
  'banner.error.body': '请稍候或重新打开面板。',
  'empty.noProject.title': '未打开项目',
  'empty.noProject.body': '在 OpenChamber 中打开一个项目后即可运行它的 Makefile。',
  'empty.noTargets.title': '未找到 Makefile',
  'empty.noTargets.body': '在项目中添加 Makefile（或 makefile / GNUmakefile）后即可看到其中的任务。',
  'target.default': '默认',
  'target.phony': '伪目标',
  'target.ready': '尚未运行',
  'target.running': '运行中…',
  'target.starting': '启动中…',
  'target.stopping': '停止中…',
  'target.run': '运行',
  'target.stop': '停止',
  'target.rerun': '重新运行',
  'status.success': '完成',
  'status.failed': '失败',
  'status.stopped': '已停止',
  'status.unknown': '未知',
  'log.empty': '暂无输出',
  'log.loading': '正在加载输出…',
  'log.copy': '复制',
  'log.clear': '清空',
  'log.truncated': '前面的输出已被截断',
  'log.exit': '退出码 {code}',
  'log.duration': '{s}s',
  'toast.copied': '已复制输出',
  'toast.copyFailed': '复制输出失败',
  'toast.loadFailed': '读取 Makefile 失败',
  'toast.runFailed': '无法启动该任务',
};

const zhTw: Dictionary = {
  title: 'Makefile',
  noProject: '未開啟專案',
  'mode.service': '本地服務',
  'mode.off': '服務未啟用',
  'mode.unknown': '連線中',
  'count.targets': '{n} 個任務',
  'count.running': '{n} 個執行中',
  'count.matches': '顯示 {n} / {m}',
  'search.placeholder': '搜尋任務…',
  'search.clear': '清除搜尋',
  'search.empty.title': '沒有符合的任務',
  'search.empty.body': '沒有任務符合此關鍵字。清除搜尋即可查看全部任務。',
  'banner.off.title': '本地服務未啟用',
  'banner.off.body': '執行任務需要擴充功能的本地服務。請在「設定 → 擴充功能」中核准後重新開啟面板。',
  'banner.error.title': '無法連線本地服務',
  'banner.error.body': '請稍候或重新開啟面板。',
  'empty.noProject.title': '未開啟專案',
  'empty.noProject.body': '在 OpenChamber 中開啟一個專案後即可執行它的 Makefile。',
  'empty.noTargets.title': '找不到 Makefile',
  'empty.noTargets.body': '在專案中加入 Makefile（或 makefile / GNUmakefile）後即可看到其中的任務。',
  'target.default': '預設',
  'target.phony': '虛擬目標',
  'target.ready': '尚未執行',
  'target.running': '執行中…',
  'target.starting': '啟動中…',
  'target.stopping': '停止中…',
  'target.run': '執行',
  'target.stop': '停止',
  'target.rerun': '重新執行',
  'status.success': '完成',
  'status.failed': '失敗',
  'status.stopped': '已停止',
  'status.unknown': '未知',
  'log.empty': '暫無輸出',
  'log.loading': '正在載入輸出…',
  'log.copy': '複製',
  'log.clear': '清空',
  'log.truncated': '前面的輸出已被截斷',
  'log.exit': '結束碼 {code}',
  'log.duration': '{s}s',
  'toast.copied': '已複製輸出',
  'toast.copyFailed': '複製輸出失敗',
  'toast.loadFailed': '讀取 Makefile 失敗',
  'toast.runFailed': '無法啟動該任務',
};

const DICTIONARIES: Record<Locale, Dictionary> = {
  en,
  'zh-cn': zhCn,
  'zh-tw': zhTw,
};

/** Map an OpenChamber locale tag to the closest dictionary, defaulting to English. */
export const resolveLocale = (tag: string | null | undefined): Locale => {
  const value = (tag ?? '').toLowerCase().replace('_', '-');
  if (value === 'en' || value.startsWith('en-')) return 'en';
  if (value.startsWith('zh')) {
    return /(tw|hk|mo|hant)/.test(value) ? 'zh-tw' : 'zh-cn';
  }
  return DEFAULT_LOCALE;
};

export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

const interpolate = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
};

export const createTranslator = (tag: string | null | undefined): Translator => {
  const dictionary = DICTIONARIES[resolveLocale(tag)];
  return (key, params) => interpolate(dictionary[key] ?? en[key] ?? key, params);
};
