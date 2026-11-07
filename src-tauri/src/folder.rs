//! Folder scanning and natural ("Explorer-like") filename ordering.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::formats;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub folder: String,
    pub files: Vec<String>,
    /// Position of the requested file inside `files` (0 when a folder was opened).
    pub index: usize,
}

/// Compares two file names the way people expect: case-insensitive, with runs of digits
/// compared by numeric value ("img2" < "img10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let na = take_digits(&mut ai);
                let nb = take_digits(&mut bi);
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta
                    .len()
                    .cmp(&tb.len())
                    .then_with(|| ta.cmp(tb))
                    // "01" after "1" so that equal values still have a stable order.
                    .then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let ord = ca.to_lowercase().cmp(cb.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
    // Identical ignoring case: fall back to a byte comparison for a total order.
    a.cmp(b)
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek().copied() {
        if c.is_ascii_digit() {
            s.push(c);
            it.next();
        } else {
            break;
        }
    }
    s
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Lists the supported images directly inside `dir` (no recursion), naturally sorted.
pub fn list_images(dir: &Path) -> AppResult<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|t| t.is_file() || t.is_symlink()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|p| !file_name(p).starts_with('.') && p.is_file() && formats::is_supported(p))
        .collect();
    files.sort_by(|a, b| natural_cmp(&file_name(a), &file_name(b)));
    Ok(files)
}

/// Opens either an image (its folder is listed and the image selected) or a folder.
pub fn open_target(target: &Path) -> AppResult<FolderListing> {
    if !target.exists() {
        return Err(AppError::new(ErrorCode::NotFound, target.display().to_string()));
    }
    if target.is_dir() {
        let files = list_images(target)?;
        return Ok(FolderListing {
            folder: target.display().to_string(),
            files: files.iter().map(|p| p.display().to_string()).collect(),
            index: 0,
        });
    }
    let folder = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let mut files = list_images(&folder).unwrap_or_default();
    let index = match files.iter().position(|p| same_file(p, target)) {
        Some(i) => i,
        None => {
            // An explicitly opened file is always shown, even with an unknown extension:
            // the viewer then explains why it cannot be displayed.
            let name = file_name(target);
            let pos = files
                .iter()
                .position(|p| natural_cmp(&file_name(p), &name) == Ordering::Greater)
                .unwrap_or(files.len());
            files.insert(pos, target.to_path_buf());
            pos
        }
    };
    Ok(FolderListing {
        folder: folder.display().to_string(),
        files: files.iter().map(|p| p.display().to_string()).collect(),
        index,
    })
}

fn same_file(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut v: Vec<&str>) -> Vec<&str> {
        v.sort_by(|a, b| natural_cmp(a, b));
        v
    }

    #[test]
    fn numbers_sort_by_value() {
        assert_eq!(
            sorted(vec!["img10.jpg", "img2.jpg", "img1.jpg", "img20.jpg", "img3.jpg"]),
            vec!["img1.jpg", "img2.jpg", "img3.jpg", "img10.jpg", "img20.jpg"]
        );
    }

    #[test]
    fn case_insensitive_and_leading_zeros() {
        assert_eq!(
            sorted(vec!["b.png", "A.png", "a2.png", "a10.png", "a02.png"]),
            vec!["A.png", "a2.png", "a02.png", "a10.png", "b.png"]
        );
    }

    #[test]
    fn huge_numbers_do_not_overflow() {
        assert_eq!(
            sorted(vec!["x99999999999999999999999.jpg", "x100000000000000000000000.jpg", "x5.jpg"]),
            vec!["x5.jpg", "x99999999999999999999999.jpg", "x100000000000000000000000.jpg"]
        );
    }

    #[test]
    fn unicode_names() {
        assert_eq!(sorted(vec!["été 2.jpg", "Été 1.jpg"]), vec!["Été 1.jpg", "été 2.jpg"]);
    }

    #[test]
    fn lists_only_supported_files_without_recursion() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["photo10.jpg", "photo2.PNG", "notes.txt", ".hidden.jpg", "scan.tiff"] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join("inner.jpg"), b"x").unwrap();

        let names: Vec<String> =
            list_images(dir.path()).unwrap().iter().map(|p| file_name(p)).collect();
        assert_eq!(names, vec!["photo2.PNG", "photo10.jpg", "scan.tiff"]);
    }

    #[test]
    fn open_file_selects_it_in_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["c.jpg", "a.jpg", "b.jpg"] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        let listing = open_target(&dir.path().join("b.jpg")).unwrap();
        assert_eq!(listing.files.len(), 3);
        assert_eq!(listing.index, 1);
        assert!(listing.files[1].ends_with("b.jpg"));
    }

    #[test]
    fn open_folder_starts_at_first_image() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["z.png", "m.png"] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        let listing = open_target(dir.path()).unwrap();
        assert_eq!(listing.index, 0);
        assert!(listing.files[0].ends_with("m.png"));
    }

    #[test]
    fn unknown_extension_is_still_shown_when_opened_directly() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        fs::write(dir.path().join("b.xyz"), b"x").unwrap();
        let listing = open_target(&dir.path().join("b.xyz")).unwrap();
        assert_eq!(listing.files.len(), 2);
        assert_eq!(listing.index, 1);
    }

    #[test]
    fn missing_file_is_reported() {
        let err = open_target(Path::new("/definitely/not/here.jpg")).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
