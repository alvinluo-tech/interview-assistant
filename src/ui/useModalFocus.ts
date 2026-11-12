import {useEffect,useRef,type RefObject} from 'react';

interface ModalEntry {
  element: HTMLElement;
  parent?: HTMLElement | null;
  previous: HTMLElement | null;
  initial?: RefObject<HTMLElement | null>;
  escape: {current:(()=>void)|undefined};
  zIndex: string;
}
const stack: ModalEntry[] = [];
const inert = new Map<HTMLElement,boolean>();
let overflow = '', observer: MutationObserver | undefined;
const top = () => stack[stack.length-1];
export const isTopModal = (element: HTMLElement | null) => !!element && top()?.element === element;
const controls = (entry: ModalEntry) => Array.from(entry.element.querySelectorAll<HTMLElement>(
  'button,input,textarea,select,a[href],summary,[contenteditable],[tabindex]',
)).filter(item => item.tabIndex >= 0 && !item.matches(':disabled') && !item.closest('[inert]') && item.getClientRects().length > 0);
const focus = (entry: ModalEntry) => {
  const preferred = entry.initial?.current;
  (preferred?.isConnected && entry.element.contains(preferred) ? preferred : controls(entry)[0] || entry.element).focus();
};
function sync() {
  const wanted = new Set<HTMLElement>();
  let element: HTMLElement | null = top()?.element || null;
  while (element?.parentElement) {
    const parent: HTMLElement = element.parentElement;
    for (const child of Array.from(parent.children)) if (child !== element && child instanceof HTMLElement) wanted.add(child);
    if (parent === document.body) break;
    element = parent;
  }
  for (const [child,previous] of inert) if (!wanted.has(child)) {child.inert=previous;inert.delete(child);}
  for (const child of wanted) {if(!inert.has(child))inert.set(child,child.inert);child.inert=true;}
  stack.forEach((entry,index)=>{entry.element.style.zIndex=String(50+index*10);});
}
const inPopup = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[data-modal-popup]');
function onFocus(event: FocusEvent) {
  // 选择器弹层挂在 Dialog 内的自由浮层：焦点进去时不要把焦点抢回对话框。
  if (inPopup(event.target)) return;
  const entry=top();if(entry && !entry.element.contains(event.target as Node))focus(entry);
}
function onKey(event: KeyboardEvent) {
  const entry=top();if(!entry)return;
  if(event.isComposing)return;
  // 弹层自己处理 Esc 与 Tab；这里放手，否则会先关掉整个 Dialog。
  if(inPopup(event.target))return;
  if(event.key==='Escape') {
    // A locked modal must also stop Escape from dismissing a lower layer.
    event.preventDefault();event.stopImmediatePropagation();entry.escape.current?.();return;
  }
  if(event.key!=='Tab')return;
  const items=controls(entry),first=items[0]||entry.element,last=items[items.length-1]||entry.element;
  if(!items.length || !entry.element.contains(document.activeElement) || (!event.shiftKey && document.activeElement===last) ||
    (event.shiftKey && (document.activeElement===first || document.activeElement===entry.element))) {
    event.preventDefault();(event.shiftKey?last:first).focus();
  }
}

/** One stack owns focus/inert/Escape, including portals and nested StrictMode mounts. */
export function useModalFocus(root: RefObject<HTMLElement|null>,open: boolean,onEscape?:()=>void,
  initial?: RefObject<HTMLElement|null>,parent?: RefObject<HTMLElement|null>) {
  const escape=useRef(onEscape);escape.current=onEscape;
  useEffect(()=>{
    const element=root.current;if(!open||!element)return;
    const entry: ModalEntry={element,parent:parent?.current,previous:document.activeElement as HTMLElement|null,initial,escape,zIndex:element.style.zIndex};
    if(!stack.length) {
      overflow=document.body.style.overflow;document.body.style.overflow='hidden';
      document.addEventListener('focusin',onFocus,true);window.addEventListener('keydown',onKey,true);
      observer=new MutationObserver(sync);observer.observe(document.body,{childList:true});
    }
    // Child effects can run before their parent's effect on the first mount.
    const child=stack.findIndex(item=>item.parent===element);
    if(child<0)stack.push(entry);else stack.splice(child,0,entry);
    sync();if(top()===entry)focus(entry);
    return()=>{
      const index=stack.indexOf(entry);if(index<0)return;
      const wasTop=top()===entry;
      stack.splice(index,1);element.style.zIndex=entry.zIndex;
      // Closing a whole subtree returns focus to its opener, not a detached input.
      for(const item of stack)if(item.previous && element.contains(item.previous))item.previous=entry.previous;
      sync();
      if(!stack.length) {
        observer?.disconnect();observer=undefined;document.body.style.overflow=overflow;
        document.removeEventListener('focusin',onFocus,true);window.removeEventListener('keydown',onKey,true);
      }
      const restore = () => {
        const current=top();
        if(entry.previous?.isConnected && !entry.previous.closest('[inert]') && (!current||current.element.contains(entry.previous)))entry.previous.focus();
        else if(current?.element.isConnected && !current.element.contains(document.activeElement))focus(current);
      };
      // Restore synchronously so StrictMode's next setup records the real opener.
      if(wasTop) {restore();queueMicrotask(restore);}
    };
  },[root,open,initial,parent]);
}
