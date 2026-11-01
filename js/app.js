import * as auth from './auth.js';
import { createStore, LocalStore } from './store.js';
import { compressImage } from './image.js';
import { qrSvg, itemUrl, parseItemCode, startScanner, decodeImageFile } from './qr.js';
import { icon } from './icons.js';

const cfg = auth.resolveConfig();
const app = document.getElementById('app');
const NEXT_KEY = 'pantry.next';

let session = auth.getSession();
let store = session ? createStore(session, cfg) : null;
let loaded = false;
let lastSync = 0;
let teardown = null;
let liveRefresh = null; // как перерисовать текущий экран после фоновой синхронизации
let renderSeq = 0;
const listState = { query: '', filter: 'all' };

/* ------------------------------------------------------------- helpers */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const currentPath = () => decodeURI(location.hash.slice(1)) || '/';
const go = (path) => { location.hash = path; };
const redirect = (path) => {
  history.replaceState(null, '', `#${path}`);
  render();
};
const findItem = (id) => store.items.find((i) => i.id === id);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const daysText = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

function toISODate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function expiry(expires) {
  if (!expires) return { left: Infinity, cls: '', label: 'Срок не указан', full: 'Срок годности не указан' };
  const [y, m, d] = expires.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const left = Math.round((date - today) / 86_400_000);
  const cls = left < 0 ? 'exp-expired' : left <= cfg.warnDays ? 'exp-soon' : '';
  const rel = left < 0 ? `просрочено на ${daysText(-left)}`
    : left === 0 ? 'истекает сегодня'
    : left === 1 ? 'истекает завтра'
    : `через ${daysText(left)}`;
  const long = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return { left, cls, label: `до ${date.toLocaleDateString('ru-RU')} · ${rel}`, full: `Годен до ${long} · ${rel}` };
}

function thumb(item, cls = 'thumb') {
  const letter = esc((item.name || '?').trim().charAt(0).toUpperCase());
  const img = item.image ? `<img data-img="${esc(item.id)}" alt="" loading="lazy">` : '';
  return `<div class="${cls}" aria-hidden="true"><span>${letter}</span>${img}</div>`;
}

function hydrateImages(root) {
  root.querySelectorAll('img[data-img]').forEach((img) => {
    const item = findItem(img.dataset.img);
    img.onerror = () => img.remove();
    Promise.resolve(item ? store.imageSrc(item) : '').then((src) => {
      if (src) img.src = src;
      else img.remove();
    });
  });
}

let toastTimer;
function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 5000 : 2600);
}

function confirmDialog({ title, text = '', ok = 'OK', danger = false }) {
  const dialog = document.getElementById('dialog');
  dialog.innerHTML = `
    <form method="dialog" class="dlg">
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      <div class="dlg-actions">
        <button class="btn btn-ghost" value="cancel">Отмена</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(ok)}</button>
      </div>
    </form>`;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// Блокирует кнопку на время операции; ошибки показывает тостом. Возвращает результат или false.
async function withBusy(button, task) {
  button.disabled = true;
  button.classList.add('busy');
  try {
    return (await task()) ?? true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}

function formHandler(name, handler) {
  const form = app.querySelector(`[data-form="${name}"]`);
  const errorEl = form.querySelector('.form-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const button = form.querySelector('button:not([type="button"])');
    button.disabled = true;
    button.classList.add('busy');
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
    }
  });
  return form;
}

/* -------------------------------------------------------------- layout */

function shell({ title = '', back = '', actions = '', body = '', dock = true, pageClass = '' }) {
  const lead = back
    ? `<a class="icon-btn" href="${back}" aria-label="Назад">${icon('back', 24)}</a>`
    : `<div class="brand"><span class="brand-mark">${icon('box', 20)}</span>Кладовая</div>`;
  return `
    <header class="topbar"><div class="topbar-inner">
      ${lead}
      <h1 class="topbar-title">${esc(title)}</h1>
      <div class="topbar-actions">${actions}</div>
    </div></header>
    <main class="page ${pageClass}">${body}</main>
    ${dock ? `
    <nav class="dock" aria-label="Действия"><div class="dock-inner">
      <a class="btn btn-primary" href="#/add">${icon('plus')}Добавить</a>
      <a class="btn btn-ink" href="#/scan">${icon('scan')}Забрать по QR</a>
    </div></nav>` : ''}`;
}

const settingsLink = `<a class="icon-btn" href="#/settings" aria-label="Настройки">${icon('settings')}</a>`;

const notFound = () => `
  <div class="empty">
    <div class="empty-icon">${icon('box', 32)}</div>
    <h2>Позиция не найдена</h2>
    <p>Возможно, её уже забрали или удалили.</p>
    <a class="btn btn-secondary" href="#/">К списку</a>
  </div>`;

/* -------------------------------------------------------------- router */

const routes = [
  { re: /^\/login$/, view: viewLogin, guest: true },
  { re: /^\/$/, view: viewList, data: true },
  { re: /^\/add$/, view: viewForm, data: true },
  { re: /^\/item\/([\w-]+)$/, view: viewItem, data: true },
  { re: /^\/item\/([\w-]+)\/edit$/, view: viewForm, data: true },
  { re: /^\/scan$/, view: viewScan, data: true },
  { re: /^\/settings$/, view: viewSettings },
];

async function render() {
  const seq = ++renderSeq;
  teardown?.();
  teardown = null;
  liveRefresh = null;
  const path = currentPath();
  const route = routes.find((r) => r.re.test(path));
  if (!route) return redirect('/');
  if (!session && !route.guest) {
    sessionStorage.setItem(NEXT_KEY, path);
    return redirect('/login');
  }
  if (session && route.guest) return redirect('/');
  if (route.data && !loaded) {
    app.innerHTML = '<div class="loading"><div class="spinner"></div><p>Загружаю кладовую…</p></div>';
    try {
      await sync();
    } catch (err) {
      if (seq === renderSeq) app.innerHTML = errorScreen(err);
      return;
    }
    if (seq !== renderSeq) return;
  }
  teardown = route.view(...path.match(route.re).slice(1)) || null;
}

async function sync() {
  await store.refresh();
  loaded = true;
  lastSync = Date.now();
}

function errorScreen(err) {
  return shell({
    actions: settingsLink,
    dock: false,
    body: `
      <div class="empty">
        <div class="empty-icon danger">${icon('alert', 32)}</div>
        <h2>Не удалось загрузить данные</h2>
        <p>${esc(err.message)}</p>
        <div class="empty-actions">
          <button class="btn btn-primary" data-action="retry">Повторить</button>
          <a class="btn btn-secondary" href="#/settings">Настройки</a>
        </div>
        <button class="btn btn-ghost" data-action="logout">${icon('logout')}Выйти</button>
      </div>`,
  });
}

function logout() {
  auth.logout();
  session = null;
  store = null;
  loaded = false;
  listState.query = '';
  listState.filter = 'all';
  redirect('/login');
}

const actions = {
  retry: () => render(),
  logout: () => logout(),
  async sync(button) {
    button.classList.add('spin');
    try {
      await sync();
      liveRefresh?.();
      toast('Данные обновлены');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.classList.remove('spin');
    }
  },
};

app.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el) actions[el.dataset.action]?.(el, event);
});

// Вернулись во вкладку — подтягиваем изменения, сделанные с других устройств.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || store?.kind !== 'github' || !loaded) return;
  if (Date.now() - lastSync < 15_000) return;
  try {
    await sync();
    liveRefresh?.();
  } catch {
    // без сети — покажем то, что уже загружено
  }
});

/* --------------------------------------------------------------- login */

function viewLogin() {
  app.innerHTML = `
    <main class="login">
      <div class="login-card">
        <span class="brand-mark lg">${icon('box', 30)}</span>
        <h1>Кладовая</h1>
        <p class="muted">Учёт продуктов дома</p>
        <form class="form" data-form="login">
          <label class="field"><span>Логин</span>
            <input name="login" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
          <label class="field"><span>Пароль</span>
            <input name="password" type="password" required autocomplete="current-password"></label>
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block">Войти</button>
        </form>
        <p class="hint login-hint" data-hint>&nbsp;</p>
      </div>
    </main>`;

  const hint = app.querySelector('[data-hint]');
  auth.probe(cfg).then((mode) => {
    hint.textContent = {
      fresh: 'Первый вход: admin / admin',
      local: 'Данные хранятся в этом браузере',
      github: 'Данные синхронизируются через GitHub',
    }[mode];
  });

  formHandler('login', async ({ login, password }) => {
    session = await auth.login(cfg, login.trim(), password);
    store = createStore(session, cfg);
    loaded = false;
    const next = sessionStorage.getItem(NEXT_KEY) || '/';
    sessionStorage.removeItem(NEXT_KEY);
    location.replace(`#${next}`);
  });
}

/* ---------------------------------------------------------------- list */

function viewList() {
  const local = store.kind === 'local';
  app.innerHTML = shell({
    actions: `${local ? '' : `<button class="icon-btn" data-action="sync" aria-label="Обновить">${icon('refresh')}</button>`}${settingsLink}`,
    body: `
      ${local ? `<div class="banner">${icon('device')}<div>Сейчас данные хранятся только в этом браузере. <a href="#/settings">Подключите GitHub</a>, чтобы открывать кладовую с любого устройства.</div></div>` : ''}
      ${!local && session.weak ? `<div class="banner warn">${icon('alert')}<div>Вход защищён слабым паролем — его легко подобрать. <a href="#/settings">Сменить пароль</a></div></div>` : ''}
      <label class="search">${icon('search')}<input type="search" placeholder="Поиск по названию и описанию" aria-label="Поиск" value="${esc(listState.query)}"></label>
      <div class="filters" role="group" aria-label="Фильтр"></div>
      <div data-list></div>`,
  });

  const input = app.querySelector('.search input');
  const filtersEl = app.querySelector('.filters');
  const listEl = app.querySelector('[data-list]');

  const draw = () => {
    const all = store.items
      .map((item) => ({ item, exp: expiry(item.expires) }))
      .sort((a, b) => a.exp.left - b.exp.left || a.item.name.localeCompare(b.item.name, 'ru'));
    const counts = {
      all: all.length,
      soon: all.filter((x) => x.exp.cls === 'exp-soon').length,
      expired: all.filter((x) => x.exp.cls === 'exp-expired').length,
    };
    filtersEl.innerHTML = [['all', 'Все'], ['soon', 'Скоро истекают'], ['expired', 'Просрочено']]
      .map(([key, label]) => `
        <button class="chip ${key !== 'all' && counts[key] ? 'alert' : ''}" data-filter="${key}" aria-pressed="${listState.filter === key}">
          ${label}<span class="count">${counts[key]}</span>
        </button>`).join('');

    const query = listState.query.trim().toLowerCase();
    const shown = all.filter(({ item, exp }) =>
      (listState.filter === 'all' || exp.cls === `exp-${listState.filter}`)
      && (!query || `${item.name}\n${item.description}`.toLowerCase().includes(query)));

    if (!all.length) {
      listEl.innerHTML = `
        <div class="empty">
          <div class="empty-icon">${icon('box', 32)}</div>
          <h2>Пока пусто</h2>
          <p>Нажмите «Добавить», чтобы внести первый продукт.</p>
        </div>`;
      return;
    }
    if (!shown.length) {
      listEl.innerHTML = '<p class="nothing">Ничего не найдено</p>';
      return;
    }
    listEl.innerHTML = `<ul class="list">${shown.map(({ item, exp }) => `
      <li class="row">
        <a class="row-link" href="#/item/${esc(item.id)}">
          ${thumb(item)}
          <div class="row-main">
            <div class="row-name">${esc(item.name)}</div>
            <div class="row-exp ${exp.cls}">${esc(exp.label)}</div>
          </div>
        </a>
        <button class="icon-btn row-del" data-del="${esc(item.id)}" aria-label="Удалить «${esc(item.name)}»">${icon('trash')}</button>
      </li>`).join('')}</ul>`;
    hydrateImages(listEl);
  };

  input.addEventListener('input', () => {
    listState.query = input.value;
    draw();
  });
  filtersEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    listState.filter = chip.dataset.filter;
    draw();
  });
  listEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-del]');
    const item = button && findItem(button.dataset.del);
    if (!item) return;
    const yes = await confirmDialog({ title: 'Удалить позицию?', text: `«${item.name}» пропадёт из списка.`, ok: 'Удалить', danger: true });
    if (!yes) return;
    if (await withBusy(button, () => store.remove(item.id, 'Удалено'))) {
      toast(`Удалено: ${item.name}`);
      draw();
    }
  });

  draw();
  liveRefresh = draw;
}

/* ---------------------------------------------------------------- card */

function viewItem(id) {
  const item = findItem(id);
  if (!item) {
    app.innerHTML = shell({ back: '#/', body: notFound() });
    return;
  }
  const exp = expiry(item.expires);
  app.innerHTML = shell({
    back: '#/',
    actions: `
      <a class="icon-btn" href="#/item/${esc(id)}/edit" aria-label="Изменить">${icon('edit')}</a>
      <button class="icon-btn" data-delete aria-label="Удалить">${icon('trash')}</button>`,
    body: `
      ${thumb(item, 'hero')}
      <h2 class="item-title">${esc(item.name)}</h2>
      <span class="badge ${exp.cls}">${icon('clock', 16)}${esc(exp.full)}</span>
      <p class="desc ${item.description ? '' : 'muted'}">${item.description ? esc(item.description) : 'Без описания'}</p>

      <section class="section qr-block">
        <div class="qr" data-qr></div>
        <div class="qr-meta">
          <h3>QR-код позиции</h3>
          <p>Наклейте на упаковку. Когда берёте продукт — отсканируйте его кнопкой «Забрать по QR».</p>
          <button class="btn btn-secondary" data-print>${icon('printer')}Печать этикетки</button>
        </div>
      </section>

      <div class="card-actions">
        <a class="btn btn-secondary" href="#/item/${esc(id)}/edit">${icon('edit')}Изменить</a>
        <button class="btn btn-tonal" data-take>${icon('check')}Забрать</button>
      </div>

      <div class="print-label">
        <div class="qr" data-qr></div>
        <div><b>${esc(item.name)}</b><span>${item.expires ? esc(exp.label.split(' · ')[0]) : ''}</span></div>
      </div>`,
  });
  hydrateImages(app);

  qrSvg(itemUrl(id))
    .then((svg) => app.querySelectorAll('[data-qr]').forEach((el) => { el.innerHTML = svg; }))
    .catch((err) => { app.querySelector('[data-qr]').textContent = err.message; });

  app.querySelector('[data-print]').addEventListener('click', () => window.print());

  const removeItem = async (button, verb) => {
    const take = verb === 'Забрано';
    const yes = await confirmDialog({
      title: take ? 'Забрать позицию?' : 'Удалить позицию?',
      text: `«${item.name}» пропадёт из списка.`,
      ok: take ? 'Забрать' : 'Удалить',
      danger: !take,
    });
    if (!yes) return;
    if (await withBusy(button, () => store.remove(id, verb))) {
      toast(`${verb}: ${item.name}`);
      redirect('/');
    }
  };
  app.querySelector('[data-take]').addEventListener('click', (e) => removeItem(e.currentTarget, 'Забрано'));
  app.querySelector('[data-delete]').addEventListener('click', (e) => removeItem(e.currentTarget, 'Удалено'));

  liveRefresh = () => render();
}

/* ---------------------------------------------------------------- form */

const PRESETS = [['3 дня', 3], ['Неделя', 7], ['2 недели', 14], ['Месяц', 0, 1], ['3 месяца', 0, 3], ['Полгода', 0, 6], ['Год', 0, 12]];

function viewForm(id) {
  const item = id ? findItem(id) : null;
  if (id && !item) {
    app.innerHTML = shell({ back: '#/', body: notFound() });
    return;
  }
  let image; // undefined — фото не трогали, null — убрали, строка — новое фото (data URL)

  app.innerHTML = shell({
    back: item ? `#/item/${esc(item.id)}` : '#/',
    title: item ? 'Редактирование' : 'Новая позиция',
    pageClass: 'page-form',
    body: `
      <form class="form" data-form="item">
        <label class="photo">
          <input type="file" accept="image/*" hidden>
          <span class="photo-empty">${icon('camera', 32)}<span>Добавить фото</span></span>
          <img alt="" hidden>
          <span class="photo-tools" hidden>
            <span class="btn btn-glass">${icon('camera', 16)}Заменить</span>
            <button type="button" class="btn btn-glass" data-photo-remove>${icon('trash', 16)}Убрать</button>
          </span>
        </label>
        <label class="field"><span>Название</span>
          <input name="name" required maxlength="120" placeholder="Например, молоко 3,2%" value="${esc(item?.name)}"></label>
        <div class="field">
          <label for="f-expires">Срок годности</label>
          <input id="f-expires" name="expires" type="date" value="${esc(item?.expires)}">
          <div class="presets">${PRESETS.map(([label, days, months = 0]) =>
            `<button type="button" class="chip sm" data-days="${days}" data-months="${months}">${label}</button>`).join('')}</div>
        </div>
        <label class="field"><span>Описание</span>
          <textarea name="description" maxlength="2000" placeholder="Где лежит, сколько осталось, заметки">${esc(item?.description)}</textarea></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block">${item ? 'Сохранить' : 'Добавить в кладовую'}</button>
      </form>`,
  });

  const photo = app.querySelector('.photo');
  const fileInput = photo.querySelector('input');
  const preview = photo.querySelector('img');
  const showPhoto = (src) => {
    preview.hidden = !src;
    photo.querySelector('.photo-tools').hidden = !src;
    photo.querySelector('.photo-empty').hidden = !!src;
    photo.classList.toggle('has-img', !!src);
    if (src) preview.src = src;
    else preview.removeAttribute('src');
  };
  if (item?.image) {
    Promise.resolve(store.imageSrc(item)).then((src) => { if (image === undefined) showPhoto(src); });
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      image = await compressImage(file, store.kind === 'local' ? 640 : 1080);
      showPhoto(image);
    } catch {
      toast('Не удалось открыть изображение', 'error');
    }
  });
  photo.querySelector('[data-photo-remove]').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    image = null;
    showPhoto('');
  });

  const expiresInput = app.querySelector('#f-expires');
  app.querySelector('.presets').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-days]');
    if (!chip) return;
    const date = new Date();
    date.setDate(date.getDate() + Number(chip.dataset.days));
    date.setMonth(date.getMonth() + Number(chip.dataset.months));
    expiresInput.value = toISODate(date);
  });

  formHandler('item', async ({ name, expires, description }) => {
    name = name.trim();
    if (!name) throw new Error('Введите название');
    const saved = await store.upsert({ id: item?.id || newId(), name, expires, description: description.trim() }, image);
    toast(item ? 'Сохранено' : `Добавлено: ${name}`);
    location.replace(`#/item/${saved.id}`);
  });
}

/* ---------------------------------------------------------------- scan */

function viewScan() {
  app.innerHTML = shell({
    back: '#/',
    title: 'Забрать по QR',
    body: `
      <div class="scanner">
        <video muted playsinline autoplay></video>
        <div class="scan-frame"></div>
      </div>
      <p class="scan-status">Запускаю камеру…</p>
      <div class="scan-alt">
        <label class="btn btn-secondary">${icon('image')}Распознать с фото
          <input type="file" accept="image/*" hidden></label>
      </div>
      <div data-sheet></div>`,
  });

  const video = app.querySelector('video');
  const status = app.querySelector('.scan-status');
  const sheet = app.querySelector('[data-sheet]');
  let scanner = null;
  let alive = true;

  const setStatus = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };

  const closeSheet = (message = 'Наведите камеру на QR-код позиции') => {
    sheet.innerHTML = '';
    setStatus(message);
    scanner?.resume();
  };

  const openSheet = (item) => {
    const exp = expiry(item.expires);
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-label="Найдена позиция"><div class="sheet-inner">
        <div class="sheet-item">
          ${thumb(item)}
          <div class="row-main">
            <div class="row-name">${esc(item.name)}</div>
            <div class="row-exp ${exp.cls}">${esc(exp.label)}</div>
          </div>
        </div>
        <button class="btn btn-primary btn-block" data-take>${icon('check')}Забрать</button>
        <div class="sheet-row">
          <a class="btn btn-secondary" href="#/item/${esc(item.id)}">Карточка</a>
          <button class="btn btn-secondary" data-cancel>Отмена</button>
        </div>
      </div></div>`;
    hydrateImages(sheet);
    sheet.querySelector('[data-cancel]').addEventListener('click', () => closeSheet());
    sheet.querySelector('[data-take]').addEventListener('click', async (event) => {
      if (await withBusy(event.currentTarget, () => store.remove(item.id, 'Забрано'))) {
        toast(`Забрано: ${item.name}`);
        closeSheet('Готово. Можно сканировать следующую позицию');
      }
    });
  };

  const onCode = (text) => {
    const id = parseItemCode(text);
    const item = id && findItem(id);
    if (!item) {
      setStatus(id ? 'Эта позиция уже забрана или удалена' : 'Это не QR-код Кладовой', true);
      return;
    }
    scanner?.pause();
    navigator.vibrate?.(40);
    setStatus(`Найдено: ${item.name}`);
    openSheet(item);
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Камера недоступна в этом браузере — распознайте код с фото', true);
  } else {
    startScanner(video, onCode)
      .then((s) => {
        if (!alive) return s.stop();
        scanner = s;
        if (!sheet.innerHTML) setStatus('Наведите камеру на QR-код позиции');
      })
      .catch((err) => {
        if (!alive) return;
        setStatus(
          err.name === 'NotAllowedError' ? 'Нет доступа к камере. Разрешите его в настройках браузера или распознайте код с фото.'
          : err.name === 'NotFoundError' ? 'Камера не найдена — распознайте код с фото'
          : err.message,
          true,
        );
      });
  }

  const fileInput = app.querySelector('.scan-alt input');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    setStatus('Распознаю…');
    try {
      const text = await decodeImageFile(file);
      if (text) onCode(text);
      else setStatus('На фото не нашлось QR-кода', true);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  return () => {
    alive = false;
    scanner?.stop();
  };
}

/* ------------------------------------------------------------ settings */

function viewSettings() {
  const gh = store.kind === 'github';
  const target = gh ? store : cfg;
  app.innerHTML = shell({
    back: '#/',
    title: 'Настройки',
    body: `
      <section class="section status">
        <span class="status-icon">${icon(gh ? 'cloud' : 'device', 22)}</span>
        <div>
          <b>${gh ? 'Синхронизация через GitHub' : 'Только этот браузер'}</b>
          <div class="hint">${gh
            ? `<a href="${esc(store.repoUrl)}" target="_blank" rel="noopener">${esc(store.owner)}/${esc(store.repo)}</a> · ветка ${esc(store.branch)}`
            : 'Другие устройства этих данных не видят'}</div>
        </div>
      </section>

      <section class="section">
        <h2>${gh ? 'Заменить токен или репозиторий' : 'Подключить GitHub'}</h2>
        <p>Данные будут храниться в репозитории с этим сайтом: список — в <code>${esc(cfg.dataDir)}/db.json</code>, фото — в <code>${esc(cfg.dataDir)}/img/</code>.</p>
        <ol class="steps">
          <li>Создайте <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained токен</a>: доступ только к этому репозиторию, право <b>Contents: Read and write</b>.</li>
          <li>Вставьте его ниже и задайте логин и пароль — с ними вы будете входить с любого устройства. Токен сохранится в репозитории только в зашифрованном этим паролем виде.</li>
        </ol>
        <form class="form" data-form="connect">
          <div class="grid-2">
            <label class="field"><span>Владелец</span>
              <input name="owner" required value="${esc(target.owner)}" placeholder="github-логин" autocapitalize="none" spellcheck="false"></label>
            <label class="field"><span>Репозиторий</span>
              <input name="repo" required value="${esc(target.repo)}" placeholder="pantry" autocapitalize="none" spellcheck="false"></label>
          </div>
          <label class="field"><span>Ветка</span>
            <input name="branch" required value="${esc(target.branch || 'main')}" autocapitalize="none" spellcheck="false"></label>
          <label class="field"><span>Токен</span>
            <input name="token" type="password" required placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
          <div class="grid-2">
            <label class="field"><span>Логин</span>
              <input name="login" required value="${esc(session.login)}" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
            <label class="field"><span>Пароль</span>
              <input name="password" type="password" required autocomplete="new-password"></label>
          </div>
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block">${gh ? 'Сохранить' : 'Подключить'}</button>
        </form>
      </section>

      <section class="section">
        <h2>Логин и пароль</h2>
        <p>${gh ? 'Пароль шифрует доступ к репозиторию, поэтому лучше сделать его длинным.' : 'Пароль для входа в этом браузере.'}</p>
        <form class="form" data-form="password">
          <label class="field"><span>Текущий пароль</span>
            <input name="current" type="password" required autocomplete="current-password"></label>
          <label class="field"><span>Новый логин</span>
            <input name="login" required value="${esc(session.login)}" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
          <div class="grid-2">
            <label class="field"><span>Новый пароль</span>
              <input name="password" type="password" required autocomplete="new-password"></label>
            <label class="field"><span>Ещё раз</span>
              <input name="repeat" type="password" required autocomplete="new-password"></label>
          </div>
          <p class="form-error" hidden></p>
          <button class="btn btn-secondary btn-block">Сменить пароль</button>
        </form>
      </section>

      <button class="btn btn-ghost btn-block" data-action="logout">${icon('logout')}Выйти</button>`,
  });

  formHandler('connect', async (data) => {
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === 'password' ? v : v.trim()]));
    if (auth.isWeak(fields.login, fields.password)) {
      const yes = await confirmDialog({
        title: 'Пароль слабый',
        text: 'Зашифрованный токен лежит в публичном репозитории, и простой пароль к нему легко подобрать. Всё равно продолжить?',
        ok: 'Продолжить',
        danger: true,
      });
      if (!yes) return;
    }
    const connected = await auth.connectGitHub(cfg, fields);
    session = connected.session;
    store = connected.store;
    loaded = true;
    lastSync = Date.now();

    const local = new LocalStore();
    await local.refresh();
    if (local.items.length) {
      const move = await confirmDialog({
        title: 'Перенести данные?',
        text: `В этом браузере есть позиции (${local.items.length}). Перенести их в GitHub?`,
        ok: 'Перенести',
      });
      if (move) {
        await store.importItems(local.items);
        LocalStore.clear();
      }
    }
    toast('GitHub подключён');
    go('/');
  });

  formHandler('password', async (data, form) => {
    if (data.password !== data.repeat) throw new Error('Новые пароли не совпадают');
    session = await auth.changeCredentials(session, store, data.current, data.login.trim(), data.password);
    form.reset();
    form.elements.namedItem('login').value = session.login;
    toast('Логин и пароль обновлены');
  });
}

/* ---------------------------------------------------------------- boot */

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
render();
