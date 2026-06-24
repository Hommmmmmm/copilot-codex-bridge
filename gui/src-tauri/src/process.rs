use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// 全局共享的进程管理状态（用 tauri::State 注入）
pub type ProcessState = Arc<Mutex<Processes>>;

#[derive(Default)]
pub struct Processes {
    /// `copilot-bridge start` 代理进程
    pub proxy: Option<ManagedChild>,
    /// 代理当前用的端口（启动时记录）
    pub proxy_port: Option<u16>,
    /// `copilot-bridge launch <model>` CDP 注入进程
    pub launch: Option<ManagedChild>,
    /// 当前 launch 用的 model
    pub current_model: Option<String>,
}

/// 被管理的子进程 + 元信息
pub struct ManagedChild {
    pub child: Child,
    pub pid: u32,
}

impl ManagedChild {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// kill 进程（SIGKILL）
    pub async fn kill(&mut self) -> std::io::Result<()> {
        self.child.kill().await
    }
}

/// spawn 一个 sidecar 子进程，stdout/stderr 通过 emit 事件推到前端
///
/// `event_prefix`：前端订阅事件名前缀。"proxy" 会发 "proxy://stdout" 和 "proxy://stderr"
pub async fn spawn_managed(
    executable: PathBuf,
    args: Vec<String>,
    event_prefix: String,
    app: AppHandle,
) -> anyhow::Result<ManagedChild> {
    let mut command = Command::new(&executable);
    command
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Windows: 不弹黑窗
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| anyhow::anyhow!("spawned process has no pid"))?;

    // 转发 stdout
    if let Some(stdout) = child.stdout.take() {
        let app_out = app.clone();
        let evt = format!("{event_prefix}://stdout");
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_out.emit(&evt, line);
            }
        });
    }

    // 转发 stderr
    if let Some(stderr) = child.stderr.take() {
        let app_err = app.clone();
        let evt = format!("{event_prefix}://stderr");
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_err.emit(&evt, line);
            }
        });
    }

    Ok(ManagedChild { child, pid })
}

/// 杀掉 state 里的某个进程（proxy / launch）
pub async fn kill_managed(state: &ProcessState, kind: ProcessKind) -> anyhow::Result<()> {
    let mut state = state.lock().await;
    let target = match kind {
        ProcessKind::Proxy => {
            state.proxy_port = None;
            state.proxy.take()
        }
        ProcessKind::Launch => {
            state.current_model = None;
            state.launch.take()
        }
    };
    if let Some(mut managed) = target {
        let _ = managed.kill().await;
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub enum ProcessKind {
    Proxy,
    Launch,
}
