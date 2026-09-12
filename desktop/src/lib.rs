//! Tauri command boundary for the desktop filesystem.
//!
//! This module is intentionally thin: it only declares the `#[tauri::command]`
//! entry points the frontend invokes over IPC and delegates every filesystem
//! operation to [`fs_service`]. All path handling, validation, and domain
//! logic lives in the service layer so it can be unit-tested without a running
//! Tauri runtime. The serialized shapes (`FileEntry`, `DirectoryListing`,
//! `DiskUsage`) and their camelCase JSON contracts are defined in `fs_service`
//! and are unchanged from the previous inline implementation.

mod fs_service;

use tauri::Manager;

/// Return the user's home directory.
#[tauri::command]
fn home_directory() -> Result<String, String> {
    fs_service::home_directory()
}

/// Read the contents of a directory and return structured entries.
///
/// If `path` is empty/None the user's home directory is listed instead.
/// Symbolic links are skipped and only the requested directory is read — we
/// never recurse into subdirectories.
#[tauri::command]
fn list_directory(
    path: Option<String>,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::DirectoryListing, String> {
    fs_service::list_directory(allow_list.inner(), path)
}

/// Create a new folder inside `dir` named `name`.
#[tauri::command]
fn create_folder(
    dir: String,
    name: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::create_folder(allow_list.inner(), &dir, &name)
}

/// Rename a file or folder in place (only the name changes, not location).
#[tauri::command]
fn rename_item(
    from: String,
    new_name: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::rename_item(allow_list.inner(), &from, &new_name)
}

/// Move an item into another directory, keeping its current file name.
#[tauri::command]
fn move_item(
    source: String,
    dest_dir: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::move_item(allow_list.inner(), &source, &dest_dir)
}

/// Move a file to an exact destination path (optionally renaming it).
#[tauri::command]
fn move_file(
    source: String,
    destination: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::move_file(allow_list.inner(), &source, &destination)
}

/// Delete a file or folder. The UI must confirm before calling this.
#[tauri::command]
fn delete_item(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::delete_item(allow_list.inner(), &path)
}

/// Open a file/folder with the operating system's default application.
#[tauri::command]
fn open_item(path: String, allow_list: tauri::State<fs_service::AllowList>) -> Result<(), String> {
    fs_service::open_item(allow_list.inner(), &path)
}

/// Read metadata for a file or directory without touching its contents.
#[tauri::command]
fn get_file_metadata(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::FileMetadata, String> {
    fs_service::get_file_metadata(allow_list.inner(), &path)
}

/// Copy a file/folder into a destination directory, keeping its name.
#[tauri::command]
fn copy_item(
    source: String,
    dest_dir: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::copy_item(allow_list.inner(), &source, &dest_dir)
}

/// Read the raw bytes of a file (text, image, binary).
#[tauri::command]
fn read_file(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<Vec<u8>, String> {
    fs_service::read_file(allow_list.inner(), &path)
}

/// Write raw bytes to a file, creating it or overwriting an existing file.
#[tauri::command]
fn write_file(
    path: String,
    content: Vec<u8>,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<(), String> {
    fs_service::write_file(allow_list.inner(), &path, &content)
}

/// Real capacity information for the volume containing `path` (defaults to
/// the user's home directory). Reads filesystem statistics only via
/// statfs/statvfs; it performs no directory scanning or recursive traversal.
#[tauri::command]
fn disk_usage(
    path: Option<String>,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::DiskUsage, String> {
    fs_service::disk_usage(allow_list.inner(), path)
}

/// Recursively search for files and directories by name across all allowed
/// roots. Returns both files and directories whose names contain the
/// (case-insensitive) query substring. The search is bounded: it stops after
/// [`fs_service::SEARCH_MAX_VISITED_ENTRIES`] visited entries and returns at
/// most [`fs_service::SEARCH_MAX_RESULTS`] results, reporting `truncated`.
#[tauri::command]
fn search_files(
    query: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::SearchFilesResult, String> {
    fs_service::search_files(
        allow_list.inner(),
        &query,
        fs_service::SEARCH_MAX_VISITED_ENTRIES,
        fs_service::SEARCH_MAX_RESULTS,
    )
}

/// Return the most recently modified files and directories across all allowed
/// roots, newest first. The result is hard-capped at `limit` (default
/// [`fs_service::RECENT_FILES_DEFAULT_LIMIT`]) — never the whole tree.
#[tauri::command]
fn recent_files(
    limit: Option<usize>,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<Vec<fs_service::FileEntry>, String> {
    fs_service::recent_files(
        allow_list.inner(),
        limit.unwrap_or(fs_service::RECENT_FILES_DEFAULT_LIMIT),
    )
}

/// Scan the allowed roots once and aggregate REAL file sizes by extension-
/// derived category (Documents, Images, Videos, Audio, Archives, Code, Other).
/// The scan is hard-capped at [`fs_service::STORAGE_SCAN_MAX_FILES`] files.
#[tauri::command]
fn storage_by_category(
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::StorageBreakdown, String> {
    fs_service::storage_by_category(allow_list.inner(), fs_service::STORAGE_SCAN_MAX_FILES)
}

/// Move an authorized file or folder into the application-managed trash.
#[tauri::command]
fn trash_item(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
    trash: tauri::State<fs_service::TrashRoot>,
) -> Result<(), String> {
    fs_service::trash_item(trash.inner(), allow_list.inner(), &path)
}

/// Restore a genuine trash entry to its recorded original location.
#[tauri::command]
fn restore_item(
    trashed_path: String,
    allow_list: tauri::State<fs_service::AllowList>,
    trash: tauri::State<fs_service::TrashRoot>,
) -> Result<String, String> {
    fs_service::restore_item(trash.inner(), allow_list.inner(), &trashed_path)
}

/// List the current contents of the application-managed trash.
#[tauri::command]
fn list_trash(
    allow_list: tauri::State<fs_service::AllowList>,
    trash: tauri::State<fs_service::TrashRoot>,
) -> Result<Vec<fs_service::TrashEntry>, String> {
    fs_service::list_trash(trash.inner(), allow_list.inner())
}

/// Permanently delete a single genuine trash entry (item and its sidecar).
#[tauri::command]
fn permanently_delete_trash_item(
    trashed_path: String,
    allow_list: tauri::State<fs_service::AllowList>,
    trash: tauri::State<fs_service::TrashRoot>,
) -> Result<String, String> {
    fs_service::permanently_delete_trash_entry(trash.inner(), allow_list.inner(), &trashed_path)
}

/// Load the user's starred absolute paths from the app-local star store.
#[tauri::command]
fn load_starred_paths(store: tauri::State<fs_service::StarStore>) -> Result<Vec<String>, String> {
    fs_service::load_stars(store.inner())
}

/// Persist the user's starred absolute paths to the app-local star store.
#[tauri::command]
fn save_starred_paths(
    paths: Vec<String>,
    store: tauri::State<fs_service::StarStore>,
) -> Result<(), String> {
    fs_service::save_stars(store.inner(), &paths)
}

/// Resolve persisted starred paths against the real filesystem, reporting
/// missing/deleted/moved/invalid/outside-allowlist paths honestly.
#[tauri::command]
fn resolve_starred_paths(
    paths: Vec<String>,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<fs_service::StarredResolution, String> {
    fs_service::resolve_starred_paths(allow_list.inner(), &paths)
}

/// Duplicate a file or folder into the same parent directory with a
/// collision-safe name.
#[tauri::command]
fn duplicate_item(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<String, String> {
    fs_service::duplicate_item(allow_list.inner(), &path)
}

/// Create an empty regular file within the AllowList boundary.
#[tauri::command]
fn create_file(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<String, String> {
    fs_service::create_file(allow_list.inner(), &path)
}

/// Scan every allowed root for file CANDIDATES that share the exact same byte
/// size. The scan is hard-capped at
/// [`fs_service::DUPLICATE_SCAN_MAX_VISITED_ENTRIES`] visited entries and
/// returns at most [`fs_service::DUPLICATE_SCAN_MAX_GROUPS`] candidate groups,
/// reporting `truncated`. This is size-bucketing ONLY — contents are not
/// hashed, so group members are candidates, never confirmed duplicates. The
/// application-managed trash subtree is excluded from the scan.
#[tauri::command]
fn duplicate_groups(
    allow_list: tauri::State<fs_service::AllowList>,
    trash: tauri::State<fs_service::TrashRoot>,
) -> Result<fs_service::DuplicateGroupsResult, String> {
    fs_service::find_duplicate_groups(
        allow_list.inner(),
        trash.inner(),
        fs_service::DUPLICATE_SCAN_MAX_VISITED_ENTRIES,
        fs_service::DUPLICATE_SCAN_MAX_GROUPS,
    )
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
            // Root-scoped security boundary: initialize the AllowList once from
            // the canonicalized user home directory (fail-closed on any error)
            // and expose it to commands via Tauri managed state.
            app.manage(fs_service::AllowList::with_default_root());
            // The application-managed trash directory is computed once here and
            // exposed as configuration state (not an authorization mechanism).
            // If it cannot be created, an empty-root tombstone is managed so
            // every trash/restore operation is denied (fail closed).
            let trash_root = fs_service::make_canonical_trash_root();
            let trash = match trash_root {
                None => fs_service::TrashRoot::empty(),
                Some(t) => t,
            };
            app.manage(trash);
            // The user's starred paths persist to a `stars.json` file in the
            // Tauri app-local data directory behind an in-memory managed store.
            // If the data directory cannot be resolved, an empty tombstone is
            // managed so every star load/save is denied (fail closed).
            let star_store = app
                .path()
                .app_local_data_dir()
                .ok()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    fs_service::StarStore::new(dir.join(fs_service::STARS_FILE_NAME))
                })
                .unwrap_or_else(fs_service::StarStore::empty);
            app.manage(star_store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            home_directory,
            list_directory,
            create_folder,
            rename_item,
            move_item,
            move_file,
            delete_item,
            open_item,
            disk_usage,
            get_file_metadata,
            copy_item,
            read_file,
            write_file,
            search_files,
            recent_files,
            storage_by_category,
            trash_item,
            restore_item,
            list_trash,
            permanently_delete_trash_item,
            load_starred_paths,
            save_starred_paths,
            resolve_starred_paths,
            duplicate_item,
            create_file,
            duplicate_groups,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
