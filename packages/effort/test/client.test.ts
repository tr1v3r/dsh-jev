// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * Browser-half tests for lib/client.js.
 *
 * The module registers itself through `window.__ModuleLoader__.load`; we stub
 * the loader, capture the factory, and drive `exports.apply(ctx)` against a
 * jsdom document — covering render, locale binding, dismissal persistence,
 * hot-swap ownership, and old-host degradation.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = (JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as { version: string }).version;
const STATE = Symbol.for('dsh-jev-effort.state');
const HINT_ID = 'dsh-jev-effort-hint';
const DISMISS_KEY = 'dsh-jev-effort.hint.dismissed';

let factory: (() => Record<string, unknown>) | undefined;
let effects: Array<() => void>;

beforeEach(async () => {
  vi.resetModules();
  factory = undefined;
  effects = [];
  (window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load: (spec: { id: string; factory: () => Record<string, unknown> }) => {
      expect(spec.id).toBe('@dsh-jev/effort');
      factory = spec.factory;
    },
  };
  // Tear down any live client state from a previous test: its MutationObserver
  // would otherwise re-render the hint with stale bindings on body resets.
  (globalThis as Record<symbol, { dispose?: () => void }>)[STATE]?.dispose?.();
  document.body.innerHTML =
    '<div id="wrap"><div data-slot="conversation.composer" id="composer"></div></div>';
  document.head.querySelectorAll('style').forEach((e) => e.remove());
  localStorage.clear();
  delete (globalThis as Record<symbol, unknown>)[STATE];
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as Record<symbol, { dispose?: () => void }>)[STATE]?.dispose?.();
  delete (globalThis as Record<symbol, unknown>)[STATE];
});

function loadClient() {
  if (!factory) throw new Error('client factory not captured — import failed');
  return factory();
}

function hint() {
  return document.getElementById(HINT_ID);
}

function applyWithLocale(mode: 'ok' | 'none' | 'throw' = 'ok') {
  const ex = loadClient();
  const registered: Array<{ ns: string; dict: unknown }> = [];
  let localeApi: unknown = {
    register: (ns: string, d: unknown) => {
      registered.push({ ns, dict: d });
      return () => {};
    },
    bind: () => (key: string) => ({ 'hint.text': '⚡ jev 提示 zh', 'hint.dismiss': '知道了' }[key] ?? key),
  };
  if (mode === 'none') localeApi = null;
  if (mode === 'throw')
    localeApi = {
      register: () => {
        throw new Error('no locale');
      },
      bind: () => {
        throw new Error('no bind');
      },
    };
  const ctx = {
    get: (k: string) => (k === 'locale' ? localeApi : null),
    effect: (fn: () => () => void, _label: string) => { const d = fn(); effects.push(d); },
  };
  (ex.apply as (c: unknown) => void)(ctx);
  return { ex, registered };
}

describe('module registration', () => {
  it('registers via window.__ModuleLoader__ with the published package id and injects locale', async () => {
    await import('../lib/client.js');
    const ex = loadClient();
    expect(ex.inject).toEqual(['locale']);
    expect(typeof ex.apply).toBe('function');
  });
});

describe('render + locale', () => {
  it('renders the hint above the composer with localized copy', async () => {
    await import('../lib/client.js');
    const { registered } = applyWithLocale('ok');
    expect(registered.map((r) => r.ns)).toContain('jev-effort');
    const bar = hint();
    expect(bar).not.toBeNull();
    expect(bar?.parentElement?.id).toBe('wrap');
    expect(bar?.nextElementSibling?.id).toBe('composer');
    expect(bar?.textContent).toContain('⚡ jev 提示 zh');
    expect(bar?.querySelector('button')?.textContent).toBe('知道了');
  });

  it('falls back to built-in English copy when the host has no locale service', async () => {
    await import('../lib/client.js');
    applyWithLocale('none');
    expect(hint()?.textContent).toContain('simple turns are automatically lowered');
    expect(hint()?.querySelector('button')?.textContent).toBe('Got it');
  });

  it('falls back to English when locale registration throws', async () => {
    await import('../lib/client.js');
    applyWithLocale('throw');
    expect(hint()?.textContent).toContain('simple turns');
  });

  it('injects a style element exactly once across re-renders', async () => {
    await import('../lib/client.js');
    applyWithLocale('none');
    const style = document.getElementById('dsh-jev-effort-style');
    expect(style).not.toBeNull();
    const first = hint();
    // Re-apply with same version: early return keeps element, style not duplicated.
    applyWithLocale('none');
    expect(document.getElementById('dsh-jev-effort-style')).toBe(style);
    expect(hint()).toBe(first); // still the original bar (early return kept it)
  });

  it('does not render when already dismissed', async () => {
    await import('../lib/client.js');
    localStorage.setItem('dsh-jev-effort.hint.dismissed', '1');
    applyWithLocale('none');
    expect(hint()).toBeNull();
  });

  it('does not render when no composer container exists (old host)', async () => {
    await import('../lib/client.js');
    document.body.innerHTML = '';
    applyWithLocale('none');
    expect(hint()).toBeNull();
    expect(document.getElementById('dsh-jev-effort-style')).toBeNull();
  });

  it('coalesces mutation bursts into one animation-frame scan and disconnects after mounting', async () => {
    await import('../lib/client.js');
    document.body.innerHTML = '';
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const query = vi.spyOn(document, 'querySelector');
    applyWithLocale('none');
    const scansAfterApply = query.mock.calls.length;
    document.body.append(document.createElement('div'), document.createElement('div'));
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(query.mock.calls.length).toBe(scansAfterApply);
    document.body.innerHTML = '<div id="wrap"><div data-slot="conversation.composer" id="composer"></div></div>';
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    frames[0](performance.now());
    expect(hint()).not.toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });

  it('treats a throwing localStorage as not-dismissed', async () => {
    await import('../lib/client.js');
    const getter = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    applyWithLocale('none');
    expect(getter).toHaveBeenCalled();
    expect(hint()).not.toBeNull();
  });
});

describe('dismissal + ownership', () => {
  it('dismiss click persists to localStorage and removes the bar', async () => {
    await import('../lib/client.js');
    applyWithLocale('none');
    const bar = hint();
    bar?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
    expect(hint()).toBeNull();
  });

  it('survives a throwing setItem (bar still removed)', async () => {
    await import('../lib/client.js');
    applyWithLocale('none');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    hint()?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hint()).toBeNull();
  });

  it('a stale-versioned bar cannot be removed by the new state (ownership stamp)', async () => {
    await import('../lib/client.js');
    applyWithLocale('none');
    const stale = hint()!;
    stale.setAttribute('data-dsh-jev-effort-version', '0.0.1');
    // New version replaces it: remove() on stale is fine, new bar uses manifest version.
    // Simulate hot swap by clearing state then re-applying.
    delete (globalThis as Record<symbol, unknown>)[STATE];
    applyWithLocale('none');
    const fresh = hint()!;
    expect(fresh).not.toBe(stale);
    expect(fresh.getAttribute('data-dsh-jev-effort-version')).toBe(packageVersion);
    // A stale bar (wrong stamp) is left alone by cleanup: re-stamp fresh as stale.
    fresh.setAttribute('data-dsh-jev-effort-version', '0.0.1');
    const state = (globalThis as Record<symbol, { dispose: () => void }>)[STATE];
    state.dispose();
    // cleanup refuses to remove a bar it does not own
    expect(hint()).toBe(fresh);
  });

  it('ctx.effect registers a cleanup that disposes observer, locale, and bar', async () => {
    await import('../lib/client.js');
    const unregistered: string[] = [];
    const ex = loadClient();
    const ctx = {
      get: () => ({
        register: (_ns: string) => () => unregistered.push('locale'),
        bind: () => (key: string) => key,
      }),
      effect: (fn: () => () => void) => { const d = fn(); effects.push(d); },
    };
    (ex.apply as (c: unknown) => void)(ctx);
    expect(hint()).not.toBeNull();
    effects[0]();
    expect(unregistered).toEqual(['locale']);
    expect(hint()).toBeNull();
    expect((globalThis as Record<symbol, unknown>)[STATE]).toBeUndefined();
    // idempotent
    effects[0]();
    expect(unregistered).toEqual(['locale']);
  });

  it('apply tolerates missing ctx.effect (no effect registration)', async () => {
    await import('../lib/client.js');
    const ex = loadClient();
    (ex.apply as (c: unknown) => void)({ get: () => null });
    expect(hint()).not.toBeNull();
  });
});
