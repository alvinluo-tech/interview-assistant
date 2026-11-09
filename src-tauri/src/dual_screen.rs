/*
 * 手机副屏（exam-dual 本地版）：在局域网起一个 HTTP+WebSocket 服务，
 * 手机扫码打开托管页，浮窗 UI 状态与动作经此中继（原版走 api.mianlingai.com 的
 * exam.toSecondary/toPrimary 消息族，见 _recon/spec/04-exam.md §8）。
 * - GET（无 Upgrade）→ 返回内嵌手机页 dual_page.html；
 * - WebSocket（路径校验 token）→ 双向消息：手机→“dual-message”事件，宿主→cmd_dual_send；
 * - 连接/断开 → “dual-peer”事件 {count}；同一 token 只允许一台手机（新连顶旧连）。
 */
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DualState {
    generation: AtomicU64,
    token: Mutex<String>,
    peer_tx: Mutex<Option<Arc<mpsc::SyncSender<String>>>>,
    stop_flag: Mutex<Arc<AtomicBool>>,
    connections: Arc<ConnectionSlots>,
}

impl Default for DualState {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            token: Mutex::new(String::new()),
            peer_tx: Mutex::new(None),
            stop_flag: Mutex::new(Arc::new(AtomicBool::new(false))),
            connections: Arc::new(ConnectionSlots::new(32)),
        }
    }
}
impl DualState {
    pub(crate) fn has_peer(&self) -> bool { self.peer_tx.lock().map(|p| p.is_some()).unwrap_or(false) }
}

const PAGE: &str = include_str!("dual_page.html");

// Shared across restarts: unfinished old handshakes still count toward the cap.
struct ConnectionSlots { used: AtomicUsize, limit: usize }
struct ConnectionPermit { slots: Arc<ConnectionSlots> }
impl ConnectionSlots {
    fn new(limit: usize) -> Self { Self { used: AtomicUsize::new(0), limit } }
    fn try_acquire(self: &Arc<Self>) -> Option<ConnectionPermit> {
        self.used.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|used| (used<self.limit).then_some(used+1)).ok()?;
        Some(ConnectionPermit { slots: self.clone() })
    }
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) { self.slots.used.fetch_sub(1,Ordering::SeqCst); }
}

fn read_request_head(stream: &mut TcpStream, stopped: &AtomicBool, deadline: std::time::Instant) -> std::io::Result<Vec<u8>> {
    use std::io::{Error,ErrorKind};
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8;1024];
    loop {
        if stopped.load(Ordering::SeqCst) { return Err(Error::new(ErrorKind::Interrupted,"session stopped")); }
        let remaining = deadline.checked_duration_since(std::time::Instant::now())
            .filter(|remaining| !remaining.is_zero()).ok_or_else(|| Error::new(ErrorKind::TimedOut,"header deadline"))?;
        stream.set_read_timeout(Some(remaining.min(std::time::Duration::from_millis(100))))?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(Error::new(ErrorKind::UnexpectedEof,"incomplete headers")),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|bytes| bytes==b"\r\n\r\n") {
                    if end+4>8192 { return Err(Error::new(ErrorKind::InvalidData,"headers too large")); }
                    return Ok(buf);
                }
                if buf.len()>=8192 { return Err(Error::new(ErrorKind::InvalidData,"headers too large")); }
            }
            Err(error) if matches!(error.kind(),ErrorKind::TimedOut|ErrorKind::WouldBlock|ErrorKind::Interrupted) => {},
            Err(error) => return Err(error),
        }
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全的副屏连接令牌")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 局域网 IPv4（UDP connect 8.8.8.8 取本端地址，不真正发包）
fn lan_ips() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                out.push(addr.ip().to_string());
            }
        }
    }
    out.push("127.0.0.1".to_string());
    out
}

fn emit_peer(app: &AppHandle, count: u32) {
    emit_peer_reason(app, count, if count > 0 { "connected" } else { "disconnected" });
}

fn emit_peer_reason(app: &AppHandle, count: u32, reason: &str) {
    let _ = app.emit("dual-peer", serde_json::json!({ "count": count, "reason": reason }));
}

fn authorized_request(line: &str, token: &str, websocket: bool) -> bool {
    if token.is_empty() { return false; }
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || parts[2] != "HTTP/1.1" { return false; }
    let Some((path, query)) = parts[1].split_once('?') else { return false; };
    if path != if websocket { "/ws" } else { "/" } { return false; }
    let mut tokens = query.split('&').filter_map(|pair| pair.strip_prefix("token="));
    tokens.next() == Some(token) && tokens.next().is_none()
}

fn current_peer(state: &DualState, generation: u64, tx: &Arc<mpsc::SyncSender<String>>) -> bool {
    state.generation.load(Ordering::SeqCst) == generation
        && state.peer_tx.lock().unwrap().as_ref().is_some_and(|current| Arc::ptr_eq(current, tx))
}

#[tauri::command]
pub fn cmd_dual_start(app: AppHandle, state: State<'_, DualState>) -> Result<serde_json::Value, String> {
    let updater = app.state::<crate::updater::UpdateState>();
    let _activity = updater.activity_guard()?;
    stop_server(&state);
    emit_peer_reason(&app, 0, "restarted");
    let token = random_token()?;
    let session_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    *state.stop_flag.lock().unwrap() = Arc::clone(&stop);
    *state.token.lock().unwrap() = token.clone();

    let app_handle = app.clone();
    let connections = state.connections.clone();
    std::thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let Some(permit) = connections.try_acquire() else { drop(stream); continue; };
                    let app = app_handle.clone();
                    let stopped = stop.clone();
                    let accepted_at = std::time::Instant::now();
                    let _ = std::thread::Builder::new().name("phone-connection".into()).spawn(move || {
                        let _permit = permit;
                        handle_conn(app, stream, session_gen, &stopped,accepted_at);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });

    let urls: Vec<String> = lan_ips().into_iter().map(|ip| format!("http://{ip}:{port}")).collect();
    Ok(serde_json::json!({ "port": port, "token": token, "urls": urls }))
}

fn handle_conn(app: AppHandle, mut stream: TcpStream, session_gen: u64, stopped: &AtomicBool,accepted_at: std::time::Instant) {
    if stream.set_write_timeout(Some(std::time::Duration::from_secs(2))).is_err() { return; }
    let deadline = accepted_at+std::time::Duration::from_secs(5);
    let Ok(buf) = read_request_head(&mut stream,stopped,deadline) else { return; };
    let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()).filter(|time| !time.is_zero()) else { return; };
    if stream.set_write_timeout(Some(remaining.min(std::time::Duration::from_secs(2)))).is_err() { return; }
    let head = String::from_utf8_lossy(&buf).to_string();
    let first_line = head.lines().next().unwrap_or_default().to_string();
    let is_ws = head.to_ascii_lowercase().contains("upgrade: websocket");
    let state: State<DualState> = app.state();
    if stopped.load(Ordering::SeqCst) || state.generation.load(Ordering::SeqCst)!=session_gen { return; }
    let token_ok = authorized_request(&first_line, &state.token.lock().unwrap(), is_ws);
    if !token_ok {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    if !is_ws {
        let body = PAGE.as_bytes();
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        );
        let _ = stream.write_all(body);
        return;
    }
    // WebSocket：tungstenite 接管（回放已读的请求头）
    stream.set_nonblocking(false).ok();
    // Keep the handshake timeout and bound writes, including stopped peers.
    let prefixed = PrefixedStream { prefix: buf, pos: 0, inner: stream };
    let config = tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(64 * 1024),
        max_frame_size: Some(64 * 1024),
        ..Default::default()
    };
    let ws = match tungstenite::accept_with_config(prefixed, Some(config)) {
        Ok(ws) => ws,
        Err(_) => return,
    };
    if state.generation.load(Ordering::SeqCst) != session_gen {
        return; // 会话已换代，拒绝旧连接
    }
    serve_peer(app, ws, session_gen);
}

/// 把已读出的请求头字节回放给 tungstenite（其 accept 需要从头读完整握手）
struct PrefixedStream {
    prefix: Vec<u8>,
    pos: usize,
    inner: TcpStream,
}

impl Read for PrefixedStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.prefix.len() {
            let n = std::cmp::min(buf.len(), self.prefix.len() - self.pos);
            buf[..n].copy_from_slice(&self.prefix[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl Write for PrefixedStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn serve_peer(app: AppHandle, mut ws: tungstenite::WebSocket<PrefixedStream>, session_gen: u64) {
    let updater = app.state::<crate::updater::UpdateState>();
    let Ok(activity) = updater.activity_guard() else { return; };
    let state: State<DualState> = app.state();
    let (tx, rx) = mpsc::sync_channel::<String>(8);
    let tx = Arc::new(tx);
    {
        let mut guard = state.peer_tx.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) != session_gen { return; }
        // The old reader checks ownership on every poll and closes its socket.
        *guard = Some(Arc::clone(&tx));
        emit_peer(&app, 1);
    }
    drop(activity);

    let mut closed = false;
    // 全程阻塞模式：写不会被 WouldBlock 打断；读用 40ms 超时轮询收发两向
    ws.get_mut().inner.set_read_timeout(Some(std::time::Duration::from_millis(40))).ok();
    let mut last_seen = std::time::Instant::now();
    let mut last_ping = std::time::Instant::now();
    while !closed && current_peer(&state, session_gen, &tx) {
        if last_seen.elapsed() > std::time::Duration::from_secs(20) { break; }
        if last_ping.elapsed() > std::time::Duration::from_secs(5) {
            if ws.send(tungstenite::Message::Ping(Vec::new())).is_err() { break; }
            last_ping = std::time::Instant::now();
        }
        while let Ok(text) = rx.try_recv() {
            if ws.write(tungstenite::Message::Text(text.into())).is_err() {
                log::warn!("[dual] write failed, closing");
                closed = true;
                break;
            }
            let _ = ws.flush();
        }
        if closed {
            break;
        }
        match ws.read() {
            Ok(tungstenite::Message::Text(text)) => {
                if !current_peer(&state, session_gen, &tx) { break; }
                last_seen = std::time::Instant::now();
                if let Err(error) = app.emit_to("overlay", "dual-message", text.to_string()) {
                    log::error!("[dual] emit dual-message failed: {error}");
                }
                let _ = app.emit_to("main", "dual-message", text.to_string());
            }
            Ok(tungstenite::Message::Ping(p)) => {
                last_seen = std::time::Instant::now();
                let _ = ws.send(tungstenite::Message::Pong(p));
            }
            Ok(tungstenite::Message::Pong(_)) => { last_seen = std::time::Instant::now(); }
            Ok(tungstenite::Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed)
            | Err(tungstenite::Error::AlreadyClosed) => {
                log::info!("[dual] peer closed");
                closed = true;
            }
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(err) => {
                log::warn!("[dual] read error: {err}");
                closed = true;
            }
            Ok(_) => {}
        }
    }
    // 连接结束：仅当注册者仍是自己时清空并广播断开（被新连接顶替则不动）
    let mut guard = state.peer_tx.lock().unwrap();
    if state.generation.load(Ordering::SeqCst) == session_gen
        && guard.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &tx)) {
        *guard = None;
        emit_peer(&app, 0);
    }
    drop(guard);
    // A control acknowledgement may have been queued just before stop/replacement.
    // Do not send stale answer snapshots to the retired connection.
    while let Ok(text) = rx.try_recv() {
        if serde_json::from_str::<serde_json::Value>(&text).ok()
            .and_then(|value| value.get("t").and_then(|kind| kind.as_str()).map(str::to_owned))
            .is_some_and(|kind| kind == "released" || kind == "ended") {
            let _ = ws.send(tungstenite::Message::Text(text));
        }
    }
    let _ = ws.close(None);
    let _ = ws.get_mut().inner.shutdown(std::net::Shutdown::Both);
}

#[tauri::command]
pub fn cmd_dual_send(state: State<'_, DualState>, text: String) -> Result<bool, String> {
    let guard = state.peer_tx.lock().unwrap();
    match guard.as_ref() {
        Some(tx) => Ok(tx.try_send(text).is_ok()),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn cmd_dual_peer_count(state: State<'_, DualState>) -> u32 {
    let guard = state.peer_tx.lock().unwrap();
    u32::from(guard.is_some())
}

#[tauri::command]
pub fn cmd_dual_stop(app: AppHandle, state: State<'_, DualState>) {
    stop_server(&state);
    emit_peer_reason(&app, 0, "stopped");
}

fn stop_server(state: &DualState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    // 先置停止位让 accept 循环退出，再换新旗子给下一轮 start
    state.stop_flag.lock().unwrap().store(true, Ordering::SeqCst);
    *state.stop_flag.lock().unwrap() = Arc::new(AtomicBool::new(false));
    *state.peer_tx.lock().unwrap() = None;
    *state.token.lock().unwrap() = String::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_poisoned_peer_lock_does_not_report_a_peer() {
        let state = DualState::default();
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.peer_tx.lock().unwrap();
            panic!("poison the peer lock");
        }));
        assert!(poisoned.is_err());
        assert!(!state.has_peer());
    }

    #[test]
    fn connection_slots_are_bounded_and_released_on_drop() {
        let slots = Arc::new(ConnectionSlots::new(2));
        let first = slots.try_acquire().unwrap();
        let second = slots.try_acquire().unwrap();
        assert!(slots.try_acquire().is_none());
        drop(first);
        let third = slots.try_acquire().unwrap();
        assert!(slots.try_acquire().is_none());
        drop((second, third));
        assert_eq!(slots.used.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn concurrent_connections_cannot_exceed_the_global_limit() {
        let slots = Arc::new(ConnectionSlots::new(4));
        let ready = Arc::new(std::sync::Barrier::new(17));
        let release = Arc::new(std::sync::Barrier::new(17));
        let mut threads = Vec::new();
        for _ in 0..16 {
            let (slots,ready,release) = (slots.clone(),ready.clone(),release.clone());
            threads.push(std::thread::spawn(move || {
                let permit = slots.try_acquire();
                ready.wait();
                release.wait();
                drop(permit);
            }));
        }
        ready.wait();
        assert_eq!(slots.used.load(Ordering::SeqCst), 4);
        release.wait();
        for thread in threads { thread.join().unwrap(); }
        assert_eq!(slots.used.load(Ordering::SeqCst), 0);
    }

    fn tcp_pair() -> (TcpStream,TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server,_) = listener.accept().unwrap();
        (server,client)
    }

    #[test]
    fn headers_complete_within_the_deadline_and_keep_prefetched_bytes() {
        let (mut server,mut client) = tcp_pair();
        client.write_all(b"GET /?token=synthetic HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let bytes = read_request_head(&mut server,&AtomicBool::new(false),std::time::Instant::now()+std::time::Duration::from_secs(1)).unwrap();
        assert!(bytes.ends_with(b"\r\n\r\n"));
    }

    #[test]
    fn slow_drip_headers_do_not_renew_the_absolute_deadline() {
        let (mut server,mut client) = tcp_pair();
        let stop = Arc::new(AtomicBool::new(false));
        let sender_stop = stop.clone();
        let sender = std::thread::spawn(move || {
            while !sender_stop.load(Ordering::SeqCst) {
                if client.write_all(b"x").is_err() { break; }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        let began = std::time::Instant::now();
        let result = read_request_head(&mut server,&stop,began+std::time::Duration::from_millis(80));
        stop.store(true,Ordering::SeqCst);sender.join().unwrap();
        assert_eq!(result.unwrap_err().kind(),std::io::ErrorKind::TimedOut);
        assert!(began.elapsed()<std::time::Duration::from_secs(1));
    }

    #[test]
    fn oversized_and_incomplete_headers_are_rejected() {
        let (mut server,mut client) = tcp_pair();
        client.write_all(&vec![b'x';8193]).unwrap();
        let result = read_request_head(&mut server,&AtomicBool::new(false),std::time::Instant::now()+std::time::Duration::from_secs(1));
        assert_eq!(result.unwrap_err().kind(),std::io::ErrorKind::InvalidData);
        let (mut server,mut client) = tcp_pair();
        client.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        drop(client);
        assert_eq!(read_request_head(&mut server,&AtomicBool::new(false),std::time::Instant::now()+std::time::Duration::from_secs(1)).unwrap_err().kind(),std::io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn stopping_a_session_cancels_its_pending_header_reads() {
        let (mut server,_client) = tcp_pair();
        let result = read_request_head(&mut server,&AtomicBool::new(true),std::time::Instant::now()+std::time::Duration::from_secs(1));
        assert_eq!(result.unwrap_err().kind(),std::io::ErrorKind::Interrupted);
    }

    #[test]
    fn pairing_requires_a_nonempty_exact_token_on_the_correct_route() {
        let token = "0123456789abcdef0123456789abcdef";
        assert!(authorized_request(&format!("GET /?token={token} HTTP/1.1"), token, false));
        assert!(authorized_request(&format!("GET /ws?token={token} HTTP/1.1"), token, true));
        for (line, expected, ws) in [
            (format!("GET /ws?token=x{token} HTTP/1.1"), token, true),
            (format!("GET /ws?other={token} HTTP/1.1"), token, true),
            (format!("GET /wrong?token={token} HTTP/1.1"), token, true),
            (format!("GET /ws?token={token}&token=other HTTP/1.1"), token, true),
            ("GET /ws?token=anything HTTP/1.1".into(), "", true),
            (format!("POST /ws?token={token} HTTP/1.1"), token, true),
        ] { assert!(!authorized_request(&line, expected, ws), "{line}"); }
    }

    #[test]
    fn replacement_and_stop_revoke_the_previous_reader() {
        let state = DualState::default();
        let (first, _first_rx) = mpsc::sync_channel(8);
        let first = Arc::new(first);
        *state.peer_tx.lock().unwrap() = Some(first.clone());
        assert!(current_peer(&state, 0, &first));
        let (second, _second_rx) = mpsc::sync_channel(8);
        let second = Arc::new(second);
        *state.peer_tx.lock().unwrap() = Some(second.clone());
        assert!(!current_peer(&state, 0, &first));
        assert!(current_peer(&state, 0, &second));
        stop_server(&state);
        assert!(!current_peer(&state, 0, &second));
        assert!(!authorized_request("GET /ws?token=old HTTP/1.1", &state.token.lock().unwrap(), true));
    }
}
