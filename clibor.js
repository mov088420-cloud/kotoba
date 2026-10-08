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
