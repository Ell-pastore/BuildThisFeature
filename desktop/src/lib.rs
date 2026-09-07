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
/// (case-insensitive) query substring.
#[tauri::command]
fn search_files(
    query: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<Vec<fs_service::FileEntry>, String> {
    fs_service::search_files(allow_list.inner(), &query)
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

/// Duplicate a file or folder into the same parent directory with a
/// collision-safe name.
#[tauri::command]
fn duplicate_item(
    path: String,
    allow_list: tauri::State<fs_service::AllowList>,
) -> Result<String, String> {
    fs_service::duplicate_item(allow_list.inner(), &path)
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
            get_file_metadata,
            copy_item,
            read_file,
            write_file,
            search_files,
            trash_item,
            restore_item,
            duplicate_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
