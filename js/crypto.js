const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function b64ToBytes(b64) {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const textToB64 = (text) => bytesToB64(encoder.encode(text));
export const b64ToText = (b64) => decoder.decode(b64ToBytes(b64));

const ITERATIONS = 250_000;

function requireSubtle() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Шифрование доступно только по HTTPS или на localhost.');
  }
}

async function deriveKey(login, password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(`${login}\n${password}`), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Шифрует payload ключом, полученным из логина и пароля. Сам пароль нигде
// не хранится: вход успешен, только если ящик удаётся расшифровать.
export async function seal(login, password, payload) {
  requireSubtle();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(login, password, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
}

// Возвращает расшифрованный payload или null, если логин/пароль не подходят.
export async function unseal(login, password, box) {
  requireSubtle();
  const key = await deriveKey(login, password, b64ToBytes(box.salt), box.iter || ITERATIONS);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(box.iv) }, key, b64ToBytes(box.ct));
    return JSON.parse(decoder.decode(pt));
  } catch {
    return null;
  }
}
