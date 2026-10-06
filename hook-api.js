/* 页面内 API 响应拦截器（由主进程作为 preload 注入，document-start 执行）。

   背景：应用直接请求抖音接口/分享页会被风控拦截（argus JS 挑战页），
   而抖音页面自己发起的请求带完整签名与浏览器指纹，服务器返回真实数据。
   因此我们不发任何自己的请求，只在页面内拦截抖音自己的接口响应。

   捕获四类（各自累积去重）：
   1. aweme/post      → window.__dydownApiItems   （主页作品列表）
   2. mix/list        → window.__dydownMixList    （用户的合集列表，排除 listcollection）
   3. series/list     → window.__dydownSeriesList （用户的系列列表，排除 listcollection）
   4. series/aweme、mix/aweme → window.__dydownMixItems（合集内视频列表）

   计数暴露在 __dydownApiCount / __dydownMixCount / __dydownSeriesCount / __dydownMixItemCount。 */
(function () {
  if (window.__dydownHookInstalled) return;
  window.__dydownHookInstalled = true;
  window.__dydownApiItems = [];
  window.__dydownMixList = [];
  window.__dydownSeriesList = [];
  window.__dydownMixItems = [];
  var seenPost = {};
  var seenMix = {};
  var seenSeries = {};
  var seenMixItem = {};

  function pushUnique(target, seen, key, obj) {
    if (!key || seen[key]) return false;
    seen[key] = 1;
    target.push(obj);
    return true;
  }

  /* 作品列表（主页）：只收目标作者的作品。
     主页页面上可能还有别的 aweme/post 请求（推荐位等），
     目标 sec_uid 由主进程注入到 window.__dydownTargetSec。 */
  function collectPost(json) {
    var list = json && json.aweme_list;
    if (!list || !list.length) return;
    var target = window.__dydownTargetSec || "";
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (target) {
        var au = a && a.author;
        if (au && au.sec_uid && au.sec_uid !== target) continue;
      }
      if (pushUnique(window.__dydownApiItems, seenPost, a && a.aweme_id, a)) added += 1;
    }
    if (added) window.__dydownApiCount = window.__dydownApiItems.length;
  }

  /* 合集列表（mix/list；listcollection 是"我的收藏"，不属于目标用户，排除） */
  function collectMixList(json) {
    var list = json && json.mix_infos;
    if (!list || !list.length) return;
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (pushUnique(window.__dydownMixList, seenMix, m && m.mix_id, m)) added += 1;
    }
    if (added) window.__dydownMixCount = window.__dydownMixList.length;
  }

  /* 系列列表（series/list；抖音的"合集"有两套体系，知识/短剧类多为 series） */
  function collectSeriesList(json) {
    var list = json && json.series_infos;
    if (!list || !list.length) return;
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var sid = s && (s.series_id || s.mix_id);
      if (pushUnique(window.__dydownSeriesList, seenSeries, sid, s)) added += 1;
    }
    if (added) window.__dydownSeriesCount = window.__dydownSeriesList.length;
  }

  /* 合集内视频（series/aweme、mix/aweme） */
  function collectMixItems(json) {
    var list = json && json.aweme_list;
    if (!list || !list.length) return;
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (pushUnique(window.__dydownMixItems, seenMixItem, a && a.aweme_id, a)) added += 1;
    }
    if (added) window.__dydownMixItemCount = window.__dydownMixItems.length;
  }

  function collectText(url, text) {
    try {
      if (!text || text.length < 100) return;
      var noCollect = url.indexOf("listcollection") >= 0;
      var hasMixList = url.indexOf("mix/list") >= 0 && !noCollect;
      var hasSeriesList = url.indexOf("series/list") >= 0 && !noCollect;
      var hasMixItems = url.indexOf("series/aweme") >= 0 || url.indexOf("mix/aweme") >= 0;
      var hasPost = url.indexOf("aweme/post") >= 0;
      if (!hasMixList && !hasSeriesList && !hasMixItems && !hasPost) return;
      if (text.indexOf("status_code") < 0) return;
      var json;
      try { json = JSON.parse(text); } catch (e) { return; }
      if (hasMixList) collectMixList(json);
      if (hasSeriesList) collectSeriesList(json);
      if (hasMixItems) collectMixItems(json);
      if (hasPost) collectPost(json);
    } catch (e) {}
  }

  function watchUrl(url) {
    return (
      (url.indexOf("mix/list") >= 0 && url.indexOf("listcollection") < 0) ||
      (url.indexOf("series/list") >= 0 && url.indexOf("listcollection") < 0) ||
      url.indexOf("series/aweme") >= 0 ||
      url.indexOf("mix/aweme") >= 0 ||
      url.indexOf("aweme/post") >= 0
    );
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__dydownUrl = String(url || ""); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      var xhr = this;
      if (watchUrl(xhr.__dydownUrl || "")) {
        xhr.addEventListener("load", function () {
          try { collectText(xhr.__dydownUrl || "", xhr.responseText); } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = "";
      try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (e) {}
      var p = origFetch.apply(this, arguments);
      try {
        if (watchUrl(url)) {
          p.then(function (res) {
            try { res.clone().text().then(function (t) { collectText(url, t); }, function () {}); } catch (e) {}
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }
})();
