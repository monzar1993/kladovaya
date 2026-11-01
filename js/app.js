import * as auth from './auth.js';
import { createStore, LocalStore, toQty, MAX_QTY } from './store.js';
import { compressImage } from './image.js';
import { qrSvg, itemUrl, parseItemCode, startScanner, decodeImageFile } from './qr.js';
import { icon } from './icons.js';

const cfg = auth.resolveConfig();
const app = document.getElementById('app');
const NEXT_KEY = 'pantry.next';

let session = auth.getSession();
// Сессия со старым логином (admin) или с пользователем, которого убрали из config.js, — входим заново.
if (session && !cfg.users.includes(session.login)) {
  auth.logout();
  session = null;
}
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

// active = false — продукт закончился, и подсвечивать его срок незачем.
function expiry(expires, active = true) {
  if (!expires) return { left: Infinity, cls: '', label: 'Срок не указан', full: 'Срок годности не указан' };
  const [y, m, d] = expires.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const left = Math.round((date - today) / 86_400_000);
  const cls = !active ? '' : left < 0 ? 'exp-expired' : left <= cfg.warnDays ? 'exp-soon' : '';
  const rel = left < 0 ? `просрочено на ${daysText(-left)}`
    : left === 0 ? 'истекает сегодня'
    : left === 1 ? 'истекает завтра'
    : `через ${daysText(left)}`;
  const long = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return { left, cls, label: `до ${date.toLocaleDateString('ru-RU')} · ${rel}`, full: `Годен до ${long} · ${rel}` };
}

// «сегодня в 14:05», «вчера в 09:30», «1 ноября»
function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86_400_000);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `вчера в ${time}`;
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

// Кружок с первой буквой имени; у каждого пользователя свой цвет.
function avatar(name, cls = '') {
  const tone = Math.max(cfg.users.indexOf(name), 0) % 2;
  return `<span class="avatar ${cls}" data-tone="${tone}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>`;
}

const othersText = () => cfg.users.filter((name) => name !== session.login).join(', ');

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

/* ------------------------------------------------------------ quantity */

// Нажатия −/+ копятся и уходят одной записью: пять «+» подряд — один коммит, а не пять.
// В хранилище уходит разница, а не итог, так что правки с разных устройств складываются.
const qtyEdits = new Map(); // id → { delta, inflight, timer, onSettled }

function qtyOf(item) {
  const edit = qtyEdits.get(item.id);
  return edit ? toQty(item.qty + edit.inflight + edit.delta, 0) : item.qty;
}

const qtyLabel = (qty) => (qty ? `Осталось: <b>${qty}</b> шт.` : 'Закончилось');

// Новое количество видно сразу, а сохраняется чуть позже. Возвращает то, что показать.
function setQty(id, value, onSettled) {
  const item = findItem(id);
  if (!item) return 0;
  const edit = qtyEdits.get(id) ?? { delta: 0, inflight: 0, timer: 0 };
  edit.delta += toQty(value, 0) - qtyOf(item);
  edit.onSettled = onSettled;
  qtyEdits.set(id, edit);
  clearTimeout(edit.timer);
  edit.timer = setTimeout(() => {
    edit.timer = 0;
    flushQty(id);
  }, store.kind === 'local' ? 0 : 800);
  return qtyOf(item);
}

async function flushQty(id) {
  const edit = qtyEdits.get(id);
  if (!edit || edit.inflight) return; // запись уже идёт — остаток уйдёт следом
  if (edit.delta) {
    edit.inflight = edit.delta;
    edit.delta = 0;
    try {
      await store.changeQty(id, edit.inflight);
    } catch (err) {
      toast(err.message, 'error');
    }
    edit.inflight = 0;
  }
  if (!edit.delta) qtyEdits.delete(id);
  else if (!edit.timer) flushQty(id);
  edit.onSettled?.();
}

function flushAllQty() {
  for (const [id, edit] of qtyEdits) {
    clearTimeout(edit.timer);
    edit.timer = 0;
    flushQty(id);
  }
}

// Позицию удаляют или сохраняют из формы — накопленные −/+ больше не нужны.
function dropQtyEdit(id) {
  const edit = qtyEdits.get(id);
  if (!edit) return;
  clearTimeout(edit.timer);
  edit.timer = 0;
  edit.delta = 0;
  if (!edit.inflight) qtyEdits.delete(id);
}

const stepper = (qty, attrs = '') => `
  <div class="stepper">
    <button type="button" class="step" data-step="-1" aria-label="Убрать 1 шт." ${qty > 0 ? '' : 'disabled'}>${icon('minus', 22)}</button>
    <input type="number" inputmode="numeric" min="0" max="${MAX_QTY}" step="1" value="${qty}" ${attrs}>
    <button type="button" class="step" data-step="1" aria-label="Добавить 1 шт.">${icon('plus', 22)}</button>
  </div>`;

// Поле количества с кнопками −1 и +1. onChange получает новое значение и возвращает то, что показать.
function bindStepper(el, onChange) {
  const input = el.querySelector('input');
  const minus = el.querySelector('[data-step="-1"]');
  let value = toQty(input.value, 0);
  const show = (next) => {
    value = next;
    input.value = next;
    minus.disabled = next <= 0;
  };
  const commit = (next) => show(onChange(toQty(next, value)));
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-step]');
    if (button) commit(value + Number(button.dataset.step));
  });
  input.addEventListener('change', () => commit(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.blur();
  });
  return show;
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
      <a class="btn btn-ink" href="#/scan">${icon('scan')}Считать данные по QR</a>
    </div></nav>` : ''}`;
}

// Вместо шестерёнки — кружок пользователя: сразу видно, под кем сделан вход.
const settingsLink = () => `<a class="icon-btn account" href="#/settings" aria-label="Настройки · ${esc(session.login)}">${avatar(session.login)}</a>`;

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
  const invite = /^\/join\/([\w-]{43})$/.exec(path);
  if (invite) return acceptInvite(invite[1]);
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
    actions: settingsLink(),
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
  flushAllQty();
  auth.logout();
  session = null;
  store = null;
  loaded = false;
  listState.query = '';
  listState.filter = 'all';
  redirect('/login');
}

// Ссылка-приглашение кладёт на устройство ключ общей кладовой, после чего можно войти.
function acceptInvite(key) {
  auth.joinSpace(key);
  if (session?.mode === 'github') {
    toast('Ссылка-приглашение сохранена');
    return redirect('/');
  }
  // локальная сессия показала бы список этого браузера — входим заново, уже в общую кладовую
  if (session) logout();
  else redirect('/login');
  toast('Приглашение принято. Выберите себя и введите пароль');
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
// Уходим из вкладки — отправляем накопленные −/+, не дожидаясь паузы.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') return flushAllQty();
  if (store?.kind !== 'github' || !loaded) return;
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
  const last = auth.lastUser();
  app.innerHTML = `
    <main class="login">
      <div class="login-card">
        <span class="brand-mark lg">${icon('box', 30)}</span>
        <h1>Кладовая</h1>
        <p class="muted">Учёт продуктов дома</p>
        <form class="form" data-form="login">
          <fieldset class="who">
            <legend>Кто входит</legend>
            <div class="who-options">
              ${cfg.users.map((name) => `
                <label class="who-option">
                  <input type="radio" name="user" value="${esc(name)}" required ${name === last ? 'checked' : ''}>
                  ${avatar(name)}<span>${esc(name)}</span>
                </label>`).join('')}
            </div>
          </fieldset>
          <label class="field"><span>Пароль</span>
            <input name="password" type="password" required autocomplete="current-password"></label>
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block">Войти</button>
        </form>
        <div class="join-note" hidden>
          <span class="status-icon">${icon('link', 22)}</span>
          <div>
            <b>Нужна ссылка-приглашение</b>
            <p>Общая кладовая уже создана. Откройте на этом устройстве ссылку-приглашение или наведите камеру
              на QR-код из настроек — его можно показать с устройства, где кладовая уже открыта.</p>
          </div>
        </div>
        <p class="hint login-hint" data-hint>&nbsp;</p>
      </div>
    </main>`;

  const form = app.querySelector('[data-form="login"]');
  const password = form.elements.namedItem('password');
  form.querySelector('.who').addEventListener('change', () => password.focus());

  const hint = app.querySelector('[data-hint]');
  auth.probe(cfg).then((mode) => {
    hint.textContent = {
      local: 'Пока данные хранятся только в этом браузере',
      github: `Общая кладовая: ${cfg.users.join(' и ')}`,
      invite: '',
    }[mode];
    form.hidden = mode === 'invite';
    app.querySelector('.join-note').hidden = mode !== 'invite';
  });

  formHandler('login', async ({ user, password: value }) => {
    session = await auth.login(cfg, user, value);
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
    actions: `${local ? '' : `<button class="icon-btn" data-action="sync" aria-label="Обновить">${icon('refresh')}</button>`}${settingsLink()}`,
    body: `
      <label class="search">${icon('search')}<input type="search" placeholder="Поиск по названию и описанию" aria-label="Поиск" value="${esc(listState.query)}"></label>
      <div class="filters" role="group" aria-label="Фильтр"></div>
      <div data-list></div>`,
  });

  const input = app.querySelector('.search input');
  const filtersEl = app.querySelector('.filters');
  const listEl = app.querySelector('[data-list]');

  const entries = () => store.items
    .map((item) => {
      const qty = qtyOf(item);
      return { item, qty, exp: expiry(item.expires, qty > 0) };
    })
    .sort((a, b) => a.exp.left - b.exp.left || a.item.name.localeCompare(b.item.name, 'ru'));

  const drawFilters = (all) => {
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
  };

  const row = ({ item, qty, exp }) => `
      <li class="row ${qty ? '' : 'out'}" data-row="${esc(item.id)}">
        <a class="row-link" href="#/item/${esc(item.id)}">
          ${thumb(item)}
          <div class="row-main">
            <div class="row-name">${esc(item.name)}</div>
            <div class="row-exp ${exp.cls}">${esc(exp.label)}</div>
            <div class="row-qty ${qty ? '' : 'out'}">${qtyLabel(qty)}</div>
          </div>
        </a>
        <button class="icon-btn row-del" data-del="${esc(item.id)}" aria-label="Удалить «${esc(item.name)}»">${icon('trash')}</button>
        <div class="row-step" role="group" aria-label="Количество «${esc(item.name)}»">
          <button class="step" data-step="-1" aria-label="Убрать 1 шт." ${qty ? '' : 'disabled'}>${icon('minus', 18)}</button>
          <button class="step" data-step="1" aria-label="Добавить 1 шт.">${icon('plus', 18)}</button>
        </div>
      </li>`;

  // После −/+ перерисовываем только саму строку, чтобы не мигали картинки остальных.
  const refreshRow = (id) => {
    const all = entries();
    const entry = all.find((x) => x.item.id === id);
    const li = listEl.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!entry || !li) return draw();
    const { qty, exp } = entry;
    li.classList.toggle('out', !qty);
    li.querySelector('.row-exp').className = `row-exp ${exp.cls}`;
    const left = li.querySelector('.row-qty');
    left.className = `row-qty ${qty ? '' : 'out'}`;
    left.innerHTML = qtyLabel(qty);
    li.querySelector('[data-step="-1"]').disabled = !qty;
    drawFilters(all);
  };

  const draw = () => {
    const all = entries();
    drawFilters(all);

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
    listEl.innerHTML = `<ul class="list">${shown.map(row).join('')}</ul>`;
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
    const step = event.target.closest('[data-step]');
    if (step) {
      const { row: id } = step.closest('[data-row]').dataset;
      const item = findItem(id);
      if (!item) return;
      setQty(id, qtyOf(item) + Number(step.dataset.step), () => refreshRow(id));
      refreshRow(id);
      return;
    }
    const button = event.target.closest('[data-del]');
    const item = button && findItem(button.dataset.del);
    if (!item) return;
    const yes = await confirmDialog({ title: 'Удалить позицию?', text: `«${item.name}» пропадёт из списка.`, ok: 'Удалить', danger: true });
    if (!yes) return;
    dropQtyEdit(item.id);
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
  const qty = qtyOf(item);
  const exp = expiry(item.expires, qty > 0);
  const history = [
    item.createdBy && `Добавлено: <b>${esc(item.createdBy)}</b>, ${when(item.createdAt)}`,
    item.updatedBy && item.updatedAt !== item.createdAt && `Изменено: <b>${esc(item.updatedBy)}</b>, ${when(item.updatedAt)}`,
  ].filter(Boolean);
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

      <section class="section qty-block">
        <div class="qty-head">
          <h2>Количество, шт.</h2>
          <span class="qty-out" ${qty ? 'hidden' : ''}>Закончилось</span>
        </div>
        ${stepper(qty, 'aria-label="Количество, шт."')}
      </section>

      <section class="section qr-block">
        <div class="qr" data-qr></div>
        <div class="qr-meta">
          <h3>QR-код позиции</h3>
          <p>Наклейте на упаковку. Когда берёте продукт — отсканируйте его кнопкой «Считать данные по QR».</p>
          <button class="btn btn-secondary" data-print>${icon('printer')}Печать этикетки</button>
        </div>
      </section>

      <div class="card-actions">
        <a class="btn btn-secondary" href="#/item/${esc(id)}/edit">${icon('edit')}Изменить</a>
      </div>
      ${history.length ? `<p class="item-meta">${history.map((line) => `<span>${line}</span>`).join('')}</p>` : ''}

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

  const badge = app.querySelector('.badge');
  const outNote = app.querySelector('.qty-out');
  const qtyInput = app.querySelector('.qty-block input');
  const paint = (value) => {
    outNote.hidden = value > 0;
    badge.className = `badge ${expiry(item.expires, value > 0).cls}`;
  };
  const showQty = bindStepper(app.querySelector('.qty-block .stepper'), (value) => {
    const next = setQty(id, value, () => {
      const fresh = findItem(id);
      if (!fresh || document.activeElement === qtyInput) return;
      showQty(qtyOf(fresh));
      paint(qtyOf(fresh));
    });
    paint(next);
    return next;
  });

  app.querySelector('[data-delete]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const yes = await confirmDialog({ title: 'Удалить позицию?', text: `«${item.name}» пропадёт из списка.`, ok: 'Удалить', danger: true });
    if (!yes) return;
    dropQtyEdit(id);
    if (await withBusy(button, () => store.remove(id, 'Удалено'))) {
      toast(`Удалено: ${item.name}`);
      redirect('/');
    }
  });

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
          <label for="f-qty">Количество, шт.</label>
          ${stepper(item ? qtyOf(item) : 1, 'id="f-qty" name="qty"')}
        </div>
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

  bindStepper(app.querySelector('.page-form .stepper'), (value) => value);

  formHandler('item', async ({ name, qty, expires, description }) => {
    name = name.trim();
    if (!name) throw new Error('Введите название');
    if (item) dropQtyEdit(item.id);
    const fields = { id: item?.id || newId(), name, qty: toQty(qty), expires, description: description.trim() };
    const saved = await store.upsert(fields, image);
    toast(item ? 'Сохранено' : `Добавлено: ${name}`);
    location.replace(`#/item/${saved.id}`);
  });
}

/* ---------------------------------------------------------------- scan */

function viewScan() {
  app.innerHTML = shell({
    back: '#/',
    title: 'Считать данные по QR',
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
    const qty = qtyOf(item);
    const exp = expiry(item.expires, qty > 0);
    sheet.innerHTML = `
      <div class="sheet" role="dialog" aria-label="Данные позиции"><div class="sheet-inner">
        <a class="sheet-item" href="#/item/${esc(item.id)}">
          ${thumb(item)}
          <div class="row-main">
            <div class="row-name">${esc(item.name)}</div>
            <div class="row-exp ${exp.cls}">${esc(exp.label)}</div>
            <div class="row-qty ${qty ? '' : 'out'}">${qtyLabel(qty)}</div>
          </div>
        </a>
        ${item.description ? `<p class="sheet-desc">${esc(item.description)}</p>` : ''}
        <div class="sheet-row">
          <button class="btn btn-secondary" data-close>Закрыть</button>
          <button class="btn btn-primary" data-take ${qty ? '' : 'disabled'}>Забрать 1 единицу</button>
        </div>
      </div></div>`;
    hydrateImages(sheet);
    sheet.querySelector('[data-close]').addEventListener('click', () => closeSheet());
    sheet.querySelector('[data-take]').addEventListener('click', async (event) => {
      const saved = await withBusy(event.currentTarget, () => store.changeQty(item.id, -1, 'Забрано'));
      if (saved) {
        toast(`Забрано: ${item.name} · ${saved.qty ? `осталось ${saved.qty} шт.` : 'больше не осталось'}`);
        closeSheet('Готово. Можно сканировать следующую позицию');
      }
    });
  };

  const onCode = (text) => {
    const id = parseItemCode(text);
    const item = id && findItem(id);
    if (!item) {
      setStatus(id ? 'Этой позиции уже нет в списке' : 'Это не QR-код Кладовой', true);
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

// Ссылка на создание токена с уже заполненными названием, сроком и правом на запись.
const tokenUrl = (owner) => `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
  name: 'Кладовая',
  description: 'Запись списка продуктов из приложения «Кладовая»',
  ...(owner ? { target_name: owner } : {}),
  expires_in: '366',
  contents: 'write',
})}`;

function viewSettings() {
  const gh = store.kind === 'github';
  const target = gh ? store : cfg;
  const touch = Boolean(navigator.share) && matchMedia('(pointer: coarse)').matches;
  app.innerHTML = shell({
    back: '#/',
    title: 'Настройки',
    body: `
      <section class="section status">
        ${avatar(session.login, 'lg')}
        <div>
          <b>${esc(session.login)}</b>
          <div class="hint">${gh
            ? `Общая кладовая · <a href="${esc(store.repoUrl)}" target="_blank" rel="noopener">${esc(store.owner)}/${esc(store.repo)}</a>`
            : 'Данные только в этом браузере'}</div>
        </div>
      </section>

      ${gh ? `
      <section class="section qr-block invite">
        <div class="qr" data-invite-qr></div>
        <div class="qr-meta">
          <h3>Ссылка-приглашение</h3>
          <p>Для ${esc(othersText())} и для ваших других устройств: наведите камеру на код или откройте ссылку, затем войдите своим именем и общим паролем. Отправляйте её только своим.</p>
          <button class="btn btn-secondary" data-invite>${touch ? `${icon('share')}Отправить ссылку` : `${icon('copy')}Скопировать ссылку`}</button>
        </div>
      </section>` : ''}

      <section class="section">
        <h2>${gh ? 'Заменить токен' : 'Создать общую кладовую'}</h2>
        ${gh ? '' : `<div class="banner warn" data-exists hidden>${icon('alert')}<div>В репозитории уже есть общая кладовая. Чтобы подключиться к ней, откройте ссылку-приглашение с устройства, где она открыта. Если создать кладовую здесь, данные сохранятся, но старые ссылки-приглашения перестанут работать.</div></div>`}
        <p>${gh
          ? 'Когда срок токена истечёт, создайте новый и вставьте его сюда.'
          : `Чтобы вести кладовую вместе с ${esc(othersText())} с любых устройств, данные будут храниться в репозитории с этим сайтом: список — в <code>${esc(cfg.dataDir)}/db.json</code>, фото — в <code>${esc(cfg.dataDir)}/img/</code>.`}</p>
        <ol class="steps">
          <li>Создайте <a href="${esc(tokenUrl(target.owner))}" target="_blank" rel="noopener">токен GitHub</a> — название и право на запись уже заполнены. В <b>Repository access</b> выберите <b>Only select repositories</b> → <b>${esc(target.repo || 'этот репозиторий')}</b> и нажмите <b>Generate token</b>.</li>
          <li>Вставьте токен ниже и задайте общий пароль для ${esc(cfg.users.join(' и '))}. Токен сохранится в репозитории только в зашифрованном виде: расшифровать его можно паролем и ключом из ссылки-приглашения.</li>
          ${gh ? '' : '<li>Откройте ссылку-приглашение, которая появится здесь, на остальных устройствах.</li>'}
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
          <label class="field"><span>Общий пароль</span>
            <input name="password" type="password" required autocomplete="new-password"></label>
          ${gh ? '<label class="check"><input type="checkbox" name="newKey"><span>Выдать новую ссылку-приглашение — старые перестанут работать</span></label>' : ''}
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block">${gh ? 'Сохранить' : 'Создать'}</button>
        </form>
      </section>

      <section class="section">
        <h2>Общий пароль</h2>
        <p>${gh
          ? `Один на всех: ${esc(cfg.users.join(', '))}. После смены входите новым паролем на всех устройствах.`
          : 'Пароль для входа в этом браузере.'}</p>
        <form class="form" data-form="password">
          <label class="field"><span>Текущий пароль</span>
            <input name="current" type="password" required autocomplete="current-password"></label>
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

  if (gh) {
    const url = auth.inviteUrl();
    const qr = app.querySelector('[data-invite-qr]');
    qrSvg(url).then((svg) => { qr.innerHTML = svg; }).catch((err) => { qr.textContent = err.message; });
    app.querySelector('[data-invite]').addEventListener('click', async () => {
      if (touch) {
        try {
          await navigator.share({ title: 'Кладовая', text: 'Приглашение в общую кладовую', url });
        } catch {
          // окно «Поделиться» закрыли
        }
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Ссылка скопирована');
      } catch {
        window.prompt('Скопируйте ссылку-приглашение', url);
      }
    });
  } else {
    auth.probe(cfg).then((mode) => {
      const note = app.querySelector('[data-exists]');
      if (note) note.hidden = mode === 'local';
    });
  }

  formHandler('connect', async (data) => {
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === 'password' ? v : v.trim()]));
    const fresh = !gh || Boolean(data.newKey);
    const connected = await auth.connectGitHub(cfg, session, { ...fields, newKey: Boolean(data.newKey) });
    session = connected.session;
    store = connected.store;
    loaded = true;
    lastSync = Date.now();

    const local = new LocalStore();
    await local.refresh();
    if (!gh && local.items.length) {
      const move = await confirmDialog({
        title: 'Перенести данные?',
        text: `В этом браузере есть позиции (${local.items.length}). Перенести их в общую кладовую?`,
        ok: 'Перенести',
      });
      if (move) {
        await store.importItems(local.items);
        LocalStore.clear();
      }
    }
    toast(gh ? 'Сохранено' : 'Общая кладовая создана');
    await render(); // на экране появится ссылка-приглашение
    if (fresh) app.querySelector('.invite')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  formHandler('password', async (data, form) => {
    if (data.password !== data.repeat) throw new Error('Новые пароли не совпадают');
    await auth.changePassword(cfg, session, store, data.current, data.password);
    form.reset();
    toast('Пароль обновлён');
  });
}

/* ---------------------------------------------------------------- boot */

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
});
render();
