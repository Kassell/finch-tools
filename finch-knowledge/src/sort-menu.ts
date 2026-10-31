export type SortOrder = 'updated' | 'added' | 'name' | 'modified' | 'type' | 'size';

/** A themed, keyboard-accessible menu; the popup lives under body to avoid pane clipping. */
export function createSortMenu(options: {
  trigger: HTMLButtonElement; menu: HTMLElement; label: HTMLElement;
  getValue: () => SortOrder; getLabel: (value: SortOrder) => string;
  onChange: (value: SortOrder) => void; onOpen?: () => void;
}) {
  const { trigger, menu, label } = options;
  const doc = trigger.ownerDocument;
  const viewport = doc.defaultView!;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-sort]'));
  const listeners: Array<() => void> = [];
  function listen(target: EventTarget, type: string, handler: EventListener, capture = false) {
    target.addEventListener(type, handler, capture);
    listeners.push(() => target.removeEventListener(type, handler, capture));
  }
  function refresh() {
    label.textContent = options.getLabel(options.getValue());
    for (const item of items) {
      const value = item.dataset.sort as SortOrder;
      item.querySelector<HTMLElement>('.sort-option-label')!.textContent = options.getLabel(value);
      item.setAttribute('aria-checked', String(value === options.getValue()));
      item.tabIndex = -1;
    }
  }
  function close(restoreFocus = false) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function open(last = false) {
    options.onOpen?.();
    refresh();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    menu.style.maxHeight = `${Math.max(80, viewport.innerHeight - 16)}px`;
    const anchor = trigger.getBoundingClientRect(), popup = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - popup.width, viewport.innerWidth - popup.width - 8));
    const below = anchor.bottom + 6;
    const top = below + popup.height <= viewport.innerHeight - 8 ? below : Math.max(8, anchor.top - popup.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    (last ? items.at(-1) : items.find(item => item.dataset.sort === options.getValue()) ?? items[0])?.focus();
  }
  function choose(item: HTMLButtonElement) {
    const value = item.dataset.sort as SortOrder;
    const changed = value !== options.getValue();
    close(true);
    if (changed) options.onChange(value);
    refresh();
  }
  listen(trigger, 'click', () => { if (menu.hidden) open(); else close(); });
  listen(trigger, 'keydown', raw => {
    const event = raw as KeyboardEvent;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); open(event.key === 'ArrowUp');
    } else if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault(); close(true);
    }
  });
  for (const item of items) listen(item, 'click', event => { event.stopPropagation(); choose(item); });
  listen(menu, 'keydown', raw => {
    const event = raw as KeyboardEvent;
    const current = items.findIndex(item => item === doc.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      close(true); return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
      event.preventDefault(); choose(items[current]!); return;
    }
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault(); items[next]?.focus();
  });
  listen(doc, 'pointerdown', event => {
    if (!menu.hidden && !trigger.contains(event.target as Node) && !menu.contains(event.target as Node)) close();
  }, true);
  listen(doc, 'focusin', event => {
    if (!menu.hidden && !trigger.contains(event.target as Node) && !menu.contains(event.target as Node)) close();
  });
  listen(viewport, 'resize', () => close());
  listen(doc, 'scroll', event => { if (!menu.contains(event.target as Node)) close(); }, true);
  refresh();
  return { refresh, close, dispose() { close(); for (const remove of listeners) remove(); } };
}
