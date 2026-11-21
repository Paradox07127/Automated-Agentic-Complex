import { useSyncExternalStore } from 'react';

const STORE_KEY = 'ef.devMode';
/** Off in the shipped app (`vite build --mode app`), on in the dev server, tests and e2e builds. */
const DEFAULT = import.meta.env.MODE !== 'app';

const listeners = new Set<() => void>();

/** Whether 开发者模式 is on, for code outside React. */
export function isDevMode(): boolean {
  const v = localStorage.getItem(STORE_KEY);
  return v === null ? DEFAULT : v === '1';
}

function subscribe(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORE_KEY || e.key === null) fn();
  };
  listeners.add(fn);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, isDevMode);
}

export function setDevMode(on: boolean): void {
  localStorage.setItem(STORE_KEY, on ? '1' : '0');
  listeners.forEach((fn) => fn());
}
