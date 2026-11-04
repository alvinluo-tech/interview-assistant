import {useEffect,useRef,type RefObject} from 'react';

/** Keep keyboard input within a modal even when controls change during streaming. */
export function useModalFocus(root:RefObject<HTMLElement|null>,open:boolean,onEscape?:()=>void,initial?:RefObject<HTMLElement|null>) {
  const escape=useRef(onEscape);escape.current=onEscape;
  useEffect(()=>{
    const element=root.current;if(!open||!element)return;
    const previous=document.activeElement as HTMLElement|null;
    const backgrounds=Array.from(document.body.children).filter(child=>!child.contains(element)) as HTMLElement[];
    const inert=backgrounds.map(child=>child.inert);backgrounds.forEach(child=>{child.inert=true;});
    const controls=()=>Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')).filter(item=>!item.closest('[inert]')&&item.getClientRects().length>0);
    const focus=()=>{(initial?.current||controls()[0]||element).focus();};
    const onFocus=(event:FocusEvent)=>{if(!element.contains(event.target as Node))focus();};
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&escape.current){event.preventDefault();event.stopPropagation();escape.current();return;}
      if(event.key!=='Tab')return;
      const items=controls(),first=items[0]||element,last=items[items.length-1]||element;
      if(!element.contains(document.activeElement)||(!event.shiftKey&&document.activeElement===last)||(event.shiftKey&&(document.activeElement===first||document.activeElement===element))){event.preventDefault();(event.shiftKey?last:first).focus();}
    };
    focus();document.addEventListener('focusin',onFocus);window.addEventListener('keydown',onKey,true);
    return()=>{document.removeEventListener('focusin',onFocus);window.removeEventListener('keydown',onKey,true);backgrounds.forEach((child,index)=>{child.inert=inert[index];});queueMicrotask(()=>{if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus();});};
  },[root,open,initial]);
}
