/**
 * Strings of the note about schema extensions (FCS Extended files of the opened mod and of its
 * dependencies), in the three interface languages. Merged into the common dictionary of `i18n.ts`.
 */
export const extensionsEn = {
  extTitle: 'Schema extensions',
  extNote: 'FCS Extended files (fcs.def, fcs_preload.def, *.def.patch) from the folder of this mod and of its dependencies are applied automatically.',
  extBadge: (n: number): string => `extensions: ${String(n)}`,
  extBadgeTip: 'Schema extensions (FCS Extended files) are applied to this mod; the list is in “Mod info”',
  extTypes: 'types',
  extFields: 'fields',
  extEnums: 'enums',
  extEnumValues: 'enum values',
  extNoNumber: 'no number',
  extNothing: 'adds nothing to the schema',
  extMore: (n: number): string => `+${String(n)} more`,
  extWarnings: (n: number): string => `warnings: ${String(n)}`,
  extPlugins: (list: string): string => `DLL plugins (not run in Cactus): ${list}`,
};

export type ExtensionStrings = typeof extensionsEn;

export const extensionsRu: ExtensionStrings = {
  extTitle: 'Расширения схемы',
  extNote: 'Файлы FCS Extended (fcs.def, fcs_preload.def, *.def.patch) из папки этого мода и его зависимостей применяются автоматически.',
  extBadge: (n) => `расширения: ${String(n)}`,
  extBadgeTip: 'К моду применены расширения схемы (файлы FCS Extended); список — в окне «О моде»',
  extTypes: 'типы',
  extFields: 'поля',
  extEnums: 'списки значений',
  extEnumValues: 'значения списков',
  extNoNumber: 'без номера',
  extNothing: 'ничего не добавляет в схему',
  extMore: (n) => `ещё ${String(n)}`,
  extWarnings: (n) => `предупреждений: ${String(n)}`,
  extPlugins: (list) => `DLL-плагины (не запускаются в Cactus): ${list}`,
};

export const extensionsZh: ExtensionStrings = {
  extTitle: '架构扩展',
  extNote: '此 Mod 及其依赖项文件夹中的 FCS Extended 文件（fcs.def、fcs_preload.def、*.def.patch）会自动应用。',
  extBadge: (n) => `扩展：${String(n)}`,
  extBadgeTip: '此 Mod 应用了架构扩展（FCS Extended 文件）；列表见“Mod 信息”',
  extTypes: '类型',
  extFields: '字段',
  extEnums: '枚举',
  extEnumValues: '枚举值',
  extNoNumber: '无编号',
  extNothing: '未向架构添加任何内容',
  extMore: (n) => `另有 ${String(n)} 项`,
  extWarnings: (n) => `警告：${String(n)}`,
  extPlugins: (list) => `DLL 插件（不会在 Cactus 中运行）：${list}`,
};
