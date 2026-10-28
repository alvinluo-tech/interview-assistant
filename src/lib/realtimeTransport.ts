import WebSocket from '@tauri-apps/plugin-websocket';
import type {RealtimeConnect} from './realtimeAsrProtocol';
export const connectRealtimeSocket: RealtimeConnect = (url,options)=>WebSocket.connect(url,options);
