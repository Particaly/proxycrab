//! Windows 系统代理接管（复刻 Reqable 行为）。
//!
//! 桌面端代理启动时把 WinINET 系统代理指向 `127.0.0.1:{port}`，停止或退出时恢复
//! 原值。原值备份在应用数据目录的 `system_proxy_backup.json`：进程异常退出后，
//! 备份残留会在下次启动时静默恢复，避免系统代理残留导致用户断网。
//!
//! 接管时同时清空 `ProxyOverride` 旁路列表：残留的 `192.168.*` 等局域网条目会让
//! 浏览器绕过代理直连内网地址，导致这类请求抓不到；原值同样在备份里，恢复时还原。
//!
//! 写入注册表 `HKCU\...\Internet Settings` 后通过 `InternetSetOptionW` 广播刷新，
//! 运行中的应用无需重启即可感知代理变化。非 Windows 平台一律报告不支持。

use std::path::Path;

use serde::{Deserialize, Serialize};

const INTERNET_SETTINGS_PATH: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const BACKUP_FILE: &str = "system_proxy_backup.json";

/// 系统代理接管状态：`enabled` 表示当前处于接管中（存在备份）。
#[derive(Debug, Clone, Serialize)]
pub struct SystemProxyStatus {
    pub supported: bool,
    pub enabled: bool,
    pub server: Option<String>,
}

/// 接管前的系统代理原值备份；`server` 记录本次接管设置的代理地址。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProxyBackup {
    proxy_enable: Option<u32>,
    proxy_server: Option<String>,
    proxy_override: Option<String>,
    server: String,
}

fn backup_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(BACKUP_FILE)
}

fn read_backup(app_data_dir: &Path) -> Option<ProxyBackup> {
    let bytes = std::fs::read(backup_path(app_data_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 原子写入备份（临时文件 + 改名），避免崩溃撕裂 JSON 导致无法恢复。
fn write_backup(app_data_dir: &Path, backup: &ProxyBackup) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(backup).map_err(|error| error.to_string())?;
    let path = backup_path(app_data_dir);
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)
        .and_then(|_| std::fs::rename(&temporary, &path))
        .map_err(|error| format!("写入系统代理备份失败：{error}"))
}

fn remove_backup(app_data_dir: &Path) {
    let _ = std::fs::remove_file(backup_path(app_data_dir));
}

/// 恢复备份的系统代理原值（如果存在备份）。应用启动时调用以兜底
/// 上次进程异常退出留下的接管状态。
pub fn recover_if_needed(app_data_dir: &Path) {
    if read_backup(app_data_dir).is_some() {
        if let Err(error) = restore(app_data_dir) {
            tracing::warn!("failed to recover system proxy from last run: {error}");
        } else {
            tracing::info!("recovered system proxy settings from a previous run");
        }
    }
}

/// 当前接管状态；非 Windows 平台返回 `supported: false`。
pub fn status(app_data_dir: &Path) -> SystemProxyStatus {
    match read_backup(app_data_dir) {
        Some(backup) => SystemProxyStatus {
            supported: true,
            enabled: true,
            server: Some(backup.server),
        },
        None => SystemProxyStatus {
            supported: true,
            enabled: false,
            server: None,
        },
    }
}

/// 接管系统代理：备份现值并把 WinINET 代理指向 `127.0.0.1:{port}`。
/// 已处于接管中时仅更新代理地址，原值备份保持不变。
/// `ProxyOverride` 旁路列表会被一并接管为空（原值在备份里，`restore` 时还原），
/// 否则残留的局域网条目会让浏览器绕过代理，内网 IP 请求抓不到。
#[cfg(windows)]
pub fn enable(app_data_dir: &Path, port: u16) -> Result<(), String> {
    let server = format!("127.0.0.1:{port}");
    let server_for_backup = server.clone();
    let existing = read_backup(app_data_dir);
    let backup = match existing {
        Some(backup) => ProxyBackup { server, ..backup },
        None => {
            let (proxy_enable, proxy_server, proxy_override) = read_proxy_values();
            let backup = ProxyBackup {
                proxy_enable,
                proxy_server,
                proxy_override,
                server: server_for_backup.clone(),
            };
            write_backup(app_data_dir, &backup)?;
            backup
        }
    };
    let key = open_settings_key()?;
    key.set_value("ProxyEnable", &1u32)
        .map_err(|error| format!("写入 ProxyEnable 失败：{error}"))?;
    key.set_value("ProxyServer", &backup.server)
        .map_err(|error| format!("写入 ProxyServer 失败：{error}"))?;
    // 旁路列表一并接管为空：残留的 `192.168.*` 等局域网条目会让浏览器绕过代理，
    // 内网 IP 请求就抓不到了。原值已在备份里，`restore` 时还原；值本不存在时删除失败可忽略。
    let _ = key.delete_value("ProxyOverride");
    notify_change();
    Ok(())
}

/// 恢复接管前的系统代理原值并移除备份；无备份时是空操作。
/// 原值缺失的注册表项会被删除，还原到「从未设置」的状态。
#[cfg(windows)]
pub fn restore(app_data_dir: &Path) -> Result<(), String> {
    let Some(backup) = read_backup(app_data_dir) else {
        return Ok(());
    };
    let key = open_settings_key()?;
    let set_or_delete_u32 = |name: &str, value: Option<u32>| -> Result<(), String> {
        match value {
            Some(value) => key
                .set_value(name, &value)
                .map_err(|error| format!("恢复 {name} 失败：{error}")),
            // 原本没有这个值：删除以还原，不存在时删除失败可忽略。
            None => {
                let _ = key.delete_value(name);
                Ok(())
            }
        }
    };
    let set_or_delete_str = |name: &str, value: Option<&str>| -> Result<(), String> {
        match value {
            Some(value) => key
                .set_value(name, &value)
                .map_err(|error| format!("恢复 {name} 失败：{error}")),
            None => {
                let _ = key.delete_value(name);
                Ok(())
            }
        }
    };
    set_or_delete_u32("ProxyEnable", backup.proxy_enable)?;
    set_or_delete_str("ProxyServer", backup.proxy_server.as_deref())?;
    set_or_delete_str("ProxyOverride", backup.proxy_override.as_deref())?;
    remove_backup(app_data_dir);
    notify_change();
    Ok(())
}

#[cfg(windows)]
fn open_settings_key() -> Result<winreg::RegKey, String> {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            INTERNET_SETTINGS_PATH,
            winreg::enums::KEY_QUERY_VALUE | winreg::enums::KEY_SET_VALUE,
        )
        .map_err(|error| format!("打开系统代理注册表失败：{error}"))
}

#[cfg(windows)]
fn read_proxy_values() -> (Option<u32>, Option<String>, Option<String>) {
    let Ok(key) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(INTERNET_SETTINGS_PATH, winreg::enums::KEY_QUERY_VALUE)
    else {
        return (None, None, None);
    };
    (
        key.get_value("ProxyEnable").ok(),
        key.get_value("ProxyServer").ok(),
        key.get_value("ProxyOverride").ok(),
    )
}

/// 广播 WinINET 设置变化，让运行中的应用立即感知代理变化。
#[cfg(windows)]
fn notify_change() {
    use windows::Win32::Networking::WinInet::{
        INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED, InternetSetOptionW,
    };
    unsafe {
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }
}

#[cfg(not(windows))]
pub fn enable(_app_data_dir: &Path, _port: u16) -> Result<(), String> {
    Err("仅 Windows 桌面端支持自动接管系统代理".into())
}

#[cfg(not(windows))]
pub fn restore(_app_data_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn status(_app_data_dir: &Path) -> SystemProxyStatus {
    SystemProxyStatus {
        supported: false,
        enabled: false,
        server: None,
    }
}

#[cfg(not(windows))]
pub fn recover_if_needed(_app_data_dir: &Path) {}

#[cfg(not(windows))]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_windows_reports_unsupported_and_enable_fails() {
        let dir = tempfile::tempdir().unwrap();
        let status = status(dir.path());
        assert!(!status.supported);
        assert!(!status.enabled);
        assert!(enable(dir.path(), 8089).is_err());
        // 恢复在非 Windows 上是无操作，不应报错。
        restore(dir.path()).unwrap();
    }
}

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_file_drives_takeover_status_without_touching_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        // 空状态：未接管。
        let initial = status(dir.path());
        assert!(initial.supported);
        assert!(!initial.enabled);
        assert!(initial.server.is_none());

        // 存在备份（接管中）：状态翻转并报告代理地址。
        write_backup(
            dir.path(),
            &ProxyBackup {
                proxy_enable: Some(0),
                proxy_server: None,
                proxy_override: None,
                server: "127.0.0.1:8089".into(),
            },
        )
        .unwrap();
        let taken_over = status(dir.path());
        assert!(taken_over.enabled);
        assert_eq!(taken_over.server.as_deref(), Some("127.0.0.1:8089"));

        // 损坏的备份按未接管处理，不阻塞启动恢复逻辑。
        std::fs::write(backup_path(dir.path()), b"not json").unwrap();
        assert!(!status(dir.path()).enabled);

        remove_backup(dir.path());
        assert!(!status(dir.path()).enabled);
        // restore 无备份时是空操作。
        restore(dir.path()).unwrap();
        assert!(!status(dir.path()).enabled);
    }
}
