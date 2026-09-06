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
}
