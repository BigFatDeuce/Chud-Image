//! A single error type shared by every command, serialised as `{ code, message }`
//! so the frontend can show a translated, user-friendly explanation.

use serde::Serialize;
use std::fmt;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    Unsupported,
    Corrupt,
    ReadOnlyFormat,
    Animated,
    TooLarge,
    TrashUnavailable,
    Io,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }
    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Corrupt, message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<io::Error> for AppError {
    fn from(e: io::Error) -> Self {
        let code = match e.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        };
        Self::new(code, e.to_string())
    }
}

impl From<image::ImageError> for AppError {
    fn from(e: image::ImageError) -> Self {
        use image::ImageError as E;
        match e {
            E::Unsupported(u) => Self::unsupported(u.to_string()),
            E::Limits(l) => Self::new(ErrorCode::TooLarge, l.to_string()),
            E::IoError(io) => io.into(),
            other => Self::corrupt(other.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
