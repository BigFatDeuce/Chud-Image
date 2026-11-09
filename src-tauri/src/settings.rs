//! User preferences, stored as JSON in the platform configuration folder.

use crate::error::AppResult;
use crate::rotate::atomic_write;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transition {
    #[default]
    Glitch,
    Fade,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WheelAction {
    #[default]
    Zoom,
    Navigate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Background {
    #[default]
    Auto,
    Black,
    Gray,
    White,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    /// "system", "fr" or "en".
    pub language: String,
    /// Seconds between two slides.
    pub slideshow_interval: u32,
    pub slideshow_loop: bool,
    pub transition: Transition,
    pub wheel_action: WheelAction,
    /// Going past the last image returns to the first one (and vice versa).
    pub wrap_navigation: bool,
    pub confirm_delete: bool,
    pub background: Background,
    /// Checkerboard behind transparent pixels.
    pub transparency_checker: bool,
    /// Hide the toolbar in fullscreen after a few idle seconds.
    pub autohide_controls: bool,
    /// Look for a new version on GitHub at startup.
    pub auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            language: "system".into(),
            slideshow_interval: 4,
            slideshow_loop: true,
            transition: Transition::Glitch,
            wheel_action: WheelAction::Zoom,
            wrap_navigation: true,
            confirm_delete: true,
            background: Background::Auto,
            transparency_checker: true,
            autohide_controls: true,
            auto_update: true,
        }
    }
}

impl Settings {
    pub const MIN_INTERVAL: u32 = 1;
    pub const MAX_INTERVAL: u32 = 120;

    /// Brings hand-edited or outdated values back into a valid range.
    pub fn sanitized(mut self) -> Self {
        self.slideshow_interval = self.slideshow_interval.clamp(Self::MIN_INTERVAL, Self::MAX_INTERVAL);
        if !matches!(self.language.as_str(), "system" | "fr" | "en") {
            self.language = "system".into();
        }
        self
    }
}

/// Loads settings; a missing or corrupted file silently yields the defaults.
pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(&settings.clone().sanitized())
        .map_err(|e| crate::error::AppError::new(crate::error::ErrorCode::Io, e.to_string()))?;
    atomic_write(path, json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.json")), Settings::default());
        assert_eq!(Settings::default().theme, Theme::System);
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings {
            theme: Theme::Dark,
            language: "en".into(),
            slideshow_interval: 9,
            slideshow_loop: false,
            transition: Transition::Fade,
            wheel_action: WheelAction::Navigate,
            wrap_navigation: false,
            confirm_delete: false,
            background: Background::Black,
            transparency_checker: false,
            autohide_controls: false,
            auto_update: false,
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
    }

    #[test]
    fn corrupted_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ this is not json").unwrap();
        assert_eq!(load(&path), Settings::default());
    }

    #[test]
    fn partial_file_keeps_known_values_and_clamps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{ "theme": "light", "slideshowInterval": 5000, "language": "klingon" }"#).unwrap();
        let s = load(&path);
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.slideshow_interval, Settings::MAX_INTERVAL);
        assert_eq!(s.language, "system");
        assert!(s.confirm_delete);
    }

    #[test]
    fn json_uses_camel_case_and_lowercase_enums() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("\"slideshowInterval\":4"));
        assert!(json.contains("\"theme\":\"system\""));
        assert!(json.contains("\"transition\":\"glitch\""));
    }
}
