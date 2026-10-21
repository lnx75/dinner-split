// Shared by the page editor and the server; financial rules remain in split.js.
export const CONTENT_TEXT_FIELDS = [
  ['documentTitle', '浏览器页面标题', '品牌与侧栏', 60, '搭个伙 · 聚餐分账'],
  ['brandName', '品牌名称', '品牌与侧栏', 30, '搭个伙'],
  ['workspaceLabel', '空间标签', '品牌与侧栏', 40, '我的聚餐空间'],
  ['gatheringName', '账单名称', '品牌与侧栏', 40, '本次账单'],
  ['heroTitleLine1', '账单标题', '首页介绍', 40, '本次账单'],
  ['heroTitleLine2', '标题补充', '首页介绍', 40, '按菜分摊'],
  ['heroTotalLabel', '总费用标签', '首页介绍', 60, '总费用'],
  ['peopleHeading', '人物区域标题', '人物与费用', 60, '各自应付'],
  ['expensesHeading', '费用区域标题', '人物与费用', 60, '菜品与费用'],
  ['guestTitle', '浏览模式标题', '浏览提示', 60, '当前为浏览模式'],
  ['guestDescription', '浏览模式描述', '浏览提示', 180, '登录后可添加菜品、修改金额和选择分摊成员。', true],
  ['loginTitle', '登录窗口标题', '登录窗口', 80, '登录后，一起算清。'],
  ['loginDescription', '登录窗口描述', '登录窗口', 180, '使用管理员分配的账户编辑聚餐账单。', true],
].map(([key, label, group, maxLength, defaultValue, multiline = false]) => Object.freeze({ key, label, group, maxLength, defaultValue, multiline }));

export const CONTENT_IMAGE_FIELDS = Object.freeze([
  { key: 'sidebar', label: '侧栏插画', allowEmpty: false },
  { key: 'brand', label: '品牌标志', allowEmpty: true },
]);

export const DEFAULT_CONTENT = Object.freeze({
  version: 1,
  texts: Object.freeze(Object.fromEntries(CONTENT_TEXT_FIELDS.map(field => [field.key, field.defaultValue]))),
  images: Object.freeze({
    sidebar: Object.freeze({ src: '/assets/shared-table.svg', alt: '聚餐空间插画', fit: 'contain', position: 'center' }),
    brand: Object.freeze({ src: '', alt: '站点标志', fit: 'contain', position: 'center' }),
  }),
});

export function isContentImageSource(value, allowEmpty = false) {
  return (allowEmpty && value === '') || value === '/assets/shared-table.svg' ||
    (typeof value === 'string' && /^\/media\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg|webp)$/.test(value));
}

// Older installations gain newly introduced fields without losing saved content.
export function normalizeContent(input) {
  const output = { version: Number.isSafeInteger(input?.version) && input.version > 0 ? input.version : 1, texts: {}, images: {} };
  for (const field of CONTENT_TEXT_FIELDS) {
    const value = input?.texts?.[field.key];
    output.texts[field.key] = typeof value === 'string' && value.trim() && value.trim().length <= field.maxLength &&
      (field.multiline || !/[\r\n]/.test(value)) ? value.trim() : field.defaultValue;
  }
  for (const { key, allowEmpty } of CONTENT_IMAGE_FIELDS) {
    const source = input?.images?.[key];
    const defaults = DEFAULT_CONTENT.images[key];
    output.images[key] = {
      src: isContentImageSource(source?.src, allowEmpty) ? source.src : defaults.src,
      alt: typeof source?.alt === 'string' && source.alt.trim().length <= 120 ? source.alt.trim() : defaults.alt,
      fit: ['contain', 'cover'].includes(source?.fit) ? source.fit : defaults.fit,
      position: ['center', 'top', 'bottom'].includes(source?.position) ? source.position : defaults.position,
    };
  }
  return output;
}
