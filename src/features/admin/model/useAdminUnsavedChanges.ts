'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

const WARNING = 'Есть несохранённые изменения. Они ещё не опубликованы и могут потеряться при уходе. Покинуть страницу?';

function retainedPanel(from: string, to: string) {
  const source = new URL(from), destination = new URL(to, source);
  if (source.origin !== destination.origin) return false;
  if (source.pathname === destination.pathname && source.search === destination.search) return true;
  return /^\/admin\/site\/?$/.test(source.pathname) && source.pathname === destination.pathname;
}

/** Protect Panel-owned drafts without mutating browser or Next router history. */
export function useAdminUnsavedChanges(hasUnsaved: boolean) {
  const dirty = useRef(hasUnsaved);
  const allowedUntil = useRef(0);
  useLayoutEffect(() => {
    dirty.current = hasUnsaved;
    allowedUntil.current = 0;
  }, [hasUnsaved]);
  const confirmLeave = useCallback(() => {
    if (!dirty.current) return true;
    if (!window.confirm(WARNING)) return false;
    // An accepted plain anchor should not immediately trigger a second native
    // beforeunload prompt. A failed/intercepted navigation must not disable the
    // guard indefinitely (for example, if logout fails).
    allowedUntil.current = Date.now() + 500;
    return true;
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current || Date.now() < allowedUntil.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (!dirty.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target.toLowerCase() !== '_self')) return;
      const destination = new URL(anchor.href, window.location.href);
      if (!/^https?:$/.test(destination.protocol) || retainedPanel(window.location.href, destination.href)) return;
      if (!confirmLeave()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    // SPA Back/Forward deliberately remains under Next/browser control:
    // popstate cannot safely cancel it, and cancelling Navigation API traversal
    // is inconsistent in WebKit. Panel-owned drafts must survive SPA unmounts
    // in their separate in-memory workspace instead of rewriting history here.
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [confirmLeave]);

  return { confirmLeave };
}
