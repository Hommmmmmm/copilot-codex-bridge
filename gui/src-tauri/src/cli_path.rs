use std::env;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 解析 sidecar 可执行文件路径。
///
/// 命名约定：开发期产物在 `gui/src-tauri/binaries/copilot-bridge-<triple>(.exe)`，
/// 但 Tauri 打包 macOS 时会把 sidecar 拷到 `Contents/MacOS/copilot-bridge`（去掉
/// triple 后缀），Windows 则保留 `.exe`。我们两种文件名都尝试。
pub fn resolve_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    let triple = target_triple()?;
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let suffixed = format!("copilot-bridge-{triple}{exe_ext}");
    let plain = format!("copilot-bridge{exe_ext}");

    let mut tried: Vec<PathBuf> = Vec::new();

    // 1. 打包后：macOS 在 Contents/MacOS/，其它平台在 resource_dir/。
    //    macOS 上 resource_dir 是 Contents/Resources/，但 externalBin 实际放在
    //    可执行目录（Contents/MacOS/）。同时找两处。
    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in [&plain, &suffixed] {
            let c = resource_dir.join(name);
            if c.exists() {
                return Ok(c);
            }
            tried.push(c);
        }
        // macOS: 资源旁边的 MacOS 目录（Contents/MacOS/）
        if let Some(parent) = resource_dir.parent() {
            let macos_dir = parent.join("MacOS");
            for name in [&plain, &suffixed] {
                let c = macos_dir.join(name);
                if c.exists() {
                    return Ok(c);
                }
                tried.push(c);
            }
        }
    }
    // 2. 备选：进程自己所在目录（兼容 NSIS 安装后的扁平布局）
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [&plain, &suffixed] {
                let c = dir.join(name);
                if c.exists() {
                    return Ok(c);
                }
                tried.push(c);
            }
        }
    }
    // 3. dev 模式：仓库里的 binaries/ 目录（cwd 通常是 gui/src-tauri/ 或 gui/）
    if let Ok(cwd) = env::current_dir() {
        let dev_dirs = [
            cwd.join("binaries"),
            cwd.join("src-tauri").join("binaries"),
            cwd.join("gui").join("src-tauri").join("binaries"),
        ];
        for dir in dev_dirs.iter() {
            for name in [&suffixed, &plain] {
                let c = dir.join(name);
                if c.exists() {
                    return Ok(c);
                }
                tried.push(c);
            }
        }
    }

    Err(format!(
        "未找到 sidecar 二进制（已尝试: {}）",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn target_triple() -> Result<&'static str, String> {
    if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        Ok("aarch64-apple-darwin")
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        Ok("x86_64-apple-darwin")
    } else if cfg!(all(target_arch = "aarch64", target_os = "windows")) {
        Ok("aarch64-pc-windows-msvc")
    } else if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
        Ok("x86_64-pc-windows-msvc")
    } else if cfg!(all(target_arch = "aarch64", target_os = "linux")) {
        Ok("aarch64-unknown-linux-gnu")
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        Ok("x86_64-unknown-linux-gnu")
    } else {
        Err("当前平台不支持".into())
    }
}
