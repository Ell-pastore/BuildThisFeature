use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A single entry in a directory listing.
///
/// Field names are serialized in camelCase so they map cleanly onto the
/// shared frontend `FileItem` model.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    id: String,
    name: String,
    path: String,
    is_folder: bool,
    size_bytes: u64,
    /// Only present for directories.
    item_count: Option<u64>,
    /// Lowercased file extension ("pdf", "docx", ...) or "folder".
    file_type: String,
    /// Human readable size, e.g. "2.4 MB" (folders render as "—").
    size: String,
    created: String,
    modified: String,
    /// Raw modification time (epoch seconds) so the UI can sort numerically.
    modified_ts: i64,
    created_ts: i64,
}

/// Result of listing a directory.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    parent_path: Option<String>,
    is_home: bool,
    items: Vec<FileEntry>,
}

/// Format a numeric size into a compact human readable string.
fn format_size(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", value, units[unit])
    }
}

/// Convert days-since-epoch to a (year, month, day) tuple.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_date(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{}, {}, {}", months[(m - 1) as usize], d, y)
}

fn map_io_error(err: &io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::PermissionDenied => "Permission denied.".to_string(),
        ErrorKind::NotFound => "The file or folder no longer exists.".to_string(),
        ErrorKind::AlreadyExists => "A file or folder with that name already exists.".to_string(),
        _ => err.to_string(),
    }
}
/// Return the user's home directory.
#[tauri::command]
fn home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Unable to determine the home directory".to_string())
}

/// Read the contents of a directory and return structured entries.
///
/// If `path` is empty/None the user's home directory is listed instead.
/// Symbolic links are skipped and only the requested directory is read — we
/// never recurse into subdirectories.
#[tauri::command]
fn list_directory(path: Option<String>) -> Result<DirectoryListing, String> {
    let target = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => dirs::home_dir().ok_or_else(|| "Unable to determine the home directory".to_string())?,
    };

    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to open this folder: {}", map_io_error(&e)))?;

    if !canonical.is_dir() {
        return Err("The selected path is not a folder".to_string());
    }

    let read = fs::read_dir(&canonical)
        .map_err(|e| format!("Unable to open this folder: {}", map_io_error(&e)))?;

    let mut items: Vec<FileEntry> = Vec::new();
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // skip entries we cannot stat
        };
        // Do not follow symbolic links.
        if meta.file_type().is_symlink() {
            continue;
        }

        let file_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Creation time is not reliably available everywhere; fall back to the
        // modification time so the UI always has a value.
        let created_secs = modified_secs;

        let is_folder = meta.is_dir();
        let item_count = if is_folder {
            file_path.read_dir().ok().map(|r| r.count() as u64)
        } else {
            None
        };

        let file_type = if is_folder {
            "folder".to_string()
        } else {
            file_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_else(|| "file".to_string())
        };

        items.push(FileEntry {
            id: file_path.to_string_lossy().into_owned(),
            name,
            path: file_path.to_string_lossy().into_owned(),
            is_folder,
            size_bytes: if meta.is_file() { meta.len() } else { 0 },
            item_count,
            file_type,
            size: if is_folder { "—".to_string() } else { format_size(meta.len()) },
            created: format_date(created_secs),
            modified: format_date(modified_secs),
            modified_ts: modified_secs,
            created_ts: created_secs,
        });
    }

    // Folders first, then case-insensitive name order.
    items.sort_by(|a, b| {
        b.is_folder
            .cmp(&a.is_folder)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let home = dirs::home_dir()
        .map(|h| h.canonicalize().unwrap_or(h))
        .unwrap_or_else(|| PathBuf::from(""));

    Ok(DirectoryListing {
        path: canonical.to_string_lossy().into_owned(),
        parent_path: canonical.parent().map(|p| p.to_string_lossy().into_owned()),
        is_home: home == canonical,
        items,
    })
}

/// Validate an item name so it cannot escape its parent directory.
fn validate_item_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    Ok(name.to_string())
}

/// Create a new folder inside `dir`.
#[tauri::command]
fn create_folder(dir: String, name: String) -> Result<(), String> {
    let name = validate_item_name(&name)?;
    let target = Path::new(&dir).join(&name);
    if target.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::create_dir(&target).map_err(|e| format!("Unable to create folder: {}", map_io_error(&e)))
}

/// Rename a file or folder in place (only the name changes, not location).
#[tauri::command]
fn rename_item(from: String, new_name: String) -> Result<(), String> {
    let name = validate_item_name(&new_name)?;
    let source = PathBuf::from(&from);
    if !source.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let destination = source.with_file_name(&name);
    if destination == source {
        return Ok(());
    }
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::rename(&source, &destination).map_err(|e| format!("Unable to rename: {}", map_io_error(&e)))
}

/// Move an item into another directory, keeping its current file name.
#[tauri::command]
fn move_item(source: String, dest_dir: String) -> Result<(), String> {
    let source = PathBuf::from(&source);
    let dest_dir = PathBuf::from(&dest_dir);

    if !source.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    if !dest_dir.is_dir() {
        return Err("The destination is not a folder".to_string());
    }

    let name = source
        .file_name()
        .ok_or_else(|| "Invalid source item".to_string())?;
    let destination = dest_dir.join(name);

    if destination == source {
        return Ok(());
    }
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::rename(&source, &destination).map_err(|e| format!("Unable to move: {}", map_io_error(&e)))
}

/// Delete a file or folder. The UI must confirm before calling this.
#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let meta = fs::metadata(&target).map_err(|e| format!("Unable to delete: {}", map_io_error(&e)))?;
    let result = if meta.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|e| format!("Unable to delete: {}", map_io_error(&e)))
}

/// Open a file/folder with the operating system's default application.
#[tauri::command]
fn open_item(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    open::that(target).map_err(|e| format!("Unable to open this item: {}", e))
}

/// Real capacity information for the volume containing `path` (defaults to
/// the user's home directory).
///
/// This reads filesystem statistics only (statfs/statvfs via `libc`, which is
/// already part of our dependency tree). It performs NO directory scanning and
/// no recursive traversal — it simply asks the OS how big the volume is and
/// how many bytes are free.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskUsage {
    /// Total volume size in bytes.
    total_bytes: u64,
    /// Free bytes available to unprivileged users.
    free_bytes: u64,
}

/// Read real free/total space for the volume containing `path`.
///
/// macOS exposes statfs; Linux and other Unix flavours expose statvfs. Both
/// report block counts multiplied by a block size. Windows support can be
/// added later via GetDiskFreeSpaceExW — until then it reports unsupported.
#[cfg(target_os = "macos")]
fn volume_usage(path: &Path) -> Result<DiskUsage, String> {
    use std::ffi::CString;
    let c_path = CString::new(path.as_os_str().to_string_lossy().as_bytes())
        .map_err(|_| "Unable to open this folder.".to_string())?;
    unsafe {
        let mut fs_stat: libc::statfs = std::mem::zeroed();
        if libc::statfs(c_path.as_ptr(), &mut fs_stat) != 0 {
            return Err("Unable to read disk usage.".to_string());
        }
        let bsize = fs_stat.f_bsize as u64;
        Ok(DiskUsage {
            total_bytes: bsize.saturating_mul(fs_stat.f_blocks as u64),
            free_bytes: bsize.saturating_mul(fs_stat.f_bavail as u64),
        })
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn volume_usage(path: &Path) -> Result<DiskUsage, String> {
    use std::ffi::CString;
    let c_path = CString::new(path.as_os_str().to_string_lossy().as_bytes())
        .map_err(|_| "Unable to open this folder.".to_string())?;
    unsafe {
        let mut vfs: libc::statvfs_t = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut vfs) != 0 {
            return Err("Unable to read disk usage.".to_string());
        }
        let frsize = vfs.f_frsize as u64;
        Ok(DiskUsage {
            total_bytes: frsize.saturating_mul(vfs.f_blocks as u64),
            free_bytes: frsize.saturating_mul(vfs.f_bavail as u64),
        })
    }
}

#[cfg(not(unix))]
fn volume_usage(_path: &Path) -> Result<DiskUsage, String> {
    Err("Disk usage is not supported on this platform yet.".to_string())
}

#[tauri::command]
fn disk_usage(path: Option<String>) -> Result<DiskUsage, String> {
    let target = match &path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => dirs::home_dir()
            .ok_or_else(|| "Unable to determine the home directory".to_string())?,
    };
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    volume_usage(&target)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        home_directory,
        list_directory,
        create_folder,
        rename_item,
        move_item,
        delete_item,
        open_item,
        disk_usage,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
