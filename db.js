import { uid, validName, validateBackup, mergeBackup } from './data.js';
import { planCliborRefresh, snapshotSignature } from './clibor.js';

export const DB_NAME = `kotoba-local:${new URL('./',import.meta.url).pathname}`;
export const DB_VERSION = 1;
let database;
const initialCategories = ['社内連絡','メール','営業','その他'];
export function openDatabase(onVersionChange = () => {}) {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      // Add future migrations as independent `if (event.oldVersion < N)` blocks.
      // Never delete/recreate an existing store during a schema upgrade.
      if (event.oldVersion < 1) {
        const entries = db.createObjectStore('templates',{keyPath:'id'});
        entries.createIndex('updatedAt','updatedAt');
        entries.createIndex('categoryId','categoryId');
        const categories = db.createObjectStore('categories',{keyPath:'id'});
        categories.createIndex('name','name',{unique:true});
        initialCategories.forEach((name,i) => categories.put({id:`default-${i+1}`,name}));
        db.createObjectStore('settings',{keyPath:'key'}).put({key:'theme',value:'system'});
      }
    };
    let abandoned = false;
    request.onblocked = () => { abandoned = true; reject(new Error('別の画面が保存領域を使用しています。ことばを開いている画面を閉じてから再読み込みしてください。')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (abandoned) { request.result.close(); return; }
      database = request.result;
      database.onversionchange = () => { database.close(); database = null; onVersionChange(); };
      resolve(database);
    };
  });
}
function transaction(stores, mode, run) {
  return new Promise((resolve,reject) => {
    if (!database) { reject(new Error('保存領域を開けません。アプリを起動し直してください。')); return; }
    let tx, result, issue;
    try {
      tx = database.transaction(stores,mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(issue || tx.error || new Error('保存が中断されました。変更は反映されていません。'));
      tx.onerror = () => {}; // The abort event is the final transaction result.
      const abort = error => { issue = error; tx.abort(); };
      run(tx, value => { result=value; }, abort);
    } catch (error) { if (tx) { issue=error; tx.abort(); } else reject(error); }
  });
}
function getSnapshot(tx, done, abort) {
  const categories = tx.objectStore('categories').getAll();
  const templates = tx.objectStore('templates').getAll();
  let finished = 0;
  const ready = () => { if (++finished === 2) { try { done({categories:categories.result, templates:templates.result}); } catch(error) { abort(error); } } };
  categories.onsuccess = ready; templates.onsuccess = ready;
}
export function readAll() {
  return transaction(['categories','templates'],'readonly',(tx,set,abort) => getSnapshot(tx,set,abort));
}
export function getSetting(key) {
  return transaction(['settings'],'readonly',(tx,set) => { tx.objectStore('settings').get(key).onsuccess = e => set(e.target.result?.value); });
}
export function putSetting(key,value) {
  return transaction(['settings'],'readwrite',tx => tx.objectStore('settings').put({key,value}));
}
export function saveTemplate(input, expectedUpdatedAt = null) {
  const title = validName(input.title,200,'タイトル');
  if (typeof input.body !== 'string' || !input.body.trim()) return Promise.reject(new Error('本文を入力してください。'));
  return transaction(['templates','categories'],'readwrite',(tx,set,abort) => {
    const store = tx.objectStore('templates');
    const id = input.id || uid();
    store.get(id).onsuccess = event => {
      const previous = event.target.result;
      if ((previous?.updatedAt ?? null) !== expectedUpdatedAt) { abort(new Error('別の画面でこの定型文が変更されました。入力内容を控え、開き直してください。')); return; }
      const write = () => {
        try {
        const time = Math.max(Date.now(), (previous?.updatedAt || 0)+1);
        const entry = {id,title,body:input.body,categoryId:input.categoryId || null,favorite:!!input.favorite,createdAt:previous?.createdAt || time,updatedAt:time};
        if(previous?.clibor)entry.clibor={...previous.clibor};
        store.put(entry); set(entry);
        } catch(error) { abort(error); }
      };
      if (!input.categoryId) write();
      else tx.objectStore('categories').get(input.categoryId).onsuccess = e => {
        if (!e.target.result) abort(new Error('選択したカテゴリは削除されています。カテゴリを選び直してください。'));
        else write();
      };
    };
  });
}
export function deleteTemplate(id, expectedUpdatedAt) {
  return transaction(['templates'],'readwrite',(tx,set,abort) => {
    const store = tx.objectStore('templates');
    store.get(id).onsuccess = e => {
      if (!e.target.result || e.target.result.updatedAt !== expectedUpdatedAt) abort(new Error('定型文が別の画面で変更されました。一覧を更新して確認してください。'));
      else store.delete(id);
    };
  });
}
export function saveCategory(id,name) {
  name = validName(name,80,'カテゴリ名');
  return transaction(['categories'],'readwrite',(tx,set,abort) => {
    const store = tx.objectStore('categories');
    store.getAll().onsuccess = e => {
      if (id && !e.target.result.some(c => c.id === id)) { abort(new Error('このカテゴリは既に削除されています。')); return; }
      if (e.target.result.some(c => c.name === name && c.id !== id)) { abort(new Error('同じ名前のカテゴリがあります。')); return; }
      try { store.put({id:id || uid(),name}); } catch(error) { abort(error); }
    };
  });
}
export function deleteCategory(id) {
  return transaction(['categories','templates'],'readwrite',(tx,set,abort) => {
    tx.objectStore('categories').delete(id);
    const store = tx.objectStore('templates');
    store.index('categoryId').openCursor(IDBKeyRange.only(id)).onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { const value=cursor.value; cursor.update({...value,categoryId:null,updatedAt:Math.max(Date.now(),value.updatedAt+1)}); cursor.continue(); }
    };
  });
}
export function restoreBackup(raw,mode) {
  const backup = validateBackup(raw); // All validation completes before any write transaction starts.
  if (!['merge','replace'].includes(mode)) return Promise.reject(new Error('復元方法が不正です。'));
  return transaction(['categories','templates'],'readwrite',(tx,set,abort) => {
    getSnapshot(tx,current => {
      const next = mode === 'merge' ? mergeBackup(current,backup) : {...backup,added:backup.templates.length,skipped:0};
      // Clear and put belong to one transaction: quota failure aborts all changes, including clears.
      tx.objectStore('templates').clear(); tx.objectStore('categories').clear();
      for (const c of next.categories) tx.objectStore('categories').put(c);
      for (const t of next.templates) tx.objectStore('templates').put(t);
      set({added:next.added,skipped:next.skipped});
    },abort);
  });
}

export function refreshClibor(raw,expected,hasGroups) {
  const backup=validateBackup(raw);
  return transaction(['categories','templates'],'readwrite',(tx,set,abort)=>{
    getSnapshot(tx,current=>{
      if(snapshotSignature(current)!==expected)throw new Error('確認中に定型文・カテゴリが変更されました。CSVを選び直して、更新内容を再確認してください。');
      const plan=planCliborRefresh(current,backup,hasGroups);
      // All deletes and writes are atomic; manual entries are never deleted or rewritten.
      const store=tx.objectStore('templates');
      for(const t of current.templates)if(t.clibor)store.delete(t.id);
      for(const c of plan.next.categories)tx.objectStore('categories').put(c);
      for(const t of plan.next.templates)if(t.clibor)store.put(t);
      set({added:plan.added,updated:plan.updated,removed:plan.removed.length});
    },abort);
  });
}
