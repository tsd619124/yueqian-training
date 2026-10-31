/* 跃迁计划 · 应用脚本。APP_VERSION 定义在 index.html(发布脚本从那里读取),这里直接使用。 */
(function(){
'use strict';
var KEY='yueqian.v1';
var CONTENT_URL='./content/course.json';
var $=function(s,el){return (el||document).querySelector(s)};
var $$=function(s,el){return Array.prototype.slice.call((el||document).querySelectorAll(s))};

/* ================= 启动:先读课程内容(content/course.json),再挂载界面 ================= */
var booted=false;
function loadContent(){return fetch(CONTENT_URL,{cache:'no-cache'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})}
function bootFailed(){
 var box=$('#bootStatus');if(!box||booted)return;
 box.innerHTML='<span>课程内容没有载入。'+(navigator.onLine===false?'当前离线，联网后重试。':'请稍后重试。')+'</span><button class="btn sm primary" type="button" id="bootRetry">重试</button>';
 $('#bootRetry').addEventListener('click',function(){box.textContent='正在载入课程…';loadContent().then(boot,bootFailed)});
}
(window.YUEQIAN_CONTENT||loadContent()).then(boot,bootFailed);

function boot(C){
if(booted)return;booted=true;
/* ================= 内容数据(随 content/course.json 发布;此处只做派生索引) ================= */
var LVW=C.levels,STAGES=C.stages,TRACKS=C.tracks,MODS=C.modules,DAILY=C.dailyPrompts,PHASES=C.phases,PROJECTS=C.projects,QA=C.interviewQuestions,QUIZ=C.quizzes,LESSONS=C.lessons,SKILL_LESSON=C.skillLessons,LEARN_ENTRIES=C.entries,TASK_LABELS=C.taskLabels,RELATED_GOALS=C.relatedGoals;
var NN=0;MODS.forEach(function(m){NN+=m.nodes.length});
var SRC={};
PHASES.forEach(function(p){p.ws.forEach(function(w){w.tasks.forEach(function(_,i){SRC[w.id+'.'+i]={src:p.name,wk:'第 '+w.id.slice(1)+' 周 · '+w.t}})})});
PROJECTS.forEach(function(p){p.tasks.forEach(function(_,i){SRC[p.id+'.'+i]={src:'求职大作业',wk:p.name}})});

function md(s){
 var lines=String(s).split('\n'),html='',list=null,code=null,tbl=false;
 function closeL(){if(list){html+='</ul>';list=null}}
 function closeT(){if(tbl){html+='</tbody></table>';tbl=false}}
 function closeCode(){if(code!==null){html+='<pre><code>'+esc(code.join('\n'))+'</code></pre>';code=null}}
 lines.forEach(function(ln){
  if(ln.trim().indexOf('```')===0){closeL();closeT();if(code===null)code=[];else closeCode();return}
  if(code!==null){code.push(ln);return}
  var image=ln.match(/^!\[([^\]]*)\]\((training-receipt(?:-obscured)?\.png)\)$/);
  if(image){closeL();closeT();html+='<img src="./'+esc(image[2])+'" alt="'+esc(image[1])+'" loading="lazy">';return}
  if(ln.indexOf('## ')===0){closeL();closeT();html+='<h5>'+esc(ln.slice(3))+'</h5>'}
  else if(ln.indexOf('- ')===0){closeT();if(!list){html+='<ul>';list=true}html+='<li>'+esc(ln.slice(2))+'</li>'}
  else if(ln.charAt(0)==='>'){closeL();closeT();html+='<blockquote>'+esc(ln.slice(1).trim())+'</blockquote>'}
  else if(ln.charAt(0)==='|'){
   closeL();
   var cells=ln.split('|').slice(1,-1).map(function(x){return x.trim()});
   if(cells.every(function(cell){return /^:?-{3,}:?$/.test(cell)}))return;
   if(!tbl){html+='<table><thead><tr>';cells.forEach(function(c){html+='<th>'+esc(c)+'</th>'});html+='</tr></thead><tbody>';tbl=true}
   else{html+='<tr>';cells.forEach(function(c){html+='<td>'+esc(c)+'</td>'});html+='</tr>'}
  }
  else if(ln===''){closeL();closeT()}
  else{closeL();closeT();html+='<p>'+esc(ln)+'</p>'}
 });
 closeL();closeT();closeCode();
 return html;
}
var DRL=null,readerRestoreFocus=null,readerRestoreIndex=0,readerRestoring=false,readerFrame=0;
function secT(t){return '<div class="sec-t">'+t+'</div>'}
function lessonStatus(id){return S.checks[id]?'done':S.readDone[id]?'read':S.read[id]?'opened':'new'}
function readingLabel(id){return S.readDone[id]?'已读完':S.read[id]?'已打开':'未打开'}
function highlightText(value,query){
 var text=String(value||''),needle=String(query||'').toLowerCase(),lower=text.toLowerCase(),result='',start=0,index;
 if(!needle)return esc(text);
 while((index=lower.indexOf(needle,start))>=0){result+=esc(text.slice(start,index))+'<mark>'+esc(text.slice(index,index+needle.length))+'</mark>';start=index+needle.length}
 return result+esc(text.slice(start));
}
function lessonSnippet(lesson,query){
 var sections=[lesson.why||'',lesson.out||''].concat(lesson.how||[]);
 (lesson.mat||[]).forEach(function(material){sections.push(material.n+' · '+material.b)});
 for(var index=0;index<sections.length;index++){
  var text=String(sections[index]).replace(/\s+/g,' '),hit=text.toLowerCase().indexOf(query.toLowerCase());
  if(hit>=0){var start=Math.max(0,hit-34),end=Math.min(text.length,hit+query.length+84);return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'')}
 }
 return '';
}
function learnItem(id,lesson,query){
 var read=S.readDone[id],snippet=query?lessonSnippet(lesson,query):'';
 return '<button type="button" class="learn-item'+(read?' done':'')+'" data-lesson="'+esc(id)+'">'+icon(read?'i-check':'i-book')+'<span class="learn-copy"><span class="learn-title">'+highlightText(lesson.t,query)+'</span><span class="learn-meta"><span class="tag'+(read?' green':'')+'">'+readingLabel(id)+'</span>'+(S.checks[id]?'<span class="tag green">任务完成</span>':'')+'<span>'+esc(lesson.time||'')+'</span></span>'+(snippet?'<span class="learn-snippet">'+highlightText(snippet,query)+'</span>':'')+'</span></button>';
}
function learnHay(lesson){return ((lesson.t||'')+' '+(lesson.why||'')+' '+(lesson.out||'')+' '+(lesson.how||[]).join(' ')+' '+(lesson.mat||[]).map(function(material){return (material.n||'')+' '+(material.k||'')+' '+(material.b||'')}).join(' ')).toLowerCase()}
function renderLearn(){
 var query=$('#learnSearch').value.trim().slice(0,200),week=$('#learnWeek').value,status=$('#learnState').value;
 var hits=LEARN_ENTRIES.filter(function(entry){return (week==='all'||entry.week===week)&&(status==='all'||lessonStatus(entry.id)===status)&&(!query||learnHay(LESSONS[entry.id]).indexOf(query.toLowerCase())>=0)});
 var html='',group='',context='';
 hits.forEach(function(entry){
  if(group!==entry.group){group=entry.group;html+='<div class="phase-head"><h3>'+esc(group)+'</h3></div>';context=''}
  if(context!==entry.context){context=entry.context;if(context!==group)html+='<div class="learn-week small muted" style="margin:12px 0 7px">'+esc(context)+'</div>'}
  html+=learnItem(entry.id,LESSONS[entry.id],query);
 });
 if(!hits.length)html='<div class="card learn-empty"><p>没有找到匹配的学习内容</p><p class="small muted" style="margin:6px 0 12px">试试更短的关键词，或清除周次和状态筛选。</p><button class="btn sm" id="learnClear" data-action="learn-clear">清除搜索与筛选</button></div>';
 var completed=Object.keys(S.readDone).filter(function(id){return !!LESSONS[id]}).length;
 $('#learnIntro').textContent=(query?'全文搜索「'+query+'」 · ':'')+'显示 '+hits.length+' / '+LEARN_ENTRIES.length+' 个主题 · 已读完 '+completed+' 个。打开材料与读完、任务完成分别记录。';
 $('#learnWrap').innerHTML=html;
}
function applyReaderSettings(){
 $('#drBody').style.setProperty('--reading-size',UI.font+'px');
 $('#drBody').style.setProperty('--reading-line',UI.line);
 $('#readerFontSize').textContent=UI.font;
 $('#readerLine').value=String(UI.line);
 $$('[data-font-step]').forEach(function(button){button.disabled=Number(button.getAttribute('data-font-step'))<0?UI.font<=15:UI.font>=24});
}
function captureReading(){
 if(!DRL||readerRestoring)return;
 UI.reading[DRL]={top:Math.round($('#drBody').scrollTop),open:$$('#drBody details.mat').map(function(detail,index){return detail.open?index:-1}).filter(function(index){return index>=0})};
 captureEvidenceDraft();
 saveUI();
}
function renderReaderFoot(){
 if(!DRL)return;
 $('#drReadingStatus').textContent=readingLabel(DRL)+(S.checks[DRL]?' · 任务完成':' · 阅读位置自动保存');
 $('#drFoot').innerHTML='<button class="btn'+(S.readDone[DRL]?'':' primary')+'" id="drRead" data-action="reader-read">'+icon('i-check')+(S.readDone[DRL]?'已读完 · 撤销':'标记读完')+'</button>'+(SRC[DRL]?'<button class="btn'+(S.readDone[DRL]?' primary':'')+'" id="drDone" data-action="reader-done"'+(S.checks[DRL]?' disabled':'')+'>'+icon('i-clipboard')+(S.checks[DRL]?'任务已完成':'标记任务完成')+'</button>':'');
}
function openLesson(id,restoring,trigger){
 if(NAV_PENDING&&!restoring)return;
 var lesson=LESSONS[id];if(!lesson)return;
 captureReading();
 if(!DRL){
  readerRestoreFocus=trigger||document.activeElement;
  var view=readerRestoreFocus.closest('.view');
  readerRestoreIndex=view?$$('[data-lesson]',view).filter(function(button){return button.getAttribute('data-lesson')===id}).indexOf(readerRestoreFocus):0;
 }
 DRL=id;
 UI.lastLesson=id;saveUI();
 if(!S.read[id]){S.read[id]=true;save()}
 var src=SRC[id]||{};
 $('#drSrc').textContent=(src.src?src.src+' · '+src.wk+' · ':'')+(lesson.time||'');$('#drTitle').textContent=lesson.t;
 var html='',position=UI.reading[id];
 readerRestoring=true;cancelAnimationFrame(readerFrame);
 if(lesson.why)html+=secT('为什么做')+'<div class="md"><p>'+esc(lesson.why)+'</p></div>';
 if(lesson.review){html+='<details class="mat"><summary>校订与来源 · '+esc(lesson.review.date)+'</summary><div class="md"><p>'+esc(lesson.review.scope)+'</p>';lesson.review.sources.forEach(function(source){html+='<p><a href="'+esc(source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(source.title)+'</a></p>'});html+='</div></details>'}
 var external=globalThis.YUEQIAN_EXTERNAL_CATALOG;
 var originals=external?external.articles.filter(function(article){return article.lessonIDs.indexOf(id)>=0}):[];
 if(originals.length){html+=secT('原文与配图');originals.forEach(function(article){html+='<p style="margin:0 0 8px"><a class="btn ghost" href="./materials.html?article='+esc(article.id)+'">'+esc(article.title)+' ↗</a></p>'})}
 if(lesson.mat){
  html+=secT('学习材料');
  lesson.mat.forEach(function(material,index){
   var expanded=position?position.open.indexOf(index)>=0:index===0;
   html+='<details class="mat"'+(expanded?' open':'')+'><summary><span class="tag brand">'+esc(material.k)+'</span><b style="font-size:15px;flex:1;min-width:140px">'+esc(material.n)+'</b>'+icon('i-chev','chev')+'</summary><div class="md">'+md(material.b)+'</div></details>';
  });
 }
 if(lesson.how)html+=secT('怎么做')+'<div class="md"><ul>'+lesson.how.map(function(text){return '<li>'+esc(text)+'</li>'}).join('')+'</ul></div>';
 if(lesson.out)html+=secT('完成标志')+'<div class="md"><blockquote>'+esc(lesson.out)+'</blockquote></div>';
 html+=evidenceEditor(id);
 $('#drBody').innerHTML=html;
 applyReaderSettings();renderReaderFoot();
 $('#drawer').classList.add('on');
 $('#drawer').removeAttribute('inert');$('#drawer').setAttribute('aria-hidden','false');
 $('#drawerMask').classList.add('on');
 $('.app').setAttribute('inert','');$('.tabbar').setAttribute('inert','');
 document.body.style.overflow='hidden';
 $('#drClose').focus({preventScroll:true});
 readerFrame=requestAnimationFrame(function(){$('#drBody').scrollTop=position?position.top:0;readerRestoring=false});
 invalidate('learn','hero');
 if(!restoring)writeRoute();
}
function closeLesson(restoring){
 if(!DRL)return;
 captureReading();
 if(!restoring&&NAV_READY&&history.state&&history.state.yueqianRoute&&history.state.lesson===DRL&&history.state.step>0){
  if(!NAV_PENDING){NAV_PENDING=true;history.back()}
  return;
 }
 cancelAnimationFrame(readerFrame);readerRestoring=false;
 $('#drawer').classList.remove('on');
 $('#drawerMask').classList.remove('on');
 $('.app').removeAttribute('inert');$('.tabbar').removeAttribute('inert');
 document.body.style.overflow='';
 DRL=null;
 var restore=readerRestoreFocus,view=$('.view:not([hidden])');
 if(restore&&!restore.isConnected&&view&&restore.hasAttribute('data-lesson')){
  var lessonId=restore.getAttribute('data-lesson');
  var matches=$$('[data-lesson]',view).filter(function(button){return button.getAttribute('data-lesson')===lessonId});
  restore=matches[Math.max(0,readerRestoreIndex)]||matches[0];
 }
 if(restore&&restore.isConnected&&!restore.disabled&&!restore.closest('[hidden],[inert]')&&restore.getClientRects().length)restore.focus({preventScroll:true});
 if(view&&($('#drawer').contains(document.activeElement)||document.activeElement===document.body)){view.setAttribute('tabindex','-1');view.focus({preventScroll:true})}
 readerRestoreFocus=null;readerRestoreIndex=0;
 $('#drawer').setAttribute('inert','');$('#drawer').setAttribute('aria-hidden','true');
 if(!restoring)writeRoute(true);
}
function markReadDone(){
 if(!DRL)return;
 if(S.readDone[DRL])delete S.readDone[DRL];else S.readDone[DRL]=true;
 save();renderReaderFoot();invalidate('learn','hero');
 toast(S.readDone[DRL]?'已记录读完，任务完成情况单独保存。':'已撤销读完标记。','i-book');
}
function markLessonDone(){
 var id=DRL;if(!id)return;
 setTaskChecks([id],true);
 toast('任务已完成，周次、阶段和总进度已同步更新。','i-check','green');
}

/* ================= Store:学习状态、本机持久化、云同步与错误上报 =================
   状态只在这一层读写和保存;界面层通过 store.on 订阅提示、同步状态与整份替换,
   通过 invalidate() 标记需要重绘的区域,不在这里直接改界面。 */
var store={listeners:{},on:function(type,fn){(this.listeners[type]=this.listeners[type]||[]).push(fn)},emit:function(type,detail){(this.listeners[type]||[]).forEach(function(fn){fn(detail)})}};
function notify(msg,ic,cls,btn){store.emit('notice',{msg:msg,ic:ic,cls:cls,btn:btn})}
function replaceState(next){S=next;store.emit('replace')}
function defaults(){return {name:'',theme:'auto',skills:{},checks:{},days:[],quiz:{},co:[],start:null,reroll:{},mil:{},read:{},readDone:{},wrong:{},quizSeen:{},attempts:[],latestQuiz:{},evidence:[],rev:0,pushedRev:0,pushedAt:'',pushedHash:'',syncBase:'',lc:null,extra:null}}
var S=defaults();
/* 向前兼容:新版本客户端写入的未知字段、未知课程/题目的记录原样保留在 extra,推送与导出时并回 */
var KNOWN_TOP=Object.keys(defaults());
function safeKey(key){return typeof key==='string'&&key.length<=120&&key!=='__proto__'&&key!=='constructor'&&key!=='prototype'}
function keepExtra(raw,result,known){if(raw&&typeof raw==='object'&&!Array.isArray(raw))Object.keys(raw).forEach(function(key){if(known.indexOf(key)<0&&safeKey(key)&&!Object.prototype.hasOwnProperty.call(result,key))result[key]=raw[key]});return result}
function withExtra(src,out){
 var extra=src&&src.extra;if(!extra||typeof extra!=='object')return out;
 var ids=extra.ids&&typeof extra.ids==='object'?extra.ids:{};
 ['readDone','quizSeen'].forEach(function(key){var map=ids[key];if(map&&typeof map==='object'&&Object.keys(map).length){var merged={};Object.keys(out[key]||{}).forEach(function(id){merged[id]=out[key][id]});Object.keys(map).forEach(function(id){if(safeKey(id)&&map[id]===true)merged[id]=true});out[key]=merged}});
 if(Array.isArray(out.evidence)&&ids.goals&&typeof ids.goals==='object')out.evidence=out.evidence.map(function(proof){var more=proof&&ids.goals[proof.id];if(!more||!Object.prototype.hasOwnProperty.call(ids.goals,proof.id))return proof;var next=Object.assign({},proof);next.goals=(proof.goals||[]).concat(more.goals||[]);var confirmed=(proof.confirmedGoals||[]).concat(more.confirmedGoals||[]);if(confirmed.length)next.confirmedGoals=confirmed;return next});
 if(Array.isArray(ids.evidence)&&ids.evidence.length)out.evidence=(Array.isArray(out.evidence)?out.evidence:[]).concat(ids.evidence);
 if(Array.isArray(ids.attempts)&&ids.attempts.length)out.attempts=(Array.isArray(out.attempts)?out.attempts:[]).concat(ids.attempts).map(function(item,index){return {item:item,index:index,at:Date.parse(item&&item.at)||0}}).sort(function(a,b){return a.at-b.at||a.index-b.index}).map(function(entry){return entry.item});
 if(extra.top&&typeof extra.top==='object')Object.keys(extra.top).forEach(function(key){if(KNOWN_TOP.indexOf(key)<0&&safeKey(key))out[key]=extra.top[key]});
 return out;
}
var motionPreference=window.matchMedia('(prefers-reduced-motion: reduce)');
var REDUCE=motionPreference.matches;
function normalize(raw,target){
 var out=target||S;
 if(!raw||typeof raw!=='object')return;
 if(raw.extra&&typeof raw.extra==='object'){raw=withExtra(raw,Object.assign({},raw));delete raw.extra}
 var extra={top:{},ids:{readDone:{},quizSeen:{},evidence:[],attempts:[],goals:{}}};
 Object.keys(raw).forEach(function(key){if(KNOWN_TOP.indexOf(key)<0&&safeKey(key))extra.top[key]=raw[key]});
 if(typeof raw.name==='string')out.name=raw.name.slice(0,12);
 if(raw.theme==='light'||raw.theme==='dark'||raw.theme==='auto')out.theme=raw.theme;
 if(Array.isArray(raw.days))out.days=raw.days.filter(function(x){return typeof x==='string'}).slice(-400);
 if(raw.skills&&typeof raw.skills==='object'){var o1={};for(var k in raw.skills){var v=raw.skills[k];if(typeof v==='number'&&v>=0&&v<=3)o1[k]=v}out.skills=o1}
 if(raw.checks&&typeof raw.checks==='object'){var o2={};for(var k2 in raw.checks){if(raw.checks[k2])o2[k2]=true}out.checks=o2}
 if(raw.quiz&&typeof raw.quiz==='object'){var o3={};for(var k3 in raw.quiz){var v3=raw.quiz[k3];if(typeof v3==='number'&&v3>=0&&v3<=100)o3[k3]=Math.round(v3)}out.quiz=o3}
 if(Array.isArray(raw.co))out.co=raw.co.filter(function(x){return x&&typeof x.n==='string'&&x.n}).slice(0,60).map(function(x){
   var s=(typeof x.s==='number')?Math.floor(x.s):0,t=(typeof x.t==='number')?Math.floor(x.t):0;
   return keepExtra(x,{n:x.n.slice(0,40),s:(s>=0&&s<STAGES.length)?s:0,t:(t>=0&&t<TRACKS.length)?t:0,d:(typeof x.d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x.d))?x.d:''},['n','s','t','d'])});
 if(raw.reroll&&typeof raw.reroll==='object'){var o4={};for(var k4 in raw.reroll){if(typeof raw.reroll[k4]==='number')o4[k4]=raw.reroll[k4]}out.reroll=o4}
 if(raw.mil&&typeof raw.mil==='object'){var o5={};for(var k5 in raw.mil){if(raw.mil[k5])o5[k5]=true}out.mil=o5}
 if(raw.read&&typeof raw.read==='object'){var o6={};for(var k6 in raw.read){if(raw.read[k6])o6[k6]=true}out.read=o6}
 if(raw.readDone&&typeof raw.readDone==='object'){var completed={};Object.keys(raw.readDone).forEach(function(id){if(raw.readDone[id]!==true)return;if(Object.keys(LESSONS).indexOf(id)>=0)completed[id]=true;else if(safeKey(id))extra.ids.readDone[id]=true});out.readDone=completed}
 if(raw.quizSeen&&typeof raw.quizSeen==='object'){var seen={};Object.keys(raw.quizSeen).forEach(function(id){if(raw.quizSeen[id]!==true)return;if(quizQuestion(id))seen[id]=true;else if(safeKey(id))extra.ids.quizSeen[id]=true});out.quizSeen=seen}
 if(Array.isArray(raw.attempts))extra.ids.attempts=raw.attempts.filter(function(attempt){return attempt&&typeof attempt==='object'&&typeof attempt.mod==='string'&&Object.keys(QUIZ).indexOf(attempt.mod)<0&&attempt.mod!=='review'&&typeof attempt.at==='string'}).slice(-100);
 if(Array.isArray(raw.attempts))out.attempts=raw.attempts.filter(function(attempt){return attempt&&typeof attempt==='object'&&(Object.keys(QUIZ).indexOf(attempt.mod)>=0||attempt.mod==='review')&&typeof attempt.at==='string'&&isFinite(Date.parse(attempt.at))&&typeof attempt.correct==='number'&&isFinite(attempt.correct)&&typeof attempt.total==='number'&&isFinite(attempt.total)&&attempt.total>=1&&attempt.total<=100&&attempt.correct>=0&&attempt.correct<=attempt.total}).slice(-100).map(function(attempt){var total=Math.floor(attempt.total),correct=Math.min(total,Math.floor(attempt.correct));return keepExtra(attempt,{mod:attempt.mod,at:attempt.at.slice(0,40),correct:correct,total:total,score:Math.round(correct/total*100)},['mod','at','correct','total','score'])});
 out.latestQuiz={};out.attempts.forEach(function(attempt){if(QUIZ[attempt.mod])out.latestQuiz[attempt.mod]=attempt});
 if(raw.latestQuiz&&typeof raw.latestQuiz==='object'){Object.keys(QUIZ).forEach(function(module){var value=raw.latestQuiz[module];if(value&&value.mod===module&&value.total===QUIZ[module].length&&typeof value.correct==='number'&&isFinite(value.correct)&&value.correct>=0&&value.correct<=value.total&&typeof value.at==='string'&&isFinite(Date.parse(value.at)))out.latestQuiz[module]={mod:module,at:value.at,correct:Math.floor(value.correct),total:value.total,score:Math.round(Math.floor(value.correct)/value.total*100)}})}
 if(Array.isArray(raw.evidence))extra.ids.evidence=raw.evidence.filter(function(proof){return proof&&typeof proof==='object'&&typeof proof.id==='string'&&typeof proof.lesson==='string'&&Object.keys(LESSONS).indexOf(proof.lesson)<0&&typeof proof.title==='string'&&Array.isArray(proof.goals)}).slice(-200);
 if(Array.isArray(raw.evidence))out.evidence=raw.evidence.filter(function(proof){return proof&&typeof proof==='object'&&typeof proof.id==='string'&&Object.keys(LESSONS).indexOf(proof.lesson)>=0&&typeof proof.title==='string'&&Array.isArray(proof.goals)}).slice(-200).map(function(proof){var confirmed=Array.isArray(proof.confirmedGoals)?proof.confirmedGoals.filter(function(id,index,list){return proof.goals.indexOf(id)>=0&&Object.keys(SRC).indexOf(id)>=0&&list.indexOf(id)===index}).sort():[];var result={id:proof.id.slice(0,80),lesson:proof.lesson,title:proof.title.slice(0,120),note:typeof proof.note==='string'?proof.note.slice(0,6000):'',url:safeEvidenceUrl(proof.url),goals:proof.goals.filter(function(id,index,list){return typeof id==='string'&&Object.keys(SRC).indexOf(id)>=0&&list.indexOf(id)===index}).slice(0,80),at:typeof proof.at==='string'&&isFinite(Date.parse(proof.at))?proof.at.slice(0,40):''};if(confirmed.length)result.confirmedGoals=confirmed;var unknownGoals=proof.goals.filter(function(id){return typeof id==='string'&&safeKey(id)&&!SRC[id]}),unknownConfirmed=Array.isArray(proof.confirmedGoals)?proof.confirmedGoals.filter(function(id){return unknownGoals.indexOf(id)>=0}):[];if(unknownGoals.length&&safeKey(result.id)){extra.ids.goals[result.id]={goals:unknownGoals};if(unknownConfirmed.length)extra.ids.goals[result.id].confirmedGoals=unknownConfirmed}return keepExtra(proof,result,['id','lesson','title','note','url','goals','at','confirmedGoals'])});
 if(raw.wrong&&typeof raw.wrong==='object'){var o7={};for(var k7 in raw.wrong){var w=raw.wrong[k7];if(w&&typeof w==='object'&&typeof w.next==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(w.next))o7[k7]=keepExtra(w,{n:Math.min(99,Math.max(1,Math.floor(w.n)||1)),s:Math.min(9,Math.max(0,Math.floor(w.s)||0)),next:w.next},['n','s','next'])}out.wrong=o7}
 if(typeof raw.start==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(raw.start))out.start=raw.start;
 if(raw.lc&&typeof raw.lc==='object'){var lc={};['id','key','host','code','backend','token','gist'].forEach(function(f){if(typeof raw.lc[f]==='string')lc[f]=raw.lc[f].slice(0,200)});out.lc=lc}
 if(typeof raw.rev==='number'&&raw.rev>=0)out.rev=Math.floor(raw.rev);
 if(typeof raw.pushedRev==='number'&&raw.pushedRev>=0)out.pushedRev=Math.floor(raw.pushedRev);
 if(typeof raw.pushedAt==='string')out.pushedAt=raw.pushedAt.slice(0,40);
 if(typeof raw.pushedHash==='string')out.pushedHash=raw.pushedHash.slice(0,40);
 if(typeof raw.syncBase==='string')out.syncBase=raw.syncBase.slice(0,40);
 var ids=extra.ids,kept={};
 if(Object.keys(extra.top).length)kept.top=extra.top;
 if(Object.keys(ids.readDone).length||Object.keys(ids.quizSeen).length||ids.evidence.length||ids.attempts.length||Object.keys(ids.goals).length){kept.ids={};Object.keys(ids).forEach(function(key){if(Array.isArray(ids[key])?ids[key].length:Object.keys(ids[key]).length)kept.ids[key]=ids[key]})}
 out.extra=Object.keys(kept).length?kept:null;
}
try{var saved=localStorage.getItem(KEY);if(saved)normalize(JSON.parse(saved))}catch(e){}
var UI_KEY=KEY+'.experience',uiTimer=null,UI=uiDefaults();
function uiDefaults(){return {view:'ov',group:{train:'daily',plan:'plan'},scroll:{},lastLesson:'',reading:{},drafts:{},font:17,line:1.85,query:'',week:'all',status:'all'}}
function loadUI(){
 try{
  var raw=JSON.parse(localStorage.getItem(UI_KEY)||'null');if(!raw||typeof raw!=='object')return;
  var views=['ov','daily','skills','quiz','plan','learn','lab','me'];
  if(views.indexOf(raw.view)>=0)UI.view=raw.view;
  if(raw.group&&typeof raw.group==='object'){
   if(['daily','skills','quiz'].indexOf(raw.group.train)>=0)UI.group.train=raw.group.train;
   if(['plan','learn','lab'].indexOf(raw.group.plan)>=0)UI.group.plan=raw.group.plan;
  }
  if(raw.scroll&&typeof raw.scroll==='object')views.forEach(function(view){var value=raw.scroll[view];if(typeof value==='number'&&isFinite(value)&&value>=0)UI.scroll[view]=Math.min(value,1e7)});
  if(typeof raw.font==='number'&&isFinite(raw.font))UI.font=Math.min(24,Math.max(15,Math.round(raw.font)));
  if([1.6,1.85,2.1].indexOf(raw.line)>=0)UI.line=raw.line;
  if(typeof raw.lastLesson==='string'&&LESSONS[raw.lastLesson])UI.lastLesson=raw.lastLesson;
  if(raw.reading&&typeof raw.reading==='object')Object.keys(raw.reading).forEach(function(id){
   var position=raw.reading[id];if(!LESSONS[id]||!position||typeof position!=='object')return;
   UI.reading[id]={top:typeof position.top==='number'&&isFinite(position.top)?Math.min(1e7,Math.max(0,position.top)):0,open:Array.isArray(position.open)?position.open.filter(function(index){return typeof index==='number'&&index>=0&&index%1===0&&index<(LESSONS[id].mat||[]).length}):[0]};
  });
  if(raw.drafts&&typeof raw.drafts==='object')Object.keys(raw.drafts).forEach(function(id){
   var draft=raw.drafts[id];if(!LESSONS[id]||!draft||typeof draft!=='object')return;
   UI.drafts[id]={title:typeof draft.title==='string'?draft.title.slice(0,120):'',note:typeof draft.note==='string'?draft.note.slice(0,6000):'',url:typeof draft.url==='string'?draft.url.slice(0,2000):'',goals:Array.isArray(draft.goals)?draft.goals.filter(function(goal){return typeof goal==='string'&&!!SRC[goal]}):[]};
  });
  if(typeof raw.query==='string')UI.query=raw.query.slice(0,200);
  if(raw.week==='projects'||raw.week==='refs'||/^w([1-9]|1[0-2])$/.test(raw.week))UI.week=raw.week;
  if(['all','new','opened','read','done'].indexOf(raw.status)>=0)UI.status=raw.status;
 }catch(error){}
}
var storageWarned=false;
function storageFailed(){
 if(storageWarned)return;storageWarned=true;
 setTimeout(function(){store.emit('storage-full')},0);
}
function persistUI(){try{localStorage.setItem(UI_KEY,JSON.stringify(UI));return true}catch(error){storageFailed();return false}}
function saveUI(){clearTimeout(uiTimer);uiTimer=setTimeout(persistUI,150)}
loadUI();
function syncData(state){
 var src=state||S,out={};
 ['name','theme','skills','checks','days','quiz','co','start','reroll','mil','read','wrong'].forEach(function(k){out[k]=src[k]});
 ['readDone','quizSeen','attempts','evidence','latestQuiz'].forEach(function(key){var value=src[key];if(value&&Object.keys(value).length)out[key]=value});
 return withExtra(src,out);
}
function syncCanonical(value){
 if(Array.isArray(value))return value.map(syncCanonical);
 if(value&&typeof value==='object'){
  var out={},keys=Object.keys(value).sort();
  keys.forEach(function(k){out[k]=syncCanonical(value[k])});
  return out;
 }
 return value;
}
function syncHash(state){
 var text=JSON.stringify(syncCanonical(syncData(state))),h=2166136261;
 for(var i=0;i<text.length;i++){h^=text.charCodeAt(i);h+=(h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)}
 return ('00000000'+(h>>>0).toString(16)).slice(-8);
}
function normalizedState(raw){var out=defaults();normalize(raw,out);return out}
if(!S.pushedHash&&S.pushedRev===S.rev)S.pushedHash=syncHash(S);
var saveTimer=null,pushTimer=null;
function persist(){try{localStorage.setItem(KEY,JSON.stringify(S));return true}catch(e){storageFailed();return false}}
function save(){
 S.rev=(typeof S.rev==='number'?S.rev:0)+1;
 clearTimeout(saveTimer);
 saveTimer=setTimeout(persist,250);
 schedulePush();
}
function schedulePush(){
 if(!lcOK())return;
 if(navigator&&!navigator.onLine)return;
 clearTimeout(pushTimer);
 pushTimer=setTimeout(function(){pushNow(false,true)},5000);
}

/* ---------- Store · 云同步(优先 GitHub Gist,备选 LeanCloud) ---------- */
function lcIsGist(){return !!(S.lc&&S.lc.backend==='gist'&&S.lc.token&&S.lc.gist)}
function lcOK(){return lcIsGist()||!!(S.lc&&S.lc.id&&S.lc.key&&S.lc.host&&S.lc.code)}
function lcBase(){
 var h=S.lc.host.trim();
 if(/^https?:\/\//.test(h))return h.replace(/\/+$/,'')+'/1.1';
 return 'https://'+h.replace(/\/+$/,'')+'/1.1';
}
function lcHeaders(){return {'Content-Type':'application/json','X-LC-Id':S.lc.id,'X-LC-Key':S.lc.key}}
function gistHeaders(){return {'Authorization':'Bearer '+S.lc.token,'Accept':'application/vnd.github+json','Content-Type':'application/json'}}
function gistRead(keepalive){
 return fetch('https://api.github.com/gists/'+S.lc.gist,{headers:gistHeaders(),cache:'no-store',keepalive:!!keepalive})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status+'(检查令牌与 Gist ID)');return r.json()})
  .then(function(g){
   var f=g.files&&g.files['yueqian.json'];
   if(!f||!f.content)return null;
   try{return JSON.parse(f.content)}catch(e){throw new Error('云端数据损坏')}
  });
}
/* keepalive 请求体上限约 64KB,超出时退回普通请求 */
function keepaliveOK(body,keepalive){return !!keepalive&&body.length<60000}
function gistWrite(state,keepalive){
 var body=JSON.stringify({description:'yueqian-progress',files:{'yueqian.json':{content:JSON.stringify(state)}}});
 return fetch('https://api.github.com/gists/'+S.lc.gist,{method:'PATCH',headers:gistHeaders(),body:body,keepalive:keepaliveOK(body,keepalive)})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
}
function remoteFromPayload(payload,objectId){
 var raw;
 try{raw=typeof payload==='string'?JSON.parse(payload):payload}catch(e){throw new Error('云端数据损坏')}
 var parsed=parseBackup(raw),state=parsed.state;
 return {rev:state.rev||0,payload:JSON.stringify(raw),objectId:objectId,hash:syncHash(state)};
}
function lcFind(keepalive){
 if(lcIsGist()){
  return gistRead(keepalive).then(function(st){return st?remoteFromPayload(st,S.lc.gist):null});
 }
 return fetch(lcBase()+'/classes/Progress?where='+encodeURIComponent(JSON.stringify({code:S.lc.code}))+'&limit=1',{headers:lcHeaders(),cache:'no-store',keepalive:!!keepalive})
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status+'(检查 AppID/Key/域名)');return r.json()})
  .then(function(d){var r=(d.results&&d.results[0])||null;return r?remoteFromPayload(r.payload,r.objectId):null});
}
function isVirgin(){
 return !S.name&&S.theme==='auto'&&!S.days.length&&!Object.keys(S.checks).length&&!Object.keys(S.skills).length&&!Object.keys(S.quiz).length&&!S.co.length&&!S.start&&!hasLocalSyncChanges();
}
/* 同步基线:上次成功同步时云端内容的指纹。云端偏离基线且本机也有改动才算冲突,不再比较各端自增的 rev */
function syncBase(){return S.syncBase||S.pushedHash||''}
function hasLocalSyncChanges(){var base=syncBase();return base?syncHash(S)!==base:(S.rev||0)>(S.pushedRev||0)}
function syncDecision(remote){
 if(!remote)return 'push';
 var localHash=syncHash(S);
 if(remote.hash===localHash)return 'same';
 if(isVirgin())return 'adopt';
 var base=syncBase(),remoteChanged=!base||remote.hash!==base,localChanged=hasLocalSyncChanges();
 if(remoteChanged&&localChanged)return 'conflict';
 return remoteChanged?'adopt':'push';
}
function markSynced(hash){S.pushedRev=S.rev||0;S.pushedHash=hash;S.syncBase=hash;S.pushedAt=new Date().toLocaleString('zh-CN');persist();store.emit('sync')}
function syncPayload(){
 var payload=JSON.parse(JSON.stringify(S)),data=syncData(S);
 delete payload.lc;delete payload.extra;delete payload.syncBase;
 Object.keys(data).forEach(function(key){payload[key]=data[key]});
 payload.pushedHash=syncHash(S);
 payload.pushedAt='';
 return JSON.parse(JSON.stringify(payload));
}
/* 同步任务串行执行,避免回到前台、页面隐藏与定时推送同时读写云端 */
var syncChain=Promise.resolve();
function queueSync(task){var run=syncChain.then(task,task);syncChain=run.catch(function(){});return run}
function pushNow(force,silent,keepalive){
 if(!lcOK())return Promise.resolve();
 if(navigator&&!navigator.onLine){if(!silent)notify('当前离线，联网后自动同步。','i-msg');return Promise.resolve()}
 return queueSync(function(){
 if(!lcOK())return;
 return lcFind(keepalive).then(function(remote){
  var lr=S.rev||0;
  var localHash=syncHash(S);
  var decision=force?'push':syncDecision(remote);
  if(decision==='same'){markSynced(localHash);if(!silent)notify('本机已是最新','i-check','green');return}
  if(decision==='adopt'){adoptRemote(remote.payload,silent);return}
  if(decision==='conflict'){store.emit('conflict');return}
  var payloadState=syncPayload();
  payloadState.rev=lr;
  var body=lcIsGist()?null:JSON.stringify({code:S.lc.code,payload:JSON.stringify(payloadState),rev:lr,device:String(navigator.userAgent||'').slice(0,80)});
  var req;
  if(lcIsGist()){req=gistWrite(payloadState,keepalive)}
  else{
   var url=lcBase()+'/classes/Progress'+(remote?'/'+remote.objectId:'');
   req=fetch(url,{method:remote?'PUT':'POST',headers:lcHeaders(),body:body,keepalive:keepaliveOK(body,keepalive)});
  }
  return req.then(function(r){
   if(r&&r.ok===false)throw new Error('HTTP '+r.status);
   return r&&typeof r.json==='function'?r.json():r;
  }).then(function(){
   markSynced(localHash);store.emit('resolved');
   if(!silent)notify('已推送到云端','i-check','green');
  });
 }).catch(function(e){if(e&&e.message&&!(silent&&keepalive))notify('同步失败:'+e.message,'i-msg')});
 });
}
function adoptRemote(payload,silent){
 try{
  var raw=typeof payload==='string'?JSON.parse(payload):payload;
  var next=normalizedState(raw);next.lc=S.lc;
  var hash=syncHash(next);
  next.pushedRev=next.rev||0;next.pushedHash=hash;next.syncBase=hash;next.pushedAt=new Date().toLocaleString('zh-CN');
  S=next;persist();store.emit('resolved');replaceState(next);
  if(!silent)notify('已从云端恢复进度','i-check','green');
 }catch(e){notify('云端数据解析失败','i-msg')}
}
function pullNow(interactive){
 if(!lcOK())return Promise.resolve();
 return queueSync(function(){
 if(!lcOK())return;
 return lcFind().then(function(remote){
  if(!remote){if(interactive){if(isVirgin())notify('云端暂无存档,先完成一项训练再同步','i-msg');else return 'push'}return}
  var decision=syncDecision(remote);
  if(decision==='same'){markSynced(remote.hash);if(interactive)notify('本机已是最新','i-check','green');return}
  if(decision==='adopt'){adoptRemote(remote.payload);return}
  if(decision==='conflict'){store.emit('conflict');return}
  return 'push';
 }).catch(function(e){if(interactive)notify('拉取失败:'+e.message,'i-msg')});
 }).then(function(next){if(next==='push')return pushNow(false,!interactive)});
}

/* ================= 工具 ================= */
function pad(n){return (n<10?'0':'')+n}
function dateStr(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function todayStr(){return dateStr(new Date())}
function dateCn(t){var d=new Date(t+'T12:00:00');return (d.getMonth()+1)+'月'+d.getDate()+'日 周'+'日一二三四五六'.charAt(d.getDay())}
function dayNum(t){return Math.floor(Date.parse(t+'T12:00:00')/864e5)}
function hasDay(t){return S.days.indexOf(t)>=0}
function streakCount(){
 var d=new Date();
 if(!hasDay(dateStr(d)))d.setDate(d.getDate()-1);
 var n=0;while(hasDay(dateStr(d))){n++;d.setDate(d.getDate()-1)}
 return n;
}
function currentWeek(){
 if(!S.start)return null;
 var diff=Math.floor((dayNum(todayStr())-dayNum(S.start))/7)+1;
 return Math.min(12,Math.max(1,diff));
}
function sumLevels(){var s=0;MODS.forEach(function(module){module.nodes.forEach(function(node){s+=Math.min(3,Math.max(0,S.skills[node.id]||0))})});return s}
function modPct(m){var s=0;m.nodes.forEach(function(nd){s+=(S.skills[nd.id]||0)});return Math.round(s/(3*m.nodes.length)*100)}
function taskCounts(){
 var total=0,done=0;
 PHASES.forEach(function(p){p.ws.forEach(function(w){w.tasks.forEach(function(_,i){total++;if(S.checks[w.id+'.'+i])done++})})});
 PROJECTS.forEach(function(p){p.tasks.forEach(function(_,i){total++;if(S.checks[p.id+'.'+i])done++})});
 return {total:total,done:done};
}
function quizAvg(){
 var earned=0,total=0,complete=0;
 Object.keys(QUIZ).forEach(function(module){var questions=QUIZ[module],attempt=S.latestQuiz[module]||S.attempts.filter(function(item){return item.mod===module}).slice(-1)[0];total+=questions.length;if(attempt&&attempt.total===questions.length&&questions.every(function(_,index){return S.quizSeen[module+'.'+index]===true})){earned+=attempt.correct;complete++}});
 return complete?earned/Math.max(1,total)*100:null;
}
function overallPct(){
 var sp=sumLevels()/(3*NN)*100;
 var tc=taskCounts();var tp=tc.total?tc.done/tc.total*100:0;
 var qa=quizAvg()||0;
 return Math.round(sp*0.4+tp*0.4+qa*0.2);
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function icon(id,cls){return '<svg class="ic'+(cls?' '+cls:'')+'" aria-hidden="true"><use href="#'+id+'"/></svg>'}

/* toast */
var toastTimer={};
function toast(msg,ic,cls,btn){
 var box=$('#toasts');
 var el=document.createElement('div');
 el.className='toast'+(cls?' '+cls:'');
 el.innerHTML=icon(ic||'i-msg')+'<span>'+esc(msg)+'</span>';
 if(btn&&btn.t&&typeof btn.fn==='function'){
  var b=document.createElement('button');
  b.className='btn sm';b.textContent=btn.t;b.style.flex='none';
  b.addEventListener('click',function(){btn.fn();el.classList.add('out');setTimeout(function(){el.remove()},320)});
  el.appendChild(b);
 }
 box.appendChild(el);
 var k='t'+Date.now()+Math.random();
 toastTimer[k]=setTimeout(function(){el.classList.add('out');setTimeout(function(){el.remove()},320)},btn?6000:3600);
 while(box.children.length>3)box.firstChild.remove();
}
/* 里程碑 */
function checkMilestones(){
 var queue=[];
 var s=streakCount(),ov=overallPct();
 [['streak',3,'连续打卡 3 天 —— 热身完毕,轨道启动了。','i-flame','orange'],
  ['streak',7,'连续 7 天!这已经不是三分钟热度了。','i-flame','orange'],
  ['streak',14,'连续 14 天,习惯已经长出来了。','i-flame','orange'],
  ['streak',30,'连续 30 天,你已经是自己的教练了。','i-trophy','green'],
  ['progress',25,'综合进度 25%,打底阶段应该快收尾了。','i-zap',''],
  ['progress',50,'赛程过半!作品集和简历该成型了。','i-zap',''],
  ['progress',75,'75% 了,面试冲刺就在眼前。','i-zap','orange'],
  ['progress',100,'100%!轨道跑完,接下来去面试里把它兑现。','i-trophy','green']
 ].forEach(function(m){
  var streak=m[0]==='streak',key=(streak?'d':'p')+m[1];
  if((streak?s:ov)>=m[1]&&!S.mil[key]){S.mil[key]=true;queue.push(m.slice(2))}
 });
 if(queue.length){
  save();
  var last=queue[queue.length-1];
  queue.forEach(function(m,i){setTimeout(function(){toast(m[0],m[1],m[2])},i*900)});
  renderTop();
 }
}
/* 版本更新:只读 version.json(不走缓存)比对版本;发现新版只显示提示条,用户点按后再切换。
   不卸载 Service Worker、不清空缓存;测验作答中不显示提示条,交卷后再显示。 */
var lastUpdChk=0,swReg=null,updateReady=null,updating=false;
function quizInProgress(){return !!(QM.mod||QM.review)&&!QM.finished&&(QM.idx>0||QM.picked!==null)}
function showUpdateBanner(){
 var banner=$('#updateBanner');if(!banner)return;
 banner.hidden=!updateReady||quizInProgress();
}
function fetchRemoteVersion(){
 return fetch('version.json',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
  .then(function(remote){if(!remote||typeof remote.version!=='string')throw new Error('版本信息无效');return remote});
}
function checkUpdate(silent){
 if(navigator&&navigator.onLine===false){if(!silent)toast('当前离线,联网后会自动检查更新。','i-msg');return}
 lastUpdChk=Date.now();
 var ub=$('#updBtn'),oldTxt=ub?ub.textContent:'检查更新';
 if(!silent&&ub){ub.disabled=true;ub.textContent='检查中…'}
 function done(){if(!silent&&ub){ub.disabled=false;ub.textContent=oldTxt}}
 fetchRemoteVersion().then(function(remote){
  done();
  if(remote.version===APP_VERSION){if(!silent)toast('已是最新版本 '+APP_VERSION,'i-check','green');return}
  updateReady=remote;
  if(swReg)swReg.update().catch(function(){});
  showUpdateBanner();
  if(!silent)toast('发现新版本 '+remote.version+(quizInProgress()?'，交卷后再更新。':'，点顶部提示条更新。'),'i-zap');
 }).catch(function(){done();if(!silent)toast('检查更新失败(网络)','i-msg')});
}
function applyUpdate(){
 if(updating)return;
 updating=true;flushExperience();
 var waiting=swReg&&swReg.waiting;
 if(waiting&&navigator.serviceWorker.controller){waiting.postMessage({type:'SKIP_WAITING'});setTimeout(function(){location.reload()},3000)}
 else location.reload();
}
/* 新的 Service Worker 装好后:页面已是新版(联网打开时网络优先)就直接接管,不重载;页面仍是旧版则显示提示条 */
function workerWaiting(worker){
 if(navigator.onLine===false)return;
 fetchRemoteVersion().then(function(remote){
  if(remote.version===APP_VERSION){worker.postMessage({type:'SKIP_WAITING'});return}
  updateReady=remote;showUpdateBanner();
 }).catch(function(){});
}
function watchServiceWorker(){
 if(!('serviceWorker' in navigator)||!/^https?:$/.test(location.protocol))return;
 navigator.serviceWorker.addEventListener('controllerchange',function(){if(updating)location.reload()});
 navigator.serviceWorker.register('sw.js').then(function(reg){
  swReg=reg;
  if(reg.waiting&&navigator.serviceWorker.controller)workerWaiting(reg.waiting);
  reg.addEventListener('updatefound',function(){
   var worker=reg.installing;if(!worker)return;
   worker.addEventListener('statechange',function(){if(worker.state==='installed'&&navigator.serviceWorker.controller)workerWaiting(worker)});
  });
 }).catch(function(){});
}
/* 教练台词 */
function pick(arr,seed){return arr[seed%arr.length]}
var PRAISE=['今日份完成,轨道又往前挪了一点。','这 30 分钟,面试官抢不走。','漂亮,就是这种不起眼的积累最吓人。','记下了。你比昨天的自己多储备了一发弹药。','稳稳的一天。别小看打卡,它筛掉了 90% 的同行。','完成!奖励你自己一句:你正在变成难被替代的人。','又一天,连续记录在涨,焦虑在跌。','好的节奏。跳槽拼的不是爆发,是续航。'];
function coachLine(){
 var w=currentWeek(),tc=taskCounts();
 if(!S.start)return '第一次打卡或勾选任意任务,我就开始为你记周次。今天可以从「今日训练」那道题开始。';
 if(!hasDay(todayStr())&&S.days.length&&dayNum(todayStr())-dayNum(S.days.slice().sort().pop())>=2)
   return '两天没见了——不追进度,先把今天的 30 分钟捡起来,轨道不会跑,我们慢慢追。';
 if(w){
  var flat=[];PHASES.forEach(function(p){p.ws.forEach(function(x){flat.push(x)})});
  var wk=flat[w-1];
  var unchecked=0;wk.tasks.forEach(function(t,i){if(!S.checks[wk.id+'.'+i])unchecked++});
  if(unchecked===0)return '第 '+w+' 周的任务已经全部清空,干净利落。看看「技能树」里还有没有可以推到「能演示」的。';
  return '第 '+w+' 周「'+wk.t+'」还剩 '+unchecked+' 项。先挑最小的一件,开个头比什么都重要。';
 }
 return pick(PRAISE,dayNum(todayStr()));
}
/* typewriter → 平滑淡入 */
var typeTimer=null;
function typeInto(el,text){
 el.textContent=text;
 el.classList.remove('fadein');
 void el.offsetWidth;
 el.classList.add('fadein');
}
function countUp(el,to,suffix){
 el.textContent=String(to)+(suffix||'');
}

/* ================= 主题 ================= */
var mq=window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(){
 var eff=S.theme==='auto'?(mq.matches?'dark':'light'):S.theme;
 document.documentElement.dataset.theme=eff;
 document.documentElement.style.colorScheme=eff;
 var cs=document.querySelector('meta[name="color-scheme"]');if(cs)cs.setAttribute('content',eff);
 var tc=document.querySelector('meta[name="theme-color"]');if(tc)tc.setAttribute('content',eff==='dark'?'#0a0b12':'#f5f7fc');
 var tb=$('#themeBtn');if(tb)tb.innerHTML='<svg class="ic"><use href="#'+(eff==='dark'?'i-sun':'i-moon')+'"/></svg>';
 var tv=$('#meThemeVal');if(tv)tv.textContent=S.theme==='auto'?'跟随系统':(S.theme==='dark'?'深色':'浅色');
 $$('#themeSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-theme-opt')===S.theme)});
}
mq.addEventListener('change',function(){if(S.theme==='auto')applyTheme()});

/* ================= 渲染调度:按区域记脏位,只重绘当前可见的视图 =================
   隐藏视图保留旧 DOM,切换过去时再按脏位重绘;同一事件里多次 invalidate 合并到一次微任务。 */
var REGIONS={
 hero:{view:'ov',render:function(){updateRunway();renderHero()}},
 daily:{view:'daily',render:function(){renderDaily()}},
 skills:{view:'skills',render:function(){renderSkills()}},
 quiz:{view:'quiz',render:function(){renderQuizMods();renderQuizHistory()}},
 learn:{view:'learn',render:function(){renderLearn()}},
 lab:{view:'lab',render:function(){renderLab()}},
 co:{view:'lab',render:function(){renderCo()}},
 evidence:{view:'lab',render:function(){renderEvidenceList()}},
 me:{view:'me',render:function(){renderMe()}},
 plan:{view:'plan',render:function(){renderPlan()}}
};
var REGION_ORDER=Object.keys(REGIONS);
/* 问候语、日期、投递停留天数按当天计算,切到这些视图时总要刷新 */
var REFRESH_ON_SHOW={ov:['hero'],daily:['daily'],lab:['co'],me:['me']};
var DIRTY={},flushQueued=false;
function invalidate(){
 for(var i=0;i<arguments.length;i++)DIRTY[arguments[i]]=true;
 if(!flushQueued){flushQueued=true;Promise.resolve().then(function(){flushQueued=false;renderRegions(curView)})}
}
function renderRegions(view){REGION_ORDER.forEach(function(name){if(DIRTY[name]&&REGIONS[name].view===view){delete DIRTY[name];REGIONS[name].render()}})}
/* 启动时先画可见视图,其余视图逐个放进空闲时间(计划页最后画) */
var idle=window.requestIdleCallback?function(fn){window.requestIdleCallback(fn,{timeout:300})}:function(fn){setTimeout(fn,1)};
function renderRemaining(){
 var name=REGION_ORDER.filter(function(key){return DIRTY[key]})[0];
 if(!name)return;
 delete DIRTY[name];REGIONS[name].render();
 idle(renderRemaining);
}

/* ================= 视图切换 ================= */
var GROUPS={ov:['ov'],train:['daily','skills','quiz'],plan:['plan','learn','lab'],me:['me']};
var GORDER=['ov','train','plan','me'];
var GROUP_CUR=UI.group;
var ORDER=['ov','daily','skills','quiz','plan','learn','lab','me'],curView='ov',scrollMemo=UI.scroll,lastGoV='',lastGoT=0;
var NAV_READY=false,NAV_PENDING=false,NAV_STEP=0;
function writeRoute(replace){
 if(!NAV_READY)return;
 var previous=history.state;
 if(!replace&&previous&&previous.yueqianRoute&&previous.view===curView&&previous.lesson===DRL)return;
 if(!replace)NAV_STEP++;
 try{history[replace?'replaceState':'pushState']({yueqianRoute:1,view:curView,lesson:DRL,step:NAV_STEP},'')}catch(error){}
}
function initNavigation(){
 var route=history.state,view=route&&route.yueqianRoute&&ORDER.indexOf(route.view)>=0?route.view:UI.view;
 if('scrollRestoration' in history)history.scrollRestoration='manual';
 go(view,true,true);
 NAV_STEP=route&&route.yueqianRoute?Number(route.step)||0:0;
 NAV_READY=true;
 var lesson=route&&route.yueqianRoute?route.lesson:null;
 if(lesson&&LESSONS[lesson])openLesson(lesson,true);
 writeRoute(true);
}
window.addEventListener('popstate',function(event){
 NAV_PENDING=false;
 var route=event.state;if(!route||!route.yueqianRoute||ORDER.indexOf(route.view)<0)return;
 closeLesson(true);NAV_STEP=Number(route.step)||0;go(route.view,true,true);
 if(route.lesson&&LESSONS[route.lesson])openLesson(route.lesson,true);
});
function groupOf(v){for(var g in GROUPS){if(GROUPS[g].indexOf(v)>=0)return g}return 'ov'}
function movePill(v){
 var pill=$('#tabPill');if(!pill)return;
 var gi=GORDER.indexOf(groupOf(v));
 if(gi>=0){pill.style.opacity='1';pill.style.transform='translateX('+(gi*100)+'%)'}
 else{pill.style.opacity='0'}
}
function go(v,exact,restoring){
 if(NAV_PENDING&&!restoring)return;
 if(!exact&&GROUPS[v]&&GROUPS[v].length>1){v=GROUP_CUR[v]||GROUPS[v][0]}
 if(ORDER.indexOf(v)<0)return;
 var now=Date.now();
 if(!restoring&&v===lastGoV&&now-lastGoT<80){return}
 lastGoV=v;lastGoT=now;
 if(DRL)closeLesson(true);
 var g=groupOf(v);
 if(GROUPS[g]&&GROUPS[g].length>1)GROUP_CUR[g]=v;
 $$('.nav-btn[data-view]').forEach(function(b){
  var dv=b.getAttribute('data-view');
  var selected=b.closest('.tabbar')?dv===g:dv===v;
  b.classList.toggle('on',selected);
  if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  if(b.closest('.tabbar')){
   var icons={ov:'i-home',train:'i-zap',plan:'i-range',me:'i-user-check'};
   $('use',b).setAttribute('href','#'+icons[dv]+(selected?'-on':''));
  }
 });
 $$('[data-sub]').forEach(function(b){var selected=b.getAttribute('data-sub')===v;b.classList.toggle('on',selected);b.setAttribute('aria-pressed',selected?'true':'false')});
 movePill(v);
 UI.view=v;saveUI();
 if(v===curView){renderRegions(v);if(!restoring)scrollMemo[v]=0;window.scrollTo(0,scrollMemo[v]||0);if(!restoring)writeRoute();return}
 var prev=curView,outEl=$('#view-'+prev),inEl=$('#view-'+v);
 scrollMemo[prev]=window.scrollY;
 curView=v;
 $$('.view').forEach(function(s){if(s!==inEl){s.hidden=true;s.classList.remove('vi-l','vi-r');s.style.transform='';s.style.transition=''}});
 inEl.hidden=false;inEl.style.pointerEvents='';
 window.scrollTo(0,scrollMemo[v]||0);
 if(!REDUCE&&!restoring){
  var dir=ORDER.indexOf(v)>ORDER.indexOf(prev)?1:-1;
  inEl.classList.remove('vi-l','vi-r');void inEl.offsetWidth;inEl.classList.add(dir>0?'vi-r':'vi-l');
  setTimeout(function(){inEl.classList.remove('vi-l','vi-r')},380);
 }
 requestAnimationFrame(dockScroll);
 (REFRESH_ON_SHOW[v]||[]).forEach(function(name){DIRTY[name]=true});
 renderRegions(v);
 if(!restoring)writeRoute();
}
document.addEventListener('keydown',function(e){
 if(DRL)return;
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 var tg=e.target||{},tag=tg.tagName||'';
 if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||tg.isContentEditable)return;
 var i=['1','2','3','4'].indexOf(e.key);
 if(i>=0)go(GORDER[i]);
});
/* ---------- 大标题滚动收起(iOS inline title) ---------- */
var DOCK={ov:'首页',daily:'今日训练',skills:'技能树',quiz:'模块自测',plan:'12 周计划',learn:'学习中心',lab:'求职实战',me:'我的'};
function dockScroll(){
 var dt=$('#dockTitle');if(!dt)return;
 var vis=$('.view:not([hidden])');
 if(!vis){dt.classList.remove('on');return}
 var vid=vis.id.slice(5),label=DOCK[vid],pt=vis.querySelector('.ptitle'),show=pt?(pt.getBoundingClientRect().bottom<12):(window.scrollY>120);
 if(show&&label){if(dt.textContent!==label)dt.textContent=label;dt.classList.add('on')}
 else dt.classList.remove('on');
}
window.addEventListener('scroll',function(){requestAnimationFrame(dockScroll);if(!DRL){scrollMemo[curView]=window.scrollY;saveUI()}},{passive:true});
/* ---------- 触摸手势:内容区左右滑切 Tab(跟手可打断),教材页右滑返回,看板行左滑删除 ---------- */
var SW={mode:null,el:null,body:null,x0:0,y0:0,dx:0,lock:false};
var DR={on:false,closing:false,x0:0,y0:0,dx:0,lock:false};
document.addEventListener('touchstart',function(e){
 SW.mode=null;SW.el=null;SW.body=null;SW.dx=0;SW.lock=false;
 if(e.touches.length!==1)return;
 var t=e.target;
 if($('#drawer').classList.contains('on')){
  if(DR.closing||t.closest('input,textarea,select,.reader-settings,.evidence-goals,.md table,.md pre'))return;
  DR.on=true;DR.x0=e.touches[0].clientX;DR.y0=e.touches[0].clientY;DR.dx=0;DR.lock=false;
  return;
 }
 var ob=$('#onboard');if(ob&&!ob.classList.contains('hidden'))return;
 var row=t.closest('.co-row');
 if(row){SW.mode='row';SW.el=row;SW.body=row.querySelector('.co-body');SW.x0=e.touches[0].clientX;SW.y0=e.touches[0].clientY;return}
 if(t.closest('input,textarea,select,.tabbar,.seg,.heat,label.opt,[data-qmod],.qdots'))return;
 SW.mode='view';SW.el=$('.view:not([hidden])');SW.x0=e.touches[0].clientX;SW.y0=e.touches[0].clientY;
},{passive:true});
document.addEventListener('touchmove',function(e){
 if(DR.on&&e.touches.length===1){
  var rdx=e.touches[0].clientX-DR.x0,rdy=e.touches[0].clientY-DR.y0;
  if(!DR.lock){
   if(Math.abs(rdx)<16&&Math.abs(rdy)<16)return;
   if(Math.abs(rdy)>Math.abs(rdx)*1.3){DR.on=false;return}
   DR.lock=true;
  }
  DR.dx=rdx;
  $('#drawer').style.transition='none';
  $('#drawer').style.transform='translateX('+Math.max(0,rdx)+'px)';
  var dmk=$('#drawerMask');dmk.style.transition='none';dmk.style.opacity=Math.max(0,1-rdx/300);
  return;
 }
 if(!SW.mode||e.touches.length!==1)return;
 var x=e.touches[0].clientX,y=e.touches[0].clientY,dx=x-SW.x0,dy=y-SW.y0;
 if(!SW.lock){
  if(Math.abs(dx)<16&&Math.abs(dy)<16)return;
  if(Math.abs(dy)>Math.abs(dx)*1.3){SW.mode=null;return}
  SW.lock=true;
 }
 SW.dx=dx;
 if(SW.mode==='row'&&SW.body){SW.body.style.transition='none';SW.body.style.transform='translateX('+Math.min(0,dx)+'px)'}
 else if(SW.mode==='view'&&SW.el&&dx!==0){SW.el.style.transition='none';SW.el.style.transform='translateX('+dx+'px)'}
},{passive:true});
function swSnap(m,el,body){
 if(m==='row'&&body){body.style.transition='';body.style.transform='';return}
 if(m==='view'&&el){
  el.style.transition='transform .25s cubic-bezier(.32,.72,.34,1)';el.style.transform='';
  setTimeout(function(){el.style.transition='';el.style.transform=''},280)
 }
}
document.addEventListener('touchend',function(){
 if(DR.on){
  var ddx=DR.dx;DR.on=false;DR.lock=false;
  var d=$('#drawer'),mk=$('#drawerMask');
  if(ddx>90){
   DR.closing=true;
   d.style.transition='transform .3s cubic-bezier(.32,.72,.34,1)';d.style.transform='translateX(105%)';mk.style.transition='';mk.style.opacity='0';
   setTimeout(function(){DR.closing=false;closeLesson();d.style.transition='';d.style.transform='';mk.style.opacity=''},310);
  }else{
   d.style.transition='transform .28s cubic-bezier(.32,.72,.34,1)';d.style.transform='translateX(0)';mk.style.transition='';mk.style.opacity='';
   setTimeout(function(){d.style.transition='';d.style.transform=''},290);
  }
  return;
 }
 if(!SW.mode)return;
 var m=SW.mode,el=SW.el,body=SW.body,dx=SW.dx;
 SW.mode=null;SW.el=null;SW.body=null;
 if(m==='row'&&body){
  swSnap(m,el,body);
  if(dx<-64){var idx=Number(el.getAttribute('data-coidx'));if(!isNaN(idx)&&S.co[idx])delCo(idx)}
  return;
 }
 if(m==='view'&&el){
  swSnap(m,el,body);
  var pi=ORDER.indexOf(curView);
  if(dx<-70&&pi<ORDER.length-1)go(ORDER[pi+1],true);
  else if(dx>70&&pi>0)go(ORDER[pi-1],true);
 }
});
document.addEventListener('touchcancel',function(){
 if(DR.on){
  DR.on=false;DR.lock=false;
  var d=$('#drawer'),mk=$('#drawerMask');
  d.style.transition='transform .28s cubic-bezier(.32,.72,.34,1)';d.style.transform='translateX(0)';mk.style.transition='';mk.style.opacity='';
  setTimeout(function(){d.style.transition='';d.style.transform=''},290);
 }
 if(!SW.mode)return;
 swSnap(SW.mode,SW.el,SW.body);
 SW.mode=null;SW.el=null;SW.body=null;
});

/* ================= 跃迁轨道 ================= */
var RW={
 path:'M 30 138 C 210 132 330 104 440 80 C 550 56 660 34 790 20',
 fr:[0,.25,.5,.75,1],
 labels:['打底','定位与作品','投递面试','Offer 冲刺']
};
function buildRunway(){
 var svg=$('#rwSvg');
 svg.innerHTML='<defs><linearGradient id="rwg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="var(--brand)"/><stop offset="1" stop-color="var(--brand-2)"/></linearGradient></defs>'+
  '<path id="rwBase" d="'+RW.path+'" fill="none" stroke="var(--line-strong)" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 7"/>'+
  '<path id="rwDone" d="'+RW.path+'" fill="none" stroke="url(#rwg)" stroke-width="4" stroke-linecap="round"/>'+
  '<g id="rwPts"></g><g id="rwMrk"></g>';
 var pts=$('#rwPts'),L=0;
 var base=$('#rwBase');L=base.getTotalLength();
 RW.len=L;
 RW.fr.forEach(function(f,i){
  var p=base.getPointAtLength(f*L);
  if(i<RW.labels.length){
   var y=p.y-14;
   pts.innerHTML+='<text class="rw-phase" data-rl="'+i+'" x="'+p.x+'" y="'+y+'" text-anchor="middle">'+RW.labels[i]+'</text>';
  }
  pts.innerHTML+='<circle data-rp="'+i+'" cx="'+p.x+'" cy="'+p.y+'" r="'+(i===0||i===4?6:5)+'" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="2"/>';
 });
 pts.innerHTML+='<text class="rw-flag" x="782" y="8" text-anchor="end">OFFER</text>';
 pts.innerHTML+='<text class="rw-phase" x="30" y="160" text-anchor="start">帆软销售</text>';
 updateRunway();
 var dots=$('#rwDots');dots.innerHTML='';
 PHASES.forEach(function(p,i){
  var done=0,total=0;
  p.ws.forEach(function(w){w.tasks.forEach(function(_,j){total++;if(S.checks[w.id+'.'+j])done++})});
  dots.innerHTML+='<span class="tag'+(total&&done===total?' green':'')+'">'+esc(p.name)+' '+done+'/'+total+'</span>';
 });
}
function updateRunway(){
 var w=currentWeek();
 var f=w?(w-0.5)/12:0;
 f=Math.max(0,Math.min(1,f));
 var done=$('#rwDone'),base=$('#rwBase'),L=RW.len;
 if(!L)L=base.getTotalLength();
 done.setAttribute('stroke-dasharray',(f*L)+' '+L);
 $$('#rwPts [data-rp]').forEach(function(c,i){
  var reached=f>=RW.fr[i]-0.001||i===0;
  c.setAttribute('fill',reached?'var(--brand)':'var(--surface)');
  c.setAttribute('stroke',reached?'var(--brand)':'var(--line-strong)');
 });
 $$('#rwPts .rw-phase').forEach(function(t,i){t.classList.toggle('done',f>=RW.fr[i]-0.001)});
 var mrk=$('#rwMrk');
 var p=base.getPointAtLength(f*L);
 mrk.innerHTML='<circle cx="'+p.x+'" cy="'+p.y+'" r="11" fill="var(--brand-soft)">'+(REDUCE?'':'<animate attributeType="SVG" attributeName="r" values="9;14;9" dur="2.2s" repeatCount="indefinite"/>')+'</circle>'+
  '<circle cx="'+p.x+'" cy="'+p.y+'" r="5.5" fill="var(--orange)" stroke="#fff" stroke-width="2"/>';
 /* 起点标签始终高亮 */
}
function updateMotionPreference(event){REDUCE=event.matches;updateRunway()}
if(motionPreference.addEventListener)motionPreference.addEventListener('change',updateMotionPreference);
else motionPreference.addListener(updateMotionPreference);

/* ================= 总览 ================= */
function renderHero(){
 var h=new Date().getHours();
 var hello=h<5?'夜深了':h<9?'早上好':h<12?'上午好':h<14?'中午好':h<18?'下午好':'晚上好';
 $('#greetLine').innerHTML=hello+(S.name?',<em>'+esc(S.name)+'</em>':',<em>准售前</em>');
 var mn=$('#meName');if(mn)mn.textContent=S.name||'准售前';
 var mvn=$('#meNameVal');if(mvn)mvn.textContent=S.name||'准售前';
 var nud='';
 var stale=staleApplied();
 if(stale.length)nud+='<div class="nudge"><span>'+icon('i-briefcase')+'<b>'+esc(stale[0])+'</b>'+(stale.length>1?' 等 '+stale.length+' 家公司':'')+'投递已超一周,该跟进一轮了。</span><button class="btn sm primary" data-goto="lab">去看板</button></div>';
 var nb=$('#ovNudge');if(nb)nb.innerHTML=nud;
 $('#dateTag').textContent=dateCn(todayStr())+' · 距离 Offer 还有 '+Math.max(0,84-(S.start?(dayNum(todayStr())-dayNum(S.start)):0))+' 天';
 typeInto($('#coachLine'),coachLine());
 var tc=taskCounts();
 countUp($('#stOverall'),overallPct());
 countUp($('#stStreak'),streakCount());
 countUp($('#stTasks'),tc.done);
 $('#stTasksUnit').textContent=' / '+tc.total;
 var qa=quizAvg();
 $('#stQuiz').textContent=qa==null?'—':Math.round(qa)+' 分';
 $('#stQuizSub').textContent='最近完整测验按全部 25 题折算，未测计零';
 var s=streakCount();
 $('#stStreakSub').textContent=s?('连续 '+s+' 天 · 累计 '+S.days.length+' 天'):'去今日训练点亮第一天';
 $('#stOverallSub').textContent='自评 40% + 自记任务 40% + 最近测验 20%，仅记录过程';
 renderCurWeek();renderModBars();renderOvToday();renderStudyHub();renderLearningEvidence();
 renderTop();
}
function suggestedLesson(){
 var week='w'+(currentWeek()||1),entries=LEARN_ENTRIES.filter(function(entry){return entry.week===week&&!S.checks[entry.id]});
 if(!entries.length)entries=LEARN_ENTRIES.filter(function(entry){return SRC[entry.id]&&!S.checks[entry.id]});
 return entries.length?entries[0].id:null;
}
function renderStudyHub(){
 var id=suggestedLesson(),lesson=id?LESSONS[id]:null,last=UI.lastLesson&&LESSONS[UI.lastLesson]?UI.lastLesson:null,due=wrongDue();
 var html='<div class="study-heading"><span class="eyebrow">今天学什么</span><span class="tag brand">第 '+(currentWeek()||1)+' 周</span></div>';
 if(lesson){
  html+='<h3>'+esc(lesson.t)+'</h3><p class="study-description">'+esc(lesson.time||'按自己的节奏学习')+' · '+esc((lesson.why||'完成本周的一项学习目标。').slice(0,86))+'</p><div class="study-actions"><button class="btn primary" data-lesson="'+esc(id)+'">'+icon('i-book')+(S.read[id]?'继续学习':'开始学习')+'</button><button class="btn ghost" data-goto="daily">'+(hasDay(todayStr())?'查看今日训练':'30 分钟微训练')+'</button></div>';
 }else html+='<h3>计划任务已全部完成</h3><p class="study-description">回看学习证据，或重测一个模块，检验现在的掌握情况。</p><div class="study-actions"><button class="btn primary" data-goto="quiz">检验掌握情况</button></div>';
 html+='<div class="study-next"><button '+(last?'data-lesson="'+esc(last)+'"':'data-goto="learn"')+'><b>'+icon('i-book')+'继续上次</b><span>'+(last?esc(LESSONS[last].t):'还没有阅读记录，从学习中心选一篇开始。')+'</span></button><button '+(due?'id="ovReview" data-action="review-due"':'data-goto="quiz"')+'><b>'+icon('i-refresh')+'到期复习'+(due?' · '+due+' 道':'')+'</b><span>'+(due?'先练到期错题，其他错题按计划保留。':'今天没有到期错题，可做一轮模块自测。')+'</span></button></div>';
 html+='<div class="study-library"><button class="btn ghost sm" data-goto="learn">'+icon('i-book')+'学习中心</button><button class="btn ghost sm" data-goto="plan">查看周计划 →</button></div>';
 $('#studyHub').innerHTML=html;
}
function quizQuestion(id){var parts=String(id).split('.'),index=Number(parts[1]);return parts.length===2&&/^\d+$/.test(parts[1])&&QUIZ[parts[0]]&&QUIZ[parts[0]][index]}
function quizCoverage(){
 var total=0;Object.keys(QUIZ).forEach(function(module){total+=QUIZ[module].length});
 var tested=Object.keys(S.quizSeen).filter(function(id){return !!quizQuestion(id)}).length;
 return {tested:tested,total:total};
}
function attemptLabel(attempt){return (attempt.mod==='review'?'错题复习':attempt.mod+' 模块')+' · '+attempt.score+' 分'}
function renderLearningEvidence(){
 var coverage=quizCoverage(),read=Object.keys(S.readDone).length,last=S.attempts[S.attempts.length-1];
 $('#learningEvidence').innerHTML='<div class="study-heading"><span class="eyebrow">学习记录</span><button class="btn ghost sm" data-goto="lab">查看学习证据 →</button></div><div class="evidence-metrics"><div><b>'+read+'<span> / '+LEARN_ENTRIES.length+'</span></b><span>确认读完</span></div><div><b>'+coverage.tested+'<span> / '+coverage.total+'</span></b><span>题目覆盖</span></div><div><b>'+S.evidence.length+'</b><span>学习证据</span></div></div><p class="small muted">'+(last?'最近测验：'+esc(attemptLabel(last))+'。':'还没有本版测验记录。')+'自评与任务用于过程跟踪，结合最近成绩和作品检验掌握情况。</p>';
 renderQuizHistory();
}
function renderQuizHistory(){
 var coverage=quizCoverage(),html='<p class="small muted" style="margin:10px 0">已作答 '+coverage.tested+' / '+coverage.total+' 道题，覆盖率 '+Math.round(coverage.tested/coverage.total*100)+'%。覆盖按实际作答记录，历史最佳成绩继续保留。</p>';
 if(!S.attempts.length)html+='<p class="small muted">完成一轮测验后，这里会保留最近成绩，而不只显示最高分。</p>';
 S.attempts.slice(-6).reverse().forEach(function(attempt){html+='<div class="attempt-row"><span>'+esc(attemptLabel(attempt))+'<br><span class="muted">'+esc(new Date(attempt.at).toLocaleString('zh-CN'))+'</span></span><span class="num">'+attempt.correct+' / '+attempt.total+' 题</span></div>'});
 $('#quizHistory').innerHTML=html;
 $('#quizHistoryTitle').textContent='最近测验 · '+S.attempts.length+' 次记录 · 覆盖 '+coverage.tested+'/'+coverage.total+' 题';
}
function safeEvidenceUrl(value){if(typeof value!=='string')return '';var url=value.trim().slice(0,2000);try{var parsed=new URL(url);return /^https?:$/.test(parsed.protocol)&&!parsed.username&&!parsed.password?url:''}catch(error){return ''}}
function evidenceForTask(id){return S.evidence.filter(function(proof){return proof.goals.indexOf(id)>=0})}
function evidenceEditor(id){
 var existing=S.evidence.filter(function(proof){return proof.lesson===id}).slice(-1)[0],draft=UI.drafts[id]||existing||{title:LESSONS[id].t,note:'',url:'',goals:SRC[id]?[id]:[]};
 var related=[];RELATED_GOALS.forEach(function(group){if(group.indexOf(id)>=0)related=group.filter(function(goal){return goal!==id})});
 var goals=Object.keys(TASK_LABELS);goals.sort(function(first,second){return (first===id?-2:related.indexOf(first)>=0?-1:0)-(second===id?-2:related.indexOf(second)>=0?-1:0)});
 var html='<details class="evidence-editor" id="drEvidence"'+(UI.drafts[id]?' open':'')+'><summary>'+icon('i-clipboard')+(existing?'编辑学习证据':'留下学习证据')+'</summary><p class="small muted">保存和关联不会自动达标。逐项对照完成标志自核后，才会完成相应任务；系统不自动评审内容或核实作品链接。</p>';
 html+='<label class="evidence-field">证据标题<input class="field" id="evidenceTitle" maxlength="120" value="'+esc(draft.title)+'"></label><label class="evidence-field">总结 / 口述提纲<textarea class="field" id="evidenceNote" maxlength="6000" rows="4" placeholder="我学到了什么？能怎样向客户解释？">'+esc(draft.note)+'</textarea></label><label class="evidence-field">作品链接（可选）<input type="url" class="field" id="evidenceUrl" maxlength="2000" placeholder="https://…" value="'+esc(draft.url)+'"></label>';
 html+='<details style="margin-top:12px"><summary style="cursor:pointer;min-height:44px">关联学习目标（可多选）</summary><p class="small muted">'+(related.length?'相近的周计划与大作业已排在前面，请按实际交付选择。':'只勾选这份证据实际支持的目标；也可只保存阅读总结。')+'</p><div class="evidence-goals">';
 goals.forEach(function(goal){html+='<div><label class="form-check"><input type="checkbox" data-evidence-goal="'+esc(goal)+'"'+(draft.goals.indexOf(goal)>=0?' checked':'')+'><span>'+esc(TASK_LABELS[goal])+'</span></label><p class="small muted">'+esc(LESSONS[goal]?LESSONS[goal].out:TASK_LABELS[goal])+'</p><label class="form-check"><input type="checkbox" data-evidence-confirm="'+esc(goal)+'"'+(existing&&!UI.drafts[id]&&(existing.confirmedGoals||[]).indexOf(goal)>=0?' checked':'')+'><span>已对照此项目标的完成标志自核</span></label></div>'});
 return html+'</div></details><p class="small muted" style="margin:8px 0">修改证据内容需重新自核。草稿只存本机，已保存证据随学习进度备份与同步。旧记录不自动推断达标。</p><p id="evidenceError" class="small" style="color:var(--red)" role="status"></p><button class="btn primary" id="evidenceSave" data-action="evidence-save">'+(existing?'更新证据':'保存证据')+'</button></details>';
}
function captureEvidenceDraft(){
 if(!DRL||!$('#evidenceTitle'))return;
 var draft={title:$('#evidenceTitle').value.slice(0,120),note:$('#evidenceNote').value.slice(0,6000),url:$('#evidenceUrl').value.slice(0,2000),goals:$$('[data-evidence-goal]:checked').map(function(input){return input.getAttribute('data-evidence-goal')})};
 var existing=S.evidence.filter(function(proof){return proof.lesson===DRL}).slice(-1)[0],saved=existing?{title:existing.title,note:existing.note,url:existing.url,goals:existing.goals}:{title:LESSONS[DRL].t,note:'',url:'',goals:SRC[DRL]?[DRL]:[]};
 if(JSON.stringify(draft)!==JSON.stringify(saved))UI.drafts[DRL]=draft;else delete UI.drafts[DRL];
}
function saveEvidence(){
 if(!DRL)return;
 var title=$('#evidenceTitle').value.trim()||LESSONS[DRL].t,note=$('#evidenceNote').value.trim(),rawUrl=$('#evidenceUrl').value.trim(),url=safeEvidenceUrl(rawUrl),error=$('#evidenceError');
 if(rawUrl&&!url){error.textContent='请输入完整的 http 或 https 作品链接。';$('#evidenceUrl').focus();return}
 if(!note&&!url){error.textContent='请至少写一段总结或提供一个作品链接。';$('#evidenceNote').focus();return}
 var existing=S.evidence.filter(function(proof){return proof.lesson===DRL}).slice(-1)[0],goals=$$('[data-evidence-goal]:checked').map(function(input){return input.getAttribute('data-evidence-goal')});
 var proof={id:existing?existing.id:'proof-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),lesson:DRL,title:title.slice(0,120),note:note.slice(0,6000),url:url,goals:goals,at:new Date().toISOString()};
 var confirmed=$$('[data-evidence-confirm]:checked').map(function(input){return input.getAttribute('data-evidence-confirm')}).filter(function(goal){return goals.indexOf(goal)>=0}).sort();
 if(confirmed.length)proof.confirmedGoals=confirmed;
 if(existing)S.evidence[S.evidence.indexOf(existing)]=proof;else S.evidence.push(proof);
 S.evidence=S.evidence.slice(-200);delete UI.drafts[DRL];saveUI();error.textContent='';
 setTaskChecks(confirmed,true);
 $('#evidenceSave').textContent='更新证据';
 toast('证据已保存'+(confirmed.length?'，'+confirmed.length+' 项目标已由本人自核。':'，尚未自核达标。'),'i-check','green');
}
function renderEvidenceList(){
 var html='';
 S.evidence.slice().reverse().forEach(function(proof){
  html+='<div class="proof-item"><h4>'+esc(proof.title)+'</h4>'+(proof.note?'<p>'+esc(proof.note)+'</p>':'')+(proof.url?'<a href="'+esc(proof.url)+'" target="_blank" rel="noopener noreferrer">打开作品链接 ↗</a>':'')+'<div class="learn-meta">'+proof.goals.length+' 项关联目标 · '+esc(proof.at?dateCn(dateStr(new Date(proof.at))):'历史记录')+'</div><button class="btn ghost sm" data-lesson="'+esc(proof.lesson)+'">查看与编辑</button></div>';
 });
 $('#evidenceList').innerHTML=html||'<p class="small muted" style="margin-top:12px">在教材里展开「留下学习证据」，保存总结、口述提纲或作品链接。已完成的任务也可以补上证据。</p>';
}
function setTaskChecks(ids,checked){
 ids.forEach(function(id){if(!SRC[id])return;if(checked)S.checks[id]=true;else delete S.checks[id]});
 if(checked&&ids.length&&!S.start){S.start=todayStr();buildRunway()}
 save();refreshProgress();checkMilestones();
}
function refreshProgress(){
 $$('[data-check]').forEach(function(input){input.checked=!!S.checks[input.getAttribute('data-check')]});
 PHASES.forEach(function(phase,index){
  var done=0,total=0;phase.ws.forEach(function(week){var weekDone=0;week.tasks.forEach(function(_,task){total++;if(S.checks[week.id+'.'+task]){done++;weekDone++}});var badge=$('[data-wb="'+week.id+'"]');if(badge)badge.textContent=weekDone+' / '+week.tasks.length});
  var count=$('[data-phase-count="'+index+'"]'),fill=$('[data-phase-fill="'+index+'"]');
  if(count)count.textContent=done+'/'+total;if(fill)fill.style.width=Math.round(done/total*100)+'%';
 });
 PROJECTS.forEach(function(project){var done=0;project.tasks.forEach(function(_,index){if(S.checks[project.id+'.'+index])done++});var badge=$('[data-pb="'+project.id+'"]');if(badge)badge.textContent=done+' / '+project.tasks.length});
 $$('.task-proof').forEach(function(element){var proofs=evidenceForTask(element.getAttribute('data-proof-task'));element.textContent=proofs.length?'关联证据：'+proofs.map(function(proof){return proof.title}).join('、'):''});
 var current='w'+(currentWeek()||0);$$('details.wk').forEach(function(detail){var active=detail.getAttribute('data-wid')===current;detail.classList.toggle('here',active);$('[data-current-week]',detail).hidden=!active});
 invalidate('hero','learn','quiz','evidence');renderReaderFoot();
}
function renderMe(){
 var mn=$('#meName');if(mn)mn.textContent=S.name||'准售前';
 var mvn=$('#meNameVal');if(mvn)mvn.textContent=S.name||'准售前';
 renderTop();renderSyncCard();
}
function renderTop(){
 $('#tbStreakN').textContent=String(streakCount());
}
function renderCurWeek(){
 var el=$('#curWeek');
 if(!S.start){el.innerHTML='<p class="small muted">还没有开始记录 —— 去「今日训练」完成第一次打卡,或在「12 周计划」勾选任意任务,轨道即刻出发。</p>';return}
 var w=currentWeek();
 var flat=[];PHASES.forEach(function(p){p.ws.forEach(function(x){flat.push({w:x,ph:p.name})})});
 var cur=flat[w-1];if(!cur){el.innerHTML='';return}
 var unchecked=[];cur.w.tasks.forEach(function(t,i){if(!S.checks[cur.w.id+'.'+i])unchecked.push(t)});
 var html='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px"><span class="tag brand">第 '+w+' / 12 周</span><b style="font-size:14px">'+esc(cur.w.t)+'</b><span class="small muted">'+esc(cur.ph)+'</span><button class="btn ghost sm" data-goto="plan" style="margin-left:auto">查看计划</button></div>';
 if(unchecked.length){
  html+='<div style="display:flex;flex-direction:column;gap:2px">'+unchecked.slice(0,3).map(function(t){return '<div class="small" style="display:flex;gap:7px;align-items:baseline"><span style="color:var(--brand)">›</span>'+esc(t)+'</div>'}).join('')+'</div>';
  if(unchecked.length>3)html+='<div class="small muted" style="margin-top:6px">还有 '+(unchecked.length-3)+' 项未完成</div>';
 }else html+='<p class="small" style="color:var(--green)">本周任务已全部完成,漂亮。</p>';
 el.innerHTML=html;
}
function renderModBars(){
 $('#modBars').innerHTML=MODS.map(function(m){
  var p=modPct(m);
  return '<div class="bar-row"><span class="bl">'+esc(m.name)+'</span><div class="track"><div class="fill" style="width:'+p+'%"></div></div><span class="pc num">'+p+'%</span></div>';
 }).join('');
}
function renderOvToday(){
 var idx=dailyIdx();
 var item=DAILY[idx];
 $('#ovToday').innerHTML='<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="tag brand">'+esc(item.c)+'</span><span style="flex:1;min-width:200px">'+esc(item.t)+'</span><button class="btn sm primary" data-goto="daily">去打卡</button></div>';
}
function dailyIdx(){
 var t=todayStr();
 if(S.reroll&&typeof S.reroll[t]==='number')return S.reroll[t];
 return ((dayNum(t)%DAILY.length)+DAILY.length)%DAILY.length;
}

/* ================= 今日训练 ================= */
function renderDaily(){
 var item=DAILY[dailyIdx()];
 $('#dailyCat').textContent=item.c;
 $('#dailyTask').textContent=item.t;
 $('#dailyHowBody').textContent=item.m||'';
 $('#dailyHow').hidden=!item.m;
 var done=hasDay(todayStr()),btn=$('#dailyBtn');
 if(done){btn.classList.remove('primary');btn.innerHTML=icon('i-check')+'今日已打卡 · 撤销'}
 else{btn.classList.add('primary');btn.innerHTML=icon('i-check')+'完成今日打卡'}
 $('#dailyNote').textContent='已连续 '+streakCount()+' 天 · 累计 '+S.days.length+' 天';
 var grid='',recent=0;
 for(var i=83;i>=0;i--){
  var d=new Date();d.setDate(d.getDate()-i);
  var dt=dateStr(d),on=hasDay(dt);
  if(on)recent++;
  grid+='<i class="'+(on?'on':'')+(i===0?' today':'')+'" title="'+dt+(on?' · 已打卡':' · 未打卡')+'"></i>';
 }
 $('#heatGrid').innerHTML=grid;
 $('#heatGrid').setAttribute('aria-label','最近 12 周打卡日历,共 '+recent+' 天');
}
function toggleToday(){
 var t=todayStr();
 if(hasDay(t)){
  S.days=S.days.filter(function(x){return x!==t});
  toast('已撤销今日打卡,随时回来。','i-refresh');
  $('#todayFeedback').textContent='';
 }else{
  S.days.push(t);
  if(!S.start)S.start=t;
  var praise=pick(PRAISE,Math.floor(Math.random()*PRAISE.length));
  $('#todayFeedback').textContent='小跃:'+praise;
  toast(praise,'i-flame','orange');
 }
 save();
 renderDaily();refreshProgress();
 if(hasDay(t))checkMilestones();
}

/* ================= 技能树 ================= */
function renderSkills(){
 var html='';
 MODS.forEach(function(m,mi){
  if(mi)html+='<div class="hr"></div>';
  html+='<div class="mod-head" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:'+(mi?'0 0 10px':'0 0 10px')+'">'+
   '<h3 style="display:flex;align-items:center;gap:8px;font-size:15px">'+icon(m.icon)+esc(m.id+' · '+m.name)+'</h3>'+
   '<span class="small muted" data-mq="'+m.id+'">自测未测</span>'+
   '<span class="tag num" data-mb="'+m.id+'" style="margin-left:auto">0%</span></div><div class="skill-grid">';
  m.nodes.forEach(function(nd){
   var lv=S.skills[nd.id]||0;
   var lid=SKILL_LESSON[nd.id];
   html+='<div class="chip-skill lv'+lv+'" data-chip="'+nd.id+'"><button type="button" class="sk-main" data-skill="'+nd.id+'" title="'+esc(nd.d)+'"><span class="nm">'+esc(nd.n)+'</span><span class="lv">'+LVW[lv]+'</span></button>'+
    (lid&&LESSONS[lid]?'<button type="button" class="lesson-btn sk-learn" data-lesson="'+lid+'" aria-label="学习内容:'+esc(nd.n)+'" title="学习内容">'+icon('i-book')+'</button>':'')+
    '</div>';
  });
  html+='<p class="sk-desc small muted" data-sk-desc="'+m.id+'" aria-live="polite"></p></div>';
 });
 $('#skillsWrap').innerHTML=html;
 MODS.forEach(function(m){updateModBadge(m.id)});
}
function updateModBadge(mid){
 var m=MODS.filter(function(x){return x.id===mid})[0];
 var b=$('[data-mb="'+mid+'"]');if(b&&m)b.textContent=modPct(m)+'%';
 var q=$('[data-mq="'+mid+'"]');if(q)q.textContent=S.quiz[mid]!=null?('自测最佳 '+S.quiz[mid]+' 分'):'自测未测';
}
var UP_WORDS={1:'听懂了,不错。',2:'升到「能讲」——找个人讲一遍巩固一下。',3:'「能演示」!这是售前的硬通货。'};
function cycleSkill(id){
 var chip=$('[data-chip="'+id+'"]');
 if(!chip)return;
 var cur=S.skills[id]||0,nv=(cur+1)%4;
 if(nv===0)delete S.skills[id];else S.skills[id]=nv;
 chip.classList.remove('lv0','lv1','lv2','lv3');
 chip.classList.add('lv'+nv,'pop');
 $('.lv',chip).textContent=LVW[nv];
 updateModBadge(id.charAt(0));
 var node=null;MODS.forEach(function(m){m.nodes.forEach(function(nd){if(nd.id===id)node=nd})});
 var desc=$('[data-sk-desc="'+id.charAt(0)+'"]');if(desc&&node){chip.after(desc);desc.textContent='「'+node.n+'」'+LVW[nv]+'：'+node.d}
 if(nv>0)toast(UP_WORDS[nv],nv===3?'i-check':'i-zap',nv===3?'green':'');
 save();
 if(!S.start){S.start=todayStr();buildRunway()}
 invalidate('hero');
 checkMilestones();
 setTimeout(function(){chip.classList.remove('pop')},260);
}

/* ================= 12 周计划 ================= */
function checkboxHtml(id,label){
 var btn=LESSONS[id]?'<button type="button" class="lesson-btn" data-lesson="'+esc(id)+'" aria-label="学习内容:'+esc(label)+'" title="学习内容">'+icon('i-book')+'</button>':'';
 var proofs=evidenceForTask(id);
 return '<div><div class="tsk"><label class="form-check"><input type="checkbox" data-check="'+esc(id)+'"'+(S.checks[id]?' checked':'')+'><span style="font-size:13px">'+esc(label)+'</span></label>'+btn+'</div><div class="task-proof" data-proof-task="'+esc(id)+'">'+(proofs.length?'关联证据：'+esc(proofs.map(function(proof){return proof.title}).join('、')):'')+'</div></div>';
}
function renderPlan(){
 var html='',w=currentWeek();
 PHASES.forEach(function(p,pi){
  var pd=0,pt=0;
  p.ws.forEach(function(x){x.tasks.forEach(function(_,i){pt++;if(S.checks[x.id+'.'+i])pd++})});
  html+='<div class="phase-head"><h3>'+esc(p.name)+'</h3><div class="track"><div class="fill" data-phase-fill="'+pi+'" style="width:'+(pt?Math.round(pd/pt*100):0)+'%"></div></div><span class="small muted num" data-phase-count="'+pi+'">'+pd+'/'+pt+'</span></div>';
  p.ws.forEach(function(wk){
   var done=0;wk.tasks.forEach(function(_,i){if(S.checks[wk.id+'.'+i])done++});
   html+='<details class="wk'+(w&&wk.id==='w'+w?' here':'')+'" data-wid="'+wk.id+'"><summary>'+icon('i-chev','chev')+'<span>第 '+wk.id.slice(1)+' 周 · '+esc(wk.t)+'</span><span class="tag brand" data-current-week="'+wk.id+'"'+(w&&wk.id==='w'+w?'':' hidden')+'>本周</span><span class="tag num" data-wb="'+wk.id+'" style="margin-left:auto">'+done+' / '+wk.tasks.length+'</span></summary><div class="wk-body">';
   wk.tasks.forEach(function(t,i){html+=checkboxHtml(wk.id+'.'+i,t)});
   html+='</div></details>';
  });
 });
 $('#planWrap').innerHTML=html;
}

/* ================= 求职实战 ================= */
function renderLab(){
 var html='';
 PROJECTS.forEach(function(p,pi){
  if(pi)html+='<div class="hr"></div>';
  var done=0;p.tasks.forEach(function(_,i){if(S.checks[p.id+'.'+i])done++});
  html+='<div data-pid="'+p.id+'" style="padding:2px 0 8px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px"><b style="font-size:15px">'+esc(p.name)+'</b><span class="tag num" data-pb="'+p.id+'" style="margin-left:auto">'+done+' / '+p.tasks.length+'</span></div>'+
   '<p class="small muted" style="margin-bottom:6px">'+esc(p.goal)+'</p>'+
   p.tasks.map(function(t,i){return checkboxHtml(p.id+'.'+i,t)}).join('')+'</div>';
 });
 $('#labProjects').innerHTML=html;
 $('#qaGrid').innerHTML=QA.map(function(item,i){
  var pts='<ul>'+item.a.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>';
  return '<div class="flip" data-action="flip" data-qa="'+i+'" tabindex="0" role="button" aria-label="面试题:'+esc(item.q)+',点击翻面看要点"><div class="flip-in">'+
   '<div class="face"><span class="tag">Q'+(i+1)+'</span><div class="q" style="margin-top:8px">'+esc(item.q)+'</div><div class="hint">'+icon('i-chev')+'点击翻面看参考要点</div></div>'+
   '<div class="face back"><div class="q" style="font-size:13px;color:var(--muted)">'+esc(item.q)+'</div>'+pts+
   '<label class="form-check" style="margin-top:auto;padding:2px 0"><input type="checkbox" data-check="qa'+i+'"'+(S.checks['qa'+i]?' checked':'')+'><span class="small">这条我练过了</span></label></div>'+
   '</div></div>';
 }).join('');
 renderCo();
}
function staleApplied(){
 var t=dayNum(todayStr()),out=[];
 S.co.forEach(function(c){if(c.s===1&&c.d&&t-dayNum(c.d)>=8)out.push(c.n)});
 return out;
}
function renderCo(){
 var list=$('#coList');
 if(!S.co.length){
  list.innerHTML='<p class="small muted">还没有公司。第 4-6 周做完赛道调研后,把靠谱的加进来,别只存在备忘录里。</p>';
  $('#coSummary').innerHTML='';return;
 }
 var applied=0,intv=0,offer=0,tc=[0,0,0];
 S.co.forEach(function(c){if(c.s===1)applied++;if(c.s>=2&&c.s<=4)intv++;if(c.s===5)offer++;tc[c.t]++});
 $('#coSummary').innerHTML='<span class="tag">共 '+S.co.length+' 家</span><span class="tag brand">数据智能 '+tc[0]+'</span><span class="tag brand">泛 AI 应用 '+tc[1]+'</span><span class="tag">其他 '+tc[2]+'</span><span class="tag">已投递 '+applied+'</span><span class="tag amber">面试中 '+intv+'</span><span class="tag green">Offer '+offer+'</span>';
 list.innerHTML=S.co.map(function(c,i){
  var opts=STAGES.map(function(st,si){return '<option value="'+si+'"'+(si===c.s?' selected':'')+'>'+st+'</option>'}).join('');
  var topts=TRACKS.map(function(tr,ti){return '<option value="'+ti+'"'+(ti===c.t?' selected':'')+'>'+tr+'</option>'}).join('');
  var stale=(c.s===1&&c.d)?(dayNum(todayStr())-dayNum(c.d)):0;
  return '<div class="co-row" data-coidx="'+i+'"><div class="co-red">删除</div><div class="co-body"><span class="nm">'+esc(c.n)+(stale>=8?'<span class="tag amber" style="margin-left:6px">'+stale+' 天未跟进</span>':'')+'</span><select class="field" data-cot="'+i+'" aria-label="'+esc(c.n)+' 赛道">'+topts+'</select><select class="field" data-co="'+i+'" aria-label="'+esc(c.n)+' 阶段">'+opts+'</select><button class="btn ghost sm" data-codel="'+i+'" aria-label="删除 '+esc(c.n)+'">'+icon('i-trash')+'</button></div></div>';
 }).join('');
}
function delCo(i){
 var removed=S.co.splice(i,1)[0];
 if(!removed)return;
 save();renderCo();
 toast('已删除「'+removed.n+'」','i-trash',null,{t:'撤销',fn:function(){S.co.splice(Math.min(i,S.co.length),0,removed);save();renderCo()}});
}
function addCo(){
 var inp=$('#coInput'),v=(inp.value||'').trim();
 if(!v){toast('先填个公司名吧。','i-msg');return}
 S.co.push({n:v.slice(0,40),s:0,t:Number($('#coTrack').value)||0,d:todayStr()});
 inp.value='';
 save();renderCo();
 toast('已加入看板。调研中 → 已投递,状态你说了算。','i-kanban');
}

/* ================= 模块自测 ================= */
var QM={mod:null,idx:0,picked:null,correct:0,list:null,qids:null,review:false};
function qzList(){return QM.list||QUIZ[QM.mod]}
function wrongDue(){var t=todayStr(),n=0;for(var k in S.wrong){if(quizQuestion(k)&&S.wrong[k].next<=t)n++}return n}
function wrongTotal(){return Object.keys(S.wrong).filter(function(k){return !!quizQuestion(k)}).length}
function recordWrong(qid){
 var w=S.wrong[qid]||{n:0,s:0};
 S.wrong[qid]={n:w.n+1,s:0,next:dateStr(new Date(Date.now()+864e5))};
 save();
}
function recordRight(qid){
 var w=S.wrong[qid];if(!w)return;
 var s=w.s+1;
 if(s>=3){delete S.wrong[qid];toast('这道错题连对 3 次,已掌握,移出错题本。','i-check','green')}
 else S.wrong[qid]={n:w.n,s:s,next:dateStr(new Date(Date.now()+(s>=2?7:3)*864e5))};
 save();
}
function startReview(onlyDue){
 var list=[],qids=[];
 Object.keys(S.wrong).sort(function(first,second){return S.wrong[first].next.localeCompare(S.wrong[second].next)}).forEach(function(k){
  if(onlyDue&&S.wrong[k].next>todayStr())return;
  var p=k.split('.'),q=QUIZ[p[0]]&&QUIZ[p[0]][Number(p[1])];
  if(q){list.push(q);qids.push(k)}
 });
 if(!list.length){toast(onlyDue?'今天没有到期错题。':'错题本是空的,先去测一轮模块。','i-msg');return}
 QM={mod:null,idx:0,picked:null,correct:0,list:list,qids:qids,review:true,dueOnly:!!onlyDue};
 renderQ(false);
}
function renderQuizMods(){
 var due=wrongDue(),tot=wrongTotal();
 var html=MODS.map(function(m){
  var b=S.quiz[m.id],recent=S.latestQuiz[m.id];
  return '<button class="btn sm" data-qmod="'+m.id+'">'+esc(m.id+' · '+m.name)+(b!=null?' · 最佳 '+b+' 分':'')+(recent?' · 最近 '+recent.score+' 分':'')+'</button>';
 }).join('');
 if(tot)html+='<button class="btn sm" id="qReview" data-action="quiz-review" style="background:var(--orange-soft);color:var(--orange)">'+icon('i-refresh')+'错题本 '+tot+' 道'+(due?' · '+due+' 到期':'')+'</button>';
 $('#quizMods').innerHTML=html;
}
function startQuiz(mid){QM={mod:mid,idx:0,picked:null,correct:0,list:null,qids:null,review:false};renderQ(false)}
function renderQ(graded){
 var list=qzList(),q=list[QM.idx],last=QM.idx===list.length-1;
 var dots='';list.forEach(function(_,i){dots+='<i class="'+(i<QM.idx?'on':'')+'"></i>'});
 var html='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="tag brand">'+(QM.review?'错题重练':esc(QM.mod)+' 模块')+'</span><span class="small muted">第 '+(QM.idx+1)+' / '+list.length+' 题</span></div><div class="qdots" style="margin-top:10px">'+dots+'</div>';
 html+='<p style="font-size:17px;font-weight:700;margin:4px 0 6px">'+esc(q.q)+'</p><div>';
 q.o.forEach(function(o,i){
  var cls='opt'+(graded?(i===q.ans?' ok':(i===QM.picked?' no':'')):'');
  html+='<label class="'+cls+'"><input type="radio" name="qopt" value="'+i+'"'+((!graded&&QM.picked===i)?' checked':'')+(graded?' disabled':'')+'><span>'+String.fromCharCode(65+i)+'. '+esc(o)+'</span></label>';
 });
 html+='</div>';
 if(graded){
  var ok=QM.picked===q.ans;
  html+='<p style="margin-top:12px;font-weight:700;color:'+(ok?'var(--green)':'var(--red)')+'">'+(ok?'答对了':'答错了 · 正确答案是 '+String.fromCharCode(65+q.ans))+'</p>';
  html+='<p class="small muted" style="margin-top:2px">'+esc(q.ex)+'</p>';
  html+='<div style="margin-top:14px"><button class="btn primary" id="qNext" data-action="quiz-next">'+(last?'查看成绩':'下一题')+icon('i-chev')+'</button></div>';
 }else{
  html+='<div style="margin-top:14px"><button class="btn primary" id="qConfirm" data-action="quiz-confirm" disabled>确认答案</button></div>';
 }
 $('#quizArea').innerHTML=html;
}
function modNameOf(id){for(var i=0;i<MODS.length;i++){if(MODS[i].id===id)return MODS[i].name}return id}
function finishQuiz(){
 if(QM.finished)return;
 QM.finished=true;
 var questionCount=qzList().length;
 S.attempts.push({mod:QM.review?'review':QM.mod,at:new Date().toISOString(),correct:QM.correct,total:questionCount,score:Math.round(QM.correct/questionCount*100)});
 if(!QM.review)S.latestQuiz[QM.mod]=S.attempts[S.attempts.length-1];
 S.attempts=S.attempts.slice(-100);save();
 if(QM.review){
  var list=qzList(),pct=list.length?Math.round(QM.correct/list.length*100):100,left=wrongDue();
  $('#quizArea').innerHTML='<div style="text-align:center;padding:18px 0">'+
   '<div class="eyebrow" style="margin-bottom:4px">错题重练 · 完成</div>'+
   '<div class="num" style="font-size:40px;font-weight:700;letter-spacing:-0.03em;color:'+(pct>=80?'var(--green)':'var(--ink)')+'">'+pct+'<span class="small muted" style="font-size:15px;font-weight:500"> %</span></div>'+
   '<p class="small muted" style="max-width:380px;margin:6px auto 0">'+(left?('还有 '+left+' 道到期错题。'):'今天的到期错题已处理。')+'其余错题按间隔计划保留，连对 3 次后移出错题本。</p>'+
   '<div style="display:flex;gap:9px;justify-content:center;margin-top:18px;flex-wrap:wrap"><button class="btn" id="qAgain" data-action="quiz-again">再练一轮</button><button class="btn primary" data-goto="skills">回技能树</button></div></div>';
  invalidate('quiz','hero');showUpdateBanner();
  return;
 }
 var score=Math.round(QM.correct/questionCount*100),prev=S.quiz[QM.mod]!=null?S.quiz[QM.mod]:null;
 var best=Math.max(prev==null?0:prev,score);
 var first=prev==null;
 S.quiz[QM.mod]=best;save();
 var msg=score>=80?(first?'首测已达标，再用自己的话讲一遍巩固。':score>prev?'刷新了历史最佳，继续保持。':score===prev?'保持住了最佳成绩。':'本次达标，最近成绩会如实记录。'):'把答错的题对应的技能点讲给空气听一遍，再回来重测。';
 $('#quizArea').innerHTML='<div style="text-align:center;padding:18px 0">'+
  '<div class="eyebrow" style="margin-bottom:4px">'+esc(modNameOf(QM.mod))+' · 成绩</div>'+
  '<div class="num" style="font-size:40px;font-weight:700;letter-spacing:-0.03em;color:'+(score>=80?'var(--green)':'var(--ink)')+'">'+score+'<span class="small muted" style="font-size:15px;font-weight:500"> / 100</span></div>'+
  '<p class="small muted" style="max-width:380px;margin:6px auto 0">'+esc(msg)+(prev!=null&&score<prev?('(历史最佳 '+prev+' 分,这次没破)'):'')+'</p>'+
  '<div style="display:flex;gap:9px;justify-content:center;margin-top:18px;flex-wrap:wrap"><button class="btn" id="qAgain" data-action="quiz-again">再测一次</button><button class="btn primary" data-goto="skills">回技能树</button></div></div>';
 if(score>=80)toast(score+' 分,过线。','i-check','green');
 updateModBadge(QM.mod);invalidate('quiz','hero');showUpdateBanner();
 checkMilestones();
}

/* ================= 设置 ================= */
function downloadJson(filename,data){
 var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
 setTimeout(function(){URL.revokeObjectURL(url)},0);
}
function backupPayload(){
 var data=syncData(S);
 return {format:'yueqian-progress',version:3,exportedAt:new Date().toISOString(),data:data};
}
function doExport(){
 downloadJson('yueqian-progress-'+todayStr()+'.json',backupPayload());
 toast('备份已导出,存好这个文件。','i-download');
}
function parseBackup(raw){
 var data=raw;
 if(raw&&raw.format==='yueqian-progress'){
  if(raw.version&&raw.version>3)throw new Error('备份版本过新,请先更新训练系统。');
  data=raw.data;
 }
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('备份格式不正确。');
 var valid=Array.isArray(data.days)&&data.skills&&typeof data.skills==='object'&&!Array.isArray(data.skills)&&data.checks&&typeof data.checks==='object'&&!Array.isArray(data.checks);
 if(!valid)throw new Error('这不是跃迁计划的完整进度备份。');
 return {raw:data,state:normalizedState(data)};
}
function importSummary(state){
 var done=Object.keys(state.checks).length,skills=Object.keys(state.skills).length,quiz=Object.keys(state.quiz).length;
 return (state.name?('称呼「'+state.name+'」 · '):'')+'已打卡 '+state.days.length+' 天 · 完成任务 '+done+' 项 · 已练技能 '+skills+' 项 · 已测模块 '+quiz+' 个。导入后会保留本机同步配置,并把恢复的数据标记为待同步。';
}
var pendingImport=null;
function closeImportPreview(){pendingImport=null;$('#importPreview').classList.add('hidden')}
function confirmImport(){
 if(!pendingImport)return;
 var backup=backupPayload();
 try{localStorage.setItem(KEY+'.pre-import',JSON.stringify(backup))}catch(e){}
 downloadJson('yueqian-before-import-'+todayStr()+'.json',backup);
 var oldLc=S.lc,oldRev=Number(S.rev)||0,oldBase=syncBase(),next=pendingImport.state;
 next.lc=oldLc;next.rev=Math.max(oldRev,Number(next.rev)||0);next.pushedRev=0;next.pushedHash='';next.pushedAt='';next.syncBase=oldBase;
 S=next;save();
 var stored=persist();
 if(stored){try{localStorage.removeItem(KEY+'.pre-import')}catch(e){}}
 replaceState(next);closeImportPreview();
 if(stored)toast('已先下载当前进度备份，恢复完成。','i-check','green');
}
function doImport(file){
 var rd=new FileReader();
 rd.onload=function(){
  try{
   var parsed=parseBackup(JSON.parse(rd.result));
   pendingImport=parsed;$('#importPreviewBody').textContent=importSummary(parsed.state);$('#importPreview').classList.remove('hidden');
  }catch(e){toast(e&&e.message?e.message:'这个文件读不出来,确认是导出的 JSON 备份。','i-msg')}
 };
 rd.readAsText(file);
}

/* ================= 事件:data-action 分发表 =================
   带 data-action 的控件按名称分发;data-view / data-lesson 等带参数的控件以属性名作为动作名,参数从属性读取。 */
function toggleReaderSettings(){
 var settings=$('#readerSettings'),show=settings.classList.contains('hidden');
 settings.classList.toggle('hidden',!show);$('#readerSettingsToggle').setAttribute('aria-expanded',show?'true':'false');
}
function stepReaderFont(button){captureReading();UI.font=Math.max(15,Math.min(24,UI.font+Number(button.getAttribute('data-font-step'))));applyReaderSettings();saveUI()}
function clearLearnFilters(){$('#learnSearch').value='';$('#learnWeek').value='all';$('#learnState').value='all';saveLearnFilters();renderLearn()}
function confirmAnswer(){
 if(QM.picked!==null||QM.finished)return;
 var sel=$('input[name="qopt"]:checked');
 if(!sel)return;
 QM.picked=Number(sel.value);
 var qz=qzList(),q=qz[QM.idx],qid=QM.qids?QM.qids[QM.idx]:(QM.mod+'.'+QM.idx);
 S.quizSeen[qid]=true;
 if(QM.picked===q.ans){QM.correct++;recordRight(qid)}else{recordWrong(qid)}
 save();renderQ(true);invalidate('hero','quiz');showUpdateBanner();
}
function nextQuestion(){
 if(QM.picked===null||QM.finished)return;
 QM.idx++;
 if(QM.idx>=qzList().length)finishQuiz();else{QM.picked=null;renderQ(false)}
}
function rerollDaily(){
 var cur=dailyIdx(),nv=cur;
 while(nv===cur)nv=Math.floor(Math.random()*DAILY.length);
 S.reroll[todayStr()]=nv;save();renderDaily();invalidate('hero');
 toast('换了一道,今天的任务以这道为准。','i-shuffle');
}
function saveName(){
 var v=$('#nameInput').value.trim();
 S.name=v.slice(0,12);save();invalidate('hero','me');
 toast(v?('好的,'+v+',就这么叫了。'):'行,继续当神秘人。','i-msg');
}
function resetAll(rb){
 if(rb.getAttribute('data-armed')==='1'){
  /* 保留同步配置与基线:重置后的状态视为本机有意的新状态,云端未变时直接推送,云端另有修改时走冲突选择 */
  var keep={lc:S.lc,rev:S.rev,pushedRev:S.pushedRev,pushedHash:S.pushedHash,pushedAt:S.pushedAt,syncBase:syncBase()},next=defaults();
  Object.keys(keep).forEach(function(key){next[key]=keep[key]});
  UI=uiDefaults();GROUP_CUR=UI.group;scrollMemo=UI.scroll;saveUI();
  S=next;save();
  $('#learnSearch').value='';$('#learnWeek').value='all';$('#learnState').value='all';
  replaceState(next);
  rb.removeAttribute('data-armed');rb.innerHTML=icon('i-refresh')+'重置全部进度';
  toast(lcOK()?'已全部重置。同步设置已保留，云端会更新为重置后的进度；如云端另有新修改，会先请你选择。':'已全部重置，轨道回到起点。','i-refresh');
 }else{
  rb.setAttribute('data-armed','1');rb.textContent=lcOK()?'再点一次，确认清空（云端也会同步清空）':'再点一次，确认清空所有进度';
  setTimeout(function(){if(rb.getAttribute('data-armed')==='1'){rb.removeAttribute('data-armed');rb.innerHTML=icon('i-refresh')+'重置全部进度'}},3500);
 }
}
var ACTIONS={
 'import-cancel':closeImportPreview,
 'import-confirm':confirmImport,
 'flip':function(card,e){if(!e.target.closest('input,label'))card.classList.toggle('on')},
 'view':function(button){go(button.getAttribute('data-view'),!button.closest('.tabbar'))},
 'sub':function(button){go(button.getAttribute('data-sub'),true)},
 'lesson':function(button){openLesson(button.getAttribute('data-lesson'),false,button)},
 'reader-close':function(){closeLesson()},
 'reader-read':markReadDone,
 'reader-done':markLessonDone,
 'reader-settings':toggleReaderSettings,
 'font-step':stepReaderFont,
 'evidence-save':saveEvidence,
 'learn-clear':clearLearnFilters,
 'goto':function(button){go(button.getAttribute('data-goto'),true)},
 'skill':function(button){cycleSkill(button.getAttribute('data-skill'))},
 'qmod':function(button){startQuiz(button.getAttribute('data-qmod'))},
 'quiz-confirm':confirmAnswer,
 'quiz-next':nextQuestion,
 'quiz-again':function(){if(QM.review)startReview(QM.dueOnly);else startQuiz(QM.mod)},
 'quiz-review':function(){startReview()},
 'review-due':function(){go('quiz',true);startReview(true)},
 'daily-toggle':toggleToday,
 'daily-reroll':rerollDaily,
 'co-add':addCo,
 'codel':function(button){delCo(Number(button.getAttribute('data-codel')))},
 'update-check':function(){checkUpdate(false)},
 'update-apply':applyUpdate,
 'export':doExport,
 'import':function(){$('#importFile').click()},
 'name-save':saveName,
 'reset':resetAll,
 'theme-opt':function(button){S.theme=button.getAttribute('data-theme-opt');save();applyTheme()},
 'sync-save':saveSyncConfig,
 'sync-now':syncNow,
 'sync-off':disconnectSync,
 'sync-keep-local':keepLocal,
 'sync-keep-cloud':keepCloud,
 'onboard-start':startOnboard
};
var PARAM_ACTIONS=['view','sub','lesson','goto','skill','qmod','font-step','codel','theme-opt'];
var ACTION_SELECTOR='[data-action],'+PARAM_ACTIONS.map(function(name){return '[data-'+name+']'}).join(',');
document.addEventListener('click',function(e){
 var target=e.target&&e.target.closest?e.target.closest(ACTION_SELECTOR):null;
 if(!target)return;
 var name=target.getAttribute('data-action');
 if(!name)for(var i=0;i<PARAM_ACTIONS.length;i++){if(target.hasAttribute('data-'+PARAM_ACTIONS[i])){name=PARAM_ACTIONS[i];break}}
 var handler=ACTIONS[name];
 if(handler)handler(target,e);
});
document.addEventListener('change',function(e){
 var el=e.target;
 if(el.id==='learnWeek'||el.id==='learnState'){saveLearnFilters();renderLearn();return}
 if(el.id==='readerLine'){captureReading();UI.line=Number(el.value);applyReaderSettings();saveUI();return}
 if(el.matches&&el.matches('[data-evidence-goal]')){captureEvidenceDraft();saveUI();return}
 if(el.name==='qopt'){var b=$('#qConfirm');if(b)b.disabled=false;return}
 if(el.matches&&el.matches('[data-cot]')){var jt=Number(el.getAttribute('data-cot'));if(S.co[jt]){S.co[jt].t=Number(el.value);save();renderCo()}return}
 if(el.matches&&el.matches('[data-co]')){var i2=Number(el.getAttribute('data-co'));if(S.co[i2]){S.co[i2].s=Number(el.value);S.co[i2].d=todayStr();save();renderCo()}return}
 if(el.matches&&el.matches('[data-check]')){
  var id=el.getAttribute('data-check');
  if(el.checked){S.checks[id]=true;if(!S.start){S.start=todayStr();buildRunway()}}
  else delete S.checks[id];
  save();refreshProgress();
  checkMilestones();
 }
});
document.addEventListener('keydown',function(e){
 if(DRL&&e.key==='Tab'){
  var focusable=$$('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex]:not([tabindex="-1"])', $('#drawer')).filter(function(element){return element.tabIndex>=0&&element.getClientRects().length>0&&getComputedStyle(element).visibility==='visible'&&!element.closest('[hidden],[inert]')});
  var first=focusable[0],last=focusable[focusable.length-1];
  if(!first){e.preventDefault();return}
  if(e.shiftKey&&(document.activeElement===first||focusable.indexOf(document.activeElement)<0)){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&(document.activeElement===last||focusable.indexOf(document.activeElement)<0)){e.preventDefault();first.focus()}
 }
 if(e.key==='Enter'&&e.target&&e.target.id==='coInput'){e.preventDefault();addCo()}
 if(e.key==='Enter'&&e.target&&e.target.classList&&e.target.classList.contains('flip')){e.target.classList.toggle('on')}
 if(e.key==='Enter'&&e.target&&e.target.id==='obName'){e.preventDefault();startOnboard()}
 if(e.key==='Escape')closeLesson();
});
$('#importFile').addEventListener('change',function(){if(this.files&&this.files[0])doImport(this.files[0]);this.value=''});
$('#drBody').addEventListener('scroll',captureReading,{passive:true});
$('#drBody').addEventListener('toggle',captureReading,true);
$('#drBody').addEventListener('input',function(event){if(!event.target.matches('[data-evidence-confirm]'))$$('[data-evidence-confirm]').forEach(function(input){input.checked=false});captureEvidenceDraft();saveUI()});
function flushExperience(){captureReading();UI.view=curView;UI.scroll=scrollMemo;UI.group=GROUP_CUR;clearTimeout(uiTimer);clearTimeout(saveTimer);persistUI();persist()}
window.addEventListener('pagehide',flushExperience);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flushExperience()});

function showConflict(){var el=$('#lcConflict');if(el)el.classList.remove('hidden');toast('检测到云端与本机都有新修改,去「设置 → 同步」选择保留哪边','i-msg')}
function hideConflict(){var el=$('#lcConflict');if(el)el.classList.add('hidden')}
function renderSyncCard(){
 if(!$('#lcToken'))return;
 var sv=$('#meSyncVal');if(sv)sv.textContent=(!S.lc||(!S.lc.token&&!S.lc.id))?'未配置':(lcIsGist()?'Gist 已连接':'LeanCloud');
 var set=function(id,v){var el=$(id);if(el&&document.activeElement!==el&&v)el.value=v};
 set('#lcToken',(S.lc&&S.lc.token)||'');set('#lcGist',(S.lc&&S.lc.gist)||'');
 set('#lcId',(S.lc&&S.lc.id)||'');set('#lcKey',(S.lc&&S.lc.key)||'');set('#lcHost',(S.lc&&S.lc.host)||'');set('#lcCode',(S.lc&&S.lc.code)||'');
 var st=$('#lcStatus');if(!st)return;
 if(!S.lc||(!S.lc.token&&!S.lc.id)){st.textContent='未配置。';hideConflict();return}
 if(!lcOK()){st.textContent='配置不完整:Gist 需要令牌和 Gist ID 两项。';return}
 st.textContent=(lcIsGist()?('Gist '+S.lc.gist.slice(0,8)+'…'):('同步码 '+S.lc.code))+' · 本机版本 v'+(S.rev||0)+' · '+(hasLocalSyncChanges()?'有改动待推送':('已同步'+(S.pushedAt?(' · '+S.pushedAt):'')));
}
function saveSyncConfig(){
 var tok=$('#lcToken').value.trim(),gid=$('#lcGist').value.trim();
 if(tok&&gid){
  S.lc={backend:'gist',token:tok.slice(0,200),gist:gid.replace(/^.*\//,'').slice(0,80)};
 }else{
  S.lc={id:$('#lcId').value.trim().slice(0,160),key:$('#lcKey').value.trim().slice(0,160),host:$('#lcHost').value.trim().slice(0,160),code:$('#lcCode').value.trim().toUpperCase().slice(0,8)};
 }
 persist();renderSyncCard();
 if(lcOK()){toast('配置已保存,正在连接...','i-check');pullNow(false);schedulePush()}
 else toast('还没填全(令牌 + Gist ID,或 LeanCloud 四项)','i-msg');
}
function syncNow(){if(!lcOK()){toast('先填好并保存同步配置','i-msg');return}pullNow(true)}
function disconnectSync(b){
 if(b.getAttribute('data-armed')==='1'){
  b.removeAttribute('data-armed');b.textContent='断开';
  S.lc=null;persist();['#lcToken','#lcGist','#lcId','#lcKey','#lcHost','#lcCode'].forEach(function(s){var el=$(s);if(el)el.value=''});renderSyncCard();toast('已断开同步(本机数据保留)','i-check');
 }else{
  b.setAttribute('data-armed','1');b.textContent='再点一次确认断开';
  setTimeout(function(){if(b.getAttribute('data-armed')==='1'){b.removeAttribute('data-armed');b.textContent='断开'}},3000);
 }
}
function keepLocal(){hideConflict();pushNow(true,false)}
function keepCloud(){lcFind().then(function(r){if(r)adoptRemote(r.payload)}).catch(function(e){toast('拉取失败:'+e.message,'i-msg')})}
window.addEventListener('online',function(){if(lcOK())schedulePush()});
function pushOnLeave(){if(lcOK()&&hasLocalSyncChanges()){clearTimeout(pushTimer);pushNow(false,true,true)}}
window.addEventListener('pagehide',pushOnLeave);
document.addEventListener('visibilitychange',function(){
 if(document.visibilityState==='hidden')pushOnLeave();
 if(document.visibilityState==='visible'&&Date.now()-lastUpdChk>300000){lastUpdChk=Date.now();checkUpdate(true)}
});

/* onboarding */
function startOnboard(){
 var v=$('#obName').value.trim();
 S.name=v.slice(0,12);save();
 $('#onboard').classList.add('hidden');
 invalidate('hero','me');
 toast((v?v+',':'')+'轨道点火,第 1 周从「大模型通识入门」开始。','i-rocket');
}

/* ================= 启动 ================= */
function renderAll(){
 REGION_ORDER.forEach(function(name){DIRTY[name]=true});
 renderRegions(curView);
 if(DRL)openLesson(DRL,true);
}
/* 界面订阅 Store 事件 */
store.on('notice',function(note){toast(note.msg,note.ic,note.cls,note.btn)});
store.on('storage-full',function(){try{toast('本机存储空间已满，最近的修改可能未保存。请先导出备份或开启云同步。','i-msg','orange',{t:'导出备份',fn:function(){doExport()}})}catch(e){}});
store.on('sync',renderSyncCard);
store.on('conflict',showConflict);
store.on('resolved',hideConflict);
store.on('replace',function(){applyTheme();buildRunway();renderAll();renderSyncCard();if(S.name)$('#onboard').classList.add('hidden')});
var weekOptions='<option value="all">全部周次</option>';
for(var weekNumber=1;weekNumber<=12;weekNumber++)weekOptions+='<option value="w'+weekNumber+'">第 '+weekNumber+' 周</option>';
$('#learnWeek').innerHTML=weekOptions+'<option value="projects">求职大作业</option><option value="refs">跨周参考</option>';
$('#learnSearch').value=UI.query;$('#learnWeek').value=UI.week;$('#learnState').value=UI.status;
function saveLearnFilters(){UI.query=$('#learnSearch').value.slice(0,200);UI.week=$('#learnWeek').value;UI.status=$('#learnState').value;saveUI()}
applyTheme();
buildRunway();
REGION_ORDER.forEach(function(name){DIRTY[name]=true});
(function(){var av=$('#appVer');if(av)av.textContent=APP_VERSION;var vv=$('#meVerVal');if(vv)vv.textContent='v'+APP_VERSION})();
(function(){var timer=null;$('#learnSearch').addEventListener('input',function(){saveLearnFilters();clearTimeout(timer);timer=setTimeout(renderLearn,120)})})();
/* 「我的」页手风琴:展开一项收起其他 */
$$('.me-item').forEach(function(d){d.addEventListener('toggle',function(){if(d.open)$$('.me-item').forEach(function(o){if(o!==d)o.open=false})})});
/* ---------- 版本更新日志(最新一期展开,更早版本折叠) ---------- */
var CHANGELOG=[
 {v:'1.15.0',d:'10-31',items:['课程内容拆成单独的数据文件，与应用外壳一起离线缓存；首次打开只下载应用本身，原文与配图在第一次打开原文页时再缓存','发现新版本时顶部显示「有新版本，点此更新」，点按后切换；不再清空缓存，测验作答中不显示提示，交卷后再提示','弱网下打开：3 秒内没有网络响应就先显示本机缓存的版本','勾选任务、切换技能等操作只重绘当前页面，其他页面切换过去时再更新']},
 {v:'1.14.1',d:'10-30',items:['原文搜索改用随资料发布的官方来源索引：联网时按内容哈希更新，校验通过才替换，离线也能搜索；不再默认连接 workers.dev 检索服务','云同步改按上次同步的云端指纹判断冲突，两台设备离线各自修改后不再静默覆盖；新版本写入的未知字段会原样保留','重置进度保留同步设置，并作为本机新状态推送；云端另有修改时先让你选择','修复 12 周计划每周都显示「本周」、综合进度 25% 里程碑误判、凌晨证据日期早一天、错题本计数与可练题数不一致、非 5 题测验分数错误','教材列表合并为同一列表；技能树点按后在下方显示说明；提示改到底部并可被读屏朗读；存储写满时提醒导出或同步','原文页离线不再显示英文报错，服务连接移到正文下方的高级设置']},
 {v:'1.14.0',d:'10-28',items:['Web 与原生共用已审核资料发布清单，按哈希复用原文原图，只下载变化文件，完整校验后切换版本','原文资料库支持中英文主题搜索，可连接官方来源检索服务；外部候选标记未审核并保留原文片段与来源详情','新增独立服务连接设置，断网继续阅读已保存图文；保留原有课程、任务 ID 和学习进度']},
 {v:'1.13.0',d:'10-28',items:['接入 Microsoft 开源课程的 10 篇中文原文与 49 张原图，保留原始正文、来源、英文原文、版本和 MIT 授权','学习中心及相关课程提供原文入口，支持全文搜索、图片离线放大和深色阅读','支持手动更新与前台每日检查；原文原图完整下载并校验后替换缓存，失败时保留已有资料；原学习记录独立保留']},
 {v:'1.12.0',d:'10-27',items:['补齐技术选型决策表、结构化输出和双图多模态练习','新增贯通调研、范围、测试、成本、上线回滚和交接的虚构 POC 交付包','扩充制造、金融运营、零售、医药材料四行业全过程案例，附数据、SQL、预期结果与失败诊断','补充 RAG 冲突评测、复杂问数口径与权限验收；原有主题与进度 ID 保留']},
 {v:'1.11.0',d:'10-27',items:['过程进度改按最近完整测验与全题库计算，未测模块计零，历史最佳仅供回看','证据保存和关联不自动达标，需逐项目标对照完成标志自核；编辑内容后重新核对','校订大模型、RAG、微调、NL2SQL、部署安全与指标口径的关键边界']},
 {v:'1.10.1',d:'10-26',items:['降低透明度时底栏、侧栏与悬浮层使用实色背景并关闭模糊，避免后续样式覆盖系统偏好','减少动态效果时停用 CSS 动画及轨道圆点呼吸，系统设置变化后即时生效','教材打开后聚焦返回按钮并限制键盘焦点；关闭后从访问性树移除，入口重绘后仍能返回对应学习按钮','主按钮使用独立深蓝底色，深浅色及悬停状态均保持白字对比度；任务勾选行保留至少 44×44px 命中区域']},
 {v:'1.10.0',d:'10-26',items:['首页优先呈现今天学什么、继续上次与到期复习，保留四个主导航并记忆各区状态','教材接入浏览器前进与返回，保存章节展开、滚动位置、字号与行距；阅读区采用稳定实色背景','区分已打开、已读完与任务完成，旧版已读标记保留为已打开，不推断已经读完','学习中心支持材料全文搜索、命中摘要与高亮，以及周次和学习状态筛选','增加最近测验记录、实际题目覆盖率和总结、口述提纲、作品链接等学习证据','一份证据可关联多个学习目标；勾选、教材完成与证据提交统一刷新周次、阶段、作品和综合进度','保留同步冲突识别和凭据隔离；新增学习数据纳入同步及第 3 版备份，兼容旧版备份']},
 {v:'1.9.5',d:'10-26',items:['修复 Gist 推送成功后仍报 r.json 错误,同步版本和状态会正确更新','同步改用内容指纹与共同基线识别同版本分叉,两端同时修改时显示冲突选择','导出默认只包含学习数据并剥离同步凭据;导入增加格式校验、恢复预览和恢复前备份','Service Worker 与更新检查只清理跃迁计划自身缓存,不影响同源其他 App']},
 {v:'1.9.4',d:'10-26',items:['全局规格收敛:卡片内边距统一为 20/22(跃迁轨道卡、今日训练卡不再各自为政;统计卡保留紧凑规格)','触控目标提升到 iOS 44px 标准:标准/小号按钮、图标按钮加高,分段器扩大命中区而外观不变','三套折叠控件(我的/周计划/教材)统一为同一套参数:13/16 内边距、15px 标题、44px 行高','字号归并到标准层级,清理 10.5/12.5/13.5/14.5/15.5/16.5 等历史微差','小节标题间距收成两档(块级 10px、紧贴说明 4px)','补上自测缺失的样式:选项行此前是无样式的裸单选(现 44px 行高、答对绿/答错红反馈),进度圆点此前完全不可见(现可见)']},
 {v:'1.9.3',d:'10-26',items:['统一各页大标题规格:首页问候语从 21px 提到与其他页一致的 23px/700,「我的」页补上标准大标题,切换页签时标题位置与高度不再跳动','首页打卡提醒横幅移到问候语下方,标题位置恒定不再被横幅推挤','学习中心分段器与标题的间距对齐其他页(12px→16px)']},
 {v:'1.9.2',d:'10-25',items:['教材学习页返回交互重做:返回按钮移到左上角(iOS 惯例),替换原右上角关闭箭头','新增教材页跟手右滑返回:页面跟着手指移动,滑过阈值滑出,不够则回弹;顶部遮罩随滑动变淡','教材页纵向滚动与返回手势互不干扰,向下滚列表不会误触返回']},
 {v:'1.9.1',d:'10-25',items:['页面内滑动返回:左右滑动现在在组内子页间往返(今日↔技能树↔自测、周计划↔学习中心↔实战),滑到组边缘自然跨入相邻 Tab','修复访问过学习中心/实战后,分段器或「查看计划」按钮可能停留在原页的问题','修复滑动被 iOS 系统边缘手势打断时页面卡在偏移位置、不回弹的问题','修复 Toast 悬浮期间挡住顶部按钮点击的问题(撤销按钮仍可点)']},
 {v:'1.9.0',d:'10-25',items:['内容区左右滑动切换 Tab:页面跟手移动、松手回弹或切换,可随时打断','看板公司行左滑删除,误删可一键撤销(Toast 撤销按钮)','学习中心新增搜索:按主题/材料名/正文关键词过滤 113 份材料','大标题滚动收起:滚过标题后顶部浮现玻璃小标题(iOS inline title)','Tab 选中图标切换为填充变体,按下有按压反馈','细节五连修:防双击缩放、教材按钮放大到 44px、日期中文化(10月25日 周六)、检查更新显示进行中、辅助功能「降低透明度」时玻璃自动变不透明']},
 {v:'1.8.1',d:'10-25',items:['投递跟进提醒:「已投递」超一周的公司在首页提醒,看板内标注停留天数','修复离线时「检查更新」误报最新版本的问题']},
 {v:'1.8.0',d:'10-25',items:['新增错题本与间隔复习:答错自动收录,连对 3 次视为掌握,到期首页提醒','学习材料已读标记:点开即记,学习中心显示已读进度','首页新增打卡提醒与错题到期横幅','打卡热力图扩展为 12 周日历','抽屉/弹窗/提示玻璃统一为 4px 轻磨砂','电脑端按 1-4 数字键快速切页']},
 {v:'1.7.5',d:'10-25',items:['重修切页过渡:移除冻结快照机制,旧页立即退场、新页实体滑入,彻底消除上页残留','移除顶部状态栏护罩实色带,内容像原生 App 一样自然延伸到状态栏下方']},
 {v:'1.7.4',d:'10-25',items:['切页改为不透明滑入过渡,消除文字图像残影与顶部渐隐遮罩','Tab 栏磨砂降至 4px','分段引导切换器去灰底:透明轨道+描边+品牌色选中']},
 {v:'1.7.3',d:'10-25',items:['Tab 栏加回 6px 轻磨砂,平衡穿透感与可读性','玻璃光感重做:光源式径向光泽、更亮的顶缘光边与药丸高光']},
 {v:'1.7.2',d:'10-25',items:['Tab 栏彻底去磨砂:不再模糊,只保留玻璃折射、描边与药丸','底色再降至浅 16%/深 10%,近乎全透']},
 {v:'1.7.1',d:'10-25',items:['底色加入品牌色系:浅色改为冷雾蓝 #f5f7fc,与品牌蓝同谱系','深色模式改为深空蓝黑 #0a0b12,层次感更好','启动画面底色同步更新']},
 {v:'1.7.0',d:'10-25',items:['「我的」页重构为二级菜单:称呼/外观/同步/数据/关于收纳为列表,点击展开','更新日志默认只显示最新一期,更早版本折叠','浅色模式背景改纯白,顶部与卡片同色,消除灰色蒙层观感','Tab 栏透明度再降:模糊 10px,近乎只剩边缘与药丸']},
 {v:'1.6.3',d:'10-25',items:['Tab 栏从磨砂改为透玻璃:模糊 30→12px、底色再降,内容清晰穿透','修复顶部回弹时内容闪入状态栏区被系统磨砂的问题(状态栏护罩)','修复页面存在约 59px 过度滚动空隙的问题']},
 {v:'1.6.2',d:'10-25',items:['Tab 栏改为居中紧凑胶囊:收窄宽度、高度精简,图标 21px、文字 10.5px,分布更紧凑秀气']},
 {v:'1.6.1',d:'10-25',items:['Tab 栏按液态玻璃参考重制:更饱满的全圆角悬浮胶囊,图标 24px、文字加大','玻璃细节升级:亮白描边、斜向光泽、「玻璃上叠玻璃」更亮药丸']},
 {v:'1.6.0',d:'10-25',items:['Tab 从 7 个精简为 4 个:首页 / 训练 / 计划 / 我的,组内页面用顶部分段切换','训练 = 今日 + 技能树 + 自测;计划 = 周计划 + 学习中心 + 实战','Tab 栏玻璃推至最透:36px 模糊 + 顶部光泽 + 上下缘高光/暗影','修复滚动时内容钻入状态栏区、被系统加一层模糊的问题']},
 {v:'1.5.0',d:'10-25',items:['新增「我的」页:称呼、外观、多设备同步、数据、关于集中一处','移除顶部标题栏,内容直达状态栏区,更沉浸','「关于」新增版本更新日志,每个版本改了什么一目了然']},
 {v:'1.4.2',d:'10-25',items:['滚动时顶栏改为悬浮玻璃胶囊,与系统状态栏无缝衔接','切页动画统一曲线与视差,消除视觉不一致','玻璃材质更透明,抽屉、弹窗、提示同步升级']},
 {v:'1.4.1',d:'10-25',items:['顶栏静止时与背景完全融合,滚动后玻璃才浮现','切页新增滚动位置记忆,来回切换回到原处','点击当前页签回到顶部(iOS 习惯)']},
 {v:'1.4.0',d:'10-25',items:['iOS 液态玻璃改版:状态栏随 App 深浅色自动同步','页面切换改为方向感知的滑动过渡','底部导航改为悬浮胶囊 + 滑动指示器','修复手机端无法进入设置页的问题']},
 {v:'1.3.0',d:'10-25',items:['新增自动更新:打开自动检查新版并静默升级','版本号与「检查更新」按钮']}
];
(function(){var el=$('#meLog');if(!el)return;
 var item=function(c){return '<div class="logv"><div style="display:flex;align-items:center;gap:8px"><span class="tag brand mono">v'+c.v+'</span><span class="small muted">'+c.d+'</span></div><ul>'+c.items.map(function(t){return '<li>'+t+'</li>'}).join('')+'</ul></div>'};
 var html=item(CHANGELOG[0]);
 if(CHANGELOG.length>1){html+='<details class="log-more"><summary>更早版本 · '+(CHANGELOG.length-1)+' 个</summary>'+CHANGELOG.slice(1).map(item).join('')+'</details>'}
 el.innerHTML=html})();
setTimeout(function(){checkUpdate(true)},3000);
/* 链接参数自动配置:#t=令牌&g=GistID(打开即存,随即清掉地址栏,令牌不留在历史记录) */
(function(){
 try{
  var h=location.hash||'';
  if(h.indexOf('#t=')===0||h.indexOf('&g=')>0){
   var m=h.match(/t=([^&]+)&g=([^&]+)/);
   if(m&&m[1]&&m[2]){
    S.lc={backend:'gist',token:decodeURIComponent(m[1]).slice(0,200),gist:decodeURIComponent(m[2]).slice(0,80)};
    persist();renderSyncCard();
    toast('同步配置已通过链接导入','i-check');
   }
   history.replaceState(null,'',location.pathname+location.search);
  }
 }catch(e){}
})();
/* 自动读取同目录 sync-config.js(若部署者放了 Gist ID 等,新设备少填一项;令牌不放公开文件) */
(function(){
 try{
  fetch('sync-config.js',{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(t){
   if(!t)return;
   var i=t.indexOf('{'),j=t.lastIndexOf('}');
   if(i<0||j<=i)return;
   var c;
   try{c=JSON.parse(t.slice(i,j+1))}catch(e){return}
   if(!c)return;
   if(c.backend==='gist'&&c.gist&&(!S.lc||!S.lc.gist)){
    S.lc=S.lc||{};S.lc.backend='gist';S.lc.gist=String(c.gist).slice(0,80);
    if(c.token)S.lc.token=String(c.token).slice(0,200);
    persist();renderSyncCard();
   }else if(c.id&&c.key&&c.host&&c.code&&(!S.lc||!S.lc.id||!S.lc.key||!S.lc.host||!S.lc.code)){
    S.lc={id:String(c.id).slice(0,160),key:String(c.key).slice(0,160),host:String(c.host).slice(0,160),code:String(c.code).slice(0,8)};
    persist();renderSyncCard();
   }
  }).catch(function(){});
 }catch(e){}
})();
if(lcOK()&&(!navigator||navigator.onLine))pullNow(false);
initNavigation();
document.documentElement.classList.remove('booting');
idle(renderRemaining);
watchServiceWorker();
if(!S.name)$('#onboard').classList.remove('hidden');
}
})();
