use serde::Serialize;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn image(language: &str) -> Result<&'static str, String> {
    match language {
        "python" => Ok("python:3.13-alpine"),
        "javascript" => Ok("node:22-alpine"),
        _ => Err("暂只支持 Python 3 与 JavaScript 完整程序。".into()),
    }
}
fn create_args(name: &str, language: &str, code: &str) -> Result<Vec<String>, String> {
    if code.trim().is_empty() || code.len() > 16000 || code.contains('\0') {
        return Err("代码应为 1～16000 字节且不含空字符。".into());
    }
    let mut args = vec![
        "create",
        "--pull=never",
        "--name",
        name,
        "-i",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--memory=256m",
        "--memory-swap=256m",
        "--cpus=0.5",
        "--user=65534:65534",
        "--ulimit=nofile=64:64",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--env=HOME=/tmp",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        "--entrypoint",
        if language == "python" {
            "python"
        } else {
            "node"
        },
        image(language)?,
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    args.extend(
        if language == "python" {
            vec!["-I", "-c", code]
        } else {
            vec!["--max-old-space-size=128", "-e", code]
        }
        .into_iter()
        .map(str::to_string),
    );
    Ok(args)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
    passed: bool,
}
fn process(args: &[String], input: &str, timeout: Duration) -> Result<RunResult, String> {
    let mut command = Command::new("docker");
    // The built-in default context uses the local socket/pipe. Never dispatch code to a remote daemon.
    command
        .args(["--context", "default"])
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT");
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Docker；请安装并启动 Docker Desktop 的 Linux 引擎。")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.take(65537).read_to_end(&mut bytes);
            let truncated = bytes.len() > 65536;
            bytes.truncate(65536);
            (String::from_utf8_lossy(&bytes).into_owned(), truncated)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let input = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let _ = writer.join();
    let (stdout, out_truncated) = out.join().unwrap_or_default();
    let (stderr, err_truncated) = err.join().unwrap_or_default();
    Ok(RunResult {
        stdout,
        stderr,
        exit_code: status.code(),
        timed_out,
        truncated: out_truncated || err_truncated,
        passed: false,
    })
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}
#[tauri::command]
pub async fn cmd_code_check() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let info=process(&args(&["info","--format","{{.OSType}}"]),"",Duration::from_secs(4))?;
        if info.timed_out || info.exit_code!=Some(0) || info.stdout.trim()!="linux" {return Err("Docker Linux 引擎未就绪。请启动 Docker Desktop 并切换到 Linux 容器。".into());}
        let mut available=Vec::new();
        for language in ["python","javascript"] {
            let name=image(language)?;
            let status=process(&args(&["image","inspect",name]),"",Duration::from_secs(3))?;
            if status.exit_code==Some(0) {available.push(language);}
        }
        Ok(format!("Linux 容器引擎已就绪；本地可用运行时：{}。缺少时请自行执行 docker pull python:3.13-alpine 或 docker pull node:22-alpine。",if available.is_empty(){"无".to_string()}else{available.join("、")}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn cmd_code_run(
    language: String,
    code: String,
    stdin: String,
    expected: String,
) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if stdin.len() > 64000 || expected.len() > 64000 {
            return Err("样例输入与输出各最多 64000 字节。".into());
        }
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!("mianling-check-{}-{id}", std::process::id());
        let create = create_args(&name, &language, &code)?;
        let created = process(&create, "", Duration::from_secs(5));
        let result = (|| {
            let created = created?;
            if created.exit_code != Some(0) || created.timed_out {
                return Err(format!(
                    "创建隔离容器失败。请先检查 Docker 和本地 {} 镜像：{}",
                    image(&language)?,
                    created.stderr.chars().take(500).collect::<String>()
                ));
            }
            let mut result = process(
                &args(&["start", "-a", "-i", &name]),
                &stdin,
                Duration::from_secs(10),
            )?;
            result.passed = !result.timed_out
                && !result.truncated
                && result.exit_code == Some(0)
                && result.stdout.replace("\r\n", "\n").trim_end()
                    == expected.replace("\r\n", "\n").trim_end();
            Ok(result)
        })();
        // Always remove the named container, including timeout and failed start paths.
        let cleanup = process(&args(&["rm", "-f", &name]), "", Duration::from_secs(4));
        if !matches!(&cleanup,Ok(value) if value.exit_code==Some(0)&&!value.timed_out)
            && result.is_ok()
        {
            return Err(format!(
                "执行结束，但未能清理容器 {name}。请在 Docker Desktop 中删除。"
            ));
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_uses_a_restricted_container_without_host_mounts_or_shell_interpolation() {
        let code = "print('$(do not execute on host)')";
        let args = create_args("mianling-test", "python", code).unwrap();
        for flag in [
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=256m",
            "--user=65534:65534",
        ] {
            assert!(args.contains(&flag.to_string()), "missing {flag}");
        }
        assert!(
            !args.iter().any(|arg| arg == "-v"
                || arg.starts_with("--volume")
                || arg.starts_with("--mount"))
        );
        assert_eq!(args.last().unwrap(), code);
        assert!(create_args("mianling-test", "shell", "echo unsafe").is_err());
        assert!(create_args("mianling-test", "python", &"x".repeat(64001)).is_err());
    }
}
