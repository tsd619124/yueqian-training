function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function renderReviewHTML(report) {
  const states = { pending: '待审核', 'needs-review': '需重新审核', approved: '已通过', rejected: '已拒绝', deferred: '暂缓' };
  const groups = { 'new-topic': '待补充主题', 'material-update': '已有主题的新材料', 'content-change': '内容变化', deprecation: '弃用线索', 'possible-conflict': '表述差异', 'source-check': '来源复核' };
  const pending = report.queue.filter(item => ['pending', 'needs-review'].includes(item.status)).length;
  const coverageRows = report.coverage.map(topic => `<tr><th scope="row">${escapeHTML(topic.title)}<code>${escapeHTML(topic.id)}</code></th><td>${topic.evidence.length || '—'}</td><td>${topic.candidateEvidence.length || '—'}</td></tr>`).join('');
  const sections = Object.entries(groups).map(([kind, heading]) => {
    const items = report.queue.filter(item => item.kind === kind);
    if (!items.length) return '';
    return `<section><h2 class="group-title">${heading}<span>${items.length}</span></h2>${items.map(item => {
      const sources = item.documents.map(document => `<a href="${escapeHTML(document.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(document.sourceID)} · ${escapeHTML(document.path)}</a>`).join('<br>');
      const proofs = item.evidence.map(proof => `<blockquote><p>${escapeHTML(proof.quote)}${proof.truncated ? '…' : ''}</p><a href="${escapeHTML(proof.url)}" target="_blank" rel="noopener noreferrer">${proof.version === 'previous' ? '上一版 · ' : ''}L${proof.lineStart} · ${escapeHTML(proof.revision.slice(0, 10))}</a></blockquote>`).join('');
      const images = (item.images || []).map(image => image.url ? `<li><a href="${escapeHTML(image.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(image.alt || image.original)}</a> · 待核对图片授权</li>` : `<li>${escapeHTML(image.original)} · 待解析</li>`).join('');
      const blockers = item.blockers.map(message => `<p class="blocked">${escapeHTML(message)}</p>`).join('');
      const curriculum = item.curriculumMatches?.length ? `<details><summary>关联现有课程 · ${item.curriculumMatches.length}</summary><ul>${item.curriculumMatches.map(lesson => `<li>${escapeHTML(lesson.id)} · ${escapeHTML(lesson.title)}</li>`).join('')}</ul><p>关联只提供比对线索，是否已有充分内容需要人工判断。</p></details>` : '';
      const actionOptions = ['new-topic', 'material-update'].includes(item.kind) ? '<option value="">选择编排方式</option><option value="add-topic">新增主题</option><option value="update-material">补充现有材料</option>' : '<option value="resolve">完成本项复核</option>';
      const licenses = item.documents.filter(document => document.license).map(document => `<li><a href="${escapeHTML(document.license.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(document.sourceID)} · 来源许可证</a></li>`).join('');
      const audit = item.review ? `<details><summary>审核记录 · ${states[item.status]}</summary><p>${escapeHTML(item.review.reviewer)} · ${escapeHTML(item.review.reviewedAt)}</p><p>${escapeHTML(item.review.note)}</p>${item.review.current ? '' : '<p>内容、许可或审核规则已经变化，原决定不再生效。</p>'}</details>` : '';
      return `<article><div class="article-title"><h3>${escapeHTML(item.title)}</h3><span>${states[item.status]}</span></div><p class="source">${sources}</p>${proofs}${blockers}${curriculum}${licenses ? `<details><summary>来源许可</summary><ul>${licenses}</ul></details>` : ''}${images ? `<details><summary>原图来源 · ${item.images.length}</summary><ul>${images}</ul></details>` : ''}${item.before ? `<details><summary>版本差异</summary><pre>${escapeHTML(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre></details>` : ''}${audit}
      <form data-item-id="${escapeHTML(item.id)}" data-fingerprint="${escapeHTML(item.fingerprint)}"><label>审核决定<select name="decision" aria-label="${escapeHTML(item.title)}的审核决定"><option value="">暂不处理</option><option value="approve"${item.blockers.length ? ' disabled' : ''}>通过本项审核</option><option value="defer">暂缓</option><option value="reject">拒绝</option></select></label><div class="decision-fields" hidden><label>前置能力 ID<input name="prerequisites" value="${escapeHTML(item.suggestedPrerequisiteTopicIDs.join(', '))}" placeholder="如 agents, tools；无前置能力时留空"></label><fieldset hidden><legend>通过前逐项确认</legend><label>编排方式<select name="action">${actionOptions}</select></label>${[['source', '原文和发布者可信'], ['relevance', '与课程目标相关，内容足够支撑该主题'], ['versions', '适用版本、弃用和冲突已核对'], ['rights', '已核对原文授权，图片仍需单独审核'], ['prerequisites', '前置能力已明确，空白表示无需前置能力']].map(([name, label]) => `<label class="check"><input type="checkbox" name="${name}">${label}</label>`).join('')}</fieldset><label>审核依据<textarea name="note" rows="2" maxlength="2000" placeholder="记录适用条件、取舍和仍待补齐的内容"></textarea></label></div></form></article>`;
    }).join('')}</section>`;
  }).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>主题审核 · 跃迁计划</title><style>
:root{color-scheme:light;--ink:#1d2925;--muted:#59665f;--line:#d8dfda;--accent:#215b47}*{box-sizing:border-box}body{margin:0;background:#f5f6f2;color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}header,main{max-width:1280px;margin:auto;padding:32px}header{padding-bottom:8px}h1{font-size:34px;letter-spacing:-1px;margin:0 0 8px}header p{max-width:760px;color:var(--muted)}a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}main{display:grid;grid-template-columns:300px minmax(0,1fr);gap:40px;padding-top:20px}aside{align-self:start;position:sticky;top:20px}.toolbar{display:flex;align-items:end;gap:14px;margin:24px 0 0}.toolbar label{max-width:260px}.toolbar input{background:white}.group-title{font-size:19px;display:flex;gap:14px;align-items:center;margin:0 0 18px}.group-title span{font-size:14px;color:var(--muted);font-weight:400}section+section{margin-top:36px}article{background:#fff;padding:26px;margin-bottom:18px;border:1px solid var(--line);border-radius:12px}.article-title{display:flex;justify-content:space-between;align-items:baseline;gap:16px}h3{font-size:21px;line-height:1.4;margin:0}.article-title span{white-space:nowrap;font-size:13px;color:var(--muted)}.source{font-size:13px;line-height:1.6;margin:12px 0 20px}blockquote{border-left:2px solid #9bb7a7;margin:16px 0;padding:0 0 0 16px}blockquote p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}blockquote a{font-size:12px}label{display:block;font-size:13px;color:var(--muted)}input,textarea,select,button{font:inherit}input:not([type=checkbox]),textarea,select{display:block;width:100%;margin:6px 0 14px;padding:10px 12px;border:1px solid #b4c0b9;background:#fff;border-radius:6px;color:var(--ink)}select{max-width:360px}textarea{resize:vertical}.check{display:flex;gap:9px;align-items:start;margin:9px 0}.check input{margin-top:5px}fieldset{border:0;margin:8px 0 16px;padding:0}button{border:0;background:var(--accent);color:#fff;padding:12px 20px;border-radius:7px;cursor:pointer;min-height:44px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #b06c22;outline-offset:3px}details{font-size:13px;margin:16px 0;color:var(--muted)}summary{cursor:pointer;min-height:28px}.blocked{color:#a13c26;font-size:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 4px;border-bottom:1px solid var(--line)}thead th{font-weight:400;color:var(--muted)}tbody th{font-weight:500}td{text-align:center}code{display:block;font-size:11px;color:var(--muted)}aside p{font-size:13px;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere}#export-status{font-size:14px;color:var(--accent);min-height:22px;margin-bottom:0}.empty{background:white;padding:30px;border-radius:12px}[hidden]{display:none!important}@media(max-width:860px){header,main{padding:22px}main{grid-template-columns:1fr;gap:24px}aside{position:static}aside details{margin:0}article{padding:20px}.article-title{display:block}.article-title span{display:block;margin-top:7px}.toolbar{flex-wrap:wrap}h1{font-size:28px}}
</style></head><body><header><h1>主题审核</h1><p>${report.scope.collected} 篇正文已采集，${pending} 项待判断。通过后进入编排候选，正式课程的更新单独审核发布。目录中尚有 ${report.scope.remaining} 篇待采集${report.sourceStates.some(source => source.selectionLimited) ? '，部分来源受发现数量上限限制' : ''}。</p><div class="toolbar"><label>审核人<input id="reviewer" maxlength="100" autocomplete="name" placeholder="姓名或署名"></label><button type="button" id="export">导出审核决定</button></div><p id="export-status" role="status" aria-live="polite"></p></header><main><aside><details id="coverage" open><summary>能力覆盖</summary><p>数字为关键词命中的原文篇数，不代表教学完整或技术先进。</p><table><thead><tr><th>能力</th><th>已收录</th><th>候选</th></tr></thead><tbody>${coverageRows}</tbody></table></details><p>来源事实、前置能力和授权需逐项人工核对。原图按需打开，审核页不主动访问外站。</p><details><summary>保存到本地审核记录</summary><p>导出 JSON 后，在项目目录运行：</p><pre>node content-pipeline/run.mjs review --decisions 审核决定.json</pre><p>系统会重新校验当前内容版本，过期决定无法导入。</p></details></aside><div>${sections || '<p class="empty">还没有可审核正文，请先运行正文采集。</p>'}</div></main><script>
const narrowScreen = matchMedia('(max-width:860px)');
const updateCoverageLayout = () => { document.getElementById('coverage').open = !narrowScreen.matches; };
narrowScreen.addEventListener('change', updateCoverageLayout);
updateCoverageLayout();
const forms = [...document.querySelectorAll('form[data-item-id]')];
const statusElement = document.getElementById('export-status');
for (const form of forms) {
  form.addEventListener('submit', event => event.preventDefault());
  form.elements.decision.addEventListener('change', () => {
    form.querySelector('.decision-fields').hidden = !form.elements.decision.value;
    form.querySelector('fieldset').hidden = form.elements.decision.value !== 'approve';
  });
}
document.getElementById('export').addEventListener('click', () => {
  const reviewer = document.getElementById('reviewer').value.trim();
  if (!reviewer) { statusElement.textContent = '请填写审核人。'; document.getElementById('reviewer').focus(); return; }
  const decisions = [];
  for (const form of forms) {
    const decision = form.elements.decision.value;
    if (!decision) continue;
    const note = form.elements.note.value.trim();
    const checks = Object.fromEntries(['source','relevance','versions','rights','prerequisites'].map(name => [name, form.querySelector('input[type=checkbox][name="' + name + '"]').checked]));
    const action = decision === 'approve' ? form.elements.action.value : null;
    if (!note || (decision === 'approve' && (!action || Object.values(checks).some(value => !value)))) {
      statusElement.textContent = '请填写审核依据；通过审核还需逐项确认。';
      form.scrollIntoView({block:'center'});
      return;
    }
    const prerequisiteTopicIDs = [...new Set(form.querySelector('input[name=prerequisites]').value.split(/[,，\\s]+/).filter(Boolean))];
    decisions.push({itemID:form.dataset.itemId,fingerprint:form.dataset.fingerprint,decision,action,note,checks,prerequisiteTopicIDs});
  }
  if (!decisions.length) { statusElement.textContent = '请选择需要保存的审核决定。'; return; }
  const batch = {schemaVersion:1,reviewer,exportedAt:new Date().toISOString(),decisions};
  const url = URL.createObjectURL(new Blob([JSON.stringify(batch,null,2)],{type:'application/json'}));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = '审核决定.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  statusElement.textContent = '已导出 ' + decisions.length + ' 项决定；导入后才写入本地审核记录。';
});
</script></body></html>`;
}
