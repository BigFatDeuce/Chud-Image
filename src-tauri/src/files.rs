//! Deleting pictures: the Recycle Bin / Trash first, permanent deletion only on request.

use crate::error::{AppError, AppResult, ErrorCode};
use std::fs;
use std::path::Path;

pub fn move_to_trash(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(ErrorCode::NotFound, path.display().to_string()));
    }
    trash::delete(path).map_err(|e| AppError::new(ErrorCode::TrashUnavailable, e.to_string()))?;
    if path.exists() {
        return Err(AppError::new(ErrorCode::TrashUnavailable, "the file is still present"));
    }
    Ok(())
}

pub fn delete_permanently(path: &Path) -> AppResult<()> {
    if !path.is_file() {
        return Err(AppError::new(ErrorCode::NotFound, path.display().to_string()));
    }
    fs::remove_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_delete_removes_only_that_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jpg");
        let b = dir.path().join("b.jpg");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        delete_permanently(&a).unwrap();
        assert!(!a.exists());
        assert!(b.exists());
    }

    #[test]
    fn deleting_a_missing_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gone.jpg");
        assert_eq!(move_to_trash(&p).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(delete_permanently(&p).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn refuses_to_delete_a_folder_permanently() {
        let dir = tempfile::tempdir().unwrap();
        assert!(delete_permanently(dir.path()).is_err());
        assert!(dir.path().exists());
    }

    /// Really uses the Recycle Bin / Trash, so it is opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn trash_moves_the_file_away() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("chud-image-trash-test.txt");
        fs::write(&p, b"x").unwrap();
        move_to_trash(&p).unwrap();
        assert!(!p.exists());
    }
}
