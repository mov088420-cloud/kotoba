import * as db from './db.js';
import { MAX_IMPORT_BYTES, parseBackup, makeBackup } from './data.js';
import { decodeCliborFile, parseCliborCsv } from './clibor.js';

const $ = id => document.getElementById(id);
let snapshot = {templates:[],categories:[]}, favoritesOnly = false, editing = null, editorInitial = '', editorBodyInitial = '', pendingImport = null;
let registration, channel, toastTimer, refreshSerial = 0, databaseReady = false, confirmResolve;
const icons = {
  star:'M12 3 14.8 8.7 21 9.6 16.5 14 17.6 20.2 12 17.3 6.4 20.2 7.5 14 3 9.6 9.2 8.7Z',
  copy:'M9 8h10v13H9z M15 8V3H4v13h5'
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',icons[name]); svg.append(path); return svg;
}
function element(tag,className,text) { const node=document.createElement(tag); if(className) node.className=className; if(text !== undefined) node.textContent=text; return node; }
function errorText(error) {
  if (error?.name === 'QuotaExceededError') return '端末の保存容量が不足しています。保存できませんでした。入力内容を控え、不要なファイルを整理してください。';
  if (['SecurityError','InvalidStateError','UnknownError'].includes(error?.name)) return '端末内の保存領域を利用できません。Safariの通常モードや会社の管理設定、空き容量を確認してください。';
  return error?.message || '処理に失敗しました。内容を控えてから、もう一度お試しください。';
}
function showError(id,error) { $(id).textContent=errorText(error); $(id).hidden=false; }
function clearError(id) { $(id).textContent=''; $(id).hidden=true; }
function toast(text) {
  clearTimeout(toastTimer);
  const open=[...document.querySelectorAll('dialog[open]')].at(-1);
  (open || document.body).append($('toast'));
  $('toast').textContent=text; $('toast').hidden=false;
  toastTimer=setTimeout(() => { $('toast').hidden=true; document.body.append($('toast')); },2200);
}
function openDialog(id) { const d=$(id); if(!d.open) d.showModal(); }
function closeDialog(id) { if($(id).contains($('toast'))) { $('toast').hidden=true; document.body.append($('toast')); } $(id).close(); }
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => closeDialog(button.dataset.close)));
function confirmation({title,message,action='実行',danger=false,value=null}) {
  $('confirm-heading').textContent=title; $('confirm-message').textContent=message;
  $('confirm-yes').textContent=action; $('confirm-yes').className=danger?'danger-button':'primary';
  $('confirm-input-label').hidden=value === null; $('confirm-input').value=value ?? ''; $('confirm-input').required=value !== null;
  openDialog('confirm-dialog');
  // Put initial focus on the safe action for destructive confirmations.
  if(value !== null) $('confirm-input').focus(); else $('confirm-no').focus();
  return new Promise(resolve => { confirmResolve=resolve; });
}
function finishConfirm(answer) { const resolve=confirmResolve; confirmResolve=null; closeDialog('confirm-dialog'); resolve?.(answer); }
$('confirm-no').addEventListener('click',() => finishConfirm(null));
$('confirm-dialog').addEventListener('cancel',event => {event.preventDefault();finishConfirm(null);});
$('confirm-form').addEventListener('submit',event => {event.preventDefault();finishConfirm($('confirm-input-label').hidden ? true : $('confirm-input').value);});

function fillCategories(select,firstText,firstValue,selected) {
  select.replaceChildren(new Option(firstText,firstValue));
  if(select.id === 'category-filter') select.add(new Option('未分類','__none__'));
  for(const c of [...snapshot.categories].sort((a,b)=>a.name.localeCompare(b.name,'ja'))) select.add(new Option(c.name,select.id==='category-filter'?`category:${c.id}`:c.id));
  select.value=[...select.options].some(o=>o.value===selected)?selected:firstValue;
}
function renderList() {
  const q=$('search').value.toLocaleLowerCase('ja').trim(), category=$('category-filter').value;
  const rows=snapshot.templates.filter(t => (!favoritesOnly || t.favorite) && (!category || (category==='__none__' ? t.categoryId===null : t.categoryId===category.slice(9))) && (!q || t.title.toLocaleLowerCase('ja').includes(q) || t.body.toLocaleLowerCase('ja').includes(q)));
  rows.sort($('sort').value==='title' ? (a,b)=>a.title.localeCompare(b.title,'ja') || b.updatedAt-a.updatedAt : (a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
  $('total-count').textContent=`${snapshot.templates.length}件`;
  $('result-count').textContent=rows.length?`${rows.length}件の定型文`:'';
  const categoryNames=new Map(snapshot.categories.map(c=>[c.id,c.name])), fragment=document.createDocumentFragment();
  for(const t of rows) {
    const card=element('article','card'), top=element('div','card-top');
    top.append(element('h2','card-title',t.title));
    const favorite=element('button','favorite-button'); favorite.append(icon('star')); favorite.setAttribute('aria-pressed',String(t.favorite)); favorite.setAttribute('aria-label',`${t.title}をお気に入り${t.favorite?'から外す':'にする'}`);
    favorite.addEventListener('click',async()=>{ favorite.disabled=true; try { await db.saveTemplate({...t,favorite:!t.favorite},t.updatedAt); await changed(); } catch(error){showError('main-error',error);favorite.disabled=false;} });
    top.append(favorite); card.append(top,element('p','card-preview',t.body.slice(0,500)));
    const bottom=element('div','card-bottom'); bottom.append(element('span','category-badge',categoryNames.get(t.categoryId)||'未分類'));
    const edit=element('button','edit-button','編集');edit.setAttribute('aria-label',`${t.title}を編集`); edit.addEventListener('click',()=>openEditor(t));
    const copy=element('button','copy-button');copy.append(icon('copy'),document.createTextNode('コピー'));copy.setAttribute('aria-label',`${t.title}をコピー`);
    // Body is already in memory. No await/DB lookup precedes this clipboard call.
    copy.addEventListener('click',()=>copyBody(t.body,copy));
    bottom.append(edit,copy);card.append(bottom);fragment.append(card);
  }
  $('cards').replaceChildren(fragment); $('empty-state').hidden=rows.length>0;
  const hasData=snapshot.templates.length>0;
  $('empty-title').textContent=hasData?'該当する定型文がありません':'いつもの言葉を、すぐに。';
  $('empty-description').textContent=hasData?'検索ワードや絞り込みを変えてみてください。':'よく使う文章を登録して、ワンタップでコピーできます。';
  $('empty-add').hidden=hasData || !databaseReady;
}
function manualCopy(body) { $('manual-copy').value=body; openDialog('copy-dialog'); }
function copyBody(body,button) {
  if(!navigator.clipboard?.writeText) { manualCopy(body); return; }
  try {
    const result=navigator.clipboard.writeText(body);
    button.disabled=true;
    result.then(()=>toast('コピーしました'),()=>manualCopy(body)).finally(()=>{button.disabled=false;});
  } catch { manualCopy(body); }
}
$('select-copy').addEventListener('click',()=>{ const text=$('manual-copy');text.focus();text.select();text.setSelectionRange(0,text.value.length); });
async function refresh() {
  const serial=++refreshSerial, next=await db.readAll();
  if(serial!==refreshSerial)return;
  snapshot=next; fillCategories($('category-filter'),'すべてのカテゴリ','',$('category-filter').value); renderList(); renderCategories();
}
async function changed() { clearError('main-error');await refresh();channel?.postMessage('changed'); }
$('search').addEventListener('input',renderList);$('category-filter').addEventListener('change',renderList);$('sort').addEventListener('change',renderList);
function setFavorites(value){favoritesOnly=value;$('filter-all').setAttribute('aria-pressed',String(!value));$('filter-favorites').setAttribute('aria-pressed',String(value));renderList();}
$('filter-all').addEventListener('click',()=>setFavorites(false));$('filter-favorites').addEventListener('click',()=>setFavorites(true));

function editorValue() { return JSON.stringify([$('edit-title').value,$('edit-body').value,$('edit-category').value,$('edit-favorite').checked]); }
function openEditor(entry=null) {
  if(!databaseReady)return;
  editing=entry?{...entry}:null;clearError('editor-error');
  $('editor-heading').textContent=entry?'定型文を編集':'新規登録';$('edit-title').value=entry?.title||'';$('edit-body').value=entry?.body||'';$('edit-favorite').checked=entry?.favorite||false;
  editorBodyInitial=$('edit-body').value;
  fillCategories($('edit-category'),'未分類','',entry?.categoryId||'');$('delete-template').hidden=!entry;editorInitial=editorValue();openDialog('editor-dialog');
  $('clibor-original').hidden=!entry?.clibor;
  $('clibor-note').textContent=entry?.clibor?.note||'（メモなし）';
  $('clibor-hotkey').textContent=entry?.clibor?.hotkey||'（設定なし）';
}
async function cancelEditor() {
  if($('save-template').disabled)return;
  if(editorValue()!==editorInitial && !await confirmation({title:'変更を破棄しますか？',message:'まだ保存していない入力内容は失われます。',action:'破棄する',danger:true}))return;
  closeDialog('editor-dialog');
}
$('new-template').addEventListener('click',()=>openEditor());$('empty-add').addEventListener('click',()=>openEditor());$('editor-cancel').addEventListener('click',cancelEditor);
$('editor-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelEditor();});
$('editor-form').addEventListener('submit',async event=>{
  event.preventDefault(); if($('save-template').disabled)return;clearError('editor-error');$('save-template').disabled=true;
  try {
    // textarea normalizes CRLF to LF. Preserve the imported bytes when only metadata changes.
    const body=editing&&$('edit-body').value===editorBodyInitial?editing.body:$('edit-body').value;
    await db.saveTemplate({id:editing?.id,title:$('edit-title').value,body,categoryId:$('edit-category').value||null,favorite:$('edit-favorite').checked},editing?.updatedAt??null);
    closeDialog('editor-dialog');await changed();toast('保存しました');
  }catch(error){showError($('editor-dialog').open?'editor-error':'main-error',error);}finally{$('save-template').disabled=false;}
});
$('delete-template').addEventListener('click',async()=>{
  if(!editing || !await confirmation({title:'定型文を削除しますか？',message:`「${editing.title}」を削除します。この操作は取り消せません。`,action:'削除する',danger:true}))return;
  try{await db.deleteTemplate(editing.id,editing.updatedAt);closeDialog('editor-dialog');await changed();toast('削除しました');}catch(error){showError('editor-error',error);}
});
function renderCategories(){
  const fragment=document.createDocumentFragment();
  for(const category of [...snapshot.categories].sort((a,b)=>a.name.localeCompare(b.name,'ja'))){
    const row=element('div','category-row');row.append(element('span','',category.name));
    const edit=element('button','text-button','編集');edit.setAttribute('aria-label',`${category.name}を編集`);
    edit.addEventListener('click',async()=>{
      const name=await confirmation({title:'カテゴリ名を編集',message:'定型文の分類はそのまま引き継がれます。',action:'保存',value:category.name});
      if(name===null)return;
      try{await db.saveCategory(category.id,name);clearError('category-error');await changed();}catch(error){showError('category-error',error);}
    });
    const remove=element('button','danger-button','削除');remove.setAttribute('aria-label',`${category.name}を削除`);
    remove.addEventListener('click',async()=>{
      if(!await confirmation({title:'カテゴリを削除しますか？',message:`「${category.name}」の定型文は削除せず、「未分類」に移します。`,action:'削除する',danger:true}))return;
      try{await db.deleteCategory(category.id);clearError('category-error');await changed();}catch(error){showError('category-error',error);}
    });row.append(edit,remove);fragment.append(row);
  }
  if(!snapshot.categories.length)fragment.append(element('p','muted','カテゴリはまだありません。'));
  $('category-list').replaceChildren(fragment);
}
$('categories-open').addEventListener('click',()=>{clearError('category-error');openDialog('categories-dialog');});
$('category-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await db.saveCategory(null,$('category-name').value);$('category-name').value='';clearError('category-error');await changed();}catch(error){showError('category-error',error);}finally{button.disabled=false;}});

function applyTheme(value){document.documentElement.dataset.theme=value;$('theme').value=value;const dark=value==='dark'||(value==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.querySelector('meta[name=theme-color]').content=dark?'#101318':'#f6f7fa';}
$('theme').addEventListener('change',async()=>{const previous=document.documentElement.dataset.theme;try{await db.putSetting('theme',$('theme').value);applyTheme($('theme').value);}catch(error){$('theme').value=previous;showError('settings-error',error);}});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>applyTheme($('theme').value));
$('settings-open').addEventListener('click',()=>{clearError('settings-error');openDialog('settings-dialog');updateStorageStatus();checkCache();});
async function updateStorageStatus(){
  try{
    const persistent=await navigator.storage?.persisted?.();
    const estimate=await navigator.storage?.estimate?.();
    const usage=estimate?.usage!=null?` 使用量の目安：${(estimate.usage/1048576).toFixed(1)} MB。`:'';
    $('storage-status').textContent=(persistent?'保存領域の保持：許可済み。永久保存の保証はありません。':'保存領域の保持：通常の保存。OSの判断で削除される場合があります。')+usage;
    $('request-persist').disabled=!navigator.storage?.persist;
    if(!navigator.storage?.persist)$('request-persist').textContent='この環境では保持要求に未対応';
  }catch{$('storage-status').textContent='保存領域の状態を取得できませんでした。';}
}
$('request-persist').addEventListener('click',async()=>{try{const granted=await navigator.storage.persist();await updateStorageStatus();toast(granted?'保持要求が許可されました':'保持要求は許可されませんでした');}catch(error){showError('settings-error',error);}});
$('export-data').addEventListener('click',async()=>{
  if(!await confirmation({title:'バックアップを書き出す',message:'本文を含むJSONファイルを保存します。Safariのダウンロード先が、会社で許可された「このiPhone内」になっていることを確認してください。iCloud Driveなどには保存しないでください。',action:'書き出す'}))return;
  const button=$('export-data');button.disabled=true;clearError('settings-error');
  try{
    const backup=makeBackup(await db.readAll());
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    const d=new Date(),stamp=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
    a.href=url;a.download=`kotoba-backup-${stamp}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);toast('ファイルの保存先を確認してください');
  }catch(error){showError('settings-error',error);}finally{button.disabled=false;}
});
async function selectImport(event,isClibor=false){
  const file=event.target.files[0];event.target.value='';if(!file)return;clearError('settings-error');
  try{
    if(file.size>MAX_IMPORT_BYTES && !await confirmation({title:'大きなファイルを読み込みますか？',message:'20 MBを超えるファイルです。読み込みに時間がかかり、端末のメモリ不足で中断する場合があります。読み込みと検証だけでは既存データは変わりません。',action:'読み込む'}))return;
    let detail='';
    if(isClibor){
      const decoded=decodeCliborFile(await file.arrayBuffer()),result=parseCliborCsv(decoded.text);pendingImport=result.backup;
      detail=`${result.groupColumnPresent?'グループをカテゴリにします。':'グループ列がないため、カテゴリは「未分類」にします。'}メモをタイトルにします。メモが空・複数行・長い場合はタイトルを整えます（${result.generatedTitles}件）。元メモは編集画面に残し、本文は変更しません。ホットキーとマクロは動作しません。文字コード：${decoded.encoding}。`;
    }else pendingImport=parseBackup(await file.text());
    $('import-heading').textContent=isClibor?'Cliborの定型文を取り込む':'バックアップを復元';
    $('confirm-import').textContent=isClibor?'取り込む':'復元する';
    $('import-summary').textContent=`定型文 ${pendingImport.templates.length}件・カテゴリ ${pendingImport.categories.length}件を読み込みました。${detail}取り込み方法を選んでください。`;
    document.querySelector('input[name=import-mode][value=merge]').checked=true;clearError('import-error');openDialog('import-dialog');
  }catch(error){pendingImport=null;showError('settings-error',error);}
}
$('import-file').addEventListener('change',event=>selectImport(event));
$('clibor-file').addEventListener('change',event=>selectImport(event,true));
function cancelImport(){if($('confirm-import').disabled)return;pendingImport=null;closeDialog('import-dialog');}
$('import-cancel').addEventListener('click',cancelImport);$('import-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelImport();});
$('confirm-import').addEventListener('click',async()=>{
  if(!pendingImport||$('confirm-import').disabled)return;
  const mode=document.querySelector('input[name=import-mode]:checked').value;
  if(mode==='replace'&&!await confirmation({title:'現在のデータを置き換えますか？',message:`現在のすべての定型文・カテゴリを削除し、ファイル内の定型文 ${pendingImport.templates.length}件に置き換えます。必要なら先にバックアップしてください。この操作は取り消せません。`,action:'置き換える',danger:true}))return;
  $('confirm-import').disabled=true;
  try{const result=await db.restoreBackup(pendingImport,mode);pendingImport=null;closeDialog('import-dialog');await changed();toast(mode==='merge'?`${result.added}件を追加・${result.skipped}件は重複を省略`:'復元しました');}catch(error){showError('import-error',error);}finally{$('confirm-import').disabled=false;}
});

function setOfflineStatus(ready,message){$('offline-status').dataset.ready=String(ready);$('offline-label').textContent=message;$('settings-offline').textContent=message;}
async function checkCache(){
  const worker=navigator.serviceWorker?.controller || registration?.active;
  if(!worker)return false;
  try{
    const ready=await new Promise((resolve,reject)=>{
      const port=new MessageChannel();const timer=setTimeout(()=>{port.port1.close();reject(new Error('timeout'));},8000);
      port.port1.onmessage=e=>{clearTimeout(timer);port.port1.close();resolve(e.data?.ready===true);};
      worker.postMessage({type:'CACHE_STATUS'},[port.port2]);
    });
    setOfflineStatus(ready,ready?'オフライン利用の準備完了':'オフライン準備が未完了です。接続して起動し直してください。');return ready;
  }catch{setOfflineStatus(false,'オフライン準備を確認できません。接続して起動し直してください。');return false;}
}
async function repairCache(){
  const worker=navigator.serviceWorker?.controller || registration?.active;
  if(!worker)return;
  await new Promise((resolve,reject)=>{
    const port=new MessageChannel(),timer=setTimeout(()=>{port.port1.close();reject(new Error('準備の確認がタイムアウトしました。接続を確認してください。'));},30000);
    port.port1.onmessage=e=>{clearTimeout(timer);port.port1.close();e.data?.ready?resolve():reject(new Error('必要なファイルを取得できませんでした。接続を確認してください。更新版がある場合は、すべての画面を閉じて再起動してください。'));};
    worker.postMessage({type:'REPAIR_CACHE'},[port.port2]);
  });
}
async function setupOffline(){
  if(!isSecureContext || !('serviceWorker' in navigator)){setOfflineStatus(false,'オフラインにはHTTPSと対応するSafariが必要です。');return;}
  try{
    registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
    const waiting=()=>{$('update-notice').hidden=!(registration.waiting && navigator.serviceWorker.controller);};waiting();
    registration.addEventListener('updatefound',()=>{
      const installing=registration.installing;
      installing?.addEventListener('statechange',()=>{
        if(installing.state==='installed')waiting();
        if(installing.state==='activated'){waiting();checkCache();}
        if(installing.state==='redundant'&&!registration.active)setOfflineStatus(false,'準備に失敗しました。接続を確認し、設定から再試行してください。');
      });
    });
    if(registration.active)await checkCache();
    // First activation: no forced skipWaiting during updates; existing clients keep their version.
    navigator.serviceWorker.ready.then(()=>checkCache());
  }catch{setOfflineStatus(false,'オフライン準備が未完了です。接続を確認し、設定から再試行してください。');}
}
navigator.serviceWorker?.addEventListener('controllerchange',()=>checkCache());
$('check-update').addEventListener('click',async()=>{
  const button=$('check-update');button.disabled=true;clearError('settings-error');
  try{await setupOffline();if(registration){await registration.update();if(!await checkCache()){await repairCache();await checkCache();}toast(registration.waiting?'更新版があります。画面を閉じて再起動してください':'確認しました。準備状態をご確認ください');}}catch(error){showError('settings-error',new Error(`${errorText(error)} 現在の保存データは変更していません。`));}finally{button.disabled=false;}
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&databaseReady){refresh().catch(error=>showError('main-error',error));checkCache();}});
async function start(){
  $('new-template').disabled=true;$('categories-open').disabled=true;
  try{
    await db.openDatabase(()=>{databaseReady=false;$('new-template').disabled=true;showError('main-error',new Error('アプリが更新されました。保存していない文章を控え、この画面を再読み込みしてください。'));});
    databaseReady=true;applyTheme((await db.getSetting('theme'))||'system');await refresh();$('new-template').disabled=false;$('categories-open').disabled=false;
    if('BroadcastChannel' in window){channel=new BroadcastChannel(`kotoba-local-changes:${new URL('./',import.meta.url).pathname}`);channel.onmessage=()=>refresh().catch(error=>showError('main-error',error));}
  }catch(error){showError('main-error',error);$('empty-title').textContent='保存領域を開けませんでした';$('empty-description').textContent='Safariの通常モード、端末の空き容量、会社の設定をご確認ください。';$('empty-state').hidden=false;$('empty-add').hidden=true;}
  await setupOffline();
}
start();
