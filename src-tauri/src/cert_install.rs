//! Windows CA 一键安装（复刻 Reqable 行为）。
//!
//! 安装：对工作区根目录的 `proxy-crab-ca.crt` 执行
//! `certutil -user -addstore Root`，写入当前用户「受信任的根证书颁发机构」；
//! 系统会弹出一次确认框，无需管理员权限。
//!
//! 状态检测：证书指纹（DER 的 SHA-1）在 Windows 证书存储中以指纹为键名存放在
//! 注册表 `SystemCertificates\Root\Certificates` 下，因此直接检查注册表键是否
//! 存在（覆盖当前用户、本地机器与企业策略三个位置），无需拉起子进程。

use std::path::Path;

use base64::Engine;
use serde::Serialize;

const ROOT_CERTIFICATES_PATHS: &[(&str, &str)] = &[
    (
        "HKEY_CURRENT_USER",
        "Software\\Microsoft\\SystemCertificates\\Root\\Certificates",
    ),
    (
        "HKEY_LOCAL_MACHINE",
        "Software\\Microsoft\\SystemCertificates\\Root\\Certificates",
    ),
    (
        "HKEY_LOCAL_MACHINE",
        "Software\\Microsoft\\EnterpriseCertificates\\Root\\Certificates",
    ),
];

/// CA 安装状态：`supported` 为 false 表示当前平台不支持一键安装。
#[derive(Debug, Clone, Serialize)]
pub struct CertificateInstallState {
    pub supported: bool,
    pub installed: bool,
}

/// 安装 CA 到当前用户受信任的根证书存储；弹出系统确认框，等待用户选择。
#[cfg(windows)]
pub fn install(certificate_path: &Path) -> Result<(), String> {
    if !certificate_path.is_file() {
        return Err(format!("CA 证书文件不存在：{}", certificate_path.display()));
    }
    let output = std::process::Command::new("certutil")
        .args(["-user", "-addstore", "Root"])
        .arg(certificate_path)
        .output()
        .map_err(|error| format!("启动 certutil 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    let detail = if detail.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    } else {
        detail.to_owned()
    };
    Err(format!(
        "certutil 安装失败（{}）：{}",
        output.status,
        last_lines(&detail, 3)
    ))
}

/// 依据证书 PEM 检测安装状态；非 Windows 平台返回不支持。
#[cfg(windows)]
pub fn install_status(certificate_pem: &str) -> CertificateInstallState {
    match certificate_thumbprint(certificate_pem) {
        Some(thumbprint) => CertificateInstallState {
            supported: true,
            installed: store_contains(&thumbprint),
        },
        None => CertificateInstallState {
            supported: true,
            installed: false,
        },
    }
}

/// 非 Windows 平台不支持一键安装。
#[cfg(not(windows))]
pub fn install_status(_certificate_pem: &str) -> CertificateInstallState {
    CertificateInstallState {
        supported: false,
        installed: false,
    }
}

#[cfg(not(windows))]
pub fn install(_certificate_path: &Path) -> Result<(), String> {
    Err("仅 Windows 桌面端支持一键安装 CA 证书".into())
}

/// 解析 PEM 提取 DER，再计算 SHA-1 指纹的小写十六进制串。
/// 文件为裸 DER 时直接哈希；无法解析时返回 None。
#[cfg(windows)]
fn certificate_thumbprint(certificate_pem: &str) -> Option<String> {
    use base64::engine::general_purpose::STANDARD;
    use sha1::{Digest, Sha1};

    let der: Vec<u8> = if certificate_pem.contains("-----BEGIN CERTIFICATE-----") {
        let body: String = certificate_pem
            .lines()
            .skip_while(|line| !line.contains("-----BEGIN CERTIFICATE-----"))
            .skip(1)
            .take_while(|line| !line.contains("-----END CERTIFICATE-----"))
            .collect();
        STANDARD.decode(body.as_bytes()).ok()?
    } else {
        certificate_pem.bytes().collect()
    };
    Some(hex_lower(&Sha1::digest(&der)))
}

#[cfg(windows)]
fn hex_lower(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

/// 检查证书存储（当前用户 / 本地机器 / 企业策略）是否存在该指纹。
#[cfg(windows)]
fn store_contains(thumbprint: &str) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE};

    let hkey = |name: &str| match name {
        "HKEY_CURRENT_USER" => HKEY_CURRENT_USER,
        _ => HKEY_LOCAL_MACHINE,
    };
    for (hive, path) in ROOT_CERTIFICATES_PATHS {
        let Ok(root) =
            winreg::RegKey::predef(hkey(hive)).open_subkey_with_flags(path, KEY_QUERY_VALUE)
        else {
            continue;
        };
        if root
            .open_subkey_with_flags(thumbprint, KEY_QUERY_VALUE)
            .is_ok()
        {
            return true;
        }
    }
    false
}

/// 取错误输出的最后几行，避免 toast 被刷屏。
fn last_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn thumbprint_hashes_pem_body() {
        let pem = "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n";
        let thumb = certificate_thumbprint(pem).unwrap();
        // base64("foo") = "Zm9v"；SHA-1("foo") 固定值。
        assert_eq!(thumb, "0beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a33");
    }

    #[cfg(windows)]
    #[test]
    fn thumbprint_handles_raw_der_input() {
        let thumb = certificate_thumbprint("foo").unwrap();
        assert_eq!(thumb, "0beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a33");
    }

    #[test]
    fn last_lines_keeps_tail_only() {
        let text = "line1\nline2\n\nline3";
        assert_eq!(last_lines(text, 2), "line2 | line3");
    }
}
