import { textToB64, b64ToText } from './crypto.js';

// Формат позиции: { id, name, description, expires: 'YYYY-MM-DD' | '', image, imageSha, createdAt, updatedAt }
// image — data URL (локальный режим) или путь к файлу в репозитории (режим GitHub).

const LOCAL_DB = 'pantry.local.db';
const API = 'https://api.github.com';

const nowIso = () => new Date().toISOString();

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function normalize(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.id)
    .map((item) => ({ name: '', description: '', expires: '', image: '', imageSha: '', ...item }));
}

function upsertIn(items, item) {
  const index = items.findIndex((x) => x.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
  return items;
}

const dbFile = (items) => JSON.stringify({ version: 1, updatedAt: nowIso(), items }, null, 2) + '\n';

/* ---------------------------------------------------------------- local */

export class LocalStore {
  kind = 'local';
  items = [];

  async refresh() {
    this.items = normalize(readJSON(LOCAL_DB)?.items);
  }

  #save(items) {
    try {
      localStorage.setItem(LOCAL_DB, dbFile(items));
    } catch {
      throw new Error('В памяти браузера закончилось место. Удалите часть фото или подключите GitHub в настройках.');
    }
    this.items = items;
  }

  async upsert(fields, image) {
    const prev = this.items.find((i) => i.id === fields.id);
    const item = { image: '', createdAt: nowIso(), ...prev, ...fields, updatedAt: nowIso() };
    if (image !== undefined) item.image = image || '';
    this.#save(upsertIn([...this.items], item));
    return item;
  }

  async remove(id) {
    this.#save(this.items.filter((i) => i.id !== id));
  }

  imageSrc(item) {
    return item?.image || '';
  }

  static clear() {
    localStorage.removeItem(LOCAL_DB);
  }
}

/* --------------------------------------------------------------- github */

async function apiError(res) {
  let message = '';
  try {
    message = (await res.json()).message || '';
  } catch {
    // тело не JSON
  }
  const err = new Error(
    res.status === 401 ? 'GitHub не принял токен: он истёк или был отозван. Укажите новый в настройках.'
    : res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0' ? 'Превышен лимит запросов к GitHub, попробуйте через несколько минут.'
    : res.status === 403 ? 'GitHub запретил запись. У токена должно быть право Contents: Read and write на этот репозиторий.'
    : res.status === 404 ? 'Репозиторий не найден, или у токена нет к нему доступа.'
    : `GitHub ответил ошибкой ${res.status}${message ? `: ${message}` : ''}`,
  );
  err.status = res.status;
  return err;
}

async function ok(res) {
  if (!res.ok) throw await apiError(res);
  return res;
}

// Хранит db.json и фото прямо в репозитории через GitHub Contents API.
// Каждое изменение — отдельный коммит, так что история репозитория заодно служит журналом.
export class GitHubStore {
  kind = 'github';
  items = [];
  #sha = null;
  #isPrivate = null;
  #images = new Map(); // путь → URL картинки (или промис URL)
  #queue = Promise.resolve();

  constructor({ owner, repo, branch = 'main', token, dataDir = 'data' }) {
    Object.assign(this, { owner, repo, branch, token, dataDir });
    this.dbPath = `${dataDir}/db.json`;
    this.authPath = `${dataDir}/auth.json`;
  }

  get repoUrl() {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  #api(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    return fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  #ref() {
    return `?ref=${encodeURIComponent(this.branch)}`;
  }

  // Записи идут строго по очереди: параллельные коммиты в одну ветку GitHub отклоняет.
  #enqueue(task) {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {});
    return run;
  }

  async checkRepo() {
    const info = await (await ok(await this.#api(''))).json();
    this.#isPrivate = info.private;
    return info;
  }

  refresh() {
    return this.#enqueue(() => this.#load());
  }

  async #load() {
    const [res] = await Promise.all([
      this.#api(`/contents/${this.dbPath}${this.#ref()}`),
      this.#isPrivate === null ? this.checkRepo() : null,
    ]);
    if (res.status === 404) {
      this.#sha = null;
      this.items = [];
      return;
    }
    const meta = await (await ok(res)).json();
    let content = meta.content;
    if (!content && meta.size > 0) {
      // файлы больше 1 МБ Contents API отдаёт без содержимого — берём через Blobs API
      content = (await (await ok(await this.#api(`/git/blobs/${meta.sha}`))).json()).content;
    }
    this.#sha = meta.sha;
    this.items = normalize(content ? JSON.parse(b64ToText(content)).items : []);
  }

  #putFile(path, contentB64, message, sha) {
    return this.#api(`/contents/${path}`, {
      method: 'PUT',
      body: { message, content: contentB64, branch: this.branch, ...(sha ? { sha } : {}) },
    });
  }

  async #fileSha(path) {
    const res = await this.#api(`/contents/${path}${this.#ref()}`);
    if (res.status === 404) return null;
    return (await (await ok(res)).json()).sha;
  }

  async #deleteFile(path, sha, message) {
    sha ||= await this.#fileSha(path);
    if (!sha) return;
    const res = await this.#api(`/contents/${path}`, { method: 'DELETE', body: { message, sha, branch: this.branch } });
    if (!res.ok && res.status !== 404) throw await apiError(res);
  }

  async #uploadImage(id, dataUrl, name) {
    const path = `${this.dataDir}/img/${id}-${Date.now().toString(36)}.jpg`;
    const res = await ok(await this.#putFile(path, dataUrl.slice(dataUrl.indexOf(',') + 1), `Фото: ${name}`));
    this.#images.set(path, dataUrl);
    return { image: path, imageSha: (await res.json()).content.sha };
  }

  // Применяет изменение к db.json. Если файл успели поменять с другого устройства,
  // перечитывает его и применяет изменение заново — так правки не затирают друг друга.
  async #commitItems(mutate, message) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const items = mutate(structuredClone(this.items));
      const res = await this.#putFile(this.dbPath, textToB64(dbFile(items)), message, this.#sha);
      if (res.ok) {
        this.#sha = (await res.json()).content.sha;
        this.items = items;
        return;
      }
      if (res.status !== 409 && res.status !== 422) throw await apiError(res);
      lastError = await apiError(res);
      await this.#load();
    }
    throw lastError;
  }

  upsert(fields, image) {
    return this.#enqueue(async () => {
      const prev = this.items.find((i) => i.id === fields.id);
      const item = { image: '', imageSha: '', createdAt: nowIso(), ...prev, ...fields, updatedAt: nowIso() };
      const oldImage = image !== undefined && prev?.image ? { path: prev.image, sha: prev.imageSha } : null;
      if (image) Object.assign(item, await this.#uploadImage(item.id, image, item.name));
      else if (image === null) Object.assign(item, { image: '', imageSha: '' });
      await this.#commitItems((items) => upsertIn(items, item), `${prev ? 'Изменено' : 'Добавлено'}: ${item.name}`);
      if (oldImage) this.#dropImage(oldImage.path, oldImage.sha, `Старое фото: ${item.name}`);
      return item;
    });
  }

  remove(id, verb = 'Удалено') {
    return this.#enqueue(async () => {
      const prev = this.items.find((i) => i.id === id);
      await this.#commitItems((items) => items.filter((i) => i.id !== id), `${verb}: ${prev?.name ?? id}`);
      if (prev?.image) this.#dropImage(prev.image, prev.imageSha, `${verb} (фото): ${prev.name}`);
    });
  }

  // Фото удаляется отдельным коммитом в фоне; если не вышло — останется лишний файл, не страшно.
  #dropImage(path, sha, message) {
    this.#enqueue(() => this.#deleteFile(path, sha, message)).catch(() => {});
  }

  importItems(localItems) {
    return this.#enqueue(async () => {
      const uploaded = [];
      for (const local of localItems) {
        const item = { ...local, imageSha: '' };
        if (item.image?.startsWith('data:')) Object.assign(item, await this.#uploadImage(item.id, item.image, item.name));
        uploaded.push(item);
      }
      await this.#commitItems((items) => {
        for (const item of uploaded) if (!items.some((x) => x.id === item.id)) items.push(item);
        return items;
      }, `Перенесено из браузера: ${uploaded.length}`);
    });
  }

  writeAuth(box) {
    return this.#enqueue(async () => {
      const sha = await this.#fileSha(this.authPath);
      await ok(await this.#putFile(this.authPath, textToB64(JSON.stringify(box, null, 2) + '\n'), 'Доступ к Кладовой', sha));
    });
  }

  imageSrc(item) {
    const path = item?.image;
    if (!path) return '';
    if (path.startsWith('data:')) return path;
    if (this.#images.has(path)) return this.#images.get(path);
    if (this.#isPrivate === false) {
      return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
    }
    // приватный репозиторий: картинку можно получить только с токеном
    const url = this.#api(`/contents/${path}${this.#ref()}`, { accept: 'application/vnd.github.raw+json' })
      .then(ok)
      .then((res) => res.blob())
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => '');
    this.#images.set(path, url);
    return url;
  }
}

export function createStore(session, cfg) {
  return session.mode === 'github'
    ? new GitHubStore({ ...session, dataDir: cfg.dataDir })
    : new LocalStore();
}
