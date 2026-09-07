//! Filesystem service core for the Smart File Manager desktop app.
//!
//! Every local filesystem operation the frontend can perform lives here as
//! plain functions over `std::fs`, so the safety rules are centralized and
//! unit-testable without a running Tauri runtime. The `#[tauri::command]`
//! wrappers in `lib.rs` delegate 1:1 to these functions — command names,
//! argument names/types and serialized shapes are the frontend IPC contract.
//!
//! # Path safety (the seam for future policy)
//!
//! All operations funnel through two helpers:
//!
//! * [`canonical_dir`] — canonicalizes an existing directory (used for the
//!   directory being listed, created into, or moved into). This resolves `..`
//!   segments and symlinked ancestors, so an operation can never land where
//!   its input string merely looked like it pointed.
//! * [`resolve_in_canonical_parent`] — for operations on an existing item
//!   (rename/delete), canonicalizes the item's parent and re-attaches the
//!   final component verbatim: ancestors are normalized, while a symlinked
//!   leaf keeps its meaning (deleting a symlink removes the link, not its
//!   target; renaming one renames the link).
//!
//! A root-scoped scope/allowlist policy ([`AllowList`]) is now imposed at
//! exactly these two seams: every operation gates its canonical result through
//! [`ensure_allowed`] before touching the filesystem. Membership is based on
//! canonical filesystem location; an empty registry denies every path.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

// ---------------------------------------------------------------------------
// DTOs — serialized camelCase; these shapes are the frontend IPC contract.
// ---------------------------------------------------------------------------

/// A single entry in a directory listing.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    pub size_bytes: u64,
    /// Only present for directories.
    pub item_count: Option<u64>,
    /// Lowercased file extension ("pdf", "docx", ...) or "folder".
    pub file_type: String,
    /// Human readable size, e.g. "2.4 MB" (folders render as "—").
    pub size: String,
    pub created: String,
    pub modified: String,
    /// Raw modification time (epoch seconds) so the UI can sort numerically.
    pub modified_ts: i64,
    pub created_ts: i64,
}

/// Result of listing a directory.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub parent_path: Option<String>,
    pub is_home: bool,
    pub items: Vec<FileEntry>,
}

/// Real capacity of a storage volume.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    /// Total volume size in bytes.
    pub total_bytes: u64,
    /// Free bytes available to unprivileged users.
    pub free_bytes: u64,
}

/// Metadata for a single file or directory.
///
/// Collects filesystem metadata only — the item's contents are never read.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    /// Last path component of the resolved (canonical) target.
    pub name: String,
    /// Canonical absolute path of the resolved target.
    pub path: String,
    pub is_file: bool,
    pub is_folder: bool,
    /// Size in bytes (0 for directories).
    pub size_bytes: u64,
    /// Lowercased file extension without the dot, or None for folders and
    /// extension-less files.
    pub extension: Option<String>,
    /// Whether the name begins with a dot (the app's hidden-file convention).
    pub is_hidden: bool,
    /// Human readable modified date, e.g. "Aug 24, 2026".
    pub modified: String,
    /// Raw modification time in epoch seconds (for numeric sorting).
    pub modified_ts: i64,
    /// Human readable creation date.
    pub created: String,
    /// Raw creation time in epoch seconds.
    pub created_ts: i64,
    /// Human readable accessed date, when the platform provides one.
    pub accessed: Option<String>,
    /// Raw accessed time in epoch seconds, when the platform provides one.
    pub accessed_ts: Option<i64>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Format a numeric size into a compact human readable string.
pub fn format_size(bytes: u64) -> String {
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

pub fn format_date(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!("{}, {}, {}", months[(m - 1) as usize], d, y)
}

pub fn map_io_error(err: &io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::PermissionDenied => "Permission denied.".to_string(),
        ErrorKind::NotFound => "The file or folder no longer exists.".to_string(),
        ErrorKind::AlreadyExists => "A file or folder with that name already exists.".to_string(),
        _ => err.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Path-safety core
// ---------------------------------------------------------------------------

/// Canonicalize an existing directory. `..` segments and symlinked ancestors
/// are resolved, so the returned path is where the operation will actually land.
fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to open this folder: {}", map_io_error(&e)))?;
    if !canonical.is_dir() {
        return Err("The selected path is not a folder".to_string());
    }
    Ok(canonical)
}

/// Canonicalize the existing parent of `path` and re-attach its final
/// component verbatim.
///
/// Used by operations that act ON an existing item (rename/delete): ancestors
/// are normalized (no traversal through `..` or symlinked directories), while
/// the final component is kept verbatim so symlinked leaves keep their meaning.
fn resolve_in_canonical_parent(path: &Path, error_prefix: &str) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Invalid source item".to_string())?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("{}{}", error_prefix, map_io_error(&e)))?;
    Ok(parent.join(file_name))
}

// ---------------------------------------------------------------------------
// Root-scoped security boundary
// ---------------------------------------------------------------------------

/// A registry of canonical allowed roots. Membership is component-aware
/// canonical-path containment — never raw string prefix matching. An empty
/// registry denies every path (fail closed).
pub struct AllowList {
    roots: Vec<PathBuf>,
}

impl AllowList {
    /// Fail-closed initialization: the canonicalized user home directory is
    /// the single allowed root. If the home directory cannot be determined or
    /// canonicalized, an EMPTY registry is returned so that every path-bearing
    /// operation is denied — there is never an unrestricted fallback root.
    pub fn with_default_root() -> Self {
        match dirs::home_dir() {
            None => AllowList::empty(),
            Some(home) => match home.canonicalize() {
                Err(_) => AllowList::empty(),
                Ok(canonical) => {
                    if !canonical.is_dir() {
                        AllowList::empty()
                    } else {
                        AllowList::from_roots(vec![canonical])
                    }
                }
            },
        }
    }

    /// Build a registry from a single root path — used by the application on
    /// startup and by unit tests. The root is canonicalized (and must be an
    /// existing directory) before it is stored.
    #[allow(dead_code)]
    pub fn with_root(root: &str) -> Result<Self, String> {
        let canonical = canonical_dir(root)?;
        Ok(AllowList::from_roots(vec![canonical]))
    }

    /// Register another canonical root. Duplicate registrations are ignored.
    #[allow(dead_code)]
    pub fn register_root(&mut self, root: &str) -> Result<(), String> {
        let canonical = canonical_dir(root)?;
        for existing in self.roots.iter() {
            if existing == &canonical {
                return Ok(());
            }
        }
        self.roots.push(canonical);
        Ok(())
    }

    /// Number of registered roots.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.roots.len()
    }

    /// Read-only access to the canonical allowed roots.
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Whether no root is registered (in which case every path is denied).
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    /// Component-aware canonical membership:
    /// - empty registry → false (fail closed);
    /// - `canonical` equal to a root → true;
    /// - `canonical` a descendant of a root (component boundary) → true;
    /// - otherwise → false.
    pub fn is_allowed(&self, canonical: &PathBuf) -> bool {
        if self.roots.is_empty() {
            return false;
        }
        for root in self.roots.iter() {
            if canonical == root || canonical.starts_with(root) {
                return true;
            }
        }
        false
    }

    fn empty() -> Self {
        AllowList::from_roots(Vec::new())
    }

    fn from_roots(roots: Vec<PathBuf>) -> Self {
        AllowList { roots }
    }
}

/// Safe generic denial message returned to the frontend: it never echoes the
/// rejected filesystem path.
pub const SECURITY_POLICY_ERROR: &str = "This location is outside your allowed folders.";

/// The SINGLE authoritative security gate. `canonical` must already be a
/// canonical filesystem path produced by `canonical_dir` or
/// `resolve_in_canonical_parent` — never a raw input string.
fn ensure_allowed(allow_list: &AllowList, canonical: &PathBuf) -> Result<(), String> {
    if allow_list.is_allowed(canonical) {
        Ok(())
    } else {
        Err(SECURITY_POLICY_ERROR.to_string())
    }
}

/// Validate an item name so it cannot escape its parent directory.
pub fn validate_item_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------
// Operations (called by the Tauri command wrappers in lib.rs)
// ---------------------------------------------------------------------------

/// Return the user's home directory.
pub fn home_directory() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Unable to determine the home directory".to_string())
}

/// Read the contents of a directory and return structured entries.
///
/// If `path` is empty/None the user's home directory is listed instead.
/// Symbolic links are skipped and only the requested directory is read — we
/// never recurse into subdirectories.
pub fn list_directory(
    allow_list: &AllowList,
    path: Option<String>,
) -> Result<DirectoryListing, String> {
    let canonical = match path {
        Some(p) if !p.trim().is_empty() => canonical_dir(&p)?,
        _ => dirs::home_dir()
            .ok_or_else(|| "Unable to determine the home directory".to_string())?
            .canonicalize()
            .map_err(|e| format!("Unable to open this folder: {}", map_io_error(&e)))?,
    };
    ensure_allowed(allow_list, &canonical)?;

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
            size: if is_folder {
                "—".to_string()
            } else {
                format_size(meta.len())
            },
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

/// Create a new folder inside `dir`.
pub fn create_folder(allow_list: &AllowList, dir: &str, name: &str) -> Result<(), String> {
    let name = validate_item_name(name)?;
    let parent = canonical_dir(dir)?;
    ensure_allowed(allow_list, &parent)?;
    let target = parent.join(&name);
    if target.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }
    fs::create_dir(&target).map_err(|e| format!("Unable to create folder: {}", map_io_error(&e)))
}

/// Rename a file or folder in place (only the name changes, not location).
pub fn rename_item(allow_list: &AllowList, from: &str, new_name: &str) -> Result<(), String> {
    let name = validate_item_name(new_name)?;
    let source = PathBuf::from(from);
    if !source.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let source = resolve_in_canonical_parent(&source, "Unable to rename: ")?;
    ensure_allowed(allow_list, &source)?;
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
pub fn move_item(allow_list: &AllowList, source: &str, dest_dir: &str) -> Result<(), String> {
    let source = PathBuf::from(source);
    if !source.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let name = source
        .file_name()
        .ok_or_else(|| "Invalid source item".to_string())?
        .to_owned();
    let source = resolve_in_canonical_parent(&source, "Unable to move: ")?;
    ensure_allowed(allow_list, &source)?;

    let dest_dir = PathBuf::from(dest_dir);
    if !dest_dir.exists() {
        return Err("The destination is not a folder".to_string());
    }
    let dest_dir = dest_dir
        .canonicalize()
        .map_err(|e| format!("Unable to move: {}", map_io_error(&e)))?;
    if !dest_dir.is_dir() {
        return Err("The destination is not a folder".to_string());
    }
    ensure_allowed(allow_list, &dest_dir)?;

    let destination = dest_dir.join(&name);
    if destination == source {
        return Ok(());
    }
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }

    // Path safety: a folder must never be moved into its own subtree —
    // that would detach and corrupt the directory tree.
    if fs::metadata(&source)
        .map_err(|e| format!("Unable to move: {}", map_io_error(&e)))?
        .is_dir()
        && destination.starts_with(&source)
    {
        return Err("Cannot move a folder into itself".to_string());
    }

    fs::rename(&source, &destination).map_err(|e| format!("Unable to move: {}", map_io_error(&e)))
}

/// Delete a file or folder. The UI must confirm before calling this.
pub fn delete_item(allow_list: &AllowList, path: &str) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let target = resolve_in_canonical_parent(&target, "Unable to delete: ")?;
    ensure_allowed(allow_list, &target)?;
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let meta =
        fs::metadata(&target).map_err(|e| format!("Unable to delete: {}", map_io_error(&e)))?;
    let result = if meta.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|e| format!("Unable to delete: {}", map_io_error(&e)))
}

/// Open a file/folder with the operating system's default application.
///
/// The target is FULLY canonicalized (ancestors and leaf) before the policy
/// gate: opening a symlink whose canonical target resolves outside the allowed
/// roots must be rejected before `open::that` is reached.
pub fn open_item(allow_list: &AllowList, path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to open this item: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;
    open::that(canonical).map_err(|e| format!("Unable to open this item: {}", e))
}

/// Real capacity information for the volume containing `path` (defaults to
/// the user's home directory).
///
/// This reads filesystem statistics only (statfs/statvfs via `libc`). It
/// performs NO directory scanning and no recursive traversal.
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

pub fn disk_usage(allow_list: &AllowList, path: Option<String>) -> Result<DiskUsage, String> {
    let target = match &path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            dirs::home_dir().ok_or_else(|| "Unable to determine the home directory".to_string())?
        }
    };
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to read disk usage: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;
    volume_usage(&canonical)
}

/// Read structured metadata for a file or directory without touching its contents.
///
/// The target is FULLY canonicalized (ancestors and leaf) before the policy
/// gate, exactly like [`open_item`]: `..` traversal, symlinked ancestors and
/// the final symlink all resolve first, so `..`/symlink escapes are denied
/// before any metadata is read. `symlink_metadata` is intentionally NOT used —
/// the returned metadata describes the resolved target object.
pub fn get_file_metadata(allow_list: &AllowList, path: &str) -> Result<FileMetadata, String> {
    let target = Path::new(path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to get metadata: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;
    let meta = fs::metadata(&canonical)
        .map_err(|e| format!("Unable to get metadata: {}", map_io_error(&e)))?;

    let name = canonical
        .file_name()
        .ok_or_else(|| "Unable to get metadata.".to_string())?
        .to_string_lossy()
        .to_string();

    let is_folder = meta.is_dir();
    let is_file = meta.is_file();

    // Folders (and extension-less files) have no extension.
    let extension = if is_folder {
        None
    } else {
        canonical
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
    };

    // Same dotfile convention used across the app: a leading dot marks hidden.
    let is_hidden = name.starts_with('.');

    let modified_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Creation time is not reliably available everywhere; fall back to the
    // modification time so the UI always has a value (same as list_directory).
    let created_secs = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_secs);

    let accessed_ts = accessed_secs(&meta);
    let accessed = accessed_ts.map(format_date);

    // Directories always report 0 bytes, matching the FileEntry convention.
    let size_bytes = if is_file { meta.len() } else { 0 };

    Ok(FileMetadata {
        name,
        path: canonical.to_string_lossy().into_owned(),
        is_file,
        is_folder,
        size_bytes,
        extension,
        is_hidden,
        modified: format_date(modified_secs),
        modified_ts: modified_secs,
        created: format_date(created_secs),
        created_ts: created_secs,
        accessed,
        accessed_ts,
    })
}

/// Best-effort last-access time.
///
/// Unix exposes it via `MetadataExt::atime`; other platforms report `None`
/// for now (the field is optional).
#[cfg(unix)]
fn accessed_secs(meta: &fs::Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.atime())
}

#[cfg(not(unix))]
fn accessed_secs(_meta: &fs::Metadata) -> Option<i64> {
    None
}

/// Whether the entry `name` inside `dir` is a symbolic link.
///
/// On Unix the directory entry's own type is inspected via `symlink_metadata`
/// so a link is never followed. On non-Unix platforms there is no standard
/// portable symlink primitive; treat nothing as a link (the copy will use the
/// platform's ordinary file/dir path on those platforms).
#[cfg(unix)]
fn entry_is_symlink(dir: &Path, name: &str) -> bool {
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn entry_is_symlink(_dir: &Path, _name: &str) -> bool {
    false
}

/// Recursively copy the directory `src` into the existing directory `dest_root`
/// under the name `name` (which must not already exist under `dest_root`).
///
/// Child symlinks are NEVER followed: on Unix they are recreated as symlinks
/// preserving their target text, which makes cycles and escapes through child
/// links impossible. Only `src`'s own contents are read.
fn copy_dir_recursive(src: &Path, dest_root: &Path, name: &str) -> Result<(), String> {
    let dest = dest_root.join(name);
    fs::create_dir(&dest).map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;

    let entries = fs::read_dir(src)
        .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?
        .flatten();

    for entry in entries {
        let child_name = entry.file_name().to_string_lossy().to_string();
        let child_path = entry.path();

        if entry_is_symlink(src, &child_name) {
            // Recreate the link verbatim; never follow it.
            #[cfg(unix)]
            {
                use std::os::unix::fs as unix_fs;
                let target = fs::read_link(&child_path)
                    .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;
                let dest_link = dest.join(&child_name);
                unix_fs::symlink(&target, &dest_link)
                    .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;
            }
            #[cfg(not(unix))]
            {
                // No portable symlink primitive; skip the child rather than
                // ever following it.
            }
            continue;
        }

        match fs::metadata(&child_path) {
            Ok(meta) if meta.is_dir() => copy_dir_recursive(&child_path, &dest, &child_name)?,
            _ => {
                fs::copy(&child_path, dest.join(&child_name))
                    .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;
            }
        }
    }
    Ok(())
}

/// Copy a file or folder into a destination directory, keeping its name.
///
/// Both the source (fully canonicalized — ancestors and final symlink) and the
/// destination directory (fully canonicalized, must be an existing directory)
/// are checked against the AllowList before anything is read or written.
/// Recursive folder copies never follow child symlinks. An existing
/// destination item is never overwritten, and a folder is never copied into
/// its own subtree.
pub fn copy_item(allow_list: &AllowList, source: &str, dest_dir: &str) -> Result<(), String> {
    // Resolve and authorize the source (follows the final symlink).
    let source = Path::new(source);
    let source = source
        .canonicalize()
        .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &source)?;
    let name = source
        .file_name()
        .ok_or_else(|| "Invalid source item".to_string())?
        .to_string_lossy()
        .to_string();

    // Resolve and authorize the destination directory.
    let dest_dir = PathBuf::from(dest_dir);
    if !dest_dir.exists() {
        return Err("The destination is not a folder".to_string());
    }
    let dest_dir = dest_dir
        .canonicalize()
        .map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;
    if !dest_dir.is_dir() {
        return Err("The destination is not a folder".to_string());
    }
    ensure_allowed(allow_list, &dest_dir)?;

    let destination = dest_dir.join(&name);
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }

    let meta =
        fs::metadata(&source).map_err(|e| format!("Unable to copy: {}", map_io_error(&e)))?;

    // A folder must never be copied into its own subtree — that would read
    // while writing into the same tree and loop without bound.
    if meta.is_dir() && destination.starts_with(&source) {
        return Err("Cannot copy a folder into itself".to_string());
    }

    if meta.is_dir() {
        if let Err(e) = copy_dir_recursive(&source, &dest_dir, &name) {
            // Do not leave a misleading partially-copied tree behind. Safe:
            // the own-subtree guard above already rejected any case where
            // `destination` could contain `source`.
            let _ = fs::remove_dir_all(&destination);
            return Err(e);
        }
    } else if let Err(e) = fs::copy(&source, &destination) {
        // Remove a partially copied file, if one was created.
        let _ = fs::remove_file(&destination);
        return Err(format!("Unable to copy: {}", map_io_error(&e)));
    }
    Ok(())
}

/// Read the raw bytes of a file (text, image, binary) without interpretation.
///
/// The path is fully canonicalized (ancestors and the final symlink) before the
/// policy gate, exactly like [`get_file_metadata`]: a symlink is resolved to its
/// target, so a link that escapes the allowed root is denied before any content
/// is read. `std::fs::read` happens only after authorization, so no bytes of an
/// out-of-root file ever leak.
pub fn read_file(allow_list: &AllowList, path: &str) -> Result<Vec<u8>, String> {
    let target = Path::new(path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to read this file: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;
    fs::read(&canonical).map_err(|e| format!("Unable to read this file: {}", map_io_error(&e)))
}

/// Write raw bytes to a file, creating it or overwriting an existing file.
///
/// The single existing AllowList gate is applied in two cases so that no write
/// can ever land outside an allowed root:
///
/// * NEW FILE (final component absent): the parent directory is canonicalized
///   and gated, then the write lands in that allowed parent under the literal
///   final name. No symlink is followed, so no escape is possible.
/// * OVERWRITE (final component present): the full target is canonicalized —
///   following a final symlink — and the RESOLVED path is gated. A symlink
///   whose target is outside the allowlist is therefore denied before any
///   write. A broken symlink fails canonicalization and is never written.
///
/// The final filename is validated up front (no `.`, `..`, or empty/trailing
/// component) so traversal cannot be smuggled through the name itself.
pub fn write_file(allow_list: &AllowList, path: &str, content: &[u8]) -> Result<(), String> {
    // String-level final-component validation: reject ".", "..", a trailing
    // separator, and empty paths. This MUST be done on the raw string
    // because Path::file_name() normalizes away a trailing ".".
    let name = path
        .rsplit_once(std::path::is_separator)
        .map(|(_, n)| n)
        .unwrap_or(path);
    if name.is_empty() || name == "." || name == ".." {
        return Err("Invalid file path".to_string());
    }

    let target = Path::new(path);
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Invalid file path".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("Unable to write this file: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &parent)?;

    let target = parent.join(name);

    // Inspect the final component WITHOUT following it.
    match fs::symlink_metadata(&target) {
        Err(_) => {
            // Final component is absent: create a fresh file in the allowed
            // parent. No symlink is followed, so no escape is possible.
            fs::write(&target, content)
                .map_err(|e| format!("Unable to write this file: {}", map_io_error(&e)))
        }
        Ok(_) => {
            // Final component exists (file, dir, symlink, or broken link).
            // Resolve the full target (follows the final symlink) and gate
            // the resolved location before permitting the overwrite.
            let resolved = target
                .canonicalize()
                .map_err(|e| format!("Unable to write this file: {}", map_io_error(&e)))?;
            ensure_allowed(allow_list, &resolved)?;
            fs::write(&target, content)
                .map_err(|e| format!("Unable to write this file: {}", map_io_error(&e)))
        }
    }
}

// ---------------------------------------------------------------------------
// Recursive file search
// ---------------------------------------------------------------------------

/// Build a [`FileEntry`] from a canonical entry path and its pre-fetched
/// metadata. Shares the exact field calculations used by [`list_directory`]
/// so search results match the listing contract one-to-one.
fn build_file_entry(path: &Path, meta: &fs::Metadata) -> FileEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let modified_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let created_secs = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(modified_secs);

    let is_folder = meta.is_dir();

    let item_count = if is_folder {
        path.read_dir().ok().map(|r| r.count() as u64)
    } else {
        None
    };

    let file_type = if is_folder {
        "folder".to_string()
    } else {
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_else(|| "file".to_string())
    };

    FileEntry {
        id: path.to_string_lossy().into_owned(),
        name,
        path: path.to_string_lossy().into_owned(),
        is_folder,
        size_bytes: if meta.is_file() { meta.len() } else { 0 },
        item_count,
        file_type,
        size: if is_folder {
            "—".to_string()
        } else {
            format_size(meta.len())
        },
        created: format_date(created_secs),
        modified: format_date(modified_secs),
        modified_ts: modified_secs,
        created_ts: created_secs,
    }
}

/// Recurse into `dir`, collecting entries whose name contains `query_lower`.
/// Only the already-authorized subtree rooted at the AllowList root is visited.
///
/// Symlinks are never followed (detected via `entry.metadata()` which, like
/// [`list_directory`], does not resolve the final link). Cycle detection uses
/// canonical inode identity on Unix to defend against hardlink-based directory
/// loops and bind mounts. Per-branch errors (permission denied, I/O error)
/// are tolerated and do not abort the overall search.
fn search_recursive(
    dir: &Path,
    query_lower: &str,
    results: &mut Vec<FileEntry>,
    visited: &mut std::collections::HashSet<(u64, u64)>,
) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return, // unreadable directory — skip silently
    };

    for entry in read_dir.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // skip entries we cannot stat
        };

        // Do not follow symbolic links — skip them entirely.
        if meta.file_type().is_symlink() {
            continue;
        }

        let entry_path = entry.path();

        // Cycle detection on Unix: if this directory has already been visited
        // (same device + inode), skip it to avoid infinite recursion.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.is_dir() {
                let key = (meta.dev(), meta.ino());
                if !visited.insert(key) {
                    continue; // already visited this directory inode
                }
            }
        }

        // Case-insensitive substring match on the entry's final component.
        if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
            if name.to_lowercase().contains(query_lower) {
                results.push(build_file_entry(&entry_path, &meta));
            }
        }

        // Recurse into subdirectories.
        if meta.is_dir() {
            search_recursive(&entry_path, query_lower, results, visited);
        }
    }
}

/// Search recursively through every root in the [`AllowList`] for files and
/// directories whose names contain the (case-insensitive) `query` substring.
///
/// # Security
///
/// - The AllowList remains the sole authorization boundary: only canonicalized
///   roots registered in the AllowList are traversed via [`AllowList::roots`].
///   `search_files` never re-derives or re-canonicalizes roots independently.
/// - Symbolic links are never followed, so a symlink cannot expose a target
///   outside an allowed root.
/// - Cycle detection (Unix inode tracking) prevents infinite loops from
///   hardlink-based directory cycles or bind mounts.
/// - Traversal errors are handled per-branch: a single unreadable subdirectory
///   is skipped without aborting the search or exposing unauthorized data.
/// - An empty or whitespace-only query returns an empty result set without
///   touching the filesystem.
/// - Results are sorted by path for deterministic output.
///
/// # Matching
///
/// Filenames are matched using a case-insensitive substring search. Both files
/// and directories are returned when their name contains the query.
pub fn search_files(allow_list: &AllowList, query: &str) -> Result<Vec<FileEntry>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let query_lower = trimmed.to_lowercase();
    let mut results: Vec<FileEntry> = Vec::new();

    for root in allow_list.roots() {
        ensure_allowed(allow_list, root)?;
        search_recursive(root, &query_lower, &mut results, &mut Default::default());
    }

    // Deterministic ordering: sort by canonical path.
    results.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(results)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::SystemTime;

    /// Unique temp directory per test, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .subsec_nanos();
            let path = std::env::temp_dir().join(format!(
                "sfm_fs_test_{}_{}_{}_{}",
                label,
                std::process::id(),
                nanos,
                id
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn child(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[allow(dead_code)]
    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(path, contents).expect("write test file");
    }

    fn str_of(path: &Path) -> String {
        path.to_str().expect("utf-8 temp path").to_string()
    }

    /// AllowList rooted at the temp directory (canonicalized on construction).
    fn allow_for(tmp: &TempDir) -> AllowList {
        AllowList::with_root(&str_of(tmp.path())).unwrap()
    }

    // -- name validation ----------------------------------------------------

    #[test]
    fn validate_name_accepts_normal_names() {
        assert_eq!(validate_item_name("  Report  ").unwrap(), "Report");
        assert_eq!(validate_item_name("notes.txt").unwrap(), "notes.txt");
    }

    #[test]
    fn validate_name_rejects_empty() {
        assert!(validate_item_name("").is_err());
        assert!(validate_item_name("   ").is_err());
    }

    #[test]
    fn validate_name_rejects_dot_components() {
        assert!(validate_item_name(".").is_err());
        assert!(validate_item_name("..").is_err());
    }

    #[test]
    fn validate_name_rejects_path_separators() {
        assert!(validate_item_name("a/b").is_err());
        assert!(validate_item_name("a\\b").is_err());
    }

    // -- create_folder -------------------------------------------------------

    #[test]
    fn create_folder_creates_directory() {
        let tmp = TempDir::new("create_ok");
        let allow = allow_for(&tmp);
        create_folder(&allow, &str_of(tmp.path()), "New Folder").unwrap();
        assert!(tmp.child("New Folder").is_dir());
    }

    #[test]
    fn create_folder_rejects_duplicate() {
        let tmp = TempDir::new("create_dup");
        let allow = allow_for(&tmp);
        create_folder(&allow, &str_of(tmp.path()), "dup").unwrap();
        let err = create_folder(&allow, &str_of(tmp.path()), "dup").unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[test]
    fn create_folder_rejects_separators() {
        let tmp = TempDir::new("create_sep");
        let allow = allow_for(&tmp);
        assert!(create_folder(&allow, &str_of(tmp.path()), "a/b").is_err());
    }

    #[test]
    fn create_folder_rejects_missing_parent() {
        let tmp = TempDir::new("create_missing");
        let allow = allow_for(&tmp);
        assert!(create_folder(&allow, &str_of(&tmp.child("ghost")), "x").is_err());
    }

    // -- canonicalization / traversal ---------------------------------------

    #[test]
    fn create_folder_resolves_parent_traversal() {
        // `..` inside the dir input must resolve to the canonical parent —
        // the folder lands in the real target, not somewhere the string
        // merely looked like it pointed. `other` is created first so the
        // traversal path canonicalizes through the existing `real` segment to
        // a real, existing parent (the parent must exist; only the new child
        // does not).
        let tmp = TempDir::new("create_traversal");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        fs::create_dir_all(tmp.child("other")).unwrap();
        let tricky = str_of(&tmp.child("real").join("..").join("other"));
        create_folder(&allow, &tricky, "made").unwrap();
        assert!(tmp.child("other").join("made").is_dir());
        assert!(!tmp.child("real").join("other").exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_folder_resolves_symlinked_parent() {
        // A symlinked parent must be followed to its canonical target, so an
        // operation cannot be steered by a link that later changes meaning.
        let tmp = TempDir::new("create_symlink");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        std::os::unix::fs::symlink(tmp.child("real"), tmp.child("link")).unwrap();
        create_folder(&allow, &str_of(&tmp.child("link")), "inside").unwrap();
        assert!(tmp.child("real").join("inside").is_dir());
    }

    // -- AllowList basics ---------------------------------------------------

    #[test]
    fn allow_list_allows_inside_root() {
        let tmp = TempDir::new("al_inside");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub")).unwrap();
        let sub = tmp.child("sub").canonicalize().unwrap();
        assert!(allow.is_allowed(&sub));
        let root_canon = tmp.path().canonicalize().unwrap();
        assert!(allow.is_allowed(&root_canon));
    }

    #[test]
    fn allow_list_rejects_outside_root() {
        let root = TempDir::new("al_inside2");
        let outside = TempDir::new("al_outside");
        let allow = allow_for(&root);
        let out = outside.path().canonicalize().unwrap();
        assert!(!allow.is_allowed(&out));
        assert!(!allow.is_allowed(&out.join("x")));
    }

    #[test]
    fn allow_list_rejects_traversal_escape() {
        let tmp = TempDir::new("al_trav");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        // tmp/real/../.. canonicalizes to the parent of tmp — outside the root.
        let escape = tmp
            .child("real")
            .join("..")
            .join("..")
            .canonicalize()
            .unwrap();
        assert!(!allow.is_allowed(&escape));
    }

    #[cfg(unix)]
    #[test]
    fn allow_list_rejects_symlink_escape() {
        let root = TempDir::new("al_symlink");
        let outside = TempDir::new("al_symlink_out");
        let allow = allow_for(&root);
        fs::create_dir_all(outside.child("secret")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.child("escape")).unwrap();
        let target = root.child("escape").join("secret").canonicalize().unwrap();
        assert!(!allow.is_allowed(&target));
        let link_dir = root.child("escape").canonicalize().unwrap();
        assert!(!allow.is_allowed(&link_dir));
    }

    #[test]
    fn allow_list_multiple_roots() {
        let a = TempDir::new("al_multi_a");
        let b = TempDir::new("al_multi_b");
        let c = TempDir::new("al_multi_c");
        let mut allow = allow_for(&a);
        allow.register_root(&str_of(b.path())).unwrap();
        assert!(allow.is_allowed(&a.path().canonicalize().unwrap()));
        assert!(allow.is_allowed(&b.path().canonicalize().unwrap()));
        assert!(!allow.is_allowed(&c.path().canonicalize().unwrap()));
    }

    #[test]
    fn allow_list_ignores_duplicate_root() {
        let a = TempDir::new("al_dup");
        let mut allow = allow_for(&a);
        allow.register_root(&str_of(a.path())).unwrap();
        assert_eq!(allow.len(), 1);
    }

    #[test]
    fn allow_list_empty_denies_all() {
        let tmp = TempDir::new("al_empty");
        let allow = AllowList::empty();
        assert_eq!(allow.len(), 0);
        assert!(!allow.is_allowed(&tmp.path().canonicalize().unwrap()));
    }

    // -- operation boundary enforcement -------------------------------------

    #[test]
    fn list_directory_denies_outside_root() {
        let tmp = TempDir::new("list_root");
        let allowed = tmp.child("allowed");
        fs::create_dir_all(&allowed).unwrap();
        let outside = tmp.child("outside");
        fs::create_dir_all(&outside).unwrap();
        let allow = AllowList::with_root(&str_of(&allowed)).unwrap();

        // a sibling directory inside the temp dir but outside the allowed root
        let err = list_directory(&allow, Some(str_of(&outside))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());

        // the allowed directory itself works
        let listing = list_directory(&allow, Some(str_of(&allowed))).unwrap();
        assert!(listing.items.is_empty());

        // the default home is not the allowed subdir — still gated
        assert!(list_directory(&allow, None).is_err());
    }

    #[test]
    fn create_folder_respects_boundary() {
        let root = TempDir::new("mk_root");
        let outside = TempDir::new("mk_outside");
        let allow = allow_for(&root);

        // inside → allowed
        create_folder(&allow, &str_of(root.path()), "made").unwrap();
        assert!(root.child("made").is_dir());

        // outside parent → denied
        let err = create_folder(&allow, &str_of(outside.path()), "x").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());

        // nonexistent child inside an allowed parent → allowed (canonical parent)
        fs::create_dir_all(root.child("sub")).unwrap();
        create_folder(&allow, &str_of(&root.child("sub")), "kid").unwrap();
        assert!(root.child("sub").join("kid").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn create_folder_rejects_symlinked_parent_escape() {
        let root = TempDir::new("mk_symlink_escape");
        let outside = TempDir::new("mk_symlink_out");
        let allow = allow_for(&root);
        std::os::unix::fs::symlink(outside.path(), root.child("escape")).unwrap();
        let err = create_folder(&allow, &str_of(&root.child("escape")), "x").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!outside.child("x").exists());
    }

    #[test]
    fn rename_item_denies_outside_root() {
        let root = TempDir::new("rn_root");
        let outside = TempDir::new("rn_outside");
        let allow = allow_for(&root);

        write_file(&root.child("a.txt"), "a");
        rename_item(&allow, &str_of(&root.child("a.txt")), "b.txt").unwrap();
        assert!(root.child("b.txt").is_file());

        write_file(&outside.child("c.txt"), "c");
        let err = rename_item(&allow, &str_of(&outside.child("c.txt")), "d.txt").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("c.txt").is_file());
    }

    #[test]
    fn move_item_requires_both_sides_inside() {
        let root = TempDir::new("mv_root");
        let outside = TempDir::new("mv_outside");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("dest")).unwrap();

        // in → in: allowed
        write_file(&root.child("inside.txt"), "x");
        move_item(
            &allow,
            &str_of(&root.child("inside.txt")),
            &str_of(&root.child("dest")),
        )
        .unwrap();
        assert!(root.child("dest").join("inside.txt").is_file());

        // in → out: denied
        write_file(&root.child("in2.txt"), "x");
        let err = move_item(
            &allow,
            &str_of(&root.child("in2.txt")),
            &str_of(outside.path()),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(root.child("in2.txt").is_file());

        // out → in: denied
        write_file(&outside.child("o3.txt"), "x");
        let err = move_item(
            &allow,
            &str_of(&outside.child("o3.txt")),
            &str_of(&root.child("dest")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("o3.txt").is_file());

        // out → out: denied
        let err = move_item(
            &allow,
            &str_of(&outside.child("o3.txt")),
            &str_of(outside.path()),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("o3.txt").is_file());
    }

    #[test]
    fn delete_item_denies_outside_root() {
        let root = TempDir::new("del_root");
        let outside = TempDir::new("del_outside");
        let allow = allow_for(&root);

        write_file(&root.child("a.txt"), "a");
        delete_item(&allow, &str_of(&root.child("a.txt"))).unwrap();
        assert!(!root.child("a.txt").exists());

        write_file(&outside.child("b.txt"), "b");
        let err = delete_item(&allow, &str_of(&outside.child("b.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("b.txt").is_file());
    }

    #[test]
    fn open_item_denies_outside_root() {
        // Only denial paths are exercised — the allowed path would launch an
        // external application, which unit tests must never do.
        let root = TempDir::new("open_root");
        let outside = TempDir::new("open_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");

        let err = open_item(&allow, &str_of(&outside.child("secret.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[cfg(unix)]
    #[test]
    fn open_item_rejects_symlink_escape() {
        // A symlink whose canonical target resolves outside the root must be
        // rejected BEFORE `open::that` is reached.
        let root = TempDir::new("open_symlink_escape");
        let outside = TempDir::new("open_symlink_out");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");
        std::os::unix::fs::symlink(outside.child("secret.txt"), root.child("leak")).unwrap();
        let err = open_item(&allow, &str_of(&root.child("leak"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn disk_usage_denies_outside_root() {
        let tmp = TempDir::new("du_root");
        let allowed = tmp.child("allowed");
        fs::create_dir_all(&allowed).unwrap();
        let outside = tmp.child("outside");
        fs::create_dir_all(&outside).unwrap();
        let allow = AllowList::with_root(&str_of(&allowed)).unwrap();

        let err = disk_usage(&allow, Some(str_of(&outside))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());

        // allowed path returns real statfs/statvfs data
        disk_usage(&allow, Some(str_of(&allowed))).unwrap();

        // default home is not the allowed subdir — still gated
        assert!(disk_usage(&allow, None).is_err());
    }

    // -- get_file_metadata --------------------------------------------------

    #[test]
    fn get_file_metadata_existing_file() {
        let tmp = TempDir::new("meta_file");
        let allow = allow_for(&tmp);
        let file = tmp.child("notes.txt");
        write_file(&file, "hello world"); // exactly 11 bytes

        let meta = get_file_metadata(&allow, &str_of(&file)).unwrap();
        assert_eq!(meta.name, "notes.txt");
        assert_eq!(
            meta.path,
            file.canonicalize().unwrap().to_string_lossy().to_string()
        );
        assert!(meta.is_file);
        assert!(!meta.is_folder);
        assert_eq!(meta.size_bytes, 11);
        assert_eq!(meta.extension.as_deref(), Some("txt"));
        assert!(!meta.is_hidden);
        assert!(meta.modified_ts > 0);
        assert!(meta.created_ts > 0);
    }

    #[test]
    fn get_file_metadata_existing_directory() {
        let tmp = TempDir::new("meta_dir");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("pics")).unwrap();

        let meta = get_file_metadata(&allow, &str_of(&tmp.child("pics"))).unwrap();
        assert_eq!(meta.name, "pics");
        assert!(meta.is_folder);
        assert!(!meta.is_file);
        assert_eq!(meta.size_bytes, 0);
        assert_eq!(meta.extension, None);
    }

    #[test]
    fn get_file_metadata_no_extension() {
        let tmp = TempDir::new("meta_noext");
        let allow = allow_for(&tmp);
        let file = tmp.child("Makefile");
        write_file(&file, "");

        let meta = get_file_metadata(&allow, &str_of(&file)).unwrap();
        assert_eq!(meta.extension, None);
    }

    #[test]
    fn get_file_metadata_nonexistent() {
        let tmp = TempDir::new("meta_missing");
        let allow = allow_for(&tmp);

        let err = get_file_metadata(&allow, &str_of(&tmp.child("ghost"))).unwrap_err();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
    }

    #[test]
    fn get_file_metadata_outside_root() {
        let root = TempDir::new("meta_root");
        let outside = TempDir::new("meta_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");

        let err = get_file_metadata(&allow, &str_of(&outside.child("secret.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn get_file_metadata_traversal_escape() {
        let tmp = TempDir::new("meta_trav");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        // tmp/real/../.. canonicalizes to the parent of tmp — outside the
        // allowed root. The path EXISTS, so this exercises the security
        // boundary rather than merely producing NotFound.
        let escape = tmp.child("real").join("..").join("..");

        let err = get_file_metadata(&allow, &str_of(&escape)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[cfg(unix)]
    #[test]
    fn get_file_metadata_symlink_escape() {
        let root = TempDir::new("meta_symlink");
        let outside = TempDir::new("meta_symlink_out");
        let allow = allow_for(&root);

        // in-root symlink → outside file: denied, no outside metadata leaks
        write_file(&outside.child("secret.txt"), "s");
        std::os::unix::fs::symlink(outside.child("secret.txt"), root.child("leak")).unwrap();
        let err = get_file_metadata(&allow, &str_of(&root.child("leak"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());

        // in-root symlink → in-root file: allowed, and describes the resolved
        // target (the final symlink is followed, not reported as the link).
        write_file(&root.child("real.txt"), "x");
        std::os::unix::fs::symlink(root.child("real.txt"), root.child("alias")).unwrap();
        let meta = get_file_metadata(&allow, &str_of(&root.child("alias"))).unwrap();
        assert_eq!(meta.name, "real.txt");
        assert!(meta.is_file);
        assert_eq!(
            meta.path,
            root.child("real.txt")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
    }

    #[test]
    fn get_file_metadata_hidden() {
        let tmp = TempDir::new("meta_hidden");
        let allow = allow_for(&tmp);
        write_file(&tmp.child(".env"), "x");
        write_file(&tmp.child("visible.txt"), "x");

        let hidden = get_file_metadata(&allow, &str_of(&tmp.child(".env"))).unwrap();
        assert!(hidden.is_hidden);

        let visible = get_file_metadata(&allow, &str_of(&tmp.child("visible.txt"))).unwrap();
        assert!(!visible.is_hidden);
    }

    #[test]
    fn get_file_metadata_empty_allowlist() {
        let tmp = TempDir::new("meta_empty");
        let allow = AllowList::empty();
        write_file(&tmp.child("a.txt"), "x");

        let err = get_file_metadata(&allow, &str_of(&tmp.child("a.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    // -- copy_item ------------------------------------------------------------

    #[test]
    fn copy_item_copies_file() {
        let tmp = TempDir::new("copy_file");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("notes.txt"), "hello world");
        fs::create_dir_all(tmp.child("dest")).unwrap();

        copy_item(
            &allow,
            &str_of(&tmp.child("notes.txt")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap();

        let copied = tmp.child("dest").join("notes.txt");
        assert!(copied.is_file());
        assert_eq!(fs::read(&copied).unwrap(), b"hello world");
        // original remains unchanged
        assert_eq!(fs::read(tmp.child("notes.txt")).unwrap(), b"hello world");
    }

    #[test]
    fn copy_item_copies_directory_recursively() {
        let tmp = TempDir::new("copy_dir");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("source/nested")).unwrap();
        write_file(&tmp.child("source/file.txt"), "top");
        write_file(&tmp.child("source/nested/nested.txt"), "deep");
        fs::create_dir_all(tmp.child("dest")).unwrap();

        copy_item(
            &allow,
            &str_of(&tmp.child("source")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap();

        let copied = tmp.child("dest").join("source");
        assert!(copied.is_dir());
        assert_eq!(fs::read(copied.join("file.txt")).unwrap(), b"top");
        assert!(copied.join("nested").is_dir());
        assert_eq!(fs::read(copied.join("nested/nested.txt")).unwrap(), b"deep");
        // original remains intact
        assert!(tmp.child("source/file.txt").is_file());
        assert!(tmp.child("source/nested/nested.txt").is_file());
    }

    #[test]
    fn copy_item_rejects_existing_destination() {
        let tmp = TempDir::new("copy_dup");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.txt"), "a");
        fs::create_dir_all(tmp.child("dest")).unwrap();
        write_file(&tmp.child("dest/a.txt"), "existing");

        let err = copy_item(
            &allow,
            &str_of(&tmp.child("a.txt")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap_err();
        assert_eq!(err, "A file or folder with that name already exists.");
        // destination item was not overwritten
        assert_eq!(fs::read(tmp.child("dest/a.txt")).unwrap(), b"existing");
    }

    #[test]
    fn copy_item_rejects_nonexistent_source() {
        let tmp = TempDir::new("copy_missing");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("dest")).unwrap();

        let err = copy_item(
            &allow,
            &str_of(&tmp.child("ghost")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap_err();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
    }

    #[test]
    fn copy_item_rejects_nonexistent_destination() {
        let tmp = TempDir::new("copy_nodest");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.txt"), "a");

        let err = copy_item(
            &allow,
            &str_of(&tmp.child("a.txt")),
            &str_of(&tmp.child("ghost")),
        )
        .unwrap_err();
        assert_eq!(err, "The destination is not a folder");
    }

    #[test]
    fn copy_item_denies_source_outside_root() {
        let root = TempDir::new("copy_root");
        let outside = TempDir::new("copy_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");
        fs::create_dir_all(root.child("dest")).unwrap();

        let err = copy_item(
            &allow,
            &str_of(&outside.child("secret.txt")),
            &str_of(&root.child("dest")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        // nothing was copied
        assert!(!root.child("dest/secret.txt").exists());
    }

    #[test]
    fn copy_item_denies_destination_outside_root() {
        let root = TempDir::new("copy_dest_out");
        let outside = TempDir::new("copy_dest_outside");
        let allow = allow_for(&root);
        write_file(&root.child("a.txt"), "a");

        let err = copy_item(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(outside.path()),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        // nothing was written outside
        assert!(!outside.child("a.txt").exists());
    }

    #[test]
    fn copy_item_rejects_own_subtree() {
        let tmp = TempDir::new("copy_subtree");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("folder/child")).unwrap();

        let err = copy_item(
            &allow,
            &str_of(&tmp.child("folder")),
            &str_of(&tmp.child("folder/child")),
        )
        .unwrap_err();
        assert_eq!(err, "Cannot copy a folder into itself");
    }

    #[cfg(unix)]
    #[test]
    fn copy_item_symlink_source_escape() {
        let root = TempDir::new("copy_symlink_out");
        let outside = TempDir::new("copy_symlink_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");
        std::os::unix::fs::symlink(outside.child("secret.txt"), root.child("leak")).unwrap();
        fs::create_dir_all(root.child("dest")).unwrap();

        let err = copy_item(
            &allow,
            &str_of(&root.child("leak")),
            &str_of(&root.child("dest")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        // no copied outside content inside the destination
        assert!(!root.child("dest/leak").exists());
        assert!(!root.child("dest/secret.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_item_symlink_source_inside() {
        let tmp = TempDir::new("copy_symlink_in");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("real.txt"), "target content");
        std::os::unix::fs::symlink(tmp.child("real.txt"), tmp.child("alias")).unwrap();
        fs::create_dir_all(tmp.child("dest")).unwrap();

        copy_item(
            &allow,
            &str_of(&tmp.child("alias")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap();

        // The copy is named after the resolved target ("real.txt") and its
        // content matches the target.
        let copied = tmp.child("dest").join("real.txt");
        assert!(copied.is_file());
        assert_eq!(fs::read(&copied).unwrap(), b"target content");
    }

    #[cfg(unix)]
    #[test]
    fn copy_item_child_symlink_not_followed() {
        let tmp = TempDir::new("copy_child_link");
        let outside = TempDir::new("copy_child_outside");
        let allow = allow_for(&tmp);

        fs::create_dir_all(tmp.child("source")).unwrap();
        write_file(&tmp.child("source/inside.txt"), "kept");
        write_file(&outside.child("secret.txt"), "outside");
        std::os::unix::fs::symlink(outside.child("secret.txt"), tmp.child("source/link")).unwrap();
        fs::create_dir_all(tmp.child("dest")).unwrap();

        copy_item(
            &allow,
            &str_of(&tmp.child("source")),
            &str_of(&tmp.child("dest")),
        )
        .unwrap();

        let copied_link = tmp.child("dest/source/link");
        // The child link was recreated, not followed: it is still a symlink
        // with its target text preserved, and no outside content was copied.
        let link_meta = fs::symlink_metadata(&copied_link).unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(
            fs::read_link(&copied_link).unwrap(),
            outside.child("secret.txt")
        );
        // the in-root regular file was still copied
        assert_eq!(
            fs::read(tmp.child("dest/source/inside.txt")).unwrap(),
            b"kept"
        );
    }

    #[test]
    fn copy_item_source_is_destination() {
        let tmp = TempDir::new("copy_self");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.txt"), "original");

        // Copying an item into its own directory resolves the destination to
        // the source itself — an existing destination item, which must fail
        // with the contract error rather than silently doing nothing.
        let err = copy_item(&allow, &str_of(&tmp.child("a.txt")), &str_of(tmp.path())).unwrap_err();
        assert_eq!(err, "A file or folder with that name already exists.");

        // No destructive change: the source is intact and no new item exists.
        assert_eq!(fs::read(tmp.child("a.txt")).unwrap(), b"original");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    // -- read_file ------------------------------------------------------------

    #[test]
    fn read_file_reads_text_file() {
        let tmp = TempDir::new("read_text");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("notes.txt"), "hello world");

        let bytes = read_file(&allow, &str_of(&tmp.child("notes.txt"))).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "hello world");
    }

    #[test]
    fn read_file_reads_binary_file() {
        let tmp = TempDir::new("read_binary");
        let allow = allow_for(&tmp);
        // Non-UTF-8 raw bytes, including values that are not valid in UTF-8.
        let payload: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE];
        std::fs::write(tmp.child("image.png"), &payload).unwrap();

        let bytes = read_file(&allow, &str_of(&tmp.child("image.png"))).unwrap();
        assert_eq!(bytes, payload);
    }

    #[test]
    fn read_file_denies_outside_root() {
        let root = TempDir::new("read_root");
        let outside = TempDir::new("read_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");

        let err = read_file(&allow, &str_of(&outside.child("secret.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn read_file_traversal_escape() {
        let tmp = TempDir::new("read_trav");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        // tmp/real/../.. canonicalizes to the parent of tmp — outside the root.
        let escape = tmp.child("real").join("..").join("..");

        let err = read_file(&allow, &str_of(&escape)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn read_file_nonexistent() {
        let tmp = TempDir::new("read_missing");
        let allow = allow_for(&tmp);

        let err = read_file(&allow, &str_of(&tmp.child("ghost"))).unwrap_err();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_file_symlink_inside() {
        let tmp = TempDir::new("read_symlink_in");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("real.txt"), "target content");
        std::os::unix::fs::symlink(tmp.child("real.txt"), tmp.child("alias")).unwrap();

        let bytes = read_file(&allow, &str_of(&tmp.child("alias"))).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), "target content");
    }

    #[cfg(unix)]
    #[test]
    fn read_file_symlink_outside() {
        let root = TempDir::new("read_symlink_out");
        let outside = TempDir::new("read_symlink_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "s");
        std::os::unix::fs::symlink(outside.child("secret.txt"), root.child("leak")).unwrap();

        let err = read_file(&allow, &str_of(&root.child("leak"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn read_file_rejects_directory() {
        let tmp = TempDir::new("read_dir");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub")).unwrap();

        // Reading a directory path is not a security bypass; it must fail
        // gracefully with a mapped filesystem error.
        let err = read_file(&allow, &str_of(&tmp.child("sub"))).unwrap_err();
        assert!(!err.is_empty());
    }

    // -- write_file -----------------------------------------------------------

    #[test]
    fn write_file_creates_new_file() {
        let tmp = TempDir::new("write_new");
        let allow = allow_for(&tmp);
        super::write_file(&allow, &str_of(&tmp.child("note.txt")), b"hello world").unwrap();
        assert_eq!(
            fs::read_to_string(tmp.child("note.txt")).unwrap(),
            "hello world"
        );
    }

    #[test]
    fn write_file_writes_empty_content() {
        let tmp = TempDir::new("write_empty");
        let allow = allow_for(&tmp);
        super::write_file(&allow, &str_of(&tmp.child("empty.txt")), b"").unwrap();
        let meta = fs::metadata(tmp.child("empty.txt")).unwrap();
        assert!(meta.is_file());
        assert_eq!(meta.len(), 0);
    }

    #[test]
    fn write_file_overwrites_existing() {
        let tmp = TempDir::new("write_overwrite");
        let allow = allow_for(&tmp);
        // local fixture helper, then overwrite via the service
        write_file(&tmp.child("a.txt"), "original");
        super::write_file(&allow, &str_of(&tmp.child("a.txt")), b"replaced").unwrap();
        assert_eq!(fs::read_to_string(tmp.child("a.txt")).unwrap(), "replaced");
    }

    #[test]
    fn write_file_denies_outside_root() {
        let root = TempDir::new("write_root");
        let outside = TempDir::new("write_outside");
        let allow = allow_for(&root);
        let err =
            super::write_file(&allow, &str_of(&outside.child("secret.txt")), b"x").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!outside.child("secret.txt").exists());
    }

    #[test]
    fn write_file_parent_nonexistent() {
        let tmp = TempDir::new("write_noparent");
        let allow = allow_for(&tmp);
        let child = tmp.child("ghost").join("a.txt");
        let err = super::write_file(&allow, &str_of(&child), b"x").unwrap_err();
        assert!(err.contains("no longer exists"), "unexpected error: {err}");
    }

    #[test]
    fn write_file_traversal_escape() {
        let tmp = TempDir::new("write_trav");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("real")).unwrap();
        // resolves to the parent of the root once canonicalized -> outside
        let escape = tmp.child("real").join("..").join("..").join("evil.txt");
        let err = super::write_file(&allow, &str_of(&escape), b"x").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    #[test]
    fn write_file_rejects_invalid_name() {
        let tmp = TempDir::new("write_name");
        let allow = allow_for(&tmp);
        // ".", "..", trailing separator, and empty final component are all
        // rejected with a validation error before any filesystem access.
        for bad in [
            ".",
            "..",
            &format!("{}/", str_of(&tmp.child("ok"))),
            &str_of(&tmp.child("ok/.")),
            &str_of(&tmp.child("ok/..")),
        ] {
            let err = super::write_file(&allow, bad, b"x").unwrap_err();
            assert_eq!(err, "Invalid file path", "for input {bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_symlink_final_component_inside() {
        let tmp = TempDir::new("write_sym_in");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("real.txt"), "before"); // local fixture helper
        std::os::unix::fs::symlink(tmp.child("real.txt"), tmp.child("link.txt")).unwrap();
        super::write_file(&allow, &str_of(&tmp.child("link.txt")), b"after").unwrap();
        assert_eq!(fs::read_to_string(tmp.child("real.txt")).unwrap(), "after");
    }

    #[cfg(unix)]
    #[test]
    fn write_file_symlink_final_component_outside() {
        let root = TempDir::new("write_sym_out");
        let outside = TempDir::new("write_sym_outside");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "original"); // local fixture helper
        std::os::unix::fs::symlink(outside.child("secret.txt"), root.child("link.txt")).unwrap();

        let err =
            super::write_file(&allow, &str_of(&root.child("link.txt")), b"hacked").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());

        // the outside file's contents must be untouched
        assert_eq!(
            fs::read_to_string(outside.child("secret.txt")).unwrap(),
            "original"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_file_broken_symlink() {
        let tmp = TempDir::new("write_sym_broken");
        let allow = allow_for(&tmp);
        std::os::unix::fs::symlink(tmp.child("nowhere"), tmp.child("link.txt")).unwrap();

        let err = super::write_file(&allow, &str_of(&tmp.child("link.txt")), b"x").unwrap_err();
        // broken link: canonicalize(target) fails -> mapped fs error, never written
        assert!(!err.is_empty());
        assert!(!tmp.child("nowhere").exists());
    }

    #[test]
    fn write_file_empty_allowlist() {
        let tmp = TempDir::new("write_empty_al");
        let allow = AllowList::empty();
        let err = super::write_file(&allow, &str_of(&tmp.child("a.txt")), b"x").unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    // -- search_files -------------------------------------------------------

    #[test]
    fn search_empty_query_returns_empty() {
        let tmp = TempDir::new("search_empty");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("anything.txt"), "data");

        let results = super::search_files(&allow, "").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_whitespace_only_query_returns_empty() {
        let tmp = TempDir::new("search_whitespace");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("anything.txt"), "data");

        let results = super::search_files(&allow, "   \t  ").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_case_insensitive_filename() {
        let tmp = TempDir::new("search_case");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("README.TXT"), "hello");
        write_file(&tmp.child("notes.txt"), "world");

        let results = super::search_files(&allow, "readme").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "README.TXT");
    }

    #[test]
    fn search_substring_match() {
        let tmp = TempDir::new("search_substring");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("annual_report.pdf"), "data");
        write_file(&tmp.child("my-report.txt"), "data");
        write_file(&tmp.child("budget.xlsx"), "data");

        let results = super::search_files(&allow, "report").unwrap();
        assert_eq!(results.len(), 2);
        let names: Vec<&str> = results.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"annual_report.pdf"));
        assert!(names.contains(&"my-report.txt"));
    }

    #[test]
    fn search_matches_files() {
        let tmp = TempDir::new("search_files");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("target.txt"), "data");

        let results = super::search_files(&allow, "target").unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].is_folder);
    }

    #[test]
    fn search_matches_directories() {
        let tmp = TempDir::new("search_dirs");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("projects")).unwrap();
        write_file(&tmp.child("projects").join("file.txt"), "data");

        let results = super::search_files(&allow, "projects").unwrap();
        assert!(results.iter().any(|e| e.is_folder && e.name == "projects"));
    }

    #[test]
    fn search_recursive_nested() {
        let tmp = TempDir::new("search_nested");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("deep").join("nested").join("path")).unwrap();
        write_file(
            &tmp.child("deep")
                .join("nested")
                .join("path")
                .join("found.txt"),
            "data",
        );

        let results = super::search_files(&allow, "found").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "found.txt");
    }

    #[test]
    fn search_multiple_roots() {
        let tmp1 = TempDir::new("search_multi_r1");
        let tmp2 = TempDir::new("search_multi_r2");
        let mut allow = AllowList::with_root(&str_of(tmp1.path())).unwrap();
        allow.register_root(&str_of(tmp2.path())).unwrap();

        write_file(&tmp1.child("alpha.txt"), "data");
        write_file(&tmp2.child("beta.txt"), "data");

        let results = super::search_files(&allow, "alpha").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "alpha.txt");

        let results = super::search_files(&allow, "beta").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "beta.txt");
    }

    #[test]
    fn search_results_remain_inside_allowed_roots() {
        let tmp = TempDir::new("search_inside");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub")).unwrap();
        write_file(&tmp.child("sub").join("match.txt"), "data");

        let results = super::search_files(&allow, "match").unwrap();
        assert!(!results.is_empty());
        // Use the canonical AllowList root with component-aware Path comparison
        // (not string-prefix matching) to verify containment.
        let root = &allow.roots()[0];
        for entry in &results {
            let entry_path = Path::new(&entry.path);
            assert!(entry_path.starts_with(root));
        }
    }

    #[test]
    fn search_outside_paths_never_returned() {
        let root = TempDir::new("search_outside_r");
        let outside = TempDir::new("search_outside_o");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "data");

        let results = super::search_files(&allow, "secret").unwrap();
        assert!(results.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn search_symlink_outside_not_followed() {
        let root = TempDir::new("search_sym_out_r");
        let outside = TempDir::new("search_sym_out_o");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.txt"), "data");

        // Create a symlink inside the allowed root pointing to a file outside.
        std::os::unix::fs::symlink(&outside.child("secret.txt"), &root.child("link.txt")).unwrap();

        let results = super::search_files(&allow, "secret").unwrap();
        // The symlink itself is skipped; the target outside is never reached.
        assert!(results.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn search_symlink_cycle_does_not_loop_forever() {
        let tmp = TempDir::new("search_cycle");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("cycle")).unwrap();

        // Create a symlink cycle: cycle/loop -> cycle (itself).
        std::os::unix::fs::symlink(tmp.child("cycle"), tmp.child("cycle").join("loop")).unwrap();

        // Should complete without hanging.
        let results = super::search_files(&allow, "anything").unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_deterministic_ordering() {
        let tmp = TempDir::new("search_order");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("zebra.txt"), "data");
        write_file(&tmp.child("apple.txt"), "data");
        write_file(&tmp.child("mango.txt"), "data");

        let results = super::search_files(&allow, "").unwrap();
        assert!(results.is_empty());

        let results = super::search_files(&allow, "txt").unwrap();
        assert_eq!(results.len(), 3);
        // Results must be sorted by path.
        for i in 1..results.len() {
            assert!(results[i - 1].path <= results[i].path);
        }
    }

    #[test]
    fn search_empty_allowlist_returns_no_results() {
        let tmp = TempDir::new("search_empty_al");
        let allow = AllowList::empty();
        write_file(&tmp.child("hidden.txt"), "data");

        let results = super::search_files(&allow, "hidden").unwrap();
        assert!(results.is_empty());
    }
}
