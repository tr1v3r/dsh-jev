/**
 * dsh-jev-effort — browser half (Web face).
 *
 * A lightweight, dismissible hint above the composer telling the user that
 * simple turns are automatically lowered to `low` reasoning effort by jev
 * (the host half does the actual judgment at `agent/request`; the browser
 * cannot hold the API key). Dismissal persists in localStorage.
 *
 * Follows the dsh-quote-followup hardening pattern (see ~/.config/dsh/AGENTS.md):
 *  1. never touches contenteditable internals — the hint is a sibling DOM node;
 *  2. no synthetic clipboard / paste commands needed at all;
 *  3. versioned global state + element ownership survive client hot-swaps;
 *  4. old hosts degrade silently (no locale → English copy, no composer → hidden).
 *
 * @module dsh-jev-effort/client
 */
window.__ModuleLoader__.load({
	id: "dsh-jev-effort",
	factory: () => {
		const exports = {};
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const CLIENT_VERSION = "0.1.0";
		const HINT_ID = "dsh-jev-effort-hint";
		const OWNERSHIP_ATTR = "data-dsh-jev-effort-version";
		const DISMISS_KEY = "dsh-jev-effort.hint.dismissed";
		const COMPOSER_CONTAINER_SELECTORS = [
			'[data-slot="conversation.composer"]',
			"[data-composer-card]",
			'[data-input-scroll]'
		];
		const LOCALE_NS = "jev-effort";
		const LOCALE_DICT = {
			zh: {
				"hint.text": "⚡ jev：简单问题发送时将自动降低为 low 推理档",
				"hint.dismiss": "知道了"
			},
			en: {
				"hint.text": "⚡ jev: simple turns are automatically lowered to low reasoning effort",
				"hint.dismiss": "Got it"
			}
		};
		const fallbackT = (key) => LOCALE_DICT.en[key] ?? key;
		let currentT = fallbackT;
		const isDismissed = () => {
			try {
				return globalThis.localStorage?.getItem(DISMISS_KEY) === "1";
			} catch {
				return false;
			}
		};
		const findComposerContainer = () => {
			for (const selector of COMPOSER_CONTAINER_SELECTORS) {
				const element = document.querySelector(selector);
				if (element !== null)
					return element;
			}
			return null;
		};
		const styleOnce = (() => {
			let done = false;
			return () => {
				if (done)
					return;
				done = true;
				const style = document.createElement("style");
				style.id = "dsh-jev-effort-style";
				style.textContent = `#${HINT_ID}{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:4px 10px;font-size:12px;line-height:1.4;border-radius:8px;background:color-mix(in srgb, var(--ds-primary, #4c6ef5) 8%, transparent);color:inherit;opacity:.85}
#${HINT_ID} button{margin-left:auto;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.7;text-decoration:underline;padding:0}`;
				document.head.append(style);
			};
		})();
		/**
		 * (Re)create the hint bar. Ownership: only the state whose version matches
		 * the live element's stamped version may remove it — a stale hot-swapped
		 * listener cannot tear down the new UI.
		 */
		const renderHint = () => {
			if (isDismissed())
				return;
			const container = findComposerContainer();
			if (container === null)
				return;
			styleOnce();
			const existing = document.getElementById(HINT_ID);
			if (existing?.getAttribute(OWNERSHIP_ATTR) === CLIENT_VERSION)
				return;
			existing?.remove();
			const bar = document.createElement("div");
			bar.id = HINT_ID;
			bar.setAttribute(OWNERSHIP_ATTR, CLIENT_VERSION);
			const text = document.createElement("span");
			text.textContent = currentT("hint.text");
			const dismiss = document.createElement("button");
			dismiss.type = "button";
			dismiss.textContent = currentT("hint.dismiss");
			dismiss.addEventListener("click", () => {
				try {
					globalThis.localStorage?.setItem(DISMISS_KEY, "1");
				} catch {}
				if (bar.getAttribute(OWNERSHIP_ATTR) === CLIENT_VERSION)
					bar.remove();
			});
			bar.append(text, dismiss);
			container.parentElement?.insertBefore(bar, container);
		};
		const STATE = Symbol.for("dsh-jev-effort.state");
		function apply(ctx) {
			const previous = globalThis[STATE];
			if (previous?.version === CLIENT_VERSION)
				return;
			if (typeof previous?.dispose === "function")
				previous.dispose();
			let unregisterLocale = null;
			let observer = null;
			let disposed = false;
			let state;
			try {
				const locale = typeof ctx?.get === "function" ? ctx.get("locale") : null;
				if (typeof locale?.register === "function" && typeof locale?.bind === "function") {
					unregisterLocale = locale.register(LOCALE_NS, LOCALE_DICT);
					currentT = locale.bind(LOCALE_NS);
				} else {
					currentT = fallbackT;
				}
			} catch {
				currentT = fallbackT;
			}
			renderHint();
			// The composer mounts asynchronously; watch for it and late layouts.
			try {
				observer = new MutationObserver(() => renderHint());
				observer.observe(document.body, { childList: true, subtree: true });
			} catch {}
			const cleanup = () => {
				if (disposed)
					return;
				disposed = true;
				observer?.disconnect();
				if (typeof unregisterLocale === "function")
					unregisterLocale();
				currentT = fallbackT;
				const bar = document.getElementById(HINT_ID);
				if (bar?.getAttribute(OWNERSHIP_ATTR) === CLIENT_VERSION)
					bar.remove();
				if (globalThis[STATE] === state)
					delete globalThis[STATE];
			};
			state = { version: CLIENT_VERSION, dispose: cleanup };
			globalThis[STATE] = state;
			if (ctx !== undefined && typeof ctx.effect === "function")
				ctx.effect(() => cleanup, "dsh-jev-effort: composer hint");
		}
		exports.inject = ["locale"];
		exports.apply = apply;
		return exports;
	}
});
