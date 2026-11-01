import { seal, unseal, randomKey, keyId } from './crypto.js';
import { GitHubStore } from './store.js';

const DEFAULT_PASSWORD = '149';

const SESSION = 'pantry.session';
const LAST_USER = 'pantry.user';
const LOCAL_AUTH = 'pantry.local.password'; // зашифрованный пустой ящик: общий пароль для локального режима
const REMOTE_AUTH = 'pantry.remote.auth';   // копия data/auth.json из репозитория
const SPACE_KEY = 'pantry.key';             // ключ кладовой из ссылки-приглашения

export const INVITE_NEEDED = 'Это устройство ещё не подключено к общей кладовой. Откройте на нём ссылку-приглашение.';

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function resolveConfig() {
  const cfg = { owner: '', repo: '', branch: 'main', dataDir: 'data', warnDays: 3, users: ['Igor', 'Anna'], ...window.PANTRY_CONFIG };
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    cfg.owner ||= host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    cfg.repo ||= first && !first.endsWith('.html') ? first : host;
  }
  return cfg;
}

export const getSession = () => readJSON(SESSION);
export const lastUser = () => localStorage.getItem(LAST_USER) || '';

function saveSession(session) {
  localStorage.setItem(SESSION, JSON.stringify(session));
  localStorage.setItem(LAST_USER, session.login);
  return session;
}

export function logout() {
  localStorage.removeItem(SESSION);
}

/* -------------------------------------------------------------- invite */

// Токен в data/auth.json зашифрован паролем и ключом кладовой. Пароль короткий, его можно подобрать,
// а ключа в репозитории нет: он приходит на устройство только по ссылке-приглашению.
const spaceKey = () => localStorage.getItem(SPACE_KEY) || '';

export function joinSpace(key) {
  localStorage.setItem(SPACE_KEY, key);
}

export const inviteUrl = () => `${location.origin}${location.pathname}#/join/${spaceKey()}`;

async function hasKeyFor(box) {
  const key = spaceKey();
  return Boolean(key && box?.kid && box.kid === await keyId(key));
}

/* --------------------------------------------------------------- login */

// Сначала берём data/auth.json через API (свежая версия сразу после коммита), затем с самого сайта
// (работает и для приватного репозитория), затем копию, сохранённую при прошлом входе.
async function fetchRemoteAuth(cfg) {
  const sources = [];
  if (cfg.owner && cfg.repo) {
    sources.push(() => fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dataDir}/auth.json?ref=${encodeURIComponent(cfg.branch)}`,
      { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' },
    ));
  }
  sources.push(() => fetch(`${cfg.dataDir}/auth.json`, { cache: 'no-store' }));
  for (const load of sources) {
    try {
      const res = await load();
      if (!res.ok) continue;
      const box = await res.json();
      if (box?.ct) return box;
    } catch {
      // нет сети или файла — пробуем следующий источник
    }
  }
  return readJSON(REMOTE_AUTH);
}

async function checkLocal(password) {
  const box = readJSON(LOCAL_AUTH);
  if (!box) return password === DEFAULT_PASSWORD;
  return (await unseal('local', password, box)) !== null;
}

// 'github' — вход откроет общую кладовую; 'invite' — она есть, но на этом устройстве нет ключа из приглашения;
// 'local' — общей кладовой ещё нет, данные хранятся в этом браузере.
export async function probe(cfg) {
  const remote = await fetchRemoteAuth(cfg);
  if (!remote) return 'local';
  return (await hasKeyFor(remote)) ? 'github' : 'invite';
}

export async function login(cfg, user, password) {
  if (!cfg.users.includes(user)) throw new Error('Выберите, кто входит');
  const remote = await fetchRemoteAuth(cfg);
  if (remote) {
    if (!(await hasKeyFor(remote))) throw new Error(INVITE_NEEDED);
    const secret = await unseal(spaceKey(), password, remote);
    if (!secret?.token) throw new Error('Неверный пароль');
    localStorage.setItem(REMOTE_AUTH, JSON.stringify(remote));
    return saveSession({
      mode: 'github',
      login: user,
      token: secret.token,
      owner: remote.owner || cfg.owner,
      repo: remote.repo || cfg.repo,
      branch: remote.branch || cfg.branch,
    });
  }
  if (!(await checkLocal(password))) throw new Error('Неверный пароль');
  return saveSession({ mode: 'local', login: user });
}

/* ------------------------------------------------------------- setup */

// newKey — выдать новый ключ: старые ссылки-приглашения перестанут работать.
export async function connectGitHub(cfg, session, { owner, repo, branch, token, password, newKey }) {
  const store = new GitHubStore({ owner, repo, branch, token, dataDir: cfg.dataDir, user: session.login });
  await store.checkRepo();
  const key = session.mode === 'github' && !newKey && spaceKey() ? spaceKey() : randomKey();
  const box = { ...(await seal(key, password, { token })), kid: await keyId(key), owner, repo, branch };
  await store.writeAuth(box);
  await store.refresh();
  joinSpace(key);
  localStorage.setItem(REMOTE_AUTH, JSON.stringify(box));
  const next = saveSession({ mode: 'github', login: session.login, token, owner, repo, branch });
  return { session: next, store };
}

export async function changePassword(cfg, session, store, current, password) {
  if (session.mode === 'github') {
    const box = await fetchRemoteAuth(cfg);
    const secret = box && (await hasKeyFor(box)) ? await unseal(spaceKey(), current, box) : null;
    if (!secret?.token) throw new Error('Текущий пароль указан неверно');
    const next = { ...(await seal(spaceKey(), password, secret)), kid: box.kid, owner: box.owner, repo: box.repo, branch: box.branch };
    await store.writeAuth(next);
    localStorage.setItem(REMOTE_AUTH, JSON.stringify(next));
  } else {
    if (!(await checkLocal(current))) throw new Error('Текущий пароль указан неверно');
    localStorage.setItem(LOCAL_AUTH, JSON.stringify(await seal('local', password, {})));
  }
}
