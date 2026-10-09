// Pure data validation and merge logic. No network or browser storage access.
export const FORMAT = 'kotoba-backup';
export const BACKUP_VERSION = 1;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export function uid() { return crypto.randomUUID(); }
export function validName(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}を1〜${max}文字で入力してください。`);
  return value.trim();
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
function timestamp(value) { return Number.isSafeInteger(value) && value > 0; }
function invalid(message) { throw new Error(`バックアップを読み込めません。${message}`); }
export function validateBackup(raw) {
  if (!object(raw) || raw.format !== FORMAT || raw.version !== BACKUP_VERSION) invalid('ことばの対応形式（version 1）ではありません。');
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.templates)) invalid('カテゴリ・定型文の一覧が不正です。');
  const categoryIds = new Set(), names = new Set(), templateIds = new Set();
  const categories = raw.categories.map(c => {
    if (!object(c) || !identifier(c.id) || categoryIds.has(c.id)) invalid('カテゴリIDが不正または重複しています。');
    const name = validName(c.name, 80, 'カテゴリ名');
    if (names.has(name)) invalid('カテゴリ名が重複しています。');
    names.add(name); categoryIds.add(c.id);
    return { id: c.id, name };
  });
  const templates = raw.templates.map(t => {
    if (!object(t) || !identifier(t.id) || templateIds.has(t.id)) invalid('定型文IDが不正または重複しています。');
    const title = validName(t.title, 200, 'タイトル');
    if (typeof t.body !== 'string' || !t.body.trim()) invalid('空の本文、または文字列以外の本文があります。');
    if (typeof t.favorite !== 'boolean') invalid('お気に入りの値が不正です。');
    if (t.categoryId !== null && !categoryIds.has(t.categoryId)) invalid('存在しないカテゴリが指定されています。');
    if (!timestamp(t.createdAt) || !timestamp(t.updatedAt) || t.updatedAt < t.createdAt) invalid('日時が不正です。');
    templateIds.add(t.id);
    const result = { id:t.id, title, body:t.body, categoryId:t.categoryId, favorite:t.favorite, createdAt:t.createdAt, updatedAt:t.updatedAt };
    if (t.clibor !== undefined) {
      if (!object(t.clibor) || typeof t.clibor.note !== 'string' || typeof t.clibor.hotkey !== 'string') invalid('Cliborの元メモ情報が不正です。');
      result.clibor = {note:t.clibor.note,hotkey:t.clibor.hotkey};
      if (t.clibor.source !== undefined) {
        const source=t.clibor.source;
        if (!object(source) || typeof source.title !== 'string' || !source.title.trim() || source.title.length>200 || typeof source.body !== 'string' || !source.body.trim()) invalid('Cliborの更新元情報が不正です。');
        result.clibor.source={title:source.title,body:source.body};
      }
    }
    return result;
  });
  return { format:FORMAT, version:BACKUP_VERSION, categories, templates };
}
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { invalid('JSONの文法が正しくありません。'); }
  return validateBackup(raw);
}
export function makeBackup(snapshot) {
  return { ...validateBackup({ format:FORMAT, version:BACKUP_VERSION, ...snapshot }), exportedAt:new Date().toISOString() };
}
export function mergeBackup(current, incoming, newId = uid) {
  const categories = current.categories.map(c => ({...c}));
  const templates = current.templates.map(t => ({...t}));
  const catIds = new Set(categories.map(c => c.id)), ids = new Set(templates.map(t => t.id));
  const names = new Map(categories.map(c => [c.name,c.id])), categoryMap = new Map();
  const fresh = used => { let id; do { id = newId(); } while (used.has(id)); used.add(id); return id; };
  for (const category of incoming.categories) {
    let id = names.get(category.name);
    if (!id) {
      id = catIds.has(category.id) ? fresh(catIds) : category.id;
      catIds.add(id); categories.push({id,name:category.name}); names.set(category.name,id);
    }
    categoryMap.set(category.id,id);
  }
  // Explicit tuples avoid object-key injection and ignore timestamps when identifying identical content.
  const key = t => JSON.stringify([t.title,t.body,t.categoryId,t.favorite,t.clibor?.note || '',t.clibor?.hotkey || '']);
  const content = new Set(templates.map(key));
  let added = 0, skipped = 0;
  for (const item of incoming.templates) {
    const t = {...item, categoryId:item.categoryId === null ? null : categoryMap.get(item.categoryId)};
    if (content.has(key(t))) { skipped++; continue; }
    if (ids.has(t.id)) t.id = fresh(ids);
    ids.add(t.id); content.add(key(t)); templates.push(t); added++;
  }
  return {categories,templates,added,skipped};
}
