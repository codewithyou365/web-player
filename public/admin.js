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

  async deleteEpisode(show, ep) {
    const okay = await this.confirm(`删除「${show.name}」第 ${ep.index + 1} 集`, [ep.title]);
    if (!okay) return null;
    const r = await fetch(`/api/shows/${show.id}/episodes/${ep.index}`, { method: 'DELETE' }).then((x) => x.json());
    if (r.error) { alert('删除失败：' + r.error); return null; }
    return r;
  },
};
