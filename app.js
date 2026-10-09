import * as db from './db.js';
import { MAX_IMPORT_BYTES, parseBackup, makeBackup } from './data.js';
import { decodeCliborFile, parseCliborCsv, planCliborRefresh } from './clibor.js';

const $ = id => document.getElementById(id);
let snapshot = {templates:[],categories:[]}, favoritesOnly = false, editing = null, editorInitial = '', editorBodyInitial = '', pendingImport = null;
let registration, channel, toastTimer, refreshSerial = 0, databaseReady = false, confirmResolve;
let previewing = null, cancelCurrentPress = null, cancelReleaseGuard = null;
let pendingCliborPlan=null, pendingCliborGroups=false;
let currentSort='registered';
const selectedIds=new Set();
let bulkBusy=false,pendingBulkTargets=[];
const icons = {
  star:'M12 3 14.8 8.7 21 9.6 16.5 14 17.6 20.2 12 17.3 6.4 20.2 7.5 14 3 9.6 9.2 8.7Z',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',
  check:'M5 12l4 4L19 6'
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
function openPreview(entry) {
  previewing=entry;
  $('preview-heading').textContent=entry.title;
  $('preview-category').textContent=snapshot.categories.find(c=>c.id===entry.categoryId)?.name || '未分類';
  $('preview-body').textContent=entry.body;
  $('preview-body').scrollTop=0;
  $('preview-edit').setAttribute('aria-label',`${entry.title}を編集`);
  openDialog('preview-dialog');
}
$('preview-dialog').addEventListener('close',()=>{previewing=null;});
$('preview-edit').addEventListener('click',()=>{
  const entry=previewing;
  closeDialog('preview-dialog');
  if(entry)openEditor(snapshot.templates.find(t=>t.id===entry.id) || entry);
});
function guardLongPressRelease(pointerId) {
  cancelReleaseGuard?.();
  const controller=new AbortController(),options={capture:true,signal:controller.signal};
  let timer=setTimeout(cleanup,15000);
  function cleanup(){clearTimeout(timer);controller.abort();if(cancelReleaseGuard===cleanup)cancelReleaseGuard=null;}
  cancelReleaseGuard=cleanup;
  document.addEventListener('click',event=>{
    if(event.detail===0)return; // Keyboard activation remains available.
    event.preventDefault();event.stopImmediatePropagation();cleanup();
  },options);
  document.addEventListener('pointerdown',cleanup,options); // A new tap is a new intent.
  const released=event=>{if(event.pointerId===pointerId){clearTimeout(timer);timer=setTimeout(cleanup,700);}};
  document.addEventListener('pointerup',released,options);
  document.addEventListener('pointercancel',released,options);
}
function attachTemplateGesture(button,entry) {
  let blockClick=false;
  button.addEventListener('pointerdown',event=>{
    cancelCurrentPress?.();
    if(!event.isPrimary || event.button!==0)return;
    blockClick=false;
    const controller=new AbortController(),options={capture:true,signal:controller.signal};
    const {pointerId,clientX,clientY}=event;
    let timer=setTimeout(()=>{
      blockClick=true;
      finish();
      guardLongPressRelease(pointerId);
      openPreview(entry);
    },500);
    button.classList.add('pressing');
    function finish(){clearTimeout(timer);controller.abort();button.classList.remove('pressing');if(cancelCurrentPress===cancel)cancelCurrentPress=null;}
    function cancel(){blockClick=true;finish();}
    cancelCurrentPress=cancel;
    document.addEventListener('pointermove',move=>{
      if(move.pointerId===pointerId && Math.hypot(move.clientX-clientX,move.clientY-clientY)>12)cancel();
    },options);
    document.addEventListener('pointerup',up=>{if(up.pointerId===pointerId)finish();},options);
    document.addEventListener('pointercancel',cancel,options);
    document.addEventListener('pointerdown',down=>{if(down.pointerId!==pointerId)cancel();},options);
    document.addEventListener('scroll',cancel,options);
    window.addEventListener('blur',cancel,{signal:controller.signal});
  });
  button.addEventListener('click',event=>{
    if(blockClick && event.detail!==0){event.preventDefault();return;}
    // Copy stays directly inside the trusted click; no timer or DB read precedes it.
    copyBody(entry.body,button);
  });
  button.addEventListener('contextmenu',event=>{
    event.preventDefault();blockClick=true;cancelCurrentPress?.();
    if(!$('preview-dialog').open)openPreview(entry);
  });
  button.addEventListener('keydown',event=>{
    if((event.key==='Enter'&&event.shiftKey) || event.key==='ContextMenu' || (event.key==='F10'&&event.shiftKey)){
      event.preventDefault();cancelCurrentPress?.();openPreview(entry);
    }
  });
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelCurrentPress?.();cancelReleaseGuard?.();}});
function selectedEntries(){return snapshot.templates.filter(t=>selectedIds.has(t.id));}
function updateSelectionUI(){
  const entries=selectedEntries(),count=entries.length,allFavorite=count>0&&entries.every(t=>t.favorite);
  $('new-template').hidden=count>0;$('bulk-actions').hidden=!count;
  $('selected-count').textContent=`${count}件`;$('selected-count').setAttribute('aria-label',`${count}件選択中`);
  $('bulk-favorite-label').textContent=allFavorite?'解除':'お気に入り';
  $('bulk-favorite').setAttribute('aria-label',`選択した${count}件をお気に入り${allFavorite?'から外す':'にする'}`);
  $('bulk-favorite').classList.toggle('is-favorite',allFavorite);
  for(const id of ['bulk-favorite','bulk-category','clear-selection'])$(id).disabled=bulkBusy||!databaseReady;
  for(const button of document.querySelectorAll('.select-button')){
    const selected=selectedIds.has(button.dataset.selectId);
    button.setAttribute('aria-checked',String(selected));button.disabled=bulkBusy||!databaseReady;
    button.closest('.card').classList.toggle('selected',selected);
  }
}
function clearSelection(){selectedIds.clear();updateSelectionUI();}
$('clear-selection').addEventListener('click',clearSelection);
async function applyBulk(targets,patch,errorId){
  if(bulkBusy||!databaseReady||!targets.length)return false;
  bulkBusy=true;updateSelectionUI();clearError(errorId);$('bulk-save').disabled=true;$('bulk-cancel').disabled=true;
  try{
    await db.updateTemplates(targets,patch);await changed();
    if(errorId==='main-error')toast(`${targets.length}件のお気に入りを設定しました`);return true;
  }catch(error){showError(errorId,error);return false;}
  finally{bulkBusy=false;updateSelectionUI();$('bulk-save').disabled=$('bulk-category-select').selectedIndex===0;$('bulk-cancel').disabled=false;}
}
$('bulk-favorite').addEventListener('click',()=>{
  const entries=selectedEntries();
  applyBulk(entries.map(t=>({id:t.id,updatedAt:t.updatedAt})),{favorite:!entries.every(t=>t.favorite)},'main-error');
});
$('bulk-category').addEventListener('click',()=>{
  if(bulkBusy||!databaseReady)return;
  pendingBulkTargets=selectedEntries().map(t=>({id:t.id,updatedAt:t.updatedAt}));
  if(!pendingBulkTargets.length)return;
  clearError('bulk-error');$('bulk-summary').textContent=`選択した${pendingBulkTargets.length}件のカテゴリを設定します。`;
  const select=$('bulk-category-select'),placeholder=new Option('カテゴリを選択','');placeholder.disabled=true;
  select.replaceChildren(placeholder,new Option('未分類','none'));
  for(const c of [...snapshot.categories].sort((a,b)=>a.name.localeCompare(b.name,'ja')))select.add(new Option(c.name,`category:${c.id}`));
  select.selectedIndex=0;$('bulk-save').disabled=true;openDialog('bulk-category-dialog');
});
$('bulk-category-select').addEventListener('change',()=>{$('bulk-save').disabled=bulkBusy||$('bulk-category-select').selectedIndex===0;});
$('bulk-category-form').addEventListener('submit',async event=>{
  event.preventDefault();const select=$('bulk-category-select');if(select.selectedIndex===0||bulkBusy)return;
  const value=select.value;
  if(await applyBulk(pendingBulkTargets,{categoryId:value==='none'?null:value.slice(9)},'bulk-error')){closeDialog('bulk-category-dialog');toast(`${pendingBulkTargets.length}件のカテゴリを設定しました`);}
});
$('bulk-category-dialog').addEventListener('cancel',event=>{if(bulkBusy)event.preventDefault();});
function renderList() {
  cancelCurrentPress?.();
  const q=$('search').value.toLocaleLowerCase('ja').trim(), category=$('category-filter').value;
  const rows=snapshot.templates.filter(t => (!favoritesOnly || t.favorite) && (!category || (category==='__none__' ? t.categoryId===null : t.categoryId===category.slice(9))) && (!q || t.title.toLocaleLowerCase('ja').includes(q) || t.body.toLocaleLowerCase('ja').includes(q)));
  if($('sort').value==='title')rows.sort((a,b)=>a.title.localeCompare(b.title,'ja') || b.updatedAt-a.updatedAt);
  else if($('sort').value==='updated')rows.sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
  const visibleIds=new Set(rows.map(t=>t.id));
  for(const id of selectedIds)if(!visibleIds.has(id))selectedIds.delete(id);
  $('total-count').textContent=`${snapshot.templates.length}件`;
  $('result-count').textContent=rows.length?`${rows.length}件の定型文`:'';
  const fragment=document.createDocumentFragment();
  for(const t of rows) {
    const card=element('article','card'), content=element('button','template-tap');
    content.type='button';content.setAttribute('aria-label',`${t.title}をコピー`);
    content.setAttribute('aria-describedby','list-help');
    content.append(element('span','card-title',t.title),element('span','card-preview',t.body.replace(/[\r\n]+/g,' ').slice(0,500)));
    attachTemplateGesture(content,t);
    const favorite=element('button','favorite-button'); favorite.append(icon('star')); favorite.setAttribute('aria-pressed',String(t.favorite)); favorite.setAttribute('aria-label',`${t.title}をお気に入り${t.favorite?'から外す':'にする'}`);
    favorite.addEventListener('click',async()=>{ favorite.disabled=true; try { await db.saveTemplate({...t,favorite:!t.favorite},t.updatedAt); await changed(); } catch(error){showError('main-error',error);favorite.disabled=false;} });
    const details=element('button','details-button');details.append(icon('more'));
    details.setAttribute('aria-label',`${t.title}の全文を見る`);details.setAttribute('aria-haspopup','dialog');
    details.addEventListener('click',()=>openPreview(t));
    const select=element('button','select-button');select.type='button';select.setAttribute('role','checkbox');select.dataset.selectId=t.id;
    select.setAttribute('aria-label',`${t.title}を選択`);select.setAttribute('aria-describedby','selection-help');
    const mark=element('span','selection-mark');mark.setAttribute('aria-hidden','true');mark.append(icon('check'));select.append(mark);
    select.addEventListener('click',()=>{if(bulkBusy)return;selectedIds.has(t.id)?selectedIds.delete(t.id):selectedIds.add(t.id);updateSelectionUI();});
    card.append(select,content,favorite,details);fragment.append(card);
  }
  $('cards').replaceChildren(fragment); $('empty-state').hidden=rows.length>0;
  const hasData=snapshot.templates.length>0;
  $('empty-title').textContent=hasData?'該当する定型文がありません':'いつもの言葉を、すぐに。';
  $('empty-description').textContent=hasData?'検索ワードや絞り込みを変えてみてください。':'よく使う文章を登録して、ワンタップでコピーできます。';
  $('empty-add').hidden=hasData || !databaseReady;updateSelectionUI();
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
  const serial=++refreshSerial, [next,sort]=await Promise.all([db.readAll(),db.getSetting('listSort')]);
  if(serial!==refreshSerial)return;
  currentSort=['registered','updated','title'].includes(sort)?sort:'registered';$('sort').value=currentSort;
  snapshot=next; fillCategories($('category-filter'),'すべてのカテゴリ','',$('category-filter').value); renderList(); renderCategories();
}
async function changed() { clearError('main-error');await refresh();channel?.postMessage('changed'); }
$('search').addEventListener('input',renderList);$('category-filter').addEventListener('change',renderList);
$('sort').addEventListener('change',async()=>{
  const selected=$('sort').value,previous=currentSort;$('sort').disabled=true;
  try{await db.putSetting('listSort',selected);currentSort=selected;renderList();channel?.postMessage('changed');}
  catch(error){$('sort').value=previous;renderList();showError('main-error',error);}
  finally{$('sort').disabled=false;}
});
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
    let detail='';pendingCliborPlan=null;
    if(isClibor){
      const decoded=decodeCliborFile(await file.arrayBuffer()),result=parseCliborCsv(decoded.text);pendingImport=result.backup;
      pendingCliborGroups=result.groupColumnPresent;
      pendingCliborPlan=planCliborRefresh(await db.readAll(),pendingImport,pendingCliborGroups);
      detail=`${result.groupColumnPresent?'グループをカテゴリにします。':'グループ列がないため、新規分は「未分類」にします。更新で対応できた前回分はカテゴリを引き継ぎます。'}メモをタイトルにします。メモが空・複数行・長い場合はタイトルを整えます（${result.generatedTitles}件）。元メモは編集画面に残し、本文は変更しません。ホットキーとマクロは動作しません。文字コード：${decoded.encoding}。`;
    }else pendingImport=parseBackup(await file.text());
    $('import-heading').textContent=isClibor?'Cliborの定型文を取り込む':'バックアップを復元';
    $('confirm-import').textContent=isClibor?'取り込む':'復元する';
    $('import-summary').textContent=`定型文 ${pendingImport.templates.length}件・カテゴリ ${pendingImport.categories.length}件を読み込みました。${detail}取り込み方法を選んでください。`;
    $('clibor-refresh-option').hidden=!isClibor;
    $('json-order-option').hidden=isClibor;
    document.querySelector(`input[name=import-mode][value=${pendingCliborPlan?.previous?'clibor-refresh':'merge'}]`).checked=true;
    renderImportMode();clearError('import-error');openDialog('import-dialog');
  }catch(error){pendingImport=null;pendingCliborPlan=null;showError('settings-error',error);}
}
function renderImportMode(){
  const mode=document.querySelector('input[name=import-mode]:checked').value,refresh=mode==='clibor-refresh';
  $('confirm-import').textContent=mode==='order-only'?'順番を合わせる':pendingCliborPlan?'取り込む':'復元する';
  $('clibor-review').hidden=!refresh;
  if(!refresh || !pendingCliborPlan)return;
  const p=pendingCliborPlan;
  $('clibor-review-summary').textContent=`更新 ${p.updated}件・追加／再作成 ${p.added}件・変更なし ${p.unchanged}件・前回分の削除 ${p.removed.length}件。iPhoneで直接作った ${p.manual}件は残します。${p.duplicates?`CSV内の完全に同じ ${p.duplicates}件は重複を省きます。`:''}`;
  $('clibor-review-warning').textContent=`必ずCliborの全定型文を含む最新CSVを選んでください。CSVにない前回分は削除されます。Clibor由来のタイトル・本文はPC側の内容に揃えるため、iPhoneでの編集は上書きされます。${p.localChanges?`iPhoneでの編集を検出した ${p.localChanges}件も対象です。`:''}${p.legacy?`以前の形式で取り込んだ ${p.legacy}件は、iPhoneでの編集の有無を判別できません。`:''}固定IDがないため、対応を特定できない項目は削除・再作成され、お気に入りやカテゴリが引き継がれない場合があります。`;
  const list=$('clibor-review-list');list.replaceChildren();
  for(const row of p.rows){const li=element('li','',`${row.status}：${row.title}${row.localEdited?'（iPhoneでの編集を上書き）':''}`);if(row.oldTitle&&row.oldTitle!==row.title)li.append(element('small','muted',`以前：${row.oldTitle}`));list.append(li);}
  for(const row of p.removed)list.append(element('li','refresh-removed',`前回分を削除：${row.title}`));
}
document.querySelectorAll('input[name=import-mode]').forEach(input=>input.addEventListener('change',renderImportMode));
$('import-file').addEventListener('change',event=>selectImport(event));
$('clibor-file').addEventListener('change',event=>selectImport(event,true));
function cancelImport(){if($('confirm-import').disabled)return;pendingImport=null;pendingCliborPlan=null;closeDialog('import-dialog');}
$('import-cancel').addEventListener('click',cancelImport);$('import-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelImport();});
$('confirm-import').addEventListener('click',async()=>{
  if(!pendingImport||$('confirm-import').disabled)return;
  const mode=document.querySelector('input[name=import-mode]:checked').value;
  $('confirm-import').disabled=true;
  try{
    if(mode==='replace'&&!await confirmation({title:'現在のデータを置き換えますか？',message:`現在のすべての定型文・カテゴリを削除し、ファイル内の定型文 ${pendingImport.templates.length}件に置き換えます。必要なら先にバックアップしてください。この操作は取り消せません。`,action:'置き換える',danger:true}))return;
    if(mode==='clibor-refresh'){
      if(!pendingCliborPlan)throw new Error('CliborのCSVを選び直してください。');
      if(!await confirmation({title:'Clibor分を最新CSVに更新しますか？',message:`前回のClibor分 ${pendingCliborPlan.previous}件を、CSVの ${pendingCliborPlan.next.templates.length-pendingCliborPlan.manual}件に揃えます。前回分のうち ${pendingCliborPlan.removed.length}件を削除します。Clibor由来のiPhoneでの編集は上書きされます。iPhoneで直接作った ${pendingCliborPlan.manual}件は残ります。必要なら先にJSONを書き出してください。この操作は取り消せません。`,action:'Clibor分を更新',danger:true}))return;
    }
    const result=mode==='clibor-refresh'?await db.refreshClibor(pendingImport,pendingCliborPlan.expected,pendingCliborGroups):await db.restoreBackup(pendingImport,mode);
    pendingImport=null;pendingCliborPlan=null;closeDialog('import-dialog');await changed();toast(mode==='order-only'?`${result.ordered}件の順番を合わせました${result.ignored?`・${result.ignored}件は未登録`:''}`:mode==='merge'?`${result.added}件を追加・${result.skipped}件は重複を省略`:mode==='clibor-refresh'?'Clibor分を更新しました':'復元しました');
  }catch(error){showError('import-error',error);}finally{$('confirm-import').disabled=false;}
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
    await db.openDatabase(()=>{databaseReady=false;$('new-template').disabled=true;updateSelectionUI();showError('main-error',new Error('アプリが更新されました。保存していない文章を控え、この画面を再読み込みしてください。'));});
    databaseReady=true;applyTheme((await db.getSetting('theme'))||'system');await refresh();$('new-template').disabled=false;$('categories-open').disabled=false;
    if('BroadcastChannel' in window){channel=new BroadcastChannel(`kotoba-local-changes:${new URL('./',import.meta.url).pathname}`);channel.onmessage=()=>refresh().catch(error=>showError('main-error',error));}
  }catch(error){showError('main-error',error);$('empty-title').textContent='保存領域を開けませんでした';$('empty-description').textContent='Safariの通常モード、端末の空き容量、会社の設定をご確認ください。';$('empty-state').hidden=false;$('empty-add').hidden=true;}
  await setupOffline();
}
start();
