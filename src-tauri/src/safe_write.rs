//! Crash-safe file writes shared by the rotation, the editor and the settings.
//!
//! Every write goes to a fresh, uniquely named hidden file next to its destination,
//! created exclusively (an existing file or link with that name is never opened, let
//! alone truncated), flushed to the disk, then renamed over the destination. A crash or
//! power cut leaves either the old file or the new one, never a half-written picture.

use crate::error::{AppError, AppResult, ErrorCode};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Marker in the names of the files staged by "replace the original" (see `edit.rs`).
pub const EDIT_TAG: &str = "chud-edit";

fn folder_of(dest: &Path) -> &Path {
    dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))
}

/// Creates a new hidden file beside `dest`, named `.<name>.<tag>-<pid>-<n>`. The name is
/// unique within this process and the file is created exclusively, so two saves running
/// at the same time, or a file planted under the expected name, cannot collide.
pub fn create_beside(dest: &Path, tag: &str) -> AppResult<(PathBuf, File)> {
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = folder_of(dest);
    let pid = std::process::id();
    for _ in 0..64 {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(".{name}.{tag}-{pid}-{n}"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::new(ErrorCode::Io, "could not create a temporary file"))
}

/// Writes `bytes` to a new file beside `dest` and flushes it to the disk.
pub fn stage(dest: &Path, bytes: &[u8], tag: &str) -> AppResult<PathBuf> {
    let (path, mut file) = create_beside(dest, tag)?;
    let written = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        keep_permissions(dest, &file)?;
        file.sync_all()
    })();
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(path)
}

/// On Unix a new file gets default permissions; keep those of the file it replaces.
#[cfg(unix)]
fn keep_permissions(dest: &Path, file: &File) -> io::Result<()> {
    match fs::metadata(dest) {
        Ok(meta) => file.set_permissions(meta.permissions()),
        Err(_) => Ok(()),
    }
}

#[cfg(not(unix))]
fn keep_permissions(_dest: &Path, _file: &File) -> io::Result<()> {
    Ok(())
}

/// Makes a rename durable (Unix needs the folder itself flushed; NTFS journals it).
pub fn sync_folder(dest: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(folder_of(dest)) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dest;
}

/// Replaces (or creates) `dest` with `bytes` atomically.
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Ok(meta) = fs::metadata(dest) {
        if meta.permissions().readonly() {
            return Err(AppError::new(ErrorCode::PermissionDenied, "file is read-only"));
        }
    }
    let tmp = stage(dest, bytes, "chud-tmp")?;
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    sync_folder(dest);
    Ok(())
}

/// The file a staged edit was meant to become, from its name: the current
/// `.<name>.chud-edit-<pid>-<n>` and the `.<stem>.chud-edit-<pid>.<ext>` of version 1.2.
pub fn edit_target_name(staged: &str) -> Option<String> {
    let rest = staged.strip_prefix('.')?;
    let at = rest.rfind(&format!(".{EDIT_TAG}-"))?;
    let (base, suffix) = (&rest[..at], &rest[at + EDIT_TAG.len() + 2..]);
    if base.is_empty() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((pid, n)) = suffix.split_once('-') {
        return (digits(pid) && digits(n)).then(|| base.to_string());
    }
    // 1.2: ".<stem>.chud-edit-<pid>.<ext>"
    let (pid, ext) = suffix.split_once('.')?;
    (digits(pid) && !ext.is_empty() && !ext.contains(['/', '\\'])).then(|| format!("{base}.{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn temporary_names_never_collide() {
        // Before 1.3 the name only carried the process id: two saves of the same file
        // shared one temporary file and could publish each other's half-written bytes.
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.jpg");
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for _ in 0..50 {
            let (p, f) = create_beside(&dest, EDIT_TAG).unwrap();
            assert!(seen.insert(p.clone()), "duplicate temporary name {}", p.display());
            files.push(f);
        }
    }

    #[test]
    fn concurrent_writes_each_publish_a_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("settings.json");
        let threads: Vec<_> = (0..8u8)
            .map(|i| {
                let dest = dest.clone();
                std::thread::spawn(move || {
                    for _ in 0..20 {
                        atomic_write(&dest, &vec![i; 64 * 1024]).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let bytes = fs::read(&dest).unwrap();
        assert_eq!(bytes.len(), 64 * 1024);
        assert!(bytes.iter().all(|&b| b == bytes[0]), "bytes from two writers were mixed");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "temporary files left behind");
    }

    #[test]
    fn an_existing_file_with_the_temporary_name_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.png");
        let n = COUNTER.load(Ordering::Relaxed);
        // Plant files under the next few names the counter could produce.
        for k in n..n + 8 {
            fs::write(dir.path().join(format!(".a.png.{EDIT_TAG}-{}-{k}", std::process::id())), b"planted").unwrap();
        }
        let staged = stage(&dest, b"mine", EDIT_TAG).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"mine");
        for k in n..n + 8 {
            let planted = dir.path().join(format!(".a.png.{EDIT_TAG}-{}-{k}", std::process::id()));
            if planted != staged {
                assert_eq!(fs::read(&planted).unwrap(), b"planted");
            }
        }
    }

    #[test]
    fn read_only_destinations_are_refused_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ro.png");
        fs::write(&path, b"old").unwrap();
        let mut perm = fs::metadata(&path).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&path, perm.clone()).unwrap();
        assert_eq!(atomic_write(&path, b"new").unwrap_err().code, ErrorCode::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&path, perm).unwrap();
    }

    #[test]
    fn staged_edit_names_point_back_to_their_picture() {
        assert_eq!(edit_target_name(".photo.jpg.chud-edit-123-4").as_deref(), Some("photo.jpg"));
        assert_eq!(edit_target_name(".my.holiday.png.chud-edit-9-0").as_deref(), Some("my.holiday.png"));
        assert_eq!(edit_target_name(".photo.chud-edit-123.jpg").as_deref(), Some("photo.jpg"));
        for other in ["photo.jpg", ".photo.jpg", ".photo.jpg.chud-tmp-1-2", ".photo.jpg.chud-edit-x-2", "..chud-edit-1-2", ".a.chud-edit-1."] {
            assert_eq!(edit_target_name(other), None, "{other}");
        }
    }
}
