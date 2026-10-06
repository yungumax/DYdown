/* 页面内作品 ID 收集器（注入抖音页面执行）
   持久累积：虚拟列表会回收滚过的 DOM，靠 MutationObserver + 定时扫描把
   所有出现过的作品 ID 记到 window.__dydownIds，滚动多快都不丢。 */
(function () {
  /* 身份校验：页面必须停留在目标用户页（加载中可能跳转到推荐页/他人页，
     不校验就会把无关视频混入，导致数量不对与解析失败） */
  if (location.pathname.indexOf('/user/__TARGET__') === -1) return '[]';
  if (!window.__dydownIds) {
    window.__dydownIds = [];
    window.__dydownIdSet = {};
    var scan = function () {
      if (location.pathname.indexOf('/user/__TARGET__') === -1) return;
      var root = document.querySelector('[data-e2e=user-post-list]');
      if (!root) return;
      var links = root.querySelectorAll('a[href]');
      for (var k = 0; k < links.length; k++) {
        var h = links[k].href;
        var i = h.indexOf('/video/');
        if (i === -1) continue;
        var id = h.slice(i + 7).split('?')[0].split('&')[0].split('#')[0].split('/')[0];
        if (id && /^[0-9]+$/.test(id) && !window.__dydownIdSet[id]) {
          window.__dydownIdSet[id] = 1;
          window.__dydownIds.push(id);
        }
      }
    };
    scan();
    try {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(scan, 1200);
  }
  return JSON.stringify(window.__dydownIds || []);
})();
