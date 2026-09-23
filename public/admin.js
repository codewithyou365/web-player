// 管理模式：开关存在本机浏览器里（localStorage），开启后才显示删除按钮
window.Admin = {
  on() { try { return localStorage.getItem('adminMode') === '1'; } catch { return false; } },
  set(v) { try { localStorage.setItem('adminMode', v ? '1' : '0'); } catch {} },

  /**
   * 删除确认框。title：标题；lines：将被删除的条目列表；resolve(true) 表示确认。
   * 必须在输入框里输入「删除」两个字才能点确认，防误触。
   */
  confirm(title, lines) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const shown = lines.slice(0, 12);
      const more = lines.length - shown.length;
      wrap.innerHTML = `
        <div class="modal">
          <h3>⚠️ ${esc(title)}</h3>
          <p class="modal-warn">这会直接从硬盘上彻底删除，<b>无法恢复</b>。</p>
          <ul class="modal-list">${shown.map((l) => `<li>${esc(l)}</li>`).join('')}${more > 0 ? `<li>… 还有 ${more} 个</li>` : ''}</ul>
          <p>请输入「删除」两个字确认：</p>
          <input class="modal-input" placeholder="删除" autocomplete="off">
          <div class="modal-btns">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn danger" data-act="ok" disabled>彻底删除</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const input = wrap.querySelector('.modal-input');
      const ok = wrap.querySelector('[data-act=ok]');
      input.addEventListener('input', () => { ok.disabled = input.value.trim() !== '删除'; });
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-act=cancel]').onclick = () => done(false);
      ok.onclick = () => done(true);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
      input.focus();
    });
  },

  async deleteShow(show) {
    const okay = await this.confirm(`删除整个节目「${show.name}」`, [`${show.relPath}（共 ${show.count ?? show.episodes.length} 集）`]);
    if (!okay) return false;
    const r = await fetch('/api/shows/' + show.id, { method: 'DELETE' }).then((x) => x.json());
    if (r.error) { alert('删除失败：' + r.error); return false; }
    if (r.errors && r.errors.length) alert('部分文件删除失败：\n' + r.errors.join('\n'));
    return true;
  },

  /** 选择框：title 标题，options [{id, label, disabled, note}]，resolve(选中的 id 或 null) */
  choose(title, hint, options) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      wrap.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <p class="modal-hint">${esc(hint)}</p>
          <div class="choice-list">${options.map((o) => `
            <label class="choice${o.disabled ? ' disabled' : ''}">
              <input type="radio" name="choice" value="${esc(o.id)}" ${o.disabled ? 'disabled' : ''}>
              <span class="choice-label">📁 ${esc(o.label)}</span>
              <span class="choice-note">${esc(o.note || '')}</span>
            </label>`).join('')}</div>
          <div class="modal-btns">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn primary" data-act="ok" disabled>归档</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const ok = wrap.querySelector('[data-act=ok]');
      wrap.querySelectorAll('input[name=choice]').forEach((r) => r.addEventListener('change', () => { ok.disabled = false; }));
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-act=cancel]').onclick = () => done(null);
      ok.onclick = () => done(wrap.querySelector('input[name=choice]:checked')?.value || null);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    });
  },

  /** 归档：让用户从该节目的上级目录里挑一个折叠成文件夹 */
  async archiveShow(show) {
    const anc = await fetch(`/api/shows/${show.id}/ancestors`).then((r) => r.json());
    if (!anc.length) { alert('这个节目直接放在扫描目录下，没有可以归档到的上级目录。'); return false; }
    const pick = await this.choose(`归档「${show.name}」`, '选择折叠成文件夹的上级目录。该目录下的所有节目都会收进去，首页只显示一张文件夹卡片。',
      anc.map((a) => ({ id: a.id, label: a.name, note: a.archived ? '（已归档）' : a.relPath, disabled: a.archived })));
    if (!pick) return false;
    const r = await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showId: show.id, ancestorId: pick }) }).then((x) => x.json());
    if (r.error) { alert('归档失败：' + r.error); return false; }
    return true;
  },

  async unarchive(folder) {
    if (!confirm(`取消归档「${folder.name}」？\n里面的 ${folder.count} 个节目会放回上一层显示。文件不会被删除。`)) return false;
    const r = await fetch('/api/folders/' + folder.id, { method: 'DELETE' }).then((x) => x.json());
    return !!r.ok;
  },

  async deleteEpisode(show, ep) {
    const okay = await this.confirm(`删除「${show.name}」第 ${ep.index + 1} 集`, [ep.title]);
    if (!okay) return null;
    const r = await fetch(`/api/shows/${show.id}/episodes/${ep.index}`, { method: 'DELETE' }).then((x) => x.json());
    if (r.error) { alert('删除失败：' + r.error); return null; }
    return r;
  },
};
