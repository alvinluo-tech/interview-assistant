// Build-only fixture. Never imported by a normal production build.
import WebSocket from '@tauri-apps/plugin-websocket';
import {getIdentifier} from '@tauri-apps/api/app';
import type {RealtimeConnect} from '../../src/lib/realtimeAsrProtocol';
export const connectRealtimeSocket: RealtimeConnect = async (_url,options)=>{
  if(await getIdentifier()!=='com.mianlingai.clone.audiosmoke')throw new Error('Realtime fixture requires the isolated application');
  const url=new URL((window as unknown as {__realtimeSmokeUrl:string}).__realtimeSmokeUrl);
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search)throw new Error('Realtime fixture only accepts a local synthetic server');
  return WebSocket.connect(url.href,options);
};
