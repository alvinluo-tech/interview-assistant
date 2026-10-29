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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DualState {
    generation: AtomicU64,
    token: Mutex<String>,
    peer_tx: Mutex<Option<Arc<mpsc::Sender<String>>>>,
    stop_flag: Mutex<Arc<AtomicBool>>,
}

impl Default for DualState {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            token: Mutex::new(String::new()),
            peer_tx: Mutex::new(None),
            stop_flag: Mutex::new(Arc::new(AtomicBool::new(false))),
        }
    }
}

const PAGE: &str = include_str!("dual_page.html");

fn random_token() -> String {
    // RandomState 每进程随机播种，两次 hash 足够做局域网会话令牌
    use std::hash::{BuildHasher, Hash, Hasher};
    let mut h1 = std::collections::hash_map::RandomState::new().build_hasher();
    let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
    std::time::Instant::now().hash(&mut h1);
    std::process::id().hash(&mut h2);
    format!("{:016x}{:016x}", h1.finish(), h2.finish())
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
    let _ = app.emit("dual-peer", serde_json::json!({ "count": count }));
}

fn authorized_request(line: &str, token: &str, _websocket: bool) -> bool {
    line.split_whitespace().nth(1).is_some_and(|path| path.contains(token))
}

#[tauri::command]
pub fn cmd_dual_start(app: AppHandle, state: State<'_, DualState>) -> Result<serde_json::Value, String> {
    stop_server(&state);
    let token = random_token();
    let session_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    *state.stop_flag.lock().unwrap() = Arc::clone(&stop);
    *state.token.lock().unwrap() = token.clone();

    let app_handle = app.clone();
    std::thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let app = app_handle.clone();
                    std::thread::spawn(move || handle_conn(app, stream, session_gen));
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

fn handle_conn(app: AppHandle, mut stream: TcpStream, session_gen: u64) {
    // 读到请求头为止（简陋解析，够用）
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let first_line = head.lines().next().unwrap_or_default().to_string();
    let is_ws = head.to_ascii_lowercase().contains("upgrade: websocket");
    let state: State<DualState> = app.state();
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
    stream.set_read_timeout(None).ok();
    let prefixed = PrefixedStream { prefix: buf, pos: 0, inner: stream };
    let ws = match tungstenite::accept(prefixed) {
        Ok(ws) => ws,
        Err(_) => return,
    };
    if state.generation.load(Ordering::SeqCst) != session_gen {
        return; // 会话已换代，拒绝旧连接
    }
    serve_peer(app, ws);
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

fn serve_peer(app: AppHandle, mut ws: tungstenite::WebSocket<PrefixedStream>) {
    let state: State<DualState> = app.state();
    let (tx, rx) = mpsc::channel::<String>();
    let tx = Arc::new(tx);
    {
        let mut guard = state.peer_tx.lock().unwrap();
        // 顶掉旧连接：旧 sender 的 Arc 计数归零后，其读取循环自然结束
        *guard = Some(Arc::clone(&tx));
    }
    emit_peer(&app, 1);

    let mut closed = false;
    // 全程阻塞模式：写不会被 WouldBlock 打断；读用 40ms 超时轮询收发两向
    ws.get_mut().inner.set_read_timeout(Some(std::time::Duration::from_millis(40))).ok();
    while !closed {
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
                log::info!("[dual] recv: {}", text.chars().take(120).collect::<String>());
                if let Err(error) = app.emit_to("overlay", "dual-message", text.to_string()) {
                    log::error!("[dual] emit dual-message failed: {error}");
                }
                let _ = app.emit_to("main", "dual-message", text.to_string());
            }
            Ok(tungstenite::Message::Ping(p)) => {
                let _ = ws.write(tungstenite::Message::Pong(p));
            }
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
    let still_mine = {
        let guard = state.peer_tx.lock().unwrap();
        guard.as_ref().map(|cur| Arc::ptr_eq(cur, &tx)).unwrap_or(false)
    };
    if still_mine {
        *state.peer_tx.lock().unwrap() = None;
        emit_peer(&app, 0);
    }
}

#[tauri::command]
pub fn cmd_dual_send(state: State<'_, DualState>, text: String) -> Result<bool, String> {
    let guard = state.peer_tx.lock().unwrap();
    match guard.as_ref() {
        Some(tx) => Ok(tx.send(text).is_ok()),
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
    emit_peer(&app, 0);
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
}
