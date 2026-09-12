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

use serde::{Deserialize, Serialize};
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
    // Case-only renames (e.g. "Report.pdf" -> "report.pdf") are valid on the
    // default macOS case-insensitive filesystem, where the destination always
    // "exists" as the same entry. Allow them without weakening the conflict
    // check for genuinely different names; allow-list and parent binding are
    // already enforced above.
    let case_only = source
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        == Some(name.to_lowercase());
    if destination.exists() && !case_only {
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

/// Move a FILE to an exact destination path. The destination may carry a new
/// name (move + rename) or the same name, but it is always a full path: the
/// destination folder must already exist and the leaf name is validated and
/// applied by this function. Folders are rejected — only files are moved.
///
/// The source must be an existing file, so the destination can never silently
/// become an empty placeholder, and the destination folder's canonical path is
/// checked against the allow list so a move can never escape permitted roots.
pub fn move_file(allow_list: &AllowList, source: &str, destination: &str) -> Result<(), String> {
    let source: PathBuf = PathBuf::from(source);
    if !source.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let metadata =
        fs::metadata(&source).map_err(|e| format!("Unable to move: {}", map_io_error(&e)))?;
    if metadata.is_dir() {
        return Err("The source is not a file".to_string());
    }
    let source = resolve_in_canonical_parent(&source, "Unable to move: ")?;
    ensure_allowed(allow_list, &source)?;

    let destination_path = Path::new(destination);
    let name = destination_path
        .file_name()
        .ok_or_else(|| "Invalid destination path".to_string())?
        .to_string_lossy()
        .into_owned();
    let name = validate_item_name(&name)?;
    let parent = destination_path
        .parent()
        .ok_or_else(|| "Invalid destination path".to_string())?;
    if !parent.exists() {
        return Err("The destination folder does not exist.".to_string());
    }
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("Unable to move: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &parent)?;

    let destination = parent.join(&name);
    if destination == source {
        return Ok(());
    }
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
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

/// Create an empty regular file at `path` within the AllowList boundary.
///
/// # Security order
///
/// 1. validate the final component (no `.`, `..`, path separators, empty),
/// 2. canonicalize the parent directory (resolves `..` and symlinked ancestors),
/// 3. `ensure_allowed` on the canonical parent,
/// 4. reject if the target already exists (never overwrite),
/// 5. create the file, return the canonical path.
pub fn create_file(allow_list: &AllowList, path: &str) -> Result<String, String> {
    let target = Path::new(path);
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid file path".to_string())?;
    let name = validate_item_name(name)?;

    let parent = target
        .parent()
        .ok_or_else(|| "Invalid file path".to_string())?;
    let canonical_parent = canonical_dir(parent.to_str().unwrap_or(""))?;
    ensure_allowed(allow_list, &canonical_parent)?;

    let destination = canonical_parent.join(&name);
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }

    fs::write(&destination, &[])
        .map_err(|e| format!("Unable to create file: {}", map_io_error(&e)))?;

    let canonical = destination
        .canonicalize()
        .map_err(|e| format!("Unable to create file: {}", map_io_error(&e)))?;
    Ok(canonical.to_string_lossy().to_string())
}

/// Recurse into `dir`, collecting entries whose name contains `query_lower`.
/// Only the already-authorized subtree rooted at the AllowList root is visited.
///
/// Symlinks are never followed (detected via `entry.metadata()` which, like
/// [`list_directory`], does not resolve the final link). Cycle detection uses
/// canonical inode identity on Unix to defend against hardlink-based directory
/// loops and bind mounts. Per-branch errors (permission denied, I/O error)
/// are tolerated and do not abort the traversal.
///
/// The shared safe walker used by [`search_files`], [`recent_files`], and
/// [`storage_by_category`]: `visit` is invoked for every entry (files AND
/// directories) inside `dir`, before recursing into subdirectories.
///
/// Returns `false` when `visit` requested an early stop (e.g. a scan safety
/// cap was reached) so callers can abort the whole traversal promptly;
/// `true` means the walk completed.
fn walk_recursive<F>(
    dir: &Path,
    visited: &mut std::collections::HashSet<(u64, u64)>,
    visit: &mut F,
) -> bool
where
    F: FnMut(&Path, &fs::Metadata) -> bool,
{
    // Default: skip nothing. The duplicate scan uses the skippable variant to
    // exclude the app trash subtree without changing how every other scan
    // traverses the tree.
    walk_recursive_skipping(dir, visited, visit, &mut |_| false)
}

/// [`walk_recursive`] with a per-directory skip predicate.
///
/// The predicate is consulted before recursing into a directory; when it
/// returns `true` the subtree is NOT entered (the directory itself is still
/// visited, so a skipped root is never itself a candidate). All other
/// semantics are identical to [`walk_recursive`]: symlinks are never followed,
/// Unix inode cycle detection guards hardlink/bind-mount loops, per-branch
/// errors are tolerated, and an early stop from the visitor propagates.
fn walk_recursive_skipping<F, S>(
    dir: &Path,
    visited: &mut std::collections::HashSet<(u64, u64)>,
    visit: &mut F,
    skip_dir: &mut S,
) -> bool
where
    F: FnMut(&Path, &fs::Metadata) -> bool,
    S: FnMut(&Path) -> bool,
{
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return true, // unreadable directory — skip silently
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

        if !visit(&entry_path, &meta) {
            return false; // visitor asked to stop the traversal early
        }

        // Recurse into subdirectories (unless the skip predicate blocks the
        // whole subtree), propagating an early stop upward.
        if meta.is_dir()
            && !skip_dir(&entry_path)
            && !walk_recursive_skipping(&entry_path, visited, visit, &mut *skip_dir)
        {
            return false;
        }
    }

    true
}

/// Result of a bounded recursive filename search. Carries the matched entries
/// plus an honest `truncated` flag so the UI can say when a safety budget was
/// reached before the whole tree was scanned.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResult {
    /// Matching files and directories, sorted by path. At most
    /// [`SEARCH_MAX_RESULTS`] entries.
    pub entries: Vec<FileEntry>,
    /// True when the traversal or result budget was reached before the
    /// entire tree was scanned, so `entries` is a potentially partial view
    /// of the filesystem.
    pub truncated: bool,
}

/// Safety cap for a recursive filename search: the walk stops after this many
/// visited entries (files AND directories) across all allowed roots, so a broad
/// query cannot traverse an unbounded tree.
pub const SEARCH_MAX_VISITED_ENTRIES: usize = 100_000;

/// Safety cap for a recursive filename search: at most this many matching
/// entries are returned, so a broad query cannot yield an unbounded result
/// list. When hit, [`SearchFilesResult::truncated`] is set.
pub const SEARCH_MAX_RESULTS: usize = 500;

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
/// # Budgets
///
/// The search is bounded so it cannot run unbounded on a large filesystem:
/// - **Result budget** (`max_results`): at most this many entries are
///   collected; more matches are discarded and the result is marked truncated.
/// - **Traversal budget** (`max_visited_entries`): the walk stops after
///   visiting this many entries (files and directories) across all roots, so a
///   broad query cannot scan an arbitrarily deep tree.
///
/// When either budget is reached, the corresponding root's walk is aborted
/// and no further roots are visited. The returned entries are sorted
/// regardless so the prefix is deterministic.
///
/// # Matching
///
/// Filenames are matched using a case-insensitive substring search. Both files
/// and directories are returned when their name contains the query.
pub fn search_files(
    allow_list: &AllowList,
    query: &str,
    max_visited_entries: usize,
    max_results: usize,
) -> Result<SearchFilesResult, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchFilesResult {
            entries: Vec::new(),
            truncated: false,
        });
    }

    let query_lower = trimmed.to_lowercase();
    let mut results: Vec<FileEntry> = Vec::new();
    let mut truncated = false;
    let mut visited_entries: usize = 0;

    'roots: for root in allow_list.roots() {
        ensure_allowed(allow_list, root)?;
        let mut visited = std::collections::HashSet::new();

        let mut visit = |entry_path: &Path, meta: &fs::Metadata| -> bool {
            // Check both budgets before visiting this entry. If either is
            // already at its limit, flag the result as truncated and abort
            // the walk — we cannot guarantee a complete result set.
            if visited_entries >= max_visited_entries || results.len() >= max_results {
                truncated = true;
                return false;
            }
            visited_entries += 1;

            // Case-insensitive substring match on the entry's final component.
            if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                if name.to_lowercase().contains(&query_lower) {
                    results.push(build_file_entry(entry_path, meta));
                }
            }
            true
        };

        if !walk_recursive(root, &mut visited, &mut visit) {
            break 'roots; // a budget was reached — do not scan further roots
        }
    }

    // Deterministic ordering: sort by canonical path (even when truncated, so
    // the returned prefix is stable).
    results.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(SearchFilesResult {
        entries: results,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Recent files
// ---------------------------------------------------------------------------

/// Default result cap for [`recent_files`]. The operation is bounded: at most
/// this many entries are returned, never the whole tree.
pub const RECENT_FILES_DEFAULT_LIMIT: usize = 20;

/// Collect the most recently modified files and directories across every
/// allowed root, newest first, hard-capped at `limit` entries.
///
/// This is a true "recent items" listing built from real modification times —
/// nothing is invented. Both regular files and directories are returned so the
/// UI can show folders alongside files.
///
/// # Security / traversal contract (mirrors [`search_files`])
///
/// - Only canonicalized [`AllowList`] roots are traversed, and each root is
///   gated through [`ensure_allowed`]; traversal never leaves an allowed root.
/// - Symbolic links are never followed (via the shared [`walk_recursive`]).
/// - Unix inode cycle detection prevents infinite loops from hardlink-based
///   directory cycles or bind mounts.
/// - Per-branch errors are tolerated: an unreadable subdirectory is skipped
///   without aborting the scan.
/// - The result list is sorted descending by raw modification timestamp and
///   truncated to an explicit hard cap (`limit`). A `limit` of 0 returns an
///   empty list without scanning.
pub fn recent_files(allow_list: &AllowList, limit: usize) -> Result<Vec<FileEntry>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut results: Vec<FileEntry> = Vec::new();

    for root in allow_list.roots() {
        ensure_allowed(allow_list, root)?;
        let mut visited = std::collections::HashSet::new();
        walk_recursive(root, &mut visited, &mut |path, meta| {
            results.push(build_file_entry(path, meta));
            true // recent files always walks the full tree
        });
    }

    // Newest first by raw modification timestamp; deterministic path tie-break
    // so equal-timestamp entries still order stably.
    results.sort_by(|a, b| {
        b.modified_ts
            .cmp(&a.modified_ts)
            .then_with(|| a.path.cmp(&b.path))
    });

    results.truncate(limit);

    Ok(results)
}

// ---------------------------------------------------------------------------
// Storage by category
// ---------------------------------------------------------------------------

/// Real aggregated byte total for a single storage category.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub category: String,
    pub bytes: u64,
}

/// Real file sizes aggregated by extension-derived category, produced by a
/// single bounded walk of the allowed roots. Only genuinely scanned files are
/// counted — nothing is invented or extrapolated.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    /// Every category in canonical order (Documents, Images, Videos, Audio,
    /// Archives, Code, Other), each with its real aggregated bytes (possibly 0).
    pub categories: Vec<StorageCategory>,
    /// Sum of all category bytes — the total size of scanned/classified files.
    pub total_bytes: u64,
    /// Number of regular files scanned and classified into a category.
    pub scanned_file_count: u64,
    /// True when the scan hit [`STORAGE_SCAN_MAX_FILES`] before finishing the
    /// tree. Totals then describe the scanned prefix honestly, never the whole
    /// tree, and the UI can say so.
    pub scan_capped: bool,
}

/// Safety cap for a filesystem-wide storage scan: classification stops after
/// this many regular files, so the scan cannot run unbounded on huge volumes.
pub const STORAGE_SCAN_MAX_FILES: u64 = 200_000;

/// Canonical category list and display order (Documents, Images, Videos,
/// Audio, Archives, Code, Other). Every category is always returned, so the UI
/// gets a stable shape with real (possibly 0 B) totals.
const STORAGE_CATEGORY_NAMES: [&str; 7] = [
    "Documents",
    "Images",
    "Videos",
    "Audio",
    "Archives",
    "Code",
    "Other",
];

/// Classify a lowercased file extension into its storage category. Unknown or
/// unclassified extensions (and extension-less files) fall through to Other.
fn storage_category_for_extension(ext: &str) -> &'static str {
    match ext {
        "txt" | "rtf" | "doc" | "docx" | "odt" | "pdf" | "xls" | "xlsx" | "csv" | "ods"
        | "ppt" | "pptx" | "odp" | "pages" | "numbers" | "keynote" | "md" | "tex" | "epub"
        | "mobi" | "log" => "Documents",

        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "tif" | "webp" | "svg" | "ico"
        | "heic" | "heif" | "raw" | "psd" | "ai" | "eps" => "Images",

        "mp4" | "mov" | "mkv" | "avi" | "webm" | "flv" | "wmv" | "m4v" | "m2ts"
        | "3gp" | "mpg" | "mpeg" => "Videos",

        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "aiff" | "mid"
        | "midi" | "amr" => "Audio",

        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "iso" | "dmg"
        | "cab" | "jar" | "tgz" => "Archives",

        // Note: the plain "ts" extension is unambiguous TypeScript here
        // (MPEG transport streams use ".m2ts"/".ts" but clash, so "ts"
        // classifies as Code; ".m2ts" remains a video).
        "js" | "ts" | "tsx" | "jsx" | "py" | "rb" | "go" | "rs" | "java" | "c" | "h"
        | "cpp" | "hpp" | "cs" | "php" | "swift" | "kt" | "sh" | "bash" | "zsh" | "fish"
        | "sql" | "html" | "css" | "scss" | "json" | "xml" | "yaml" | "yml" | "toml"
        | "ini" | "cfg" => "Code",

        _ => "Other",
    }
}

/// Scan every allowed root with the shared safe walker and aggregate REAL file
/// sizes by extension-derived category.
///
/// # Security / traversal contract (mirrors [`search_files`])
///
/// - Only canonicalized [`AllowList`] roots are traversed, gated through
///   [`ensure_allowed`]; traversal never leaves an allowed root.
/// - Symbolic links are never followed (via the shared [`walk_recursive`]).
/// - Unix inode cycle detection prevents infinite loops from hardlink-based
///   directory cycles or bind mounts.
/// - Per-branch errors are tolerated: unreadable subdirectories are skipped.
/// - Directories carry no size and are never counted; only regular files are
///   classified into the seven categories.
/// - The scan is hard-capped at `max_files` regular files. When the cap is hit
///   the walk stops early (all roots) and `scan_capped` is set so the caller
///   can present the result as the scanned prefix — never fabricated totals.
///
/// An empty AllowList yields a zeroed breakdown without touching the filesystem.
pub fn storage_by_category(
    allow_list: &AllowList,
    max_files: u64,
) -> Result<StorageBreakdown, String> {
    let mut categories: Vec<StorageCategory> = STORAGE_CATEGORY_NAMES
        .iter()
        .map(|name| StorageCategory {
            category: name.to_string(),
            bytes: 0,
        })
        .collect();

    let mut scanned_file_count: u64 = 0;
    let mut scan_capped = false;

    'roots: for root in allow_list.roots() {
        ensure_allowed(allow_list, root)?;
        let mut visited = std::collections::HashSet::new();

        let mut visit = |path: &Path, meta: &fs::Metadata| -> bool {
            // Only regular files carry size for category totals.
            if !meta.is_file() {
                return true;
            }

            // The cap bounds how many files get classified. As soon as the cap
            // is met, stop the whole scan (all roots) at the next regular file.
            if scanned_file_count >= max_files {
                scan_capped = true;
                return false;
            }

            scanned_file_count += 1;

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            let category_name = storage_category_for_extension(&ext);
            if let Some(entry) = categories.iter_mut().find(|c| c.category == category_name) {
                entry.bytes += meta.len();
            }
            true
        };

        if !walk_recursive(root, &mut visited, &mut visit) {
            break 'roots; // safety cap reached — do not scan further roots
        }
    }

    let total_bytes = categories.iter().map(|c| c.bytes).sum();

    Ok(StorageBreakdown {
        categories,
        total_bytes,
        scanned_file_count,
        scan_capped,
    })
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

/// Maximum number of " (copy n)" collision candidates to try before returning
/// an error instead of failing to find a free name. This is the same safety
/// ceiling the duplicate operation has always used, kept explicit so the
/// candidate search stays bounded.
pub const DUPLICATE_NAME_MAX_COLLISIONS: u32 = 1_000_000;

/// Compute a collision-safe duplicate name inside `parent` for `name`.
///
/// Produces `name (copy).ext`, then `name (copy 2).ext`, `name (copy 3).ext`, …
/// Never overwrites an existing item. Component-aware Path comparison.
///
/// Returns an error (never panics) once `max_collisions` candidate names have
/// all been taken, so an unduplicable item fails cleanly instead of crashing
/// the process.
fn unique_duplicate_name(
    parent: &Path,
    name: &str,
    max_collisions: u32,
) -> Result<PathBuf, String> {
    let dot_pos = name.rfind('.');
    let (stem, ext) = match dot_pos {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };

    let first = parent.join(format!("{} (copy){}", stem, ext));
    if !first.exists() {
        return Ok(first);
    }

    let mut n = 2u32;
    loop {
        let candidate = parent.join(format!("{} (copy {}){}", stem, n, ext));
        if !candidate.exists() {
            return Ok(candidate);
        }
        n += 1;
        if n > max_collisions {
            return Err("Unable to allocate a unique duplicate name".to_string());
        }
    }
}

/// Duplicate a file or folder into the same parent directory with a
/// collision-safe name: `name (copy).ext`, then `name (copy 2).ext`, etc.
///
/// # Security order
///
/// 1. canonicalize the source,
/// 2. `ensure_allowed` on the canonical source,
/// 3. compute a collision-safe destination in the same parent,
/// 4. copy (files via `fs::copy`, directories recursively),
/// 5. return the canonical new path.
pub fn duplicate_item(allow_list: &AllowList, source: &str) -> Result<String, String> {
    let target = Path::new(source);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to duplicate: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;

    let parent = canonical
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Unable to duplicate: the source has no parent".to_string())?;
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid source item".to_string())?;

    let destination = unique_duplicate_name(parent, &name, DUPLICATE_NAME_MAX_COLLISIONS)?;

    let meta = fs::metadata(&canonical)
        .map_err(|e| format!("Unable to duplicate: {}", map_io_error(&e)))?;

    if meta.is_dir() {
        let dest_name = destination.file_name().unwrap().to_string_lossy();
        copy_dir_recursive(&canonical, parent, &dest_name)?;
    } else {
        fs::copy(&canonical, &destination)
            .map_err(|e| format!("Unable to duplicate: {}", map_io_error(&e)))?;
    }

    Ok(destination.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Trash and restore
// ---------------------------------------------------------------------------

/// The directory name of the application-managed trash inside the user's home.
pub const TRASH_DIR_NAME: &str = ".trash-smart-file-manager";

/// The configured location of the application's trash directory.
///
/// This is configuration/location state ONLY — it is NOT an authorization
/// mechanism. [`AllowList`] remains the sole filesystem authorization boundary.
pub struct TrashRoot {
    root: PathBuf,
}

impl TrashRoot {
    /// Read-only access to the configured trash root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// An empty-root tombstone used when the trash cannot be configured.
    /// Every trash/restore operation on it is denied (fail closed).
    pub fn empty() -> Self {
        TrashRoot {
            root: PathBuf::from(""),
        }
    }
}

/// Sidecar metadata recording a trashed item's original location.
///
/// Serialized as a small JSON object into a file placed next to the trashed
/// entry. `original_path` is the canonical path the item was moved from.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSidecar {
    original_path: String,
}

/// Compute the canonical application trash root under the user's home directory
/// and create it if it does not exist yet.
///
/// Returns `None` when the home directory cannot be determined or the trash
/// directory cannot be created/canonicalized — the caller must manage a
/// fail-closed placeholder so every trash operation is denied.
pub fn make_canonical_trash_root() -> Option<TrashRoot> {
    let home = dirs::home_dir();
    match home {
        None => None,
        Some(home_path) => {
            let canonical_home = home_path.canonicalize().ok();
            match canonical_home {
                None => None,
                Some(canonical_home) => {
                    let trash_path: PathBuf = canonical_home.join(TRASH_DIR_NAME);
                    let _ = fs::create_dir_all(&trash_path);
                    match trash_path.canonicalize() {
                        Ok(canonical_trash) => Some(TrashRoot {
                            root: canonical_trash,
                        }),
                        Err(_) => None,
                    }
                }
            }
        }
    }
}

/// Compute the sidecar file path sitting next to a trashed item.
fn sidecar_path_for(item: &Path) -> PathBuf {
    let name = item
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "item".to_string());
    item.with_file_name(format!("{}.trash.json", name))
}

/// Write the sidecar metadata for a trashed item.
fn write_sidecar(sidecar: &Path, original_path: &Path) -> Result<(), String> {
    let meta = TrashSidecar {
        original_path: original_path.to_string_lossy().to_string(),
    };
    let json = serde_json::to_string(&meta)
        .map_err(|_| "Unable to trash: failed to serialize metadata".to_string())?;
    fs::write(sidecar, json.as_bytes())
        .map_err(|e| format!("Unable to trash: {}", map_io_error(&e)))
}

/// Read and validate the sidecar metadata for a trashed item.
fn read_sidecar(sidecar: &Path) -> Result<TrashSidecar, String> {
    let bytes =
        fs::read(sidecar).map_err(|e| format!("Unable to restore: {}", map_io_error(&e)))?;
    let text = String::from_utf8(bytes).map_err(|_| "Trash metadata is corrupt".to_string())?;
    serde_json::from_str::<TrashSidecar>(text.as_str())
        .map_err(|_| "Trash metadata is corrupt".to_string())
}

/// Allocate a collision-safe destination name inside `trash_root` for `name`.
///
/// If the bare name is already taken (by an existing trash entry or sidecar),
/// append " (1)", " (2)", ... until a free slot is found. Never overwrites.
fn unique_trash_destination(trash_root: &Path, name: &str) -> Result<PathBuf, String> {
    let first: PathBuf = trash_root.join(name);
    if !first.exists() {
        let sidecar = sidecar_path_for(&first);
        if !sidecar.exists() {
            return Ok(first);
        }
    }
    for i in 1..100_000 {
        let alt_name = format!("{} ({})", name, i);
        let candidate: PathBuf = trash_root.join(&alt_name);
        if !candidate.exists() {
            let sidecar = sidecar_path_for(&candidate);
            if !sidecar.exists() {
                return Ok(candidate);
            }
        }
    }
    Err("Unable to allocate a unique trash name".to_string())
}

/// Move an authorized file or folder into the configured trash root.
///
/// # Security order
///
/// 1. canonicalize the source (resolves `..` and symlinked ancestors/leaf),
/// 2. `ensure_allowed` on the canonical source (AllowList is the boundary),
/// 3. reject the trash root itself,
/// 4. reject any source that CONTAINS the trash root (component-aware),
/// 5. collision-safe destination inside the trash,
/// 6. move, then write the sidecar (rolling the move back if it fails).
pub fn trash_item(trash: &TrashRoot, allow_list: &AllowList, path: &str) -> Result<(), String> {
    if trash.root().as_os_str().is_empty() {
        return Err("Trash is not configured".to_string());
    }
    let target = Path::new(path);
    if !target.exists() {
        return Err("The file or folder no longer exists.".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to trash: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;

    let trash_root = trash.root();

    // Never trash the trash directory itself.
    if canonical == trash_root {
        return Err("Cannot trash the trash directory".to_string());
    }
    // Never trash a source that contains the trash directory (e.g. the user's
    // home). Component-aware Path comparison — NOT string prefix matching.
    if trash_root.starts_with(&canonical) {
        return Err("Cannot trash a folder that contains the trash".to_string());
    }

    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid source item".to_string())?;
    let destination = unique_trash_destination(trash_root, &name)?;

    match fs::rename(&canonical, &destination) {
        Ok(_) => (),
        Err(e) => return Err(format!("Unable to trash: {}", map_io_error(&e))),
    }

    // Write the sidecar. If it fails, roll the move back so no item is left
    // in an unexplained half-trashed state.
    let sidecar = sidecar_path_for(&destination);
    match write_sidecar(&sidecar, &canonical) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::rename(&destination, &canonical);
            Err(e)
        }
    }
}

/// Restore a genuine trash entry to its recorded original location.
///
/// # Security order
///
/// 1. canonicalize the trashed path,
/// 2. `ensure_allowed` (AllowList is the boundary),
/// 3. PRIMARY CHECK: the canonical path must be inside the configured trash
///    root (component-aware) — otherwise `Err("Not a trash entry")`,
/// 4. only then read and validate the sidecar metadata,
/// 5. canonicalize the original destination parent and `ensure_allowed` it,
/// 6. the destination must not already exist,
/// 7. rename back, remove the sidecar, return the restored canonical path.
pub fn restore_item(
    trash: &TrashRoot,
    allow_list: &AllowList,
    trashed_path: &str,
) -> Result<String, String> {
    if trash.root().as_os_str().is_empty() {
        return Err("Trash is not configured".to_string());
    }
    let target = Path::new(trashed_path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to restore: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;

    let trash_root = trash.root();
    // PRIMARY CHECK: is this actually a trash entry? An arbitrary allowed
    // path must never masquerade as a restore target.
    let inside = canonical != trash_root && canonical.starts_with(trash_root);
    if !inside {
        return Err("Not a trash entry".to_string());
    }

    // Only after containment is established do we touch sidecar metadata.
    let sidecar = sidecar_path_for(&canonical);
    let meta = read_sidecar(&sidecar)?;

    // Resolve and authorize the recorded original destination.
    let original = Path::new(&meta.original_path);
    let original_name = original
        .file_name()
        .ok_or_else(|| "Trash metadata is corrupt".to_string())?;
    let original_parent = original
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Trash metadata is corrupt".to_string())?
        .canonicalize()
        .map_err(|e| format!("Unable to restore: {}", map_io_error(&e)))?;
    if !original_parent.is_dir() {
        return Err("Unable to restore: the original folder is missing".to_string());
    }
    ensure_allowed(allow_list, &original_parent)?;

    let destination = original_parent.join(original_name);
    if destination.exists() {
        return Err("A file or folder with that name already exists.".to_string());
    }

    match fs::rename(&canonical, &destination) {
        Ok(()) => (),
        Err(e) => return Err(format!("Unable to restore: {}", map_io_error(&e))),
    }

    // Clean up the sidecar. If cleanup fails, the item is already restored —
    // report the failure clearly instead of pretending full success.
    if let Err(e) = fs::remove_file(&sidecar) {
        return Err(format!(
            "The item was restored but its metadata could not be removed: {}",
            map_io_error(&e)
        ));
    }

    Ok(destination.to_string_lossy().to_string())
}

/// A single item currently in the application-managed trash.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Identifier of the entry (its current path inside the trash).
    pub id: String,
    pub name: String,
    /// The item's location inside the trash (the key used for restore).
    pub path: String,
    pub is_folder: bool,
    pub size_bytes: u64,
    /// Lowercased file extension ("pdf", "docx", ...) or "folder".
    pub file_type: String,
    /// Human readable size ("2.4 MB"; folders render as "—").
    pub size: String,
    pub created: String,
    pub modified: String,
    /// Raw modification time (epoch seconds) so the UI can sort numerically.
    pub modified_ts: i64,
    pub created_ts: i64,
    /// The item's recorded original location. `None` when the sidecar is
    /// missing or corrupt — the item is still listed (honestly) without a
    /// full record; it simply cannot be restored to a known original.
    pub original_path: Option<String>,
}

/// List the current contents of the application-managed trash directory.
///
/// # Security order
///
/// 1. the trash root must be configured (fail closed otherwise),
/// 2. canonicalize + `ensure_allowed` the trash root itself (an empty
///    allowlist denies everything),
/// 3. read the trash directory entry-by-entry, skipping sidecar metadata,
/// 4. attach each entry's recorded original path from its sidecar (optional).
pub fn list_trash(
    trash: &TrashRoot,
    allow_list: &AllowList,
) -> Result<Vec<TrashEntry>, String> {
    if trash.root().as_os_str().is_empty() {
        return Err("Trash is not configured".to_string());
    }
    let canonical_root = trash
        .root()
        .canonicalize()
        .map_err(|e| format!("Unable to list trash: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical_root)?;

    let mut entries = Vec::new();
    let reader = fs::read_dir(&canonical_root)
        .map_err(|e| format!("Unable to list trash: {}", map_io_error(&e)))?;
    for dir_entry in reader {
        let entry = dir_entry.map_err(|e| format!("Unable to list trash: {}", map_io_error(&e)))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Sidecar metadata files are not trash items.
        if name.ends_with(".trash.json") {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("Unable to list trash: {}", map_io_error(&e)))?;
        let file = build_file_entry(&path, &meta);
        let sidecar = sidecar_path_for(&path);
        let original_path = read_sidecar(&sidecar).ok().map(|m| m.original_path);

        entries.push(TrashEntry {
            id: file.id,
            name: file.name,
            path: file.path,
            is_folder: file.is_folder,
            size_bytes: file.size_bytes,
            file_type: file.file_type,
            size: file.size,
            created: file.created,
            modified: file.modified,
            modified_ts: file.modified_ts,
            created_ts: file.created_ts,
            original_path,
        });
    }

    // Stable order: most recently modified first.
    entries.sort_by(|a, b| b.modified_ts.cmp(&a.modified_ts));
    Ok(entries)
}

/// Permanently delete a genuine trash entry — the item AND its paired sidecar
/// metadata — never anything else. This is the ONLY operation that removes a
/// trashed item for good; `delete_item` is deliberately NOT reused here so the
/// trash-root containment below is always enforced.
///
/// # Security order
///
/// 1. the trash root must be configured (fail closed otherwise),
/// 2. canonicalize the trashed path,
/// 3. `ensure_allowed` (the AllowList is the boundary),
/// 4. PRIMARY CHECK: the canonical path must be a DIRECT child of the trash
///    root (component-aware) — never the root itself, an ancestor, a sibling,
///    or an arbitrary allowed path,
/// 5. remove the item with the same file/directory removal semantics as
///    [`delete_item`],
/// 6. remove the paired sidecar so no orphaned metadata remains.
pub fn permanently_delete_trash_entry(
    trash: &TrashRoot,
    allow_list: &AllowList,
    trashed_path: &str,
) -> Result<String, String> {
    if trash.root().as_os_str().is_empty() {
        return Err("Trash is not configured".to_string());
    }
    let target = Path::new(trashed_path);
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Unable to delete from trash: {}", map_io_error(&e)))?;
    ensure_allowed(allow_list, &canonical)?;

    let trash_root = trash.root();
    // PRIMARY CHECK: only a direct child of the trash root is a genuine trash
    // entry. The root itself, ancestors of the root, sibling directories, and
    // arbitrary allowed paths must never be deleted through this operation.
    let inside = canonical != trash_root && canonical.starts_with(trash_root);
    if !inside || canonical.parent() != Some(trash_root) {
        return Err("Not a trash entry".to_string());
    }

    let sidecar = sidecar_path_for(&canonical);

    let meta =
        fs::metadata(&canonical).map_err(|e| format!("Unable to delete from trash: {}", map_io_error(&e)))?;
    let result = if meta.is_dir() {
        fs::remove_dir_all(&canonical)
    } else {
        fs::remove_file(&canonical)
    };
    result.map_err(|e| format!("Unable to delete from trash: {}", map_io_error(&e)))?;

    // Remove the paired sidecar. If cleanup fails the item is already gone —
    // report the failure clearly instead of pretending full success.
    if let Err(e) = fs::remove_file(&sidecar) {
        return Err(format!(
            "The item was deleted but its metadata could not be removed: {}",
            map_io_error(&e)
        ));
    }

    Ok(canonical.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Application metadata — starred paths
// ---------------------------------------------------------------------------

/// The file name of the app-managed star store inside the app-local data dir.
pub const STARS_FILE_NAME: &str = "stars.json";

/// Maximum number of starred paths the store will hold.
pub const MAX_STARRED_PATHS: usize = 10_000;

/// Maximum length of a single starred path (a sane cap, not a path policy).
pub const MAX_STAR_PATH_LEN: usize = 4_096;

/// The configured location of the app's star store (`stars.json` in the Tauri
/// app-local data directory).
///
/// This is configuration/location state ONLY — like [`TrashRoot`] it is a
/// fail-closed tombstone (empty path) when the data dir cannot be resolved.
pub struct StarStore {
    file: PathBuf,
}

impl StarStore {
    /// A store rooted at the given `stars.json` path.
    pub fn new(file: PathBuf) -> Self {
        StarStore { file }
    }

    /// Read-only access to the configured store file.
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// An empty-root tombstone so every star operation is denied (fail closed).
    pub fn empty() -> Self {
        StarStore {
            file: PathBuf::from(""),
        }
    }
}

/// Load and validate the starred absolute paths from the star store.
///
/// A missing file (first run) is an empty store. Values that are not strings,
/// over-length, or beyond the count cap are dropped; an unparseable file is an
/// error so a corrupt store is never silently treated as empty.
pub fn load_stars(store: &StarStore) -> Result<Vec<String>, String> {
    if store.file().as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    let bytes = match fs::read(store.file()) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Unable to load stars: {}", map_io_error(&e))),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Star data is corrupt".to_string())?;
    let arr = value
        .as_array()
        .ok_or_else(|| "Star data is corrupt".to_string())?;

    let mut out = Vec::new();
    for item in arr {
        if out.len() >= MAX_STARRED_PATHS {
            break;
        }
        if let Some(s) = item.as_str() {
            if s.chars().count() <= MAX_STAR_PATH_LEN {
                out.push(s.to_string());
            }
        }
    }
    Ok(out)
}

/// Persist the starred absolute paths atomically (temp file + rename).
///
/// The save refuses (rather than silently truncating) when the set exceeds the
/// count cap or any single path exceeds the length cap.
pub fn save_stars(store: &StarStore, paths: &[String]) -> Result<(), String> {
    if store.file().as_os_str().is_empty() {
        return Err("Stars are not configured".to_string());
    }
    if paths.len() > MAX_STARRED_PATHS {
        return Err(format!(
            "Too many starred paths: {} (max {})",
            paths.len(),
            MAX_STARRED_PATHS
        ));
    }
    for p in paths {
        if p.chars().count() > MAX_STAR_PATH_LEN {
            return Err("Starred path is too long".to_string());
        }
    }

    let json = serde_json::to_string(paths).map_err(|_| "Unable to serialize stars".to_string())?;
    // Write to a temp file next to the target, then atomically rename over it;
    // a crash mid-write leaves the previous store intact.
    let file = store.file();
    let temp: PathBuf = PathBuf::from(format!("{}.tmp", file.to_string_lossy()));
    fs::write(&temp, json.as_bytes())
        .map_err(|e| format!("Unable to save stars: {}", map_io_error(&e)))?;
    fs::rename(&temp, file).map_err(|e| format!("Unable to save stars: {}", map_io_error(&e)))
}

/// Outcome of resolving the persisted starred paths against the real filesystem.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StarredResolution {
    /// Entries that exist on disk (already built as normal real [`FileEntry`]s).
    pub items: Vec<FileEntry>,
    /// The original starred paths that could NOT be resolved: missing, deleted,
    /// moved, invalid, non-files (symlinks), or outside the [`AllowList`]. They
    /// are reported honestly and never synthesized into fake entries.
    pub missing: Vec<String>,
}

/// Resolve a batch of persisted starred absolute paths into real [`FileEntry`]s.
///
/// # Security order (mirrors `get_file_metadata`/`search_files`)
///
/// 1. `symlink_metadata` — verifies the entry exists; missing/deleted/moved
///    paths and symbolic links are reported as `missing` (symlinks are never
///    represented as real entries, matching list/search behavior).
/// 2. `canonicalize` — normalizes `..`/symlinked ancestors so identity is the
///    canonical filesystem path.
/// 3. `ensure_allowed` — the AllowList remains the sole authorization boundary;
///    anything outside the allowed roots is `missing`, never resolved.
/// 4. `build_file_entry` — the shared entry builder used by `list_directory`
///    and `search_files`, so resolve results match the listing contract exactly.
///
/// Each path resolves or reports independently; a single unusable path never
/// aborts the batch. An empty AllowList fails closed: every path is `missing`.
pub fn resolve_starred_paths(
    allow_list: &AllowList,
    paths: &[String],
) -> Result<StarredResolution, String> {
    let mut items = Vec::new();
    let mut missing = Vec::new();

    for path in paths.iter() {
        let target = Path::new(path);
        let meta = match fs::symlink_metadata(target) {
            Ok(m) => m,
            Err(_) => {
                missing.push(path.clone());
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            missing.push(path.clone());
            continue;
        }
        let canonical = match target.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                missing.push(path.clone());
                continue;
            }
        };
        if ensure_allowed(allow_list, &canonical).is_err() {
            missing.push(path.clone());
            continue;
        }
        items.push(build_file_entry(&canonical, &meta));
    }

    Ok(StarredResolution { items, missing })
}

// ---------------------------------------------------------------------------
// Duplicate detection (candidate discovery)
// ---------------------------------------------------------------------------

/// A single group of VERIFIED duplicate files: members share the exact same
/// byte size AND the exact same SHA-256 content digest (streamed, never loaded
/// whole into memory). Zero-byte files group naturally via their shared empty
/// digest.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// Canonical path of the first member when sorted by path (stable id).
    pub id: String,
    /// Exact shared byte size of every member.
    pub size_bytes: u64,
    /// Human-readable shared size for display, e.g. "2.4 MB".
    pub size: String,
    /// Member entries, sorted by path (always 2+, singletons are never emitted).
    pub items: Vec<FileEntry>,
}

/// Result of a bounded duplicate-verification scan.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroupsResult {
    /// Confirmed duplicate groups (2+ same-size, same-content files each),
    /// deterministically ordered.
    pub groups: Vec<DuplicateGroup>,
    /// True when a traversal, hashing, or result budget was reached before the
    /// whole allowed tree was verified, so `groups` may be a partial view.
    pub truncated: bool,
}

/// Safety cap for a duplicate scan: the walk stops after this many visited
/// entries (files AND directories) across all allowed roots, so the scan
/// cannot traverse an unbounded tree.
pub const DUPLICATE_SCAN_MAX_VISITED_ENTRIES: usize = 100_000;

/// Safety cap for a duplicate scan: at most this many groups are returned.
/// Any groups beyond the cap are dropped and `truncated` is set.
pub const DUPLICATE_SCAN_MAX_GROUPS: usize = 500;

/// Safety cap for a duplicate scan: at most this many CONTENT BYTES are
/// streamed through SHA-256 across the whole scan. When the budget is
/// exhausted mid-hash, hashing stops immediately, the in-progress group is
/// dropped, and `truncated` is set. 512 MiB bounds worst-case read amplification
/// (e.g. a heap of 100,000 max-size files) while allowing realistic catalog
/// scans to complete untouched.
pub const DUPLICATE_SCAN_MAX_BYTES_HASHED: u64 = 512 * 1024 * 1024;

/// Scan every allowed root for VERIFIED duplicate files: size-bucket the
/// traversal, then stream-hash each size-matched candidate set and keep only
/// members whose SHA-256 digests agree. Delegates to
/// [`find_duplicate_groups_budgeted`] with the global hashing budget
/// [`DUPLICATE_SCAN_MAX_BYTES_HASHED`].
///
/// # Security / traversal contract (mirrors [`search_files`])
///
/// - Only canonicalized [`AllowList`] roots are traversed, gated through
///   [`ensure_allowed`]; traversal never leaves an allowed root.
/// - Symbolic links are never followed (via the shared [`walk_recursive`]).
/// - Unix inode cycle detection prevents infinite loops from hardlink-based
///   directory cycles or bind mounts.
/// - Per-branch errors are tolerated: an unreadable subdirectory is skipped,
///   and an unreadable member is dropped from its group (never a hard error).
/// - Regular files only; folders (and symlinks) are never candidates. Zero-byte
///   files are valid candidates and group together via their shared digest.
/// - The Smart File Manager trash subtree (`trash`) is never scanned, so
///   trashed copies and their sidecar metadata never appear as candidates.
/// - ONLY files sharing an exact byte size ever reach the hasher.
/// - The scan is hard-capped at `max_visited_entries` visited entries,
///   `max_bytes_hashed` streamed content bytes, and `max_groups` returned
///   groups. When any cap is hit, remaining work is dropped and `truncated` is
///   set so the caller can present the prefix honestly.
/// - Deterministic ordering: groups by shared size, largest first (ties by
///   first-member path); members by path.
pub fn find_duplicate_groups(
    allow_list: &AllowList,
    trash: &TrashRoot,
    max_visited_entries: usize,
    max_groups: usize,
) -> Result<DuplicateGroupsResult, String> {
    find_duplicate_groups_budgeted(
        allow_list,
        trash,
        max_visited_entries,
        max_groups,
        DUPLICATE_SCAN_MAX_BYTES_HASHED,
    )
}

/// [`find_duplicate_groups`] with an explicit byte-hashing budget, so the
/// truncation behavior can be exercised by tests with tiny budgets without
/// writing hundreds of MiB of files.
fn find_duplicate_groups_budgeted(
    allow_list: &AllowList,
    trash: &TrashRoot,
    max_visited_entries: usize,
    max_groups: usize,
    max_bytes_hashed: u64,
) -> Result<DuplicateGroupsResult, String> {
    // Canonicalize the trash offset so the exclusion matches the canonical walk
    // paths (e.g. /var -> /private/var on macOS). Fall back to the raw path if
    // the trash cannot be canonicalized (it does not exist yet — nothing to
    // exclude anyway).
    let trash_canonical: PathBuf = trash
        .root()
        .canonicalize()
        .unwrap_or_else(|_| trash.root().to_path_buf());

    let mut buckets: std::collections::HashMap<u64, Vec<FileEntry>> =
        std::collections::HashMap::new();
    let mut truncated = false;
    let mut visited_entries: usize = 0;

    'roots: for root in allow_list.roots() {
        ensure_allowed(allow_list, root)?;
        let mut visited = std::collections::HashSet::new();

        let mut visit = |entry_path: &Path, meta: &fs::Metadata| -> bool {
            // Traversal budget, checked before visiting this entry — same
            // convention as the search visitor.
            if visited_entries >= max_visited_entries {
                truncated = true;
                return false;
            }
            visited_entries += 1;

            // Only regular files are size-bucket candidates.
            if !meta.is_file() {
                return true;
            }
            let entry = build_file_entry(entry_path, meta);
            buckets.entry(entry.size_bytes).or_default().push(entry);
            true
        };

        let mut skip_trash = |dir: &Path| -> bool { dir == trash_canonical.as_path() };

        if !walk_recursive_skipping(root, &mut visited, &mut visit, &mut skip_trash) {
            break 'roots; // the traversal budget was reached
        }
    }

    // Candidates for verification: buckets holding 2+ same-size files. Members
    // are sorted by path, giving every size bucket a deterministic, stable
    // order that carries into the per-hash sub-groups below.
    let mut candidates: Vec<(u64, Vec<FileEntry>)> = buckets
        .into_iter()
        .filter(|(_, entries)| entries.len() >= 2)
        .collect();
    for (_, entries) in candidates.iter_mut() {
        entries.sort_by(|a, b| a.path.cmp(&b.path));
    }
    // Process buckets from largest size to smallest (ties by first-member
    // path), matching the final display order — so a hashing-budget truncation
    // always keeps the highest-priority verified groups.
    candidates.sort_by(|(a_size, a_entries), (b_size, b_entries)| {
        b_size
            .cmp(a_size)
            .then_with(|| a_entries[0].path.cmp(&b_entries[0].path))
    });

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut bytes_hashed: u64 = 0;

    'verify: for (size_bytes, entries) in candidates {
        // Only files already matched by exact size reach the hasher.
        let mut by_hash: std::collections::HashMap<[u8; 32], Vec<FileEntry>> =
            std::collections::HashMap::new();
        for entry in entries {
            match streamed_sha256(Path::new(&entry.path), &mut bytes_hashed, max_bytes_hashed) {
                HashRead::Done(digest) => by_hash.entry(digest).or_default().push(entry),
                // Tolerate an unreadable member (permission error, vanished
                // mid-scan): drop it without poisoning the scan.
                HashRead::Unreadable => continue,
                // The global byte budget is exhausted — stop hashing entirely.
                HashRead::OutOfBudget => {
                    truncated = true;
                    break 'verify;
                }
            }
        }

        for (_, mut items) in by_hash {
            if items.len() < 2 {
                continue;
            }
            items.sort_by(|a, b| a.path.cmp(&b.path));
            groups.push(DuplicateGroup {
                id: items[0].path.clone(),
                size_bytes,
                size: format_size(size_bytes),
                items,
            });
        }
    }

    // Deterministic ordering: shared size, largest first; ties break by id.
    groups.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.id.cmp(&b.id))
    });

    // The group budget is applied at emit time (groups only become known after
    // the verification pass finishes). Extra groups are dropped and honestly
    // flagged, matching the storage/search "prefix only" convention.
    if groups.len() > max_groups {
        groups.truncate(max_groups);
        truncated = true;
    }

    Ok(DuplicateGroupsResult { groups, truncated })
}

/// Outcome of streaming one file through SHA-256.
enum HashRead {
    /// The whole file was hashed within budget; carries its 32-byte digest.
    Done([u8; 32]),
    /// The file could not be opened/read. Tolerated: the member is dropped.
    Unreadable,
    /// The global byte budget ran out before EOF. The caller must stop and
    /// report `truncated`.
    OutOfBudget,
}

/// Stream a file's contents through SHA-256 without ever loading the whole
/// file into memory, deducting every byte read from `bytes_hashed` against
/// `bytes_budget`.
///
/// A file is only fully verified if EOF is reached WITHIN budget; a file that
/// consumes the budget exactly cannot be confirmed as fully read and is
/// treated as [`HashRead::OutOfBudget`]. Zero-byte files hash for free (EOF on
/// the first read) and produce the canonical empty digest, so exact-size empty
/// files keep forming duplicates.
fn streamed_sha256(
    path: &Path,
    bytes_hashed: &mut u64,
    bytes_budget: u64,
) -> HashRead {
    use sha2::{Digest, Sha256};

    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return HashRead::Unreadable,
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        if *bytes_hashed >= bytes_budget {
            return HashRead::OutOfBudget;
        }
        let want = buf.len().min((bytes_budget - *bytes_hashed) as usize);
        let n = match io::Read::read(&mut file, &mut buf[..want]) {
            Ok(n) => n,
            Err(_) => return HashRead::Unreadable,
        };
        if n == 0 {
            return HashRead::Done(hasher.finalize().into());
        }
        hasher.update(&buf[..n]);
        *bytes_hashed += n as u64;
    }
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

    /// Set a deterministic modification time (epoch seconds) on a file so the
    /// recent-files ordering tests are stable and driven by real metadata.
    fn set_mtime(path: &Path, epoch_secs: u64) {
        let times = fs::FileTimes::new()
            .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs));
        fs::File::open(path)
            .expect("open path for mtime")
            .set_times(times)
            .expect("set modified time");
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
    fn rename_item_allows_case_only_rename() {
        let root = TempDir::new("rn_case");
        let allow = allow_for(&root);

        write_file(&root.child("Report.PDF"), "x");
        rename_item(&allow, &str_of(&root.child("Report.PDF")), "report.pdf").unwrap();

        // true everywhere: in-place case change on a case-insensitive
        // filesystem, plain rename on a case-sensitive filesystem
        assert!(root.child("report.pdf").exists());
    }

    #[test]
    fn rename_item_rejects_existing_destination() {
        let root = TempDir::new("rn_conflict");
        let allow = allow_for(&root);
        write_file(&root.child("a.txt"), "a");
        write_file(&root.child("b.txt"), "b");

        let err = rename_item(&allow, &str_of(&root.child("a.txt")), "b.txt").unwrap_err();
        assert_eq!(err, "A file or folder with that name already exists.".to_string());
        assert!(root.child("a.txt").is_file());
        assert!(root.child("b.txt").is_file());
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
    fn move_file_moves_a_file_to_an_exact_destination() {
        let root = TempDir::new("mvf_root");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("dest")).unwrap();

        write_file(&root.child("a.txt"), "a");
        move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&root.child("dest/a.txt")),
        )
        .unwrap();
        assert!(root.child("dest").join("a.txt").is_file());
        assert!(!root.child("a.txt").exists());
    }

    #[test]
    fn move_file_can_rename_while_moving() {
        let root = TempDir::new("mvf_rename");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("dest")).unwrap();

        write_file(&root.child("a.txt"), "a");
        move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&root.child("dest/renamed.txt")),
        )
        .unwrap();
        assert!(root.child("dest").join("renamed.txt").is_file());
        assert!(!root.child("a.txt").exists());
    }

    #[test]
    fn move_file_rejects_folders_and_keeps_source_when_destination_is_missing() {
        let root = TempDir::new("mvf_folder");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("folder")).unwrap();

        let err = move_file(
            &allow,
            &str_of(&root.child("folder")),
            &str_of(&root.child("dest2")),
        )
        .unwrap_err();
        assert_eq!(err, "The source is not a file");
        assert!(root.child("folder").is_dir());

        write_file(&root.child("a.txt"), "a");
        let err = move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&root.child("missing/b.txt")),
        )
        .unwrap_err();
        assert_eq!(err, "The destination folder does not exist.");
        assert!(root.child("a.txt").is_file());
    }

    #[test]
    fn move_file_refuses_to_overwrite_and_denies_outside_root() {
        let root = TempDir::new("mvf_overwrite");
        let outside = TempDir::new("mvf_outside");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("dest")).unwrap();

        write_file(&root.child("a.txt"), "a");
        write_file(&root.child("dest/a.txt"), "occupied");
        let err = move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&root.child("dest/a.txt")),
        )
        .unwrap_err();
        assert_eq!(err, "A file or folder with that name already exists.");
        assert!(!root.child("dest").join("a.txt").is_empty());
        assert_eq!(std::fs::read_to_string(root.child("dest").join("a.txt")).unwrap(), "occupied");

        // in → out: denied and source untouched
        write_file(&outside.child("x.txt"), "x");
        let err = move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&outside.child("x.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(root.child("a.txt").is_file());
        assert!(!outside.child("x.txt").is_empty());

        // out → in: denied
        let err = move_file(
            &allow,
            &str_of(&outside.child("x.txt")),
            &str_of(&root.child("dest/x.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("x.txt").is_file());
    }

    #[test]
    fn move_file_missing_source_and_noop_destination() {
        let root = TempDir::new("mvf_noop");
        let allow = allow_for(&root);
        fs::create_dir_all(root.child("dest")).unwrap();

        let err = move_file(
            &allow,
            &str_of(&root.child("ghost.txt")),
            &str_of(&root.child("dest/ghost.txt")),
        )
        .unwrap_err();
        assert_eq!(err, "The file or folder no longer exists.");

        write_file(&root.child("a.txt"), "a");
        move_file(
            &allow,
            &str_of(&root.child("a.txt")),
            &str_of(&root.child("a.txt")),
        )
        .unwrap();
        assert!(root.child("a.txt").is_file());
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

        let result =
            super::search_files(&allow, "", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS).unwrap();
        assert!(result.entries.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn search_whitespace_only_query_returns_empty() {
        let tmp = TempDir::new("search_whitespace");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("anything.txt"), "data");

        let result =
            super::search_files(&allow, "   \t  ", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(result.entries.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn search_case_insensitive_filename() {
        let tmp = TempDir::new("search_case");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("README.TXT"), "hello");
        write_file(&tmp.child("notes.txt"), "world");

        let results =
            super::search_files(&allow, "readme", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 1);
        assert_eq!(results.entries[0].name, "README.TXT");
    }

    #[test]
    fn search_substring_match() {
        let tmp = TempDir::new("search_substring");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("annual_report.pdf"), "data");
        write_file(&tmp.child("my-report.txt"), "data");
        write_file(&tmp.child("budget.xlsx"), "data");

        let results =
            super::search_files(&allow, "report", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 2);
        let names: Vec<&str> = results.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"annual_report.pdf"));
        assert!(names.contains(&"my-report.txt"));
    }

    #[test]
    fn search_matches_files() {
        let tmp = TempDir::new("search_files");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("target.txt"), "data");

        let results =
            super::search_files(&allow, "target", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 1);
        assert!(!results.entries[0].is_folder);
    }

    #[test]
    fn search_matches_directories() {
        let tmp = TempDir::new("search_dirs");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("projects")).unwrap();
        write_file(&tmp.child("projects").join("file.txt"), "data");

        let results =
            super::search_files(&allow, "projects", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(results.entries.iter().any(|e| e.is_folder && e.name == "projects"));
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

        let results =
            super::search_files(&allow, "found", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 1);
        assert_eq!(results.entries[0].name, "found.txt");
    }

    #[test]
    fn search_multiple_roots() {
        let tmp1 = TempDir::new("search_multi_r1");
        let tmp2 = TempDir::new("search_multi_r2");
        let mut allow = AllowList::with_root(&str_of(tmp1.path())).unwrap();
        allow.register_root(&str_of(tmp2.path())).unwrap();

        write_file(&tmp1.child("alpha.txt"), "data");
        write_file(&tmp2.child("beta.txt"), "data");

        let results =
            super::search_files(&allow, "alpha", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 1);
        assert_eq!(results.entries[0].name, "alpha.txt");

        let results =
            super::search_files(&allow, "beta", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 1);
        assert_eq!(results.entries[0].name, "beta.txt");
    }

    #[test]
    fn search_results_remain_inside_allowed_roots() {
        let tmp = TempDir::new("search_inside");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub")).unwrap();
        write_file(&tmp.child("sub").join("match.txt"), "data");

        let results =
            super::search_files(&allow, "match", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(!results.entries.is_empty());
        // Use the canonical AllowList root with component-aware Path comparison
        // (not string-prefix matching) to verify containment.
        let root = &allow.roots()[0];
        for entry in &results.entries {
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

        let results =
            super::search_files(&allow, "secret", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(results.entries.is_empty());
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

        let results =
            super::search_files(&allow, "secret", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        // The symlink itself is skipped; the target outside is never reached.
        assert!(results.entries.is_empty());
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
        let results =
            super::search_files(&allow, "anything", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(results.entries.is_empty());
    }

    #[test]
    fn search_deterministic_ordering() {
        let tmp = TempDir::new("search_order");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("zebra.txt"), "data");
        write_file(&tmp.child("apple.txt"), "data");
        write_file(&tmp.child("mango.txt"), "data");

        let results =
            super::search_files(&allow, "", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS).unwrap();
        assert!(results.entries.is_empty());

        let results =
            super::search_files(&allow, "txt", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(results.entries.len(), 3);
        // Results must be sorted by path.
        for i in 1..results.entries.len() {
            assert!(results.entries[i - 1].path <= results.entries[i].path);
        }
    }

    #[test]
    fn search_empty_allowlist_returns_no_results() {
        let tmp = TempDir::new("search_empty_al");
        let allow = AllowList::empty();
        write_file(&tmp.child("hidden.txt"), "data");

        let results =
            super::search_files(&allow, "hidden", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert!(results.entries.is_empty());
    }

    #[test]
    fn search_result_budget_is_honored() {
        let tmp = TempDir::new("search_result_cap");
        let allow = allow_for(&tmp);
        // Three matching files; the result budget of two must win out.
        write_file(&tmp.child("match-a.txt"), "data");
        write_file(&tmp.child("match-b.txt"), "data");
        write_file(&tmp.child("match-c.txt"), "data");

        let result = super::search_files(&allow, "match", 100, 2).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn search_traversal_budget_is_honored() {
        let tmp = TempDir::new("search_traversal_cap");
        let allow = allow_for(&tmp);
        // Five matching entries on disk; visiting a single entry already meets
        // the traversal budget of one, so the walk must stop without scanning
        // the rest of the tree.
        write_file(&tmp.child("a-one.txt"), "data");
        write_file(&tmp.child("a-two.txt"), "data");
        write_file(&tmp.child("a-three.txt"), "data");
        write_file(&tmp.child("a-four.txt"), "data");
        fs::create_dir_all(tmp.child("a-dir")).unwrap();

        // read_dir order is not guaranteed, but every entry name contains "a",
        // so whichever one entry was visited is a match — exactly one result.
        let result = super::search_files(&allow, "a", 1, 100).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(result.truncated);
    }

    #[test]
    fn search_within_budgets_is_not_truncated() {
        let tmp = TempDir::new("search_within");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("notes.txt"), "data");
        write_file(&tmp.child("plan.md"), "data");

        let result =
            super::search_files(&allow, "notes", SEARCH_MAX_VISITED_ENTRIES, SEARCH_MAX_RESULTS)
                .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "notes.txt");
        assert!(!result.truncated);
    }

    #[test]
    fn search_budget_is_shared_across_roots() {
        let tmp1 = TempDir::new("search_budget_r1");
        let tmp2 = TempDir::new("search_budget_r2");
        let mut allow = AllowList::with_root(&str_of(tmp1.path())).unwrap();
        allow.register_root(&str_of(tmp2.path())).unwrap();
        write_file(&tmp1.child("match-a.txt"), "data");
        write_file(&tmp1.child("match-b.txt"), "data");
        write_file(&tmp2.child("match-c.txt"), "data");

        // The result budget is global across all roots: once the first root
        // fills it, the second root is never scanned.
        let result = super::search_files(&allow, "match", 100, 2).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result.truncated);
    }

    // -- recent_files -------------------------------------------------------

    #[test]
    fn recent_empty_allowlist_returns_empty() {
        let tmp = TempDir::new("recent_empty_al");
        let allow = AllowList::empty();
        write_file(&tmp.child("file.txt"), "data");

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn recent_limit_zero_returns_empty_without_scanning() {
        let tmp = TempDir::new("recent_zero");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("file.txt"), "data");

        let results = super::recent_files(&allow, 0).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn recent_collects_files_and_folders() {
        let tmp = TempDir::new("recent_both");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("notes.txt"), "data");
        fs::create_dir(tmp.child("projects")).unwrap();
        write_file(&tmp.child("projects").join("plan.md"), "data");

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().any(|e| !e.is_folder && e.name == "notes.txt"));
        assert!(results.iter().any(|e| e.is_folder && e.name == "projects"));
        assert!(results.iter().any(|e| !e.is_folder && e.name == "plan.md"));
    }

    #[test]
    fn recent_sorted_newest_first() {
        let tmp = TempDir::new("recent_order");
        let allow = allow_for(&tmp);
        // Lower epoch = older. Creation order is intentionally out of mtime order.
        write_file(&tmp.child("old.txt"), "data");
        write_file(&tmp.child("new.txt"), "data");
        write_file(&tmp.child("mid.txt"), "data");
        set_mtime(&tmp.child("old.txt"), 1_000);
        set_mtime(&tmp.child("mid.txt"), 2_000);
        set_mtime(&tmp.child("new.txt"), 3_000);

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        let names: Vec<&str> = results.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["new.txt", "mid.txt", "old.txt"]);
    }

    #[test]
    fn recent_tie_breaker_is_deterministic_path() {
        let tmp = TempDir::new("recent_tie");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("zebra.txt"), "data");
        write_file(&tmp.child("apple.txt"), "data");
        set_mtime(&tmp.child("zebra.txt"), 5_000);
        set_mtime(&tmp.child("apple.txt"), 5_000);

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        let names: Vec<&str> = results.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["apple.txt", "zebra.txt"]);
    }

    #[test]
    fn recent_limit_truncates_to_newest() {
        let tmp = TempDir::new("recent_trunc");
        let allow = allow_for(&tmp);
        for i in 1..=10u64 {
            let f = tmp.child(&format!("file{}.txt", i));
            write_file(&f, "data");
            set_mtime(&f, i * 100);
        }

        let results = super::recent_files(&allow, 3).unwrap();
        assert_eq!(results.len(), 3);
        let names: Vec<&str> = results.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["file10.txt", "file9.txt", "file8.txt"]);
    }

    #[test]
    fn recent_multiple_roots_merged() {
        let tmp1 = TempDir::new("recent_multi_r1");
        let tmp2 = TempDir::new("recent_multi_r2");
        let mut allow = AllowList::with_root(&str_of(tmp1.path())).unwrap();
        allow.register_root(&str_of(tmp2.path())).unwrap();
        write_file(&tmp1.child("a.txt"), "data");
        write_file(&tmp2.child("b.txt"), "data");
        set_mtime(&tmp1.child("a.txt"), 500);
        set_mtime(&tmp2.child("b.txt"), 500);

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        assert_eq!(results.iter().filter(|e| e.name == "a.txt").count(), 1);
        assert_eq!(results.iter().filter(|e| e.name == "b.txt").count(), 1);
    }

    #[test]
    fn recent_results_remain_inside_allowed_roots() {
        let tmp = TempDir::new("recent_inside");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub")).unwrap();
        write_file(&tmp.child("sub").join("match.txt"), "data");

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        assert!(!results.is_empty());
        let root = &allow.roots()[0];
        for entry in &results {
            let entry_path = Path::new(&entry.path);
            assert!(entry_path.starts_with(root));
        }
    }

    #[cfg(unix)]
    #[test]
    fn recent_skips_symlinks_and_outside_targets() {
        let root = TempDir::new("recent_sym_r");
        let outside = TempDir::new("recent_sym_o");
        let allow = allow_for(&root);
        write_file(&outside.child("leak.txt"), "data");
        write_file(&root.child("inside.txt"), "data");
        std::os::unix::fs::symlink(&outside.child("leak.txt"), &root.child("link.txt")).unwrap();

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        // The symlink entry itself is skipped; its outside target is never reached.
        assert!(!results.iter().any(|e| e.name == "link.txt"));
        assert!(!results.iter().any(|e| e.name == "leak.txt"));
        assert!(results.iter().any(|e| e.name == "inside.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn recent_tolerates_unreadable_branch() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("recent_unreadable");
        let allow = allow_for(&tmp);
        fs::create_dir(tmp.child("locked")).unwrap();
        write_file(&tmp.child("open.txt"), "data");
        write_file(&tmp.child("locked").join("hidden.txt"), "data");

        fs::set_permissions(&tmp.child("locked"), fs::Permissions::from_mode(0o000)).unwrap();

        let results = super::recent_files(&allow, RECENT_FILES_DEFAULT_LIMIT).unwrap();
        assert!(results.iter().any(|e| e.name == "open.txt"));
        assert!(!results.iter().any(|e| e.name == "hidden.txt"));

        fs::set_permissions(&tmp.child("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    }

    // -- storage_by_category ------------------------------------------------

    #[test]
    fn storage_categories_are_in_canonical_order() {
        let tmp = TempDir::new("storage_order");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.pdf"), "data");
        write_file(&tmp.child("b.png"), "data");
        write_file(&tmp.child("c.zip"), "data");
        write_file(&tmp.child("d.xyz"), "data");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        let names: Vec<&str> = breakdown.categories.iter().map(|c| c.category.as_str()).collect();
        assert_eq!(names, ["Documents", "Images", "Videos", "Audio", "Archives", "Code", "Other"]);
    }

    #[test]
    fn storage_empty_allowlist_returns_zeroed_breakdown() {
        let tmp = TempDir::new("storage_empty_al");
        let allow = AllowList::empty();
        write_file(&tmp.child("a.txt"), "data");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        assert_eq!(breakdown.scanned_file_count, 0);
        assert_eq!(breakdown.total_bytes, 0);
        assert!(!breakdown.scan_capped);
        assert!(breakdown.categories.iter().all(|c| c.bytes == 0));
    }

    #[test]
    fn storage_aggregates_real_sizes_by_extension() {
        let tmp = TempDir::new("storage_sizes");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("report.pdf"), "pdf-content-10");
        write_file(&tmp.child("notes.txt"), "txt-content-10");
        write_file(&tmp.child("photo.png"), "png-content-10");
        write_file(&tmp.child("clip.mp4"), "mp4-content-10");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        assert_eq!(breakdown.scanned_file_count, 4);

        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        let images = breakdown.categories.iter().find(|c| c.category == "Images").unwrap();
        let videos = breakdown.categories.iter().find(|c| c.category == "Videos").unwrap();

        // "pdf-content-10" is 14 bytes, "txt-content-10" is 14 bytes, etc.
        assert_eq!(docs.bytes, 28);
        assert_eq!(images.bytes, 14);
        assert_eq!(videos.bytes, 14);
        assert_eq!(breakdown.total_bytes, docs.bytes + images.bytes + videos.bytes);
    }

    #[test]
    fn storage_unknown_extensions_go_to_other() {
        let tmp = TempDir::new("storage_other");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("took.bin"), "bin-content");
        write_file(&tmp.child("noext"), "no-ext-content");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        let other = breakdown.categories.iter().find(|c| c.category == "Other").unwrap();
        // Everything else stays 0.
        let others: Vec<u64> = breakdown
            .categories
            .iter()
            .filter(|c| c.category != "Other")
            .map(|c| c.bytes)
            .collect();
        assert!(others.iter().all(|&b| b == 0));
        assert_eq!(other.bytes, breakdown.total_bytes);
        assert!(other.bytes > 0);
    }

    #[test]
    fn storage_extension_matching_is_case_insensitive() {
        let tmp = TempDir::new("storage_case");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("REPORT.PDF"), "pdf-content-10");
        write_file(&tmp.child("slide.PPTX"), "pptx-content");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        // "pdf-content-10" (14) + "pptx-content" (12).
        assert_eq!(docs.bytes, 14 + 12);
    }

    #[test]
    fn storage_directories_carry_no_size() {
        let tmp = TempDir::new("storage_dirs");
        let allow = allow_for(&tmp);
        fs::create_dir(tmp.child("bigdir")).unwrap();
        write_file(&tmp.child("bigdir").join("inside.txt"), "txt-content-10");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        assert_eq!(breakdown.scanned_file_count, 1);
        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        assert_eq!(docs.bytes, 14);
    }

    #[cfg(unix)]
    #[test]
    fn storage_skips_symlinks_and_outside_targets() {
        let root = TempDir::new("storage_sym_r");
        let outside = TempDir::new("storage_sym_o");
        let allow = allow_for(&root);
        write_file(&outside.child("leak.bin"), "outside-bytes");
        write_file(&root.child("inside.txt"), "txt-content-10");
        std::os::unix::fs::symlink(&outside.child("leak.bin"), &root.child("link.bin")).unwrap();

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        // Only the real in-root file is counted; the symlink (and its outside
        // target) contribute nothing.
        assert_eq!(breakdown.scanned_file_count, 1);
        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        let other = breakdown.categories.iter().find(|c| c.category == "Other").unwrap();
        assert_eq!(docs.bytes, 14);
        assert_eq!(other.bytes, 0);
        assert_eq!(breakdown.total_bytes, 14);
    }

    #[test]
    fn storage_never_scans_outside_roots() {
        let root = TempDir::new("storage_out_r");
        let outside = TempDir::new("storage_out_o");
        let allow = allow_for(&root);
        write_file(&outside.child("secret.jpg"), "secret-data");
        write_file(&root.child("me.txt"), "txt-content-10");

        let breakdown = super::storage_by_category(&allow, STORAGE_SCAN_MAX_FILES).unwrap();
        assert_eq!(breakdown.scanned_file_count, 1);
        let images = breakdown.categories.iter().find(|c| c.category == "Images").unwrap();
        assert_eq!(images.bytes, 0);
    }

    #[test]
    fn storage_safety_cap_marks_cap_and_bounds_count() {
        let tmp = TempDir::new("storage_cap");
        let allow = allow_for(&tmp);
        // All files same size (10 bytes) so the scanned prefix total is exact
        // regardless of the OS's read_dir ordering.
        for i in 0..8u32 {
            write_file(&tmp.child(&format!("f{}.txt", i)), "0123456789");
        }

        let breakdown = super::storage_by_category(&allow, 5).unwrap();
        assert!(breakdown.scan_capped);
        assert_eq!(breakdown.scanned_file_count, 5);
        // Exactly 5 × 10 bytes were classified.
        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        assert_eq!(docs.bytes, 50);
        assert_eq!(breakdown.total_bytes, 50);
    }

    #[test]
    fn storage_safety_cap_stops_before_further_roots() {
        let root1 = TempDir::new("storage_cap_r1");
        let root2 = TempDir::new("storage_cap_r2");
        let mut allow = AllowList::with_root(&str_of(root1.path())).unwrap();
        allow.register_root(&str_of(root2.path())).unwrap();
        for i in 0..3u32 {
            write_file(&root1.child(&format!("a{}.txt", i)), "0123456789");
        }
        write_file(&root2.child("song.mp3"), "0123456789abcd");

        let breakdown = super::storage_by_category(&allow, 2).unwrap();
        assert!(breakdown.scan_capped);
        assert_eq!(breakdown.scanned_file_count, 2);
        // Root 2 was never reached, so Audio stays 0.
        let docs = breakdown.categories.iter().find(|c| c.category == "Documents").unwrap();
        let audio = breakdown.categories.iter().find(|c| c.category == "Audio").unwrap();
        assert_eq!(docs.bytes, 20);
        assert_eq!(audio.bytes, 0);
    }

    // -- trash / restore helpers -------------------------------------------

    /// AllowList rooted at a temp dir, with a canonical `.trash` subdirectory
    /// as the root (mirrors the canonical root computed at Tauri setup).
    fn trash_for(tmp: &TempDir) -> TrashRoot {
        let trash_path = tmp.child(".trash");
        fs::create_dir_all(&trash_path).expect("create trash root");
        let canonical = trash_path.canonicalize().expect("canonicalize trash root");
        TrashRoot { root: canonical }
    }

    /// Canonical string form of a path (the temp dir may differ from its
    /// canonical path on macOS, e.g. `/var` vs `/private/var`).
    fn canonical_str(path: &Path) -> String {
        path.canonicalize().unwrap().to_string_lossy().to_string()
    }

    // -- trash_item --------------------------------------------------------

    #[test]
    fn trash_a_file() {
        let tmp = TempDir::new("trash_file");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");

        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        assert!(!tmp.child("foo.txt").exists());
        assert!(tmp.child(".trash").join("foo.txt").is_file());
        assert!(tmp.child(".trash").join("foo.txt.trash.json").is_file());
    }

    #[test]
    fn trash_a_directory() {
        let tmp = TempDir::new("trash_dir");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("proj").join("src")).unwrap();
        write_file(&tmp.child("proj").join("src").join("a.txt"), "a");

        super::trash_item(&trash, &allow, &str_of(&tmp.child("proj"))).unwrap();

        assert!(!tmp.child("proj").exists());
        let moved = tmp.child(".trash").join("proj");
        assert!(moved.is_dir());
        assert!(moved.join("src").join("a.txt").is_file());
        assert!(tmp.child(".trash").join("proj.trash.json").is_file());
    }

    #[test]
    fn trash_collision_safe_naming() {
        let tmp = TempDir::new("trash_collision");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "one");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        write_file(&tmp.child("foo.txt"), "two");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        assert!(tmp.child(".trash").join("foo.txt").is_file());
        assert!(tmp.child(".trash").join("foo.txt (1)").is_file());
        // The first item's bytes must remain intact (never overwritten).
        let first = fs::read(&tmp.child(".trash").join("foo.txt")).unwrap();
        assert_eq!(String::from_utf8(first).unwrap(), "one");
    }

    #[test]
    fn trash_sidecar_records_original_path() {
        let tmp = TempDir::new("trash_sidecar");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        let expected = canonical_str(&tmp.child("foo.txt"));

        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        let sidecar_json =
            String::from_utf8(fs::read(&tmp.child(".trash").join("foo.txt.trash.json")).unwrap())
                .unwrap();
        assert!(sidecar_json.contains(&expected));
    }

    #[test]
    fn trash_missing_source() {
        let tmp = TempDir::new("trash_missing");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::trash_item(&trash, &allow, &str_of(&tmp.child("ghost.txt"))).unwrap_err();
        assert!(err.contains("no longer exists"));
    }

    #[test]
    fn trash_source_outside_allowlist() {
        let tmp = TempDir::new("trash_outside_r");
        let outside = TempDir::new("trash_outside_o");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&outside.child("secret.txt"), "data");

        let err =
            super::trash_item(&trash, &allow, &str_of(&outside.child("secret.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("secret.txt").is_file());
    }

    #[test]
    fn trash_empty_allowlist() {
        let tmp = TempDir::new("trash_empty_al");
        let trash = trash_for(&tmp);
        let allow = AllowList::empty();
        write_file(&tmp.child("foo.txt"), "data");

        let err = super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(tmp.child("foo.txt").is_file());
    }

    #[test]
    fn trash_rejects_trash_root_itself() {
        let tmp = TempDir::new("trash_root_itself");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::trash_item(&trash, &allow, &str_of(&tmp.child(".trash"))).unwrap_err();
        assert!(err.contains("Cannot trash the trash directory"));
    }

    #[test]
    fn trash_rejects_folder_containing_trash() {
        let tmp = TempDir::new("trash_home");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        // Trashing the home directory — which contains the trash — must fail.
        let err = super::trash_item(&trash, &allow, &str_of(tmp.path())).unwrap_err();
        assert!(err.contains("Cannot trash a folder that contains the trash"));
    }

    #[cfg(unix)]
    #[test]
    fn trash_symlink_outside_allowlist() {
        let tmp = TempDir::new("trash_symlink");
        let outside = TempDir::new("trash_symlink_out");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&outside.child("secret.txt"), "data");

        std::os::unix::fs::symlink(&outside.child("secret.txt"), &tmp.child("link.txt")).unwrap();

        let err = super::trash_item(&trash, &allow, &str_of(&tmp.child("link.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(outside.child("secret.txt").is_file());
    }

    #[test]
    fn trash_with_unconfigured_root() {
        let tmp = TempDir::new("trash_unconfigured");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        let empty_trash = TrashRoot::empty();

        let err =
            super::trash_item(&empty_trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap_err();
        assert!(err.contains("Trash is not configured"));
        assert!(tmp.child("foo.txt").is_file());
    }

    // -- restore containment -----------------------------------------------

    #[test]
    fn restore_valid_direct_entry() {
        let tmp = TempDir::new("restore_direct");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        let restored = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap();
        assert_eq!(restored, canonical_str(&tmp.child("foo.txt")));
    }

    #[test]
    fn restore_valid_nested_dir() {
        let tmp = TempDir::new("restore_nested");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("proj").join("nested")).unwrap();
        write_file(&tmp.child("proj").join("nested").join("a.txt"), "a");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("proj"))).unwrap();

        let restored =
            super::restore_item(&trash, &allow, &str_of(&tmp.child(".trash").join("proj")))
                .unwrap();
        assert_eq!(restored, canonical_str(&tmp.child("proj")));
        assert!(tmp.child("proj").join("nested").join("a.txt").is_file());
    }

    #[test]
    fn restore_rejects_trash_root_itself() {
        let tmp = TempDir::new("restore_root_itself");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::restore_item(&trash, &allow, &str_of(&tmp.child(".trash"))).unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    #[test]
    fn restore_rejects_home_directory() {
        let tmp = TempDir::new("restore_home");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::restore_item(&trash, &allow, &str_of(tmp.path())).unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    #[test]
    fn restore_rejects_arbitrary_allowed_file_outside_trash() {
        let tmp = TempDir::new("restore_arbitrary");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("plain.txt"), "data");

        let err =
            super::restore_item(&trash, &allow, &str_of(&tmp.child("plain.txt"))).unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    #[test]
    fn restore_rejects_sibling_dir_beside_trash() {
        let tmp = TempDir::new("restore_sibling");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child(".trash-sibling")).unwrap();

        let err =
            super::restore_item(&trash, &allow, &str_of(&tmp.child(".trash-sibling"))).unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    #[test]
    fn restore_rejects_ancestor_of_trash() {
        let tmp = TempDir::new("restore_ancestor");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::restore_item(&trash, &allow, &str_of(tmp.path())).unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    // -- restore behavior --------------------------------------------------

    #[test]
    fn restore_successful_round_trip() {
        let tmp = TempDir::new("restore_roundtrip");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "hello world");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();
        assert!(!tmp.child("foo.txt").exists());

        let restored = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap();
        assert_eq!(restored, canonical_str(&tmp.child("foo.txt")));

        // Original is back with identical content and the sidecar is gone.
        assert!(tmp.child("foo.txt").is_file());
        assert_eq!(
            String::from_utf8(fs::read(&tmp.child("foo.txt")).unwrap()).unwrap(),
            "hello world"
        );
        assert!(!tmp.child(".trash").join("foo.txt.trash.json").exists());
    }

    #[test]
    fn restore_destination_collision() {
        let tmp = TempDir::new("restore_collision");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "original");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        // A new file claims the original slot.
        write_file(&tmp.child("foo.txt"), "newcomer");

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert!(err.contains("already exists"));
        // Nothing was moved out of the trash and the sidecar remains.
        assert!(tmp.child(".trash").join("foo.txt").is_file());
        assert!(tmp.child(".trash").join("foo.txt.trash.json").is_file());
    }

    #[test]
    fn restore_original_parent_missing() {
        let tmp = TempDir::new("restore_parent_missing");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("docs")).unwrap();
        write_file(&tmp.child("docs").join("file.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("docs").join("file.txt"))).unwrap();

        fs::remove_dir_all(&tmp.child("docs")).unwrap();

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("file.txt")),
        )
        .unwrap_err();
        assert!(err.contains("Unable to restore"));
    }

    #[test]
    fn restore_destination_outside_allowlist() {
        let tmp = TempDir::new("restore_outside_dest_r");
        let outside = TempDir::new("restore_outside_dest_o");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        // Tamper with the sidecar: point it at a path outside the AllowList.
        let sidecar = sidecar_path_for(&tmp.child(".trash").join("foo.txt"));
        write_file(&outside.child("evil.txt"), "data");
        write_sidecar(&sidecar, &outside.child("evil.txt")).unwrap();

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        // The item stays put in the trash — nothing escaped.
        assert!(tmp.child(".trash").join("foo.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn restore_destination_through_outside_symlink() {
        let tmp = TempDir::new("restore_symlink_r");
        let outside = TempDir::new("restore_symlink_o");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        // A symlink inside the allowed zone resolving OUTSIDE the AllowList.
        write_file(&outside.child("evil.txt"), "data");
        std::os::unix::fs::symlink(outside.path(), tmp.child("alias")).unwrap();

        let sidecar = sidecar_path_for(&tmp.child(".trash").join("foo.txt"));
        write_sidecar(&sidecar, &tmp.child("alias").join("evil.txt")).unwrap();

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(tmp.child(".trash").join("foo.txt").is_file());
    }

    #[test]
    fn restore_malformed_sidecar() {
        let tmp = TempDir::new("restore_malformed");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        let sidecar = sidecar_path_for(&tmp.child(".trash").join("foo.txt"));
        fs::write(&sidecar, b"this is not json").unwrap();

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert!(err.contains("Trash metadata is corrupt"));
    }

    #[test]
    fn restore_missing_sidecar() {
        let tmp = TempDir::new("restore_missing_sidecar");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        fs::remove_file(&tmp.child(".trash").join("foo.txt.trash.json")).unwrap();

        let err = super::restore_item(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert!(err.contains("Unable to restore"));
    }

    #[test]
    fn restore_empty_allowlist_cannot_authorize() {
        let tmp = TempDir::new("restore_empty_al");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        let err = super::restore_item(
            &trash,
            &AllowList::empty(),
            &str_of(&tmp.child(".trash").join("foo.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    // -- list_trash --------------------------------------------------------

    #[test]
    fn list_trash_lists_real_files_and_folders() {
        let tmp = TempDir::new("list_trash_items");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.txt"), "data");
        fs::create_dir_all(tmp.child("proj").join("src")).unwrap();
        write_file(&tmp.child("proj").join("src").join("b.txt"), "b");

        let original_file = canonical_str(&tmp.child("a.txt"));
        let original_dir = canonical_str(&tmp.child("proj"));
        super::trash_item(&trash, &allow, &str_of(&tmp.child("a.txt"))).unwrap();
        super::trash_item(&trash, &allow, &str_of(&tmp.child("proj"))).unwrap();

        let entries = super::list_trash(&trash, &allow).unwrap();
        assert_eq!(entries.len(), 2);

        let file = entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert!(!file.is_folder);
        assert_eq!(file.size_bytes, 4);
        assert_eq!(file.file_type, "txt");
        assert_eq!(file.original_path.as_deref(), Some(original_file.as_str()));

        let dir = entries.iter().find(|e| e.name == "proj").unwrap();
        assert!(dir.is_folder);
        assert_eq!(dir.file_type, "folder");
        assert_eq!(dir.original_path.as_deref(), Some(original_dir.as_str()));
    }

    #[test]
    fn list_trash_skips_sidecar_files_and_stays_empty_when_trash_empty() {
        let tmp = TempDir::new("list_trash_skip");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let entries = super::list_trash(&trash, &allow).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn list_trash_reports_original_path_when_sidecar_is_missing() {
        let tmp = TempDir::new("list_trash_no_sidecar");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("orphan.txt"), "x");
        fs::create_dir_all(tmp.child(".trash")).unwrap();
        // Simulate a sidecar-less entry inside the trash.
        fs::rename(tmp.child("orphan.txt"), tmp.child(".trash").join("orphan.txt")).unwrap();

        let entries = super::list_trash(&trash, &allow).unwrap();
        let orphan = entries.iter().find(|e| e.name == "orphan.txt").unwrap();
        assert_eq!(orphan.original_path, None);
    }

    #[test]
    fn list_trash_fails_closed_with_unconfigured_root() {
        let tmp = TempDir::new("list_trash_unconfigured");
        let allow = allow_for(&tmp);
        let empty = TrashRoot { root: PathBuf::from("") };

        let err = super::list_trash(&empty, &allow).unwrap_err();
        assert_eq!(err, "Trash is not configured".to_string());
    }

    #[test]
    fn list_trash_denied_by_empty_allowlist() {
        let tmp = TempDir::new("list_trash_empty_al");
        let trash = trash_for(&tmp);

        let err = super::list_trash(&trash, &AllowList::empty()).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
    }

    // -- permanently_delete_trash_entry ------------------------------------

    #[test]
    fn trash_delete_successful_file() {
        let tmp = TempDir::new("trash_delete_file");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "hello world");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("foo.txt"))).unwrap();

        let trashed = str_of(&tmp.child(".trash").join("foo.txt"));
        let expected = canonical_str(&tmp.child(".trash").join("foo.txt"));
        let deleted = super::permanently_delete_trash_entry(&trash, &allow, &trashed).unwrap();
        assert_eq!(deleted, expected);

        // The item AND its sidecar are gone; the trash is otherwise untouched.
        assert!(!tmp.child(".trash").join("foo.txt").exists());
        assert!(!tmp.child(".trash").join("foo.txt.trash.json").exists());
        assert!(super::list_trash(&trash, &allow).unwrap().is_empty());
    }

    #[test]
    fn trash_delete_successful_folder() {
        let tmp = TempDir::new("trash_delete_folder");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("proj").join("nested")).unwrap();
        write_file(&tmp.child("proj").join("nested").join("a.txt"), "a");
        super::trash_item(&trash, &allow, &str_of(&tmp.child("proj"))).unwrap();

        super::permanently_delete_trash_entry(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("proj")),
        )
        .unwrap();

        // The whole subtree is removed, not just the top-level folder.
        assert!(!tmp.child(".trash").join("proj").exists());
        assert!(!tmp.child(".trash").join("proj.trash.json").exists());
        assert!(super::list_trash(&trash, &allow).unwrap().is_empty());
    }

    #[test]
    fn trash_delete_rejects_trash_root_itself() {
        let tmp = TempDir::new("trash_delete_root");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err =
            super::permanently_delete_trash_entry(&trash, &allow, &str_of(&tmp.child(".trash")))
                .unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
        assert!(tmp.child(".trash").is_dir());
    }

    #[test]
    fn trash_delete_rejects_home_directory() {
        let tmp = TempDir::new("trash_delete_home");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        // The temp dir CONTAINS the trash root — an ancestor — must fail.
        let err = super::permanently_delete_trash_entry(&trash, &allow, &str_of(tmp.path()))
            .unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
    }

    #[test]
    fn trash_delete_rejects_arbitrary_allowed_file_outside_trash() {
        let tmp = TempDir::new("trash_delete_arbitrary");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        write_file(&tmp.child("plain.txt"), "data");

        let err =
            super::permanently_delete_trash_entry(&trash, &allow, &str_of(&tmp.child("plain.txt")))
                .unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
        // The allowed file was NOT deleted.
        assert!(tmp.child("plain.txt").is_file());
    }

    #[test]
    fn trash_delete_rejects_sibling_dir_beside_trash() {
        let tmp = TempDir::new("trash_delete_sibling");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child(".trash-sibling")).unwrap();
        write_file(&tmp.child(".trash-sibling").join("keep.txt"), "keep");

        let err = super::permanently_delete_trash_entry(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash-sibling")),
        )
        .unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
        assert!(tmp.child(".trash-sibling").join("keep.txt").is_file());
    }

    #[test]
    fn trash_delete_rejects_nested_descendant_inside_trash() {
        let tmp = TempDir::new("trash_delete_nested");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child(".trash").join("proj")).unwrap();
        write_file(&tmp.child(".trash").join("proj").join("inner.txt"), "inner");

        // A direct child of the trash root is the ONLY acceptable target; a
        // nested descendant of a (hypothetical) trashed folder is not.
        let err = super::permanently_delete_trash_entry(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("proj").join("inner.txt")),
        )
        .unwrap_err();
        assert_eq!(err, "Not a trash entry".to_string());
        assert!(tmp.child(".trash").join("proj").join("inner.txt").is_file());
    }

    #[test]
    fn trash_delete_with_unconfigured_root() {
        let tmp = TempDir::new("trash_delete_unconfigured");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("foo.txt"), "data");
        let empty_trash = TrashRoot::empty();

        let err = super::permanently_delete_trash_entry(
            &empty_trash,
            &allow,
            &str_of(&tmp.child("foo.txt")),
        )
        .unwrap_err();
        assert_eq!(err, "Trash is not configured".to_string());
        assert!(tmp.child("foo.txt").is_file());
    }

    #[test]
    fn trash_delete_denied_by_empty_allowlist() {
        let tmp = TempDir::new("trash_delete_empty_al");
        let trash = trash_for(&tmp);
        write_file(&tmp.child(".trash").join("orphan.txt"), "x");

        let err = super::permanently_delete_trash_entry(
            &trash,
            &AllowList::empty(),
            &str_of(&tmp.child(".trash").join("orphan.txt")),
        )
        .unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        // Fail closed: nothing was removed.
        assert!(tmp.child(".trash").join("orphan.txt").is_file());
    }

    #[test]
    fn trash_delete_missing_entry_fails_closed() {
        let tmp = TempDir::new("trash_delete_missing");
        let trash = trash_for(&tmp);
        let allow = allow_for(&tmp);

        let err = super::permanently_delete_trash_entry(
            &trash,
            &allow,
            &str_of(&tmp.child(".trash").join("ghost.txt")),
        )
        .unwrap_err();
        assert!(err.contains("Unable to delete from trash"));
    }

    // -- StarStore (starred paths) ----------------------------------------

    fn star_store_for(tmp: &TempDir) -> StarStore {
        StarStore::new(tmp.child("stars.json"))
    }

    #[test]
    fn star_store_round_trip() {
        let tmp = TempDir::new("stars_roundtrip");
        let store = star_store_for(&tmp);
        let paths = vec!["/Users/me/Desktop/a.txt".to_string(), "/Users/me/Docs/b".to_string()];

        super::save_stars(&store, &paths).unwrap();

        let loaded = super::load_stars(&store).unwrap();
        assert_eq!(loaded, paths);
    }

    #[test]
    fn star_store_missing_file_is_empty() {
        let tmp = TempDir::new("stars_missing");
        let store = star_store_for(&tmp);

        let loaded = super::load_stars(&store).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn star_store_save_atomically_replaces_previous() {
        let tmp = TempDir::new("stars_replace");
        let store = star_store_for(&tmp);
        super::save_stars(&store, &["/one".to_string()]).unwrap();
        super::save_stars(&store, &["/two".to_string(), "/three".to_string()]).unwrap();

        let loaded = super::load_stars(&store).unwrap();
        assert_eq!(loaded, vec!["/two".to_string(), "/three".to_string()]);
        // The temp file is cleaned up by the rename.
        assert!(!tmp.child("stars.json.tmp").exists());
    }

    #[test]
    fn star_store_load_drops_non_strings_and_over_limit_values() {
        let tmp = TempDir::new("stars_validate");
        let store = star_store_for(&tmp);
        let long: String = "x".repeat(super::MAX_STAR_PATH_LEN + 1);
        fs::write(
            tmp.child("stars.json"),
            format!("[\"/ok\", 42, true, {}, \"\", \"/kept\"]", serde_json::to_string(&long).unwrap()),
        )
        .unwrap();

        let loaded = super::load_stars(&store).unwrap();
        assert_eq!(loaded, vec!["/ok".to_string(), String::new(), "/kept".to_string()]);
    }

    #[test]
    fn star_store_load_caps_entry_count() {
        let tmp = TempDir::new("stars_cap");
        let store = star_store_for(&tmp);
        let many: Vec<String> = (0..(super::MAX_STARRED_PATHS + 5) as i32)
            .map(|i| format!("/path/{}", i))
            .collect();
        super::save_stars(&store, &many).unwrap_err();
        // Even so, loading collapses an over-limit file down to the cap.
        let json = serde_json::to_string(&many).unwrap();
        fs::write(tmp.child("stars.json"), json).unwrap();
        let loaded = super::load_stars(&store).unwrap();
        assert_eq!(loaded.len(), super::MAX_STARRED_PATHS);
    }

    #[test]
    fn star_store_load_rejects_corrupt_file() {
        let tmp = TempDir::new("stars_corrupt");
        let store = star_store_for(&tmp);
        fs::write(tmp.child("stars.json"), "not json at all {").unwrap();

        let err = super::load_stars(&store).unwrap_err();
        assert_eq!(err, "Star data is corrupt".to_string());
    }

    #[test]
    fn star_store_save_rejects_empty_root() {
        let store = StarStore::empty();
        assert!(super::load_stars(&store).unwrap().is_empty());
        let err = super::save_stars(&store, &["/x".to_string()]).unwrap_err();
        assert_eq!(err, "Stars are not configured".to_string());
    }

    #[test]
    fn star_store_save_rejects_too_many_paths() {
        let tmp = TempDir::new("stars_save_cap");
        let store = star_store_for(&tmp);
        let many: Vec<String> = (0..(super::MAX_STARRED_PATHS + 1) as i32)
            .map(|i| format!("/path/{}", i))
            .collect();

        let err = super::save_stars(&store, &many).unwrap_err();
        assert!(err.contains("Too many starred paths"));
    }

    #[test]
    fn star_store_save_rejects_oversized_path() {
        let tmp = TempDir::new("stars_save_long");
        let store = star_store_for(&tmp);
        let over: String = "x".repeat(super::MAX_STAR_PATH_LEN + 1);

        let err = super::save_stars(&store, &["/ok".to_string(), over]).unwrap_err();
        assert_eq!(err, "Starred path is too long".to_string());
    }

    // -- resolve_starred_paths ---------------------------------------------

    #[test]
    fn resolve_starred_paths_resolves_existing_file() {
        let tmp = TempDir::new("resolve_file");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("report.pdf"), "pdf");

        let res = super::resolve_starred_paths(&allow, &[str_of(&tmp.child("report.pdf"))]).unwrap();

        assert!(res.missing.is_empty());
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].name, "report.pdf");
        assert_eq!(
            res.items[0].path,
            str_of(&tmp.child("report.pdf").canonicalize().unwrap())
        );
        assert!(!res.items[0].is_folder);
        assert_eq!(res.items[0].file_type, "pdf");
    }

    #[test]
    fn resolve_starred_paths_resolves_existing_folder() {
        let tmp = TempDir::new("resolve_folder");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("Docs")).unwrap();
        fs::create_dir_all(tmp.child("Docs").join("sub")).unwrap();

        let res = super::resolve_starred_paths(&allow, &[str_of(&tmp.child("Docs"))]).unwrap();

        assert!(res.missing.is_empty());
        assert_eq!(res.items.len(), 1);
        assert!(res.items[0].is_folder);
        assert_eq!(res.items[0].file_type, "folder");
        assert_eq!(res.items[0].item_count, Some(1));
    }

    #[test]
    fn resolve_starred_paths_reports_missing_alongside_resolved() {
        let tmp = TempDir::new("resolve_mixed");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("present.txt"), "hi");

        let missing_path = str_of(&tmp.child("gone.txt"));
        let res = super::resolve_starred_paths(
            &allow,
            &[str_of(&tmp.child("present.txt")), missing_path.clone()],
        )
        .unwrap();

        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].name, "present.txt");
        assert_eq!(res.missing, vec![missing_path]);
    }

    #[test]
    fn resolve_starred_paths_reports_deleted_path() {
        let tmp = TempDir::new("resolve_deleted");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("temp.txt"), "x");
        let path = str_of(&tmp.child("temp.txt"));
        fs::remove_file(&path).unwrap();

        let res = super::resolve_starred_paths(&allow, &[path.clone()]).unwrap();

        assert!(res.items.is_empty());
        assert_eq!(res.missing, vec![path]);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_starred_paths_skips_symlinks() {
        let tmp = TempDir::new("resolve_symlink");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("real.txt"), "hi");
        std::os::unix::fs::symlink(tmp.child("real.txt"), tmp.child("alias")).unwrap();
        let alias = str_of(&tmp.child("alias"));

        let res = super::resolve_starred_paths(&allow, &[alias.clone()]).unwrap();

        assert!(res.items.is_empty());
        assert_eq!(res.missing, vec![alias]);
    }

    #[test]
    fn resolve_starred_paths_reports_outside_allowlist() {
        let tmp = TempDir::new("resolve_outside");
        let outside = TempDir::new("resolve_outside_root");
        let allow = allow_for(&tmp);
        write_file(&outside.child("secret.txt"), "s");
        let secret = str_of(&outside.child("secret.txt"));

        let res = super::resolve_starred_paths(&allow, &[secret.clone()]).unwrap();

        assert!(res.items.is_empty());
        assert_eq!(res.missing, vec![secret]);
    }

    #[test]
    fn resolve_starred_paths_empty_input() {
        let tmp = TempDir::new("resolve_empty");
        let allow = allow_for(&tmp);

        let res = super::resolve_starred_paths(&allow, &[]).unwrap();

        assert!(res.items.is_empty());
        assert!(res.missing.is_empty());
    }

    #[test]
    fn resolve_starred_paths_empty_allowlist_fails_closed() {
        let tmp = TempDir::new("resolve_no_allow");
        write_file(&tmp.child("real.txt"), "hi");
        let real = str_of(&tmp.child("real.txt"));

        let res = super::resolve_starred_paths(&AllowList::empty(), &[real.clone()]).unwrap();

        assert!(res.items.is_empty());
        assert_eq!(res.missing, vec![real]);
    }

    // -- duplicate_item ---------------------------------------------------

    #[test]
    fn duplicate_a_file() {
        let tmp = TempDir::new("dup_file");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("note.txt"), "hello");

        let new_path = super::duplicate_item(&allow, &str_of(&tmp.child("note.txt"))).unwrap();
        assert!(new_path.ends_with("note (copy).txt"));
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "hello");
        assert_eq!(fs::read_to_string(&tmp.child("note.txt")).unwrap(), "hello");
    }

    #[test]
    fn duplicate_a_directory() {
        let tmp = TempDir::new("dup_dir");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("docs").join("sub")).unwrap();
        write_file(&tmp.child("docs").join("readme.md"), "# hi");

        let new_path = super::duplicate_item(&allow, &str_of(&tmp.child("docs"))).unwrap();
        assert!(new_path.ends_with("docs (copy)"));
        assert!(Path::new(&new_path).join("sub").is_dir());
        assert_eq!(
            fs::read_to_string(Path::new(&new_path).join("readme.md")).unwrap(),
            "# hi"
        );
    }

    #[test]
    fn duplicate_collision_safe_naming() {
        let tmp = TempDir::new("dup_collision");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("a.txt"), "1");
        write_file(&tmp.child("a (copy).txt"), "2");
        write_file(&tmp.child("a (copy 2).txt"), "3");

        let new_path = super::duplicate_item(&allow, &str_of(&tmp.child("a.txt"))).unwrap();
        assert_eq!(new_path, canonical_str(&tmp.child("a (copy 3).txt")));
    }

    #[test]
    fn duplicate_duplicate_name_avoids_existing() {
        let tmp = TempDir::new("dup_avoids");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("x.txt"), "orig");
        write_file(&tmp.child("x (copy).txt"), "existing");

        let new_path = super::duplicate_item(&allow, &str_of(&tmp.child("x.txt"))).unwrap();
        assert_eq!(new_path, canonical_str(&tmp.child("x (copy 2).txt")));
        // Original must not be overwritten.
        assert_eq!(
            fs::read_to_string(&tmp.child("x (copy).txt")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn duplicate_collision_limit_returns_error_instead_of_panicking() {
        let tmp = TempDir::new("dup_limit");
        // Occupy the bare " (copy)" name plus every " (copy n)" slot up to the
        // tiny test limit, so name allocation cannot yield a free candidate.
        let parent = tmp.path();
        fs::write(parent.join("a.txt"), "orig").unwrap();
        fs::write(parent.join("a (copy).txt"), "1").unwrap();
        fs::write(parent.join("a (copy 2).txt"), "2").unwrap();
        fs::write(parent.join("a (copy 3).txt"), "3").unwrap();

        // With just three collisions allowed, slot 3 is the last candidate —
        // exhaustion must degrade to an Err, never a panic.
        let result = super::unique_duplicate_name(parent, "a.txt", 3);
        assert_eq!(result.unwrap_err(), "Unable to allocate a unique duplicate name");
    }

    // -- duplicate-candidate scan (size bucketing) --------------------------

    fn dup_scan_trash(tmp: &TempDir) -> TrashRoot {
        TrashRoot { root: tmp.path().join(TRASH_DIR_NAME) }
    }

    #[test]
    fn dup_scan_groups_same_size_files() {
        let tmp = TempDir::new("dup_scan_same");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("a.txt"), "hello!!!!!");
        write_file(&tmp.child("b.txt"), "hello!!!!!");
        write_file(&tmp.child("c.txt"), "different length here");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.groups.len(), 1);
        let group = &result.groups[0];
        assert_eq!(group.size_bytes, 10);
        assert_eq!(group.items.len(), 2);
    }

    #[test]
    fn dup_scan_ignores_files_with_different_sizes() {
        let tmp = TempDir::new("dup_scan_diff");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("x.txt"), "1");
        write_file(&tmp.child("y.txt"), "22");
        write_file(&tmp.child("z.txt"), "333");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(result.groups.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn dup_scan_zero_byte_files_can_form_a_group() {
        let tmp = TempDir::new("dup_scan_zero");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("z1.txt"), "");
        write_file(&tmp.child("z2.txt"), "");
        write_file(&tmp.child("z3.bin"), "");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].size_bytes, 0);
        assert_eq!(result.groups[0].items.len(), 3);
    }

    #[test]
    fn dup_scan_singletons_are_omitted() {
        let tmp = TempDir::new("dup_scan_single");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("solo.txt"), "unique content here");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(result.groups.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn dup_scan_traversal_budget_is_honored() {
        let tmp = TempDir::new("dup_scan_trav");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("p1.txt"), "same sized!");
        write_file(&tmp.child("p2.txt"), "same sized!");

        // Visiting a single entry busts a traversal budget of one, so only the
        // first file is seen — its size-twin is never discovered and the scan
        // honestly reports truncation.
        let result = super::find_duplicate_groups(&allow, &trash, 1, 100).unwrap();
        assert!(result.truncated);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn dup_scan_group_budget_is_shared_across_roots() {
        let tmp1 = TempDir::new("dup_scan_budget_r1");
        let tmp2 = TempDir::new("dup_scan_budget_r2");
        let mut allow = AllowList::with_root(&str_of(tmp1.path())).unwrap();
        allow.register_root(&str_of(tmp2.path())).unwrap();
        let trash = dup_scan_trash(&tmp1);
        write_file(&tmp1.child("l1.txt"), "01234567890123456789");
        write_file(&tmp1.child("l2.txt"), "01234567890123456789");
        write_file(&tmp2.child("m1.txt"), "abcdefghij");
        write_file(&tmp2.child("m2.txt"), "abcdefghij");

        // Only one group fits the budget; the larger 20 B pair wins the sort,
        // the 10 B pair from the second root is dropped — globally.
        let result = super::find_duplicate_groups(&allow, &trash, 100, 1).unwrap();
        assert!(result.truncated);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].size_bytes, 20);
        assert_eq!(result.groups[0].items.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn dup_scan_symlinks_are_not_followed() {
        let tmp = TempDir::new("dup_scan_sym");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("real.txt"), "same size!!");
        // A symlink whose target shares the real file's size must be skipped:
        // the walker never follows it, so real.txt stays a singleton.
        std::os::unix::fs::symlink(&tmp.child("real.txt"), &tmp.child("link.txt")).unwrap();

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(result.groups.is_empty());
    }

    #[test]
    fn dup_scan_excludes_trash_subtree() {
        let tmp = TempDir::new("dup_scan_trash");
        let allow = allow_for(&tmp);
        let trash_root = tmp.path().join(TRASH_DIR_NAME);
        let trash = TrashRoot { root: trash_root.clone() };
        write_file(&tmp.child("real.txt"), "same thing!");
        write_file(&tmp.child("real (copy).txt"), "same thing!");
        // A trashed same-size copy must never become a candidate.
        fs::create_dir_all(&trash_root).unwrap();
        write_file(&trash_root.join("trashed copy.txt"), "same thing!");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert_eq!(result.groups.len(), 1);
        let group = &result.groups[0];
        assert_eq!(group.items.len(), 2);
        for item in &group.items {
            assert!(!item.path.contains(TRASH_DIR_NAME));
        }
    }

    #[test]
    fn dup_scan_allowlist_boundaries_enforced() {
        let root = TempDir::new("dup_scan_al_r");
        let outside = TempDir::new("dup_scan_al_o");
        let allow = allow_for(&root);
        let trash = dup_scan_trash(&root);
        write_file(&root.child("in1.txt"), "boundary!");
        write_file(&root.child("in2.txt"), "boundary!");
        // Identical-size matches OUTSIDE the allowed root never surface.
        write_file(&outside.child("out1.txt"), "boundary!");
        write_file(&outside.child("out2.txt"), "boundary!");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert_eq!(result.groups.len(), 1);
        let group = &result.groups[0];
        assert_eq!(group.items.len(), 2);
        for item in &group.items {
            assert!(Path::new(&item.path).starts_with(&allow.roots()[0]));
        }
    }

    #[test]
    fn dup_scan_deterministic_ordering() {
        let tmp = TempDir::new("dup_scan_order");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        fs::create_dir_all(tmp.child("big")).unwrap();
        fs::create_dir_all(tmp.child("tinysmall")).unwrap();
        fs::create_dir_all(tmp.child("zz").join("aaa")).unwrap();
        write_file(&tmp.child("big").join("data.txt"), "01234567890123456789");
        write_file(&tmp.child("tinysmall").join("data.txt"), "01234567890123456789");
        write_file(&tmp.child("b1.txt"), "0123456789");
        write_file(&tmp.child("zz").join("aaa").join("s.txt"), "0123456789");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.groups.len(), 2);
        // Groups: largest shared size first.
        assert_eq!(result.groups[0].size_bytes, 20);
        assert_eq!(result.groups[1].size_bytes, 10);
        // Members within each group sorted by path.
        assert_eq!(result.groups[0].items.len(), 2);
        assert!(result.groups[0].items[0].path < result.groups[0].items[1].path);
        assert_eq!(result.groups[1].items.len(), 2);
        assert!(result.groups[1].items[0].path < result.groups[1].items[1].path);
    }

    // -- duplicate content verification (streamed SHA-256) -------------------

    #[test]
    fn dup_scan_identical_contents_form_a_verified_group() {
        let tmp = TempDir::new("dup_scan_verify_ok");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("one.txt"), "exact bytes!!");
        write_file(&tmp.child("two.txt"), "exact bytes!!");
        // Same size as the pair, but different content: must NOT join them.
        write_file(&tmp.child("three.txt"), "exact bytes!?");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].size_bytes, 13);
        assert_eq!(result.groups[0].items.len(), 2);
    }

    #[test]
    fn dup_scan_same_size_but_different_contents_are_not_duplicates() {
        let tmp = TempDir::new("dup_scan_verify_mismatch");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("left.txt"), "abcdefghij");
        write_file(&tmp.child("right.txt"), "klmnopqrst");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(!result.truncated);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn dup_scan_identical_content_different_sizes_are_not_grouped() {
        let tmp = TempDir::new("dup_scan_verify_sizes");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        // Same content, different sizes: hashing is only ever reached for files
        // already matched by exact byte size, so these never group.
        write_file(&tmp.child("short.txt"), "abc");
        write_file(&tmp.child("long.txt"), "abcabc");

        let result = super::find_duplicate_groups(&allow, &trash, 100, 100).unwrap();
        assert!(!result.truncated);
        assert!(result.groups.is_empty());
    }

    #[test]
    fn dup_scan_hash_budget_truncation_keeps_verified_prefix() {
        let tmp = TempDir::new("dup_scan_hash_budget");
        let allow = allow_for(&tmp);
        let trash = dup_scan_trash(&tmp);
        write_file(&tmp.child("big1.txt"), "aaaaaaaaaa");
        write_file(&tmp.child("big2.txt"), "aaaaaaaaaa");
        write_file(&tmp.child("small1.txt"), "bbbb");
        write_file(&tmp.child("small2.txt"), "bbbb");

        // The 21-byte hash budget covers the 10 B bucket (2 x 10) but not the
        // 4 B bucket: the big pair verifies, the small pair is never hashed
        // (dropped), and truncation is reported honestly.
        let result =
            super::find_duplicate_groups_budgeted(&allow, &trash, 100, 100, 21).unwrap();
        assert!(result.truncated);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].size_bytes, 10);
        assert_eq!(result.groups[0].items.len(), 2);
    }

    #[test]
    fn duplicate_source_outside_allowlist() {
        let tmp = TempDir::new("dup_outside");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("secret.txt"), "data");

        let outside = std::env::temp_dir().join("sfm_outside_dup.txt");
        fs::write(&outside, "outside").unwrap();
        let err = super::duplicate_item(&allow, &outside.to_string_lossy()).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn duplicate_missing_source() {
        let tmp = TempDir::new("dup_missing");
        let allow = allow_for(&tmp);

        let err = super::duplicate_item(&allow, &str_of(&tmp.child("nope.txt"))).unwrap_err();
        assert!(err.contains("no longer exists"), "got: {}", err);
    }

    #[test]
    fn duplicate_symlink_outside_allowlist() {
        let tmp = TempDir::new("dup_symlink");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("real.txt"), "data");

        // Symlink inside the allowlist pointing outside.
        std::os::unix::fs::symlink(
            std::env::temp_dir().join("sfm_symlink_target.txt"),
            tmp.child("link.txt"),
        )
        .unwrap();
        fs::write(
            std::env::temp_dir().join("sfm_symlink_target.txt"),
            "outside",
        )
        .unwrap();

        let err = super::duplicate_item(&allow, &str_of(&tmp.child("link.txt"))).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        let _ = fs::remove_file(std::env::temp_dir().join("sfm_symlink_target.txt"));
    }

    #[test]
    fn duplicate_returns_canonical_path() {
        let tmp = TempDir::new("dup_canon");
        let allow = allow_for(&tmp);
        write_file(&tmp.child("f.txt"), "data");

        let new_path = super::duplicate_item(&allow, &str_of(&tmp.child("f.txt"))).unwrap();
        let canonical = Path::new(&new_path)
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(new_path, canonical);
        assert!(Path::new(&new_path).is_file());
    }

    // -- create_file --------------------------------------------------------

    #[test]
    fn create_file_successful() {
        let tmp = TempDir::new("create_file_ok");
        let allow = allow_for(&tmp);
        let target = tmp.child("new_doc.txt");

        let canonical = super::create_file(&allow, &str_of(&target)).unwrap();
        assert!(target.is_file());
        assert_eq!(fs::read(&target).unwrap(), b"");
        assert_eq!(canonical, target.canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn create_file_nested_path() {
        let tmp = TempDir::new("create_file_nested");
        let allow = allow_for(&tmp);
        fs::create_dir_all(tmp.child("sub").join("nested")).unwrap();
        let target = tmp.child("sub").join("nested").join("deep.txt");

        let canonical = super::create_file(&allow, &str_of(&target)).unwrap();
        assert!(target.is_file());
        assert_eq!(canonical, target.canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn create_file_invalid_name() {
        let tmp = TempDir::new("create_file_inv_name");
        let allow = allow_for(&tmp);

        // Name with a separator inside the final component is rejected by
        // the name validator before any filesystem call.
        let err = super::create_file(&allow, &str_of(&tmp.child("a/b.txt"))).unwrap_err();
        assert!(
            err.contains("separators")
                || err.contains("Invalid")
                || err.contains("folder")
                || err.contains("not a folder"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn create_file_existing_file() {
        let tmp = TempDir::new("create_file_exists");
        let allow = allow_for(&tmp);
        let target = tmp.child("exists.txt");
        write_file(&target, "already here");

        let err = super::create_file(&allow, &str_of(&target)).unwrap_err();
        assert!(err.contains("already exists"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "already here");
    }

    #[test]
    fn create_file_existing_directory() {
        let tmp = TempDir::new("create_file_dir_exists");
        let allow = allow_for(&tmp);
        let target = tmp.child("some_folder");
        fs::create_dir_all(&target).unwrap();

        let err = super::create_file(&allow, &str_of(&target)).unwrap_err();
        assert!(err.contains("already exists"));
        assert!(target.is_dir());
    }

    #[test]
    fn create_file_outside_allowlist() {
        let tmp = TempDir::new("create_file_inside");
        let outside = TempDir::new("create_file_outside");
        let allow = allow_for(&tmp);
        let target = outside.child("unauth.txt");

        let err = super::create_file(&allow, &str_of(&target)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!target.exists());
    }

    #[test]
    fn create_file_empty_allowlist() {
        let tmp = TempDir::new("create_file_empty_al");
        let allow = AllowList::empty();
        let target = tmp.child("fail.txt");

        let err = super::create_file(&allow, &str_of(&target)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!target.exists());
    }

    #[test]
    fn create_file_traversal() {
        let tmp = TempDir::new("create_file_traversal");
        let outside = TempDir::new("create_file_trav_out");
        let allow = allow_for(&tmp);

        // Attempting to escape via `..` from inside the allowed root to outside
        let escape = tmp
            .path()
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("escape.txt");
        let err = super::create_file(&allow, &str_of(&escape)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!escape.exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_file_symlinked_parent_inside_and_outside() {
        let root = TempDir::new("create_file_sym_root");
        let outside = TempDir::new("create_file_sym_out");
        let allow = allow_for(&root);

        // 1. Symlinked parent pointing INSIDE allowed root -> allowed
        fs::create_dir_all(root.child("real_dir")).unwrap();
        std::os::unix::fs::symlink(root.child("real_dir"), root.child("link_inside")).unwrap();
        let inside_target = root.child("link_inside").join("test_inside.txt");
        let canonical = super::create_file(&allow, &str_of(&inside_target)).unwrap();
        assert!(inside_target.is_file());
        assert_eq!(
            canonical,
            root.child("real_dir")
                .join("test_inside.txt")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );

        // 2. Symlinked parent pointing OUTSIDE allowed root -> denied
        std::os::unix::fs::symlink(outside.path(), root.child("link_outside")).unwrap();
        let outside_target = root.child("link_outside").join("test_outside.txt");
        let err = super::create_file(&allow, &str_of(&outside_target)).unwrap_err();
        assert_eq!(err, SECURITY_POLICY_ERROR.to_string());
        assert!(!outside.child("test_outside.txt").exists());
    }

    #[test]
    fn create_file_returns_canonical_path() {
        let tmp = TempDir::new("create_file_canon");
        let allow = allow_for(&tmp);
        let target = tmp.child("canon_test.txt");

        let ret = super::create_file(&allow, &str_of(&target)).unwrap();
        let expected = target.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(ret, expected);
        assert!(Path::new(&ret).is_file());
    }
}
