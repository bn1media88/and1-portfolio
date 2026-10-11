(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STORE = 'landing-an-ngu:content';
  let BASE = window.SITE_CONTENT; // cập nhật sau mỗi lần lưu vào content.js
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canHover = matchMedia('(hover: hover)').matches;
  // Có serve.py (mở bằng "Mo trang.bat") thì bấm Xong ghi thẳng vào file
  const server = location.protocol.startsWith('http')
    // Kiểm tra cả nội dung: hosting kiểu SPA trả index.html (200) cho mọi đường dẫn -> không được tưởng là có serve.py
    ? fetch('api/ping', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.ok === true)
      .catch(() => false)
    : Promise.resolve(false);

  let content = load();
  let editing = false;

  // ---------- Lưu / đọc nội dung ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s && s.text) {
        const c = { ...clone(BASE), ...s, text: { ...BASE.text, ...s.text } };
        // Thể loại mới thêm vào content.js -> vẫn hiện dù đang có bản nháp (trừ thể loại đã tự xóa)
        c.categories ||= [];
        const have = new Set(c.categories.map((x) => x.id));
        const removed = new Set(c.removedCats || []);
        (BASE.categories || []).forEach((x) => { if (!have.has(x.id) && !removed.has(x.id)) c.categories.push(clone(x)); });
        return c;
      }
    } catch { /* bộ nhớ bị chặn hoặc hỏng -> dùng mặc định */ }
    return clone(BASE);
  }

  // Việc tải file đang chạy -> bấm "Xong" phải đợi xong mới ghi content.js (không thì thiếu video)
  const uploads = new Set();
  const track = (p) => {
    uploads.add(p);
    p.finally(() => uploads.delete(p)).catch(() => {});
    return p;
  };

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify(content));
        flash('Đã lưu nháp');
      } catch {
        flash('Trình duyệt chặn lưu dữ liệu');
      }
    }, 300);
  }

  let flashTimer;
  function flash(msg, ms = 2200) {
    const el = $('#saveStatus');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(flashTimer);
    if (ms) flashTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  const getP = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), content);
  const setP = (path, v) => {
    const ks = path.split('.');
    const last = ks.pop();
    ks.reduce((o, k) => o[k], content)[last] = v;
  };

  // Chỉ giữ chữ, <em>, <strong>, <br> -> không lẫn định dạng rác khi dán/sửa
  function clean(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const walk = (node) => {
      let out = '';
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { out += esc(n.textContent); return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        const inner = walk(n);
        if (tag === 'BR') out += '<br>';
        else if (tag === 'EM' || tag === 'I') out += inner && `<em>${inner}</em>`;
        else if (tag === 'STRONG' || tag === 'B') out += inner && `<strong>${inner}</strong>`;
        else if (tag === 'DIV' || tag === 'P') out += (out && !out.endsWith('<br>') ? '<br>' : '') + inner;
        else out += inner;
      });
      return out;
    };
    return walk(tpl.content).replace(/(<br>)+$/, '');
  }

  // ---------- IndexedDB: giữ file video tải lên ----------
  const idb = (() => {
    let dbp;
    const open = () => (dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open('landing-an-ngu-media', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('files', mode);
        const req = fn(t.objectStore('files'));
        t.oncomplete = () => res(req.result);
        t.onerror = () => rej(t.error);
        // Hết dung lượng (video lớn): giao dịch bị hủy mà không có sự kiện error -> không bắt thì treo mãi
        t.onabort = () => rej(t.error || new Error('Giao dịch IndexedDB bị hủy'));
      });
    };
    return {
      get: (k) => run('readonly', (s) => s.get(k)),
      put: (k, v) => run('readwrite', (s) => s.put(v, k)),
      del: (k) => run('readwrite', (s) => s.delete(k)),
      clear: () => run('readwrite', (s) => s.clear()),
    };
  })();

  // Video trên Cloudflare R2: config.js đặt VIDEO_BASE_URL -> "videos/..." phát từ "<VIDEO_BASE_URL>/videos/...".
  // Để trống -> phát từ thư mục videos/ đi kèm website. Link đầy đủ (https://...) giữ nguyên.
  const VIDEO_BASE = String(window.VIDEO_BASE_URL || '').trim().replace(/\/+$/, '');
  const videoUrl = (src) => (VIDEO_BASE && /^videos\//i.test(src) ? `${VIDEO_BASE}/${src}` : src);

  const blobUrls = new Map();
  async function urlOf(m) {
    if (!m) return '';
    if (m.idb) {
      if (blobUrls.has(m.idb)) return blobUrls.get(m.idb);
      try {
        const rec = await idb.get(m.idb);
        if (rec) {
          const u = URL.createObjectURL(rec.blob);
          blobUrls.set(m.idb, u);
          return u;
        }
      } catch { /* file đã mất */ }
      return '';
    }
    return videoUrl(m.src || '');
  }
  function forget(m) {
    if (!m?.idb) return;
    idb.del(m.idb).catch(() => {});
    if (blobUrls.has(m.idb)) URL.revokeObjectURL(blobUrls.get(m.idb));
    blobUrls.delete(m.idb);
  }
  // ---------- Khung video ----------
  async function mountMedia(slot) {
    const url = await urlOf(getP(slot.dataset.media));
    const el = $('video.media', slot);
    const msg = $('.slot-msg', slot);
    slot.classList.remove('is-broken');
    slot.classList.toggle('is-empty', !url);
    msg.textContent = 'No video yet';
    el.onerror = () => {
      if (!url) return;
      slot.classList.add('is-broken');
      msg.textContent = 'Video unavailable';
    };
    if (!url) { el.removeAttribute('src'); el.load(); return; }
    // #t=0.1 để trình duyệt hiện khung hình đầu làm ảnh bìa
    el.src = url.includes('#') ? url : `${url}#t=0.1`;
    if (slot.dataset.autoplay != null && slot._visible && !reduceMotion) el.play().catch(() => {});
  }

  function setupSlot(slot, { removable = null } = {}) {
    const msg = document.createElement('div');
    msg.className = 'slot-msg';
    slot.append(msg);

    const tools = document.createElement('div');
    tools.className = 'media-tools edit-only';
    tools.innerHTML =
      '<button type="button" data-act="upload">Tải video lên</button>' +
      '<button type="button" data-act="link">Dán link</button>' +
      (removable != null ? '<button type="button" data-act="remove" class="danger">Xóa dự án</button>' : '');
    tools.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'upload') pickFile(slot);
      if (act === 'link') pasteLink(slot);
      if (act === 'remove') removeProject(removable);
    });
    slot.append(tools);

    if (slot.dataset.autoplay != null) autoplayObserver.observe(slot);
    const amb = slot.parentElement.querySelector(':scope > .ambient');
    if (amb) attachAmbient(amb, slot);
    return mountMedia(slot);
  }

  function replaceMedia(path, m) {
    forget(getP(path));
    setP(path, m);
    save();
    // Tìm lại khung theo đường dẫn: danh sách dự án có thể đã vẽ lại trong lúc chờ
    const slot = $$('[data-media]').find((s) => s.dataset.media === path);
    if (slot) mountMedia(slot);
  }

  // Nhớ media thuộc object nào (không theo chỉ số): xóa/thêm dự án trong lúc tải lên thì video không gắn nhầm dự án khác
  function mediaRef(path) {
    const ks = path.split('.');
    const key = ks.pop();
    return { obj: ks.reduce((o, k) => o?.[k], content), key };
  }
  function pathOf(ref) {
    if (ref.obj === content) return ref.key; // hero
    const i = content.projects.indexOf(ref.obj);
    return i < 0 ? null : `projects.${i}.${ref.key}`;
  }

  function pickFile(slot) {
    const input = $('#filePick');
    const ref = mediaRef(slot.dataset.media);
    input.onchange = async () => {
      const f = input.files[0];
      input.value = '';
      if (!f) return;
      if (await server) {
        // Mở qua "Mo trang.bat": chép thẳng file vào videos/
        try {
          flash(`Đang tải lên ${f.name}…`, 0);
          const { src } = await track(uploadToServer(f, f.name));
          const path = pathOf(ref);
          if (!path) return flash('Dự án đã bị xóa trong lúc tải lên — bỏ qua video này', 4000);
          replaceMedia(path, { src });
          flash(`Đã thay: ${f.name}`);
        } catch (e) {
          flash('Tải lên lỗi: ' + e.message, 5000);
        }
        return;
      }
      const key = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try {
        await idb.put(key, { blob: f, name: f.name });
      } catch {
        flash('Không lưu được file (video quá nặng?) — dùng "Dán link" thay thế', 5000);
        return;
      }
      const path = pathOf(ref);
      if (!path) {
        idb.del(key).catch(() => {});
        return flash('Dự án đã bị xóa trong lúc tải lên — bỏ qua video này', 4000);
      }
      replaceMedia(path, { idb: key, name: f.name });
      flash(`Đã thay: ${f.name}`);
    };
    input.click();
  }

  function pasteLink(slot) {
    const cur = getP(slot.dataset.media);
    const v = prompt('Dán đường dẫn video\n(vd: videos/phim-1.mp4 hoặc https://.../video.mp4)', cur?.src || '');
    if (v == null) return;
    replaceMedia(slot.dataset.media, { src: v.trim() });
  }

  // Phát/ dừng video đầu trang theo việc có trong màn hình hay không
  const autoplayObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      target._visible = isIntersecting;
      const v = $('video.media', target);
      if (!v || !v.getAttribute('src')) return;
      if (isIntersecting && !reduceMotion && !target.classList.contains('is-paused')) v.play().catch(() => {});
      else if (!isIntersecting) v.pause();
    });
  }, { threshold: 0.25 });

  // ---------- Ánh sáng môi trường quanh video (kiểu "ambient mode" của YouTube) ----------
  // Vẽ khung hình hiện tại của video vào 1 canvas rất nhỏ; CSS làm nhoè + phóng to -> viền toả sáng đúng màu đang chiếu.
  // Các canvas nằm trong 1 lớp riêng ngay trên nền xanh (ngoài mọi khung), mỗi khung hình đặt theo vị trí video
  // -> ánh sáng loang tự do ra nền, không bị khung hàng / dải cuộn cắt cụt ở mép.
  const ambLayer = document.createElement('div');
  ambLayer.className = 'ambient-layer';
  ambLayer.setAttribute('aria-hidden', 'true');
  $('#bgWaves').after(ambLayer);
  const ambients = new Map(); // canvas -> khung video (slot)
  const ambBySlot = new Map(); // khung video -> canvas
  const ambVisible = new Set(); // canvas của video đang ở gần màn hình
  // Ánh sáng chỉ bật cho video đang được trỏ chuột (máy tính) hoặc vừa được chạm (điện thoại)
  const lit = new Set();
  function setLit(slot, on) {
    if (on === lit.has(slot)) return;
    if (on) lit.add(slot);
    else lit.delete(slot);
    const cv = ambBySlot.get(slot);
    if (on && cv) paintAmbient(cv); // có màu ngay từ khung hình đầu khi bắt đầu hiện
    wakeAmbients();
  }
  // Điện thoại: chạm ra ngoài video thì tắt ánh sáng
  if (!canHover) {
    addEventListener('pointerdown', (e) => {
      if (!e.target.closest?.('.thumb, .player')) [...lit].forEach((s) => setLit(s, false));
    }, { passive: true, capture: true });
  }
  const ambObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      const cv = ambBySlot.get(target);
      if (!cv) return;
      if (isIntersecting) ambVisible.add(cv);
      else { ambVisible.delete(cv); cv.style.opacity = '0'; lit.delete(target); }
    });
    wakeAmbients();
  }, { rootMargin: '160px' });

  function paintAmbient(cv) {
    const v = $('video.media', ambients.get(cv));
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    try { cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height); } catch { /* video chưa sẵn sàng */ }
  }
  function attachAmbient(cv, slot) {
    const hero = slot.id === 'player';
    // Ảnh mẫu lớn hơn chút -> phóng to đã mịn, chỉ cần làm nhoè ít (nhẹ GPU hơn nhiều)
    cv.width = hero ? 48 : 24;
    cv.height = hero ? 22 : 42;
    cv.classList.toggle('is-hero', hero);
    cv.style.opacity = '0';
    ambLayer.append(cv);
    ambients.set(cv, slot);
    ambBySlot.set(slot, cv);
    ambObserver.observe(slot);
    // Video đứng yên (chưa chạy / vừa dừng xem trước) vẫn có ánh sáng theo khung hình đang hiện
    ['loadeddata', 'seeked', 'pause'].forEach((ev) => slot.addEventListener(ev, () => paintAmbient(cv), true));
    if (canHover) {
      // Máy tính: rê chuột vào video (hoặc cả thẻ, gồm tên bên dưới) thì sáng, rời ra thì tắt
      const host = slot.closest('.card') || slot;
      host.addEventListener('pointerenter', () => setLit(slot, true));
      host.addEventListener('pointerleave', () => setLit(slot, false));
    } else {
      // Điện thoại: chạm vào video nào thì video đó sáng (video khác tắt)
      slot.addEventListener('pointerdown', () => {
        [...lit].forEach((s) => { if (s !== slot) setLit(s, false); });
        setLit(slot, true);
      }, { passive: true });
    }
  }
  function detachAmbient(cv) {
    const slot = ambients.get(cv);
    if (slot) { ambObserver.unobserve(slot); ambBySlot.delete(slot); }
    ambVisible.delete(cv);
    if (slot) lit.delete(slot);
    ambients.delete(cv);
    cv.remove();
  }
  // Cập nhật màu 10 lần/giây — chỉ cho video đang sáng và đang chạy (video khác không tốn gì)
  setInterval(() => {
    if (document.hidden || !lit.size) return;
    lit.forEach((slot) => {
      const cv = ambBySlot.get(slot);
      const v = $('video.media', slot);
      if (cv && v && !v.paused) paintAmbient(cv);
    });
  }, 100);
  // Đặt quầng sáng đúng chỗ video. Chỉ chạy theo từng khung hình khi có gì đó đang chuyển động
  // (cuộn, gạt carousel, rê chuột, hiệu ứng thẻ...), trang đứng yên thì nghỉ hẳn -> không tốn CPU.
  let ambBusyUntil = 0;
  let ambRunning = false;
  const wakeAmbients = () => {
    ambBusyUntil = performance.now() + 750; // đủ cho hiệu ứng chuyển của thẻ (0.6s) chạy xong
    if (!ambRunning) { ambRunning = true; requestAnimationFrame(placeAmbients); }
  };
  ['scroll', 'resize', 'pointerover', 'pointerout', 'transitionrun', 'animationstart'].forEach((ev) =>
    addEventListener(ev, wakeAmbients, { passive: true, capture: true }));
  function placeAmbients() {
    ambVisible.forEach((cv) => {
      const slot = ambients.get(cv);
      if (!slot?.isConnected) { detachAmbient(cv); return; }
      const r = slot.getBoundingClientRect();
      // Phần video bị dải cuộn che -> ánh sáng mờ theo tỉ lệ phần còn thấy (không có "ánh sáng ma")
      let f = 1;
      const clip = slot.closest('.track');
      if (clip) {
        const c = clip.getBoundingClientRect();
        f = Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)) / (r.width || 1);
      }
      const hero = cv.classList.contains('is-hero');
      const on = lit.has(slot);
      // Không sáng và đã tắt hẳn -> bỏ qua (vẫn đi theo video trong lúc đang mờ dần)
      const now = performance.now();
      if (!on && cv.style.opacity === '0' && now > (cv._fadeEnd || 0)) return;
      if (!on && cv.style.opacity !== '0') cv._fadeEnd = now + 900;
      const scale = hero ? 1.05 : 1.12;
      const alpha = on ? (hero ? 0.85 : 1) * f ** 1.5 : 0;
      // hiện ra nhanh hơn một chút, tắt chậm hơn -> cảm giác mềm, không giật
      const dur = on ? '.6s' : '.9s';
      if (cv.style.transitionDuration !== dur) cv.style.transitionDuration = dur;
      const wpx = `${r.width}px`;
      const hpx = `${r.height}px`;
      if (cv.style.width !== wpx) cv.style.width = wpx;
      if (cv.style.height !== hpx) cv.style.height = hpx;
      cv.style.transform = `translate3d(${r.left}px, ${r.top}px, 0) scale(${scale})`;
      const op = alpha.toFixed(3);
      if (cv.style.opacity !== op) cv.style.opacity = op;
    });
    if (performance.now() < ambBusyUntil) requestAnimationFrame(placeAmbients);
    else ambRunning = false;
  }
  wakeAmbients();
  // video mới vào/ra màn hình cũng cần đặt lại vị trí
  new MutationObserver(wakeAmbients).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  // ---------- Nền xanh: các dải sáng lượn liên tục (vẽ bằng canvas theo tốc độ màn hình) ----------
  (() => {
    const cv = $('#bgWaves');
    // alpha:false = nền đặc, trình duyệt ghép hình nhanh hơn
    const ctx = cv?.getContext('2d', { alpha: false });
    if (!ctx) return;
    let w = 0;
    let h = 0;
    let base;
    let vignette;

    const resize = () => {
      // Vẽ đủ độ phân giải màn hình cho nét (tối đa 2x để màn hình siêu nét không quá nặng)
      const k = Math.min(devicePixelRatio || 1, 2);
      w = innerWidth;
      h = innerHeight;
      cv.width = Math.max(1, Math.round(w * k));
      cv.height = Math.max(1, Math.round(h * k));
      ctx.setTransform(k, 0, 0, k, 0, 0);
      // Nền xanh navy đậm, giữa sáng hơn chút; đủ tối để chữ trắng và video nổi rõ
      base = ctx.createLinearGradient(0, 0, w, h);
      base.addColorStop(0, '#020a30');
      base.addColorStop(0.45, '#06216e');
      base.addColorStop(0.75, '#04185a');
      base.addColorStop(1, '#010620');
      vignette = ctx.createRadialGradient(w * 0.55, h * 0.45, Math.min(w, h) * 0.15, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
      vignette.addColorStop(0, 'rgba(1,5,25,0)');
      vignette.addColorStop(1, 'rgba(1,4,18,.7)');
    };

    // Mỗi dải: 4 điểm đặt theo tỉ lệ màn hình, dao động chậm theo sin -> đường cong tự đổi hình mượt mà.
    // w: độ dày lõi sáng, glow: độ rộng quầng sáng, c: màu (r,g,b), a: độ sáng
    // amp: biên độ lượn (tỉ lệ màn hình), sp: tốc độ (rad/giây) — 0.4 ≈ một nhịp lượn ~15 giây
    const ribbons = [
      { p: [[-0.15, 0.78], [0.22, 0.42], [0.5, 0.08], [0.78, -0.08]], amp: 0.14, sp: 0.38, ph: 0.0, w: 2, glow: 120, c: [60, 170, 255], a: 0.6 },
      { p: [[0.18, 1.05], [0.42, 0.62], [0.55, 0.12], [1.1, 0.06]], amp: 0.12, sp: 0.46, ph: 1.7, w: 1.5, glow: 70, c: [80, 225, 255], a: 0.85 },
      { p: [[-0.1, 0.72], [0.35, 1.0], [0.75, 0.82], [1.12, 0.48]], amp: 0.13, sp: 0.42, ph: 3.1, w: 2.2, glow: 110, c: [70, 210, 255], a: 0.8 },
      { p: [[-0.1, 0.45], [0.3, 0.28], [0.7, 0.3], [1.1, 0.12]], amp: 0.16, sp: 0.33, ph: 4.4, w: 1.1, glow: 90, c: [40, 130, 255], a: 0.45 },
      { p: [[0.5, 1.1], [0.72, 0.7], [0.82, 0.32], [1.15, 0.22]], amp: 0.13, sp: 0.5, ph: 5.6, w: 1.3, glow: 80, c: [50, 160, 255], a: 0.5 },
    ];
    // Các lớp nét vẽ chồng nhau tạo quầng sáng mềm (không dùng shadowBlur cho nhẹ máy)
    const passes = [[1, 0.035], [0.45, 0.07], [0.12, 0.16], [0, 0.9]];

    const draw = (t) => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const r of ribbons) {
        // Mỗi điểm dao động với nhịp riêng (k) -> đường cong uốn lượn, đổi hình liên tục
        const pts = r.p.map(([x, y], k) => [
          (x + r.amp * Math.sin(t * r.sp * (1 + k * 0.17) + r.ph + k * 1.3)) * w,
          (y + r.amp * Math.cos(t * r.sp * (0.8 + k * 0.13) + r.ph + k * 0.9)) * h,
        ]);
        const [p0, p1, p2, p3] = pts;
        for (const [glowK, alpha] of passes) {
          const g = ctx.createLinearGradient(p0[0], p0[1], p3[0], p3[1]);
          const col = (a) => `rgba(${r.c[0]},${r.c[1]},${r.c[2]},${a})`;
          const a = alpha * r.a;
          g.addColorStop(0, col(0));
          g.addColorStop(0.25, col(a));
          g.addColorStop(0.6, col(a));
          g.addColorStop(1, col(0));
          ctx.strokeStyle = g;
          ctx.lineWidth = glowK ? r.glow * glowK : r.w;
          ctx.beginPath();
          ctx.moveTo(p0[0], p0[1]);
          ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
    };

    resize();
    addEventListener('resize', () => { resize(); if (reduceMotion) draw(8); });
    if (reduceMotion) { draw(8); return; } // giảm chuyển động: vẽ 1 khung đứng yên

    // Chạy theo tốc độ làm tươi của màn hình (thường 60 khung/giây) cho mượt nhất; tab ẩn thì dừng
    const loop = (now) => {
      draw(now / 1000);
      if (!document.hidden) requestAnimationFrame(loop);
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(loop); });
    requestAnimationFrame(loop);
  })();

  // Gắn .is-in một lần khi phần tử cuộn vào màn hình (bottom: lề dưới, vd '-8%' = phải lên khỏi đáy 8%)
  const onceVisible = (bottom) => new IntersectionObserver((entries, obs) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      target.classList.add('is-in');
      obs.unobserve(target);
    });
  }, { rootMargin: `0px 0px ${bottom} 0px` });

  // ---------- Hiện dần khi cuộn tới (hiệu ứng chỉ bật trên điện thoại — xem style.css) ----------
  const revealObserver = onceVisible('-8%');
  const reveal = (els) => els.forEach((el) => { el.classList.add('reveal'); revealObserver.observe(el); });

  // ---------- Chữ tiêu đề: tách từng từ để từng chữ trồi lên lần lượt khi cuộn tới (CSS: .split / .is-in) ----------
  // Đang chỉnh sửa thì trả về chữ thường (gõ trong các thẻ <span> tách từ rất khó chịu).
  const TITLES = '.about-title, .display, .h2, .row-title, .eyebrow';
  const titleObserver = onceVisible('-10%');

  function splitTitle(el, animate) {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 1) return walk(n); // giữ <em>, <strong>, <br>
        if (n.nodeType !== 3 || !n.textContent.trim()) return;
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (!part.trim()) return frag.append(part);
          const w = document.createElement('span');
          const wi = document.createElement('span');
          w.className = 'w';
          wi.className = 'wi';
          wi.style.setProperty('--i', i++);
          wi.textContent = part;
          w.append(wi);
          frag.append(w);
        });
        n.replaceWith(frag);
      });
    };
    walk(el);
    el.classList.add('split');
    if (animate) titleObserver.observe(el);
    else el.classList.add('is-in');
  }
  function splitTitles(root = document, animate = true) {
    $$(TITLES, root).forEach((el) => {
      titleObserver.unobserve(el);
      el.classList.remove('split', 'is-in');
      el.innerHTML = clean(getP(el.dataset.edit) ?? '');
      splitTitle(el, animate);
    });
  }
  function unsplitTitles() {
    $$('.split').forEach((el) => {
      titleObserver.unobserve(el);
      el.classList.remove('split', 'is-in');
      el.innerHTML = clean(getP(el.dataset.edit) ?? '');
    });
  }

  // ---------- Chữ ----------
  function fillTexts(root = document) {
    $$('[data-edit]', root).forEach((el) => { el.innerHTML = clean(getP(el.dataset.edit) ?? ''); });
  }
  function applyEditing(root = document) {
    $$('[data-edit]', root).forEach((el) => {
      if (editing) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
  }

  document.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-edit]');
    if (!el || !editing) return;
    setP(el.dataset.edit, clean(el.innerHTML));
    save();
  });
  document.addEventListener('focusout', (e) => {
    const el = e.target.closest?.('[data-edit]');
    if (el && editing) el.innerHTML = clean(getP(el.dataset.edit));
  });
  document.addEventListener('keydown', (e) => {
    if (!editing || e.key !== 'Enter' || !e.target.closest?.('[data-edit]')) return;
    e.preventDefault();
    document.execCommand('insertLineBreak');
  });
  document.addEventListener('paste', (e) => {
    if (!editing || !e.target.closest?.('[data-edit]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  // Đang sửa thì bấm vào link không nhảy trang
  document.addEventListener('click', (e) => {
    if (editing && e.target.closest('a')) e.preventDefault();
  }, true);

  // ---------- Hero player ----------
  const fmt = (s) => {
    s = Math.floor(s || 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  function initHero() {
    const p = $('#player');
    const v = $('video', p);
    const bar = $('.bar', p);
    const prog = $('.progress', p);
    const soundLbl = $('.sound-label', p);
    let full = false; // đang xem thật (có tiếng) hay chỉ chạy preview

    const syncSound = () => {
      p.classList.toggle('is-unmuted', !v.muted);
      soundLbl.textContent = v.muted ? 'Unmute' : 'Mute';
    };
    const toPreview = () => {
      full = false;
      v.loop = true;
      v.muted = true;
      p.classList.remove('is-full', 'is-paused');
      if (!reduceMotion && p._visible) v.play().catch(() => {});
    };
    const startFull = () => {
      if (!v.getAttribute('src')) return;
      full = true;
      v.loop = false;
      v.currentTime = 0;
      v.muted = false;
      p.classList.add('is-full');
      p.classList.remove('is-paused');
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    };
    const toggle = () => {
      if (!full) return startFull();
      v.paused ? v.play() : v.pause();
    };

    $('.big-play', p).addEventListener('click', (e) => {
      if (editing && e.target.closest('[data-edit]')) return;
      full ? v.play() : startFull();
    });
    v.addEventListener('click', () => { if (!editing) toggle(); });
    $('.toggle', p).addEventListener('click', toggle);
    $('.sound', p).addEventListener('click', () => { v.muted = !v.muted; });
    $('.fs', p).addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (p.requestFullscreen) p.requestFullscreen();
      else v.webkitEnterFullscreen?.();
    });

    v.addEventListener('volumechange', syncSound);
    v.addEventListener('play', () => p.classList.remove('is-paused'));
    v.addEventListener('pause', () => { if (full && !v.ended) p.classList.add('is-paused'); });
    v.addEventListener('ended', toPreview);
    const tick = () => {
      const d = v.duration || 0;
      $('.cur', p).textContent = fmt(v.currentTime);
      $('.dur', p).textContent = fmt(d);
      const pct = d ? (v.currentTime / d) * 100 : 0;
      bar.style.width = pct + '%';
      prog.setAttribute('aria-valuenow', Math.round(pct));
    };
    ['timeupdate', 'loadedmetadata', 'durationchange', 'emptied'].forEach((ev) => v.addEventListener(ev, tick));
    v.addEventListener('emptied', () => { if (full) toPreview(); });

    const seek = (e) => {
      const r = prog.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (v.duration) v.currentTime = x * v.duration;
    };
    prog.addEventListener('pointerdown', (e) => {
      seek(e);
      prog.setPointerCapture(e.pointerId);
      const move = (ev) => seek(ev);
      prog.addEventListener('pointermove', move);
      // lostpointercapture: chạy cả khi thả chuột lẫn khi bị hủy (pointercancel) -> không sót listener
      prog.addEventListener('lostpointercapture', () => prog.removeEventListener('pointermove', move), { once: true });
    });
    prog.addEventListener('keydown', (e) => {
      if (!v.duration) return;
      if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration, v.currentTime + 5);
      if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5);
    });
    $('.controls', p).addEventListener('click', (e) => e.stopPropagation());
    syncSound();
  }

  // ---------- Thẻ dự án ----------
  const touchObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => preview(target, isIntersecting));
  }, { threshold: 0.75 });

  function preview(thumb, on) {
    const v = $('video.media', thumb);
    if (!v || !v.getAttribute('src') || thumb.classList.contains('is-broken')) return;
    thumb.classList.toggle('is-previewing', on);
    if (on && !reduceMotion) { v.currentTime = 0; v.play().catch(() => {}); }
    else { v.pause(); v.currentTime = 0.1; }
  }

  // ---------- Dự án: mỗi thể loại 1 hàng, hiện 3 video, gạt ngang để xem thêm ----------
  const cats = () => (content.categories ??= []);
  const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.trim(); };
  const pad = (n) => String(n).padStart(2, '0');

  function fillPick(pick, value) {
    pick.innerHTML = '';
    pick.append(new Option('— Chưa phân loại —', ''), ...cats().map((c) => new Option(plain(c.name), c.id)));
    pick.value = cats().some((c) => c.id === value) ? value : '';
  }

  function makeCard(pj, i) {
    const card = $('#cardTpl').content.firstElementChild.cloneNode(true);
    const thumb = $('.thumb', card);
    thumb.dataset.media = `projects.${i}.media`;
    thumb.setAttribute('aria-label', 'Watch project video');
    $('.card-title', card).dataset.edit = `projects.${i}.title`;
    $('.card-meta', card).dataset.edit = `projects.${i}.meta`;
    const pick = $('.cat-pick select', card);
    fillPick(pick, pj.cat);
    pick.addEventListener('change', () => {
      if (pick.value) pj.cat = pick.value;
      else delete pj.cat;
      save();
      renderWorks();
    });
    return card;
  }

  function wireCard(card, i) {
    const thumb = $('.thumb', card);
    setupSlot(thumb, { removable: i });
    const v = $('video', thumb);
    const fill = $('.preview-bar i', thumb);
    v.addEventListener('timeupdate', () => {
      fill.style.width = v.duration ? `${(v.currentTime / v.duration) * 100}%` : '0';
    });
    if (canHover) {
      thumb.addEventListener('pointerenter', () => preview(thumb, true));
      thumb.addEventListener('pointerleave', () => preview(thumb, false));
    } else {
      touchObserver.observe(thumb);
    }
    thumb.addEventListener('click', (e) => {
      if (editing || e.target.closest('.media-tools')) return;
      openLightbox(thumb, i);
    });
    thumb.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !editing) { e.preventDefault(); openLightbox(thumb, i); }
    });
  }

  function renderWorks() {
    const grid = $('#grid');
    $$('.thumb', grid).forEach((t) => touchObserver.unobserve(t));
    $$('.thumb', grid).forEach((t) => { const cv = ambBySlot.get(t); if (cv) detachAmbient(cv); });
    grid.innerHTML = '';

    const known = new Set(cats().map((c) => c.id));
    const groups = cats().map((c, ci) => ({ id: c.id, path: `categories.${ci}.name`, items: [] }));
    const other = { id: '', path: 'text.catOther', items: [] };
    content.projects.forEach((pj, i) => {
      (known.has(pj.cat) ? groups.find((g) => g.id === pj.cat) : other).items.push(i);
    });
    if (other.items.length) groups.unshift(other);

    groups.forEach((g) => {
      const row = $('#rowTpl').content.firstElementChild.cloneNode(true);
      row.dataset.cat = g.id;
      row.classList.toggle('is-empty', !g.items.length);
      $('.row-title', row).dataset.edit = g.path;
      $('.row-bg', row).textContent = plain(getP(g.path));
      $('.row-count', row).textContent = `${g.items.length} ${g.items.length === 1 ? 'video' : 'videos'}`;
      if (!g.id) $('.row-del', row).remove();
      else $('.row-del', row).addEventListener('click', () => removeCat(g.id));
      $('.row-add', row).addEventListener('click', () => addProject(g.id));

      const track = $('.track', row);
      const cards = g.items.map((i) => makeCard(content.projects[i], i));
      track.append(...cards);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-tile edit-only';
      add.textContent = '+ Thêm video';
      add.addEventListener('click', () => addProject(g.id));
      track.append(add);
      // Hàng chưa có video: 1 dải gọn báo trống (không chiếm chỗ bằng 3 khung dọc)
      if (!g.items.length) {
        const ghost = document.createElement('div');
        ghost.className = 'ghost-tile';
        ghost.textContent = 'No videos yet';
        track.append(ghost);
      }
      grid.append(row);
      cards.forEach((card, k) => wireCard(card, g.items[k]));
      setupCarousel(row);
    });

    fillTexts(grid);
    applyEditing(grid);
    reveal($$('.row', grid));
    if (!editing) splitTitles(grid);
  }

  function setupCarousel(row) {
    const track = $('.track', row);
    const prev = $('.prev', row);
    const next = $('.next', row);
    const fill = $('.pg-line i', row);
    const gap = () => parseFloat(getComputedStyle(track).columnGap) || 0;
    const items = () => [...track.children].filter((el) => el.offsetWidth > 0);
    const step = () => {
      const w = items()[0]?.offsetWidth || track.clientWidth;
      const per = Math.max(1, Math.round((track.clientWidth + gap()) / (w + gap())));
      return { w, per };
    };

    const update = () => {
      const n = items().length;
      const { w, per } = step();
      const pages = Math.max(1, Math.ceil(n / per));
      const max = track.scrollWidth - track.clientWidth;
      const p = max > 2 ? Math.min(1, track.scrollLeft / max) : 0;
      const atEnd = max > 2 && track.scrollLeft >= max - 2;
      const page = atEnd ? pages : Math.min(pages, Math.round(track.scrollLeft / (per * (w + gap()))) + 1);
      $('.pg-cur', row).textContent = pad(page);
      $('.pg-total', row).textContent = pad(pages);
      fill.style.width = `${100 / pages}%`;
      fill.style.transform = `translateX(${(pages - 1) * p * 100}%)`;
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= max - 2;
      row.classList.toggle('no-nav', max <= 2);
      markActive();
    };
    row._update = update;

    // Thẻ lộ ra nhiều nhất trong hàng = thẻ đang xem (điện thoại: nổi bật, thẻ hai bên lùi lại)
    const markActive = () => {
      const tr = track.getBoundingClientRect();
      const cards = $$('.card', track);
      let best = null;
      let max = 0;
      cards.forEach((c) => {
        const r = c.getBoundingClientRect();
        const f = r.width ? (Math.min(r.right, tr.right) - Math.max(r.left, tr.left)) / r.width : 0;
        if (f > max + 0.01) { max = f; best = c; }
      });
      cards.forEach((c) => c.classList.toggle('is-active', c === best));
    };

    track.addEventListener('scroll', update, { passive: true });

    new ResizeObserver(update).observe(track);

    const go = (dir) => {
      const { w, per } = step();
      track.scrollBy({ left: dir * per * (w + gap()), behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));

    // Kéo bằng chuột để gạt (cảm ứng thì trình duyệt tự lo)
    let dragged = false;
    track.addEventListener('click', (e) => {
      if (dragged) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || editing || e.target.closest('.media-tools')) return;
      const startX = e.clientX;
      const startLeft = track.scrollLeft;
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) > 6) { moved = true; track.classList.add('dragging'); }
        if (moved) track.scrollLeft = startLeft - dx;
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        if (!moved) return;
        // Chặn cú click ngay sau khi kéo (không mở video)
        dragged = true;
        setTimeout(() => { dragged = false; }, 0);
        // Hít vào thẻ gần nhất
        const { w } = step();
        const target = Math.round(track.scrollLeft / (w + gap())) * (w + gap());
        track.classList.remove('dragging');
        track.scrollTo({ left: target, behavior: reduceMotion ? 'auto' : 'smooth' });
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up); // bị hủy giữa chừng -> vẫn gỡ listener và class "dragging"
    });

    update();
  }

  function addCat() {
    const id = 'c' + Date.now().toString(36);
    cats().push({ id, name: 'New category' });
    save();
    renderWorks();
    const el = $(`#grid .row[data-cat="${id}"] .row-title`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();
    getSelection().selectAllChildren(el);
  }

  function removeCat(id) {
    const c = cats().find((x) => x.id === id);
    if (!confirm(`Xóa thể loại "${plain(c?.name)}"? Các video trong đó sẽ chuyển sang mục "${plain(content.text.catOther)}".`)) return;
    content.projects.forEach((p) => { if (p.cat === id) delete p.cat; });
    content.categories = cats().filter((x) => x.id !== id);
    if (BASE.categories?.some((x) => x.id === id)) (content.removedCats ||= []).push(id);
    save();
    renderWorks();
  }

  // Đổi tên thể loại -> cập nhật chữ nền + danh sách chọn ngay
  document.addEventListener('input', (e) => {
    const t = e.target.closest?.('#grid .row-title');
    if (!t) return;
    $('.row-bg', t.closest('.row')).textContent = plain(getP(t.dataset.edit));
    $$('#grid .cat-pick select').forEach((s) => fillPick(s, s.value));
  });

  function addProject(cat) {
    content.projects.push({ title: 'New project', meta: 'Category · Role', ...(cat ? { cat } : {}), media: { src: '' } });
    save();
    renderWorks();
    const title = $(`#grid [data-edit="projects.${content.projects.length - 1}.title"]`);
    title.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    title.focus();
  }

  function removeProject(i) {
    const pj = content.projects[i];
    if (!confirm(`Xóa dự án "${pj.title.replace(/<[^>]+>/g, '')}"?`)) return;
    forget(pj.media);
    content.projects.splice(i, 1);
    save();
    renderWorks();
  }

  // ---------- Xem video lớn ----------
  const lb = $('#lightbox');
  const lbVideo = $('video', lb);
  async function openLightbox(thumb, i) {
    const url = await urlOf(getP(thumb.dataset.media));
    if (!url) return;
    preview(thumb, false);
    $('.lb-caption', lb).innerHTML = clean(content.projects[i]?.title);
    lbVideo.src = url;
    lb.showModal();
    lbVideo.play().catch(() => {});
  }
  lb.addEventListener('close', () => { lbVideo.pause(); lbVideo.removeAttribute('src'); lbVideo.load(); });
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  $('.lb-close', lb).addEventListener('click', () => lb.close());

  // ---------- Logo dính đầu màn hình: cuộn xuống thì thu nhỏ + hiện quầng tối phía sau (CSS: .is-stuck) ----------
  const topbar = $('.topbar');
  const onScroll = () => topbar.classList.toggle('is-stuck', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- Hàng tag ngang trên điện thoại: tách text.tags theo <br> ----------
  function renderTagsRow() {
    const row = $('#tagsRow');
    if (!row) return;
    const words = clean(content.text.tags || '').split('<br>').map(plain).filter(Boolean);
    row.replaceChildren(...words.map((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      return s;
    }));
  }

  // ---------- Dải phim phần mềm: nhân đôi danh sách, CSS dịch -50% là vừa đúng 1 vòng liền mạch ----------
  const filmTrack = $('.film-track');
  [...filmTrack.children].forEach((li) => {
    const c = li.cloneNode(true);
    c.classList.add('clone');
    c.setAttribute('aria-hidden', 'true');
    filmTrack.append(c);
  });

  // ---------- Liên hệ: Instagram, Gmail, WhatsApp, TikTok ----------
  // Lưu đúng thứ người dùng nhập (tên tài khoản, email, số điện thoại hoặc link đầy đủ) -> đổi thành link khi hiện
  const SOCIAL = {
    instagram: { name: 'Instagram', ask: 'Tên Instagram (vd: bn1.media) hoặc link', url: (v) => `https://www.instagram.com/${v.replace(/^@/, '')}` },
    gmail: { name: 'Gmail', ask: 'Địa chỉ Gmail (vd: ten@gmail.com)', url: (v) => `mailto:${v}` },
    whatsapp: { name: 'WhatsApp', ask: 'Số WhatsApp có mã nước (vd: +84 912 345 678) hoặc link', url: (v) => `https://wa.me/${v.replace(/\D/g, '')}` },
    tiktok: { name: 'TikTok', ask: 'Tên TikTok (vd: @bn1.media) hoặc link', url: (v) => `https://www.tiktok.com/@${v.replace(/^@/, '')}` },
  };
  const social = () => (content.social ??= {});

  function renderSocial() {
    $$('#social [data-social]').forEach((a) => {
      const key = a.dataset.social;
      const v = (social()[key] || '').trim();
      const href = !v ? '' : /^(https?:|mailto:)/i.test(v) ? v : SOCIAL[key].url(v);
      if (href) {
        a.href = href;
        a.removeAttribute('aria-disabled');
      } else {
        a.removeAttribute('href');
        a.setAttribute('aria-disabled', 'true');
      }
      a.title = v ? `${SOCIAL[key].name}: ${v}` : `${SOCIAL[key].name} (link coming soon)`;
      a.setAttribute('aria-label', a.title);
      // Thẻ <a> không có href thì không bấm phím Tab tới được -> vẫn cho chọn khi đang sửa
      a.tabIndex = editing || href ? 0 : -1;
    });
  }

  $('#social').addEventListener('click', (e) => {
    const a = e.target.closest('[data-social]');
    if (!a) return;
    if (!editing) { if (!a.href) e.preventDefault(); return; }
    e.preventDefault();
    const key = a.dataset.social;
    const v = prompt(SOCIAL[key].ask + '\n(để trống để xóa)', social()[key] || '');
    if (v == null) return;
    social()[key] = v.trim();
    save();
    renderSocial();
  });
  // Thẻ <a> có href thì Enter tự bấm; không có href thì phải tự gọi
  $('#social').addEventListener('keydown', (e) => {
    const a = e.target.closest?.('[data-social]');
    if (editing && a && !a.href && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); a.click(); }
  });

  // ---------- Thanh công cụ ----------
  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('editing', on);
    $('#toggleEdit').textContent = on ? '✓ Xong' : '✎ Chỉnh sửa';
    if (on) unsplitTitles();
    else splitTitles(document, false); // sửa xong: hiện ngay, không chạy lại hiệu ứng
    applyEditing();
    renderSocial();
    renderTagsRow();
    $$('#grid .row').forEach((r) => r._update?.()); // ô "+ Thêm video" hiện/ẩn -> tính lại số trang
    if (!on) document.activeElement?.blur?.();
  }

  const contentJs = (obj) =>
    '// Nội dung trang — tự ghi khi bấm "Xong" trong chế độ chỉnh sửa (hoặc nút "Xuất content.js").\n'
    + `window.SITE_CONTENT = ${JSON.stringify(obj, null, 2)};\n`;
  const mediaPaths = () => ['hero', ...content.projects.map((_, i) => `projects.${i}.media`)];

  // ---------- Bấm "Xong" -> serve.py ghi thẳng content.js + videos/ ----------
  // Chỉ có khi mở trang bằng "Mo trang.bat" (serve.py); mở file trực tiếp hoặc trên hosting thì không có.
  async function api(path, body, name) {
    const r = await fetch(path, { method: 'POST', headers: { 'X-Landing': '1' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${name} lỗi ${r.status}`);
    return data;
  }
  const uploadToServer = (blob, name) =>
    api(`api/upload?name=${encodeURIComponent(name)}&dir=videos`, blob, 'Tải lên');

  async function saveToServer() {
    flash('Đang lưu…', 0);
    // Video tải lên lúc chưa có serve.py (nằm trong IndexedDB) -> chép vào videos/ trước
    const moved = [];
    for (const p of mediaPaths()) {
      const m = getP(p);
      if (!m?.idb) continue;
      const rec = await idb.get(m.idb);
      if (!rec) continue;
      const { src } = await uploadToServer(rec.blob, rec.name || `${m.idb}.mp4`);
      setP(p, { src });
      moved.push([p, m]);
    }

    // Mục cũ không còn dùng (bản nháp cũ có thể còn) -> không ghi vào file
    delete content.portrait;
    delete content.album;
    // removedCats chỉ để bản nháp không hiện lại thể loại đã xóa khỏi content.js cũ -> ghi xong file thì không cần nữa
    const out = clone(content);
    delete out.removedCats;
    const { removed = [] } = await api('api/save', JSON.stringify(out), 'Lưu');
    BASE = out;
    try { localStorage.removeItem(STORE); } catch { /* bỏ qua */ }

    for (const [p, m] of moved) {
      const slot = $$('[data-media]').find((s) => s.dataset.media === p);
      if (slot) await mountMedia(slot);
      forget(m);
    }
    return removed;
  }

  async function commit() {
    if (uploads.size) {
      flash('Đợi tải file lên xong rồi lưu…', 0);
      await Promise.allSettled([...uploads]);
    }
    clearTimeout(saveTimer);
    try { localStorage.setItem(STORE, JSON.stringify(content)); } catch { /* bỏ qua */ }
    if (!(await server)) {
      // file:// và http://127.0.0.1 là 2 nơi lưu riêng của trình duyệt -> bản nháp ở đây KHÔNG tự sang Mo trang.bat
      flash('Đã lưu tạm trên trình duyệt này. Để ghi vào file: bấm "Xuất content.js" (bản nháp không tự chuyển sang khi mở bằng Mo trang.bat)', 9000);
      return;
    }
    try {
      const removed = await saveToServer();
      flash(removed.length
        ? `✓ Đã lưu · chuyển ${removed.length} file không dùng vào Thùng rác`  : '✓ Đã lưu vào content.js', 4000);
      if (removed.length) console.info('Đã chuyển vào Thùng rác:', removed);
    } catch (e) {
      flash('Không lưu được: ' + e.message + ' (cửa sổ Mo trang.bat còn mở không?)', 6000);
      console.error(e);
    }
  }

  function exportContent() {
    const out = clone(content);
    delete out.portrait;
    delete out.album;
    delete out.removedCats;
    const files = [];
    const used = new Set();
    const fix = (m) => {
      if (!m?.idb) return m;
      const base = m.name || `${m.idb}.mp4`;
      // 2 file tải lên trùng tên -> đặt tên khác để không trỏ chung 1 đường dẫn
      let name = base;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = base.replace(/(\.[^.]*)?$/, `-${i}$1`);
      used.add(name.toLowerCase());
      files.push(name === base ? `videos/${name}` : `videos/${base}  →  đổi tên thành ${name}`);
      return { src: `videos/${name}` };
    };
    out.hero = fix(out.hero);
    out.projects.forEach((pj) => { pj.media = fix(pj.media); });

    const js = contentJs(out);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    a.download = 'content.js';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);

    if (files.length) {
      alert('Đã xuất content.js.\n\nNhớ chép các file đã tải lên vào cạnh index.html, đúng thư mục và tên như sau:\n\n• ' + files.join('\n• '));
    }
  }

  async function resetAll() {
    if (!confirm('Bỏ mọi thay đổi trên trình duyệt này và quay về nội dung trong content.js?')) return;
    try { localStorage.removeItem(STORE); } catch { /* bỏ qua */ }
    try { await idb.clear(); } catch { /* bỏ qua */ }

    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.clear();
    content = clone(BASE);
    fillTexts();
    $$('[data-media]').forEach((s) => { if (!s.closest('#grid')) mountMedia(s); });
    renderWorks();
    renderSocial();
    renderTagsRow();
    applyEditing();
    flash('Đã khôi phục');
  }

  // ---------- Khởi động ----------
  const params = new URLSearchParams(location.search);
  const dock = $('#dock');
  if (params.has('view')) dock.remove();
  else {
    // Đưa lên hosting (không có serve.py): khách xem không thấy nút sửa; thêm ?edit vào link để hiện
    if (location.protocol.startsWith('http') && !params.has('edit')) {
      dock.style.display = 'none';
      server.then((ok) => { if (ok) dock.style.display = ''; });
    }
    const toggleBtn = $('#toggleEdit');
    toggleBtn.addEventListener('click', () => {
      if (!editing) return setEditing(true);
      setEditing(false);
      // Khóa nút tới khi lưu xong: tải file mới lên giữa lúc đang lưu sẽ bị serve.py dọn nhầm vào Thùng rác
      toggleBtn.disabled = true;
      commit().finally(() => { toggleBtn.disabled = false; });
    });
    $('#exportBtn').addEventListener('click', exportContent);
    $('#resetBtn').addEventListener('click', resetAll);
    $('#addCard').addEventListener('click', addCat);
    $('#addCatTop').addEventListener('click', addCat);
  }

  fillTexts();
  setupSlot($('#player'));
  initHero();
  renderWorks();
  renderSocial();
  renderTagsRow();
  reveal($$('.about-me-body, .hero-head, .player-wrap, .section-head'));

  // ---------- Timeline dựng phim mini (About me) ----------
  // Sóng âm: tạo các vạch cao thấp ngẫu nhiên, nhấp nhô lệch nhịp
  $$('.nle .wave').forEach((wave) => {
    const n = Number(wave.dataset.bars) || 48;
    for (let i = 0; i < n; i++) {
      const bar = document.createElement('i');
      bar.style.setProperty('--h', (0.2 + Math.random() * 0.8).toFixed(2));
      bar.style.animationDelay = `${(-Math.random() * 1.1).toFixed(2)}s`;
      wave.append(bar);
    }
  });
  // Timecode khớp đúng vị trí đầu phát (đọc thời gian của chính hiệu ứng CSS)
  const nleTc = $('#nleTc');
  const nlePh = $('.nle-ph');
  if (nleTc && nlePh && !reduceMotion) {
    const LOOP = 12; // giây cho 1 vòng — khớp với "animation: playhead 12s" trong style.css
    setInterval(() => {
      if (document.hidden || !nlePh.offsetParent) return; // ẩn (điện thoại) thì không cần đếm
      const anim = nlePh.getAnimations?.()[0];
      const t = anim ? (Number(anim.currentTime) / 1000) % LOOP : 0;
      nleTc.textContent = `00:00:${pad(Math.floor(t))}:${pad(Math.floor((t % 1) * 25))}`;
    }, 40);
  }
  splitTitles();
})();
