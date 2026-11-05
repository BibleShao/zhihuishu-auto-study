// ==UserScript==
// @name         zhihuishujiaobenbysjy
// @namespace    Jiayi Shao
// @version      1.8.0
// @description  智慧树学习页：1.5 倍速、随堂练习自动作答、自动下一节；内置切换诊断（NET/PLAYER/CAT，默认开启低噪音，可用 zhsAuto.debug 切换）。1.8.0 = 1.7.0 修复版 + 诊断版合并
// @homepageURL  https://github.com/CNsjy2008/zhihuishu-auto-study
// @supportURL   https://github.com/CNsjy2008/zhihuishu-auto-study/issues
// @updateURL    https://raw.githubusercontent.com/CNsjy2008/zhihuishu-auto-study/main/zhihuishujiaobenbysjy.user.js
// @downloadURL  https://raw.githubusercontent.com/CNsjy2008/zhihuishu-auto-study/main/zhihuishujiaobenbysjy.user.js
// @match        https://wisdom-mooc.zhihuishu.com/study/*
// @match        https://wisdom-mooc.zhihuishu.com/*
// @match        https://studyh5.zhihuishu.com/videoStudy.html*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 配置与常量 ================= */

  const CONFIG = {
    rate: 1.5,                       // 目标倍速
    checkInterval: 5 * 60 * 1000,    // 每 5 分钟巡检一次随堂问答
    quizTimeout: 60 * 1000,          // 弹窗超过该时长仍未关闭则强制关闭
    autoNext: true,                  // 本节播完后自动切下一节

    ai: {
      enabled: false,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: '',
      model: 'gpt-4o-mini'
    }
  };


  if (CONFIG.rate > 1.75) CONFIG.rate = 1.75;

  const SEL = {
    video: 'video#vjs_container_html5_api, video.vjs-tech',
    speedBox: '.speedBox',
    nextBtn: '#nextBtn, .nextButton',
    chapterItem: '.chapter-item',
    smallLesson: '.chapter-content-second',
    finishIcon: '.finish-icon',
    itemName: '.item-name',
    quizDialog: '.ai-class-exercise-dialog',
    quizItem: '.ques-list .item',
    submitBtn: 'button.el-button.btn'
  };

  const LOG_MAX = 400;

  // 诊断口径：0 = 关闭；1 = 关键诊断（默认，低噪音）；2 = 详细（含请求体/完整目录）
  const state = {
    // 自动化
    handlingQuiz: false,
    quizShownAt: 0,
    lastNextAt: 0,
    switching: false,
    lastTipAt: 0,
    lastExpandAt: 0,
    finished: false,
    boundVideo: null,
    speedTouchedFor: '',
    paused: false,
    // 诊断
    debug: 1,
    lines: [],
    records: [],
    inflight: {},
    last: {},
    watchTimer: null,
    seq: 0
  };

  /* ---------------- 页面上下文 ---------------- */

  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e) {}
    return window;
  }

  const W = pageWindow();

  // 站点（播放器、队列等）挂在页面全局；沙箱里优先读页面 window
  function site(name) {
    try {
      if (W && W[name] !== undefined) return W[name];
    } catch (e) {}
    try {
      return window[name];
    } catch (e) {
      return undefined;
    }
  }

  /* ---------------- 日志面板 ---------------- */

  function ts() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function rawLog(tag, msg) {
    const line = `[${ts()}]${tag ? ` [${tag}]` : ''} ${msg}`;
    state.lines.push(line);
    if (state.lines.length > LOG_MAX) state.lines.shift();
    try {
      console.log('[zhs-auto]', tag || '', msg);
    } catch (e) {}
    const box = document.getElementById('zhs-auto-log');
    if (box) {
      const p = document.createElement('div');
      p.textContent = line;
      box.appendChild(p);
      while (box.childElementCount > LOG_MAX) box.removeChild(box.firstElementChild);
      box.scrollTop = box.scrollHeight;
    }
  }

  // 自动化流程日志：始终显示
  function log(msg) {
    rawLog('AUTO', msg);
  }

  // 诊断日志：受 state.debug 控制
  function diag(tag, msg, level = 1) {
    if (state.debug >= level) rawLog(tag, msg);
  }

  function normalizeDebug(v) {
    if (v === false) return 0;
    if (v === true) return 1;
    if (typeof v === 'number') return Math.max(0, Math.min(2, Math.floor(v)));
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'off' || s === 'false' || s === '0') return 0;
      if (s === 'verbose' || s === '2') return 2;
      return 1;
    }
    return 1;
  }

  function flushLog() {
    const box = document.getElementById('zhs-auto-log');
    if (!box) return;
    box.textContent = '';
    state.lines.forEach((line) => {
      const p = document.createElement('div');
      p.textContent = line;
      box.appendChild(p);
    });
    box.scrollTop = box.scrollHeight;
  }

  function buildPanel() {
    if (document.getElementById('zhs-auto-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'zhs-auto-panel';
    panel.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'width:340px', 'max-height:280px',
      'z-index:2147483647', 'background:rgba(22,26,34,.92)', 'color:#e8e8e8',
      'font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'border-radius:10px', 'box-shadow:0 8px 24px rgba(0,0,0,.35)', 'padding:8px 10px',
      'display:flex', 'flex-direction:column', 'gap:6px'
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
    head.innerHTML =
      '<strong style="color:#409eff">智慧树自动学习</strong>' +
      '<span style="display:flex;gap:6px">' +
      '<button data-act="toggle" style="all:unset;cursor:pointer;color:#aaa;font-size:12px">暂停</button>' +
      '<button data-act="next" style="all:unset;cursor:pointer;color:#aaa;font-size:12px">下一节</button>' +
      '<button data-act="quiz" style="all:unset;cursor:pointer;color:#aaa;font-size:12px">处理弹窗</button>' +
      '<button data-act="fold" style="all:unset;cursor:pointer;color:#aaa;font-size:12px">折叠</button>' +
      '</span>';

    const body = document.createElement('div');
    body.id = 'zhs-auto-log';
    body.style.cssText = 'overflow-y:auto;flex:1;white-space:pre-wrap;color:#b9c3cf;max-height:190px;font:12px/1.5 Consolas,Menlo,monospace';

    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
      const act = e.target?.getAttribute?.('data-act');
      if (!act) return;
      if (act === 'toggle') {
        state.paused = !state.paused;
        e.target.textContent = state.paused ? '继续' : '暂停';
        log(state.paused ? '已暂停自动操作' : '已恢复自动操作');
      } else if (act === 'next') {
        goNext();
      } else if (act === 'quiz') {
        if (quizDialog()) handleQuiz();
        else log('当前没有检测到随堂练习弹窗');
      } else if (act === 'fold') {
        body.style.maxHeight = body.style.maxHeight === '24px' ? '190px' : '24px';
      }
    });

    flushLog();
  }

  /* ---------------- 基础工具 ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    (s || '')
      .replace(/\s+/g, '')
      .replace(/[（）()【】\[\]，,。．.、；;：:“”"'‘’_\-.·]/g, '');

  // innerText 在部分环境/隐藏元素上为空，回退到 textContent
  const text = (el) => {
    if (!el) return '';
    const t = el.innerText;
    return typeof t === 'string' && t.trim() ? t : el.textContent || '';
  };

  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        const raw = localStorage.getItem(k);
        return raw == null ? d : JSON.parse(raw);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(k, v);
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    }
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  // 站点风控：播放器 #container 上监听 click，只允许 isTrusted 事件；
  // 合成点击会提示“检测到异常脚本”并在 3 秒后跳回首页。
  // 侧栏点击只派发 MouseEvent（非 PointerEvent）且不冒泡，避开站点的两处 isTrusted 校验。
  function plainClickDirect(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    ['mousedown', 'mouseup', 'click'].forEach((t) => {
      try {
        el.dispatchEvent(
          new MouseEvent(t, { bubbles: false, cancelable: true, view: window, clientX: x, clientY: y })
        );
      } catch (e) {}
    });
    return true;
  }

  function clickEl(el) {
    if (!el) return false;
    if (typeof el.closest === 'function' && el.closest('#container')) {
      log('已跳过播放器内的合成点击（会触发站点异常脚本检测）');
      return false;
    }
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
      try {
        el.dispatchEvent(
          new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })
        );
      } catch (e) {}
    });
    try {
      el.click();
    } catch (e) {}
    return true;
  }

  function keyEscape() {
    try {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
      );
    } catch (e) {}
  }

  /* ================= 诊断：网络观测 ================= */

  const NET_KEYWORDS = [
    'saveLearningDBInTime',
    'queryStuyInfo',
    'queryUserRecruitIdLastVideoId',
    'queryStudiedTimeLimitInfo',
    'prelearningNote',
    'saveStudy'
  ];
  const CORE_NET = [
    'saveLearningDBInTime',
    'queryUserRecruitIdLastVideoId',
    'queryStudiedTimeLimitInfo'
  ];

  function safeJson(t) {
    if (!t || typeof t !== 'string') return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }

  function findKeys(obj, keys, depth = 0, out = {}) {
    if (!obj || typeof obj !== 'object' || depth > 5) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        out[k] = v;
      }
      if (v && typeof v === 'object') findKeys(v, keys, depth + 1, out);
    }
    return out;
  }

  function isNetTarget(url) {
    const u = String(url || '');
    return NET_KEYWORDS.some((k) => u.includes(k));
  }

  function keyOf(url) {
    return NET_KEYWORDS.find((k) => String(url).includes(k)) || 'other';
  }

  function extractResult(text) {
    const json = safeJson(text);
    const keys = findKeys(json, [
      'code', 'errcode', 'errorCode', 'msg', 'message', 'success',
      'canJumpChapter', 'lastViewVideoId', 'videoId', 'chapterId'
    ]);
    return { json: json || null, keys };
  }

  function remember(url, body) {
    const u = String(url);
    const r = extractResult(body);

    if (u.includes('queryStudiedTimeLimitInfo')) {
      const jump = findKeys(r.json, ['canJumpChapter']).canJumpChapter;
      if (jump !== undefined && jump !== state.last.canJumpChapter) {
        state.last.canJumpChapter = jump;
        diag('NET', `canJumpChapter=${jump}`, 1);
      }
    }

    if (u.includes('queryUserRecruitIdLastVideoId')) {
      const id = findKeys(r.json, ['lastViewVideoId', 'videoId']).lastViewVideoId;
      if (id !== undefined && id !== state.last.lastViewVideoId) {
        state.last.lastViewVideoId = id;
        diag('NET', `lastViewVideoId=${id}`, 1);
      }
    }

    if (u.includes('saveLearningDBInTime')) {
      state.last.save = { keys: r.keys, at: ts() };
    }

    if (u.includes('queryStuyInfo')) {
      state.last.studyInfoKeys = r.keys;
    }

    if (Object.keys(r.keys).length) {
      state.last[`resp:${keyOf(u)}`] = r.keys;
    }
  }

  function finishRecord(rec, url, status, body, err) {
    rec.status = status;
    rec.ms = Date.now() - rec.t0;
    rec.bytes = body ? body.length : 0;

    const k = keyOf(url);
    state.inflight[k] = Math.max(0, (state.inflight[k] || 1) - 1);

    const keys = body ? findKeys(safeJson(body), ['code', 'errcode', 'errorCode', 'msg', 'message']) : {};
    rec.code = keys.code ?? keys.errcode ?? keys.errorCode ?? '';
    rec.msg = keys.msg || keys.message || '';
    rec.inflight = state.inflight[k];

    state.records.push(rec);
    if (state.records.length > 300) state.records.shift();

    const mark = rec.code === '' ? '-' : String(rec.code);
    const line =
      `${rec.method} ${k} -> ${status} ${rec.ms}ms code=${mark} inflight=${rec.inflight}` +
      (rec.msg ? ` msg=${rec.msg}` : '') +
      (err ? ` ERR=${err}` : '');

    if (CORE_NET.includes(k)) diag('NET', line, 1);
    else diag('NET', line, 2);

    if (body) {
      remember(url, body);
      if (state.debug >= 2) {
        const snippet = body.length > 260 ? body.slice(0, 260) + '…' : body;
        diag('NET', `  body: ${snippet}`, 2);
      }
    }
  }

  function startNet() {
    if (!W || W.__zhsAutoNetWrapped) return;
    W.__zhsAutoNetWrapped = true;

    const origFetch = W.fetch;
    if (typeof origFetch === 'function') {
      W.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!isNetTarget(url)) return origFetch.apply(W, arguments);

        const method = (init && init.method) || (input && input.method) || 'GET';
        const k = keyOf(url);
        state.inflight[k] = (state.inflight[k] || 0) + 1;
        const rec = { seq: ++state.seq, method, url: String(url), t0: Date.now(), kind: 'fetch' };
        diag('NET', `${method} ${k} => 发送 inflight=${state.inflight[k]}`, 2);

        return origFetch.apply(W, arguments).then(
          async (res) => {
            let body = '';
            try {
              body = await res.clone().text();
            } catch (e) {}
            finishRecord(rec, url, res.status, body, '');
            return res;
          },
          (err) => {
            finishRecord(rec, url, 'FAIL', '', String((err && err.message) || err));
            throw err;
          }
        );
      };
    }

    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        this.__zhs = { method: String(method || 'GET'), url: String(url || '') };
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const meta = this.__zhs;
        if (meta && isNetTarget(meta.url)) {
          const k = keyOf(meta.url);
          state.inflight[k] = (state.inflight[k] || 0) + 1;
          const rec = { seq: ++state.seq, method: meta.method, url: meta.url, t0: Date.now(), kind: 'xhr' };
          diag('NET', `${meta.method} ${k} => 发送 inflight=${state.inflight[k]}`, 2);

          this.addEventListener(
            'loadend',
            () => {
              let body = '';
              try {
                if (this.responseType === 'json') body = JSON.stringify(this.response);
                else if (!this.responseType || this.responseType === 'text') {
                  body = typeof this.responseText === 'string' ? this.responseText : '';
                }
              } catch (e) {}
              finishRecord(rec, meta.url, this.status, body, this.status === 0 ? 'status0/abort' : '');
            },
            { once: true }
          );
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  /* ================= 目录 / 播放器诊断 ================= */

  function isActiveItem(it) {
    return /(^|\s)current(\s|$)/.test(it.className || '');
  }

  function itemFinished(it) {
    return !!it.querySelector(SEL.finishIcon);
  }

  function itemTitle(it) {
    return text(it.querySelector(SEL.itemName) || it).replace(/\s+/g, ' ').trim();
  }

  // 新学习页的目录是两级结构：课时 .chapter-item 下面可能挂小节 .chapter-content-second。
  // 站点只给“真正可播放”的节点绑 onClick（小节点优先），父级课时对带小节的课时不参与播放，
  // 因此必须先把目录拍平成可播放节点，否则会点到没有播放目标的父级上。
  function catalog() {
    const rows = [];
    let i = 0;
    $$(SEL.chapterItem).forEach((lesson) => {
      const smalls = $$(SEL.smallLesson, lesson);
      if (smalls.length) {
        smalls.forEach((s) => {
          rows.push({
            i: i++,
            kind: 'small',
            el: s,
            title: itemTitle(s),
            current: isActiveItem(s),
            finished: itemFinished(s),
            parent: lesson
          });
        });
      } else {
        rows.push({
          i: i++,
          kind: 'lesson',
          el: lesson,
          title: itemTitle(lesson),
          current: isActiveItem(lesson),
          finished: itemFinished(lesson),
          parent: null
        });
      }
    });
    return rows;
  }

  function playableItems() {
    return catalog().map((r) => r.el);
  }

  function currentRows() {
    return catalog().filter((r) => r.current);
  }

  function dumpCatalog(verbose = state.debug >= 2) {
    const rows = catalog();
    const current = rows.filter((r) => r.current);
    const summary =
      `可播放节点 ${rows.length} 个；current 命中 ${current.length} 个：` +
      (current.map((r) => `#${r.i}(${r.kind}) ${r.title}`).join(' | ') || '（无）');
    diag('CAT', summary, 1);
    if (current.length > 1) diag('CAT', '异常：同时有多个节点带 current', 1);

    if (verbose) {
      rows.forEach((r) => {
        rawLog(
          'CAT',
          `#${r.i} ${r.kind} [${r.current ? 'CURRENT' : '-'}] [${r.finished ? 'FINISH' : '-'}]` +
            (r.parent ? ` parentCurrent=${isActiveItem(r.parent)}` : '') +
            ` ${r.title}`
        );
      });
    }

    return rows.map((r) => ({
      i: r.i,
      kind: r.kind,
      title: r.title,
      current: r.current,
      finished: r.finished,
      parentCurrent: r.parent ? isActiveItem(r.parent) : null,
      cls: String(r.el.className || '').slice(0, 120)
    }));
  }

  function playerIds() {
    return ['container', 'vid'];
  }

  function probePlayer() {
    const PS = site('PlayerStarter');
    const able = site('ablePlayerX');
    const out = {
      ablePlayerX: typeof able,
      PlayerStarter: typeof PS,
      ids: {}
    };

    for (const id of playerIds()) {
      const entry = {};
      try {
        const starter = PS && PS.get && PS.get(id);
        entry.starterFound = !!starter;
        if (starter) {
          entry.uuid = starter.uuid;
          entry.hasCallback = !!starter.callback;
          entry.callbackKeys = starter.callback ? Object.keys(starter.callback) : [];
          entry.hasPlayerNext = !!(starter.callback && typeof starter.callback.playerNext === 'function');
          entry.hasPlaybackRate = !!(starter.callback && typeof starter.callback.playbackRate === 'function');
        }
      } catch (e) {
        entry.starterError = String((e && e.message) || e);
      }

      try {
        const api = able && able(id);
        entry.apiFound = !!api;
        if (api) {
          entry.hasObj = !!api.obj;
          entry.apiObjCallbackKeys = api.obj && api.obj.callback ? Object.keys(api.obj.callback) : [];
          entry.apiPlayerNext = !!(api.obj && api.obj.callback && typeof api.obj.callback.playerNext === 'function');
          entry.apiKeys = Object.keys(api).slice(0, 24);
        }
      } catch (e) {
        entry.apiError = String((e && e.message) || e);
      }

      out.ids[id] = entry;
    }

    out.playerArrayLen = PS && Array.isArray(PS.playerArray) ? PS.playerArray.length : null;
    return out;
  }

  function playerSummary(p) {
    const ids = Object.entries(p.ids || {})
      .map(([id, e]) => `${id}:${e.hasPlayerNext ? 'ready' : 'no-playerNext'}`)
      .join(' ');
    return `ablePlayerX=${p.ablePlayerX} PlayerStarter=${p.PlayerStarter} arr=${p.playerArrayLen} ${ids}`;
  }

  function videoInfo() {
    const v = videoEl();
    if (!v) return null;
    return {
      src: (v.currentSrc || v.src || '').slice(0, 200),
      currentTime: Math.round(v.currentTime * 10) / 10,
      duration: Math.round((v.duration || 0) * 10) / 10,
      paused: v.paused,
      rate: v.playbackRate,
      ended: v.ended
    };
  }

  function tips() {
    const nodes = $$('.el-message-box, .el-dialog, .el-message, #captchaYidun');
    return nodes
      .filter((n) => {
        const s = getComputedStyle(n);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })
      .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter(Boolean);
  }

  /* ================= 手动诊断接口 ================= */

  function callPlayerNext() {
    const ids = ['container', 'vid'];
    const notes = [];
    const attempts = [];

    for (const id of ids) {
      try {
        const able = site('ablePlayerX');
        const api = able && able(id);
        if (api && typeof api.exitFullPlay === 'function') api.exitFullPlay();

        const obj = api && api.obj;
        if (obj && obj.callback && typeof obj.callback.playerNext === 'function') {
          obj.callback.playerNext();
          attempts.push({ path: `ablePlayerX(${id}).obj.callback.playerNext`, ok: true });
          return { ok: true, path: `ablePlayerX(${id}).obj`, attempts };
        }
        if (!api) notes.push(`${id}: ablePlayerX 未返回`);
        else if (!api.obj) notes.push(`${id}: api.obj 缺失`);
        attempts.push({ path: `ablePlayerX(${id}).obj.callback.playerNext`, ok: false, reason: 'missing' });
      } catch (e) {
        const reason = String((e && e.message) || e);
        notes.push(`${id}: ablePlayerX 异常 ${reason}`);
        attempts.push({ path: `ablePlayerX(${id}).obj.callback.playerNext`, ok: false, reason });
      }

      try {
        const PS = site('PlayerStarter');
        const obj = PS && PS.get && PS.get(id);
        if (obj && obj.callback && typeof obj.callback.playerNext === 'function') {
          obj.callback.playerNext();
          attempts.push({ path: `PlayerStarter.get(${id}).callback.playerNext`, ok: true });
          return { ok: true, path: `PlayerStarter.get(${id})`, attempts };
        }
        notes.push(`${id}: PlayerStarter.get ${obj ? '回调里没有 playerNext' : '返回 null'}`);
        attempts.push({ path: `PlayerStarter.get(${id}).callback.playerNext`, ok: false, reason: 'missing' });
      } catch (e) {
        const reason = String((e && e.message) || e);
        notes.push(`${id}: PlayerStarter.get 异常 ${reason}`);
        attempts.push({ path: `PlayerStarter.get(${id}).callback.playerNext`, ok: false, reason });
      }
    }

    const PS = site('PlayerStarter');
    return {
      ok: false,
      attempts,
      notes,
      arrayLen: PS && Array.isArray(PS.playerArray) ? PS.playerArray.length : 0,
      ableType: typeof site('ablePlayerX')
    };
  }

  function tryPlayerNext() {
    const r = callPlayerNext();
    rawLog('NEXT', `playerNext 尝试结果：${JSON.stringify(r)}`);
    return r;
  }

  // 侧栏节点点击：MouseEvent 不冒泡（站点只校验 PointerEvent 的 isTrusted）
  function clickNode(i, opts = {}) {
    const rows = catalog();
    const row = rows[i];
    if (!row) {
      rawLog('CLICK', `节点 #${i} 不存在（共 ${rows.length}）`);
      return { ok: false, reason: 'no-such-index' };
    }

    const el = row.el;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const before = currentRows().map((x2) => `#${x2.i}`).join(',');
    const base = {
      clientX: x,
      clientY: y,
      bubbles: !!opts.bubbles,
      cancelable: true,
      view: window,
      button: 0
    };

    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));

    if (opts.title) {
      const t = el.querySelector(SEL.itemName);
      if (t) {
        t.dispatchEvent(new MouseEvent('mousedown', base));
        t.dispatchEvent(new MouseEvent('mouseup', base));
        t.dispatchEvent(new MouseEvent('click', base));
      }
    }

    rawLog(
      'CLICK',
      `点击 #${i} ${row.kind} "${row.title}" bubbles=${!!opts.bubbles}` +
        (r.width ? ` @${x},${y}` : ' 尺寸为0（可能被折叠）') +
        `；点击前 current=${before || '无'}`
    );

    return { ok: true, before, node: { i, kind: row.kind, title: row.title, finished: row.finished } };
  }

  async function clickAndCheck(i, opts = {}) {
    const before = currentRows().map((x) => `#${x.i}`).join(',');
    const res = clickNode(i, opts);
    for (let k = 0; k < 12; k += 1) {
      await sleep(400);
      const now = currentRows().map((x) => `#${x.i}`).join(',');
      if (now !== before) {
        rawLog('CLICK', `切换已生效：current ${before || '无'} -> ${now}（${(k + 1) * 400}ms）`);
        return { ...res, changed: true, after: now, ms: (k + 1) * 400 };
      }
    }
    rawLog('CLICK', `12 次轮询（4.8s）后 current 未变化（仍为 ${before || '无'}）；提示框：${JSON.stringify(tips())}`);
    return { ...res, changed: false };
  }

  async function nextAndCheck(timeoutMs = 12000) {
    const before = currentRows().map((x) => `#${x.i}`).join(',');
    const res = callPlayerNext();
    rawLog('NEXT', `playerNext 尝试结果：${JSON.stringify(res)}`);
    for (let t = 0; t < timeoutMs; t += 500) {
      await sleep(500);
      const now = currentRows().map((x) => `#${x.i}`).join(',');
      if (now !== before) {
        rawLog('NEXT', `切换已生效：current ${before || '无'} -> ${now}（${t + 500}ms）`);
        return { ...res, changed: true, after: now, ms: t + 500 };
      }
    }
    rawLog(
      'NEXT',
      `${timeoutMs}ms 内 current 未变化（仍为 ${before || '无'}）；在途=${JSON.stringify(state.inflight)}；提示框：${JSON.stringify(tips())}`
    );
    return { ...res, changed: false };
  }

  function snapshot() {
    const cur = currentRows();
    return {
      at: ts(),
      current: cur.map((r) => ({ i: r.i, kind: r.kind, title: r.title, finished: r.finished })),
      canJumpChapter: state.last.canJumpChapter ?? 'unknown',
      lastViewVideoId: state.last.lastViewVideoId ?? 'unknown',
      inflight: { ...state.inflight },
      lastSave: state.last.save || null,
      video: videoInfo(),
      tips: tips(),
      player: probePlayer()
    };
  }

  function watch(on = true, ms = 3000) {
    if (state.watchTimer) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
      rawLog('WATCH', '停止');
    }
    if (!on) return;
    rawLog('WATCH', `开始，每 ${ms}ms 打印状态`);
    state.watchTimer = setInterval(() => {
      const s = snapshot();
      rawLog(
        'STATE',
        `cur=${JSON.stringify(s.current)} canJump=${s.canJumpChapter} lastViewVideoId=${s.lastViewVideoId} ` +
          `inflight=${JSON.stringify(s.inflight)} ` +
          `video=${s.video ? `${s.video.currentTime}/${s.video.duration} paused=${s.video.paused}` : 'null'} ` +
          `tips=${JSON.stringify(s.tips)}`
      );
    }, ms);
  }

  /* ================= 自动化：视频与倍速 ================= */

  function videoEl() {
    const inContainer = document.querySelector('#container video, video#vjs_container_html5_api');
    if (inContainer) return inContainer;
    const list = $$('video').filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 200 && r.height > 100;
    });
    return list[0] || null;
  }

  function quizDialog() {
    const d = $(SEL.quizDialog);
    return d && isVisible(d) ? d : null;
  }

  function applyRate() {
    const v = videoEl();
    if (!v) return;
    if (v.playbackRate !== CONFIG.rate) {
      v.playbackRate = CONFIG.rate;
      log(`已设置 ${CONFIG.rate} 倍速`);
    }
    // 弹窗打开时不强行播放，避免答题被打断；其余时间保持播放
    if (v.paused && !quizDialog() && !v.ended) {
      v.play().catch(() => {});
    }
  }

  function setRateByAPI() {
    const v = videoEl();
    if (!v || !v.currentSrc) return;
    if (state.speedTouchedFor === v.currentSrc) return;
    state.speedTouchedFor = v.currentSrc;
    try {
      const PS = site('PlayerStarter');
      const obj = PS && PS.get && PS.get('container');
      if (obj) {
        // 关键：通知页面的 playbackRate 回调，让学习时长计时器 K.value = 1.5，
        // 这样上报给服务器的学习时长也会按 1.5 倍累计，而不只是本地视频加速。
        if (typeof obj.callback?.playbackRate === 'function') {
          obj.callback.playbackRate(CONFIG.rate);
        }
        if (typeof obj.player?.playbackRate === 'function') {
          obj.player.playbackRate(CONFIG.rate);
        }
        v.playbackRate = CONFIG.rate;
        const label = document.querySelector('#container .speedBox > span');
        if (label) label.textContent = `X ${CONFIG.rate === 1 ? '1.0' : CONFIG.rate}`;
        log(`已向平台上报 ${CONFIG.rate} 倍速（学习时长按 ${CONFIG.rate}x 累计）`);
        return;
      }
    } catch (e) {}
    v.playbackRate = CONFIG.rate;
  }

  function bindVideo() {
    const v = videoEl();
    if (!v || state.boundVideo === v) return;
    state.boundVideo = v;
    state.finished = false;

    v.addEventListener('ended', () => {
      log('本节视频播放结束');
      setTimeout(() => {
        if (CONFIG.autoNext) goNext({ fromEnded: true });
      }, 1200);
    });

    v.addEventListener('play', () => {
      setTimeout(applyRate, 200);
    });

    v.addEventListener('ratechange', () => {
      if (v.playbackRate !== CONFIG.rate) setTimeout(() => (v.playbackRate = CONFIG.rate), 50);
    });

    setTimeout(applyRate, 300);
  }

  /* ================= 自动化：随堂练习 ================= */

  function readQuiz(dialog) {
    const items = $$(SEL.quizItem, dialog).filter((i) => i.querySelector('.question-info'));
    return items.map((item) => {
      const type = text(item.querySelector('.type')).trim();
      const q = text(item.querySelector('.question-info')).trim();
      const options = $$('.option', item).map((o) => ({
        letter: text(o.querySelector('.class-question-select')).trim(),
        text: text(o.querySelector('.answer')).trim(),
        el: o
      }));
      return { type, q, options };
    });
  }

  function heuristicAnswer(q, type, options) {
    const t = norm(q);
    // 判断题：题干含否定词时选“错误”，否则选“正确”
    if (/判断/.test(type)) {
      const negative = /不正确|不属于|不符合|不是|不能|错误|失败|无法|不应当|不需要|不可以|不应/.test(t);
      const want = negative ? /错误/ : /正确/;
      const opt = options.find((o) => want.test(norm(o.text)));
      return [opt ? opt.letter : options[0]?.letter].filter(Boolean);
    }

    // 选择题：用题干二元词与选项文本的重合度打分
    const grams = new Set();
    for (let i = 0; i < t.length - 1; i += 1) grams.add(t.slice(i, i + 2));

    const scored = options.map((o) => {
      const ot = norm(o.text);
      let score = 0;
      grams.forEach((g) => {
        if (ot.includes(g)) score += 1;
      });
      return { o, score };
    });

    if (/多选/.test(type)) {
      const max = Math.max(...scored.map((s) => s.score));
      let pick = scored.filter((s) => s.score > 0 && s.score >= Math.max(1, max) * 0.6);
      if (!pick.length) pick = [scored[0]];
      return pick.map((s) => s.o.letter);
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score === 0) {
      // 完全无重合：取文本最长的选项（概念题常见正确项描述更完整）
      const longest = [...options].sort((a, b) => b.text.length - a.text.length)[0];
      return longest ? [longest.letter] : [];
    }
    return [scored[0].o.letter];
  }

  function requestJSON(url, body, timeout) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          timeout,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ai.apiKey}` },
          data: payload,
          onload: (res) => {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(e);
            }
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('请求超时'))
        });
        return;
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ai.apiKey}` },
        body: payload,
        signal: ctrl.signal
      })
        .then((r) => r.json())
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timer));
    });
  }

  async function aiAnswer(q, options) {
    if (!CONFIG.ai.enabled || !CONFIG.ai.apiKey) return null;
    const prompt = [
      '请作答下面的题目，只返回正确选项的字母，多个字母用英文逗号分隔，不要输出其他内容。',
      `题目：${q}`,
      '选项：',
      ...options.map((o) => `${o.letter}. ${o.text}`)
    ].join('\n');

    try {
      const res = await requestJSON(
        CONFIG.ai.endpoint,
        {
          model: CONFIG.ai.model,
          temperature: 0,
          messages: [
            { role: 'system', content: '你是严谨的答题助手，只输出选项字母。' },
            { role: 'user', content: prompt }
          ]
        },
        CONFIG.quizTimeout
      );
      const aiText = res?.choices?.[0]?.message?.content || '';
      const letters = (aiText.toUpperCase().match(/[A-H]/g) || []).filter(
        (l) => options.some((o) => o.letter.toUpperCase() === l)
      );
      return letters.length ? letters : null;
    } catch (e) {
      log(`AI 作答失败，改用本地规则：${e.message}`);
      return null;
    }
  }

  function findSubmit(dialog) {
    const btn = $(SEL.submitBtn, dialog);
    if (btn && /提交|作答|确定/.test(text(btn))) return btn;
    return $$('button', dialog).find((b) => /提交作答|提交|确定/.test(text(b))) || null;
  }

  async function closeQuiz(dialog) {
    if (!dialog) return;
    // 1) 右上角 × / header 关闭按钮
    const closeBtn =
      $('.el-dialog__headerbtn', dialog) ||
      $('.el-dialog__headerclose', dialog) ||
      $('[aria-label="Close"]', dialog) ||
      $('[aria-label="close"]', dialog);
    if (closeBtn) {
      clickEl(closeBtn);
      await sleep(700);
      if (!quizDialog()) return;
    }

    // 2) Escape
    keyEscape();
    await sleep(500);
    if (!quizDialog()) return;

    // 3) 点击弹窗外的遮罩区域（避免点中弹窗本身）
    const rect = dialog.getBoundingClientRect();
    const point = rect.left > 20 ? [10, Math.max(10, rect.top + 10)] : [10, 10];
    const hit = document.elementFromPoint(point[0], point[1]);
    if (hit && !dialog.contains(hit)) {
      clickEl(hit);
      await sleep(500);
      if (!quizDialog()) return;
    }

    // 4) 兜底：强制隐藏弹窗及其遮罩（用户要求必须关闭，避免卡住视频）
    log('弹窗仍未关闭，执行强制隐藏');
    const dlg = quizDialog() || $(SEL.quizDialog);
    if (dlg) {
      const maskDialog = dlg.closest('.el-overlay-dialog');
      const overlay = dlg.closest('.el-overlay');
      dlg.style.display = 'none';
      if (maskDialog) {
        maskDialog.style.display = 'none';
        maskDialog.style.pointerEvents = 'none';
      }
      if (overlay) {
        overlay.style.display = 'none';
        overlay.style.pointerEvents = 'none';
      }
      document.body.style.overflow = '';
    }
  }

  async function closeResultIfAny(dialog) {
    if (!dialog || !isVisible(dialog)) return;
    const btns = $$('button', dialog).filter(
      (b) => /关闭|确定|知道了|完成|继续|返回/.test(text(b)) && isVisible(b)
    );
    if (btns.length) {
      clickEl(btns[0]);
      await sleep(600);
    }
  }

  async function handleQuiz() {
    const dialog = quizDialog();
    if (!dialog) return false;
    if (state.handlingQuiz) return true;

    state.handlingQuiz = true;
    state.quizShownAt = state.quizShownAt || Date.now();

    try {
      log('检测到 AI 随堂练习，开始识别作答');
      const questions = readQuiz(dialog);
      if (!questions.length) {
        log('未解析到题目，直接关闭弹窗');
        await closeQuiz(dialog);
        return true;
      }

      const bank = store.get('zhs_quiz_bank', {});

      for (const q of questions) {
        let letters = null;
        const key = norm(q.q);

        if (bank[key]) letters = Array.isArray(bank[key]) ? bank[key] : [bank[key]];
        if (!letters) letters = await aiAnswer(q.q, q.options);
        if (!letters || !letters.length) letters = heuristicAnswer(q.q, q.type, q.options);

        const chosen = q.options.filter((o) => letters.includes(o.letter));
        const targets = chosen.length ? chosen : [q.options[0]];
        targets.forEach((o) => o.el && clickEl(o.el));

        log(
          `作答：${q.q.slice(0, 30)}${q.q.length > 30 ? '…' : ''} → ${targets
            .map((o) => o.letter)
            .join(',')}`
        );
        await sleep(250);
      }

      const submit = findSubmit(dialog);
      if (submit) {
        clickEl(submit);
        log('已提交作答');
        await sleep(1600);
      } else {
        log('未找到提交按钮');
      }

      await closeResultIfAny($(SEL.quizDialog));
      await closeQuiz(quizDialog() || $(SEL.quizDialog));
      state.quizShownAt = 0;
      log('随堂练习已处理，继续播放');
    } finally {
      state.handlingQuiz = false;
    }

    applyRate();
    return true;
  }

  /* ================= 自动化：下一节 ================= */

  async function waitPlayerReady(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const PS = site('PlayerStarter');
      for (const id of playerIds()) {
        const obj = PS && PS.get && PS.get(id);
        if (obj && obj.callback && typeof obj.callback.playerNext === 'function') return true;
      }
      await sleep(400);
    }
    return false;
  }

  function pageNext() {
    // 站点把“下一节”逻辑挂在播放器回调 playerNext 上，内部就是官方 Ls()；
    // 直接调用可绕过 #container 的 isTrusted 点击校验。
    const r = callPlayerNext();
    if (!r.ok) log(`playerNext 不可用：${JSON.stringify(r)}`);
    return r.ok;
  }

  function videoSrc(v) {
    return v ? v.currentSrc || v.src || '' : '';
  }

  // 与 Autovisor 的 FUSION_CATALOG 对齐：
  // 课时容器 .chapter-item，完成标记 .finish-icon
  function expandCatalog() {
    if (Date.now() - state.lastExpandAt < 15000) return;
    state.lastExpandAt = Date.now();
    try {
      $$('.el-collapse-item').forEach((it) => {
        if (!/\bis-active\b/.test(it.className || '')) {
          const h = it.querySelector('.el-collapse-item__header');
          if (h) clickEl(h);
        }
      });
    } catch (e) {}
  }

  // 站点只用一个 current 类标记“当前播放位置”
  function currentItem(all) {
    return all.find(isActiveItem) || null;
  }

  async function waitForSwitch(beforeEl, beforeSrc, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(500);
      const v = videoEl();
      if (!v) continue;
      const src = videoSrc(v);
      if (v !== beforeEl) return true;
      if (beforeSrc && src && src !== beforeSrc) return true;
      if (beforeSrc && !src) return true;
    }
    return false;
  }

  function activeSignature() {
    const all = playableItems();
    const i = all.findIndex(isActiveItem);
    if (i < 0) return '';
    return `${i}|${itemTitle(all[i])}`;
  }

  async function waitForActiveChange(beforeSig, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(500);
      const sig = activeSignature();
      if (sig && sig !== beforeSig) return true;
    }
    return false;
  }

  // 站点切换前必须先把本节进度上报成功并标记完成（.finish-icon），否则会静默拒绝切换
  async function waitForFinish(it, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!it.isConnected) return false;
      if (itemFinished(it)) return true;
      await sleep(500);
    }
    return false;
  }

  // 冒泡点击标题：兼容监听器绑在标题/父级上的情况
  function plainClickBubbling(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    ['mousedown', 'mouseup', 'click'].forEach((t) => {
      try {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      } catch (e) {}
    });
    return true;
  }

  function closeBlockingTips() {
    if (Date.now() - state.lastTipAt < 2000) return;
    state.lastTipAt = Date.now();
    const boxes = $$('.el-message-box, .el-dialog').filter((b) => isVisible(b));
    for (const b of boxes) {
      const t = text(b);
      if (!/同时播放多个视频|学习时间|网络连接|异常脚本|安全验证|请完成验证|验证码/.test(t)) continue;
      log(`检测到平台提示：${t.replace(/\s+/g, ' ').slice(0, 60)}`);
      if (/安全验证|请完成验证|验证码/.test(t)) {
        log('该提示需要人工验证，自动操作已暂停');
        state.paused = true;
        return;
      }
      const btn = $$('button', b).find((x) => /确定|知道了|关闭|继续|返回|重新/.test(text(x)));
      if (btn) clickEl(btn);
      return;
    }
  }

  // 汇总当前会阻断切换的站点提示（只用于日志与停手，不越过验证）
  function blockReason() {
    const boxes = $$('.el-message-box, .el-dialog, .el-message').filter((b) => isVisible(b));
    for (const b of boxes) {
      const t = text(b).replace(/\s+/g, ' ').trim();
      if (/同时播放多个视频|学习时间|网络连接|安全验证|请完成验证|验证码|异常脚本|Cross-chapter|unfinished video/i.test(t)) {
        return t.slice(0, 120);
      }
    }
    const yidun = $('#captchaYidun');
    if (yidun && yidun.childElementCount && isVisible(yidun)) return '站点验证码（易盾）';
    return '';
  }

  async function goNext(opts = {}) {
    if (state.paused) return false;
    if (state.switching) return true;
    if (Date.now() - state.lastNextAt < 15000) return true;
    state.lastNextAt = Date.now();
    state.switching = true;

    try {
      if (quizDialog()) {
        log('随堂练习弹窗尚未处理，暂不切换');
        return false;
      }

      expandCatalog();
      await sleep(300);

      let all = playableItems();
      let cur = currentItem(all);
      if (!cur) {
        log('未找到当前播放节点（目录可能尚未加载完成）');
        return false;
      }

      // 站点在切换前要先把本节进度上报成功并标记为已完成
      if (!itemFinished(cur)) {
        const waitMs = opts.fromEnded ? 25000 : 3000;
        log(`等待站点标记本节完成（最多 ${Math.round(waitMs / 1000)} 秒）`);
        await waitForFinish(cur, waitMs);
      }
      if (!itemFinished(cur)) {
        const reason = blockReason();
        log(reason ? `本节仍未标记完成，站点提示：${reason}` : '本节仍未标记完成，继续尝试切换');
      }

      const beforeEl = videoEl();
      const beforeSrc = videoSrc(beforeEl);
      const beforeSig = activeSignature();

      // 播放器由站点异步创建（实测目录先渲染、播放器约 1 秒后才注册），先等就绪
      if (!(await waitPlayerReady(8000))) log('播放器 8 秒内仍未就绪，playerNext 可能不可用');

      // 首选官方切换路径：playerNext -> Ls()，自带两级目录与跨章判断
      if (pageNext()) {
        log('已调用播放器 playerNext');
        if (await waitForActiveChange(beforeSig, 12000)) {
          const ok = await waitForSwitch(beforeEl, beforeSrc, 8000);
          log(ok ? '下一节切换成功（playerNext）' : '下一节已高亮，但视频未加载，检查平台提示');
          return ok;
        }
        // 站点进度上报在途时 qt 会直接 return（见 index-OsQXRfDj.js: if (j.value) return）
        await sleep(1500);
        if (pageNext()) {
          log('playerNext 重试一次');
          if (await waitForActiveChange(beforeSig, 6000)) {
            const ok = await waitForSwitch(beforeEl, beforeSrc, 8000);
            log(ok ? '下一节切换成功（playerNext 重试）' : '下一节已高亮，但视频未加载，检查平台提示');
            return ok;
          }
        }
        log('playerNext 未生效，改用目录点击');
      }

      // 兜底：直接点击下一个未完成的“可播放节点”（小节优先）
      // 站点保存进度是异步的，可能在等待期间才真正切换，先确认没有迟到切换
      if (activeSignature() !== beforeSig) {
        log('站点已自行完成切换');
        return true;
      }
      all = playableItems();
      cur = currentItem(all) || cur;
      const pos = all.indexOf(cur);
      if (pos < 0) {
        log('目录已刷新，未能重新定位当前节点');
        return false;
      }

      const target = all.slice(pos + 1).find((it) => !itemFinished(it));
      if (!target) {
        log('目录中已没有未完成的下一个节点');
        return false;
      }

      const titleEl = target.querySelector(SEL.itemName) || target;
      try {
        target.scrollIntoView({ block: 'center' });
      } catch (e) {}
      log(`当前：${beforeSig ? beforeSig.split('|')[1] : '未识别'}；点击：${itemTitle(target).slice(0, 40)}`);

      // 侧栏不在 #container 内，合成 MouseEvent 不触发站点 isTrusted 校验；
      // 不冒泡可避免冒泡到父级课时上触发另一次切换
      plainClickDirect(target);
      if (await waitForActiveChange(beforeSig, 8000)) {
        const ok = await waitForSwitch(beforeEl, beforeSrc, 12000);
        log(ok ? '下一节切换成功（目录点击）' : '高亮已切换，但视频未加载，检查平台提示');
        return ok;
      }

      // 若这一次点击正好落在保存请求在途窗口，站点会静默丢弃（qt: if (j.value) return）
      log('目录点击未生效，1.2 秒后重试一次');
      await sleep(1200);
      plainClickDirect(target);
      if (await waitForActiveChange(beforeSig, 5000)) {
        const ok = await waitForSwitch(beforeEl, beforeSrc, 12000);
        log(ok ? '下一节切换成功（目录点击重试）' : '高亮已切换，但视频未加载，检查平台提示');
        return ok;
      }

      log('目录点击未生效，尝试冒泡点击标题');
      plainClickBubbling(titleEl);
      if (await waitForActiveChange(beforeSig, 8000)) {
        const ok = await waitForSwitch(beforeEl, beforeSrc, 12000);
        log(ok ? '下一节切换成功（标题点击）' : '高亮已切换，但视频未加载，检查平台提示');
        return ok;
      }

      const reason = blockReason();
      if (reason) log(`切换未生效，站点提示：${reason}`);
      else log('切换未生效：进度上报失败（多视频同时播放 / 易盾验证码 / 网络异常）或跨章限制');
      closeBlockingTips();
      return false;
    } finally {
      state.switching = false;
    }
  }

  /* ================= 主循环 ================= */

  function tick() {
    if (state.paused) return;
    bindVideo();
    applyRate();
    setRateByAPI();

    // 弹窗兜底：长时间未处理则强制关闭
    if (quizDialog() && !state.handlingQuiz) {
      if (!state.quizShownAt) state.quizShownAt = Date.now();
      if (Date.now() - state.quizShownAt > CONFIG.quizTimeout) {
        log('弹窗停留过久，强制关闭');
        closeQuiz(quizDialog());
        state.quizShownAt = 0;
        setTimeout(applyRate, 500);
      } else {
        handleQuiz();
      }
    } else if (!quizDialog()) {
      state.quizShownAt = 0;
    }

    // 自动识别并关闭平台的阻塞提示（多视频同时播放、学习时间结束、网络异常等）
    closeBlockingTips();
  }

  function start() {
    log('脚本已启动：1.5 倍速 / 自动答题 / 自动下一节');

    // 1) 秒级守护：保持倍速与播放
    setInterval(tick, 1000);

    // 2) 每 5 分钟巡检一次随堂问答
    setInterval(() => {
      if (state.paused) return;
      log('5 分钟巡检：检查随堂问答');
      if (quizDialog()) handleQuiz();
      else applyRate();
    }, CONFIG.checkInterval);

    // 3) DOM 变化即时发现弹窗（不必等到 5 分钟）
    let debounce = null;
    const observer = new MutationObserver(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!state.paused && quizDialog() && !state.handlingQuiz) handleQuiz();
      }, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 4) 页面重新可见时校正倍速
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) setTimeout(applyRate, 500);
    });

    // 进入页面时：当前可播放节点已完成则自动进入下一节
    setTimeout(() => {
      if (!CONFIG.autoNext) return;
      expandCatalog();
      const cur = currentItem(playableItems());
      if (cur && itemFinished(cur)) {
        log('检测到当前节点已完成，自动切换下一节');
        goNext();
      }
    }, 6000);

    setTimeout(tick, 800);
  }

  /* ================= 对外接口 ================= */

  const zhsApi = {
    config: CONFIG,
    bank: {
      get: () => store.get('zhs_quiz_bank', {}),
      set: (obj) => store.set('zhs_quiz_bank', obj),
      clear: () => store.set('zhs_quiz_bank', {})
    },
    next: goNext,
    nextCheck: nextAndCheck,
    nextRaw: tryPlayerNext,
    handleQuiz,
    log,
    diag,
    net: state,
    dump: () => dumpCatalog(true),
    probe: () => {
      const p = probePlayer();
      rawLog('PLAYER', JSON.stringify(p));
      return p;
    },
    snapshot: () => {
      const s = snapshot();
      rawLog('SNAP', JSON.stringify(s));
      return s;
    },
    clickNode,
    clickAndCheck,
    clickTitle: (i) => clickAndCheck(i, { title: true, bubbles: true }),
    watch,
    tips,
    videoInfo,
    catalog
  };

  // 诊断级别：赋值 true/false/0/1/2/'verbose' 均可；默认 1（关键诊断，低噪音）
  Object.defineProperty(zhsApi, 'debug', {
    enumerable: true,
    get() {
      return state.debug;
    },
    set(v) {
      state.debug = normalizeDebug(v);
      rawLog('BOOT', `诊断级别=${state.debug}（0=关闭，1=关键，2=详细）`);
    }
  });

  window.zhsAuto = zhsApi;
  try {
    if (W !== window) W.zhsAuto = zhsApi;
  } catch (e) {}

  /* ================= 启动 ================= */

  // 网络观测必须在页面脚本发请求之前安装，因此 @run-at document-start
  startNet();

  function boot() {
    if (!document.body) {
      setTimeout(boot, 200);
      return;
    }

    buildPanel();

    diag('BOOT', `合并版 1.8.0 已注入 @ ${location.href}；诊断级别=${state.debug}（0=关闭，1=关键，2=详细）`, 1);
    diag(
      'BOOT',
      '可用：zhsAuto.next() / .nextRaw() / .nextCheck() / .dump() / .snapshot() / .probe() / .watch() / .clickNode(i)；zhsAuto.debug=false 关闭诊断',
      2
    );
    if (/studyh5\.zhihuishu\.com/.test(location.hostname)) {
      diag('BOOT', '旧版学习页：目录结构与新页不同，自动切换仅按兼容逻辑尝试', 1);
    }

    start();

    // 页面就绪后自检一次，不影响站点逻辑
    setTimeout(() => {
      try {
        dumpCatalog(false);
      } catch (e) {
        diag('BOOT', `目录自检异常：${(e && e.message) || e}`, 1);
      }
    }, 2500);

    setTimeout(() => {
      try {
        const p = probePlayer();
        if (state.debug >= 2) rawLog('PLAYER', JSON.stringify(p));
        else diag('PLAYER', playerSummary(p), 1);
      } catch (e) {
        diag('BOOT', `播放器自检异常：${(e && e.message) || e}`, 1);
      }
    }, 4200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
