import type { DemoState } from './types';

export const STORAGE_KEY = 'project-tokyo:demo:v1';
const PREFIX = 'gz1:';

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function asState(value: unknown): DemoState | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as DemoState;
  if (!Array.isArray(s.assets) || typeof s.version !== 'number') return null;
  if (!s.accounts || typeof s.accounts !== 'object') return null;
  return s;
}

export async function encodeState(state: DemoState): Promise<string> {
  const json = JSON.stringify(state);
  if (typeof CompressionStream === 'undefined') return json;
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return PREFIX + bytesToBase64(bytes);
}

export async function decodeState(text: string): Promise<DemoState | null> {
  try {
    if (text.startsWith(PREFIX)) {
      if (typeof DecompressionStream === 'undefined') return null;
      const bytes = base64ToBytes(text.slice(PREFIX.length));
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      const stream = new Blob([copy])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
      return asState(JSON.parse(await new Response(stream).text()));
    }
    return asState(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function loadState(): Promise<DemoState | null> {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    return decodeState(raw);
  } catch {
    return null;
  }
}

export async function saveState(state: DemoState): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, await encodeState(state));
  } catch {
    // quota or private-mode write failure: keep going with in-memory state
  }
}
