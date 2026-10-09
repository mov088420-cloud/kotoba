// Clibor's documented CSV format. Selected files are parsed locally; no network access.
import { FORMAT, BACKUP_VERSION, uid, validateBackup } from './data.js';

function fail(message) { throw new Error(`CliborのCSVを読み込めません。${message}`); }
export function decodeCliborFile(bytes) {
  try { return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),encoding:'UTF-8'}; }
  catch {
    try { return {text:new TextDecoder('shift_jis',{fatal:true}).decode(bytes),encoding:'Shift_JIS'}; }
    catch { fail('UTF-8またはShift_JISで保存したCSVを選んでください。'); }
  }
}
export function csvRows(input) {
  if(typeof input !== 'string') fail('ファイルの内容が不正です。');
  const text=input.replace(/^\uFEFF/,''),rows=[];
  let row=[],field='',quoted=false,closed=false,start=true;
  const endField=()=>{row.push(field);field='';closed=false;start=true;};
  const endRow=()=>{endField();if(!(row.length===1&&row[0]===''))rows.push(row);row=[];};
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(quoted) {
      if(ch==='"') { if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;} }
      else field+=ch;
      continue;
    }
    if(ch===','){endField();continue;}
    if(ch==='\r'||ch==='\n'){if(ch==='\r'&&text[i+1]==='\n')i++;endRow();continue;}
    if(closed)fail('引用符の後に余分な文字があります。元のCSVを再度書き出してください。');
    if(ch==='"'){if(!start)fail('引用符の位置が不正です。');quoted=true;start=false;continue;}
    field+=ch;start=false;
  }
  if(quoted)fail('閉じられていない引用符があります。');
  if(row.length||field!==''||!start||closed)endRow();
  return rows;
}
function titleFor(note,body) {
  const first=value=>value.split(/\r\n|\r|\n/).find(line=>line.trim())?.trim()||'';
  const raw=first(note)||first(body)||'Cliborの定型文';
  let title='';for(const ch of raw){if(title.length+ch.length>200)break;title+=ch;}
  return title;
}
export function parseCliborCsv(text,newId=uid,now=Date.now()) {
  const rows=csvRows(text);
  if(!rows.length)fail('ファイルが空です。');
  const header=rows.shift().map(s=>s.trim());
  const formats=[['定型文グループ','定型文','メモ','ホットキー'],['Template Text Group','Template Text','Notes','Hotkeys'],['定型文','メモ','ホットキー'],['Template Text','Notes','Hotkeys']];
  const format=formats.find(names=>header.length===names.length&&new Set(header).size===names.length&&names.every(name=>header.includes(name)));
  if(!format)fail('先頭行が「定型文,メモ,ホットキー」またはグループ列付きの、定型文のCSVを選んでください。クリップボード履歴は対象外です。');
  if(!rows.length)fail('定型文がありません。');
  const columns=format.map(name=>header.indexOf(name)),categories=[],templates=[],groups=new Map();
  let generatedTitles=0;
  for(let i=0;i<rows.length;i++) {
    const row=rows[i],number=i+2;
    if(row.length!==format.length)fail(`${number}番目のレコードの列数が不正です。`);
    const values=columns.map(index=>row[index]);
    const [group,body,note,hotkey]=format.length===4?values:[null,...values];
    if(!body.trim())fail(`${number}番目のレコードの本文が空です。`);
    let categoryId=null;
    if(group!==null){
      const name=group.trim();
      if(!name||name.length>80)fail(`${number}番目のレコードのグループ名を1〜80文字にしてください。`);
      if(!groups.has(name)){const id=newId();groups.set(name,id);categories.push({id,name});}
      categoryId=groups.get(name);
    }
    const title=titleFor(note,body);if(!note.trim()||title!==note.trim())generatedTitles++;
    templates.push({id:newId(),title,body,categoryId,favorite:false,createdAt:now,updatedAt:now,clibor:{note,hotkey}});
  }
  const backup=validateBackup({format:FORMAT,version:BACKUP_VERSION,categories,templates});
  return {backup,generatedTitles,groupColumnPresent:format.length===4};
}

// Full CSV snapshot refresh. CSV has no stable IDs: uncertain identities are never guessed.
export function snapshotSignature(snapshot) {
  return JSON.stringify({categories:[...snapshot.categories].sort((a,b)=>a.id.localeCompare(b.id)),templates:[...snapshot.templates].sort((a,b)=>a.id.localeCompare(b.id))});
}
export function planCliborRefresh(current,raw,hasGroups=false,newId=uid,now=Date.now()) {
  const incoming=validateBackup(raw);
  if(typeof hasGroups!=='boolean' || !incoming.templates.length || incoming.templates.some(t=>!t.clibor || (!hasGroups&&t.categoryId!==null))) throw new Error('Cliborの全定型文を含むCSVを選び直してください。');
  const previous=current.templates.filter(t=>t.clibor),manual=current.templates.filter(t=>!t.clibor);
  const categories=current.categories.map(c=>({...c})),names=new Map(categories.map(c=>[c.name,c.id]));
  const categoryIds=new Set(categories.map(c=>c.id)),ids=new Set(current.templates.map(t=>t.id)),catMap=new Map();
  const fresh=used=>{let id;do{id=newId();}while(used.has(id));used.add(id);return id;};
  for(const c of incoming.categories){let id=names.get(c.name);if(!id){id=categoryIds.has(c.id)?fresh(categoryIds):c.id;categoryIds.add(id);categories.push({id,name:c.name});names.set(c.name,id);}catMap.set(c.id,id);}
  const unique=[],seen=new Set();let duplicates=0;
  for(const t of incoming.templates){const key=JSON.stringify([t.title,t.body,t.categoryId,t.clibor.note,t.clibor.hotkey]);if(seen.has(key)){duplicates++;continue;}seen.add(key);unique.push(t);}
  const matches=new Map(),used=new Set();
  const source=t=>t.clibor.source || {title:t.title,body:t.body};
  // A match requires uniqueness in both complete lists, even after other matches were found.
  const match=(oldKey,newKey)=>{
    const oldMap=new Map(),newMap=new Map();
    const collect=(map,key,t)=>{if(key!==null){const list=map.get(key)||[];list.push(t);map.set(key,list);}};
    previous.forEach(t=>collect(oldMap,oldKey(t),t));unique.forEach(t=>collect(newMap,newKey(t),t));
    for(const [key,next] of newMap){const old=oldMap.get(key);if(next.length===1&&old?.length===1&&!matches.has(next[0].id)&&!used.has(old[0].id)){matches.set(next[0].id,old[0]);used.add(old[0].id);}}
  };
  match(t=>JSON.stringify([source(t).body,t.clibor.note,t.clibor.hotkey]),t=>JSON.stringify([t.body,t.clibor.note,t.clibor.hotkey]));
  match(t=>t.clibor.note.trim()?t.clibor.note:null,t=>t.clibor.note.trim()?t.clibor.note:null);
  match(t=>t.clibor.hotkey.trim()?t.clibor.hotkey:null,t=>t.clibor.hotkey.trim()?t.clibor.hotkey:null);
  match(t=>source(t).body,t=>t.body);
  const rows=[];let added=0,updated=0,unchanged=0,localChanges=0,legacy=0;
  const templates=manual.map(t=>structuredClone(t));
  for(const t of unique){
    const old=matches.get(t.id),categoryId=hasGroups?(t.categoryId===null?null:catMap.get(t.categoryId)):(old?.categoryId ?? null);
    const changed=old && (old.title!==t.title || old.body!==t.body || old.categoryId!==categoryId || old.clibor.note!==t.clibor.note || old.clibor.hotkey!==t.clibor.hotkey);
    const localEdited=old?.clibor.source && (old.title!==source(old).title || old.body!==source(old).body) && (old.title!==t.title || old.body!==t.body);
    if(localEdited)localChanges++;
    if(old&&!old.clibor.source)legacy++;
    let id=old?.id || t.id;if(!old&&ids.has(id))id=fresh(ids);ids.add(id);
    const next={...t,id,categoryId,favorite:old?.favorite ?? false,createdAt:old?.createdAt ?? t.createdAt,updatedAt:old?(changed?Math.max(now,old.updatedAt+1):old.updatedAt):t.updatedAt,clibor:{note:t.clibor.note,hotkey:t.clibor.hotkey,source:{title:t.title,body:t.body}}};
    templates.push(next);
    const status=!old?'追加・再作成':changed?'更新':'変更なし';
    if(!old)added++;else if(changed)updated++;else unchanged++;
    rows.push({title:t.title,oldTitle:old?.title,status,localEdited:!!localEdited});
  }
  const removed=previous.filter(t=>!used.has(t.id));
  localChanges+=removed.filter(t=>t.clibor.source&&(t.title!==source(t).title||t.body!==source(t).body)).length;
  legacy=previous.filter(t=>!t.clibor.source).length;
  // Validate the entire proposed result before opening a write transaction.
  const next=validateBackup({format:FORMAT,version:BACKUP_VERSION,categories,templates});
  return {next,expected:snapshotSignature(current),rows,removed:removed.map(t=>({id:t.id,title:t.title})),previous:previous.length,manual:manual.length,added,updated,unchanged,duplicates,localChanges,legacy};
}
