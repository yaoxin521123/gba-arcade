import { load } from './vendor/mgba/mgba.sdk.js';

const $ = s => document.querySelector(s);
const screen = $('.screen');
const canvas = document.createElement('canvas');
canvas.tabIndex = -1;
canvas.id = 'gba-screen'; canvas.width = 240; canvas.height = 160;
canvas.setAttribute('aria-label', 'GBA 游戏画面'); canvas.hidden = true;
screen.insertBefore(canvas, $('.scanlines'));
const library = document.createElement('section');
library.className = 'rom-library';
library.innerHTML = `<div class="rom-heading"><div><span class="eyebrow">YOUR OWN CARTRIDGES</span><h2>把你的 GBA 卡带带进来。</h2><p>选择本机 .gba 文件，游戏和存档保存在此浏览器。</p></div><label class="rom-import">＋ 导入 GBA 卡带<input id="rom-files" type="file" accept=".gba" multiple></label></div><div id="rom-cards" class="rom-cards"></div><p id="rom-status" role="status">支持同时导入多张卡带。文件仅在本机读取，不会上传。</p><div class="rom-tools" hidden><button id="rom-pause">暂停</button><button id="rom-save">即时存档</button><button id="rom-load">读取存档</button><button id="rom-export">导出存档</button><label class="save-import">导入存档<input id="rom-save-file" type="file" accept=".pocket-save"></label><button id="rom-zoom">放大屏幕 ⛶</button></div><div class="rom-key-guide" hidden><span><kbd>↑ ← ↓ →</kbd> 移动</span><span><kbd>X / 空格</kbd> A · 跳跃 / 确认</span><span><kbd>Z</kbd> B · 攻击 / 返回</span><span><kbd>Q / E</kbd> L / R</span><span><kbd>Enter</kbd> START</span><span><kbd>Shift</kbd> SELECT</span><span><kbd>P</kbd> 暂停</span></div>`;
$('.control-bar').after(library);

const catalog = document.createElement('section');
catalog.className = 'hosted-library';
catalog.innerHTML = '<div class="rom-heading"><div><span class="eyebrow">READY TO PLAY</span><h2>站点卡带</h2><p>选择一张卡带，加载后直接游玩。</p></div><button id="catalog-refresh" class="rom-import">刷新卡带</button></div><div id="hosted-cards" class="rom-cards"></div><p id="catalog-status" role="status">正在读取卡带清单…</p>';
library.before(catalog);

let engine = null, current = null, active = false, paused = false, busy = false, sequence = 0;
const records = new Map();
const hosted = new Map();
const catalogURL = new URL('./roms/catalog.json', import.meta.url);
let downloadController = null, catalogLoading = false;
const MAX_ROM_BYTES = 32 * 1024 * 1024;

function catalogEntry(entry) {
  if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string' || !entry.name.trim()) {
    throw new Error('每张卡带需要 name 和 file 字段');
  }
  const url = new URL(entry.file, catalogURL);
  const basePath = new URL('./', catalogURL).pathname;
  if (url.origin !== catalogURL.origin || !url.pathname.startsWith(basePath) ||
      !/\.gba$/i.test(url.pathname) || url.search || url.hash || url.username || url.password ||
      /[\\/]/.test(decodeURIComponent(url.pathname.slice(basePath.length)))) {
    throw new Error('file 必须是 roms 目录内的 .gba 文件名');
  }
  if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
    throw new Error('sha256 必须是 64 位十六进制字符串');
  }
  return { id: url.href, url: url.href, name: entry.name.trim().slice(0,80),
    label: typeof entry.label === 'string' ? entry.label.slice(0,60) : entry.name.slice(0,60),
    fileName: decodeURIComponent(url.pathname.slice(basePath.length)), sha256: entry.sha256?.toLowerCase() };
}

async function refreshCatalog() {
  if (catalogLoading || busy) return;
  catalogLoading = true; $('#catalog-refresh').disabled = true;
  $('#catalog-status').textContent = '正在读取卡带清单…';
  try {
    const response = await fetch(catalogURL, {cache:'no-store', signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`清单请求失败（HTTP ${response.status}）`);
    const entries = await response.json();
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('卡带清单必须是最多 100 项的数组');
    const next = entries.map(catalogEntry);
    if (new Set(next.map(e=>e.id)).size !== next.length) throw new Error('卡带清单包含重复的文件');
    hosted.clear(); next.forEach(entry=>hosted.set(entry.id,entry)); renderCards();
    $('#catalog-status').textContent = next.length ? `${next.length} 张卡带可供选择，点击后开始加载。` : '暂时没有站点卡带。你也可以在下方导入本地游戏。';
  } catch (error) {
    $('#catalog-status').textContent = `无法更新站点卡带：${error.message}。可以重试或使用本地导入。`;
  } finally {
    catalogLoading = false; $('#catalog-refresh').disabled = busy;
  }
}

async function downloadRom(entry, signal) {
  const response = await fetch(entry.url, {signal});
  if (!response.ok) throw new Error(`卡带下载失败（HTTP ${response.status}），请检查文件是否存在`);
  if (Number(response.headers.get('content-length')) > MAX_ROM_BYTES) {
    await response.body?.cancel(); throw new Error('卡带超过 32 MB');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_ROM_BYTES) { await reader.cancel(); throw new Error('卡带超过 32 MB'); }
      chunks.push(value);
      status(`正在加载 ${entry.name} · ${(size/1024/1024).toFixed(1)} MB`);
    }
  } finally { reader.releaseLock(); }
  const rom = await identify(new File(chunks, entry.fileName));
  if (entry.sha256 && entry.sha256 !== rom.id) throw new Error('卡带校验不匹配，请重新上传正确文件');
  return {...rom, name:entry.name, label:entry.label, sourceId:entry.id};
}
const dbPromise = new Promise((resolve,reject)=>{
  const request = indexedDB.open('pocket-room-gba',1);
  request.onupgradeneeded=()=>{request.result.createObjectStore('roms',{keyPath:'id'});request.result.createObjectStore('states',{keyPath:'id'});};
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
dbPromise.catch(()=>{});
async function dbAction(store,mode,operation){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode);const req=operation(tx.objectStore(store));tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('保存被中断'));});}
const status = message => { $('#rom-status').textContent = message; };
function setBusy(value){busy=value;$('#rom-files').disabled=value;$('#catalog-refresh').disabled=value||catalogLoading;document.querySelectorAll('.rom-play,.rom-tools button,.rom-tools input').forEach(b=>b.disabled=value);}
const names = {A2C:['晓月圆舞曲','ARIA OF SORROW'],ACH:['白夜协奏曲','HARMONY OF DISSONANCE'],AAM:['月之轮回','CIRCLE OF THE MOON']};
async function identify(file){
  if(!/\.gba$/i.test(file.name)||file.size<192||file.size>32*1024*1024)throw new Error('请选择 192 字节至 32 MB 的 .gba 文件。');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes[0xb2]!==0x96)throw new Error('文件缺少有效的 GBA 标识，请检查是否已解压。');
  const decode=b=>new TextDecoder('ascii').decode(b).replace(/\0/g,'').trim();
  const code=decode(bytes.slice(0xac,0xb0)),title=decode(bytes.slice(0xa0,0xac));
  const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
  return {id,bytes,code,title,name:names[code.slice(0,3)]?.[0]||title||file.name,label:names[code.slice(0,3)]?.[1]||title||'GBA',fileName:file.name};
}
function renderCards(){
  $('#rom-cards').replaceChildren();
  $('#hosted-cards').replaceChildren();
  for(const rom of [...hosted.values(), ...records.values()]){
    const isHosted = !!rom.url;
    const selected = isHosted ? current?.sourceId===rom.id : current?.id===rom.id;
    const button=document.createElement('button');button.className='rom-play';button.dataset.rom=rom.id;
    button.setAttribute('aria-pressed',String(selected));
    const symbol=document.createElement('span');symbol.className='rom-icon';symbol.textContent='▦';
    const copy=document.createElement('span'),title=document.createElement('strong'),detail=document.createElement('small');
    title.textContent=rom.name;detail.textContent=isHosted?'站点卡带 · 点击加载':`${rom.code} · ${(rom.bytes.length/1024/1024).toFixed(0)} MB · 本地卡带`;
    copy.append(title,detail);const arrow=document.createElement('span');arrow.textContent=selected?'已插入':'插入 ↗';
    button.append(symbol,copy,arrow);button.disabled=busy;button.onclick=()=>boot(rom);$(isHosted?'#hosted-cards':'#rom-cards').append(button);
  }
}
function releaseKeys(){for(const code of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyX','KeyZ','KeyQ','KeyE','Enter','ShiftRight'])sendKey(code,false);document.querySelectorAll('.pressed').forEach(b=>b.classList.remove('pressed'));}
function stop(){
  downloadController?.abort();downloadController=null;
  ++sequence;releaseKeys();engine?.destroy();engine=null;active=false;paused=false;current=null;
  canvas.hidden=true;$('#game').hidden=false;$('.rom-tools').hidden=true;$('.rom-key-guide').hidden=true;
  $('.key-guide').hidden=false;$('#select').setAttribute('aria-label','退出卡带');$('#start').setAttribute('aria-label','开始或暂停游戏');
  setBusy(false);renderCards();
}
async function boot(rom){
  if(busy)return;
  stop();window.pocketRoom.eject();const ticket=++sequence;
  active=true;current=rom.url?{...rom,sourceId:rom.id}:rom;setBusy(true);renderCards();
  $('#game').hidden=true;canvas.hidden=false;$('.key-guide').hidden=true;
  $('.rom-tools').hidden=false;$('.rom-key-guide').hidden=false;
  $('#now-playing').textContent=`正在启动 ${rom.name}…`;
  $('#game-note').textContent='方向键移动，X 跳跃 / 确认，Z 攻击 / 返回，Enter 开始。';
  $('#insert-label').textContent=rom.label;$('#insert-label').style.background='#8d7eab';
  $('#inserted').classList.add('loaded');$('#eject').disabled=false;
  $('#select').setAttribute('aria-label','GBA SELECT');$('#start').setAttribute('aria-label','GBA START');
  status(`正在读取 ${rom.fileName}…`);
  let downloadTimeout;
  try{
    if(rom.url){
      const controller = new AbortController(); downloadController = controller;
      downloadTimeout = setTimeout(()=>controller.abort(),60000);
      try { rom=await downloadRom(rom,controller.signal); }
      finally { clearTimeout(downloadTimeout); if(downloadController===controller)downloadController=null; }
      if(ticket!==sequence)return;
      current=rom;renderCards();
    }
    const next=await load({canvasEl:canvas,assets:{rom:rom.bytes},storageNamespace:rom.id,persist:'opfs',options:{system:'gba',gamepads:true,volume:$('#sound').getAttribute('aria-pressed')==='true'?0.65:0,escMenu:false}});
    if(ticket!==sequence){next.destroy();return;}
    engine=next;canvas.focus({preventScroll:true});engine.setInput({'p1.l':'KeyQ','p1.r':'KeyE'});engine.start();
    $('#now-playing').textContent=`${rom.name} / GBA`;$('#rom-pause').textContent='暂停';
    status(`${rom.name} 已启动。Enter 开始游戏；即时存档可跨刷新读取。`);
  }catch(error){if(ticket!==sequence)return;stop();window.pocketRoom.eject();status(`启动失败：${error.name==='AbortError'?'下载超时，请检查网络后重试':error.message}。可以重新点击卡带或使用本地导入。`);}
  finally{clearTimeout(downloadTimeout);if(ticket===sequence){setBusy(false);renderCards();}}
}
$('#rom-files').addEventListener('change',async event=>{
  const files=Array.from(event.target.files);event.target.value='';if(!files.length||busy)return;
  setBusy(true);let first=null;const failures=[];let persisted=true;
  for(const file of files){try{const rom=await identify(file);records.set(rom.id,rom);first||=rom;try{await dbAction('roms','readwrite',s=>s.put(rom))}catch{persisted=false}}catch(e){failures.push(`${file.name}：${e.message}`)}}
  setBusy(false);renderCards();if(first)await boot(first);
  if(failures.length)status(failures.join('；'));else if(!persisted)status('卡带可正常游玩，但浏览器未能保存卡带。下次打开需要重新导入。');
});

function pause(){if(!engine||busy)return;releaseKeys();paused=!paused;if(paused)engine.pause();else engine.resume();$('#rom-pause').textContent=paused?'继续':'暂停';canvas.focus({preventScroll:true});}
$('#rom-pause').onclick=pause;
function sendKey(code,down){const e=new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true,cancelable:true});Object.defineProperty(e,'gbaForwarded',{value:true});window.dispatchEvent(e);}
const map={ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',KeyX:'KeyX',Space:'KeyX',KeyZ:'KeyZ',KeyQ:'KeyQ',KeyE:'KeyE',Enter:'Enter',ShiftLeft:'ShiftRight',ShiftRight:'ShiftRight'};
for(const kind of ['keydown','keyup'])window.addEventListener(kind,e=>{
  if(!active||e.gbaForwarded)return;
  if(e.target instanceof HTMLInputElement)return;
  if((e.code==='Space'||e.code==='Enter')&&e.target instanceof HTMLButtonElement)return;
  if(e.code==='KeyP'){e.preventDefault();e.stopImmediatePropagation();if(kind==='keydown'&&!e.repeat)pause();return;}
  const code=map[e.code];if(!code)return;e.preventDefault();e.stopImmediatePropagation();
  if(!e.repeat&&engine&&!busy)sendKey(code,kind==='keydown');
},true);
const deviceMap={ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',' ':'KeyX',z:'KeyZ'};
for(const side of ['left','right']){const old=document.querySelector('.shoulder.'+side);const b=document.createElement('button');b.className=old.className;b.dataset.gbaKey=side==='left'?'KeyQ':'KeyE';b.setAttribute('aria-label',side==='left'?'GBA L':'GBA R');old.replaceWith(b);}
for(const button of document.querySelectorAll('[data-key],[data-gba-key],#start,#select')){
  const code=button.dataset.gbaKey||deviceMap[button.dataset.key]||(button.id==='start'?'Enter':'ShiftRight');
  button.addEventListener('pointerdown',e=>{if(!active)return;e.preventDefault();e.stopImmediatePropagation();if(!engine||busy)return;button.setPointerCapture(e.pointerId);button.classList.add('pressed');sendKey(code,true)},true);
  for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,e=>{if(!active)return;e.stopImmediatePropagation();button.classList.remove('pressed');sendKey(code,false)},true);
  button.addEventListener('click',e=>{if(!active)return;e.preventDefault();e.stopImmediatePropagation();if(e.detail===0&&engine){sendKey(code,true);setTimeout(()=>sendKey(code,false),90)}button.blur()},true);
}
document.querySelectorAll('.cartridge').forEach(b=>b.addEventListener('click',()=>{if(active)stop()},true));
$('#eject').addEventListener('click',()=>{if(active)stop()},true);
const ejectButton=document.createElement('button');ejectButton.textContent='弹出卡带 ↥';ejectButton.id='rom-eject';
ejectButton.onclick=()=>{stop();window.pocketRoom.eject();status('已弹出。点击本地卡带可重新启动。')};$('.rom-tools').append(ejectButton);
$('#sound').addEventListener('click',()=>{engine?.config.write('volume',$('#sound').getAttribute('aria-pressed')==='true'?0.65:0)});
window.addEventListener('blur',()=>{if(active&&engine&&!paused)pause()});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active&&engine&&!paused)pause()});
async function save(){if(!engine||busy)return;setBusy(true);const rom=current,core=engine;try{const bytes=await core.saveState();await dbAction('states','readwrite',s=>s.put({id:rom.id,bytes,date:Date.now()}));status(`${rom.name} 即时存档已保存。`)}catch(e){status(`存档失败：${e.message}`)}finally{setBusy(false);if(active)canvas.focus({preventScroll:true})}}
async function restore(){if(!engine||busy)return;setBusy(true);try{const saved=await dbAction('states','readonly',s=>s.get(current.id));if(!saved){status('这张卡带还没有即时存档，请先点击“即时存档”。');return}await engine.loadState(saved.bytes);status('已恢复即时存档。')}catch(e){status(`读取失败：${e.message}`)}finally{setBusy(false);if(active)canvas.focus({preventScroll:true})}}
$('#rom-save').onclick=save;$('#rom-load').onclick=restore;
$('#rom-export').onclick=async()=>{if(!engine||busy)return;setBusy(true);try{const bytes=await engine.saveState();const prefix=new TextEncoder().encode(JSON.stringify({format:'pocket-room-1',rom:current.id})+'\n');const url=URL.createObjectURL(new Blob([prefix,bytes]));const a=document.createElement('a');a.href=url;a.download=`${current.code}-${current.name}.pocket-save`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('存档已导出，请保留文件用于备份。')}catch(e){status(`导出失败：${e.message}`)}finally{setBusy(false);if(active)canvas.focus({preventScroll:true})}};
$('#rom-save-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file||!engine||busy)return;setBusy(true);try{if(file.size>2*1024*1024)throw new Error('存档文件过大');const bytes=new Uint8Array(await file.arrayBuffer()),end=bytes.indexOf(10);if(end<0||end>256)throw new Error('存档格式不正确');const meta=JSON.parse(new TextDecoder().decode(bytes.slice(0,end)));if(meta.format!=='pocket-room-1'||meta.rom!==current.id)throw new Error('存档不属于当前卡带，请切换对应卡带');await engine.loadState(bytes.slice(end+1));status('已导入并恢复存档。')}catch(error){status(`导入失败：${error.message}`)}finally{setBusy(false);if(active)canvas.focus({preventScroll:true})}};
$('#rom-zoom').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await screen.requestFullscreen()}catch{status('浏览器不支持全屏，请使用桌面 Chrome 或 Edge。')}};
dbAction('roms','readonly',s=>s.getAll()).then(roms=>{for(const rom of roms)records.set(rom.id,rom);renderCards();if(roms.length&&!active)status(`已恢复 ${roms.length} 张本地卡带。点击卡带开始游戏。`)}).catch(()=>status('浏览器存储不可用；仍可导入卡带游玩，但刷新后需重新导入。'));
$('#catalog-refresh').onclick=refreshCatalog;
void refreshCatalog();
window.gbaPlayer={get active(){return active},getSnapshot:()=>({active,paused,busy,game:current?.name,code:current?.code,library:records.size,hosted:hosted.size}),stop};
