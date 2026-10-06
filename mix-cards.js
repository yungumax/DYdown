/* 合集卡片 DOM 提取器（主进程用 executeJavaScript 注入，作为 hook 数据的兜底）。

   从页面上的合集卡片链接（a[href*="/collection/"]）提取 mix_id、名称、集数。
   卡片的文本形态示例："电工基础5650.7万 播放更新至 107 集"。
   返回 JSON 字符串数组，元素：{ mix_id, name, episodes } */
(function () {
  try {
    var out = [];
    var seen = {};
    var anchors = document.querySelectorAll('a[href*="/collection/"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute("href") || "";
      var m = href.match(/\/collection\/(\d+)/);
      if (!m) continue;
      var id = m[1];
      if (seen[id]) continue;
      seen[id] = 1;
      var txt = (a.textContent || "").replace(/\s+/g, " ").trim();
      /* 去掉播放量（"5650.7万 播放"）与更新信息（"更新至 107 集"）后的部分做名称 */
      var name = txt
        .replace(/\d[\d.,]*\s*[万亿]?\s*播放[\s\S]*$/, "")
        .replace(/\s*更新至[\s\S]*$/, "")
        .replace(/\s*共\s*\d+\s*集[\s\S]*$/, "")
        .trim();
      var epM = txt.match(/更新至\s*(\d+)\s*集/);
      if (!epM) epM = txt.match(/共\s*(\d+)\s*集/);
      out.push({
        mix_id: id,
        name: name || id,
        episodes: epM ? Number(epM[1]) : 0,
      });
    }
    return JSON.stringify(out);
  } catch (e) {
    return "[]";
  }
})();
