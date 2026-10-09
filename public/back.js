// 返回上一个界面：主屏幕 Web App 没有浏览器的后退键，靠这个按钮。
// 有站内上一页就 history.back()（保留滚动位置）；直接打开的页面没有上一页，就去 data-fallback（默认首页）。
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-back]');
  if (!btn) return;
  e.preventDefault();
  let fromHere = false;
  try { fromHere = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch {}
  if (fromHere && history.length > 1) history.back();
  else location.href = btn.dataset.fallback || '/';
});
