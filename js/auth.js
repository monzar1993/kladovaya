import { seal, unseal } from './crypto.js';
import { GitHubStore } from './store.js';

const DEFAULT_LOGIN = 'admin';
const DEFAULT_PASSWORD = 'admin';

const SESSION = 'pantry.session';
const LOCAL_AUTH = 'pantry.local.auth';   // зашифрованный пустой ящик: пароль для локального режима
const REMOTE_AUTH = 'pantry.remote.auth'; // копия data/auth.json из репозитория

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function resolveConfig() {
  const cfg = { owner: '', repo: '', branch: 'main', dataDir: 'data', warnDays: 3, ...window.PANTRY_CONFIG };
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    cfg.owner ||= host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    cfg.repo ||= first && !first.endsWith('.html') ? first : host;
  }
  return cfg;
}

export const getSession = () => readJSON(SESSION);

function saveSession(session) {
  localStorage.setItem(SESSION, JSON.stringify(session));
  return session;
}

export function logout() {
  localStorage.removeItem(SESSION);
}

export const isWeak = (login, password) =>
  password.length < 8 || password === login || password === DEFAULT_PASSWORD;

// data/auth.json хранит токен GitHub, зашифрованный логином и паролем.
// Сначала берём его через API (свежая версия сразу после коммита), затем с самого сайта
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

async function checkLocal(login, password) {
  const box = readJSON(LOCAL_AUTH);
  if (!box) return login === DEFAULT_LOGIN && password === DEFAULT_PASSWORD;
  return (await unseal(login, password, box)) !== null;
}

// 'github' — вход откроет данные из репозитория; 'local' — пароль уже менялся; 'fresh' — admin/admin.
export async function probe(cfg) {
  if (await fetchRemoteAuth(cfg)) return 'github';
  return readJSON(LOCAL_AUTH) ? 'local' : 'fresh';
}

export async function login(cfg, login, password) {
  const remote = await fetchRemoteAuth(cfg);
  if (remote) {
    const secret = await unseal(login, password, remote);
    if (!secret?.token) throw new Error('Неверный логин или пароль');
    localStorage.setItem(REMOTE_AUTH, JSON.stringify(remote));
    return saveSession({
      mode: 'github',
      login,
      token: secret.token,
      owner: remote.owner || cfg.owner,
      repo: remote.repo || cfg.repo,
      branch: remote.branch || cfg.branch,
      weak: isWeak(login, password),
    });
  }
  if (!(await checkLocal(login, password))) throw new Error('Неверный логин или пароль');
  return saveSession({ mode: 'local', login, weak: isWeak(login, password) });
}

export async function connectGitHub(cfg, { owner, repo, branch, token, login, password }) {
  const store = new GitHubStore({ owner, repo, branch, token, dataDir: cfg.dataDir });
  await store.checkRepo();
  const box = { ...(await seal(login, password, { token })), owner, repo, branch };
  await store.writeAuth(box);
  await store.refresh();
  localStorage.setItem(REMOTE_AUTH, JSON.stringify(box));
  const session = saveSession({ mode: 'github', login, token, owner, repo, branch, weak: isWeak(login, password) });
  return { session, store };
}

export async function changeCredentials(session, store, currentPassword, login, password) {
  if (session.mode === 'github') {
    const box = readJSON(REMOTE_AUTH);
    if (!box || !(await unseal(session.login, currentPassword, box))) throw new Error('Текущий пароль указан неверно');
    const { owner, repo, branch, token } = session;
    const next = { ...(await seal(login, password, { token })), owner, repo, branch };
    await store.writeAuth(next);
    localStorage.setItem(REMOTE_AUTH, JSON.stringify(next));
  } else {
    if (!(await checkLocal(session.login, currentPassword))) throw new Error('Текущий пароль указан неверно');
    localStorage.setItem(LOCAL_AUTH, JSON.stringify(await seal(login, password, {})));
  }
  return saveSession({ ...session, login, weak: isWeak(login, password) });
}
