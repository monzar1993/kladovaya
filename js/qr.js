import { decodeImage } from './image.js';

const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const JSQR_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

const scripts = new Map();

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => {
        scripts.delete(src);
        el.remove();
        reject(new Error('Не удалось загрузить модуль QR — проверьте интернет.'));
      };
      document.head.append(el);
    }));
  }
  return scripts.get(src);
}

// QR ведёт на карточку позиции: обычная камера телефона откроет её сразу,
// а встроенный сканер достаёт из ссылки id.
export const itemUrl = (id) => `${location.origin}${location.pathname}#/item/${id}`;

export function parseItemCode(text) {
  return /#\/item\/([\w-]+)/.exec(text || '')?.[1] ?? null;
}

export async function qrSvg(text) {
  await loadScript(QR_LIB);
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 3;
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c + margin} ${r + margin}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR-код"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// Встроенный BarcodeDetector (Chrome, Android) быстрее; где его нет (iOS, Firefox) — jsQR.
async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (source) => (await detector.detect(source))[0]?.rawValue ?? null;
      }
    } catch {
      // переходим на jsQR
    }
  }
  await loadScript(JSQR_LIB);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (source, maxSize = 800) => {
    const w = source.videoWidth || source.width;
    const h = source.videoHeight || source.height;
    if (!w || !h) return null;
    const scale = Math.min(1, maxSize / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

export async function startScanner(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const stopStream = () => stream.getTracks().forEach((t) => t.stop());
  let detect;
  try {
    video.srcObject = stream;
    await video.play();
    detect = await createDetector();
  } catch (err) {
    stopStream();
    throw err;
  }

  let running = true;
  let paused = false;
  let busy = false;
  let last = 0;
  let frame = 0;
  const loop = async (time) => {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    if (paused || busy || time - last < 180 || video.readyState < 2) return;
    busy = true;
    last = time;
    try {
      const text = await detect(video);
      if (text && running && !paused) onCode(text);
    } catch {
      // кадр не распознался — пробуем следующий
    }
    busy = false;
  };
  frame = requestAnimationFrame(loop);

  return {
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      stopStream();
      video.srcObject = null;
    },
  };
}

export async function decodeImageFile(file) {
  const [detect, image] = await Promise.all([createDetector(), decodeImage(file)]);
  return detect(image, 1400);
}
