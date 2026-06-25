use crate::cli_path;
use crate::process::{kill_managed, spawn_managed, ProcessKind, ProcessState};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

// ============================================================
// 通用工具
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpStatus {
    pub status: String,
    pub message: String,
}

fn ok() -> OpStatus {
    OpStatus {
        status: "ok".into(),
        message: String::new(),
    }
}

fn fail(msg: impl Into<String>) -> OpStatus {
    OpStatus {
        status: "failed".into(),
        message: msg.into(),
    }
}

/// 解析 sidecar 路径
fn locate_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    cli_path::resolve_sidecar(app)
}

// ============================================================
// 1. 状态：登录 / 代理 / 当前模型
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub authenticated: bool,
    pub expires_at: i64,
    pub remaining_minutes: i64,
}

#[tauri::command]
pub fn login_status() -> LoginStatus {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return LoginStatus { authenticated: false, expires_at: 0, remaining_minutes: 0 },
    };
    let auth_file = home.join(".copilot-codex-bridge/auth.json");
    let raw = match std::fs::read_to_string(&auth_file) {
        Ok(s) => s,
        Err(_) => return LoginStatus { authenticated: false, expires_at: 0, remaining_minutes: 0 },
    };
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return LoginStatus { authenticated: false, expires_at: 0, remaining_minutes: 0 },
    };
    let expires_at = json["copilot_expires_at"].as_i64().unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let remaining = ((expires_at - now) / 60).max(0);
    LoginStatus {
        authenticated: !json["github_token"].as_str().unwrap_or("").is_empty(),
        expires_at,
        remaining_minutes: remaining,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    /// 当前 bind 的 host：127.0.0.1 = 仅本机；0.0.0.0 = 同局域网可访问
    pub host: String,
    /// 本机所有非 loopback 的 IPv4 地址，方便 GUI 显示「http://192.168.x.x:port/v1」
    pub lan_ips: Vec<String>,
}

#[tauri::command]
pub async fn proxy_status(state: State<'_, ProcessState>) -> Result<ProxyStatus, String> {
    let s = state.lock().await;
    Ok(ProxyStatus {
        running: s.proxy.is_some(),
        pid: s.proxy.as_ref().map(|c| c.pid()),
        port: s.proxy_port.unwrap_or(8787),
        host: s.proxy_host.clone().unwrap_or_else(|| "127.0.0.1".into()),
        lan_ips: list_lan_ipv4(),
    })
}

/// 列出所有非 loopback 的 IPv4 地址（macOS：通过解析 `ifconfig` 输出；不引新依赖）
fn list_lan_ipv4() -> Vec<String> {
    use std::process::Command;
    let output = Command::new("ifconfig")
        .output()
        .ok()
        .filter(|o| o.status.success());
    let Some(out) = output else { return Vec::new(); };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ips = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("inet ") else { continue };
        // 形如 `inet 192.168.1.5 netmask 0xffffff00 broadcast 192.168.1.255`
        let Some(ip) = rest.split_whitespace().next() else { continue };
        if ip == "127.0.0.1" || ip.starts_with("169.254.") {
            continue;
        }
        ips.push(ip.to_string());
    }
    ips
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub launch_running: bool,
    pub launch_pid: Option<u32>,
    pub current_model: Option<String>,
}

#[tauri::command]
pub async fn codex_status(state: State<'_, ProcessState>) -> Result<CodexStatus, String> {
    let s = state.lock().await;
    Ok(CodexStatus {
        launch_running: s.launch.is_some(),
        launch_pid: s.launch.as_ref().map(|c| c.pid()),
        current_model: s.current_model.clone(),
    })
}

// ============================================================
// 2. 启动 / 停止代理
// ============================================================

#[tauri::command]
pub async fn start_proxy(
    port: Option<u16>,
    expose_lan: Option<bool>,
    state: State<'_, ProcessState>,
    app: AppHandle,
) -> Result<OpStatus, String> {
    // 已经在跑就先停掉旧的
    {
        let mut s = state.lock().await;
        if let Some(mut old) = s.proxy.take() {
            let _ = old.kill().await;
        }
    }

    let sidecar = locate_sidecar(&app)?;
    let port = port.unwrap_or(8787);
    let host = if expose_lan.unwrap_or(false) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let args = vec![
        "start".into(),
        "--port".into(),
        port.to_string(),
        "--host".into(),
        host.into(),
    ];
    let child = spawn_managed(sidecar, args, "proxy".into(), app)
        .await
        .map_err(|e| format!("启动代理失败：{e}"))?;

    {
        let mut s = state.lock().await;
        s.proxy = Some(child);
        s.proxy_port = Some(port);
        s.proxy_host = Some(host.to_string());
    }
    Ok(ok())
}

#[tauri::command]
pub async fn stop_proxy(state: State<'_, ProcessState>) -> Result<OpStatus, String> {
    kill_managed(state.inner(), ProcessKind::Proxy)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ok())
}

// ============================================================
// 3. 模型列表 / 切换 + launch
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
}

/// 调代理的 /v1/model-catalog 接口拿模型列表
#[tauri::command]
pub async fn list_models() -> Result<Vec<ModelInfo>, String> {
    let res = reqwest_get("http://127.0.0.1:8787/v1/model-catalog").await?;
    let json: serde_json::Value = serde_json::from_str(&res).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    if let Some(arr) = json["models"].as_array() {
        for m in arr {
            if let Some(id) = m.as_str() {
                out.push(ModelInfo {
                    id: id.to_string(),
                    name: id.to_string(),
                    category: None,
                });
            }
        }
    }
    Ok(out)
}

/// 简易 HTTP GET（避免引 reqwest 依赖）
async fn reqwest_get(url: &str) -> Result<String, String> {
    // 用 std + tokio TcpStream 写太麻烦，直接调 curl
    let output = tokio::process::Command::new("curl")
        .args(&["-sf", url])
        .output()
        .await
        .map_err(|e| format!("curl 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "GET {url} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

/// launch Codex.app + 注入菜单 patch + 切换模型
/// 内部 spawn `node dist/index.js launch <model>`，保持进程运行（bridge handler 需要）
#[tauri::command]
pub async fn launch_codex(
    model: String,
    state: State<'_, ProcessState>,
    app: AppHandle,
) -> Result<OpStatus, String> {
    // 先停旧 launch
    {
        let mut s = state.lock().await;
        if let Some(mut old) = s.launch.take() {
            let _ = old.kill().await;
        }
        s.current_model = None;
    }

    let sidecar = locate_sidecar(&app)?;
    let child = spawn_managed(
        sidecar,
        vec!["launch".into(), model.clone()],
        "launch".into(),
        app,
    )
    .await
    .map_err(|e| format!("启动 launch 失败：{e}"))?;

    {
        let mut s = state.lock().await;
        s.launch = Some(child);
        s.current_model = Some(model);
    }
    Ok(ok())
}

#[tauri::command]
pub async fn stop_codex(state: State<'_, ProcessState>) -> Result<OpStatus, String> {
    kill_managed(state.inner(), ProcessKind::Launch)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ok())
}

// ============================================================
// 4. 登录 / 退出（device flow）
// ============================================================

/// 触发 GitHub device flow（开浏览器 + 用户粘 user code）
/// 这是个长流程，调用方需要订阅 "login://stdout" 看 user code
#[tauri::command]
pub async fn run_login(app: AppHandle) -> Result<OpStatus, String> {
    spawn_one_shot(vec!["login".into()], "login", app).await
}

/// 退出 Copilot 授权：调 CLI logout 命令删 auth.json
#[tauri::command]
pub async fn run_logout(app: AppHandle) -> Result<OpStatus, String> {
    spawn_one_shot(vec!["logout".into()], "login", app).await
}

// ============================================================
// 5. 一键 install（注入 copilot_proxy provider 到 ~/.codex/config.toml）
// ============================================================

#[tauri::command]
pub async fn run_install(app: AppHandle) -> Result<OpStatus, String> {
    spawn_one_shot(vec!["install".into()], "install", app).await
}


/// 跑一次性 CLI 命令（spawn → 等退出 → 不持有 child）
/// 关键：必须 wait 进程退出，否则 child drop 时 kill_on_drop=true 会杀掉进程
async fn spawn_one_shot(
    args: Vec<String>,
    event_prefix: &'static str,
    app: AppHandle,
) -> Result<OpStatus, String> {
    let sidecar = locate_sidecar(&app)?;
    let mut managed = spawn_managed(sidecar, args, event_prefix.into(), app)
        .await
        .map_err(|e| format!("启动 {event_prefix} 失败：{e}"))?;

    // 等进程退出（最多 5 分钟，device flow 有 15 分钟超时但通常更快）
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(15 * 60),
        managed.child.wait(),
    )
    .await;

    match status {
        Ok(Ok(exit)) if exit.success() => Ok(ok()),
        Ok(Ok(exit)) => Ok(fail(format!("命令退出码 {}", exit.code().unwrap_or(-1)))),
        Ok(Err(e)) => Ok(fail(format!("等待进程失败: {e}"))),
        Err(_) => {
            let _ = managed.kill().await;
            Ok(fail("命令超时"))
        }
    }
}
