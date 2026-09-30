// 修正舊版 hls.js 的「假 HE-AAC」：它在非 Firefox/Android 一律把 AAC-LC 宣告成 HE-AAC(SBR)，
// WebView2 的 FFmpeg AAC 解碼器照 SBR 去解,聲音會像開了變聲器(iyf.tv 等)。
// 假造的特徵:SBR 延伸取樣率 == 核心取樣率(真正的 HE-AAC 是 2 倍),只改這種,改回 LC。
(function () {
  if (window.__ytfAacFix || !window.SourceBuffer) return;
  window.__ytfAacFix = true;
  function fixInit(u8) {
    // 找 esds 內的 DecoderSpecificInfo(tag 0x05, 長度 4) = AudioSpecificConfig
    for (var i = 0; i + 8 < u8.length; i++) {
      if (u8[i] !== 0x65 || u8[i + 1] !== 0x73 || u8[i + 2] !== 0x64 || u8[i + 3] !== 0x73) continue; // "esds"
      for (var j = i + 4; j + 6 < u8.length && j < i + 64; j++) {
        if (u8[j] !== 0x05 || u8[j + 1] !== 0x04) continue;
        var b0 = u8[j + 2], b1 = u8[j + 3], b2 = u8[j + 4];
        var obj = b0 >> 3, sf = ((b0 & 7) << 1) | (b1 >> 7), ch = (b1 >> 3) & 15;
        var ext = ((b1 & 7) << 1) | (b2 >> 7);
        if (obj !== 5 || ext !== sf) return null;
        var out = new Uint8Array(u8); // 複製,不動原資料
        out[j + 2] = (2 << 3) | (sf >> 1);
        out[j + 3] = ((sf & 1) << 7) | (ch << 3);
        out[j + 4] = 0;
        out[j + 5] = 0;
        return out;
      }
      return null;
    }
    return null;
  }
  var origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      var u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // 只看初始化片段(含 moov),一般媒體片段直接放行
      if (u8.length < 65536 && u8.length > 8 &&
          String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) !== "moof") {
        var fixed = fixInit(u8);
        if (fixed) {
          window.__ytfAacFixed = (window.__ytfAacFixed || 0) + 1; // 除錯用:修正次數
          return origAppend.call(this, fixed);
        }
      }
    } catch (e) {}
    return origAppend.apply(this, arguments);
  };
})();

// 只在最上層 frame 注入,避免 YouTube 內嵌 iframe 也跑一份
(function () {
  if (window.top !== window.self) return;
  if (window.__ytfInjected) return;
  window.__ytfInjected = true;

  // 失焦不暫停：部分網站在視窗 blur / 頁面隱藏時會自動暫停影片（如 iyf.tv）。
  // 浮動視窗點到別的程式就會失焦,所以在網站腳本之前攔掉這些事件、並假裝頁面一直可見。
  if (/(^|\.)iyf\.tv$/.test(location.hostname)) {
    ["blur", "visibilitychange", "webkitvisibilitychange"].forEach(function (type) {
      window.addEventListener(type, function (e) {
        // 只攔「整個視窗/頁面」層級的事件,輸入框等元素自己的 blur 照常
        if (e.target === window || e.target === document) e.stopImmediatePropagation();
      }, true);
    });
    try {
      Object.defineProperty(Document.prototype, "hidden", { get: function () { return false; } });
      Object.defineProperty(Document.prototype, "visibilityState", { get: function () { return "visible"; } });
      Document.prototype.hasFocus = function () { return true; };
    } catch (e) {}
  }

  function win() {
    return window.__TAURI__.window.getCurrentWindow();
  }
  function hasTauri() {
    return !!(window.__TAURI__ && window.__TAURI__.window);
  }

  function ready(fn) {
    if (document.body || document.documentElement) return fn();
    new MutationObserver(function (_, obs) {
      if (document.documentElement) {
        obs.disconnect();
        fn();
      }
    }).observe(document, { childList: true, subtree: true });
  }

  ready(function () {
    var BAR_H = 32;
    var GRIP = 6;

    // ---- 樣式 ----
    var style = document.createElement("style");
    style.id = "ytf-style";
    style.textContent = [
      "#ytf-bar{position:fixed;top:0;left:0;right:0;height:" + BAR_H + "px;z-index:2147483647;",
      "display:flex;align-items:center;gap:6px;padding:0 6px;box-sizing:border-box;",
      "background:rgba(20,20,20,.95);backdrop-filter:blur(6px);font:13px system-ui,sans-serif;",
      "color:#eee;transform:translateY(-100%);transition:transform .15s ease;}",
      "#ytf-bar.show{transform:translateY(0);}",
      "#ytf-drag{flex:1;height:100%;cursor:grab;display:flex;align-items:center;}",
      "#ytf-url{flex:1;min-width:0;height:22px;border:none;border-radius:4px;padding:0 8px;",
      "background:#333;color:#fff;outline:none;font:12px system-ui;}",
      ".ytf-btn{min-width:24px;height:22px;border:none;border-radius:4px;background:#333;color:#ddd;",
      "cursor:pointer;font-size:13px;line-height:22px;padding:0 4px;}",
      ".ytf-btn:hover{background:#555;}",
      "#ytf-pin.on,.ytf-btn.on{background:#c00;color:#fff;}",
      ".ytf-svc{font-weight:700;letter-spacing:.5px;filter:saturate(1.1);}",
      ".ytf-svc:hover{filter:brightness(1.2);}",
      // 🎬 劇場模式：隱藏頁面其餘部分,讓播放器填滿視窗
      "html.ytf-cinema{overflow:hidden !important;}",
      "html.ytf-cinema #masthead-container,html.ytf-cinema #masthead,",
      "html.ytf-cinema ytd-watch-metadata,html.ytf-cinema #secondary,",
      "html.ytf-cinema #secondary-inner,html.ytf-cinema #comments,",
      "html.ytf-cinema #below,html.ytf-cinema #chat,html.ytf-cinema #chat-container,",
      "html.ytf-cinema ytd-merch-shelf-renderer,html.ytf-cinema #related,",
      "html.ytf-cinema tp-yt-app-header,html.ytf-cinema #header{display:none !important;}",
      // 一般 YouTube 影片用 #movie_player；Shorts 用 #shorts-player（避開隱藏的 #movie_player decoy）
      "html.ytf-cinema:not(.ytf-shorts) #movie_player,html.ytf-shorts #shorts-player{",
      "position:fixed !important;inset:0 !important;width:100vw !important;",
      "height:100vh !important;z-index:9000 !important;background:#000 !important;}",
      "html.ytf-cinema:not(.ytf-shorts) #movie_player .html5-video-container,",
      "html.ytf-shorts #shorts-player .html5-video-container{position:absolute !important;",
      "inset:0 !important;width:100% !important;height:100% !important;}",
      "html.ytf-cinema:not(.ytf-shorts) #movie_player video,html.ytf-shorts #shorts-player video,",
      "html.ytf-cinema .bpx-player-container video,html.ytf-cinema .xgplayer video{",
      "position:absolute !important;left:0 !important;top:0 !important;",
      "width:100% !important;height:100% !important;object-fit:contain !important;}",
      // Shorts：隱藏右側按鈕/字幕覆蓋層
      "html.ytf-shorts ytd-reel-player-overlay-renderer{display:none !important;}",
      // Shorts：取消 CSS containment，否則 position:fixed 會相對它定位（造成左/上空白）
      "html.ytf-shorts .reel-video-in-sequence-new,html.ytf-shorts ytd-reel-video-renderer,",
      "html.ytf-shorts #shorts-container,html.ytf-shorts ytd-shorts{contain:none !important;}",
      // Bilibili 播放器
      "html.ytf-cinema .bpx-player-container{position:fixed !important;inset:0 !important;",
      "width:100vw !important;height:100vh !important;z-index:2147483600 !important;",
      "background:#000 !important;margin:0 !important;padding:0 !important;}",
      "html.ytf-cinema .bpx-player-primary-area,html.ytf-cinema .bpx-player-video-area,",
      "html.ytf-cinema .bpx-player-video-perch,html.ytf-cinema .bpx-player-video-wrap{",
      "position:absolute !important;inset:0 !important;width:100% !important;height:100% !important;}",
      "html.ytf-cinema #biliMainHeader,html.ytf-cinema .bili-header,",
      "html.ytf-cinema .fixed-header{display:none !important;}",
      // Bilibili 彈幕層 + 頂部發送列
      "html.ytf-cinema .bpx-player-sending-bar,html.ytf-cinema .bpx-player-top,",
      "html.ytf-cinema [class*=dm-wrap]{display:none !important;}",
      // 西瓜播放器 xgplayer（iyf.tv 等）
      "html.ytf-cinema .xgplayer{position:fixed !important;inset:0 !important;",
      "width:100vw !important;height:100vh !important;z-index:2147483600 !important;",
      "background:#000 !important;margin:0 !important;padding:0 !important;}",
      "html.ytf-cinema .xgplayer-danmu,html.ytf-cinema .danmu_handler_box{display:none !important;}",
      // 📑 書籤清單
      "#ytf-bm{position:fixed;top:" + (BAR_H + 2) + "px;right:6px;z-index:2147483647;display:none;",
      "width:260px;max-width:calc(100vw - 12px);max-height:calc(100vh - " + (BAR_H + 10) + "px);overflow-y:auto;",
      "background:rgba(20,20,20,.97);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);",
      "font:12px system-ui,sans-serif;color:#eee;padding:4px 0;}",
      "#ytf-bm.show{display:block;}",
      ".ytf-bm-item{display:flex;align-items:center;gap:4px;padding:4px 8px;cursor:pointer;}",
      ".ytf-bm-item:hover{background:#333;}",
      ".ytf-bm-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".ytf-bm-del{border:none;background:none;color:#888;cursor:pointer;font-size:12px;padding:0 2px;}",
      ".ytf-bm-del:hover{color:#f55;}",
      ".ytf-bm-empty{padding:8px;color:#888;text-align:center;}",
      "#ytf-handle{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;",
      "width:90px;height:8px;border-radius:0 0 7px 7px;background:rgba(200,0,0,.85);cursor:grab;}",
      "#ytf-handle:hover{height:13px;background:rgba(225,0,0,1);}",
      "#ytf-handle:active{cursor:grabbing;}",
      "#ytf-hot{position:fixed;top:0;left:0;right:0;height:24px;z-index:2147483646;}",
      ".ytf-rs{position:fixed;z-index:2147483645;}",
      ".ytf-n{top:0;left:0;right:0;height:" + GRIP + "px;cursor:ns-resize;}",
      ".ytf-s{bottom:0;left:0;right:0;height:" + GRIP + "px;cursor:ns-resize;}",
      ".ytf-w{top:0;bottom:0;left:0;width:" + GRIP + "px;cursor:ew-resize;}",
      ".ytf-e{top:0;bottom:0;right:0;width:" + GRIP + "px;cursor:ew-resize;}",
      ".ytf-nw{top:0;left:0;width:14px;height:14px;cursor:nwse-resize;}",
      ".ytf-ne{top:0;right:0;width:14px;height:14px;cursor:nesw-resize;}",
      ".ytf-sw{bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize;}",
      ".ytf-se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;}",
    ].join("");

    // ---- 顯示 / 隱藏 ----
    var hideTimer;
    function show() {
      clearTimeout(hideTimer);
      bar.classList.add("show");
    }
    function hide() {
      if (bar.classList.contains("pinned")) return;
      if (document.activeElement === url) return;
      if (bmPanel.classList.contains("show")) return;
      bar.classList.remove("show");
    }

    // ---- 工具列 ----
    var bar = document.createElement("div");
    bar.id = "ytf-bar";

    var drag = document.createElement("div");
    drag.id = "ytf-drag";
    drag.title = "拖曳移動視窗";
    drag.addEventListener("mousedown", function (e) {
      if (e.button !== 0 || e.target !== drag) return;
      if (hasTauri()) win().startDragging();
    });

    var url = document.createElement("input");
    url.id = "ytf-url";
    url.type = "text";
    url.placeholder = "輸入網址或 YouTube 連結，按 Enter";
    url.value = location.href;
    url.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") {
        var v = url.value.trim();
        if (!v) return;
        if (!/^https?:\/\//i.test(v)) v = "https://" + v;
        location.assign(v);
      } else if (e.key === "Escape") {
        url.blur();
        hide();
      }
    });
    url.addEventListener("focus", show);
    drag.appendChild(url);

    var pin = document.createElement("button");
    pin.id = "ytf-pin";
    pin.className = "ytf-btn";
    pin.textContent = "📌";
    pin.title = "釘選工具列（不自動隱藏）";
    pin.addEventListener("click", function () {
      bar.classList.toggle("pinned");
      pin.classList.toggle("on", bar.classList.contains("pinned"));
    });

    // ◀ ▶ 上一頁 / 下一頁
    var back = document.createElement("button");
    back.className = "ytf-btn";
    back.textContent = "◀";
    back.title = "上一頁";
    back.addEventListener("click", function () { history.back(); });

    var fwd = document.createElement("button");
    fwd.className = "ytf-btn";
    fwd.textContent = "▶";
    fwd.title = "下一頁";
    fwd.addEventListener("click", function () { history.forward(); });

    // 服務快速跳轉鈕
    function navBtn(label, target, bg) {
      var b = document.createElement("button");
      b.className = "ytf-btn ytf-svc";
      b.textContent = label;
      b.title = "前往 " + target;
      b.style.background = bg;
      b.style.color = "#fff";
      b.addEventListener("click", function () { location.assign(target); });
      return b;
    }
    var svcYT = navBtn("YT", "https://www.youtube.com", "#cc0000");
    var svcNF = navBtn("NF", "https://www.netflix.com", "#b1060f");
    var svcBI = navBtn("B", "https://www.bilibili.com", "#00a1d6");
    var svcIY = navBtn("IY", "https://mview.iyf.tv", "#ff6a00");

    // 🎬 只看影片：CSS 劇場模式，隱藏頁面其餘部分、播放器填滿視窗（不換頁，無嵌入限制）
    var cinema = document.createElement("button");
    cinema.className = "ytf-btn";
    cinema.textContent = "🎬";
    cinema.title = "只看影片（隱藏其餘介面，播放器填滿視窗）";
    function hasPlayer() {
      return !!document.querySelector(
        "#movie_player, .html5-video-player, .bpx-player-container, .xgplayer, video"
      );
    }
    function setCinema(on) {
      var isShorts = /\/shorts\//.test(location.pathname);
      document.documentElement.classList.toggle("ytf-cinema", on);
      document.documentElement.classList.toggle("ytf-shorts", on && isShorts);
      cinema.classList.toggle("on", on);
      // 通知播放器重新計算尺寸
      window.dispatchEvent(new Event("resize"));
      setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 200);
    }
    cinema.addEventListener("click", function () {
      // Netflix 觀看頁本來就是全畫面影片,不需要也不應套用(會干擾其播放器)
      if (/netflix\.com$/.test(location.hostname)) {
        show();
        url.value = "Netflix 本來就是全畫面影片，免按 🎬";
        return;
      }
      var on = !document.documentElement.classList.contains("ytf-cinema");
      if (on && !hasPlayer()) {
        show();
        url.value = "請先點開一支影片，再按 🎬";
        return;
      }
      setCinema(on);
    });

    // ⭐ 加入/移除書籤、📑 書籤清單（存在 Rust 端 bookmarks.json，各網站共用）
    var bookmarks = [];
    function invoke(cmd, args) {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    function loadBookmarks() {
      if (!hasTauri()) return Promise.resolve();
      return invoke("load_bookmarks").then(function (s) {
        try { bookmarks = JSON.parse(s) || []; } catch (e) { bookmarks = []; }
        syncStar();
      }).catch(function () {});
    }
    function saveBookmarks() {
      if (hasTauri()) invoke("save_bookmarks", { data: JSON.stringify(bookmarks) }).catch(function () {});
      syncStar();
    }
    function bmIndex(u) {
      for (var i = 0; i < bookmarks.length; i++) if (bookmarks[i].url === u) return i;
      return -1;
    }

    var star = document.createElement("button");
    star.className = "ytf-btn";
    star.textContent = "⭐";
    star.title = "加入 / 移除書籤";
    function syncStar() {
      star.classList.toggle("on", bmIndex(location.href) >= 0);
    }
    star.addEventListener("click", function () {
      loadBookmarks().then(function () {
        var i = bmIndex(location.href);
        if (i >= 0) bookmarks.splice(i, 1);
        else bookmarks.unshift({ title: document.title || location.href, url: location.href });
        saveBookmarks();
        if (bmPanel.classList.contains("show")) renderBm();
      });
    });

    var bmPanel = document.createElement("div");
    bmPanel.id = "ytf-bm";
    function renderBm() {
      bmPanel.textContent = "";
      if (!bookmarks.length) {
        var empty = document.createElement("div");
        empty.className = "ytf-bm-empty";
        empty.textContent = "尚無書籤，按 ⭐ 加入目前頁面";
        bmPanel.appendChild(empty);
        return;
      }
      bookmarks.forEach(function (b, i) {
        var row = document.createElement("div");
        row.className = "ytf-bm-item";
        row.title = b.url;
        var t = document.createElement("span");
        t.className = "ytf-bm-t";
        t.textContent = b.title;
        var del = document.createElement("button");
        del.className = "ytf-bm-del";
        del.textContent = "✕";
        del.title = "刪除書籤";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          bookmarks.splice(i, 1);
          saveBookmarks();
          renderBm();
        });
        row.addEventListener("click", function () {
          bmPanel.classList.remove("show");
          location.assign(b.url);
        });
        row.appendChild(t);
        row.appendChild(del);
        bmPanel.appendChild(row);
      });
    }
    var bmBtn = document.createElement("button");
    bmBtn.className = "ytf-btn";
    bmBtn.textContent = "📑";
    bmBtn.title = "書籤清單";
    bmBtn.addEventListener("click", function () {
      if (bmPanel.classList.toggle("show")) {
        show();
        loadBookmarks().then(renderBm);
      }
    });
    // 點面板外面就關閉
    document.addEventListener("mousedown", function (e) {
      if (!bmPanel.classList.contains("show")) return;
      if (bmPanel.contains(e.target) || e.target === bmBtn) return;
      bmPanel.classList.remove("show");
      hideTimer = setTimeout(hide, 600);
    }, true);
    loadBookmarks();

    var minBtn = document.createElement("button");
    minBtn.className = "ytf-btn";
    minBtn.textContent = "➖";
    minBtn.title = "縮小到工作列";
    minBtn.addEventListener("click", function () { if (hasTauri()) win().minimize(); });

    var close = document.createElement("button");
    close.className = "ytf-btn";
    close.textContent = "✕";
    close.title = "隱藏到系統匣";
    close.addEventListener("click", function () { if (hasTauri()) win().hide(); });

    bar.appendChild(back);
    bar.appendChild(fwd);
    bar.appendChild(drag);
    bar.appendChild(svcYT);
    bar.appendChild(svcNF);
    bar.appendChild(svcBI);
    bar.appendChild(svcIY);
    bar.appendChild(cinema);
    bar.appendChild(star);
    bar.appendChild(bmBtn);
    bar.appendChild(pin);
    bar.appendChild(minBtn);
    bar.appendChild(close);
    bar.addEventListener("mouseenter", show);
    bar.addEventListener("mouseleave", function () {
      hideTimer = setTimeout(hide, 600);
    });

    // 永遠可見的握把
    var handle = document.createElement("div");
    handle.id = "ytf-handle";
    handle.title = "按住拖曳移動視窗 · 移到此處顯示網址列 · 雙擊聚焦網址列";
    handle.addEventListener("mouseenter", show);
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      show();
      if (hasTauri()) win().startDragging();
    });
    handle.addEventListener("dblclick", function () {
      show();
      url.focus();
      url.select();
    });

    // 頂部感應條
    var hot = document.createElement("div");
    hot.id = "ytf-hot";
    hot.addEventListener("mouseenter", show);

    // 縮放感應區
    var grips = [];
    [["n","North"],["s","South"],["w","West"],["e","East"],
     ["nw","NorthWest"],["ne","NorthEast"],["sw","SouthWest"],["se","SouthEast"]
    ].forEach(function (d) {
      var g = document.createElement("div");
      g.className = "ytf-rs ytf-" + d[0];
      g.addEventListener("mousedown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        if (hasTauri()) win().startResizeDragging(d[1]);
      });
      grips.push(g);
    });

    // ---- 掛載 + keepalive：被 SPA 清掉就補回 ----
    var nodes = [bar, bmPanel, handle, hot].concat(grips);
    function mount() {
      var html = document.documentElement;
      if (!html) return;
      if (!document.getElementById("ytf-style")) {
        (document.head || html).appendChild(style);
      }
      nodes.forEach(function (n) {
        if (!n.isConnected) html.appendChild(n);
      });
    }
    mount();
    setInterval(mount, 1000);

    // 讓「開新分頁」的連結改在同一視窗開啟（修正 Bilibili 等點影片沒反應）
    window.open = function (u) {
      if (u) { try { location.assign(u); } catch (e) {} }
      return null;
    };
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      if (a.target === "_blank" || a.getAttribute("target") === "_blank") {
        e.preventDefault();
        e.stopPropagation();
        location.assign(a.href);
      }
    }, true);

    // Shorts 劇場模式:滾輪切換上/下一支（劇場模式蓋住原生滾動區，改觸發原生導航鈕）
    var wheelLock = false;
    window.addEventListener("wheel", function (e) {
      if (!document.documentElement.classList.contains("ytf-shorts")) return;
      e.preventDefault();
      if (wheelLock || Math.abs(e.deltaY) < 8) return;
      wheelLock = true;
      setTimeout(function () { wheelLock = false; }, 550);
      var sel = e.deltaY > 0
        ? "#navigation-button-down button"
        : "#navigation-button-up button";
      var btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 250);
      }
    }, { passive: false, capture: true });

    // 熱鍵:Ctrl+L
    window.addEventListener("keydown", function (e) {
      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        show();
        url.focus();
        url.select();
      }
    }, true);

    // 同步網址顯示（SPA 導航時）
    setInterval(function () {
      if (document.activeElement !== url) url.value = location.href;
      syncStar();
    }, 1500);

    // 啟動時自動秀出 4 秒
    show();
    hideTimer = setTimeout(hide, 4000);
  });
})();
